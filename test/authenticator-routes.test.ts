// Each person links their own authenticator app to their account over `/api/me/authenticator`: the secret is shown once,
// the first code links it, a code removes it, and the owner can remove anyone's (a lost phone). Nobody else can.
import { type App, cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

let app: App;
let server: Server;
let address: string;
let clock = 1_800_000_000_000;
const tokens = new Map<string, string>();
let alex: User;
let vera: User;
let sam: User;

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call<T = Record<string, unknown>>(
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

/** The code `secret` shows now; `ahead` steps later for a code not yet used. */
const codeOf = (secret: string, ahead = 0) => totp(secret, Math.floor(clock / STEP_MS) + ahead);

/** Link an authenticator for `user` over HTTP; its secret. */
async function link(user: User): Promise<string> {
    const begun = await call<{ secret: string; link: string; svg: string }>(
        user,
        "me/authenticator/begin",
        {},
    );

    assert.equal(begun.status, 200);

    const confirmed = await call(user, "me/authenticator/confirm", {
        code: codeOf(begun.body.secret),
    });

    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.body, { linked: true });

    return begun.body.secret;
}

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
    alex = person("Alex", "guest");
    vera = person("Vera", "viewer");
    sam = person("Sam", "guest", ["1"]);
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

test("a person links their own authenticator: the secret once, then the first code", async () => {
    assert.deepEqual((await call(alex, "me/authenticator")).body, { linked: false });

    const begun = await call<{ secret: string; link: string; svg: string }>(
        alex,
        "me/authenticator/begin",
        {},
    );

    assert.equal(begun.status, 200);
    assert.match(begun.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(begun.body.link, /^otpauth:\/\/totp\/Pi%20Pocket:Alex\?secret=/);
    assert.match(begun.body.svg, /^<svg/);
    // Not linked until a code confirms it, so a scan that failed links nothing.
    assert.deepEqual((await call(alex, "me/authenticator")).body, { linked: false });

    const wrong = await call<{ error: string }>(alex, "me/authenticator/confirm", {
        code: "000000",
    });

    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /wrong or used/);
    assert.equal(
        (await call(alex, "me/authenticator/confirm", { code: "12345" })).status,
        400,
        "only 6 digits",
    );

    const confirmed = await call(alex, "me/authenticator/confirm", {
        code: codeOf(begun.body.secret),
    });

    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.body, { linked: true });
    assert.equal(app.authenticators.linked(alex.id), true);
    // The secret is never sent again: not in a status, not in the account.
    assert.equal(
        JSON.stringify((await call(alex, "me/authenticator")).body).includes("secret"),
        false,
    );
    assert.equal(JSON.stringify((await call(alex, "me")).body).includes(begun.body.secret), false);
    assert.equal(
        (await call(alex, "me/authenticator/begin", {})).status,
        409,
        "a linked one is removed first, so nobody swaps in their own",
    );
});

test("viewers and people invited to one session link one too", async () => {
    for (const each of [vera, sam]) {
        await link(each);
        assert.equal(app.authenticators.linked(each.id), true);
    }
});

test("a code removes it; without one it stays", async () => {
    clock += STEP_MS;

    const secret = app.config.userById(alex.id)!.authenticator!.secret;

    assert.equal((await call(alex, "me/authenticator/remove", {})).status, 400);
    assert.equal((await call(alex, "me/authenticator/remove", { code: "000000" })).status, 400);
    assert.equal(app.authenticators.linked(alex.id), true);

    const removed = await call(alex, "me/authenticator/remove", { code: codeOf(secret) });

    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { linked: false });
    assert.equal(app.config.userById(alex.id)?.authenticator, undefined);
});

test("one not yet confirmed is dropped without a code, as when linking is cancelled", async () => {
    assert.equal((await call(alex, "me/authenticator/begin", {})).status, 200);
    assert.notEqual(app.config.userById(alex.id)?.authenticator, undefined);
    assert.equal((await call(alex, "me/authenticator/remove", {})).status, 200);
    assert.equal(app.config.userById(alex.id)?.authenticator, undefined);
});

test("too many wrong codes lock it out, and the status says until when", async () => {
    clock += STEP_MS;

    for (let i = 0; i < 5; i++) {
        await call(vera, "me/authenticator/remove", { code: "000000" });
    }

    const status = await call<{ linked: boolean; lockedUntil?: number }>(vera, "me/authenticator");

    assert.equal(status.body.linked, true);
    assert.equal(status.body.lockedUntil, clock + 10 * 60_000);

    const locked = await call<{ error: string }>(vera, "me/authenticator/remove", {
        code: "000000",
    });

    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /Try again in 10 minutes/);
});

test("removing a guest's authenticator ends their steering until the owner lets them steer again", async () => {
    const gina = person("Gina", "viewer");

    clock += STEP_MS;
    await link(gina);
    app.setAccess(owner(app), gina.id, { role: "guest" });
    assert.equal(app.config.userById(gina.id)?.role, "guest", "linked: the owner lets her steer");

    // She removes her own with a code: she is a viewer again.
    clock += STEP_MS;
    const secret = app.config.userById(gina.id)!.authenticator!.secret;

    assert.equal(
        (await call(gina, "me/authenticator/remove", { code: codeOf(secret) })).status,
        200,
    );
    assert.equal(app.config.userById(gina.id)?.role, "viewer");
    assert.throws(
        () => app.setAccess(owner(app), gina.id, { role: "guest" }),
        /must link an authenticator first/,
    );

    // Linked again and let steer; then the owner removes it for a lost phone: a viewer again.
    clock += STEP_MS;
    await link(gina);
    app.setAccess(owner(app), gina.id, { role: "guest" });
    assert.equal(
        (await call(owner(app), `users/${gina.id}/authenticator`, undefined, "DELETE")).status,
        200,
    );
    assert.equal(app.config.userById(gina.id)?.role, "viewer");
    // A viewer's own stays a viewer: nothing else changes.
    assert.equal(app.config.userById(vera.id)?.role, "viewer");
});

test("the owner sees who linked one, and removes anyone's; nobody else can", async () => {
    const listed = (await call<{ id: string; authenticator?: true }[]>(owner(app), "users")).body;

    assert.equal(listed.find((each) => each.id === vera.id)?.authenticator, true);
    assert.equal(listed.find((each) => each.id === alex.id)?.authenticator, undefined);
    // Others learn nothing of anyone's authenticator.
    assert.equal(JSON.stringify((await call(alex, "users")).body).includes("authenticator"), false);

    const refused = await call(alex, `users/${vera.id}/authenticator`, undefined, "DELETE");

    assert.equal(refused.status, 403);
    assert.equal(app.authenticators.linked(vera.id), true);

    // A locked one too: a lost phone needs no code.
    const removed = await call<{ id: string; authenticator?: true }[]>(
        owner(app),
        `users/${vera.id}/authenticator`,
        undefined,
        "DELETE",
    );

    assert.equal(removed.status, 200);
    assert.equal(removed.body.find((each) => each.id === vera.id)?.authenticator, undefined);
    assert.equal(app.authenticators.linked(vera.id), false);
    assert.equal(
        (await call(owner(app), "users/nobody/authenticator", undefined, "DELETE")).status,
        404,
    );
});

/** Open a device link as a browser does, or, with `form`, post its page. `who`: whom the answer signs in. */
async function join(
    code: string,
    form?: Record<string, string>,
): Promise<{ status: number; text: string; who: string | undefined }> {
    const response = await fetch(`${address}/join/${code}`, {
        method: form === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        ...(form === undefined
            ? {}
            : {
                  body: new URLSearchParams(form).toString(),
                  headers: {
                      "content-type": "application/x-www-form-urlencoded",
                      "sec-fetch-site": "same-origin",
                  },
              }),
    });
    const cookie = /pocket_auth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];

    return {
        status: response.status,
        text: await response.text(),
        who:
            cookie === undefined
                ? undefined
                : app.config.userByToken(decodeURIComponent(cookie))?.id,
    };
}

test("a device link for someone with an authenticator takes two codes: its own, and one from the authenticator", async () => {
    const dana = person("Dana", "viewer");
    const secret = await link(dana);
    const made = await call<{ code: string }>(dana, "me/device", {});

    assert.equal(made.status, 200);

    const page = await join(made.body.code);

    assert.equal(page.status, 200);
    assert.match(page.text, /Code from Dana's authenticator app<input name="code"/);

    // Without the second code, or with a wrong one, nobody is signed in, and the link stays for another try.
    const none = await join(made.body.code, {});

    assert.equal(none.status, 400);
    assert.equal(none.who, undefined);
    assert.match(none.text, /role="alert">Enter the code from your authenticator\./);
    assert.match(none.text, /<input name="code"/, "the page asks again");

    const wrong = await join(made.body.code, { code: "000000" });

    assert.equal(wrong.status, 400);
    assert.equal(wrong.who, undefined);
    assert.match(wrong.text, /That code is wrong or used/);
    assert.equal((await join(made.body.code)).status, 200, "the link is not spent");

    // Both codes sign the device in as them, and the link is spent.
    clock += STEP_MS;

    const right = await join(made.body.code, { code: codeOf(secret) });

    assert.equal(right.status, 303);
    assert.equal(right.who, dana.id);
    assert.equal((await join(made.body.code, { code: codeOf(secret, 1) })).status, 410);

    // A code works once here too: the one just used opens no other link.
    const second = await call<{ code: string }>(dana, "me/device", {});
    const replayed = await join(second.body.code, { code: codeOf(secret) });

    assert.equal(replayed.status, 400);
    assert.equal(replayed.who, undefined);

    // Someone without an authenticator is asked for none.
    const pat = person("Pat", "viewer");
    const theirs = await call<{ code: string }>(pat, "me/device", {});

    assert.doesNotMatch((await join(theirs.body.code)).text, /name="code"/);
    assert.equal((await join(theirs.body.code, {})).who, pat.id);
});

test("the owner makes a device link for someone else; their authenticator is still asked, and wrong codes lock it out", async () => {
    const lou = person("Lou", "viewer");
    const secret = await link(lou);

    // Only the owner makes one for someone else, and only for someone here.
    assert.equal((await call(alex, `users/${lou.id}/device`, {})).status, 403);
    assert.equal((await call(lou, `users/${owner(app).id}/device`, {})).status, 403);
    assert.equal((await call(owner(app), "users/nobody/device", {})).status, 404);

    const made = await call<{ code: string; minutes: number }>(
        owner(app),
        `users/${lou.id}/device`,
        {},
    );

    assert.equal(made.status, 200);
    assert.equal(made.body.minutes, 15);
    assert.match(
        (await join(made.body.code)).text,
        /Sign in as Lou<\/h1>.*Code from Lou's authenticator app/s,
    );

    // The link alone signs nobody in as Lou, and wrong codes count as they do anywhere else.
    for (let i = 0; i < 4; i++) {
        const wrong = await join(made.body.code, { code: "000000" });

        assert.equal(wrong.status, 400);
        assert.equal(wrong.who, undefined);
    }

    const locked = await join(made.body.code, { code: "000000" });

    assert.equal(locked.status, 429);
    assert.match(locked.text, /Too many wrong codes\. Try again in 10 minutes\./);

    // Locked out, the right code is refused too; the link stays.
    clock += STEP_MS;

    const refused = await join(made.body.code, { code: codeOf(secret) });

    assert.equal(refused.status, 429);
    assert.equal(refused.who, undefined);
    assert.equal((await join(made.body.code)).status, 200);

    // Lou lost the authenticator too: the owner removes it, and the link then signs a device in as Lou.
    assert.equal(
        (await call(owner(app), `users/${lou.id}/authenticator`, undefined, "DELETE")).status,
        200,
    );
    assert.doesNotMatch((await join(made.body.code)).text, /name="code"/);

    const signed = await join(made.body.code, {});

    assert.equal(signed.status, 303);
    assert.equal(signed.who, lou.id);
    assert.equal(app.config.users.filter((each) => each.name === "Lou").length, 1, "no one new");

    // Removing someone ends a link the owner made for them.
    const again = await call<{ code: string }>(owner(app), `users/${lou.id}/device`, {});

    assert.equal((await join(again.body.code)).status, 200);
    await app.removeUser(owner(app), lou.id);
    assert.equal((await join(again.body.code)).status, 410);
});
