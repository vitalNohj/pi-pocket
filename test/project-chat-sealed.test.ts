// The folder's people keep their chat, but the database keeps only sealed text.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test, type TestContext } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import { PocketApp } from "../src/server/app.ts";
import { open as openMessage } from "../src/server/chat-seal.ts";
import type { User } from "../src/server/config.ts";
import { directKey } from "../src/server/direct.ts";
import {
    DirectDoc,
    DirectIndexDoc,
    ProjectChatDoc,
    ProjectChatIndexDoc,
    type ProjectChatMessage,
} from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const unreadable = "This message cannot be read on this server anymore.";
const scrubSql = ["VACUUM", "PRAGMA wal_checkpoint(TRUNCATE)"];
const privateText = () => `Private project chat ${randomUUID()}`;

function fixture(t: TestContext) {
    const data = join(root, randomUUID());
    const model = scriptedModel();

    const open = async () => {
        const app = await openApp(model, data);

        t.after(() => app.close());

        return app;
    };

    return { data, keyFile: join(data, "direct.key"), open };
}

function watchScrubs(t: TestContext): string[] {
    const statements: string[] = [];

    for (const method of ["exec", "prepare"] as const) {
        const run: (this: DatabaseSync, sql: string) => unknown = DatabaseSync.prototype[method];

        t.mock.method(DatabaseSync.prototype, method, function (this: DatabaseSync, sql: string) {
            if (/\b(?:VACUUM|wal_checkpoint)\b/i.test(sql)) {
                statements.push(sql);
            }

            return run.call(this, sql);
        });
    }

    // The database also checkpoints on close. Take a fresh count just before each start.
    return statements;
}

const stored = (app: App, key: string) => app.harness.snapshot(ProjectChatDoc, key, context);
const index = (app: App) => app.harness.snapshot(ProjectChatIndexDoc, context);
const post = (
    app: App,
    from: User,
    id: ConversationId,
    text: string,
    requestId: string = randomUUID(),
) => app.projectChat.post(from, id, { text, requestId });

async function share(app: App, id: ConversationId, folder?: string) {
    const added = app.config.addUser("Lee", "guest");

    app.config.setUsers(THIS_SERVER, [added.user.id]);

    if (folder !== undefined) {
        app.config.setGivenFolders(THIS_SERVER, added.user.id, [folder]);
    }

    await app.commands.shareSession(id, owner(app), [added.user.id]);

    return added;
}

async function otherSession(app: App) {
    const folder = join(work, randomUUID());

    mkdirSync(folder);

    return newSession(app, folder);
}

// The old writer stored text and kept no sealing mark in the index.
function legacyPlace(app: App, id: ConversationId) {
    const place = app.folderOf(id);

    assert.ok(place);
    const { computer, path: folder } = place;
    const key = createHash("sha256").update(`${computer}\n${folder}`).digest("hex").slice(0, 32);

    return { key, computer, folder };
}

const legacyMessage = (from: User, text = privateText()): ProjectChatMessage => ({
    id: randomUUID(),
    userId: from.id,
    name: from.name,
    at: Date.now(),
    text,
});

async function keepOldPost(app: App, id: ConversationId, message: ProjectChatMessage) {
    const { key, computer, folder } = legacyPlace(app, id);

    await app.harness.commit(async (tx) => {
        (await tx.doc(ProjectChatDoc, key, null)).messages.push(message);
        (await tx.doc(ProjectChatIndexDoc)).chats[key] = { computer, folder, at: message.at };
    }, context);
}

function absentFromSqlite(data: string, ...markers: string[]): void {
    for (const file of ["pocket.sqlite", "pocket.sqlite-wal"]) {
        const bytes = readFileSync(join(data, file));

        for (const marker of markers) {
            assert.equal(
                bytes.includes(marker),
                false,
                `${file} holds plaintext project chat text`,
            );
        }
    }
}

after(cleanUp);

test("new project text is absent from SQLite and WAL and both people read it", async (t) => {
    const { data, keyFile, open } = fixture(t);
    const app = await open();
    const from = owner(app);
    const id = await newSession(app);
    const { user: to } = await share(app, id, work);
    const text = `@${to.name}: ${privateText()} 👋`;

    assert.equal(existsSync(keyFile), false);
    const message = await post(app, from, id, text);

    absentFromSqlite(data, text);
    const chat = await app.projectChat.thread(from, id);

    assert.deepEqual(chat.messages, [message]);
    assert.deepEqual(await app.projectChat.thread(to, id), chat);
    assert.equal(message.text, text);
    assert.deepEqual(message.mentions, [to.id]);

    const [kept] = (await stored(app, chat.key))?.messages ?? [];

    assert.ok(kept !== undefined && "sealed" in kept);
    const { sealed, ...metadata } = kept;
    const { text: _text, ...publicMetadata } = message;

    assert.match(sealed, /^v1:[\w-]{16}:[\w-]{22}:[\w-]+$/);
    assert.deepEqual(metadata, publicMetadata);
    assert.equal((await index(app))?.sealed, true);
});

test("startup seals old project chats and drops old revision bytes without sealing twice", async (t) => {
    const { data, keyFile, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const id = await newSession(app);
    const other = await otherSession(app);
    const { key } = legacyPlace(app, id);
    const { key: unindexed } = legacyPlace(app, other);
    const first = legacyMessage(from);
    const current = legacyMessage(from);
    const orphan = legacyMessage(from);

    await keepOldPost(app, id, first);
    await app.harness.commit(async (tx) => {
        (await tx.doc(ProjectChatDoc, key, null)).messages.splice(0, 1, current);
        (await tx.doc(ProjectChatDoc, unindexed, null)).messages.push(orphan);
    }, context);
    assert.equal(existsSync(keyFile), false);
    await app.close();
    const oldBytes = readFileSync(join(data, "pocket.sqlite"));
    const texts = [first.text, current.text, orphan.text];

    for (const text of texts) {
        assert.ok(oldBytes.includes(text), "the old writer stored plaintext");
    }

    app = await open();
    const sealed = await stored(app, key);

    assert.ok(sealed?.messages.length === 1 && "sealed" in sealed.messages[0]!);
    assert.ok("sealed" in (await stored(app, unindexed))!.messages[0]!);
    assert.equal((await index(app))?.sealed, true);
    absentFromSqlite(data, ...texts);
    assert.deepEqual((await app.projectChat.thread(from, id)).messages, [current]);
    assert.deepEqual((await app.projectChat.thread(from, other)).messages, [orphan]);
    await app.close();

    app = await open();
    assert.deepEqual(await stored(app, key), sealed);
    assert.deepEqual((await app.projectChat.thread(from, id)).messages, [current]);
    absentFromSqlite(data, ...texts);
});

test("startup does not scrub with no project index or with a clean sealed index", async (t) => {
    const sql = watchScrubs(t);
    const { open } = fixture(t);
    let app = await open();

    assert.deepEqual(sql, []);
    assert.equal(await index(app), undefined, "startup does not create an index");
    await app.projectChat.setOn(owner(app), false);
    assert.deepEqual(await index(app), { chats: {}, sealed: true });
    await app.close();
    const before = sql.length;

    app = await open();
    assert.deepEqual(sql.slice(before), []);
    assert.deepEqual(await index(app), { chats: {}, sealed: true });
});

test("startup scrubs both chats once and clears both scrub marks", async (t) => {
    const { data, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const id = await newSession(app);
    const { user: to } = app.config.addUser("Mo", "guest");
    const project = legacyMessage(from);
    const direct = { id: "old-direct", userId: from.id, at: 100, text: privateText() };
    const thread = directKey(from.id, to.id);

    await keepOldPost(app, id, project);
    await app.harness.commit(async (tx) => {
        (await tx.doc(DirectDoc, thread, null)).messages.push(direct);
        (await tx.doc(DirectIndexDoc)).threads[thread] = {
            people: [from.id, to.id],
            at: direct.at,
            unread: { [to.id]: 1 },
        };
    }, context);
    await app.close();
    const sql = watchScrubs(t);

    app = await open();
    assert.deepEqual(sql, scrubSql);
    assert.equal((await index(app))?.scrub, undefined);
    assert.equal((await index(app))?.sealed, true);
    assert.equal((await app.harness.snapshot(DirectIndexDoc, context))?.scrub, undefined);
    absentFromSqlite(data, project.text, direct.text);
    assert.deepEqual((await app.projectChat.thread(from, id)).messages, [project]);
    assert.deepEqual((await app.direct.thread(to, from.id)).messages, [direct]);
});

test("a busy checkpoint serves sealed project chat and retries the scrub on restart", async (t) => {
    const { data, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const id = await newSession(app);
    const { key } = legacyPlace(app, id);
    const old = legacyMessage(from);

    await keepOldPost(app, id, old);
    await app.close();
    const reader = new DatabaseSync(join(data, "pocket.sqlite"), { readOnly: true });
    const logged = t.mock.method(PocketApp.prototype, "log");
    const sql = watchScrubs(t);
    let firstSealed: Awaited<ReturnType<typeof stored>>;

    try {
        reader.exec("BEGIN");
        assert.ok(reader.prepare("SELECT id FROM documents LIMIT 1").get());

        // The read transaction keeps its snapshot and prevents truncating the WAL.
        app = await open();
        firstSealed = await stored(app, key);
        assert.ok(firstSealed?.messages.length === 1 && "sealed" in firstSealed.messages[0]!);
        assert.deepEqual((await app.projectChat.thread(from, id)).messages, [old]);
        assert.deepEqual(sql, scrubSql);
        assert.equal((await index(app))?.scrub, true);
        assert.equal((await index(app))?.sealed, true);
        assert.deepEqual(
            logged.mock.calls
                .map(({ arguments: [line] }) => line)
                .filter((line) => line.startsWith("Project chat:")),
            [
                "Project chat: old plaintext bytes may still be in SQLite. The next start will try again.",
            ],
        );
    } finally {
        reader.close();
    }

    await app.close();
    const before = sql.length;

    app = await open();
    assert.deepEqual(sql.slice(before), scrubSql);
    assert.equal((await index(app))?.scrub, undefined);
    assert.equal((await index(app))?.sealed, true);
    assert.deepEqual(await stored(app, key), firstSealed);
    absentFromSqlite(data, old.text);
});

test("moving a sealed project message to another chat, id, or direct thread does not open it", async (t) => {
    const { keyFile, open } = fixture(t);
    const app = await open();
    const from = owner(app);
    const to = app.config.addUser("Mo", "guest").user;
    const id = await newSession(app);
    const other = await otherSession(app);
    const { key } = legacyPlace(app, id);
    const { key: moved } = legacyPlace(app, other);
    const message = await post(app, from, id, privateText());
    const [sealed] = (await stored(app, key))?.messages ?? [];

    assert.ok(sealed !== undefined && "sealed" in sealed);
    await app.harness.commit(async (tx) => {
        (await tx.doc(ProjectChatDoc, moved, null)).messages.push(sealed);
        (await tx.doc(ProjectChatDoc, key, null)).messages.push({ ...sealed, id: "changed-id" });
        (await tx.doc(DirectDoc, directKey(from.id, to.id), null)).messages.push({
            id: sealed.id,
            userId: sealed.userId,
            at: sealed.at,
            sealed: sealed.sealed,
        });
    }, context);

    assert.deepEqual((await app.projectChat.thread(from, other)).messages, [
        { ...message, text: unreadable },
    ]);
    assert.deepEqual((await app.projectChat.thread(from, id)).messages, [
        message,
        { ...message, id: "changed-id", text: unreadable },
    ]);
    assert.deepEqual((await app.direct.thread(to, from.id)).messages, [
        { id: message.id, userId: from.id, at: message.at, text: unreadable },
    ]);

    // Even at the same document key and id, the direct chat's AAD cannot open a project message.
    const bytes = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");

    assert.equal(
        openMessage(bytes, Buffer.from(JSON.stringify([key, message.id])), sealed.sealed),
        undefined,
    );
    assert.equal(
        openMessage(
            bytes,
            Buffer.from(JSON.stringify(["project-chat", key, message.id])),
            sealed.sealed,
        ),
        message.text,
    );
});

test("a replaced key gives one warning per chat and still lets people post", async (t) => {
    const { keyFile, open } = fixture(t);
    const app = await open();
    const from = owner(app);
    const id = await newSession(app);
    const old = [
        await post(app, from, id, privateText()),
        await post(app, from, id, privateText()),
    ];
    const lost = old.map((message) => ({ ...message, text: unreadable }));
    const logged = t.mock.method(app, "log");
    const read = async () => (await app.projectChat.thread(from, id)).messages;

    writeFileSync(keyFile, `${randomBytes(32).toString("base64")}\n`);
    assert.deepEqual(await read(), lost);
    assert.deepEqual(await read(), lost);
    const fresh = await post(app, from, id, privateText());

    assert.deepEqual(await read(), [...lost, fresh]);
    assert.deepEqual(
        logged.mock.calls.map(({ arguments: [line] }) => line),
        [`Project chat ${legacyPlace(app, id).key}: could not decrypt a message`],
    );

    writeFileSync(keyFile, "invalid key\n");
    assert.deepEqual(await read(), [...lost, { ...fresh, text: unreadable }]);
    await assert.rejects(post(app, from, id, privateText()), /Invalid direct chat key file/);
    assert.equal(readFileSync(keyFile, "utf8"), "invalid key\n");

    unlinkSync(keyFile);
    assert.deepEqual(await read(), [...lost, { ...fresh, text: unreadable }]);
    assert.ok(existsSync(keyFile), "reading recreates a missing key, as for direct chat");
    const afterLoss = await post(app, from, id, privateText());

    assert.deepEqual(await read(), [...lost, { ...fresh, text: unreadable }, afterLoss]);
});

test("a person without the folder gets no project text from the route, event, or first load", async (t) => {
    const app = await fixture(t).open();
    const id = await newSession(app);
    const { user, token } = await share(app, id);
    const looking = fakeTab(id, user);

    assert.ok(app.canSee(user, id));
    assert.equal(app.policy.mayChatIn(user, THIS_SERVER, work), false);
    await app.attach(looking.client);
    t.after(() => app.detach(looking.client));
    const text = privateText();

    await post(app, owner(app), id, text);
    assert.ok(!looking.events.some(({ event }) => event === "project-chat"));

    const initial = fakeTab(id, user);

    await app.attach(initial.client);
    t.after(() => app.detach(initial.client));
    await until(() => initial.last("view") !== undefined, "the first session view");
    assert.ok(initial.last("hello"));
    assert.ok(!JSON.stringify(initial.events).includes(text));

    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/project-chat`, {
        headers: { authorization: `Bearer ${token}`, "X-Pocket": "1" },
        signal: AbortSignal.timeout(20_000),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "No project chat here." });
});

test("retrying a project post opens the first message and stores only one", async (t) => {
    const app = await fixture(t).open();
    const from = owner(app);
    const id = await newSession(app);
    const first = await post(app, from, id, privateText(), "same");

    assert.deepEqual(await post(app, from, id, "Different text", "same"), first);
    const kept = await stored(app, legacyPlace(app, id).key);

    assert.equal(kept?.messages.length, 1);
    assert.ok("sealed" in kept.messages[0]!);
});

test("startup scrubs old retired project chats once even with no chat document left", async (t) => {
    const { data, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const sessions = [await newSession(app), await otherSession(app)];
    const keys = sessions.map((id) => legacyPlace(app, id).key);
    const markers = [];

    for (const id of sessions) {
        const marker = privateText();

        markers.push(marker);

        // Several revisions of a longer message leave bytes in free pages after retirement.
        for (let n = 0; n < 4; n++) {
            await keepOldPost(app, id, legacyMessage(from, `${marker} `.repeat(56).trim()));
        }
    }

    app.config.setProjectChat(false);
    await app.harness.commit(async (tx) => {
        const oldIndex = await tx.doc(ProjectChatIndexDoc);

        for (const key of keys) {
            await tx.retireDoc(ProjectChatDoc, key);
            delete oldIndex.chats[key];
        }
    }, context);
    assert.deepEqual(await index(app), { chats: {} });

    for (const key of keys) {
        assert.equal(await stored(app, key), undefined);
    }

    await app.close();
    const oldBytes = readFileSync(join(data, "pocket.sqlite"));

    assert.ok(
        markers.some((marker) => oldBytes.includes(marker)),
        "retirement left plaintext bytes",
    );
    const sql = watchScrubs(t);

    app = await open();
    assert.deepEqual(sql, scrubSql);
    assert.deepEqual(await index(app), { chats: {}, sealed: true });
    absentFromSqlite(data, ...markers);
    await app.close();
    const before = sql.length;

    app = await open();
    assert.deepEqual(sql.slice(before), []);
    assert.deepEqual(await index(app), { chats: {}, sealed: true });
});

test("retiring a new project chat leaves no plain bytes and needs no scrub", async (t) => {
    const { data, open } = fixture(t);
    const sql = watchScrubs(t);
    let app = await open();
    const from = owner(app);
    const id = await newSession(app);
    const marker = privateText();

    for (let n = 0; n < 4; n++) {
        await post(app, from, id, `${marker} `.repeat(56).trim());
    }

    await app.projectChat.setOn(from, false);
    assert.equal(await stored(app, legacyPlace(app, id).key), undefined);
    assert.deepEqual(sql, []);
    absentFromSqlite(data, marker);
    await app.close();
    const before = sql.length;

    app = await open();
    assert.deepEqual(sql.slice(before), []);
    assert.deepEqual(await index(app), { chats: {}, sealed: true });
    absentFromSqlite(data, marker);
});
