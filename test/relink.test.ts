// Removing an authenticator pauses a user, without giving up their role or ending their scheduled work.
import {
    type App,
    addPerson,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
} from "./helpers.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import type { RunningBoard } from "../src/server/running.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

let app: App;
let server: Server;
let base: string;
let ahead = 0;

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => Date.now() + ahead);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    if (server !== undefined) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

async function call<T>(
    token: string,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
): Promise<T> {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${token}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as T;

    assert.equal(response.status, 200, `${method} ${path}`);

    return result;
}

const current = (user: User) => app.config.userById(user.id)!;
const codeOf = (secret: string) => totp(secret, Math.floor(app.now() / STEP_MS));

async function link(token: string): Promise<string> {
    const { secret } = await call<{ secret: string }>(token, "me/authenticator/begin", {});

    assert.deepEqual(await call(token, "me/authenticator/confirm", { code: codeOf(secret) }), {
        linked: true,
    });

    return secret;
}

const removeByOwner = (user: User) =>
    call(app.config.ownerToken, `users/${user.id}/authenticator`, undefined, "DELETE");

const submit = (id: ConversationId, user: User) =>
    app.commands.submit(id, current(user), {
        text: "Hello again",
        requestId: crypto.randomUUID(),
    });

async function messages(id: ConversationId): Promise<string[]> {
    return (await app.transcripts.allEntries(id, true)).flatMap((entry) =>
        entry.kind === "user" ? [entry.text] : [],
    );
}

test("owner removal pauses prompting and relinking restores Manage users", async () => {
    const id = await newSession(app);
    const { user, token } = await addPerson(app, "Morgan", "guest");

    await link(token);
    app.setManagesUsers(owner(app), user.id, true);
    await removeByOwner(user);

    assert.equal(current(user).role, "viewer");
    assert.equal(current(user).managesUsers, undefined);
    const saved = JSON.parse(readFileSync(app.config.file, "utf8")) as { users: User[] };

    assert.deepEqual(saved.users.find((each) => each.id === user.id)?.paused, {
        managesUsers: true,
    });
    await assert.rejects(submit(id, user), { status: 403, message: /Viewers cannot prompt/ });

    await link(token);
    assert.equal(current(user).role, "guest");
    assert.equal(current(user).managesUsers, true);
    assert.equal(Object.hasOwn(current(user), "paused"), false);
    const { submissionId } = await submit(id, user);

    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.match((await messages(id))[0]!, /Hello again/);
});

test("self-removal with a code pauses a user until they relink", async () => {
    const { user, token } = app.config.addUser("Jordan", "guest");
    const secret = await link(token);

    app.setManagesUsers(owner(app), user.id, true);
    ahead += STEP_MS; // A code is used once; the next one can remove the authenticator.
    assert.deepEqual(await call(token, "me/authenticator/remove", { code: codeOf(secret) }), {
        linked: false,
    });
    assert.equal(current(user).role, "viewer");
    assert.equal(current(user).managesUsers, undefined);
    assert.deepEqual(current(user).paused, { managesUsers: true });

    await link(token);
    assert.equal(current(user).role, "guest");
    assert.equal(current(user).managesUsers, true);
    assert.equal(Object.hasOwn(current(user), "paused"), false);
});

test("a real demotion survives removing and relinking an authenticator", async () => {
    const { user, token } = app.config.addUser("Robin", "guest");

    await link(token);
    app.setManagesUsers(owner(app), user.id, true);
    app.setAccess(owner(app), user.id, { role: "viewer" });
    await removeByOwner(user);
    await link(token);

    assert.equal(current(user).role, "viewer");
    assert.equal(current(user).managesUsers, undefined);
    assert.equal(Object.hasOwn(current(user), "paused"), false);
});

test("Keep as viewer cancels the pause and prevents restoration", async () => {
    const { user, token } = app.config.addUser("Sasha", "guest");

    await link(token);
    await removeByOwner(user);
    assert.deepEqual(current(user).paused, {});

    app.setAccess(owner(app), user.id, { role: "viewer" });
    assert.equal(Object.hasOwn(current(user), "paused"), false);
    await link(token);
    assert.equal(current(user).role, "viewer");
});

test("linking an authenticator does not promote a viewer who was never paused", async () => {
    const { user, token } = app.config.addUser("Pat", "viewer");

    await link(token);
    assert.equal(current(user).role, "viewer");
    assert.equal(Object.hasOwn(current(user), "paused"), false);
});

test("a due schedule waits for its paused person and sends after relinking", async () => {
    const id = await newSession(app);
    const { user, token } = await addPerson(app, "Sam", "guest");

    await link(token);
    app.schedules.holdMs = 1_500;
    const schedule = await app.commands.schedule(id, user, {
        next: app.now() + 1_000,
        text: "check the calendar",
    });

    app.removeAuthenticator(user.id, owner(app));
    ahead += 1_000;
    await until(async () => {
        const [item] = await app.schedules.list(id);

        return item === undefined || item.next > schedule.next;
    }, "the due schedule to be checked");

    const board = await call<RunningBoard>(app.config.ownerToken, "running/board");

    assert.equal(
        board.schedules.find((item) => item.id === schedule.id)?.held,
        "they link an authenticator first",
    );
    assert.deepEqual(await messages(id), []);

    await link(token);
    await until(async () => (await messages(id)).length === 1, "the held message to go out");
    assert.match((await messages(id))[0]!, /\[scheduled\] check the calendar/);
    assert.deepEqual(await app.schedules.list(id), []);
});

test("a pull request watch waits instead of failing while its person is paused", async () => {
    const id = await newSession(app);
    const { user, token } = await addPerson(app, "Charlie", "guest");
    let conflicts = false;

    // Like triggers.test.ts, put a fake on the watch's gh seam and let the durable task look.
    app.watches.gh = async ([command, arg]) => {
        if (command === "pr" && arg === "view") {
            return JSON.stringify({
                number: 7,
                url: "https://github.com/acme/app/pull/7",
                title: "A change",
                state: "OPEN",
                headRefOid: "abcdef123456",
                baseRefName: "main",
                mergeable: conflicts ? "CONFLICTING" : "MERGEABLE",
            });
        }

        if (command === "api" && arg === "user") {
            return "me\n";
        }

        if (command === "api" && arg === "repos/acme/app") {
            return JSON.stringify({ permissions: { push: true } });
        }

        if (command === "api" && arg?.startsWith("repos/acme/app/pulls/7/comments?")) {
            return "[]";
        }

        throw new Error(`Unexpected gh call: ${command} ${arg}`);
    };

    app.watches.timing = { soon: 40, quiet: 40, retry: 40 };
    await link(token);
    await app.commands.watchPr(id, user, undefined);

    try {
        await removeByOwner(user);
        conflicts = true;
        await until(async () => {
            const watch = await app.watches.get(id);

            return watch?.note !== undefined || watch?.status === "failed";
        }, "the watch to try to report the conflict");

        const waiting = await app.watches.get(id);

        assert.equal(waiting?.status, "watching");
        assert.equal(waiting?.note, "Waits until its person links an authenticator.");
        assert.equal(waiting?.errors, 0);
        assert.equal(waiting?.sent, 0);

        await link(token);
        await until(async () => (await app.watches.get(id))?.sent === 1, "the conflict report");
        await until(async () => (await messages(id)).length === 1, "the report to reach Pi");
        assert.match((await messages(id))[0]!, /It has conflicts/);
    } finally {
        await app.watches.stop(id);
    }
});

test("a paused person's pull request watch does not wait for ever: it expires after two weeks with nothing told", async () => {
    const id = await newSession(app);
    const { user, token } = await addPerson(app, "Dana", "guest");
    let conflicts = false;

    app.watches.gh = async ([command, arg]) => {
        if (command === "pr" && arg === "view") {
            return JSON.stringify({
                number: 8,
                url: "https://github.com/acme/app/pull/8",
                title: "Another change",
                state: "OPEN",
                headRefOid: "123456abcdef",
                baseRefName: "main",
                mergeable: conflicts ? "CONFLICTING" : "MERGEABLE",
            });
        }

        if (command === "api" && arg === "user") {
            return "me\n";
        }

        if (command === "api" && arg === "repos/acme/app") {
            return JSON.stringify({ permissions: { push: true } });
        }

        if (command === "api" && arg?.startsWith("repos/acme/app/pulls/8/comments?")) {
            return "[]";
        }

        throw new Error(`Unexpected gh call: ${command} ${arg}`);
    };

    app.watches.timing = { soon: 40, quiet: 40, retry: 40 };
    await link(token);
    await app.commands.watchPr(id, user, undefined);

    const before = ahead;

    try {
        await removeByOwner(user);
        conflicts = true;
        await until(
            async () =>
                (await app.watches.get(id))?.note ===
                "Waits until its person links an authenticator.",
            "the watch to wait for its person",
        );
        assert.equal((await app.watches.get(id))?.status, "watching");

        // Two weeks and a day later, with nothing told since: it ends as any quiet watch does, and is no failure.
        ahead += 15 * 24 * 3_600_000;
        await until(
            async () => (await app.watches.get(id))?.status !== "watching",
            "the watch to end",
        );
        assert.equal((await app.watches.get(id))?.status, "expired");
        assert.equal((await app.watches.get(id))?.sent, 0);
        assert.deepEqual(await messages(id), []);
    } finally {
        ahead = before;
        await app.watches.stop(id);
    }
});

test("the people view shows only a pause flag, to the owner and the paused person", async () => {
    const { user, token } = app.config.addUser("Avery", "guest");
    const other = app.config.addUser("Jean", "guest");

    await link(token);
    app.setManagesUsers(owner(app), user.id, true);
    await removeByOwner(user);

    const person = async (token: string) => {
        const people = await call<{ id: string; paused?: true }[]>(token, "users");
        const listed = people.find((each) => each.id === user.id);

        assert.ok(listed, "the person is in the people view");

        return listed;
    };

    assert.equal((await person(app.config.ownerToken)).paused, true);
    assert.equal((await person(token)).paused, true);
    assert.equal(Object.hasOwn(await person(other.token), "paused"), false);
});
