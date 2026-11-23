// Manage users: the owner lets a user manage people (`access.ts` `managesPeople`). Such a user reads of a person what the
// owner reads, and changes what that person may do, but never themselves, the owner, or another who manages users, and
// gives no more than they have themselves. Only the owner sets it, and it ends when they are no longer a full user.
import { type App, cleanUp, linkAuthenticator, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
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
        (Record<string, unknown> & { rights?: string[] }) | undefined;

/** A user who manages users, made so by the owner. */
async function manager(name: string): Promise<User> {
    const user = person(name, "guest");

    await done(owner(app), `users/${user.id}/rights`, { right: "managesUsers", on: true });

    return user;
}

/** Post the page of a link or an invite as a browser does. `who`: whom the answer signs in, if anyone. */
async function join(
    code: string,
    form: Record<string, string> = {},
): Promise<{ status: number; who: string | undefined }> {
    const response = await fetch(`${address}/join/${code}`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        body: new URLSearchParams(form).toString(),
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
        },
    });
    const cookie = /pocket_auth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];

    await response.text();

    return {
        status: response.status,
        who:
            cookie === undefined
                ? undefined
                : app.config.userByToken(decodeURIComponent(cookie))?.id,
    };
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
    const path = (user: User) => `users/${user.id}/rights`;

    // Off for everyone but the owner.
    assert.equal((await app.hello(owner(app))).user.rights.managesUsers, true);
    assert.equal((await app.hello(mona)).user.rights.managesUsers, false);

    await refused(
        mona,
        path(gil),
        { right: "managesUsers", on: true },
        403,
        /Only the owner gives that permission/,
    );
    await refused(
        mona,
        path(mona),
        { right: "managesUsers", on: true },
        403,
        /Only the owner gives that permission/,
    );
    await refused(
        owner(app),
        path(vera),
        { right: "managesUsers", on: true },
        400,
        /must be a user who is not limited/,
    );
    await refused(
        owner(app),
        path(sam),
        { right: "managesUsers", on: true },
        400,
        /must be a user who is not limited/,
    );
    await refused(
        owner(app),
        path(owner(app)),
        { right: "managesUsers", on: true },
        404,
        /No such person/,
    );
    await refused(
        owner(app),
        "users/nobody/rights",
        { right: "managesUsers", on: true },
        404,
        /No such person/,
    );
    await refused(
        owner(app),
        path(mona),
        { right: "managesUsers", on: "yes" },
        400,
        /on must be true or false/,
    );
    assert.notEqual(kept(mona.id)?.rights?.includes("managesUsers"), true);

    await done(owner(app), path(mona), { right: "managesUsers", on: true });
    assert.equal(kept(mona.id)?.rights?.includes("managesUsers"), true);
    assert.equal((await app.hello(kept(mona.id)!)).user.rights.managesUsers, true);
    assert.equal((await app.hello(gil)).user.rights.managesUsers, false);

    // The owner and they themselves read it, and so does who manages users. Nobody else.
    assert.equal(told(owner(app), mona)?.rights?.includes("managesUsers"), true);
    assert.equal(told(mona, mona)?.rights?.includes("managesUsers"), true);
    assert.notEqual(told(gil, mona)?.rights?.includes("managesUsers"), true);

    // Even with it, they do not give it to anyone, and do not take it from themselves.
    await refused(
        mona,
        path(gil),
        { right: "managesUsers", on: true },
        403,
        /Only the owner gives that permission/,
    );
    await refused(
        mona,
        path(mona),
        { right: "managesUsers", on: false },
        403,
        /Only the owner gives that permission/,
    );

    await done(owner(app), path(mona), { right: "managesUsers", on: false });
    assert.notEqual(kept(mona.id)?.rights?.includes("managesUsers"), true);
    assert.equal((await app.hello(kept(mona.id)!)).user.rights.managesUsers, false);
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
    await refused(
        gil,
        `users/${vera.id}`,
        { role: "guest" },
        403,
        /Only someone who manages users can do that/,
    );
    await refused(
        gil,
        `users/${vera.id}/remove`,
        {},
        403,
        /Only someone who manages users can do that/,
    );
    await refused(
        gil,
        `users/${vera.id}/authenticator`,
        undefined,
        403,
        /Only someone who manages users can do that/,
        "DELETE",
    );
    await refused(
        gil,
        `users/${vera.id}/approval-days`,
        { days: 1 },
        403,
        /Only someone who manages users can do that/,
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

    // A sign-in link for a user signs a device in as them, with all they have: the owner's alone.
    await refused(mona, `users/${gil.id}/device`, {}, 403, /only for a viewer/);
});

test("who manages users invites people, and signs a device in as a viewer and as nobody else", async () => {
    const mona = await manager("Mona 7");
    const max = await manager("Max 7");
    const ivy = person("Ivy 7", "guest");
    const gil = person("Gil 7", "guest");
    const pia = person("Pia 7", "guest");
    const vera = person("Vera 7", "viewer");
    const only = /Who manages users makes a sign-in link only for a viewer/;
    const link = (by: User, target: string) =>
        call<{ code: string }>(by, `users/${target}/device`, {});

    // Invite people comes with managing users: it has no switch of its own to turn on.
    assert.notEqual(kept(mona.id)?.rights?.includes("invites"), true);
    assert.equal((await app.hello(kept(mona.id)!)).user.rights.invites, true);
    assert.equal(told(owner(app), mona)?.rights?.includes("invites"), true);
    assert.equal(told(mona, mona)?.rights?.includes("invites"), true);
    assert.equal((await app.hello(gil)).user.rights.invites, false);
    assert.notEqual(told(owner(app), gil)?.rights?.includes("invites"), true);

    // As for anyone who invites: to their own sessions, only where they start sessions.
    await refused(mona, "invite", { minutes: 15 }, 403, /Only people who may start sessions here/);
    app.config.setUsers(THIS_SERVER, [...(app.config.server.users ?? []), mona.id]);

    const invite = await call<{ code: string }>(mona, "invite", { minutes: 15 });

    assert.equal(invite.status, 200);

    // Someone who only invites makes a sign-in link for nobody.
    await done(owner(app), `users/${ivy.id}/rights`, { right: "invites", on: true });
    await refused(
        ivy,
        `users/${vera.id}/device`,
        {},
        403,
        /Only someone who manages users can do that/,
    );

    // For a viewer, who makes none themselves: it signs a device in as them.
    const made = await link(mona, vera.id);

    assert.equal(made.status, 200);
    assert.equal((await join(made.body.code)).who, vera.id);

    // Never for a user, another who manages users, the owner, or themselves.
    for (const each of [gil, max, owner(app), mona]) {
        await refused(mona, `users/${each.id}/device`, {}, 403, only);
    }

    await refused(mona, "users/nobody/device", {}, 404, /No such person/);

    // Nor for a paused user, who is a user again once they link an authenticator. Kept as a viewer, they are one.
    linkAuthenticator(app, pia);
    await done(owner(app), `users/${pia.id}/authenticator`, undefined, "DELETE");
    assert.equal(kept(pia.id)?.role, "viewer");
    assert.ok(kept(pia.id)?.paused !== undefined);
    await refused(mona, `users/${pia.id}/device`, {}, 403, only);
    assert.equal((await link(owner(app), pia.id)).status, 200);
    await done(mona, `users/${pia.id}`, { role: "viewer" });
    assert.equal(kept(pia.id)?.paused, undefined);
    assert.equal((await link(mona, pia.id)).status, 200);

    // A link made for a viewer signs nobody in once they are a user.
    const early = await link(mona, vera.id);

    app.config.updateUser(vera.id, { role: "guest" });
    assert.equal((await join(early.body.code)).who, undefined);
    app.config.updateUser(vera.id, { role: "viewer" });

    // Nor once its maker no longer manages users; the invite they made ends with it too.
    const late = await link(mona, vera.id);

    assert.equal(late.status, 200);
    await done(owner(app), `users/${mona.id}/rights`, { right: "managesUsers", on: false });
    assert.equal((await join(late.body.code)).who, undefined);
    assert.equal((await app.hello(kept(mona.id)!)).user.rights.invites, false);
    assert.notEqual(told(owner(app), mona)?.rights?.includes("invites"), true);
    assert.equal((await join(invite.body.code, { name: "Nia 7" })).who, undefined);
    await refused(
        mona,
        `users/${vera.id}/device`,
        {},
        403,
        /Only someone who manages users can do that/,
    );
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
        await refused(
            mona,
            `users/${target.id}/rights`,
            { right: "linksRunners", on: false },
            403,
            said,
        );
        await refused(
            mona,
            `users/${target.id}/rights`,
            { right: "invites", on: false },
            403,
            said,
        );
        await refused(
            mona,
            `users/${target.id}/rights`,
            { right: "keepsWarm", on: false },
            403,
            said,
        );
        await refused(mona, `users/${target.id}/approval-days`, { days: 1 }, 403, said);
        await refused(mona, `users/${target.id}/authenticator`, undefined, 403, said, "DELETE");
    }

    assert.equal(kept(mona.id)?.role, "guest");
    assert.equal(kept(max.id)?.role, "guest");
    assert.equal(kept(max.id)?.rights?.includes("managesUsers"), true);
    assert.equal(app.authenticators.linked(max.id), true);
    assert.equal(app.authenticators.linked(mona.id), true, "their own takes their own code");
    assert.notEqual(kept(owner(app).id), undefined);

    // The owner changes them as anyone else.
    await done(owner(app), `users/${max.id}/rights`, { right: "invites", on: true });
    assert.equal(kept(max.id)?.rights?.includes("invites"), true);
    await done(owner(app), `users/${max.id}/approval-days`, { days: 1 });
    assert.equal(kept(max.id)?.approvalDays, 1);
    await done(owner(app), `users/${max.id}/remove`, {});
    assert.equal(kept(max.id), undefined);
});

test("who manages users gives only what they have themselves, and takes back anything", async () => {
    const mona = await manager("Mona 5");
    const gil = person("Gil 5", "guest");
    const more = /You can only give what you have yourself/;

    // Invite people they have with managing users (`access.ts` `invites`): they give it, and take it back.
    await done(mona, `users/${gil.id}/rights`, { right: "invites", on: true });
    assert.equal(kept(gil.id)?.rights?.includes("invites"), true);
    await done(mona, `users/${gil.id}/rights`, { right: "invites", on: false });
    assert.notEqual(kept(gil.id)?.rights?.includes("invites"), true);

    for (const right of ["linksRunners", "keepsWarm"] as const) {
        const path = `users/${gil.id}/rights`;

        await refused(mona, path, { right, on: true }, 403, more);
        assert.notEqual(kept(gil.id)?.rights?.includes(right), true, right);

        // What the owner gave someone, they take back without having it.
        await done(owner(app), path, { right, on: true });
        await done(mona, path, { right, on: false });
        assert.notEqual(kept(gil.id)?.rights?.includes(right), true, right);

        // With it themselves, they give it.
        await done(owner(app), `users/${mona.id}/rights`, { right, on: true });
        await done(mona, path, { right, on: true });
        assert.equal(kept(gil.id)?.rights?.includes(right), true, right);
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
    assert.notEqual(kept(mona.id)?.rights?.includes("managesUsers"), true);
    await done(owner(app), `users/${mona.id}`, { role: "guest" });
    assert.equal(kept(mona.id)?.role, "guest");
    assert.notEqual(kept(mona.id)?.rights?.includes("managesUsers"), true);
    assert.equal((await app.hello(kept(mona.id)!)).user.rights.managesUsers, false);
    await refused(
        mona,
        `users/${gil.id}/remove`,
        {},
        403,
        /Only someone who manages users can do that/,
    );
    assert.equal(told(mona, vera)?.approvalDays, undefined);

    // Their authenticator removed: a viewer, so it ends too.
    await done(owner(app), `users/${lena.id}/authenticator`, undefined, "DELETE");
    assert.equal(kept(lena.id)?.role, "viewer");
    assert.notEqual(kept(lena.id)?.rights?.includes("managesUsers"), true);

    // Limited to one session.
    app.config.updateUser(max.id, { sessions: ["1"] });
    assert.notEqual(kept(max.id)?.rights?.includes("managesUsers"), true);
    app.config.updateUser(max.id, { sessions: undefined });
    assert.notEqual(kept(max.id)?.rights?.includes("managesUsers"), true);
    await refused(
        max,
        `users/${gil.id}/remove`,
        {},
        403,
        /Only someone who manages users can do that/,
    );

    // It is not kept for a viewer, or for someone limited.
    const sam = person("Sam 6", "guest", ["1"]);

    app.config.updateUser(vera.id, { rights: ["managesUsers"] });
    assert.notEqual(kept(vera.id)?.rights?.includes("managesUsers"), true);
    app.config.updateUser(sam.id, { rights: ["managesUsers"] });
    assert.notEqual(kept(sam.id)?.rights?.includes("managesUsers"), true);

    // And a file edited by hand that says so of one of them counts for nothing: the policy reads who they are now.
    for (const each of [vera, sam]) {
        Object.assign(kept(each.id)!, { rights: ["managesUsers"] });
        assert.equal(kept(each.id)?.rights?.includes("managesUsers"), true, each.name);
        assert.equal(app.policy.managesPeople(each), false, each.name);
        assert.equal(app.policy.mayManagePerson(each, gil), false, each.name);
        assert.equal((await app.hello(kept(each.id)!)).user.rights.managesUsers, false, each.name);
        assert.equal(told(each, gil)?.approvalDays, undefined, each.name);
        await refused(
            each,
            `users/${gil.id}/remove`,
            {},
            403,
            /Only someone who manages users can do that/,
        );
    }

    assert.notEqual(kept(gil.id), undefined);
});
