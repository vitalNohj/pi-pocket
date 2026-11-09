// New folders on this server (`folder-requests.ts`): a chosen person's session in a folder no saved folder covers waits
// for their own authenticator code or the owner's approval, as a runner's would. The owner needs none here; someone not
// chosen is refused before anything waits. An approved folder is saved, unless it is too broad. Each person's tabs hear
// only their own requests; the owner's hear every one.
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

/** A new folder (a real path) no saved folder covers. */
function newFolder(): string {
    const folder = join(root, "projects", `p${String(++folderCount)}`);

    mkdirSync(folder, { recursive: true });

    return realpathSync(folder);
}

/** The next code of `secret`: each code works once, so the clock moves on a step first. */
function nextCode(secret: string): string {
    clock += STEP_MS;

    return totp(secret, Math.floor(clock / STEP_MS));
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
    app.config.setComputerSettings(undefined, { stopAsking: false });

    for (const folder of app.config.server.folders ?? []) {
        app.config.removeServerFolder(folder);
    }
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
    assert.equal(app.config.server.folders, undefined);
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

test("a chosen person approves a new folder with their own code, and it is saved", async () => {
    const folder = newFolder();
    const started = app.commands.createSession(alex, { cwd: folder });
    const request = await pending(alex, folder);

    assert.equal(request.person, alex.id);
    assert.equal(request.kind, "new");
    assert.equal(request.code, true);
    assert.equal(request.saved, false);
    assert.equal(request.broad, false);
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
    assert.deepEqual(app.config.server.folders, [folder]);
    assert.deepEqual(app.folderRequests.list(alex), []);

    // Saved, but "Stop asking" is off: the next session there asks again, and says a saved folder covers it.
    const again = assert.rejects(
        app.commands.createSession(alex, { cwd: folder }),
        /owner did not allow this folder/,
    );
    const second = await pending(alex, folder);

    assert.equal(second.saved, true);
    app.folderRequests.deny(owner(app), second.id);
    await again;

    // With "Stop asking" on, a saved folder and the folders in it start at once.
    app.config.setComputerSettings(undefined, { stopAsking: true });
    mkdirSync(join(folder, "inner"));
    assert.ok(await app.commands.createSession(alex, { cwd: join(folder, "inner") }));
    assert.deepEqual(app.folderRequests.list(owner(app)), []);
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
    assert.deepEqual(app.config.server.folders, [folder]);

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
    assert.deepEqual(app.config.server.folders, [folder]);
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
    assert.equal(app.config.server.folders, undefined);
});

test("a request nobody answers ends after its time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const folder = newFolder();
    const rejected = assert.rejects(
        app.approveFolder(alex, folder, "new"),
        /Nobody approved the folder in time/,
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

test("a folder too broad to save is approved once, and asks again next time", async () => {
    const top = realpathSync("/");
    const waiting = app.approveFolder(alex, top, "new");
    const request = await pending(alex, top);

    assert.equal(request.broad, true);
    await app.folderRequests.approve(owner(app), request.id, { method: "owner" });
    await waiting;
    assert.equal(app.config.server.folders, undefined);
});

test("copies, moves, and linked sessions to a new folder ask as a new session does", async () => {
    const source = newFolder();

    app.config.saveServerFolder(source);
    app.config.setComputerSettings(undefined, { stopAsking: true });

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

    // A copy in the same folder, now saved, needs nothing more.
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
        /can no longer start sessions here/,
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
