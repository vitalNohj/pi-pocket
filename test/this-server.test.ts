// "This server" in the Runners sheet: the server as a computer (`access.ts` `THIS_SERVER`), with the owner as its
// linker. The owner chooses its people, its rules, and its saved folders over the same routes as a runner's; it cannot be
// removed, and nobody else learns of its people or folders, also not from live updates.
import { newIdentity } from "../src/runner/secure-link.ts";
import {
    type App,
    cleanUp,
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
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import type { ServerView } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let alex: User;
let vera: User;
let sam: User;
let runnerId: string;
const project = join(root, "project");

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

before(async () => {
    app = await openApp(scriptedModel());
    alex = person("Alex", "guest");
    vera = person("Vera", "viewer");
    sam = person("Sam", "guest", ["1"]);
    runnerId = app.config.addRunner("Laptop", owner(app).id, newIdentity().publicKey).id;
    mkdirSync(project, { recursive: true });
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

test("the owner sees this server as a computer they linked, with nobody chosen and asking on", async () => {
    const shown = await call<ServerView>(owner(app), `runners/${THIS_SERVER}`);

    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body, {
        id: THIS_SERVER,
        name: "This server",
        createdBy: owner(app).id,
        users: [],
        folders: [],
        stopAsking: false,
        shareNew: false,
    });
    assert.deepEqual((await app.hello(owner(app))).thisServer, shown.body);
});

test("nobody else learns of its people or folders", async () => {
    for (const each of [alex, vera, sam]) {
        assert.equal((await call(each, `runners/${THIS_SERVER}`)).status, 403);
        assert.equal("thisServer" in (await app.hello(each)), false);
    }
});

test("it cannot be removed", async () => {
    const refused = await call<{ error: string }>(
        owner(app),
        `runners/${THIS_SERVER}`,
        undefined,
        "DELETE",
    );

    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /cannot be removed/);
});

test("the owner chooses its people: a chosen guest may start here, a viewer may only see", async () => {
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), false, "not chosen yet");

    const chosen = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/users`, {
        users: [alex.id, vera.id, sam.id, owner(app).id, "nobody"],
    });

    assert.equal(chosen.status, 200);
    // Never the owner, someone removed, or a person invited to one session.
    assert.deepEqual(chosen.body.users, [
        { id: alex.id, name: "Alex", role: "guest" },
        { id: vera.id, name: "Vera", role: "viewer" },
    ]);
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), true);
    assert.equal(app.policy.mayUse(vera, THIS_SERVER), true);
    assert.equal(app.policy.mayStart(vera, THIS_SERVER), false);
    assert.equal(app.policy.mayUse(sam, THIS_SERVER), false);
});

test("a chosen guest cannot choose people or change its rules", async () => {
    assert.equal(
        (await call(alex, `runners/${THIS_SERVER}/users`, { users: [alex.id] })).status,
        403,
    );
    assert.equal(
        (await call(alex, `runners/${THIS_SERVER}/settings`, { stopAsking: true })).status,
        403,
    );
    assert.equal(
        (
            await call(
                alex,
                `runners/${THIS_SERVER}/folders?folder=${encodeURIComponent(project)}`,
                undefined,
                "DELETE",
            )
        ).status,
        403,
    );
});

test("the owner turns its rules on and off: Stop asking and default sharing", async () => {
    const on = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/settings`, {
        stopAsking: true,
        shareNew: true,
    });

    assert.equal(on.status, 200);
    assert.equal(on.body.stopAsking, true);
    assert.equal(on.body.shareNew, true);
    assert.deepEqual(app.policy.initialShares(THIS_SERVER, owner(app).id), [alex.id, vera.id]);

    const off = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/settings`, {
        shareNew: false,
    });

    assert.equal(off.body.stopAsking, true, "a rule left out stays");
    assert.equal(off.body.shareNew, false);
    assert.deepEqual(app.policy.initialShares(THIS_SERVER, owner(app).id), []);
    assert.equal(
        (await call(owner(app), `runners/${THIS_SERVER}/settings`, { stopAsking: "yes" })).status,
        400,
    );
});

test("a runner's default sharing is set here too, but its Stop asking stays on that computer", async () => {
    const on = await call<{ shareNew?: true }>(owner(app), `runners/${runnerId}/settings`, {
        shareNew: true,
    });

    assert.equal(on.status, 200);
    assert.equal(on.body.shareNew, true);
    assert.equal(app.config.runnerById(runnerId)?.shareNew, true);

    const refused = await call<{ error: string }>(owner(app), `runners/${runnerId}/settings`, {
        stopAsking: true,
    });

    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /keeps Stop asking on its computer/);
    assert.equal(
        (await call(owner(app), "runners/nobody/settings", { shareNew: true })).status,
        404,
    );
});

test("a saved folder needs no approval while Stop asking is on; removing it asks again", async () => {
    const real = realpathSync(project);

    assert.deepEqual(await app.policy.folder(alex, THIS_SERVER, real), {
        kind: "ask",
        saved: false,
    });
    app.config.saveServerFolder(real);
    assert.deepEqual((await call<ServerView>(owner(app), `runners/${THIS_SERVER}`)).body.folders, [
        real,
    ]);
    assert.deepEqual(await app.policy.folder(alex, THIS_SERVER, join(real, "inner")), {
        kind: "allow",
    });

    const removed = await call<ServerView>(
        owner(app),
        `runners/${THIS_SERVER}/folders?folder=${encodeURIComponent(real)}`,
        undefined,
        "DELETE",
    );

    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.folders, []);
    assert.deepEqual(await app.policy.folder(alex, THIS_SERVER, real), {
        kind: "ask",
        saved: false,
    });
    assert.equal(
        (
            await call(
                owner(app),
                `runners/${THIS_SERVER}/folders?folder=${encodeURIComponent(real)}`,
                undefined,
                "DELETE",
            )
        ).status,
        404,
    );
});

test("a change reaches the owner's tabs live, and never anyone else's", async () => {
    const ownerTab = fakeTab(undefined, owner(app));
    const alexTab = fakeTab(undefined, alex);

    await app.attach(ownerTab.client);
    await app.attach(alexTab.client);

    try {
        await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [alex.id] });
        await until(
            () => (ownerTab.last("this-server") as ServerView | undefined)?.users.length === 1,
            "the owner's tab hears of the change",
        );
        assert.deepEqual((ownerTab.last("this-server") as ServerView).users, [
            { id: alex.id, name: "Alex", role: "guest" },
        ]);
        assert.equal(
            alexTab.events.some((each) => each.event === "this-server"),
            false,
        );
    } finally {
        app.detach(ownerTab.client);
        app.detach(alexTab.client);
    }
});

test("someone no longer chosen leaves at once", async () => {
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), true);
    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [] });
    assert.equal(app.policy.mayUse(alex, THIS_SERVER), false);
    assert.equal(app.policy.mayUse(vera, THIS_SERVER), false);
});
