import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionDraft } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";

after(cleanUp);

async function setup(t: TestContext) {
    const app = await openApp(scriptedModel(), join(root, crypto.randomUUID()));

    t.after(() => app.close());
    const bob = app.config.addUser("Bob", "guest").user;

    app.config.setUsers(THIS_SERVER, [bob.id]);

    return { app, bob, boss: owner(app) };
}

const bobTitle = "Saved for Bob";

function saveTitle(app: App, id: ConversationId, user: User): Promise<void> {
    return app.commit(
        async (tx) => {
            (await app.sessionsIn(tx)).items[String(id)]!.title = bobTitle;
        },
        app.admission(id, user),
    );
}

test("1. Removing a share refuses the save queued next", async (t) => {
    const { app, bob, boss } = await setup(t);
    const id = await newSession(app);
    const title = app.sessionMeta(id)?.title;

    await app.commands.shareSession(id, boss, [bob.id]);
    app.recheck(id, bob);

    const removing = app.commit(async (tx) => {
        delete (await app.sessionsIn(tx)).items[String(id)]!.sharedWith;
    }, context);
    const saving = saveTitle(app, id, bob);

    await Promise.all([removing, assert.rejects(saving, { status: 404 })]);
    assert.equal(app.sessionMeta(id)?.title, title);
});

test("2. Removing a share refuses a real submit queued next", async (t) => {
    const { app, bob, boss } = await setup(t);
    const id = await newSession(app);

    await app.commands.shareSession(id, boss, [bob.id]);
    const conversation = app.conversation.bind(app);
    let removing: Promise<void> | undefined;

    app.conversation = async (requested) => {
        const found = await conversation(requested);

        if (requested !== id) {
            return found;
        }

        return new Proxy(found, {
            get(target, key) {
                if (key === "submit") {
                    return (input: SubmissionDraft, saving: Context) => {
                        // Both saves join the line in this tick, after submit has prepared the message.
                        removing ??= app.commit(async (tx) => {
                            delete (await app.sessionsIn(tx)).items[String(id)]!.sharedWith;
                        }, context);

                        return target.submit(input, saving);
                    };
                }

                const value: unknown = Reflect.get(target, key, target);

                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };

    try {
        await assert.rejects(
            app.commands.submit(id, bob, {
                text: "Bob's queued message",
                requestId: "bob-message",
            }),
            { status: 404 },
        );
    } finally {
        app.conversation = conversation;
        await removing;
    }

    assert.ok(removing, "the removal reached the line before submit");
    const entries = await (await conversation(id)).entries({}, 64, undefined, context);

    assert.ok(!entries.items.some((entry) => entry.kind === "pi.user"));
});

test("3. Giving the wheel to the owner refuses Bob's save queued next", async (t) => {
    const { app, bob, boss } = await setup(t);
    const id = await newSession(app);
    const title = app.sessionMeta(id)?.title;

    await app.commands.shareSession(id, boss, [bob.id]);
    await app.commit(async (tx) => {
        const turns = await app.turnsIn(tx, id);

        turns.on = true;
        turns.driver = bob.id;
    }, context);
    app.recheck(id, bob);

    const taking = app.commit(async (tx) => {
        (await app.turnsIn(tx, id)).driver = boss.id;
    }, context);
    const saving = saveTitle(app, id, bob);

    await Promise.all([taking, assert.rejects(saving, { status: 409 })]);
    assert.equal(app.sessionMeta(id)?.title, title);
});

test("4. Moving out of Bob's folder refuses his save queued next", async (t) => {
    const { app, bob, boss } = await setup(t);
    const given = join(root, "given");
    const outside = join(root, "outside");

    mkdirSync(given);
    mkdirSync(outside);
    await app.giveFolders(boss, THIS_SERVER, bob.id, [given]);
    await app.seeFolder(boss, THIS_SERVER, bob.id, given, true);
    const id = await newSession(app, given);
    const title = app.sessionMeta(id)?.title;

    assert.equal(app.sessionMeta(id)?.sharedWith, undefined);
    app.recheck(id, bob);

    const moving = app.commit(async (tx) => {
        (await app.sessionsIn(tx)).items[String(id)]!.cwd = outside;
    }, context);
    const saving = saveTitle(app, id, bob);

    await Promise.all([moving, assert.rejects(saving, { status: 404 })]);
    assert.equal(app.sessionMeta(id)?.cwd, outside);
    assert.equal(app.sessionMeta(id)?.title, title);
});

test("5. A new share does not admit a save until publication", async (t) => {
    const { app, bob } = await setup(t);
    const id = await newSession(app);
    const title = app.sessionMeta(id)?.title;

    assert.equal(app.canSee(bob, id), false);
    const sharing = app.commit(async (tx) => {
        (await app.sessionsIn(tx)).items[String(id)]!.sharedWith = [bob.id];
    }, context);
    const saving = saveTitle(app, id, bob);

    await Promise.all([sharing, assert.rejects(saving, { status: 404 })]);
    assert.equal(app.sessionMeta(id)?.title, title);
    await saveTitle(app, id, bob);
    assert.equal(app.sessionMeta(id)?.title, bobTitle);
});

test("6. Line entries leave when each commit settles", async (t) => {
    const { app, bob } = await setup(t);
    const id = await newSession(app);

    await app.commit(async (tx) => {
        (await app.sessionsIn(tx)).items[String(id)]!.sharedWith = [bob.id];
    }, context);
    assert.equal(app.lineHeld, 0, "sessions must leave the line view");

    await app.commit(async (tx) => {
        const turns = await app.turnsIn(tx, id);

        turns.on = true;
        turns.driver = bob.id;
    }, context);
    assert.equal(app.lineHeld, 0, "turns must leave the line view");
});

test("7. A throwing callback holds nothing, and a raw commit cannot take a tracked draft", async (t) => {
    const { app, bob } = await setup(t);
    const id = await newSession(app);
    const failure = new Error("Do not save");

    await assert.rejects(
        app.commit(async (tx) => {
            (await app.sessionsIn(tx)).items[String(id)]!.sharedWith = [bob.id];
            (await app.turnsIn(tx, id)).on = true;

            throw failure;
        }, context),
        failure,
    );
    assert.equal(app.lineHeld, 0);
    assert.equal(app.sessionMeta(id)?.sharedWith, undefined);

    const wrongCommit = { message: "Take this document in app.commit" };

    await assert.rejects(
        app.harness.commit((tx) => app.sessionsIn(tx), context),
        wrongCommit,
    );
    await assert.rejects(
        app.harness.commit((tx) => app.turnsIn(tx, id), context),
        wrongCommit,
    );
});

test("8. Only the helpers, new session initializers, and wheel checks take raw documents", () => {
    const source = fileURLToPath(new URL("../src/server/", import.meta.url));
    const expected = new Map([
        ["app.ts", [1, 1]],
        ["commands.ts", [4, 0]],
        ["pip.ts", [1, 0]],
        ["linked-sessions.ts", [0, 3]],
        ["extension-request.ts", [0, 1]],
    ]);

    for (const file of readdirSync(source, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) {
            continue;
        }

        const path = join(file.parentPath, file.name);
        const name = relative(source, path);
        const code = readFileSync(path, "utf8");
        const counts = ["SessionsDoc", "TurnsDoc"].map(
            (doc) =>
                code.match(new RegExp(`\\btx\\s*\\.\\s*doc\\s*\\(\\s*${doc}\\b`, "g"))?.length ?? 0,
        );

        assert.deepEqual(counts, expected.get(name) ?? [0, 0], `raw document takes in ${name}`);
        expected.delete(name);
    }

    assert.deepEqual([...expected.keys()], [], "all files with raw takes must be checked");
});

test("9. Changing only the title holds no access entry before publication", async (t) => {
    const { app, boss } = await setup(t);
    const id = await newSession(app);
    const title = app.sessionMeta(id)?.title;

    const changing = saveTitle(app, id, boss);
    const observing = app.harness.commit(() => {
        assert.equal(app.sessionMeta(id)?.title, title, "the title has not published yet");
        assert.equal(app.lineHeld, 0);
    }, context);

    await Promise.all([changing, observing]);
    assert.equal(app.sessionMeta(id)?.title, bobTitle);
});

test("10. Removing a share while listing items refuses the save queued next", async (t) => {
    const { app, bob, boss } = await setup(t);
    const id = await newSession(app);
    const title = app.sessionMeta(id)?.title;

    await app.commands.shareSession(id, boss, [bob.id]);
    const removing = app.commit(async (tx) => {
        const { items } = await app.sessionsIn(tx);
        const shared = Object.values(items).find((meta) => meta.sharedWith?.includes(bob.id));

        assert.ok(shared);
        delete shared.sharedWith;
    }, context);
    const saving = saveTitle(app, id, bob);

    await Promise.all([removing, assert.rejects(saving, { status: 404 })]);
    assert.equal(app.sessionMeta(id)?.title, title);
});

test("11. Deleting a session record refuses the save queued next", async (t) => {
    const { app, bob, boss } = await setup(t);
    const id = await newSession(app);

    await app.commands.shareSession(id, boss, [bob.id]);
    const removing = app.commit(async (tx) => {
        const { items } = await app.sessionsIn(tx);

        delete items[String(id)];
    }, context);
    const saving = saveTitle(app, id, bob);

    await Promise.all([removing, assert.rejects(saving, { status: 404 })]);
    assert.equal(app.sessionMeta(id), undefined);
});

test("12. Taking sessions twice in one commit returns the same view", async (t) => {
    const { app } = await setup(t);

    await app.commit(async (tx) => {
        const [first, second] = await Promise.all([app.sessionsIn(tx), app.sessionsIn(tx)]);

        assert.equal(first, second);
        assert.equal(first.items, second.items);
    }, context);
});

test("Undo publishes the new session and leaves nothing held", async (t) => {
    const { app, boss } = await setup(t);
    const id = await newSession(app);

    await say(app, id, "Undo this message");
    const entries = await (await app.conversation(id)).entries({}, 64, undefined, context);
    const message = entries.items.find((entry) => entry.kind === "pi.user");

    assert.ok(message);
    const undone = await app.commands.undo(id, boss, { entryId: Number(message.id) });

    assert.equal(app.lineHeld, 0);
    assert.notEqual(undone.id, id);
    assert.equal(app.sessionMeta(undone.id)?.forkedFrom?.id, Number(id));
});
