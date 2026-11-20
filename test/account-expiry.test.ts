// A temporary account's own clock starts when its invite is spent, and its end removes it as People does.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { Auth, type InviteGrant } from "../src/server/auth.ts";
import { createHandler } from "../src/server/http.ts";

const DAY = 24 * 60 * 60_000;
const clock = Date.now();
let app: App;
let server: Server;
let address: string;

async function call<T = { error: string }>(token: string, path: string, body?: unknown) {
    const response = await fetch(`${address}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${token}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as T };
}

const makeInvite = (body: { temporary?: boolean; accountMinutes?: unknown }) =>
    call<{ code: string; grant: InviteGrant }>(app.config.ownerToken, "invite", body);
const access = (id: string, patch: unknown, token = app.config.ownerToken) =>
    call(token, `users/${id}`, patch);

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
        server === undefined ? resolve() : server.close(() => resolve()),
    );
    await app?.close();
    cleanUp();
});

test("a temporary invite starts the account's lifetime when they join", async (t) => {
    const auth = new Auth(app.config);
    const answer = await makeInvite({ accountMinutes: 1440 });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.grant, { role: "viewer", temporary: true, accountMinutes: 1440 });

    // They spend the invite five minutes after it was made, not when it was created.
    const joiningAt = Date.now() + 5 * 60_000;
    const wall = t.mock.method(Date, "now", () => joiningAt);

    try {
        const added = auth.redeem(answer.body.code, "One day");

        assert.ok(added);
        assert.equal(added.user.role, "viewer");
        assert.equal(added.user.temporary, true);
        assert.equal(added.user.expiresAt, joiningAt + DAY);
    } finally {
        wall.mock.restore();
    }

    for (const [body, temporary] of [
        [{}, true],
        [{ accountMinutes: null }, true],
        [{ temporary: false, accountMinutes: 1440 }, undefined],
        [{ temporary: false, accountMinutes: "ignored" }, undefined],
    ] as const) {
        const forever = await makeInvite(body);

        assert.equal(forever.status, 200);
        assert.equal(forever.body.grant.temporary, temporary);
        assert.equal(Object.hasOwn(forever.body.grant, "accountMinutes"), false);
        assert.equal(Object.hasOwn(app.config.invite(forever.body.code)!, "accountMinutes"), false);

        const added = auth.redeem(forever.body.code, "No end");

        assert.ok(added);
        assert.equal(added.user.temporary, temporary);
        assert.equal(Object.hasOwn(added.user, "expiresAt"), false);
    }

    // The auth helper also drops the lifetime when a caller grants a full account directly.
    const { code } = auth.createInvite(owner(app), { role: "viewer", accountMinutes: 1440 });

    assert.equal(Object.hasOwn(app.config.invite(code)!, "accountMinutes"), false);
});

test("an invite refuses an unsupported accountMinutes", async () => {
    for (const accountMinutes of [15, "1440", true, {}]) {
        const answer = await call(app.config.ownerToken, "invite", { accountMinutes });

        assert.equal(answer.status, 400);
        assert.equal(answer.body.error, "accountMinutes must be 1440, 10080, or 43200");
    }
});

test("expireAccounts removes the person, their token, and their session share", async () => {
    const end = clock + DAY / 2;
    const { user, token } = app.config.addUser("Expiring", "viewer", undefined, true, end);
    const session = await newSession(app);
    const tab = fakeTab(undefined, user);

    await app.choosePerson(THIS_SERVER, user.id, true);
    assert.deepEqual(await app.commands.shareSession(session, owner(app), [user.id]), [user.id]);
    assert.deepEqual(app.sessionMeta(session)?.sharedWith, [user.id]);
    assert.equal(app.config.userByToken(token)?.id, user.id);
    await app.attach(tab.client);

    try {
        assert.equal(await app.expireAccounts(end - 1), 0);
        assert.equal(await app.expireAccounts(end), 1);
        assert.ok(!app.config.users.some((each) => each.id === user.id));
        assert.equal(app.config.userByToken(token), undefined);
        assert.equal(app.sessionMeta(session)?.sharedWith, undefined);
        assert.ok(tab.events.some((each) => each.event === "closing"));
    } finally {
        app.detach(tab.client);
    }
});

test("an expired token is refused before the account sweep", async () => {
    const { user, token } = app.config.addUser(
        "Expired",
        "viewer",
        undefined,
        true,
        Date.now() - 1,
    );
    const device = app.config.addDevice(user.id)!;

    try {
        assert.equal((await call(token, "users")).status, 401);
        assert.equal((await call(device, "users")).status, 401);
        assert.ok(
            app.config.users.some((each) => each.id === user.id),
            "not swept yet",
        );
    } finally {
        app.config.removeUser(user.id);
    }
});

test("only someone who manages the account can set or clear its end", async () => {
    const { user } = app.config.addUser("Temporary", "viewer", undefined, true, clock + DAY);
    const other = app.config.addUser("Other", "guest");
    const end = clock + 7 * DAY;
    const kept = () => app.config.userById(user.id)!;

    assert.equal((await access(user.id, { expiresAt: end })).status, 200);
    assert.equal(kept().expiresAt, end);

    const refused = await access(user.id, { expiresAt: null }, other.token);

    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "Only the owner can do that");
    assert.equal(kept().expiresAt, end);

    for (const expiresAt of [clock - 1, clock, String(end), true]) {
        const answer = await access(user.id, { expiresAt });

        assert.equal(answer.status, 400);
        assert.equal(answer.body.error, "expiresAt must be a time in the future, or null");
    }

    assert.equal(kept().expiresAt, end);
    assert.equal((await access(user.id, { expiresAt: null })).status, 200);
    assert.equal(Object.hasOwn(kept(), "expiresAt"), false);
});

test("a full account rejects expiresAt", async () => {
    const { user } = app.config.addUser("Full", "viewer", undefined, false, clock + DAY);

    assert.equal(Object.hasOwn(user, "expiresAt"), false);

    for (const expiresAt of [clock + DAY, null]) {
        const answer = await access(user.id, { expiresAt });

        assert.equal(answer.status, 409);
        assert.equal(answer.body.error, "Only a temporary account expires.");
    }
});

test("making a temporary account full drops expiresAt", async () => {
    for (const patch of [{ temporary: false }, { temporary: false, expiresAt: clock + 2 * DAY }]) {
        const { user } = app.config.addUser("Going full", "viewer", undefined, true, clock + DAY);

        assert.equal((await access(user.id, patch)).status, 200);
        assert.equal(Object.hasOwn(app.config.userById(user.id)!, "expiresAt"), false);
        assert.equal(app.config.userById(user.id)?.temporary, undefined);
    }
});

test("People sends expiresAt only to the person and those who manage them", async () => {
    const end = clock + DAY;
    const { user, token } = app.config.addUser("Temporary", "viewer", undefined, true, end);
    const other = app.config.addUser("Other", "guest");
    const manager = app.config.addUser("Manager", "guest");

    app.config.updateUser(manager.user.id, { managesUsers: true });

    for (const [as, visible] of [
        [app.config.ownerToken, true],
        [token, true],
        [manager.token, true],
        [other.token, false],
    ] as const) {
        const answer = await call<{ id: string; expiresAt?: number }[]>(as, "users");
        const row = answer.body.find((each) => each.id === user.id);

        assert.equal(answer.status, 200);
        assert.ok(row);
        assert.equal(Object.hasOwn(row, "expiresAt"), visible);
        assert.equal(row.expiresAt, visible ? end : undefined);
    }

    const hello = await app.hello(user);

    assert.equal(hello.user.temporary, true);
    assert.equal(hello.user.expiresAt, end);
});

test("opening the app removes accounts that ended while it was closed", async () => {
    const data = join(root, "expiry-startup");
    const end = clock + DAY;
    let now = clock;
    let opened = await openApp(scriptedModel(), data, () => now);

    try {
        const { user } = opened.config.addUser("Expired offline", "viewer", undefined, true, end);
        const lasting = opened.config.addUser("Still here", "viewer", undefined, true, end + DAY);
        const session = await newSession(opened);

        await opened.choosePerson(THIS_SERVER, user.id, true);
        await opened.commands.shareSession(session, owner(opened), [user.id]);
        await opened.close();
        now = end;
        opened = await openApp(scriptedModel(), data, () => now);
        assert.equal(opened.config.userById(user.id), undefined);
        assert.equal(opened.sessionMeta(session)?.sharedWith, undefined);
        assert.equal(opened.config.userById(lasting.user.id)?.expiresAt, end + DAY);
    } finally {
        await opened.close();
    }
});
