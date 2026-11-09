// Approvals on this server (`folder-requests.ts`, `folder-approvals.ts`): a chosen person's session in a folder the owner
// gave them waits for their own authenticator code or the owner's approval, which is then kept for that folder until
// unused for the person's approval time. The owner needs none here; a folder not given, or someone not chosen, is
// refused before anything waits. Sending to a session needs the approval to be live too. Each person's tabs hear only
// their own requests; the owner's hear every one.
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
import { STEP_MS, totp } from "../src/runner/totp.ts";
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

/** `user`'s request to send to a session, once it is there. */
async function steering(user: User): Promise<FolderRequestView> {
    let found: FolderRequestView | undefined;

    await until(() => {
        found = app.folderRequests.list(user).find((each) => each.kind === "steer");

        return found !== undefined;
    }, `${user.name}'s request to send`);

    return found!;
}

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
    assert.deepEqual(app.config.folderApprovals, []);
});

test("someone not chosen for this server is refused before anything waits", async () => {
    const folder = newFolder();

    await assert.rejects(
        app.commands.createSession(stranger, { cwd: folder }),
        /not chosen you for this server/,
    );
    assert.deepEqual(app.folderRequests.list(owner(app)), []);
    await assert.rejects(app.approveFolder(vera, folder, "new"), /view sessions but not start/);
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

test("a chosen person approves a folder with their own code, and the approval is kept for it", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });
    const request = await pending(alex, folder);

    assert.equal(request.person, alex.id);
    assert.equal(request.kind, "new");
    assert.equal(request.code, true);
    assert.equal(request.computer, "this-server");
    assert.equal(request.expiresAt, clock + FOLDER_REQUEST_MS);

    // A wrong code, someone else's request, and another person's code: none of them approve it.
    assert.equal(
        (await call(alex, `folder-requests/${request.id}`, { code: "000000" })).status,
        400,
    );
    assert.equal(
        (await call(gale, `folder-requests/${request.id}`, { code: nextCode(alexSecret) })).status,
        404,
    );
    assert.equal(
        (await call(gale, `folder-requests/${request.id}`, { approve: true })).status,
        404,
    );
    assert.equal(app.folderRequests.list(alex).length, 1);

    const approved = await call(alex, `folder-requests/${request.id}`, {
        code: nextCode(alexSecret),
    });

    assert.equal(approved.status, 200);

    const { id } = await started;

    assert.equal(app.cwdOf(id), folder);
    assert.deepEqual(
        app.folderApprovals.list(alex).map((each) => [each.folder, each.method, each.by]),
        [[folder, "totp", alex.id]],
    );
    assert.deepEqual(app.folderRequests.list(alex), []);

    // While it lasts, the next session there starts at once; a folder inside it is another folder, and asks.
    assert.ok(await app.commands.createSession(alex, { cwd: folder }));
    mkdirSync(join(folder, "inner"));

    const inner = assert.rejects(
        app.commands.createSession(alex, { cwd: join(folder, "inner") }),
        /owner did not allow/,
    );

    app.folderRequests.deny(owner(app), (await pending(alex, join(folder, "inner"))).id);
    await inner;
});

test("an approval ends once unused for the person's time, and each use starts the clock again", async () => {
    const folder = newFolder();
    const day = 86_400_000;

    app.folderApprovals.add(alex.id, { computer: "this-server", folder }, "owner", owner(app).id);

    // Used on day 6: the 7 days start again from there.
    clock += 6 * day;
    assert.ok(await app.commands.createSession(alex, { cwd: folder }));
    clock += 6 * day;
    assert.ok(await app.commands.createSession(alex, { cwd: folder }));

    // Unused for more than 7 days: it ends, and asks again.
    clock += 8 * day;

    const asked = assert.rejects(app.commands.createSession(alex, { cwd: folder }), /Cancelled/);

    app.folderRequests.deny(alex, (await pending(alex, folder)).id);
    await asked;

    // The owner sets Alex's time to never: no more asking, but still only in given folders.
    assert.equal(
        (await call(owner(app), `users/${alex.id}/approval-days`, { days: 0 })).status,
        200,
    );
    assert.ok(await app.commands.createSession(alex, { cwd: folder }));
    assert.equal((await call(alex, `users/${alex.id}/approval-days`, { days: 0 })).status, 403);
    assert.equal(
        (await call(owner(app), `users/${alex.id}/approval-days`, { days: 3 })).status,
        400,
    );
});

test("each person sees and revokes their own approvals; the owner sees and revokes every one", async () => {
    const folder = newFolder();
    const alexs = app.folderApprovals.add(
        alex.id,
        { computer: "this-server", folder },
        "totp",
        alex.id,
    );
    const gales = app.folderApprovals.add(
        gale.id,
        { computer: "this-server", folder },
        "owner",
        owner(app).id,
    );
    const ids = (body: unknown) => (body as { id: string }[]).map((each) => each.id).sort();

    assert.deepEqual(ids((await call(alex, "approvals")).body), [alexs.id]);
    assert.deepEqual(ids((await call(owner(app), "approvals")).body), [alexs.id, gales.id].sort());

    const revoke = async (user: User, id: string) =>
        (
            await fetch(`${address}/api/approvals/${id}`, {
                method: "DELETE",
                headers: {
                    authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
                    "X-Pocket": "1",
                },
            })
        ).status;

    assert.equal(await revoke(alex, gales.id), 404, "not Alex's to revoke, nor to know of");
    assert.equal(await revoke(alex, alexs.id), 200);
    assert.equal(await revoke(owner(app), gales.id), 200);
    assert.deepEqual(app.config.folderApprovals, []);
});

test("taking a folder back, or the person off this server, ends their approvals there", async () => {
    const folder = newFolder();

    app.folderApprovals.add(alex.id, { computer: "this-server", folder }, "totp", alex.id);
    await app.giveFolders(owner(app), "this-server", alex.id, [join(root, "outside")]);
    assert.deepEqual(app.folderApprovals.list(alex), []);
    await app.giveFolders(owner(app), "this-server", alex.id, [given]);

    app.folderApprovals.add(gale.id, { computer: "this-server", folder }, "totp", gale.id);

    try {
        app.config.setServerUsers([alex.id, vera.id]);
        app.accessChanged();
        assert.deepEqual(app.folderApprovals.list(gale), []);
    } finally {
        app.config.setServerUsers([alex.id, gale.id, vera.id]);
    }

    // Only the owner gives folders, only to chosen people, and only real folders.
    assert.equal(
        (await call(alex, "runners/this-server/given", { person: alex.id, folders: [given] }))
            .status,
        403,
    );
    assert.equal(
        (
            await call(owner(app), "runners/this-server/given", {
                person: stranger.id,
                folders: [given],
            })
        ).status,
        400,
    );
    assert.equal(
        (
            await call(owner(app), "runners/this-server/given", {
                person: alex.id,
                folders: [join(root, "missing")],
            })
        ).status,
        400,
    );
});

test("sending to a session needs a live approval: of the folder for one's own, of the session for a shared one", async () => {
    const folder = newFolder();

    app.folderApprovals.add(alex.id, { computer: "this-server", folder }, "totp", alex.id);

    const { id } = await app.commands.createSession(alex, { cwd: folder });

    await app.commands.configure(id, alex, {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await app.commands.shareSession(id, alex, [gale.id]);

    // Alex's own session: the folder's approval lets them send.
    const sent = await app.commands.submit(id, alex, {
        text: "hi",
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(sent.submissionId, context))!.wait(context);

    // Gale sees the shared session, but must approve it before sending; the owner may approve it for them.
    const sending = app.commands.submit(id, gale, {
        text: "me too",
        requestId: crypto.randomUUID(),
    });
    const steer = await steering(gale);

    assert.equal(steer.session, String(id));
    await app.folderRequests.approve(owner(app), steer.id, { method: "owner" });

    const theirs = await sending;

    await (await app.harness.submission(theirs.submissionId, context))!.wait(context);
    assert.ok(app.folderApprovals.list(gale).some((each) => each.session === String(id)));

    // Alex's approval ends: their next message waits for a code.
    app.config.setFolderApprovals(
        app.config.folderApprovals.filter((each) => each.person !== alex.id),
    );

    const later = assert.rejects(
        app.commands.submit(id, alex, { text: "again", requestId: crypto.randomUUID() }),
        /Cancelled/,
    );
    const again = await steering(alex);

    assert.equal(again.folder, folder);
    assert.equal(again.session, undefined);
    app.folderRequests.deny(alex, again.id);
    await later;

    // Unshared, Gale's approval of the session ends with it.
    await app.commands.shareSession(id, alex, []);
    assert.deepEqual(app.folderApprovals.list(gale), []);
});

test("the owner approves or denies a guest's new folder from the app", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(gale, { cwd: folder });
    const request = await pending(gale, folder);

    // Gale has no authenticator: only the owner can let them in, and a code is no use.
    assert.equal(request.code, false);
    assert.equal(
        (await call(gale, `folder-requests/${request.id}`, { code: "123456" })).status,
        400,
    );
    assert.equal(
        (await call(gale, `folder-requests/${request.id}`, { approve: true })).status,
        403,
    );
    assert.ok(app.folderRequests.list(owner(app)).some((each) => each.id === request.id));
    assert.equal(
        (await call(owner(app), `folder-requests/${request.id}`, { approve: true })).status,
        200,
    );
    assert.equal(app.cwdOf((await started).id), folder);
    assert.equal(app.folderApprovals.list(gale)[0]?.method, "owner");

    const other = newFolder();
    const denied = assert.rejects(
        app.commands.createSession(gale, { cwd: other }),
        /owner did not allow this folder/,
    );
    const second = await pending(gale, other);

    assert.equal(
        (await call(owner(app), `folder-requests/${second.id}`, { deny: true })).status,
        200,
    );
    await denied;
    assert.deepEqual(
        app.folderApprovals.list(gale).map((each) => each.folder),
        [folder],
    );
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
    const rejected = assert.rejects(
        app.approveFolder(alex, folder, "new"),
        /Nobody approved it in time/,
    );

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

test("copies, moves, and linked sessions to a new folder ask as a new session does", async () => {
    const source = newFolder();

    app.folderApprovals.add(alex.id, { computer: "this-server", folder: source }, "totp", alex.id);

    const { id } = await app.commands.createSession(alex, { cwd: source });

    // A move to another folder asks; denied, the session stays where it was.
    const target = newFolder();
    const moving = assert.rejects(
        app.commands.configure(id, alex, { cwd: target }),
        /owner did not allow this folder/,
    );
    const move = await pending(alex, target);

    assert.equal(move.kind, "move");
    app.folderRequests.deny(owner(app), move.id);
    await moving;
    assert.equal(app.cwdOf(id), source);

    // Approved, it moves.
    const moved = app.commands.configure(id, alex, { cwd: target });

    await app.folderRequests.approve(owner(app), (await pending(alex, target)).id, {
        method: "owner",
    });
    await moved;
    assert.equal(app.cwdOf(id), target);

    // A copy in the same folder, now approved, needs nothing more.
    const copy = await app.commands.fork(id, alex, {});

    assert.equal(app.cwdOf(copy.id), target);
    assert.deepEqual(app.folderRequests.list(owner(app)), []);

    // A linked session the agent starts for Alex in another folder asks Alex, as their own session there would: the
    // agent gets no more than the person it works for.
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
    const linking = app.linkedSessions.start(
        id,
        { message: "Work over there", cwd: elsewhere },
        crypto.randomUUID(),
    );
    const linked = await pending(alex, elsewhere);

    assert.equal(linked.kind, "linked");
    assert.equal(linked.person, alex.id);
    await app.folderRequests.approve(alex, linked.id, {
        method: "totp",
        code: nextCode(alexSecret),
    });
    assert.equal(app.cwdOf((await linking).session), elsewhere);
});

test("a person removed from this server loses their waiting requests", async () => {
    const folder = newFolder();
    const waiting = assert.rejects(
        app.commands.createSession(gale, { cwd: folder }),
        /can no longer work there/,
    );

    await pending(gale, folder);

    try {
        app.config.setServerUsers([alex.id, vera.id]);
        app.accessChanged();
        await waiting;
        assert.deepEqual(app.folderRequests.list(owner(app)), []);
    } finally {
        app.config.setServerUsers([alex.id, gale.id, vera.id]);
    }
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
