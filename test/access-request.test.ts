// What a viewer is told of the people here, and how they ask for access. A viewer has no list of people: they get
// themselves, and of the people in the sessions shown to them the name and the picture alone (`app.ts` `people`,
// `#metBy`). They ask for access with a few words; who manages people reads that on their row and clears it
// (`requestAccess`, `clearAccessRequest`).
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
} from "./helpers.ts";
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

// A 1x1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

const headers = (user: User) => ({
    authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
    "X-Pocket": "1",
});

async function call<T = { error?: string }>(
    user: User,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: { ...headers(user), "content-type": "application/json" },
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
): Promise<void> {
    const answer = await call(user, path, body);

    assert.equal(answer.status, status, `${user.name} ${path}`);
    assert.match(String(answer.body.error), said, `${user.name} ${path}`);
}

/** A request that must work. */
async function done(user: User, path: string, body?: unknown): Promise<void> {
    const answer = await call(user, path, body);

    assert.equal(answer.status, 200, `${user.name} ${path}: ${JSON.stringify(answer.body)}`);
}

/** The status of a request for `target`'s picture by `user`. */
const picture = async (user: User, target: User) =>
    (
        await fetch(`${address}/api/avatar/${target.id}`, {
            headers: headers(user),
            signal: AbortSignal.timeout(20_000),
        })
    ).status;

type Row = Record<string, unknown> & { id: string };

/** The record of `id` as it is kept now. */
const kept = (id: string) => app.config.userById(id);
/** The people list as `viewer` is told it now. */
const list = (viewer: User) => app.people(kept(viewer.id) ?? viewer) as Row[];
/** What `viewer` is told of `target` in the people list. */
const told = (viewer: User, target: User) => list(viewer).find((each) => each.id === target.id);
/** Whom `rows` name, in order of name. */
const names = (rows: readonly Row[]) => rows.map((each) => String(each.name)).sort();

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

test("a viewer is told of themselves, and of the people in the sessions shown to them by name and picture alone", async () => {
    const boss = owner(app);
    const vera = person("Vera", "viewer");
    const gil = person("Gil", "guest");
    const ann = person("Ann", "guest");
    const session = await newSession(app);
    const sam = person("Sam", "viewer", [String(session)]);

    assert.equal(
        (
            await fetch(`${address}/api/me/avatar`, {
                method: "POST",
                body: new Uint8Array(PNG),
                headers: headers(gil),
            })
        ).status,
        200,
    );
    app.config.setUsers(THIS_SERVER, [gil.id, vera.id, ann.id]);

    const gils = fakeTab(undefined, gil);
    const veras = fakeTab(undefined, vera);
    const sent = () => names((veras.last("users") ?? []) as unknown as Row[]);

    await app.attach(gils.client);
    await app.attach(veras.client);

    try {
        // Shown nothing, she meets nobody: the list, the route, the first message to her tab, and a picture all say so.
        assert.deepEqual(names(list(vera)), ["Vera"]);
        assert.deepEqual(names((await call<Row[]>(vera, "users")).body), ["Vera"]);
        assert.deepEqual(names((await app.hello(vera)).users as Row[]), ["Vera"]);
        assert.deepEqual(sent(), ["Vera"]);
        assert.equal(await picture(vera, gil), 404);
        // A user still reads of everyone here, as does the owner.
        assert.deepEqual(names(list(gil)), [boss.name, "Ann", "Gil", "Sam", "Vera"].sort());
        assert.equal(told(boss, gil)?.online, true);
        assert.equal(typeof told(boss, gil)?.lastSeen, "number");

        // Shown a session, she meets who started it and who else sees it, and her tab is told with the list.
        await app.commands.shareSession(session, boss, [gil.id, vera.id]);
        await until(() => sent().includes("Gil"), "the names of the people in the shared session");
        assert.deepEqual(sent(), [boss.name, "Gil", "Sam", "Vera"].sort());
        assert.deepEqual(names(list(vera)), [boss.name, "Gil", "Sam", "Vera"].sort());
        assert.deepEqual(
            names((await call<Row[]>(vera, "users")).body),
            [boss.name, "Gil", "Sam", "Vera"].sort(),
        );
        assert.equal(await picture(vera, gil), 200);
        assert.equal(await picture(vera, ann), 404);

        // Of them, the name and the picture alone: not that Gil is here now, when he last was, or what he may do.
        // Whether he is here is left out, not said as false, which the app would show as away.
        assert.deepEqual(Object.keys(told(vera, gil) ?? {}).sort(), [
            "avatar",
            "id",
            "name",
            "role",
        ]);
        assert.deepEqual(Object.keys(told(vera, boss) ?? {}).sort(), ["id", "name", "role"]);
        // Not which session Sam is limited to, either.
        assert.deepEqual(Object.keys(told(vera, sam) ?? {}).sort(), ["id", "name", "role"]);
        // Of herself she reads what anyone reads of themselves.
        assert.equal(told(vera, vera)?.online, true);
        assert.equal(typeof told(vera, vera)?.lastSeen, "number");
        assert.equal(typeof told(vera, vera)?.approvalDays, "number");

        // A viewer invited to one session meets the people of that session, and nobody else.
        assert.deepEqual(names(list(sam)), [boss.name, "Gil", "Sam", "Vera"].sort());
        assert.equal(told(sam, gil)?.online, undefined);
        assert.equal(told(sam, gil)?.lastSeen, undefined);

        // No longer shown it, she meets nobody again, and her tab is told.
        await app.commands.shareSession(session, boss, [gil.id]);
        await until(() => sent().length === 1, "the names leaving with the session");
        assert.deepEqual(sent(), ["Vera"]);
        assert.equal(await picture(vera, gil), 404);
    } finally {
        app.detach(gils.client);
        app.detach(veras.client);
    }
});

test("a viewer asks for access with a few words; who manages people reads it on their row and clears it", async () => {
    const boss = owner(app);
    const vic = person("Vic", "viewer");
    const val = person("Val", "viewer");
    const guy = person("Guy", "guest");
    const mona = person("Mona", "guest");
    const path = (user: User) => `users/${user.id}/access-request`;

    await done(boss, `users/${mona.id}/rights`, { right: "managesUsers", on: true });

    // Only a viewer asks, with nothing or a short text.
    await refused(guy, "me/access-request", {}, 403, /Only a viewer asks for access/);
    await refused(boss, "me/access-request", {}, 403, /Only a viewer asks for access/);
    await refused(vic, "me/access-request", { note: 5 }, 400, /note must be text/);
    await refused(
        vic,
        "me/access-request",
        { note: "x".repeat(201) },
        400,
        /200 characters or fewer/,
    );
    assert.equal(kept(vic.id)?.accessRequest, undefined);

    const watching = fakeTab(undefined, boss);

    await app.attach(watching.client);

    try {
        await done(vic, "me/access-request", { note: "  The docs folder, please  " });

        const asked = { at: clock, note: "The docs folder, please" };

        assert.deepEqual(kept(vic.id)?.accessRequest, asked);
        // The owner's open tab has it at once.
        assert.deepEqual(
            ((watching.last("users") ?? []) as unknown as Row[]).find((each) => each.id === vic.id)
                ?.request,
            asked,
        );
    } finally {
        app.detach(watching.client);
    }

    // Who manages people reads it, and they themselves; nobody else.
    for (const reader of [boss, mona, vic]) {
        assert.deepEqual(told(reader, vic)?.request, {
            at: clock,
            note: "The docs folder, please",
        });
    }

    assert.equal(told(guy, vic)?.request, undefined);
    assert.equal(told(val, vic), undefined);

    // One at a time: asking again replaces it, and a note of spaces is no note.
    await done(vic, "me/access-request", { note: "   " });
    assert.deepEqual(kept(vic.id)?.accessRequest, { at: clock });
    await done(vic, "me/access-request", { note: "Still waiting" });
    assert.deepEqual(kept(vic.id)?.accessRequest, { at: clock, note: "Still waiting" });

    // Only who manages them clears it.
    await refused(
        guy,
        path(vic),
        { clear: true },
        403,
        /Only someone who manages users can do that/,
    );
    await refused(
        val,
        path(vic),
        { clear: true },
        403,
        /Only someone who manages users can do that/,
    );
    await refused(boss, path(vic), { clear: "yes" }, 400, /clear must be true/);
    await refused(boss, "users/nobody/access-request", { clear: true }, 404, /No such person/);
    assert.deepEqual(kept(vic.id)?.accessRequest, { at: clock, note: "Still waiting" });
    // The answer is the people as they are now, for who cleared it: their page needs no second request.
    const cleared = await call<Row[]>(mona, path(vic), { clear: true });

    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body, JSON.parse(JSON.stringify(list(mona))));
    assert.equal(cleared.body.find((each) => each.id === vic.id)?.request, undefined);
    assert.equal(kept(vic.id)?.accessRequest, undefined);
    assert.equal(told(boss, vic)?.request, undefined);
    // Nothing to clear is not an error.
    await done(boss, path(vic), { clear: true });

    // They take their own back.
    await done(vic, "me/access-request", {});
    assert.deepEqual(kept(vic.id)?.accessRequest, { at: clock });
    await done(vic, "me/access-request", { withdraw: true });
    assert.equal(kept(vic.id)?.accessRequest, undefined);

    // Made a user, what they asked is done with.
    await done(vic, "me/access-request", { note: "Let me prompt" });
    app.config.updateUser(vic.id, { role: "guest" });
    assert.equal(kept(vic.id)?.accessRequest, undefined);
    assert.equal(told(boss, vic)?.request, undefined);
});
