// Session approvals on this server (`folder-requests.ts`, `folder-approvals.ts`): a chosen person's new session in a
// folder the owner gave them waits for their own authenticator code or the owner's Allow, kept for that session. It lasts
// its last user's approval time after their last use; then the session is locked until its starter's code or the
// owner's Allow renews it. The owner needs none here; a folder not given, or someone not chosen, is refused before
// anything waits. Copies, moves, and linked sessions inherit. Each person's tabs hear only their own requests; the
// owner's hear every one.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";
import type { User } from "../src/server/config.ts";
import { FOLDER_REQUEST_MS, type FolderRequestView } from "../src/server/folder-requests.ts";
import { createHandler } from "../src/server/http.ts";

let clock = 1_800_000_000_000;
let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let alex: User;
let gale: User;
let vera: User;
let stranger: User;
let alexSecret: string;
let folderCount = 0;

function person(name: string, role: User["role"]): User {
    const { user, token } = app.config.addUser(name, role);

    tokens.set(user.id, token);

    return user;
}

async function call<T = Record<string, unknown>>(
    user: User,
    path: string,
    body?: unknown,
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed as T };
}

/** The folder the owner gives everyone here, and new folders in it (real paths). */
let given: string;

function newFolder(): string {
    const folder = join(given, `p${String(++folderCount)}`);

    mkdirSync(folder, { recursive: true });

    return realpathSync(folder);
}

/** The next code of `secret`: each code works once, so the clock moves on a step first. */
function nextCode(secret: string): string {
    clock += STEP_MS;

    return totp(secret, Math.floor(clock / STEP_MS));
}

/** `user`'s request to renew a locked session, once it is there. */
async function renewing(user: User): Promise<FolderRequestView> {
    let found: FolderRequestView | undefined;

    await until(() => {
        found = app.folderRequests
            .list(user)
            .find((each) => each.kind === "renew" && each.person === user.id);

        return found !== undefined;
    }, `${user.name}'s request to renew`);

    return found!;
}

const DAY = 86_400_000;

/** The request `user` waits on, once it is there. */
async function pending(user: User, folder: string): Promise<FolderRequestView> {
    let found: FolderRequestView | undefined;

    await until(() => {
        found = app.folderRequests.list(user).find((each) => each.folder === folder);

        return found !== undefined;
    }, `a folder request for ${folder}`);

    return found!;
}

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
    alex = person("Alex", "guest");
    gale = person("Gale", "guest");
    vera = person("Vera", "viewer");
    stranger = person("Stranger", "guest");
    app.config.setServerUsers([alex.id, gale.id, vera.id]);
    mkdirSync(join(root, "projects"), { recursive: true });
    given = realpathSync(join(root, "projects"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    const begun = app.authenticators.begin(alex.id, "Alex");

    alexSecret = begun.secret;
    app.authenticators.confirm(alex.id, nextCode(alexSecret));
});

beforeEach(() => {
    for (const each of [alex, gale, vera]) {
        app.config.setGivenFolders(undefined, each.id, [given]);
        app.config.updateUser(each.id, { approvalDays: undefined });
    }

    app.config.setFolderApprovals([]);
});

after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    cleanUp();
});

test("the owner starts a session in any folder here without an approval", async () => {
    const folder = newFolder();
    const { id } = await app.commands.createSession(owner(app), { cwd: folder });

    assert.equal(app.cwdOf(id), folder);
    assert.deepEqual(app.folderRequests.list(owner(app)), []);
    // Nobody was asked, but the session has an approval on the owner's clock, for the people it is shared with.
    assert.deepEqual(
        app.config.folderApprovals
            .filter((each) => each.session === String(id))
            .map((each) => [each.method, each.by]),
        [["owner", owner(app).id]],
    );
});

test("someone not chosen for this server is refused before anything waits", async () => {
    const folder = newFolder();

    await assert.rejects(
        app.commands.createSession(stranger, { cwd: folder }),
        /not chosen you for this server/,
    );
    await assert.rejects(app.approveStart(vera, folder), /view sessions but not start/);
    assert.deepEqual(app.folderRequests.list(owner(app)), []);
});

test("a folder not given is refused before anything waits, and the picker stays in the given ones", async () => {
    const outside = join(root, "outside");

    mkdirSync(outside, { recursive: true });
    await assert.rejects(
        app.commands.createSession(alex, { cwd: outside }),
        /not given you this folder/,
    );
    assert.deepEqual(app.folderRequests.list(owner(app)), []);

    // The picker lists the given folders for a place outside them, and has no way up out of one.
    const away = await call<{ dirs: { path: string }[]; parent: unknown; given: string[] }>(
        alex,
        `fs?path=${encodeURIComponent(outside)}`,
    );

    assert.equal(away.status, 200);
    assert.deepEqual(
        away.body.dirs.map((each) => each.path),
        [given],
    );
    assert.equal(away.body.parent, null);

    const inside = await call<{ path: string; parent: unknown; given: string[] }>(
        alex,
        `fs?path=${encodeURIComponent(given)}`,
    );

    assert.equal(inside.body.path, given);
    assert.equal(inside.body.parent, null);
    assert.deepEqual(inside.body.given, [given]);

    // A new folder is made inside a given one only.
    assert.equal((await call(alex, "fs", { path: join(root, "elsewhere") })).status, 403);
    assert.equal((await call(alex, "fs", { path: join(given, "made-here") })).status, 200);

    // The owner goes anywhere, and is not limited to given folders.
    const ownerView = await call<{ given?: unknown }>(
        owner(app),
        `fs?path=${encodeURIComponent(outside)}`,
    );

    assert.equal(ownerView.body.given, undefined);
});

test("a chosen person starts a session with their own code, and the approval is that session's", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });
    const request = await pending(alex, folder);

    assert.equal(request.person, alex.id);
    assert.equal(request.kind, "new");
    assert.equal(request.code, true);
    assert.equal(request.computer, "this-server");
    assert.equal(request.expiresAt, clock + FOLDER_REQUEST_MS);

    // A wrong code, and another person's call: none of them approve it.
    assert.equal(
        (await call(alex, `folder-requests/${request.id}`, { code: "000000" })).status,
        400,
    );
    assert.equal(
        (await call(gale, `folder-requests/${request.id}`, { code: nextCode(alexSecret) })).status,
        404,
    );
    assert.equal(
        (await call(alex, `folder-requests/${request.id}`, { code: nextCode(alexSecret) })).status,
        200,
    );

    const { id } = await started;
    const approval = app.folderApprovals.get(String(id));

    assert.equal(approval?.method, "totp");
    assert.equal(approval?.folder, folder);
    assert.equal(approval?.lastUser, alex.id);

    // Each new session is its own: the next one in the same folder asks again.
    const next = assert.rejects(app.commands.createSession(alex, { cwd: folder }), /Cancelled/);
    const again = await pending(alex, folder);

    app.folderRequests.deny(alex, again.id);
    await next;
});

test("an approval lasts its last user's time after their last use, and each use resets it", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });

    await app.folderRequests.approve(owner(app), (await pending(alex, folder)).id, {
        method: "owner",
    });

    const { id } = await started;
    const session = String(id);

    // Alex's time: 7 days, the default.
    assert.equal(app.folderApprovals.expiresAt(app.folderApprovals.get(session)!), clock + 7 * DAY);

    clock += 6 * DAY;
    assert.equal(app.folderApprovals.use(session, alex), true);
    clock += 6 * DAY;
    assert.equal(app.folderApprovals.live(session), true, "used a day before it ended");

    // Gale uses it (shared with her): her time, 1 day, counts from now.
    app.config.updateUser(gale.id, { approvalDays: 1 });
    assert.equal(app.folderApprovals.use(session, gale), true);
    clock += DAY + 1;
    assert.equal(app.folderApprovals.live(session), false);
    assert.equal(app.folderApprovals.use(session, alex), false, "locked: no use resets it");
});

test("a locked session waits for a renewal: its starter's code, or the owner's Allow, and stopping stays free", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });

    await app.folderRequests.approve(alex, (await pending(alex, folder)).id, {
        method: "totp",
        code: nextCode(alexSecret),
    });

    const { id } = await started;

    await app.commands.shareSession(id, alex, [gale.id]);
    clock += 8 * DAY;

    // Locked: a send waits for a renewal.
    const sending = app.requireDriver(id, alex);
    const renew = await renewing(alex);

    assert.equal(renew.kind, "renew");
    assert.equal(renew.session, String(id));
    assert.equal(renew.code, true);
    await app.folderRequests.approve(alex, renew.id, {
        method: "totp",
        code: nextCode(alexSecret),
    });
    await sending;
    assert.equal(app.folderApprovals.live(String(id)), true);

    // Someone it is shared with cannot renew with a code: only the owner can allow it.
    clock += 8 * DAY;

    const galeSends = app.requireDriver(id, gale);
    const hers = await renewing(gale);

    assert.equal(hers.code, false);
    await assert.rejects(
        app.folderRequests.approve(gale, hers.id, { method: "totp", code: "123456" }),
        /Only whoever is in charge/,
    );
    assert.ok(app.folderRequests.list(owner(app)).some((each) => each.id === hers.id));
    await app.folderRequests.approve(owner(app), hers.id, { method: "owner" });
    await galeSends;
    assert.equal(app.folderApprovals.get(String(id))?.method, "owner");

    // Stopping work never needs an approval: the run, a schedule, and a pull request watch end at once, for its
    // starter and for someone it is shared with, and nobody is asked.
    const first = await app.commands.schedule(id, alex, { when: "in 10m check it", zone: "UTC" });
    const second = await app.commands.schedule(id, alex, { when: "in 20m and again", zone: "UTC" });

    await app.commands.shareSession(id, alex, [gale.id, vera.id]);
    app.folderApprovals.revoke(String(id), true);
    assert.equal(app.policy.steer(alex, String(id)), "locked");
    // A viewer it is shared with still stops nothing.
    await assert.rejects(app.commands.cancelSchedule(id, vera, first.id), { status: 403 });
    await app.commands.abort(id, alex);
    await app.commands.cancelSchedule(id, alex, first.id);
    await app.commands.cancelSchedule(id, gale, second.id);
    await app.commands.unwatchPr(id, alex);
    assert.deepEqual(await app.schedules.list(id), []);
    assert.deepEqual(app.folderRequests.list(owner(app)), [], "stopping asked nobody");
    assert.equal(app.policy.steer(alex, String(id)), "locked", "and renewed nothing");
});

test("in a locked session, making or editing a webhook waits for the renewal", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });

    await app.folderRequests.approve(alex, (await pending(alex, folder)).id, {
        method: "totp",
        code: nextCode(alexSecret),
    });

    const { id } = await started;
    // Approved: a webhook is made at once.
    const hook = await app.hooks.add(alex, id, { name: "Deploys", instructions: "Check it" });

    clock += 8 * DAY;

    // Locked: a new webhook and an edit wait for the renewal; nothing changes before it.
    let made = false;
    const making = app.hooks
        .add(alex, id, { name: "Later", instructions: "Run anything" })
        .then(() => (made = true));
    const renew = await renewing(alex);

    assert.equal(made, false, "no webhook while it is locked");
    assert.equal((await app.hooks.list(alex)).length, 1);
    await app.folderRequests.approve(alex, renew.id, {
        method: "totp",
        code: nextCode(alexSecret),
    });
    await making;
    assert.equal(made, true);

    clock += 8 * DAY;

    let edited = false;
    const editing = app.hooks
        .update(alex, hook.id, "Run something else")
        .then(() => (edited = true));
    const again = await renewing(alex);

    assert.equal(edited, false);
    assert.equal(
        (await app.hooks.list(alex)).find((each) => each.id === hook.id)?.instructions,
        "Check it",
        "the instructions stay as they were while it is locked",
    );
    await app.folderRequests.approve(owner(app), again.id, { method: "owner" });
    await editing;
    assert.equal(
        (await app.hooks.list(alex)).find((each) => each.id === hook.id)?.instructions,
        "Run something else",
    );
});

test("a person invited to one session waits for its renewal like everyone on it", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });

    await app.folderRequests.approve(alex, (await pending(alex, folder)).id, {
        method: "totp",
        code: nextCode(alexSecret),
    });

    const { id } = await started;
    const invited = app.config.addUser("Invited once", "guest", [String(id)]).user;

    // Approved: the invited person sends at once.
    await app.requireDriver(id, invited);

    // Locked: their send waits, as anyone's, until the owner allows it.
    clock += 8 * DAY;

    let through = false;
    const sending = app.requireDriver(id, invited).then(() => (through = true));
    const theirs = await renewing(invited);

    assert.equal(through, false, "the lock holds them too");
    assert.equal(theirs.code, false, "only the owner can allow it: they did not start it");
    await app.folderRequests.approve(owner(app), theirs.id, { method: "owner" });
    await sending;
    assert.equal(through, true);

    await app.removeUser(owner(app), invited.id);
});

test("the owner renews or revokes a session's approval from the list; its starter revokes their own", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });

    await app.folderRequests.approve(owner(app), (await pending(alex, folder)).id, {
        method: "owner",
    });

    const { id } = await started;
    const session = String(id);

    // Alex lists their own; Gale, who did not start it, does not.
    assert.deepEqual(
        (await call<{ session: string }[]>(alex, "session-approvals")).body.map(
            (each) => each.session,
        ),
        [session],
    );
    assert.deepEqual((await call<unknown[]>(gale, "session-approvals")).body, []);
    assert.equal(
        (await call(owner(app), "session-approvals")).body instanceof Array &&
            (await call<{ session: string }[]>(owner(app), "session-approvals")).body.some(
                (each) => each.session === session,
            ),
        true,
    );

    // Gale cannot revoke it; Alex can.
    const revoke = (user: User) =>
        fetch(`${address}/api/session-approvals/${session}`, {
            method: "DELETE",
            headers: {
                authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
                "X-Pocket": "1",
            },
        });

    assert.equal((await revoke(gale)).status, 404);
    assert.equal((await revoke(alex)).status, 200);
    assert.equal(app.folderApprovals.live(session), false);

    // The owner renews it with Allow, no code; Gale cannot.
    assert.equal((await call(gale, `session-approvals/${session}`, {})).status, 404);
    assert.equal((await call(owner(app), `session-approvals/${session}`, {})).status, 200);
    assert.equal(app.folderApprovals.live(session), true);

    // Its starter renews with their own code.
    await revoke(alex);
    assert.equal((await call(alex, `session-approvals/${session}`, {})).status, 403);
    assert.equal(
        (await call(alex, `session-approvals/${session}`, { code: nextCode(alexSecret) })).status,
        200,
    );
    assert.equal(app.folderApprovals.get(session)?.method, "totp");
});

test("the owner approves or denies a guest's new session from the app", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(gale, { cwd: folder });
    const request = await pending(gale, folder);

    // Gale has no authenticator: only the owner can let them in, and a code is no use.
    assert.equal(request.code, false);
    assert.equal(
        (await call(gale, `folder-requests/${request.id}`, { approve: true })).status,
        403,
    );
    assert.equal(
        (await call(owner(app), `folder-requests/${request.id}`, { approve: true })).status,
        200,
    );
    assert.equal(app.folderApprovals.get(String((await started).id))?.method, "owner");

    const other = newFolder();
    const denied = assert.rejects(
        app.commands.createSession(gale, { cwd: other }),
        /was not allowed/,
    );
    const second = await pending(gale, other);

    assert.equal(
        (await call(owner(app), `folder-requests/${second.id}`, { deny: true })).status,
        200,
    );
    await denied;
});

test("a request ends when its person cancels, the caller gives up, or nobody answers in time", async () => {
    const folder = newFolder();
    const cancelled = assert.rejects(
        app.commands.createSession(alex, { cwd: folder }),
        /Cancelled/,
    );
    const request = await pending(alex, folder);

    assert.equal((await call(alex, `folder-requests/${request.id}`, { deny: true })).status, 200);
    await cancelled;
    assert.equal(
        (await call(alex, `folder-requests/${request.id}`, { code: nextCode(alexSecret) })).status,
        404,
    );

    const controller = new AbortController();
    const aborted = assert.rejects(
        app.commands.createSession(alex, { cwd: folder }, { signal: controller.signal }),
        /Cancelled/,
    );

    await pending(alex, folder);
    controller.abort();
    await aborted;
    assert.deepEqual(app.folderRequests.list(owner(app)), []);
    assert.deepEqual(app.config.folderApprovals, []);
});

test("a request nobody answers ends after its time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const folder = newFolder();
    const rejected = assert.rejects(app.approveStart(alex, folder), /Nobody approved it in time/);

    // `until` polls with the timers mocked here: wait on the event loop instead.
    for (let turn = 0; app.folderRequests.list(alex).length === 0; turn++) {
        assert.ok(turn < 10_000, "the request is there");
        await new Promise((resolve) => setImmediate(resolve));
    }

    t.mock.timers.tick(FOLDER_REQUEST_MS - 1);
    assert.equal(app.folderRequests.list(alex).length, 1);
    t.mock.timers.tick(1);
    await rejected;
    assert.deepEqual(app.folderRequests.list(owner(app)), []);
});

test("copies, moves, and linked sessions inherit the session's approval, in folders given to them", async () => {
    const source = newFolder();
    const started = app.commands.createSession(alex, { cwd: source });

    await app.folderRequests.approve(owner(app), (await pending(alex, source)).id, {
        method: "owner",
    });

    const { id } = await started;

    // A move to another given folder asks nothing; one not given is refused.
    const target = newFolder();

    await app.commands.configure(id, alex, { cwd: target });
    assert.equal(app.cwdOf(id), target);
    assert.equal(app.folderApprovals.get(String(id))?.folder, target);
    await assert.rejects(
        app.commands.configure(id, alex, { cwd: realpathSync(root) }),
        /not given you this folder/,
    );

    // A copy inherits the approval.
    const copy = await app.commands.fork(id, alex, {});

    assert.equal(app.folderApprovals.live(String(copy.id)), true);
    assert.deepEqual(app.folderRequests.list(owner(app)), []);

    // A linked session the agent starts in another given folder inherits too: the agent gets no more than its person.
    await app.commands.configure(id, alex, {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    const { submissionId } = await app.commands.submit(id, alex, {
        text: "hello",
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    const elsewhere = newFolder();
    const { session, address: linked } = await app.linkedSessions.start(
        id,
        { message: "Work over there", cwd: elsewhere },
        crypto.randomUUID(),
    );

    assert.equal(app.cwdOf(session), elsewhere);
    assert.equal(app.folderApprovals.live(String(session)), true);
    assert.deepEqual(app.folderRequests.list(owner(app)), []);

    // A locked source is renewed before its copy is made.
    clock += 8 * DAY;

    // Stopping the linked session asks nobody, though both sessions are locked.
    assert.equal(app.policy.steer(alex, String(id)), "locked");
    assert.equal(app.policy.steer(alex, String(session)), "locked");
    await app.linkedSessions.stop(id, { to: linked }, crypto.randomUUID());
    assert.deepEqual(app.folderRequests.list(owner(app)), [], "stopping asked nobody");

    const copying = app.commands.fork(id, alex, {});
    const renew = await renewing(alex);

    await app.folderRequests.approve(owner(app), renew.id, { method: "owner" });
    assert.equal(app.folderApprovals.live(String((await copying).id)), true);
});

test("a person removed from this server loses their waiting requests, and their sessions go to the owner", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(gale, { cwd: folder });

    await app.folderRequests.approve(owner(app), (await pending(gale, folder)).id, {
        method: "owner",
    });

    const { id } = await started;
    const waiting = assert.rejects(
        app.commands.createSession(gale, { cwd: newFolder() }),
        /can no longer work there/,
    );

    await until(() => app.folderRequests.list(gale).length === 1, "Gale's second request");

    try {
        await app.choosePeople(THIS_SERVER, [alex.id, vera.id]);
        await waiting;
        assert.deepEqual(app.folderRequests.list(owner(app)), []);
        assert.equal(
            app.sessionMeta(id)?.createdBy,
            owner(app).id,
            "her session is the owner's now",
        );
        assert.equal(app.canSee(gale, id), false);
    } finally {
        app.config.setServerUsers([alex.id, gale.id, vera.id]);
    }
});

test("taking a folder back moves sessions there to the owner, and leaves the others", async () => {
    const kept = newFolder();
    const taken = newFolder();
    const ids: ConversationId[] = [];

    for (const folder of [kept, taken]) {
        const started = app.commands.createSession(alex, { cwd: folder });

        await app.folderRequests.approve(owner(app), (await pending(alex, folder)).id, {
            method: "owner",
        });
        ids.push((await started).id);
    }

    app.config.setGivenFolders(undefined, alex.id, [kept]);
    await app.handOver(alex.id, THIS_SERVER);
    assert.equal(app.sessionMeta(ids[0]!)?.createdBy, alex.id);
    assert.equal(app.sessionMeta(ids[1]!)?.createdBy, owner(app).id);
});

test("each person's tabs hear only their own requests, and the owner's every one", async () => {
    const ownerTab = fakeTab(undefined, owner(app));
    const alexTab = fakeTab(undefined, alex);
    const galeTab = fakeTab(undefined, gale);

    await app.attach(ownerTab.client);
    await app.attach(alexTab.client);
    await app.attach(galeTab.client);

    try {
        const folder = newFolder();
        const waiting = assert.rejects(app.commands.createSession(gale, { cwd: folder }));
        const request = await pending(gale, folder);
        const heard = (tab: typeof ownerTab) =>
            tab.events
                .filter((each) => each.event === "folder-requests")
                .flatMap((each) => each.data as unknown as FolderRequestView[]);

        await until(() => heard(galeTab).length > 0, "Gale's tab hears the request");
        assert.ok(heard(ownerTab).some((each) => each.id === request.id));
        assert.ok(heard(galeTab).some((each) => each.id === request.id));
        assert.deepEqual(heard(alexTab), [], "Alex never hears of Gale's request");

        app.folderRequests.deny(owner(app), request.id);
        await waiting;
        assert.deepEqual(galeTab.last("folder-requests"), []);
        assert.deepEqual(heard(alexTab), []);
    } finally {
        app.detach(ownerTab.client);
        app.detach(alexTab.client);
        app.detach(galeTab.client);
    }
});
