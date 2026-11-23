// Chat with one person (`direct.ts`): two people, each the owner or a user, write to each other on a person's page in
// People. Only the two read a thread, through real HTTP here; the counts are kept on the server; a viewer has none;
// a removed person's threads go; a restart keeps them; a push reaches the receiver only when they are not looking.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { User } from "../src/server/config.ts";
import { addDirect, directKey } from "../src/server/direct.ts";
import { DirectDoc, DirectIndexDoc, type DirectMessage } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { EmbedderMessage } from "../src/server/push.ts";
import type { Client } from "../src/server/room.ts";
import {
    type App,
    cleanUp,
    fakeTab,
    linkAuthenticator,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const model = scriptedModel();
const dataDir = `${root}/direct-data`;

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();

async function listen(): Promise<void> {
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function stop(): Promise<void> {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
}

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call<T = { error?: string }>(
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

/** A request that must work: its answer. */
async function done<T>(user: User, path: string, body?: unknown): Promise<T> {
    const answer = await call<T>(user, path, body);

    assert.equal(answer.status, 200, `${user.name} ${path}: ${JSON.stringify(answer.body)}`);

    return answer.body;
}

const post = (from: User, to: User, text: string, requestId: string = crypto.randomUUID()) =>
    done<DirectMessage>(from, `users/${to.id}/chat`, { text, requestId });
const thread = (user: User, other: User) =>
    done<{ messages: DirectMessage[] }>(user, `users/${other.id}/chat`);
const kept = (id: string) => app.config.userById(id)!;

/** A tab of `user`, attached: its `direct` and `direct-unread` events. */
async function tab(user: User) {
    const each = fakeTab(undefined, user);

    await app.attach(each.client);

    return {
        ...each,
        directs: () =>
            each.events
                .filter((event) => event.event === "direct")
                .map((event) => event.data as { person: string; messages: DirectMessage[] }),
        unread: () => each.last("direct-unread") as Record<string, number> | undefined,
    };
}

/** An embedder's tab: one whose connection said `embedder=notify` (`embedder.test.ts`). */
function embedderTab(user: User) {
    const each = fakeTab(undefined, user);
    const client: Client = { ...each.client, embedder: "embedder-notify" };
    const sent = () =>
        each.events
            .filter((event) => event.event === "embedder-notify")
            .map((event) => event.data as unknown as EmbedderMessage);

    return { client, sent };
}

before(async () => {
    app = await openApp(model, dataDir);
    await listen();
});

after(async () => {
    await stop();
    await app?.close();
    cleanUp();
});

test("a user writes to another: both read it, each tab hears it with the other's id, and reading clears the count", async () => {
    const ann = person("Ann", "guest");
    const ben = person("Ben", "guest");
    const annTab = await tab(ann);
    const benTab = await tab(ben);

    try {
        const message = await post(ann, ben, "  hello Ben  ");

        assert.equal(message.text, "hello Ben");
        assert.equal(message.userId, ann.id);
        assert.deepEqual((await thread(ann, ben)).messages, [message]);
        assert.deepEqual((await thread(ben, ann)).messages, [message]);

        assert.deepEqual(annTab.directs(), [{ person: ben.id, messages: [message] }]);
        assert.deepEqual(benTab.directs(), [{ person: ann.id, messages: [message] }]);
        await until(() => benTab.unread()?.[ann.id] === 1, "Ben's count");
        assert.deepEqual(benTab.unread(), { [ann.id]: 1 });
        assert.deepEqual(annTab.unread(), {});

        assert.deepEqual(await done(ben, `users/${ann.id}/chat/read`, {}), { ok: true });
        await until(() => benTab.unread()?.[ann.id] === undefined, "Ben's count cleared");
        assert.deepEqual(app.direct.unread(kept(ben.id)), {});
    } finally {
        app.detach(annTab.client);
        app.detach(benTab.client);
    }
});

test("the same requestId sent twice makes one message and one count", async () => {
    const cal = person("Cal", "guest");
    const dee = person("Dee", "guest");
    const first = await post(cal, dee, "once", "same-request");
    const again = await post(cal, dee, "once", "same-request");

    assert.deepEqual(again, first);
    assert.equal((await thread(dee, cal)).messages.length, 1);
    await until(() => app.direct.unread(kept(dee.id))[cal.id] !== undefined, "Dee's count");
    assert.deepEqual(app.direct.unread(kept(dee.id)), { [cal.id]: 1 });
});

test("a third person, the owner, gets nothing of a thread between two others", async () => {
    const eve = person("Eve", "guest");
    const fay = person("Fay", "guest");
    const ownerTab = await tab(owner(app));

    try {
        await post(eve, fay, "just us");
        await until(() => app.direct.unread(kept(fay.id))[eve.id] === 1, "Fay's count");

        assert.deepEqual(ownerTab.directs(), []);
        assert.deepEqual(ownerTab.unread() ?? {}, {});
        assert.deepEqual(app.direct.unread(owner(app)), {});
        // Asking about either gives the owner's own thread with them, which is empty.
        assert.deepEqual((await thread(owner(app), eve)).messages, []);
        assert.deepEqual((await thread(owner(app), fay)).messages, []);
    } finally {
        app.detach(ownerTab.client);
    }
});

test("refused: viewers, people held to sessions, yourself, nobody, empty text, and text too long", async () => {
    const gus = person("Gus", "guest");
    const vic = person("Vic", "viewer");
    const sam = person("Sam", "guest", ["1"]);
    const missing = { ...gus, id: "nobody-here", name: "Nobody" };
    const cases: [User, User, number, RegExp][] = [
        [vic, gus, 403, /Chat with one person is for the owner and users\./],
        [gus, vic, 403, /Chat with one person is for the owner and users\./],
        [sam, gus, 403, /Chat with one person is for the owner and users\./],
        [gus, sam, 403, /Chat with one person is for the owner and users\./],
        [gus, gus, 400, /That is you\./],
        [gus, missing, 404, /No such person/],
        // One who has no such chat is not told whether an id is someone's.
        [vic, missing, 403, /Chat with one person is for the owner and users\./],
        [sam, missing, 403, /Chat with one person is for the owner and users\./],
    ];

    for (const [from, to, status, said] of cases) {
        await refused(
            from,
            `users/${to.id}/chat`,
            { text: "hi", requestId: crypto.randomUUID() },
            status,
            said,
        );
        await refused(from, `users/${to.id}/chat`, undefined, status, said);
        await refused(from, `users/${to.id}/chat/read`, {}, status, said);
    }

    const other = person("Gwen", "guest");

    await refused(
        gus,
        `users/${other.id}/chat`,
        { text: "   ", requestId: "x" },
        400,
        /Message is empty/,
    );
    await refused(
        gus,
        `users/${other.id}/chat`,
        { text: "a".repeat(4001), requestId: "y" },
        413,
        /Chat messages are limited to 4000 characters/,
    );
    await refused(gus, `users/${other.id}/chat`, { text: "hi" }, 400, /text and requestId/);
    assert.deepEqual((await thread(other, gus)).messages, []);
});

test("a user made a viewer loses the thread and its count; made a user again, both come back", async () => {
    const hal = person("Hal", "guest");
    const ivy = person("Ivy", "guest");
    const ivyTab = await tab(ivy);

    try {
        const message = await post(hal, ivy, "before");

        await until(() => ivyTab.unread()?.[hal.id] === 1, "Ivy's count");

        await done(owner(app), `users/${hal.id}`, { role: "viewer" });
        await refused(hal, `users/${ivy.id}/chat`, undefined, 403, /for the owner and users/);
        await refused(ivy, `users/${hal.id}/chat`, undefined, 403, /for the owner and users/);
        await until(() => ivyTab.unread()?.[hal.id] === undefined, "Ivy's count no longer told");
        assert.deepEqual(app.direct.unread(kept(ivy.id)), {});

        linkAuthenticator(app, hal);
        await done(owner(app), `users/${hal.id}`, { role: "guest" });
        assert.deepEqual((await thread(ivy, hal)).messages, [message]);
        await until(() => ivyTab.unread()?.[hal.id] === 1, "Ivy's count back");
    } finally {
        app.detach(ivyTab.client);
    }
});

test("a removed person's threads go, with their counts", async () => {
    const jo = person("Jo", "guest");
    const kim = person("Kim", "guest");
    const kimTab = await tab(kim);
    const key = directKey(jo.id, kim.id);

    try {
        await post(jo, kim, "bye");
        await until(() => kimTab.unread()?.[jo.id] === 1, "Kim's count");
        assert.notEqual(await app.harness.snapshot(DirectDoc, key, context), undefined);

        await done(owner(app), `users/${jo.id}/remove`, {});

        assert.equal(await app.harness.snapshot(DirectDoc, key, context), undefined);
        const index = await app.harness.snapshot(DirectIndexDoc, context);

        assert.equal(
            Object.values(index?.threads ?? {}).some((each) => each.people.includes(jo.id)),
            false,
        );
        await until(() => kimTab.unread()?.[jo.id] === undefined, "Kim's count gone");
        assert.deepEqual(app.direct.unread(kept(kim.id)), {});
    } finally {
        app.detach(kimTab.client);
    }
});

test("a push reaches a receiver who is not looking, and none who is looking or turned chat off", async () => {
    const lee = person("Lee", "guest");
    const max = person("Max", "guest");
    const hidden = embedderTab(max);

    await app.attach(hidden.client);

    try {
        app.setVisible(max, hidden.client.id, false);
        await post(lee, max, "are you there?");

        assert.equal(hidden.sent().length, 1);
        const [message] = hidden.sent();

        assert.equal(message?.title, "Lee · Chat");
        assert.equal(message?.body, "are you there?");
        assert.equal(message?.url, `/?direct=${lee.id}`);
        assert.equal(message?.tag, `direct-${lee.id}`);

        // Looking: a tab in view.
        app.setVisible(max, hidden.client.id, true);
        await post(lee, max, "now?");
        assert.equal(hidden.sent().length, 1);

        // Chat turned off.
        app.setVisible(max, hidden.client.id, false);
        app.pushStore!.setPrefs(max.id, { chat: false });
        await post(lee, max, "quiet");
        assert.equal(hidden.sent().length, 1);
    } finally {
        app.pushStore!.setPrefs(max.id, { chat: true });
        app.detach(hidden.client);
    }
});

test("addDirect keeps the newest messages up to its limit", () => {
    const thread = { messages: [] as DirectMessage[] };

    for (let n = 1; n <= 5; n++) {
        addDirect(thread, { id: String(n), userId: "u", text: String(n), at: n }, 3);
    }

    assert.deepEqual(
        thread.messages.map((each) => each.id),
        ["3", "4", "5"],
    );
});

test("the people list says mayMessage only of the people that viewer may chat with", () => {
    const ned = person("Ned", "guest");
    const ola = person("Ola", "viewer");
    const pat = person("Pat", "guest", ["1"]);
    const told = (viewer: User) =>
        new Map(app.people(kept(viewer.id)).map((each) => [each.id, each.mayMessage === true]));
    const byNed = told(ned);

    assert.equal(byNed.get(owner(app).id), true);
    assert.equal(byNed.get(ned.id), false);
    assert.equal(byNed.get(ola.id), false);
    assert.equal(byNed.get(pat.id), false);
    assert.equal(told(owner(app)).get(ned.id), true);
    assert.equal([...told(ola).values()].some(Boolean), false);
    assert.equal([...told(pat).values()].some(Boolean), false);
});

// Last: it opens the app again on the same data folder.
test("after a restart, the messages and the counts are there", async () => {
    const quin = person("Quin", "guest");
    const rae = person("Rae", "guest");
    const message = await post(quin, rae, "remember me");

    await until(() => app.direct.unread(kept(rae.id))[quin.id] === 1, "Rae's count");

    await stop();
    await app.close();
    app = await openApp(model, dataDir);
    await listen();

    assert.deepEqual((await thread(rae, quin)).messages, [message]);
    assert.deepEqual(app.direct.unread(kept(rae.id)), { [quin.id]: 1 });
    const raeTab = await tab(kept(rae.id));

    try {
        assert.deepEqual(raeTab.unread(), { [quin.id]: 1 });
    } finally {
        app.detach(raeTab.client);
    }
});
