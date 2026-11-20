// Manage users: the owner lets a user manage people (`access.ts` `managesPeople`). Such a user reads of a person what the
// owner reads, and changes what that person may do, but never themselves, the owner, or another who manages users, and
// gives no more than they have themselves. Only the owner sets it, and it ends when they are no longer a full user.
import { type App, cleanUp, linkAuthenticator, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const clock = 1_800_000_000_000;
const tokens = new Map<string, string>();

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call<T = { error?: string }>(
    user: User,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method,
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

/** A request that must be refused with `status` and words like `said`. */
async function refused(
    user: User,
    path: string,
    body: unknown,
    status: number,
    said: RegExp,
    method?: string,
): Promise<void> {
    const answer = await call(user, path, body, method);

    assert.equal(answer.status, status, `${user.name} ${path}`);
    assert.match(String(answer.body.error), said, `${user.name} ${path}`);
}

/** A request that must work. */
async function done(user: User, path: string, body?: unknown, method?: string): Promise<void> {
    const answer = await call(user, path, body, method);

    assert.equal(answer.status, 200, `${user.name} ${path}: ${JSON.stringify(answer.body)}`);
}

/** The record of `id` as it is kept now. */
const kept = (id: string) => app.config.userById(id);
/** What `viewer` is told of `target` in the people list. */
const told = (viewer: User, target: User) =>
    app.people(kept(viewer.id) ?? viewer).find((each) => each.id === target.id) as
        Record<string, unknown> | undefined;

/** A user who manages users, made so by the owner. */
async function manager(name: string): Promise<User> {
    const user = person(name, "guest");

    await done(owner(app), `users/${user.id}/manages-users`, { on: true });

    return user;
}

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
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app?.close();
    cleanUp();
});

test("only the owner lets someone manage users, and only a user who is not limited to one session", async () => {
    const mona = person("Mona", "guest");
    const gil = person("Gil", "guest");
    const vera = person("Vera", "viewer");
    const sam = person("Sam", "guest", ["1"]);
    const path = (user: User) => `users/${user.id}/manages-users`;

    // Off for everyone but the owner.
    assert.equal((await app.hello(owner(app))).user.managesUsers, true);
    assert.equal((await app.hello(mona)).user.managesUsers, false);

    await refused(mona, path(gil), { on: true }, 403, /Only the owner can do that/);
    await refused(mona, path(mona), { on: true }, 403, /Only the owner can do that/);
    await refused(owner(app), path(vera), { on: true }, 400, /must be a user who is not limited/);
    await refused(owner(app), path(sam), { on: true }, 400, /must be a user who is not limited/);
    await refused(owner(app), path(owner(app)), { on: true }, 404, /No such person/);
    await refused(owner(app), "users/nobody/manages-users", { on: true }, 404, /No such person/);
    await refused(owner(app), path(mona), { on: "yes" }, 400, /on must be true or false/);
    assert.equal(kept(mona.id)?.managesUsers, undefined);

    await done(owner(app), path(mona), { on: true });
    assert.equal(kept(mona.id)?.managesUsers, true);
    assert.equal((await app.hello(kept(mona.id)!)).user.managesUsers, true);
    assert.equal((await app.hello(gil)).user.managesUsers, false);

    // The owner and they themselves read it, and so does who manages users. Nobody else.
    assert.equal(told(owner(app), mona)?.managesUsers, true);
    assert.equal(told(mona, mona)?.managesUsers, true);
    assert.equal(told(gil, mona)?.managesUsers, undefined);

    // Even with it, they do not give it to anyone, and do not take it from themselves.
    await refused(mona, path(gil), { on: true }, 403, /Only the owner can do that/);
    await refused(mona, path(mona), { on: false }, 403, /Only the owner can do that/);

    await done(owner(app), path(mona), { on: false });
    assert.equal(kept(mona.id)?.managesUsers, undefined);
    assert.equal((await app.hello(kept(mona.id)!)).user.managesUsers, false);
});

test("who manages users reads of a person what the owner reads, and nobody else does", async () => {
    const mona = await manager("Mona 2");
    const gil = person("Gil 2", "guest");
    const vera = person("Vera 2", "viewer");

    linkAuthenticator(app, vera);
    app.config.updateUser(vera.id, { approvalDays: 14 });

    for (const viewer of [owner(app), mona]) {
        const row = told(viewer, vera);

        assert.equal(row?.authenticator, true, viewer.name);
        assert.equal(row?.hasCode, true, viewer.name);
        assert.equal(row?.approvalDays, 14, viewer.name);
    }

    const row = told(gil, vera);

    assert.equal(row?.name, "Vera 2");
    assert.equal(row?.authenticator, undefined);
    assert.equal(row?.hasCode, undefined);
    assert.equal(row?.approvalDays, undefined);
});

test("who manages users makes a viewer a user and back, removes their authenticator, and removes them", async () => {
    const mona = await manager("Mona 3");
    const gil = person("Gil 3", "guest");
    const vera = person("Vera 3", "viewer");

    linkAuthenticator(app, vera);

    // Someone who manages nobody is refused as before.
    await refused(gil, `users/${vera.id}`, { role: "guest" }, 403, /Only the owner can do that/);
    await refused(gil, `users/${vera.id}/remove`, {}, 403, /Only the owner can do that/);
    await refused(
        gil,
        `users/${vera.id}/authenticator`,
        undefined,
        403,
        /Only the owner can do that/,
        "DELETE",
    );
    await refused(
        gil,
        `users/${vera.id}/approval-days`,
        { days: 1 },
        403,
        /Only the owner can do that/,
    );
    assert.equal(kept(vera.id)?.role, "viewer");

    await done(mona, `users/${vera.id}`, { role: "guest" });
    assert.equal(kept(vera.id)?.role, "guest");
    await done(mona, `users/${vera.id}`, { role: "viewer" });
    assert.equal(kept(vera.id)?.role, "viewer");
    await done(mona, `users/${vera.id}`, { role: "guest" });

    // A lost phone: no code of theirs is needed, and they view again until they link a new one.
    await done(mona, `users/${vera.id}/authenticator`, undefined, "DELETE");
    assert.equal(app.authenticators.linked(vera.id), false);
    assert.equal(kept(vera.id)?.role, "viewer");

    await done(mona, `users/${vera.id}/remove`, {});
    assert.equal(kept(vera.id), undefined);

    // A sign-in link for someone else signs a device in as them: the owner's alone.
    await refused(mona, `users/${gil.id}/device`, {}, 403, /Only the owner can do that/);
});

test("who manages users changes neither themselves, the owner, nor another who manages users", async () => {
    const mona = await manager("Mona 4");
    const max = await manager("Max 4");
    const mine = /You cannot change your own access/;
    const theirs = /Only the owner changes someone who manages users/;
    const owners = /Only the owner can do that/;

    linkAuthenticator(app, mona);
    linkAuthenticator(app, max);

    for (const [target, said] of [
        [mona, mine],
        [max, theirs],
        [owner(app), owners],
    ] as const) {
        await refused(mona, `users/${target.id}`, { role: "viewer" }, 403, said);
        await refused(mona, `users/${target.id}/remove`, {}, 403, said);
        await refused(mona, `users/${target.id}/links-runners`, { on: false }, 403, said);
        await refused(mona, `users/${target.id}/invites`, { on: false }, 403, said);
        await refused(mona, `users/${target.id}/keeps-warm`, { on: false }, 403, said);
        await refused(mona, `users/${target.id}/approval-days`, { days: 1 }, 403, said);
        await refused(mona, `users/${target.id}/authenticator`, undefined, 403, said, "DELETE");
    }

    assert.equal(kept(mona.id)?.role, "guest");
    assert.equal(kept(max.id)?.role, "guest");
    assert.equal(kept(max.id)?.managesUsers, true);
    assert.equal(app.authenticators.linked(max.id), true);
    assert.equal(app.authenticators.linked(mona.id), true, "their own takes their own code");
    assert.notEqual(kept(owner(app).id), undefined);

    // The owner changes them as anyone else.
    await done(owner(app), `users/${max.id}/invites`, { on: true });
    assert.equal(kept(max.id)?.invites, true);
    await done(owner(app), `users/${max.id}/approval-days`, { days: 1 });
    assert.equal(kept(max.id)?.approvalDays, 1);
    await done(owner(app), `users/${max.id}/remove`, {});
    assert.equal(kept(max.id), undefined);
});

test("who manages users gives only what they have themselves, and takes back anything", async () => {
    const mona = await manager("Mona 5");
    const gil = person("Gil 5", "guest");
    const more = /You can only give what you have yourself/;

    for (const [route, key] of [
        ["links-runners", "linksRunners"],
        ["invites", "invites"],
        ["keeps-warm", "keepsWarm"],
    ] as const) {
        const path = `users/${gil.id}/${route}`;

        await refused(mona, path, { on: true }, 403, more);
        assert.equal(kept(gil.id)?.[key], undefined, route);

        // What the owner gave someone, they take back without having it.
        await done(owner(app), path, { on: true });
        await done(mona, path, { on: false });
        assert.equal(kept(gil.id)?.[key], undefined, route);

        // With it themselves, they give it.
        await done(owner(app), `users/${mona.id}/${route}`, { on: true });
        await done(mona, path, { on: true });
        assert.equal(kept(gil.id)?.[key], true, route);
    }

    // Approvals: no longer than their own (7 days until the owner says otherwise; 0 never ends, the longest).
    const days = `users/${gil.id}/approval-days`;

    await refused(mona, days, { days: 14 }, 403, more);
    await refused(mona, days, { days: 0 }, 403, more);
    assert.equal(kept(gil.id)?.approvalDays, undefined);
    await done(mona, days, { days: 1 });
    assert.equal(kept(gil.id)?.approvalDays, 1);
    await done(mona, days, { days: 7 });
    await done(mona, days, { days: null });
    assert.equal(kept(gil.id)?.approvalDays, undefined);
    await refused(mona, days, { days: 3 }, 400, /days must be one of/);

    await done(owner(app), `users/${mona.id}/approval-days`, { days: 1 });
    await refused(mona, days, { days: 7 }, 403, more);
    await refused(mona, days, { days: null }, 403, more);
    await done(owner(app), `users/${mona.id}/approval-days`, { days: 0 });
    await done(mona, days, { days: 30 });
    await done(mona, days, { days: 0 });
    assert.equal(kept(gil.id)?.approvalDays, 0);
});

test("managing users ends when they are made a viewer or limited to one session, and does not come back", async () => {
    const mona = await manager("Mona 6");
    const max = await manager("Max 6");
    const lena = await manager("Lena 6");
    const gil = person("Gil 6", "guest");
    const vera = person("Vera 6", "viewer");

    linkAuthenticator(app, mona);
    linkAuthenticator(app, lena);

    // Made a viewer, and a user again: it is off, until the owner turns it on again.
    await done(owner(app), `users/${mona.id}`, { role: "viewer" });
    assert.equal(kept(mona.id)?.managesUsers, undefined);
    await done(owner(app), `users/${mona.id}`, { role: "guest" });
    assert.equal(kept(mona.id)?.role, "guest");
    assert.equal(kept(mona.id)?.managesUsers, undefined);
    assert.equal((await app.hello(kept(mona.id)!)).user.managesUsers, false);
    await refused(mona, `users/${gil.id}/remove`, {}, 403, /Only the owner can do that/);
    assert.equal(told(mona, vera)?.approvalDays, undefined);

    // Their authenticator removed: a viewer, so it ends too.
    await done(owner(app), `users/${lena.id}/authenticator`, undefined, "DELETE");
    assert.equal(kept(lena.id)?.role, "viewer");
    assert.equal(kept(lena.id)?.managesUsers, undefined);

    // Limited to one session.
    app.config.updateUser(max.id, { sessions: ["1"] });
    assert.equal(kept(max.id)?.managesUsers, undefined);
    app.config.updateUser(max.id, { sessions: undefined });
    assert.equal(kept(max.id)?.managesUsers, undefined);
    await refused(max, `users/${gil.id}/remove`, {}, 403, /Only the owner can do that/);

    // It is not kept for a viewer, or for someone limited.
    const sam = person("Sam 6", "guest", ["1"]);

    app.config.updateUser(vera.id, { managesUsers: true });
    assert.equal(kept(vera.id)?.managesUsers, undefined);
    app.config.updateUser(sam.id, { managesUsers: true });
    assert.equal(kept(sam.id)?.managesUsers, undefined);

    // And a file edited by hand that says so of one of them counts for nothing: the policy reads who they are now.
    for (const each of [vera, sam]) {
        Object.assign(kept(each.id)!, { managesUsers: true });
        assert.equal(kept(each.id)?.managesUsers, true, each.name);
        assert.equal(app.policy.managesPeople(each), false, each.name);
        assert.equal(app.policy.mayManagePerson(each, gil), false, each.name);
        assert.equal((await app.hello(kept(each.id)!)).user.managesUsers, false, each.name);
        assert.equal(told(each, gil)?.approvalDays, undefined, each.name);
        await refused(each, `users/${gil.id}/remove`, {}, 403, /Only the owner can do that/);
    }

    assert.notEqual(kept(gil.id), undefined);
});
