// Moving to the access rules (`access.ts`). A server from before them gave everyone not held to a session the whole
// server: its people keep what they had (`config.ts` `keepAccess`, `app.ts` `#finishUpgrade`), and what comes later
// follows the rules. A server that had the rules already keeps who is chosen. The owner's sessions work as before.
import {
    answerRequests,
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { THIS_SERVER } from "../src/server/access.ts";
import { ConfigStore, type User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";

type OldFile = Record<string, unknown> & { users: Record<string, unknown>[] };

/** What only a server with the access rules writes: in its file, and on a person. */
const WITH_RULES = [
    "access",
    "accessUpgrade",
    "server",
    "folderApprovals",
    "taskReminders",
    "serverIdentity",
];
const WITH_RULES_PERSON = [
    "authenticator",
    "approvalDays",
    "linksRunners",
    "invites",
    "keepsWarm",
    "temporary",
    "devices",
];
const DAY = 86_400_000;

/** Make the saved `file` one a server from before the access rules kept, then change it as `change` says. */
function asBefore(file: string, change: (old: OldFile) => void = () => {}): void {
    const old = JSON.parse(readFileSync(file, "utf8")) as OldFile;

    for (const key of WITH_RULES) {
        delete old[key];
    }

    for (const user of old.users) {
        for (const key of WITH_RULES_PERSON) {
            delete user[key];
        }
    }

    change(old);
    writeFileSync(file, JSON.stringify(old, null, 2));
}

const saved = (file: string) => JSON.parse(readFileSync(file, "utf8")) as OldFile;

/** As a server from before kept its sessions: none shared one by one; `old` ones last used a month ago. */
async function asKeptBefore(made: App, old: ConversationId[] = []): Promise<void> {
    await made.harness.commit(async (tx) => {
        const items = (await tx.doc(SessionsDoc)).items;

        for (const meta of Object.values(items)) {
            delete meta.sharedWith;
        }

        for (const id of old) {
            items[String(id)]!.updatedAt = Date.now() - 30 * DAY;
        }
    }, context);
}

const model = scriptedModel(fauxAssistantMessage("Still here."));
let app: App;
let guest: User;
let viewer: User;
let invited: User;
let ownersSession: ConversationId;
let guestsSession: ConversationId;
/** Not used for a month. */
let oldSession: ConversationId;
/** Not used for a month either: the one session Ira is held to. */
let heldSession: ConversationId;
/** On a computer, not on this server. */
let runnerSession: ConversationId;

before(async () => {
    app = await openApp(model);

    // As the server was before: people invited, sessions started by the owner and by a guest.
    guest = app.config.addUser("Gail", "guest").user;
    viewer = app.config.addUser("Vic", "viewer").user;
    ownersSession = await newSession(app);
    guestsSession = await newSession(app);
    oldSession = await newSession(app);
    heldSession = await newSession(app);
    runnerSession = await newSession(app);
    invited = app.config.addUser("Ira", "guest", [String(heldSession)]).user;
    await app.harness.commit(async (tx) => {
        const items = (await tx.doc(SessionsDoc)).items;

        // Before the rules, a guest's session was theirs by `createdBy` alone.
        items[String(guestsSession)]!.createdBy = guest.id;
        delete items[String(ownersSession)]!.createdBy;
        items[String(runnerSession)]!.runner = "a-computer";
    }, context);
    await asKeptBefore(app, [oldSession, heldSession]);
    await app.close();

    // The file as the old server kept it: no word of the rules, and the global switch on.
    asBefore(app.config.file, (old) => {
        old.sharedRunnerSessions = true;
        // An owner invite nobody used yet, which handed out the owner's token, beside an invite for someone new.
        old.invites = [
            {
                codeHash: "a".repeat(64),
                role: "owner",
                expiresAt: Date.now() + 600_000,
                createdBy: owner(app).id,
            },
            {
                codeHash: "b".repeat(64),
                role: "viewer",
                expiresAt: Date.now() + 600_000,
                createdBy: owner(app).id,
            },
        ];
    });

    app = await openApp(model);
});

after(async () => {
    await app.close();
    cleanUp();
});

const person = (user: User) => app.config.users.find((each) => each.id === user.id)!;
const listed = (user: User) => app.sessions(person(user)).map((each) => each.id);

test("the file says it follows the rules, and the old global sharing switch is gone from it", () => {
    const file = saved(app.config.file);

    assert.equal("sharedRunnerSessions" in file, false);
    assert.equal(file.access, 1);
    assert.equal("accessUpgrade" in file, false, "its sessions are shared: nothing is left to do");
});

test("an owner invite nobody used ends: a device link took its place; an invite for someone new stays", () => {
    const file = saved(app.config.file) as OldFile & {
        invites: { codeHash: string; role?: string }[];
    };

    assert.deepEqual(
        file.invites.map((each) => [each.codeHash[0], each.role]),
        [["b", "viewer"]],
    );
});

test("the people of a server from before the rules keep what they had: this server, and every session on it", async () => {
    // Chosen for this server; the guest has every folder, and may invite, as then.
    assert.deepEqual(app.config.server.users, [guest.id, viewer.id]);
    assert.deepEqual(app.config.server.given, { [guest.id]: ["/"] });
    assert.equal(app.policy.mayStart(person(guest), THIS_SERVER), true);
    assert.equal(app.policy.mayUseFolder(person(guest), THIS_SERVER, "/any/folder/at/all"), true);
    assert.equal(app.policy.folder(person(guest), THIS_SERVER, work).kind, "ask");
    assert.equal(app.policy.mayInvite(person(guest)), true);
    assert.equal(app.policy.mayInvite(person(viewer)), false);
    assert.equal(app.policy.mayStart(person(viewer), THIS_SERVER), false);

    for (const user of [guest, viewer]) {
        for (const id of [ownersSession, guestsSession, oldSession, heldSession]) {
            assert.equal(app.canSee(person(user), id), true, `${user.name} sees ${id}`);
            assert.ok(listed(user).includes(Number(id)));
        }

        // A computer's sessions were never everyone's.
        assert.equal(app.canSee(person(user), runnerSession), false);
        assert.equal(app.sessionMeta(runnerSession)?.sharedWith, undefined);
    }

    // The guest prompts them, the viewer reads.
    assert.equal(app.policy.maySteer(person(guest), String(ownersSession)), true);
    assert.equal(app.policy.maySteer(person(viewer), String(ownersSession)), false);

    // The upgrade locks nobody out: a session in use is approved by the owner, and the guest's message goes at once.
    assert.equal(app.policy.steer(person(guest), String(ownersSession)), "allow");
    assert.equal(app.folderApprovals.get(String(guestsSession))?.method, "owner");
    assert.equal(app.folderApprovals.get(String(guestsSession))?.by, owner(app).id);
    assert.equal(app.folderApprovals.get(String(guestsSession))?.lastUser, guest.id);

    const { submissionId } = await app.commands.submit(guestsSession, person(guest), {
        text: "Is this still mine?",
        requestId: "g1",
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.ok((await modelTexts(app, guestsSession)).some((text) => text.includes("Still here.")));
    assert.deepEqual(app.folderRequests.list(owner(app)), [], "nobody was asked");

    // One not used for a month would have ended by now anyway: it has no approval, and is renewed as any other.
    assert.equal(app.folderApprovals.get(String(oldSession)), undefined);
    assert.equal(app.policy.steer(person(guest), String(oldSession)), "locked");
    // No approval is kept for a computer's session.
    assert.equal(app.folderApprovals.get(String(runnerSession)), undefined);
});

test("a person held to one session keeps it and nothing more, and is not locked out of it", () => {
    assert.equal(app.config.server.users?.includes(invited.id), false);
    assert.equal(app.policy.mayUse(person(invited), THIS_SERVER), false);
    assert.equal(app.canSee(person(invited), heldSession), true);
    assert.equal(app.canSee(person(invited), ownersSession), false);
    assert.deepEqual(listed(invited), [Number(heldSession)]);
    assert.equal(person(invited).invites, undefined);
    // Though nobody used it for a month.
    assert.equal(app.policy.steer(person(invited), String(heldSession)), "allow");
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

test("what comes after the upgrade follows the rules: a new session is its starter's alone", async () => {
    assert.equal(app.config.server.shareNew, undefined);
    assert.equal(app.config.server.sees, undefined);

    const mine = await newSession(app);

    assert.equal(app.canSee(person(guest), mine), false);
    assert.equal(app.canSee(person(viewer), mine), false);

    // The guest starts one anywhere, with the owner's Allow or their own code, as on any server.
    const stop = answerRequests(app, () => true);
    const { id } = await app.commands.createSession(person(guest), { cwd: work }).finally(stop);

    assert.equal(app.sessionMeta(id)?.createdBy, guest.id);
    assert.equal(app.canSee(person(viewer), id), false);
    assert.equal(app.canSee(owner(app), id), true);
});

test("every folder is a guest's to read through a session, but never this app's own data", () => {
    const outside = join(root, "outside-the-session.txt");

    writeFileSync(outside, "hello\n");
    assert.equal(app.workspace.readableFile(person(guest), guestsSession, outside), outside);
    // The viewer was given no folder: the session's own only.
    assert.throws(
        () => app.workspace.readableFile(person(viewer), guestsSession, outside),
        /not found/i,
    );
    // People, tokens, and the database stay the owner's.
    assert.throws(
        () => app.workspace.readableFile(person(guest), guestsSession, app.config.file),
        /Not found/,
    );
});

test("it happens once: what the owner takes back afterwards stays taken back at the next start", async () => {
    await app.commands.shareSession(ownersSession, owner(app), [viewer.id]);
    assert.equal(app.canSee(person(guest), ownersSession), false);
    await app.choosePerson(THIS_SERVER, viewer.id, false);
    await app.close();

    app = await openApp(model);

    assert.equal(app.canSee(person(guest), ownersSession), false);
    assert.equal(app.canSee(person(guest), oldSession), true);
    assert.deepEqual(app.config.server.users, [guest.id]);
    assert.equal(app.canSee(person(viewer), oldSession), false);
    assert.equal(app.config.accessUpgrade, undefined);
});

test("a server that had the rules already keeps who is chosen: any sign of them, and nobody gets in by the upgrade", async () => {
    const dataDir = join(root, "data-rules");
    const made = await openApp(model, dataDir);
    const gail = made.config.addUser("Gail", "guest").user;
    const session = await newSession(made);
    const file = made.config.file;

    await asKeptBefore(made);
    await made.close();

    const of = (old: OldFile) => old.users.find((each) => each.id === gail.id)!;
    const signs: Record<string, (old: OldFile) => void> = {
        "this server's record": (old) => void (old.server = {}),
        "an approval list": (old) => void (old.folderApprovals = []),
        "task reminders": (old) => void (old.taskReminders = {}),
        "the server's key": (old) =>
            void (old.serverIdentity = { publicKey: "k", privateKey: "k" }),
        "a person's authenticator": (old) => void (of(old).authenticator = { secret: "s" }),
        "a person's approval time": (old) => void (of(old).approvalDays = 7),
        "a person who links runners": (old) => void (of(old).linksRunners = true),
        "a person who invites": (old) => void (of(old).invites = true),
        "a person who keeps warm": (old) => void (of(old).keepsWarm = true),
        "a temporary person": (old) => void (of(old).temporary = true),
        "a person's devices": (old) => void (of(old).devices = []),
    };

    for (const [name, sign] of Object.entries(signs)) {
        asBefore(file, sign);

        const config = new ConfigStore(dirname(file));

        assert.equal(config.accessUpgrade, undefined, name);
        assert.deepEqual(config.server.users ?? [], [], name);
        assert.deepEqual(config.server.given ?? {}, {}, name);
        assert.equal(saved(file).access, 1, name);
    }

    // With the whole app: the guest of such a server is still nobody here until the owner chooses them.
    asBefore(file, signs["an approval list"]);

    const next = await openApp(model, dataDir);

    try {
        const now = next.config.userById(gail.id)!;

        assert.equal(next.policy.mayUse(now, THIS_SERVER), false);
        assert.equal(next.canSee(now, session), false);
        assert.deepEqual(next.sessions(now), []);
        assert.equal(next.sessionMeta(session)?.sharedWith, undefined);
        assert.equal(now.invites, undefined);
    } finally {
        await next.close();
    }
});

test("a new server follows the rules from its first start: a restart chooses nobody", async () => {
    const dataDir = join(root, "data-new");
    const made = await openApp(model, dataDir);
    const file = made.config.file;

    assert.equal(saved(file).access, 1);

    const gail = made.config.addUser("Gail", "guest").user;
    const session = await newSession(made);

    await made.close();

    // Nothing else in its file tells it from a server from before the rules: the owner did nothing with them yet.
    const kept = saved(file);

    for (const key of WITH_RULES.filter((each) => each !== "access")) {
        delete kept[key];
    }

    for (const user of kept.users) {
        for (const key of WITH_RULES_PERSON) {
            delete user[key];
        }
    }

    writeFileSync(file, JSON.stringify(kept, null, 2));

    const next = await openApp(model, dataDir);

    try {
        const now = next.config.userById(gail.id)!;

        assert.deepEqual(next.config.server.users ?? [], []);
        assert.equal(next.config.accessUpgrade, undefined);
        assert.equal(next.policy.mayUse(now, THIS_SERVER), false);
        assert.equal(next.canSee(now, session), false);
    } finally {
        await next.close();
    }
});

test("a first start cut short after the file was saved is finished by the next", async () => {
    const dataDir = join(root, "data-cut");
    const made = await openApp(model, dataDir);
    const gail = made.config.addUser("Gail", "guest").user;
    const session = await newSession(made);
    const file = made.config.file;

    await asKeptBefore(made);
    await made.close();
    asBefore(file);

    // The file alone is brought up to date, as when the server stops before it read its sessions.
    const alone = new ConfigStore(dirname(file));

    assert.deepEqual(alone.accessUpgrade, [gail.id]);
    assert.deepEqual(alone.server.users, [gail.id]);
    assert.equal(saved(file).access, 1);

    const next = await openApp(model, dataDir);

    try {
        const now = next.config.userById(gail.id)!;

        assert.equal(next.config.accessUpgrade, undefined);
        assert.equal("accessUpgrade" in saved(file), false);
        assert.deepEqual(next.sessionMeta(session)?.sharedWith, [gail.id]);
        assert.equal(next.canSee(now, session), true);
        assert.equal(next.policy.steer(now, String(session)), "allow");
    } finally {
        await next.close();
    }
});

test("finishing it gives only what still holds: nothing to someone no longer chosen, and no second approval", async () => {
    const dataDir = join(root, "data-again");
    const made = await openApp(model, dataDir);
    const gail = made.config.addUser("Gail", "guest").user;
    const vic = made.config.addUser("Vic", "viewer").user;
    const revoked = await newSession(made);
    const plain = await newSession(made);
    const file = made.config.file;
    const me = owner(made).id;

    await asKeptBefore(made);
    await made.close();
    asBefore(file);

    // The file is brought up to date, and changed before the sessions are shared: Vic is no longer chosen, and one
    // session has an approval already, which was revoked.
    const alone = new ConfigStore(dirname(file));

    assert.deepEqual(alone.accessUpgrade, [gail.id, vic.id]);
    alone.setServerUsers([gail.id]);
    alone.setFolderApprovals([
        {
            session: String(revoked),
            computer: THIS_SERVER,
            folder: work,
            method: "totp",
            by: gail.id,
            approvedAt: 1,
            usedAt: 1,
            lastUser: gail.id,
            revokedAt: 2,
        },
    ]);

    const next = await openApp(model, dataDir);

    try {
        const now = (id: string) => next.config.userById(id)!;

        for (const id of [revoked, plain]) {
            assert.deepEqual(next.sessionMeta(id)?.sharedWith, [gail.id]);
            assert.equal(next.canSee(now(vic.id), id), false);
        }

        // The approval it had is kept as it was, alone; the other session gets the owner's.
        assert.deepEqual(
            next.config.folderApprovals
                .filter((each) => each.session === String(revoked))
                .map((each) => [each.method, each.by, each.revokedAt]),
            [["totp", gail.id, 2]],
        );
        assert.equal(next.policy.steer(now(gail.id), String(revoked)), "locked");
        assert.equal(next.folderApprovals.get(String(plain))?.by, me);
        assert.equal(next.policy.steer(now(gail.id), String(plain)), "allow");
    } finally {
        await next.close();
    }
});

test("with nobody to choose, a person held to a session is still not locked out of it", async () => {
    const dataDir = join(root, "data-held");
    const made = await openApp(model, dataDir);
    const session = await newSession(made);
    const ira = made.config.addUser("Ira", "guest", [String(session)]).user;
    const file = made.config.file;

    await asKeptBefore(made, [session]);
    await made.close();
    asBefore(file);

    const alone = new ConfigStore(dirname(file));

    assert.deepEqual(alone.accessUpgrade, [], "nobody to share with, and still not done");
    assert.deepEqual(alone.server, {});

    const next = await openApp(model, dataDir);

    try {
        const now = next.config.userById(ira.id)!;

        assert.equal(next.config.accessUpgrade, undefined);
        assert.equal(next.sessionMeta(session)?.sharedWith, undefined);
        assert.equal(next.policy.steer(now, String(session)), "allow");
    } finally {
        await next.close();
    }
});
