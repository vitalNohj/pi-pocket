// Moving to the access policy (`access.ts`): a server set up before it opens with every invited person shut out until
// the owner chooses them, the owner's sessions working as before, and each session private, also with the old global
// switch that shared every runner session on.
import {
    answerRequests,
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";

const model = scriptedModel(fauxAssistantMessage("Still here."));
let app: App;
let guest: User;
let viewer: User;
let invited: User;
let ownersSession: ConversationId;
let guestsSession: ConversationId;

before(async () => {
    app = await openApp(model);

    // As the server was before: people invited, sessions started by the owner and by a guest, nobody chosen.
    guest = app.config.addUser("Gail", "guest").user;
    viewer = app.config.addUser("Vic", "viewer").user;
    ownersSession = await newSession(app);
    guestsSession = await newSession(app);
    invited = app.config.addUser("Ira", "guest", [String(guestsSession)]).user;
    await app.harness.commit(async (tx) => {
        const items = (await tx.doc(SessionsDoc)).items;

        // Before the policy, a guest's session was theirs by `createdBy` alone, and nothing was shared one by one.
        items[String(guestsSession)]!.createdBy = guest.id;
        delete items[String(ownersSession)]!.createdBy;

        for (const meta of Object.values(items)) {
            delete meta.sharedWith;
        }
    }, context);
    await app.close();

    // The file as the old server kept it: the global switch on, and no record of this server's people.
    const file = `${app.config.file}`;
    const old = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    old.sharedRunnerSessions = true;
    delete old.server;
    writeFileSync(file, JSON.stringify(old, null, 2));

    app = await openApp(model);
});

after(async () => {
    await app.close();
    cleanUp();
});

const person = (user: User) => app.config.users.find((each) => each.id === user.id)!;

test("the old global sharing switch is gone from the file", () => {
    const saved = JSON.parse(readFileSync(app.config.file, "utf8")) as Record<string, unknown>;

    assert.equal("sharedRunnerSessions" in saved, false);
    assert.deepEqual(app.config.server.users ?? [], []);
});

test("invited people are shut out until the owner chooses them; the one invited to a session keeps it", () => {
    for (const user of [guest, viewer]) {
        assert.equal(app.policy.mayUse(person(user), THIS_SERVER), false);
        assert.deepEqual(app.sessions(person(user)), []);
        assert.equal(app.canSee(person(user), ownersSession), false);
        assert.equal(app.canSee(person(user), guestsSession), false);
    }

    // The guest who started a session sees it no more: they must be chosen first.
    assert.equal(app.policy.mayStart(person(guest), THIS_SERVER), false);

    assert.equal(app.canSee(person(invited), guestsSession), true);
    assert.equal(app.canSee(person(invited), ownersSession), false);
    assert.deepEqual(
        app.sessions(person(invited)).map((each) => each.id),
        [Number(guestsSession)],
    );
});

test("the owner keeps every session, and steers them as before", async () => {
    const me = owner(app);
    const ids = app.sessions(me).map((each) => each.id);

    assert.ok(ids.includes(Number(ownersSession)));
    assert.ok(ids.includes(Number(guestsSession)));
    assert.equal(app.policy.maySteer(me, String(ownersSession)), true);
    assert.equal(app.policy.maySteer(me, String(guestsSession)), true);

    const { submissionId } = await app.commands.submit(ownersSession, me, {
        text: "Are you there?",
        requestId: "m1",
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    assert.ok(
        (await modelTexts(app, ownersSession)).some((text) => text.includes("Still here.")),
        "the owner's session runs",
    );
});

test("once chosen, a guest sees the sessions they started, and the owner's only when shared", async () => {
    app.config.setServerUsers([guest.id, viewer.id]);
    app.accessChanged();

    try {
        assert.equal(app.canSee(person(guest), guestsSession), true);
        assert.equal(app.policy.maySteer(person(guest), String(guestsSession)), true);
        assert.equal(app.canSee(person(guest), ownersSession), false);

        // A chosen viewer sees nothing until a session is shared with them, and steers nothing even then.
        assert.deepEqual(app.sessions(person(viewer)), []);
        await app.commands.shareSession(ownersSession, owner(app), [viewer.id]);
        assert.equal(app.canSee(person(viewer), ownersSession), true);
        assert.equal(app.policy.maySteer(person(viewer), String(ownersSession)), false);

        // A guest's new session here is private too: sharing is off by default. (A given folder, allowed by the owner.)
        app.config.setGivenFolders(undefined, guest.id, [realpathSync(work)]);

        const stop = answerRequests(app, () => true);
        const { id } = await app.commands.createSession(person(guest), { cwd: work }).finally(stop);

        assert.equal(app.canSee(person(viewer), id), false);
    } finally {
        app.config.setServerUsers([]);
        app.accessChanged();
    }
});
