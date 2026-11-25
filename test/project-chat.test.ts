// The folder's people chat: real HTTP requests, two sessions at a time, with the live access policy.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import {
    ProjectChatDoc,
    ProjectChatIndexDoc,
    type ProjectChatMessage,
    SessionsDoc,
} from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";

const model = scriptedModel();
const dataDir = join(root, "project-chat");
let app: App;
let server: Server;
let address: string;
let first: ConversationId;
let second: ConversationId;
const tokens = new Map<string, string>();

const folder = (name: string) => {
    const path = join(work, name);

    mkdirSync(path, { recursive: true });

    return path;
};

function person(name: string, role: User["role"] = "guest", sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function share(user: User, id = first, given?: string): Promise<void> {
    app.config.setUsers(THIS_SERVER, [...(app.config.server.users ?? []), user.id]);

    if (given !== undefined) {
        app.config.setGivenFolders(THIS_SERVER, user.id, [given]);
    }

    await app.commands.shareSession(id, owner(app), [user.id]);
}

async function listen(): Promise<void> {
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stop(): Promise<void> {
    if (server !== undefined) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
}

async function call<T = { error?: string }>(user: User, path: string, body?: unknown) {
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

    return { status: response.status, body: (await response.json()) as T };
}

async function ok<T>(user: User, path: string, body?: unknown): Promise<T> {
    const answer = await call<T>(user, path, body);

    assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);

    return answer.body;
}

const route = (id: ConversationId) => `sessions/${id}/project-chat`;
const thread = (user: User, id: ConversationId) =>
    ok<{ key: string; computer: string; folder: string; messages: ProjectChatMessage[] }>(
        user,
        route(id),
    );
const post = (
    user: User,
    id: ConversationId,
    text: string,
    requestId: string = crypto.randomUUID(),
) => ok<ProjectChatMessage>(user, route(id), { text, requestId });

async function refused(user: User, id: ConversationId): Promise<void> {
    const answers = await Promise.all([
        call(user, route(id)),
        call(user, route(id), { text: "can't post", requestId: "refused" }),
    ]);

    assert.deepEqual(
        answers,
        Array(2).fill({ status: 404, body: { error: "No project chat here." } }),
    );
}

async function tab(t: TestContext, user: User, id?: ConversationId, embedder = false) {
    const each = fakeTab(id, user);
    const client = embedder
        ? { ...each.client, embedder: "embedder-notify" as const }
        : each.client;

    await app.attach(client);
    t.after(() => app.detach(client));

    return {
        ...each,
        client,
        projects: () =>
            each.events
                .filter((event) => event.event === "project-chat")
                .map((event) => event.data),
        pushes: () =>
            each.events
                .filter((event) => event.event === "embedder-notify")
                .map((event) => event.data),
    };
}

before(async () => {
    app = await openApp(model, dataDir);
    first = await newSession(app);
    second = await newSession(app);
    await listen();
});

after(async () => {
    await stop();
    cleanUp();
});

test("a person with the folder posts and the owner reads from another session", async () => {
    const ari = person("Ari");

    await share(ari, first, work);
    const message = await post(ari, first, "  Come to the review  ");
    const own = await thread(owner(app), second);

    assert.equal(message.text, "Come to the review");
    assert.equal(message.name, ari.name);
    assert.equal(own.folder, work);
    assert.equal(own.computer, THIS_SERVER);
    assert.equal(
        own.key,
        createHash("sha256").update(`${THIS_SERVER}\n${work}`).digest("hex").slice(0, 32),
    );
    assert.equal(own.key, (await thread(ari, first)).key);
    assert.deepEqual(own.messages, [message]);
});

test("one share without the folder gives no project routes or events", async (t) => {
    const beck = person("Beck");

    await share(beck);
    const looking = await tab(t, beck, first);

    assert.equal((await call(beck, `c/${first}/history`)).status, 200);
    await post(owner(app), first, "Folder people only");
    assert.deepEqual(looking.projects(), []);
    await refused(beck, first);
});

test("a one-session invite gives no project routes", async () => {
    const invited = person("Cam", "guest", [String(first)]);

    assert.equal((await call(invited, `c/${first}/history`)).status, 200);
    await refused(invited, first);
});

test("a viewer with a parent folder reads and writes", async () => {
    const dee = person("Dee", "viewer");
    const id = await newSession(app, folder("viewer"));

    await share(dee, id, work);
    assert.deepEqual((await thread(dee, id)).messages, []);
    const message = await post(dee, id, "A viewer can say hello");

    assert.deepEqual((await thread(owner(app), id)).messages, [message]);
});

test("a nested folder has its own chat; a worktree uses its source's chat", async () => {
    const keeper = owner(app);
    const source = folder("source");
    const original = await newSession(app, source);
    const child = await newSession(app, folder("source/child"));
    const path = folder("worktree");
    const moved = await newSession(app, path);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(moved)]!.worktree = {
            path,
            source,
            branch: "review",
        };
    }, context);
    await until(() => app.folderOf(moved)?.path === source, "the worktree's recorded source");

    const message = await post(keeper, original, "From the source folder");
    const local = await thread(keeper, original);
    const separate = await thread(keeper, child);

    assert.notEqual(separate.key, local.key);
    assert.deepEqual(separate.messages, []);
    assert.deepEqual(await thread(keeper, moved), { ...local, messages: [message] });
});

test("the same path on a runner has a different chat, retired on unlink", async () => {
    const keeper = owner(app);
    const cwd = folder("both");
    const local = await newSession(app, cwd);
    const remote = await newSession(app, cwd);
    const { id: computer } = app.config.addRunner("Laptop", keeper.id, newIdentity().publicKey);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(remote)]!.runner = computer;
    }, context);
    await until(() => app.folderOf(remote)?.computer === computer, "the runner session");
    const mine = await post(keeper, local, "Server message");
    const theirs = await post(keeper, remote, "Runner message");
    const a = await thread(keeper, local);
    const b = await thread(keeper, remote);

    assert.equal(a.folder, b.folder);
    assert.notEqual(a.key, b.key);
    assert.deepEqual(a.messages, [mine]);
    assert.deepEqual(b.messages, [theirs]);
    await app.unlinkRunner(computer);
    assert.equal(await app.harness.snapshot(ProjectChatDoc, b.key, context), undefined);
    await refused(keeper, remote);
    assert.deepEqual((await thread(keeper, local)).messages, [mine]);
});

test("events go only to open matching tabs; an unchosen person gets no later post", async (t) => {
    const keeper = owner(app);
    const evan = person("Evan");
    const wrong = await newSession(app, folder("other"));

    await share(evan, second, work);
    const here = await tab(t, keeper, first);
    const there = await tab(t, evan, second);
    const elsewhere = await tab(t, keeper, wrong);
    const list = await tab(t, keeper);
    const { key } = await thread(keeper, first);
    const one = await post(keeper, first, "Before unchoosing");

    assert.deepEqual(there.projects(), [{ key, messages: [one] }]);
    // Judge the current person even on a tab still attached when the record has already changed.
    app.config.setUsers(
        THIS_SERVER,
        (app.config.server.users ?? []).filter((id) => id !== evan.id),
    );
    const two = await post(keeper, first, "After unchoosing");

    assert.deepEqual(there.projects(), [{ key, messages: [one] }]);
    assert.deepEqual(here.projects(), [
        { key, messages: [one] },
        { key, messages: [two] },
    ]);
    assert.deepEqual(elsewhere.projects(), []);
    assert.deepEqual(list.projects(), []);
});

test("queued project events go when a polling tab loses the folder but keeps the session", async () => {
    const keeper = owner(app);
    const user = person("Perry");

    await share(user, second, work);
    type Poll = { session: string; events: { event: string }[] };
    const { session, events } = await ok<Poll>(user, `poll?c=${second}`);

    try {
        assert.ok(events.some(({ event }) => event === "view"));
        await post(keeper, first, "Do not deliver this after revocation");
        await app.giveFolders(keeper, THIS_SERVER, user.id, []);
        assert.ok(app.canSee(user, second));

        const next = await ok<Poll>(user, `poll?session=${session}&ack=0`);

        assert.ok(next.events.some(({ event }) => event === "project-chat-access"));
        assert.ok(!next.events.some(({ event }) => event === "project-chat"));
    } finally {
        await call(user, `poll?session=${session}&close=1`);
    }
});

test("a post checks the folder again inside its commit", async (t) => {
    const keeper = owner(app);
    const user = person("Quinn");
    const cwd = folder("post-race");
    const id = await newSession(app, cwd);

    await share(user, id, cwd);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = app.harness.commit(async () => {
        entered.resolve();
        await release.promise;
    }, context);
    const mayChatIn = app.policy.mayChatIn.bind(app.policy);
    let checked = false;

    t.mock.method(app.policy, "mayChatIn", (person: User, computer: string, path: string) => {
        const allowed = mayChatIn(person, computer, path);

        if (person.id === user.id && allowed) {
            checked = true;
        }

        return allowed;
    });

    try {
        await entered.promise;
        const pending = call(user, route(id), { text: "Do not save this", requestId: "revoked" });

        await until(() => checked, "the post's first folder check");
        app.config.setGivenFolders(THIS_SERVER, user.id, []);
        assert.ok(app.canSee(user, id));
        release.resolve();
        assert.equal((await pending).status, 404);
        assert.deepEqual((await thread(keeper, id)).messages, []);
    } finally {
        release.resolve();
        await held;
    }
});

test("only an eligible mention pushes, when its person is not looking and allows mentions", async (t) => {
    const keeper = owner(app);
    const finn = person("Finn");
    const gio = person("Gio");
    const haru = person("Haru");

    app.config.setUsers(THIS_SERVER, [
        ...(app.config.server.users ?? []),
        finn.id,
        gio.id,
        haru.id,
    ]);
    app.config.setGivenFolders(THIS_SERVER, finn.id, [work]);
    app.config.setGivenFolders(THIS_SERVER, haru.id, [work]);
    await app.commands.shareSession(second, keeper, [finn.id, gio.id, haru.id]);
    const away = await tab(t, finn, undefined, true);
    const refused = await tab(t, gio, second, true);
    const looking = await tab(t, haru, second, true);
    const message = await post(keeper, first, "@Finn @Gio @Haru: look at this");

    assert.deepEqual(message.mentions, [finn.id, haru.id]);
    assert.equal(away.pushes().length, 1);
    assert.equal(away.pushes()[0]?.body, message.text);
    assert.deepEqual(refused.pushes(), []);
    assert.deepEqual(looking.pushes(), []);
    assert.equal(looking.projects().length, 1);
    app.pushStore!.setPrefs(finn.id, { mention: false });
    await post(keeper, first, "@Finn: quiet please");
    await post(keeper, first, "No mentions here");
    assert.equal(away.pushes().length, 1);
});

test("off is for server managers, refuses both routes, and retires the chats", async (t) => {
    const keeper = owner(app);
    const viewer = person("Izzy", "viewer");
    const list = await tab(t, keeper);
    const id = await newSession(app, folder("switch"));
    const { key } = await thread(keeper, id);

    await post(keeper, id, "Delete this");
    assert.equal((await call(viewer, "project-chat", { on: false })).status, 403);
    assert.equal((await thread(keeper, id)).messages.length, 1);
    await ok(keeper, "project-chat", { on: false });
    assert.equal(app.config.server.projectChat, false);
    assert.deepEqual(list.last("project-chat-access"), { on: false });
    await refused(keeper, id);
    assert.equal(await app.harness.snapshot(ProjectChatDoc, key, context), undefined);
    assert.deepEqual((await app.harness.snapshot(ProjectChatIndexDoc, context))?.chats, {});
    await ok(keeper, "project-chat", { on: true });
    assert.equal(app.config.server.projectChat, undefined);
    assert.deepEqual((await thread(keeper, id)).messages, []);
    const fresh = await post(keeper, id, "Fresh after enabling");

    assert.deepEqual((await thread(keeper, id)).messages, [fresh]);
});

test("a restart finishes retiring chats of a removed runner and a saved off setting", async () => {
    const keeper = owner(app);
    const local = await newSession(app, folder("restart"));
    const remote = await newSession(app, folder("restart-runner"));
    const { id: computer } = app.config.addRunner(
        "Removed Laptop",
        keeper.id,
        newIdentity().publicKey,
    );

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(remote)]!.runner = computer;
    }, context);
    await until(() => app.folderOf(remote)?.computer === computer, "the runner session");
    const localMessage = await post(keeper, local, "Keep this until off");

    await post(keeper, remote, "Retire this when the runner is gone");
    const { key: remoteKey } = await thread(keeper, remote);
    const { key: localKey } = await thread(keeper, local);

    // A restart between the config save and the SQLite retirement.
    app.runners.remove(computer);
    await stop();
    app = await openApp(model, dataDir);
    await listen();
    assert.equal(await app.harness.snapshot(ProjectChatDoc, remoteKey, context), undefined);
    assert.deepEqual((await thread(owner(app), local)).messages, [localMessage]);

    app.config.setProjectChat(false);
    await stop();
    app = await openApp(model, dataDir);
    await listen();
    await refused(owner(app), local);
    assert.equal(await app.harness.snapshot(ProjectChatDoc, localKey, context), undefined);
    await ok(owner(app), "project-chat", { on: true });
});

test("the same requestId adds nothing and sends no second event", async (t) => {
    const keeper = owner(app);
    const id = await newSession(app, folder("repeat"));
    const looking = await tab(t, keeper, id);
    const message = await post(keeper, id, "First send", "same-request");

    assert.deepEqual(await post(keeper, id, "Retried send", "same-request"), message);
    assert.deepEqual((await thread(keeper, id)).messages, [message]);
    assert.equal(looking.projects().length, 1);
});

test("message 501 drops message 1 and keeps the newest 500", async () => {
    const keeper = owner(app);
    const id = await newSession(app, folder("limit"));

    for (let n = 1; n <= 501; n++) {
        await post(keeper, id, `Message ${n}`, `limit-${n}`);
    }

    const { messages } = await thread(keeper, id);

    assert.deepEqual(
        messages.map((message) => message.text),
        Array.from({ length: 500 }, (_, n) => `Message ${n + 2}`),
    );
});

test("a post does not go into what the model got", async () => {
    const note = "A private remark in project chat, not an instruction for Pi";

    await post(owner(app), first, note);
    await say(app, first, "Please say hello");
    const texts = await modelTexts(app, first);

    assert.ok(texts.some((text) => text.includes("Please say hello")));
    assert.ok(!texts.some((text) => text.includes(note)), "project text in the model context");
});

test("a session moved to another folder tells its open tabs to load the chat again", async (t) => {
    const keeper = owner(app);
    const to = folder("move-to");
    const moving = await newSession(app, folder("move-from"));
    const stays = await newSession(app, to);
    const looking = await tab(t, keeper, moving);
    const asked = () =>
        looking.events.filter((event) => event.event === "project-chat-access").length;
    const earlier = asked();

    await app.commands.configure(moving, keeper, { cwd: to });
    assert.equal(asked(), earlier + 1, "the tab still holds the chat of the folder it left");

    const { key } = await thread(keeper, stays);
    const message = await post(keeper, stays, "For the folder it moved to");

    assert.deepEqual(looking.projects().at(-1), { key, messages: [message] });
});

test("neither a session view nor hello contains project messages for a person without the folder", async (t) => {
    const kai = person("Kai");
    const note = "A project message that is not part of a session view";

    await share(kai, second);
    await post(owner(app), first, note);
    const looking = await tab(t, kai, second);
    const [view] = await Promise.all([
        ok(kai, `c/${second}/history`),
        until(() => looking.last("view") !== undefined, "the live session view"),
    ]);
    const bits = [view, looking.last("view"), looking.last("hello")];

    assert.ok(bits.every((bit) => bit !== undefined));
    assert.deepEqual(
        bits.map((bit) => JSON.stringify(bit).includes(note)),
        [false, false, false],
        "transcript, live view, hello",
    );
});
