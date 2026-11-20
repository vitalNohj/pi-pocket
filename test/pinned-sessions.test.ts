// Synced pinned sessions are each person's own (`pinned-sessions.ts`): read and replaced over `/api/pinned-sessions`,
// told in `hello` once there is a list, and sent only to that person's connected devices. Viewers keep one too.
import { type App, cleanUp, fakeTab, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let alex: User;
let vera: User;

function person(name: string, role: User["role"]): User {
    const { user, token } = app.config.addUser(name, role);

    tokens.set(user.id, token);

    return user;
}

async function call<T = Record<string, unknown>>(
    user: User,
    body?: unknown,
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/pinned-sessions`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as T };
}

before(async () => {
    app = await openApp(scriptedModel());
    alex = person("Alex", "guest");
    vera = person("Vera", "viewer");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

test("no list at first; a list keeps its order, drops repeats, and is in hello", async () => {
    const me = owner(app);

    assert.deepEqual((await call(me)).body, { pinned: null });
    assert.ok(!("pinnedSessions" in (await app.hello(me))), "no list: hello says nothing");

    assert.deepEqual((await call(me, { pinned: [7, 3, 7, 12, 3] })).body, { ok: true });
    assert.deepEqual((await call(me)).body, { pinned: [7, 3, 12] });
    assert.deepEqual((await app.hello(me)).pinnedSessions, [7, 3, 12]);

    // An empty list is a list: the person has synced pins, none of them pinned.
    await call(me, { pinned: [] });
    assert.deepEqual((await call(me)).body, { pinned: [] });
    assert.deepEqual((await app.hello(me)).pinnedSessions, []);
});

test("each person has their own list, and only their devices hear of it", async () => {
    const mine = fakeTab(undefined, alex);
    const myOther = fakeTab(undefined, alex);
    const theirs = fakeTab(undefined, vera);

    await app.attach(mine.client);
    await app.attach(myOther.client);
    await app.attach(theirs.client);

    try {
        assert.equal((await call(alex, { pinned: [5, 1] })).status, 200);
        await until(
            async () => JSON.stringify(myOther.last("pinned-sessions")) === "[5,1]",
            "Alex's other device hears of the list",
        );
        assert.deepEqual(mine.last("pinned-sessions"), [5, 1]);
        // Vera's devices hear only that she has none.
        assert.ok(
            theirs.events
                .filter((each) => each.event === "pinned-sessions")
                .every((each) => each.data === null),
            "no list of Alex reaches Vera",
        );
        assert.deepEqual((await call(vera)).body, { pinned: null });
        assert.ok(!("pinnedSessions" in (await app.hello(vera))));
        assert.notDeepEqual((await call(owner(app))).body, { pinned: [5, 1] });
    } finally {
        app.detach(mine.client);
        app.detach(myOther.client);
        app.detach(theirs.client);
    }
});

test("a viewer keeps synced pins too", async () => {
    assert.deepEqual((await call(vera, { pinned: [9] })).body, { ok: true });
    assert.deepEqual((await call(vera)).body, { pinned: [9] });
    assert.deepEqual((await app.hello(vera)).pinnedSessions, [9]);
});

test("a list that is not one of session ids is refused, and changes nothing", async () => {
    await call(alex, { pinned: [2] });

    for (const body of [
        {},
        { pinned: "1,2" },
        { pinned: [1, "2"] },
        { pinned: [0] },
        { pinned: [-3] },
        { pinned: [1.5] },
        { pinned: [Number.MAX_SAFE_INTEGER + 1] },
        { pinned: [null] },
        { pinned: Array.from({ length: 501 }, (_, index) => index + 1) },
        [1, 2],
    ]) {
        assert.equal((await call(alex, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }

    assert.deepEqual((await call(alex)).body, { pinned: [2] });
    // The most a list may have.
    const most = Array.from({ length: 500 }, (_, index) => index + 1);

    assert.equal((await call(alex, { pinned: most })).status, 200);
    assert.deepEqual((await call(alex)).body, { pinned: most });
});
