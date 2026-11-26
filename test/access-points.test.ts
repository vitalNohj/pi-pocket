// Every place that lists, opens, starts, or names a session or a folder on this server asks the access policy
// (`access.ts`): for each, one person who may gets in, and one who may not is refused. A real App over HTTP, with
// people the owner chose for this server, a person invited to one session, and someone nobody chose.
import {
    type App,
    answerRequests,
    approveSession,
    cleanUp,
    context,
    fakeTab,
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
/** Chosen for this server: a guest who steers, and a viewer. */
let guest: User;
let viewer: User;
/** Invited to `shared` alone. */
let invited: User;
/** On this server, but nobody chose them. */
let stranger: User;
/** The owner's, shared with `guest` and `viewer`. */
let shared: ConversationId;
/** The owner's, shared with nobody. */
let hidden: ConversationId;
const elsewhere = join(root, "elsewhere");
const outside = join(root, "outside.txt");

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call<T = Record<string, unknown>>(
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

const listed = (user: User) => app.sessions(user).map((each) => String(each.id));
/** The record of `user` as it is kept now. */
const now = (user: User) => app.config.userById(user.id)!;

/**
 * Run `during` with the guest no longer chosen for this server, as the settings alone say it: what a restart leaves
 * when it cuts an unchoose short (`app.ts` `#finishLeaving`), with nothing taken back yet. Then the guest is as before.
 * The app's own unchoose would take their shares and sessions here, which the tests after this one use.
 */
async function withoutGuest(during: () => Promise<unknown>): Promise<void> {
    app.config.setUsers(THIS_SERVER, [viewer.id]);
    app.accessChanged();

    try {
        await during();
    } finally {
        app.config.setUsers(THIS_SERVER, [guest.id, viewer.id]);
        // Nothing was taken back, so nothing is left to finish: what is shared with the guest counts again.
        app.config.clearLeaving(THIS_SERVER, [guest.id]);
        app.accessChanged();
    }
}

/** Every session id a tab was ever sent in a session list. */
const everListed = (tab: ReturnType<typeof fakeTab>) =>
    new Set(
        tab.events
            .filter((each) => each.event === "sessions")
            .flatMap((each) => (each.data as unknown as { id: number }[]).map((s) => String(s.id))),
    );

/**
 * Whether a tab was ever sent anything of session `id`: an event for it, or it in a list. `missing` (the refusal) and
 * `switched` (the echo of the id the tab itself asked for) carry nothing of the session.
 */
const everSent = (tab: ReturnType<typeof fakeTab>, id: ConversationId) =>
    everListed(tab).has(String(id)) ||
    tab.events.some(
        (each) =>
            each.event !== "missing" &&
            each.event !== "switched" &&
            (each.data as { conversationId?: unknown })?.conversationId === Number(id),
    );

let stopAnswering: () => void = () => {};

before(async () => {
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(work, "inside.txt"), "Inside the session folder.\n");
    writeFileSync(outside, "Outside every session folder.\n");
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    shared = await newSession(app);
    hidden = await newSession(app);
    await say(app, shared, "something to fork");
    guest = person("Guest", "guest");
    viewer = person("Viewer", "viewer");
    invited = person("Invited", "guest", [String(shared)]);
    stranger = person("Stranger", "guest");
    app.config.setUsers(THIS_SERVER, [guest.id, viewer.id]);

    // The folders here are given, and the owner allows every new session at once: who may start a session is what these
    // tests check, not approvals (`folder-requests.test.ts`).
    for (const each of [guest, viewer]) {
        app.config.setGivenFolders(THIS_SERVER, each.id, [realpathSync(root)]);
        app.config.updateUser(each.id, { approvalDays: 0 });
    }

    // The owner lets the guest invite people: off until then (`access.ts` `invites`).
    app.setRight(owner(app), { person: guest.id, right: "invites", on: true });
    stopAnswering = answerRequests(app, () => true);
    app.accessChanged();
    await app.commands.shareSession(shared, owner(app), [guest.id, viewer.id]);
    approveSession(app, shared, guest);
});

after(async () => {
    stopAnswering();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("people invited before the policy", () => {
    it("start with nothing until the owner chooses them, and the owner keeps every session", async () => {
        const late = person("Late", "guest");

        assert.deepEqual(listed(late), []);
        assert.equal((await call(late, "fs")).status, 403);
        assert.ok(listed(owner(app)).includes(String(hidden)));
        assert.ok(listed(owner(app)).includes(String(shared)));
    });
});

describe("the session list", () => {
    it("shows a chosen person their own and shared sessions, and nothing else", async () => {
        const answer = await call<{ id: number }[]>(guest, "sessions");

        assert.equal(answer.status, 200);
        assert.ok(answer.body.some((each) => String(each.id) === String(shared)));
        assert.ok(!answer.body.some((each) => String(each.id) === String(hidden)));
    });

    it("shows someone nobody chose nothing, and a person invited to one session that one", async () => {
        assert.deepEqual((await call<unknown[]>(stranger, "sessions")).body, []);
        assert.deepEqual(listed(invited), [String(shared)]);
    });

    it("hides a fork's source in the list from someone who sees only the copy", async () => {
        const source = await newSession(app);

        await say(app, source, "a reply to fork from");
        const { id: copy } = await app.commands.fork(source, owner(app), {});

        await app.commands.shareSession(copy, owner(app), [guest.id]);
        assert.equal(app.canSee(guest, source), false);

        type Row = { id: number; forkedFrom?: { id?: number; entryId?: number } };
        const theirs = await call<Row[]>(guest, "sessions");
        const mine = await call<Row[]>(owner(app), "sessions");
        const forkedFrom = mine.body.find((row) => row.id === Number(copy))?.forkedFrom;

        assert.equal(theirs.status, 200);
        assert.equal(mine.status, 200);
        assert.deepEqual(theirs.body.find((row) => row.id === Number(copy))?.forkedFrom, {});
        assert.equal(forkedFrom?.id, Number(source));
        assert.deepEqual(forkedFrom, app.sessionMeta(copy)?.forkedFrom);
    });
});

describe("the session cleanup browser module", () => {
    it("loads the built-in for a runner manager and updates an open tab when the permission changes", async () => {
        const manager = person("Cleanup manager", "guest");
        const tab = fakeTab(undefined, manager);
        const hasCleanup = (modules: readonly { module: string }[]) =>
            modules.some((each) => each.module === "session-cleanup");
        const offered = () =>
            hasCleanup((tab.last("hello")?.server as { ui: { module: string }[] }).ui);
        const cleanup = () => app.webs.file("session-cleanup", ["index.js"], manager);

        await app.attach(tab.client);

        try {
            assert.equal(offered(), false);
            assert.equal(cleanup(), undefined);
            app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: true });
            await until(offered, "hello adding the cleanup browser module");
            assert.equal(hasCleanup(app.webs.clients(manager)), true);
            assert.equal(hasCleanup(app.webs.clients(guest)), false);
            assert.ok(cleanup() !== undefined);
            assert.equal(app.webs.file("session-cleanup", ["index.js"], guest), undefined);

            app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: false });
            await until(() => !offered(), "hello removing the cleanup browser module");
            assert.equal(cleanup(), undefined);
        } finally {
            app.detach(tab.client);
        }
    });

    it("keeps a drop-in named session-cleanup owner-only", async () => {
        const manager = person("Another cleanup manager", "guest");

        app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: true });
        const directory = join(root, "cleanup-drop-in");

        mkdirSync(directory);
        writeFileSync(join(directory, "index.js"), "export {};\n");
        const webs = new ExtensionWebs({
            mayUse: (user, access, builtInModule) =>
                app.policy.mayUseExtension(user, access, builtInModule),
        });

        try {
            // Stage the same-named drop-in by itself: the loader prefers the built-in when both exist.
            const { part, web } = webs.stage("session-cleanup.ts", directory, "Drop-in cleanup");

            web.client("index.js", { access: "owner" });
            web.route("POST", "plan", () => ({}), { access: "owner" });
            webs.commit(part);

            assert.equal(webs.clients(owner(app))[0]?.module, "session-cleanup");
            assert.deepEqual(webs.clients(manager), []);
            assert.equal(webs.match("session-cleanup", "POST", ["plan"], manager), undefined);
            assert.equal(webs.file("session-cleanup", ["index.js"], manager), undefined);
        } finally {
            await webs.close();
        }
    });
});

describe("notification preferences", () => {
    it("offers only the Security and folder or renewal switches that each person can use", async () => {
        const peopleManager = person("People manager", "guest");
        const runnerManager = person("Runner manager", "guest");
        const linker = person("Notification linker", "guest");

        app.setRight(owner(app), { person: peopleManager.id, right: "managesUsers", on: true });
        app.setRight(owner(app), { person: runnerManager.id, right: "managesRunners", on: true });
        const runner = app.config.addRunner(
            "Notification laptop",
            linker.id,
            newIdentity().publicKey,
        );

        try {
            for (const [user, security, folders] of [
                [owner(app), true, "requests"],
                [peopleManager, true, "renewals"],
                [runnerManager, false, "requests"],
                [linker, false, "requests"],
                [guest, false, "renewals"],
                [viewer, false, false],
                [invited, false, false],
            ] as const) {
                const answer = await call(user, "push");

                assert.equal(answer.status, 200, user.name);
                assert.deepEqual(answer.body.kinds, { security, folders }, user.name);
            }
        } finally {
            app.config.removeRunner(runner.id);
        }
    });
});

describe("live updates", () => {
    it("never send a session to a tab that may not see it, and send one shared later to who it is shared with", async () => {
        const watching = fakeTab(undefined, guest);
        const refused = fakeTab(undefined, stranger);

        await app.attach(watching.client);
        await app.attach(refused.client);

        try {
            const fresh = await newSession(app);

            await say(app, fresh, "news nobody else may see");
            await app.commands.updateSession(fresh, owner(app), { title: "Owner's secret" });
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.equal(everSent(watching, fresh), false);
            assert.equal(everSent(refused, fresh), false);

            await app.commands.shareSession(fresh, owner(app), [guest.id]);
            await until(
                () => everListed(watching).has(String(fresh)),
                "the shared session's arrival",
            );
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.equal(everSent(refused, fresh), false);
            assert.ok(!JSON.stringify(refused.events).includes("Owner's secret"));
        } finally {
            app.detach(watching.client);
            app.detach(refused.client);
        }
    });

    it("take a tab out of a session the moment it stops being shared", async () => {
        const fresh = await newSession(app);

        await app.commands.shareSession(fresh, owner(app), [guest.id]);
        const tab = fakeTab(fresh, guest);

        await app.attach(tab.client);

        try {
            assert.ok(tab.events.some((each) => each.event === "view"));
            await app.commands.shareSession(fresh, owner(app), []);
            assert.equal(tab.last("missing")?.conversationId, Number(fresh));
            assert.equal(tab.client.conversationId, undefined);
        } finally {
            app.detach(tab.client);
        }
    });
    it("drops a lost session's queued long-poll events and the old session list, but keeps app-wide events", async () => {
        const fresh = await newSession(app);

        await app.commands.shareSession(fresh, owner(app), [guest.id]);

        type Poll = {
            session: string;
            events: { seq: number; event: string; data: unknown }[];
        };
        const first = await call<Poll>(guest, `poll?c=${fresh}`);
        const { session, events } = first.body;

        try {
            assert.equal(first.status, 200);
            const sessions = events.find((item) => item.event === "sessions");

            assert.ok(sessions);
            assert.ok(events.some((item) => item.event === "view"));

            // No new poll takes this chat, and the first answer is still unacknowledged.
            const room = await app.room(fresh);

            await app.collab.postChat(fresh, owner(app), {
                text: "unpolled chat",
                requestId: "unpolled-chat",
            });
            await until(
                () => room.chat.some((message) => message.text === "unpolled chat"),
                "the chat reaching the room",
            );
            await app.commands.shareSession(fresh, owner(app), []);

            const next = await call<Poll>(guest, `poll?session=${session}&ack=0`);

            assert.equal(next.status, 200);
            assert.equal(next.body.session, session);
            const missing = next.body.events.find((item) => item.event === "missing");

            assert.ok(missing);
            assert.ok(missing.seq > events.at(-1)!.seq, "event numbers are not reused");
            assert.equal(
                (missing.data as { conversationId: number }).conversationId,
                Number(fresh),
            );
            // The list made while the session was shared goes too: it names the session. The hello stays.
            assert.equal(
                next.body.events.find((item) => item.seq === sessions.seq),
                undefined,
            );
            assert.ok(next.body.events.some((item) => item.event === "hello"));
            const scoped = new Set(["view", "chat", "notes", "browser", "peek", "presence"]);

            assert.deepEqual(
                next.body.events.map((item) => item.event).filter((event) => scoped.has(event)),
                [],
                "nothing queued by the room or Browser panel remains",
            );
        } finally {
            await call(guest, `poll?session=${session}&close=1`);
        }
    });

    it("sends a long-poll tab that has not polled since a folder's level went down no list with that folder's session", async () => {
        const fresh = await newSession(app);
        const top = realpathSync(root);

        type Item = { seq: number; event: string; data: unknown };
        type Poll = { session: string; events: Item[] };
        const listsIt = (events: Item[]) =>
            events.some(
                (item) =>
                    item.event === "sessions" &&
                    (item.data as { id: number }[]).some((each) => each.id === Number(fresh)),
            );
        const raised = await call(owner(app), "runners/this-server/level", {
            person: viewer.id,
            folder: top,
            level: "all",
        });

        assert.equal(raised.status, 200, JSON.stringify(raised.body));
        const first = await call<Poll>(viewer, "poll");
        const { session } = first.body;

        try {
            assert.ok(listsIt(first.body.events), "at All sessions, the tab was sent it");
            const lowered = await call(owner(app), "runners/this-server/level", {
                person: viewer.id,
                folder: top,
                level: "none",
            });

            assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
            assert.ok(!listed(viewer).includes(String(fresh)), "the level is down");

            // The tab has not polled since: the next answer must not carry the session in any list.
            const next = await call<Poll>(viewer, `poll?session=${session}&ack=0`);

            assert.equal(next.status, 200);
            assert.equal(
                listsIt(next.body.events),
                false,
                "a sessions event sent after the level went down still lists the session",
            );
        } finally {
            await call(viewer, `poll?session=${session}&close=1`);
            app.config.setGivenFolders(THIS_SERVER, viewer.id, [top]);
            app.accessChanged();
        }
    });

    it("drops the queued peek tiles of a session a long-poll tab may no longer see", async () => {
        const fresh = await newSession(app);

        await say(app, fresh, "something for a tile to show");
        await app.commands.shareSession(fresh, owner(app), [guest.id]);

        type Item = { seq: number; event: string; data: { conversationId?: number } };
        type Poll = { session: string; events: Item[] };
        const first = await call<Poll>(guest, "poll");
        const { session } = first.body;
        // Nothing is acknowledged, so every answer has all that still waits for the tab.
        const waiting = async () =>
            (await call<Poll>(guest, `poll?session=${session}&ack=0`)).body.events;
        const tiles = (events: Item[]) =>
            events.filter(
                (item) => item.event === "peek" && item.data.conversationId === Number(fresh),
            );

        try {
            assert.equal(first.status, 200);
            const hello = first.body.events.find((item) => item.event === "hello");
            const connection = (hello?.data as { connection?: string } | undefined)?.connection;

            assert.equal(typeof connection, "string");
            assert.equal(
                (await call(guest, "peeks", { connection, ids: [Number(fresh)] })).status,
                200,
            );

            let queued: Item[] = [];

            await until(async () => {
                queued = tiles(await waiting());

                return queued.length > 0;
            }, "the tile waiting for the tab");

            await app.commands.shareSession(fresh, owner(app), []);
            assert.equal(app.canSee(guest, fresh), false);

            const after = await waiting();

            assert.deepEqual(tiles(after), [], "no tile of it still waits");
            assert.ok(
                after.some((item) => item.event === "hello"),
                "what is not about that session still waits",
            );
        } finally {
            await call(guest, `poll?session=${session}&close=1`);
        }
    });
});

describe("opening a session by its id or link", () => {
    it("opens a shared session", async () => {
        const tab = fakeTab(shared, guest);

        await app.attach(tab.client);

        try {
            assert.ok(tab.events.some((each) => each.event === "view"));
            assert.equal((await call(guest, `c/${shared}/history`)).status, 200);
        } finally {
            app.detach(tab.client);
        }
    });

    it("tells someone else it is not shared with them, and sends nothing of it", async () => {
        const tab = fakeTab(hidden, guest);

        await app.attach(tab.client);

        try {
            assert.match(String(tab.last("missing")?.message), /not shared with you/);
            assert.equal(everSent(tab, hidden), false);
            assert.ok(!tab.events.some((each) => each.event === "view"));
            assert.equal((await call(guest, `c/${hidden}/history`)).status, 404);
            assert.equal((await call(stranger, `c/${shared}/history`)).status, 404);
        } finally {
            app.detach(tab.client);
        }
    });

    it("switches a tab only to a session it may see, and peeks only at those", async () => {
        const tab = fakeTab(undefined, guest);

        await app.attach(tab.client);

        try {
            assert.equal(app.switchTo(guest, tab.client.connection, shared, undefined, 1), true);
            await until(() => tab.events.some((each) => each.event === "view"), "the shared view");
            app.switchTo(guest, tab.client.connection, hidden, undefined, 2);
            await until(() => tab.last("missing") !== undefined, "the refusal");
            assert.equal(everSent(tab, hidden), false);
            app.setPeeks(guest, tab.client.connection, [hidden, shared]);
            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.ok(
                !tab.events.some(
                    (each) => each.event === "peek" && each.data.conversationId === Number(hidden),
                ),
            );
        } finally {
            app.detach(tab.client);
        }
    });
});

describe("steering and viewing", () => {
    it("lets a chosen guest steer a shared session", async () => {
        const answer = await call(guest, `c/${shared}/submit`, { text: "hello", requestId: "g1" });

        assert.equal(answer.status, 200);
    });

    it("requires both the session and the folder for project chat GET and POST", async () => {
        for (const body of [undefined, { text: "hello from the folder", requestId: "project" }]) {
            assert.equal((await call(guest, `sessions/${shared}/project-chat`, body)).status, 200);
            assert.equal((await call(guest, `sessions/${hidden}/project-chat`, body)).status, 404);
            assert.equal(
                (await call(invited, `sessions/${shared}/project-chat`, body)).status,
                404,
            );
        }
    });

    it("lets a viewer read and use the people chat, but not the agent chat", async () => {
        assert.equal((await call(viewer, `c/${shared}/history`)).status, 200);
        assert.equal(
            (await call(viewer, `c/${shared}/chat`, { text: "just watching", requestId: "v1" }))
                .status,
            200,
        );
        assert.equal(
            (await call(viewer, `c/${shared}/submit`, { text: "do this", requestId: "v2" })).status,
            403,
        );
        assert.equal(
            (await call(viewer, `c/${hidden}/chat`, { text: "hi", requestId: "v3" })).status,
            404,
        );
    });
});

describe("new sessions", () => {
    it("start for a chosen guest, private to them", async () => {
        const answer = await call<{ id: number }>(guest, "sessions", { cwd: work });

        assert.equal(answer.status, 200);
        assert.equal(app.sessionMeta(String(answer.body.id) as never)?.createdBy, guest.id);
        assert.ok(listed(guest).includes(String(answer.body.id)));
        assert.ok(!listed(viewer).includes(String(answer.body.id)));
        assert.ok(listed(owner(app)).includes(String(answer.body.id)));
    });

    it("are refused to someone nobody chose, a viewer, and a person invited to one session", async () => {
        assert.equal((await call(stranger, "sessions", { cwd: work })).status, 403);
        assert.equal((await call(viewer, "sessions", { cwd: work })).status, 403);
        assert.equal((await call(invited, "sessions", { cwd: work })).status, 403);
    });
});

describe("copies and forks", () => {
    it("fork and copy for a chosen guest a session shared with them, to themselves", async () => {
        const fork = await call<{ id: number }>(guest, `c/${shared}/fork`, {});

        assert.equal(fork.status, 200);
        assert.equal(app.sessionMeta(String(fork.body.id) as never)?.createdBy, guest.id);
        assert.equal((await call(guest, `c/${shared}/copy-place`)).status, 200);
    });

    it("are refused where the session is not shared, to a viewer, and to a person invited to one session", async () => {
        assert.equal((await call(guest, `c/${hidden}/fork`, {})).status, 404);
        assert.equal((await call(guest, `c/${hidden}/copy-place`)).status, 404);
        assert.equal((await call(stranger, `c/${shared}/fork`, {})).status, 404);
        assert.equal((await call(viewer, `c/${shared}/fork`, {})).status, 403);
        assert.equal((await call(invited, `c/${shared}/fork`, {})).status, 403);
    });
});

describe("moving a session to another folder", () => {
    it("moves a chosen guest's session", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const id = String(body.id);

        assert.equal((await call(guest, `c/${id}/configure`, { cwd: elsewhere })).status, 200);
        assert.equal(app.cwdOf(id as never), elsewhere);
    });

    it("is refused to a person invited to one session, and on a session not shared", async () => {
        const moved = await call<{ error?: string }>(invited, `c/${shared}/configure`, {
            cwd: elsewhere,
        });

        assert.equal(moved.status, 403);
        assert.equal(app.cwdOf(shared), work);
        assert.equal((await call(guest, `c/${hidden}/configure`, { cwd: elsewhere })).status, 404);
    });
});

describe("the folder picker", () => {
    it("browses and makes folders for a chosen guest", async () => {
        assert.equal((await call(guest, `fs?path=${encodeURIComponent(root)}`)).status, 200);
        assert.equal((await call(guest, "fs", { path: join(root, "made-by-guest") })).status, 200);
    });

    it("is refused to someone nobody chose, a viewer, and a person invited to one session", async () => {
        for (const user of [stranger, viewer, invited]) {
            assert.equal((await call(user, "fs")).status, 403, user.name);
            assert.equal(
                (await call(user, "fs", { path: join(root, `made-by-${user.id}`) })).status,
                403,
                user.name,
            );
        }
    });
});

describe("the Files panel", () => {
    it("lists a shared session's files, and reads outside its folder for who may start sessions here", async () => {
        assert.equal((await call(guest, `c/${shared}/files`)).status, 200);
        assert.equal(
            (await call(guest, `c/${shared}/view?path=${encodeURIComponent(outside)}`)).status,
            200,
        );
        assert.equal(
            (
                await call(
                    invited,
                    `c/${shared}/view?path=${encodeURIComponent(join(work, "inside.txt"))}`,
                )
            ).status,
            200,
        );
    });

    it("reads in the folders given to a chosen guest, and not past them: only who is in charge reads what Pi can", async () => {
        // The guest is given the test folder only. A file in a folder not given: never theirs to read, by any path.
        const notGiven = mkdtempSync(join(tmpdir(), "pi-pocket-not-given-"));
        const secret = join(notGiven, "secret.txt");

        writeFileSync(secret, "Not given to the guest.\n");
        symlinkSync(secret, join(work, "secret-link.txt"));

        try {
            for (const path of [secret, join(work, "secret-link.txt")]) {
                const read = await call(guest, `c/${shared}/view?path=${encodeURIComponent(path)}`);

                assert.equal(read.status, 404, path);
                assert.ok(!JSON.stringify(read.body).includes("Not given"));
                assert.equal(
                    (await call(guest, `c/${shared}/download?path=${encodeURIComponent(path)}`))
                        .status,
                    404,
                    path,
                );
            }

            // The owner, in charge of this server, reads what Pi can.
            assert.equal(
                (await call(owner(app), `c/${shared}/view?path=${encodeURIComponent(secret)}`))
                    .status,
                200,
            );
        } finally {
            rmSync(join(work, "secret-link.txt"), { force: true });
            rmSync(notGiven, { recursive: true, force: true });
        }
    });

    it("is refused on a session not shared, and outside the folder to a person invited to one session", async () => {
        assert.equal((await call(guest, `c/${hidden}/files`)).status, 404);
        assert.equal((await call(stranger, `c/${shared}/files`)).status, 404);
        const read = await call(invited, `c/${shared}/view?path=${encodeURIComponent(outside)}`);

        assert.notEqual(read.status, 200);
        assert.ok(!JSON.stringify(read.body).includes("Outside every session folder"));
    });
});

describe("favorite folders", () => {
    it("are kept for a chosen guest", async () => {
        assert.equal(
            (await call(guest, "folder-favorites", { path: work, starred: true })).status,
            200,
        );
        assert.deepEqual((await call(guest, "folder-favorites")).body, [work]);
    });

    it("are refused to someone nobody chose, and kept ones are hidden when a person is no longer chosen", async () => {
        assert.equal(
            (await call(stranger, "folder-favorites", { path: work, starred: true })).status,
            403,
        );
        assert.deepEqual((await call(stranger, "folder-favorites")).body, []);

        await withoutGuest(async () => {
            assert.deepEqual((await call(guest, "folder-favorites")).body, []);
        });

        assert.deepEqual((await call(guest, "folder-favorites")).body, [work]);
    });
});

describe("attachments", () => {
    it("upload into a session the person steers", async () => {
        const response = await fetch(`${address}/api/c/${shared}/upload?name=note.txt`, {
            method: "POST",
            headers: { authorization: `Bearer ${tokens.get(guest.id)}`, "X-Pocket": "1" },
            body: "a note",
        });

        assert.equal(response.status, 200);
    });

    it("are refused on a session not shared, and to a viewer", async () => {
        for (const [user, id, status] of [
            [guest, hidden, 404],
            [stranger, shared, 404],
            [viewer, shared, 403],
        ] as const) {
            const response = await fetch(`${address}/api/c/${id}/upload?name=note.txt`, {
                method: "POST",
                headers: { authorization: `Bearer ${tokens.get(user.id)}`, "X-Pocket": "1" },
                body: "a note",
            });

            assert.equal(response.status, status, user.name);
        }
    });
});

describe("sharing and invites", () => {
    it("lets a session's starter share it with a chosen person, and invite someone to it", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });

        assert.equal(
            (await call(guest, `sessions/${body.id}/share`, { people: [viewer.id] })).status,
            200,
        );
        assert.ok(listed(viewer).includes(String(body.id)));
        assert.equal(
            (await call(guest, "invite", { role: "viewer", session: String(body.id) })).status,
            200,
        );
    });

    it("refuses sharing someone else's session, sharing with someone not chosen, and invites from who may not", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });

        assert.equal(
            (await call(guest, `sessions/${shared}/share`, { people: [guest.id] })).status,
            403,
        );
        assert.equal(
            (await call(guest, `sessions/${body.id}/share`, { people: [stranger.id] })).status,
            400,
        );
        assert.equal((await call(stranger, "invite", { role: "guest" })).status, 403);
        assert.equal(
            (await call(guest, "invite", { role: "guest", session: String(shared) })).status,
            403,
        );
        assert.equal((await call(viewer, "invite", { role: "viewer" })).status, 403);
    });

    it("lets who may invite make an invite to a session's folder: whoever joins gets only its maker's sessions there", async () => {
        const here = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const there = await call<{ id: number }>(guest, "sessions", { cwd: elsewhere });

        assert.equal(here.status, 200);
        assert.equal(there.status, 200);

        const made = await call<{ code: string; grant: unknown }>(guest, "invite", {
            session: String(here.body.id),
            folder: true,
        });
        const cwd = app
            .sessions(guest)
            .find((each) => String(each.id) === String(here.body.id))!.cwd;

        assert.equal(made.status, 200);
        // The server names the folder: the session's own, on its computer.
        assert.deepEqual(made.body.grant, {
            role: "viewer",
            folder: { computer: "this-server", path: cwd },
            // What an invite makes unless it allows more.
            temporary: true,
        });
        assert.ok(
            (await (await fetch(`${address}/join/${made.body.code}`)).text()).includes(
                "the sessions shared with you in the folder ",
            ),
            "the join page says it is for a folder",
        );

        const joined = await fetch(`${address}/join/${made.body.code}`, {
            method: "POST",
            body: "name=Folder%20friend",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
        });

        assert.equal(joined.status, 303);

        const friend = app.config.users.find((each) => each.name === "Folder friend")!;

        assert.equal(friend.role, "viewer");
        assert.equal(friend.sessions, undefined, "not limited to one session");
        assert.ok(
            listed(friend).includes(String(here.body.id)),
            "the maker's session in the folder",
        );
        assert.ok(
            !listed(friend).includes(String(there.body.id)),
            "not the maker's session in another folder",
        );
        assert.ok(!listed(friend).includes(String(shared)), "not someone else's session");
        assert.ok(!listed(friend).includes(String(hidden)));
    });

    it("lets who may invite make an invite to sessions they chose and may share; refuses it to who may not, and for a session not theirs to share", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const made = await call<{ code: string; grant: unknown }>(guest, "invite", {
            sessions: [body.id],
        });

        assert.equal(made.status, 200);
        assert.deepEqual(made.body.grant, {
            role: "viewer",
            chosen: [String(body.id)],
            temporary: true,
        });

        const joined = await fetch(`${address}/join/${made.body.code}`, {
            method: "POST",
            body: "name=Chosen%20friend",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
        });

        assert.equal(joined.status, 303);

        const friend = app.config.users.find((each) => each.name === "Chosen friend")!;

        assert.deepEqual(listed(friend), [String(body.id)]);

        // The owner's session is shared with the guest, and not theirs to share: it answers as one they cannot see.
        assert.equal(
            (await call(guest, "invite", { sessions: [body.id, Number(shared)] })).status,
            400,
        );
        assert.equal((await call(guest, "invite", { sessions: [Number(hidden)] })).status, 400);

        // A viewer, someone invited to one session, and someone nobody chose invite nobody to chosen sessions.
        for (const user of [viewer, invited, stranger]) {
            assert.equal(
                (await call(user, "invite", { sessions: [Number(shared)] })).status,
                403,
                user.name,
            );
        }
    });

    it("refuses a folder invite from who may not invite, and for a session they cannot see", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });

        // A viewer and someone invited to one session invite nobody to more than a session they may share.
        assert.equal(
            (await call(viewer, "invite", { session: String(shared), folder: true })).status,
            403,
        );
        assert.equal(
            (await call(invited, "invite", { session: String(shared), folder: true })).status,
            403,
        );
        // Someone not chosen does not see the session, so learns nothing of its folder, also when they may invite.
        app.setRight(owner(app), { person: stranger.id, right: "invites", on: true });

        try {
            assert.equal(
                (await call(stranger, "invite", { session: String(body.id), folder: true })).status,
                400,
            );
        } finally {
            app.setRight(owner(app), { person: stranger.id, right: "invites", on: false });
        }
    });

    it("lets a user invite only while the owner lets them: off, they invite to nothing, and an invite they made stops working", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const kinds = [
            { minutes: 15 },
            { session: String(body.id) },
            { session: String(body.id), folder: true },
        ];
        const join = async (code: string, name: string) =>
            (
                await fetch(`${address}/join/${code}`, {
                    method: "POST",
                    body: `name=${name}`,
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    redirect: "manual",
                })
            ).status;

        // Let: every kind of invite is theirs to make.
        const made: string[] = [];

        for (const each of kinds) {
            const answer = await call<{ code: string }>(guest, "invite", each);

            assert.equal(answer.status, 200, JSON.stringify(each));
            made.push(answer.body.code);
        }

        // Only the owner sets it.
        assert.equal(
            (await call(guest, `users/${guest.id}/rights`, { right: "invites", on: true })).status,
            403,
        );
        assert.equal(
            (await call(viewer, `users/${guest.id}/rights`, { right: "invites", on: false }))
                .status,
            403,
        );
        assert.equal(
            (await call(owner(app), `users/${guest.id}/rights`, { right: "invites", on: "yes" }))
                .status,
            400,
        );
        assert.equal(app.config.userById(guest.id)?.rights?.includes("invites"), true);

        // Keep sessions warm is set the same way, by the owner alone.
        assert.equal(
            (await call(guest, `users/${guest.id}/rights`, { right: "keepsWarm", on: true }))
                .status,
            403,
        );
        assert.equal(
            (await call(viewer, `users/${guest.id}/rights`, { right: "keepsWarm", on: true }))
                .status,
            403,
        );
        assert.equal(
            (await call(owner(app), `users/${guest.id}/rights`, { right: "keepsWarm", on: "yes" }))
                .status,
            400,
        );
        assert.notEqual(app.config.userById(guest.id)?.rights?.includes("keepsWarm"), true);
        assert.equal(
            (await call(owner(app), `users/${guest.id}/rights`, { right: "keepsWarm", on: true }))
                .status,
            200,
        );
        assert.equal(app.config.userById(guest.id)?.rights?.includes("keepsWarm"), true);
        assert.equal(
            (await call(owner(app), `users/${guest.id}/rights`, { right: "keepsWarm", on: false }))
                .status,
            200,
        );
        assert.notEqual(app.config.userById(guest.id)?.rights?.includes("keepsWarm"), true);

        // Off: no kind of invite, and the ones made before bring nobody in.
        assert.equal(
            (await call(owner(app), `users/${guest.id}/rights`, { right: "invites", on: false }))
                .status,
            200,
        );
        assert.notEqual(app.config.userById(guest.id)?.rights?.includes("invites"), true);

        try {
            for (const each of kinds) {
                const answer = await call<{ error?: string }>(guest, "invite", each);

                assert.equal(answer.status, 403, JSON.stringify(each));
                assert.match(
                    JSON.stringify(answer.body),
                    /You do not have the Invite people permission\./,
                );
            }

            for (const [index, code] of made.entries()) {
                assert.equal(
                    await join(code, `Refused${index}`),
                    410,
                    JSON.stringify(kinds[index]),
                );
            }

            assert.ok(!app.config.users.some((each) => each.name.startsWith("Refused")));
            // The owner still invites, to the same session.
            assert.equal(
                (await call(owner(app), "invite", { session: String(body.id) })).status,
                200,
            );
        } finally {
            assert.equal(
                (await call(owner(app), `users/${guest.id}/rights`, { right: "invites", on: true }))
                    .status,
                200,
            );
        }

        // On again: they invite as before, and whoever joins gets in.
        const again = await call<{ code: string }>(guest, "invite", { session: String(body.id) });

        assert.equal(again.status, 200);
        assert.equal(await join(again.body.code, "Intime"), 303);
        assert.ok(app.config.users.some((each) => each.name === "Intime"));
    });

    it("lets a runner's linker invite to what is theirs there, without being chosen for this server; nobody who starts sessions nowhere", async () => {
        const linker = person("Runner Lin", "guest");
        const nowhere = person("Nowhere Ned", "guest");
        const laptop = app.config.addRunner("Lin's laptop", linker.id, newIdentity().publicKey).id;
        const hers = await newSession(app);

        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(hers)]!;

            meta.createdBy = linker.id;
            meta.runner = laptop;
        }, context);
        app.setRight(owner(app), { person: linker.id, right: "invites", on: true });
        app.setRight(owner(app), { person: nowhere.id, right: "invites", on: true });
        app.accessChanged();

        try {
            // Neither was chosen for this server: one is in charge of a runner, the other starts sessions nowhere.
            assert.equal(app.policy.mayUse(linker, THIS_SERVER), false);
            assert.equal(app.policy.mayStart(linker, laptop), true);
            assert.equal((await app.hello(linker)).user.mayInvite, true);
            assert.equal((await app.hello(nowhere)).user.mayInvite, false);

            for (const each of [{}, { session: String(hers), folder: true }]) {
                const refused = await call<{ error?: string }>(nowhere, "invite", each);

                // The session is not theirs to see, so its folder is no session to them.
                assert.equal(refused.status, "session" in each ? 400 : 403, JSON.stringify(each));

                if (!("session" in each)) {
                    assert.equal(
                        refused.body.error,
                        "Only people who may start sessions here can invite others.",
                    );
                }

                assert.equal(
                    (await call(linker, "invite", each)).status,
                    200,
                    JSON.stringify(each),
                );
            }

            // Whoever joins gets what the linker has: the session they started, on the runner they are in charge of.
            const made = await call<{ code: string }>(linker, "invite", {});
            const joined = await fetch(`${address}/join/${made.body.code}`, {
                method: "POST",
                body: "name=Laptop%20Lou",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                redirect: "manual",
            });

            assert.equal(joined.status, 303);

            const lou = app.config.users.find((each) => each.name === "Laptop Lou")!;

            assert.equal(lou.role, "viewer");
            assert.deepEqual(app.sessionMeta(hers)?.sharedWith, [lou.id]);
            assert.equal(app.canSee(lou, hers), true);
            assert.equal(app.policy.mayUse(lou, laptop), true);
            // Not this server, which is not the linker's to give, and nothing of anyone else's.
            assert.equal(app.policy.mayUse(lou, THIS_SERVER), false);
            assert.equal(app.canSee(lou, shared), false);
            assert.deepEqual(listed(lou), [String(hers)]);
        } finally {
            app.setRight(owner(app), { person: linker.id, right: "invites", on: false });
            app.setRight(owner(app), { person: nowhere.id, right: "invites", on: false });
        }
    });

    it("shows a session's starter whom it is shared with, and whom it can be: the people chosen for its computer", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });

        await call(guest, `sessions/${body.id}/share`, { people: [viewer.id] });

        const answer = await call<{
            sharedWith: string[];
            people: { id: string; name: string; role: string }[];
            computer: string;
        }>(guest, `sessions/${body.id}/share`);

        assert.equal(answer.status, 200);
        assert.deepEqual(answer.body.sharedWith, [viewer.id]);
        // Not the owner nor the starter, who have it anyway; not who nobody chose, nor who was invited to one session.
        assert.deepEqual(
            answer.body.people.map((each) => each.id),
            [viewer.id],
        );
        assert.equal(answer.body.computer, "This server");
        assert.equal((await call(owner(app), `sessions/${body.id}/share`)).status, 200);
    });

    it("lets who is in charge take one session from one person: a shared one, and one they started", async () => {
        // Shared with the guest and the viewer: taken from the viewer alone.
        const mine = await newSession(app);

        await app.commands.shareSession(mine, owner(app), [guest.id, viewer.id]);
        assert.ok(listed(viewer).includes(String(mine)));
        assert.equal(
            (await call(owner(app), `sessions/${mine}/revoke`, { person: viewer.id })).status,
            200,
        );
        assert.ok(!listed(viewer).includes(String(mine)), "the viewer no longer sees it");
        assert.ok(listed(guest).includes(String(mine)), "the guest keeps it");
        assert.ok(listed(viewer).includes(String(shared)), "the viewer's other session stays");

        // Started by the guest, who may still use its folder: it moves to the owner, and their other one stays theirs.
        const first = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const second = await call<{ id: number }>(guest, "sessions", { cwd: work });

        assert.equal(
            (await call(owner(app), `sessions/${first.body.id}/revoke`, { person: guest.id }))
                .status,
            200,
        );
        assert.ok(!listed(guest).includes(String(first.body.id)), "the guest no longer sees it");
        assert.ok(listed(owner(app)).includes(String(first.body.id)), "the owner has it");
        assert.equal(
            app.sessionMeta(first.body.id as unknown as ConversationId)?.createdBy,
            owner(app).id,
        );
        assert.ok(listed(guest).includes(String(second.body.id)), "their other session stays");
        assert.equal(app.policy.mayStart(guest, "this-server"), true, "and so does their folder");

        // Invited to it alone: no longer.
        const alone = await newSession(app);
        const one = person("Only", "viewer", [String(alone)]);

        assert.ok(listed(one).includes(String(alone)));
        assert.equal(
            (await call(owner(app), `sessions/${alone}/revoke`, { person: one.id })).status,
            200,
        );
        assert.deepEqual(listed(one), []);
    });

    it("refuses taking a session from someone to who is not in charge, and for who does not have it", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });

        await call(guest, `sessions/${body.id}/share`, { people: [viewer.id] });

        // Its starter shares and stops sharing it, but takes it from no one this way: that is who is in charge's.
        assert.equal(
            (await call(guest, `sessions/${body.id}/revoke`, { person: viewer.id })).status,
            403,
        );
        assert.equal(
            (await call(viewer, `sessions/${body.id}/revoke`, { person: guest.id })).status,
            403,
        );
        // Not seen: not there.
        assert.equal(
            (await call(stranger, `sessions/${body.id}/revoke`, { person: guest.id })).status,
            404,
        );
        assert.ok(listed(viewer).includes(String(body.id)), "nothing changed");

        // The owner: not from someone who does not have it, not from themselves, and not from no one.
        assert.equal(
            (await call(owner(app), `sessions/${body.id}/revoke`, { person: stranger.id })).status,
            404,
        );
        assert.equal(
            (await call(owner(app), `sessions/${body.id}/revoke`, { person: owner(app).id }))
                .status,
            400,
        );
        assert.equal(
            (await call(owner(app), `sessions/${body.id}/revoke`, { person: "nobody" })).status,
            400,
        );
        assert.equal((await call(owner(app), `sessions/${body.id}/revoke`, {})).status, 400);
    });

    it("hides whom a session is shared with from who may not share it", async () => {
        // Seen but not theirs: refused. Not seen: not there.
        assert.equal((await call(viewer, `sessions/${shared}/share`)).status, 403);
        assert.equal((await call(guest, `sessions/${shared}/share`)).status, 403);
        assert.equal((await call(stranger, `sessions/${shared}/share`)).status, 404);
        assert.equal((await call(guest, `sessions/${hidden}/share`)).status, 404);
    });
});

/** What the newest hello a tab got said of starting sessions on this server. */
const startsIn = (tab: ReturnType<typeof fakeTab>) =>
    (tab.last("hello")?.user as { mayStart?: boolean } | undefined)?.mayStart;

describe("starting sessions, as the app is told", () => {
    it("tells a chosen guest they may start sessions, and their open tab learns when the owner stops choosing them", async () => {
        const tab = fakeTab(undefined, guest);

        await app.attach(tab.client);

        try {
            assert.equal(startsIn(tab), true);
            await withoutGuest(() => until(() => startsIn(tab) === false, "a hello that says no"));
        } finally {
            app.detach(tab.client);
        }
    });

    it("tells someone nobody chose, a viewer, and a person invited to one session that they may not", async () => {
        for (const user of [stranger, viewer, invited]) {
            const tab = fakeTab(undefined, user);

            await app.attach(tab.client);

            try {
                assert.equal(startsIn(tab), false, user.name);
            } finally {
                app.detach(tab.client);
            }
        }
    });
});

describe("linked sessions", () => {
    it("start with the rights of the person Pi works for, private to them", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const source = body.id as unknown as ConversationId;
        const { submissionId } = await app.commands.submit(source, guest, {
            text: "start a helper",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        const { session } = await app.linkedSessions.start(
            source,
            { message: "a task" },
            crypto.randomUUID(),
        );

        assert.equal(app.sessionMeta(session)?.createdBy, guest.id);
        assert.ok(listed(guest).includes(String(session)));
        assert.ok(!listed(viewer).includes(String(session)));

        // No longer chosen: Pi working for them starts nothing more.
        await withoutGuest(() =>
            assert.rejects(
                app.linkedSessions.start(source, { message: "another" }, crypto.randomUUID()),
                { status: 404 },
            ),
        );
    });
});

describe("other lists that name sessions or folders", () => {
    /** Each list, and what it says of the session nobody shares: its title, its artifact, or its subagent. */
    const lists = [
        ["artifacts", "hidden-artifact"],
        ["running", "Hidden title"],
        ["running/board", "Hidden title"],
        ["subagents", "hidden-helper"],
    ] as const;
    const names = (body: unknown) =>
        lists.map(([, marker]) => marker).filter((marker) => JSON.stringify(body).includes(marker));
    let scheduled: string;

    // The session nobody shares has something for each list to hide: an artifact, a message that waits for its time,
    // and a subagent.
    before(async () => {
        await app.commands.updateSession(hidden, owner(app), { title: "Hidden title" });
        await createArtifacts({} as PocketHost).tools![0]!.execute(
            { id: "hidden-artifact", title: "Kept from others", content: "<p>kept</p>" } as never,
            {
                conversationId: hidden,
                taskId: 4321,
                callId: "hidden-artifact-call",
                agent: async () => ({ cwd: work }),
                snapshot: app.harness.snapshot.bind(app.harness),
                commit: app.harness.commit.bind(app.harness),
            } as never,
            context,
        );
        scheduled = (
            await app.commands.schedule(hidden, owner(app), {
                when: "in 2h look again",
                zone: "UTC",
            })
        ).id;
        await app.harness.commit(async (tx) => {
            const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });

            (await tx.doc(AgentDoc, id)).cwd = app.cwdOf(hidden);
            (await tx.doc(SubagentsDoc, hidden)).agents["hidden-helper"] = {
                conversationId: id,
                reported: [],
            };
        }, context);
        await until(
            () => app.subagents(owner(app)).some((each) => each.name === "hidden-helper"),
            "the subagent to show on the board",
        );
    });

    after(async () => {
        await app.commands.cancelSchedule(hidden, owner(app), scheduled);
    });

    it("give the owner what the session nobody shares has in each", async () => {
        for (const [path, marker] of lists) {
            const answer = await call(owner(app), path);

            assert.equal(answer.status, 200, path);
            assert.ok(JSON.stringify(answer.body).includes(marker), `${path} names ${marker}`);
        }
    });

    it("give a chosen guest only the sessions they may see: spend, artifacts, the board, and recent folders", async () => {
        const spend = await call<{ sessions: { id: number }[] }>(guest, "spend");

        assert.equal(spend.status, 200);
        assert.ok(spend.body.sessions.some((each) => String(each.id) === String(shared)));
        assert.ok(!spend.body.sessions.some((each) => String(each.id) === String(hidden)));

        for (const [path] of lists) {
            const answer = await call(guest, path);

            assert.equal(answer.status, 200, path);
            assert.deepEqual(names(answer.body), [], path);
        }

        // The folder picker's recent folders are those of sessions the person may see.
        const ownersFolder = join(root, "owners-own-folder");

        mkdirSync(ownersFolder, { recursive: true });
        await newSession(app, ownersFolder);
        const guests = await call<{ recent: string[] }>(guest, "fs");
        const owners = await call<{ recent: string[] }>(owner(app), "fs");

        assert.equal(guests.status, 200);
        assert.ok(owners.body.recent.includes(ownersFolder));
        assert.ok(!guests.body.recent.includes(ownersFolder));
    });

    it("give someone nobody chose nothing, and reserve the search of Pi's sessions for who is in charge", async () => {
        const spend = await call<{ sessions: unknown[] }>(stranger, "spend");

        assert.deepEqual(spend.body.sessions, []);

        for (const [path] of lists) {
            const answer = await call(stranger, path);

            assert.deepEqual(names(answer.body), [], path);
            assert.ok(!JSON.stringify(answer.body).includes(`"id":${Number(shared)}`), path);
        }

        assert.equal((await call(owner(app), "pi-sessions?q=fork")).status, 200);
        assert.equal((await call(guest, "pi-sessions?q=fork")).status, 403);
    });
});

describe("approvals", () => {
    let calls = 0;

    /** A call that waits for an answer in session `id`, as Lancet Guard asks for one. */
    const ask = (id: ConversationId, subject: string) => {
        const request = {
            id: `access-approval-${++calls}`,
            conversationId: id,
            taskId: calls as never,
            callId: `access-call-${calls}`,
            tool: "bash",
            subject,
            reason: "risky",
            createdAt: Date.now(),
        };

        return { request, answered: app.approvals.request(request, context) };
    };

    const waits = (id: ConversationId, approval: string) =>
        app.approvals.forConversation(id).some((each) => each.id === approval);

    it("are answered by a chosen guest who steers the session they belong to", async () => {
        const { request, answered } = ask(shared, "rm -rf build");

        assert.equal((await call(guest, `approvals/${request.id}`, { allow: true })).status, 200);
        assert.deepEqual(await answered, { allow: true, by: "Guest" });
    });

    it("are not there for someone the session is not shared with, and a viewer answers none", async () => {
        const open = ask(shared, "rm -rf dist");

        // Someone nobody chose: as if it did not exist, to allow and to deny alike.
        assert.equal(
            (await call(stranger, `approvals/${open.request.id}`, { allow: true })).status,
            404,
        );
        assert.equal(
            (await call(stranger, `approvals/${open.request.id}`, { allow: false })).status,
            404,
        );
        // A viewer sees the session, and steers nothing in it.
        assert.equal(
            (await call(viewer, `approvals/${open.request.id}`, { allow: true })).status,
            403,
        );
        assert.equal(
            (await call(viewer, `approvals/${open.request.id}`, { allow: false })).status,
            403,
        );
        assert.ok(waits(shared, open.request.id), "it still waits");

        // A chosen guest, on a session that is not shared with them.
        const closed = ask(hidden, "rm -rf cache");

        assert.equal(
            (await call(guest, `approvals/${closed.request.id}`, { allow: true })).status,
            404,
        );
        assert.ok(waits(hidden, closed.request.id), "it still waits");

        for (const each of [open, closed]) {
            assert.equal(
                (await call(owner(app), `approvals/${each.request.id}`, { allow: false })).status,
                200,
            );
            assert.equal((await each.answered).allow, false);
        }
    });
});

describe("seeing every session in a folder", () => {
    const seen = join(root, "seen");
    const deeper = join(seen, "deeper");
    const apart = join(root, "seen-too");
    /** Chosen for this server and given `seen` alone. */
    let fellow: User;
    /** The owner's, shared with nobody: in the folder, in a folder inside it, and beside it. */
    let inside: ConversationId;
    let below: ConversationId;
    let beside: ConversationId;
    let folder: string;

    const sees = (by: User, body: unknown) => call(by, "runners/this-server/sees", body);

    before(async () => {
        for (const each of [seen, deeper, apart]) {
            mkdirSync(each, { recursive: true });
        }

        folder = realpathSync(seen);
        fellow = person("Fellow", "guest");
        app.config.setUsers(THIS_SERVER, [guest.id, viewer.id, fellow.id]);
        app.config.setGivenFolders(THIS_SERVER, fellow.id, [folder]);
        app.config.updateUser(fellow.id, { approvalDays: 0 });
        app.accessChanged();
        inside = await newSession(app, seen);
        below = await newSession(app, deeper);
        beside = await newSession(app, apart);

        for (const each of [inside, below, beside]) {
            approveSession(app, each, fellow);
        }
    });

    after(async () => {
        await app.removeUser(owner(app), fellow.id);
    });

    it("shows a person given the folder its sessions, the ones started later too, and lets them open and prompt them", async () => {
        assert.deepEqual(listed(fellow), [], "nothing of the owner's before the switch");

        const watching = fakeTab(undefined, fellow);

        await app.attach(watching.client);

        try {
            const answer = await sees(owner(app), { person: fellow.id, folder, on: true });

            assert.equal(answer.status, 200);
            assert.deepEqual((answer.body as { sees: Record<string, string[]> }).sees[fellow.id], [
                folder,
            ]);
            assert.deepEqual(
                new Set(listed(fellow)),
                new Set([String(inside), String(below)]),
                "the ones in it and in a folder inside it, not the one beside it",
            );
            assert.deepEqual(
                new Set(
                    (await call<{ id: number }[]>(fellow, "sessions")).body.map((each) =>
                        String(each.id),
                    ),
                ),
                new Set([String(inside), String(below)]),
            );
            await until(() => everListed(watching).has(String(inside)), "the list, sent again");

            // By its id: the view and its history, and a message to Pi.
            assert.equal((await call(fellow, `c/${inside}/history`)).status, 200);
            assert.equal(
                (await call(fellow, `c/${inside}/submit`, { text: "hello", requestId: "f1" }))
                    .status,
                200,
            );
            assert.equal((await call(fellow, `c/${beside}/history`)).status, 404);

            // One the owner starts there later arrives by itself; one started beside it never does.
            const later = await newSession(app, seen);
            const other = await newSession(app, apart);

            await until(() => everListed(watching).has(String(later)), "the new session's arrival");
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.equal(everSent(watching, other), false);
            assert.equal(everSent(watching, beside), false);
        } finally {
            app.detach(watching.client);
        }
    });

    it("is refused to who is not in charge, for a folder not given, and for who starts no sessions here", async () => {
        const on = { person: fellow.id, folder, on: true };

        assert.equal((await sees(guest, on)).status, 403);
        assert.equal((await sees(fellow, on)).status, 403);
        assert.equal((await sees(stranger, on)).status, 403);
        // A folder not given to them, also one inside or above a given one: the list has it as it was given.
        assert.equal((await sees(owner(app), { ...on, folder: realpathSync(apart) })).status, 400);
        assert.equal((await sees(owner(app), { ...on, folder: realpathSync(deeper) })).status, 400);
        assert.equal((await sees(owner(app), { ...on, folder: realpathSync(root) })).status, 400);
        // Someone nobody chose, a viewer, and no such person.
        assert.equal((await sees(owner(app), { ...on, person: stranger.id })).status, 400);
        assert.equal(
            (await sees(owner(app), { person: viewer.id, folder: realpathSync(root), on: true }))
                .status,
            400,
        );
        assert.equal((await sees(owner(app), { ...on, person: "nobody" })).status, 400);
        assert.equal((await sees(owner(app), { person: fellow.id, folder })).status, 400);
        assert.equal((await sees(owner(app), {})).status, 400);
        assert.equal((await call(owner(app), "runners/no-such-computer/sees", on)).status, 404);
        // The viewer was given the whole test folder (above), and still sees nothing by it.
        assert.ok(!listed(viewer).includes(String(inside)));
        assert.ok(!listed(guest).includes(String(inside)), "the switch is one person's");
        assert.ok(!listed(stranger).includes(String(inside)));
    });

    it("takes them out of a session at once: the switch off, the session moved out, the folder taken back", async () => {
        const open = async (id: ConversationId) => {
            const tab = fakeTab(id, fellow);

            await app.attach(tab.client);
            assert.ok(
                tab.events.some((each) => each.event === "view"),
                "they are in",
            );

            return tab;
        };

        const gone = (tab: ReturnType<typeof fakeTab>, id: ConversationId) => {
            assert.equal(tab.last("missing")?.conversationId, Number(id));
            assert.equal(tab.client.conversationId, undefined);
            assert.ok(!listed(fellow).includes(String(id)));
        };

        await sees(owner(app), { person: fellow.id, folder, on: true });

        // The switch off.
        let tab = await open(inside);

        try {
            assert.equal(
                (await sees(owner(app), { person: fellow.id, folder, on: false })).status,
                200,
            );
            gone(tab, inside);
            assert.equal((await call(fellow, `c/${inside}/history`)).status, 404);
            assert.deepEqual(app.config.seenFolders(THIS_SERVER, fellow.id), []);
        } finally {
            app.detach(tab.client);
        }

        // The session moved to a folder beside it.
        await sees(owner(app), { person: fellow.id, folder, on: true });

        const moving = await newSession(app, seen);

        tab = await open(moving);

        try {
            assert.equal(
                (await call(owner(app), `c/${moving}/configure`, { cwd: apart })).status,
                200,
            );
            await until(() => tab.last("missing") !== undefined, "the move takes them out");
            gone(tab, moving);
        } finally {
            app.detach(tab.client);
        }

        // The folder taken back: the switch goes with it, and does not come back with the folder.
        tab = await open(below);

        try {
            assert.equal(
                (
                    await call(owner(app), "runners/this-server/given", {
                        person: fellow.id,
                        folders: [],
                    })
                ).status,
                200,
            );
            gone(tab, below);
            assert.deepEqual(app.config.seenFolders(THIS_SERVER, fellow.id), []);
            await call(owner(app), "runners/this-server/given", {
                person: fellow.id,
                folders: [folder],
            });
            assert.ok(!listed(fellow).includes(String(inside)), "given again, the switch is off");
        } finally {
            app.detach(tab.client);
        }
    });

    it("is taken back with the switch alone, shows in the session's share list, and hands their tasks on", async () => {
        await sees(owner(app), { person: fellow.id, folder, on: true });

        // There is no one session to take: the folder's switch is what gives it.
        const refused = await call<{ error?: string }>(owner(app), `sessions/${inside}/revoke`, {
            person: fellow.id,
        });

        assert.equal(refused.status, 400);
        assert.match(String(refused.body.error), /Turn that off on the folder/);
        assert.ok(listed(fellow).includes(String(inside)));

        // Who shares the session sees that this person has it anyway.
        const sharing = await call<{ people: { id: string; byFolder?: true }[] }>(
            owner(app),
            `sessions/${inside}/share`,
        );

        assert.equal(sharing.body.people.find((each) => each.id === fellow.id)?.byFolder, true);
        assert.equal(sharing.body.people.find((each) => each.id === guest.id)?.byFolder, undefined);
        // They may not share it themselves: it is not theirs.
        assert.equal((await call(fellow, `sessions/${inside}/share`)).status, 403);

        // A webhook they set up on it is theirs while they see it, and its starter's once they do not.
        const hook = await app.hooks.add(fellow, inside, { name: "Builds", instructions: "Look" });

        assert.ok((await app.hooks.list(fellow)).some((each) => each.id === hook.id));
        await sees(owner(app), { person: fellow.id, folder, on: false });
        assert.ok(!(await app.hooks.list(fellow)).some((each) => each.id === hook.id));
        assert.ok((await app.hooks.list(owner(app))).some((each) => each.id === hook.id));

        // Shared with them one at a time, it stays when the switch goes off.
        await sees(owner(app), { person: fellow.id, folder, on: true });
        await app.commands.shareSession(below, owner(app), [fellow.id]);
        await sees(owner(app), { person: fellow.id, folder, on: false });
        assert.deepEqual(listed(fellow), [String(below)]);
        await app.commands.shareSession(below, owner(app), []);
    });
});

describe("a folder's level, for a viewer and a user", () => {
    const levelled = join(root, "levelled");
    const nextTo = join(root, "levelled-too");
    /** A viewer and a user chosen for this server, with nothing given. */
    let vera: User;
    let ulla: User;
    let folder: string;
    /** The owner's: in the folder, and beside it, made before any level was set. */
    let before1: ConversationId;
    let besideIt: ConversationId;

    const level = (by: User, body: unknown) => call(by, "runners/this-server/level", body);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

    before(async () => {
        for (const each of [levelled, nextTo]) {
            mkdirSync(each, { recursive: true });
        }

        folder = realpathSync(levelled);
        vera = person("Level Vera", "viewer");
        ulla = person("Level Ulla", "guest");
        app.config.setUsers(THIS_SERVER, [guest.id, viewer.id, vera.id, ulla.id]);
        app.config.updateUser(ulla.id, { approvalDays: 0 });
        app.accessChanged();
        before1 = await newSession(app, levelled);
        besideIt = await newSession(app, nextTo);
        await pause();
    });

    after(async () => {
        await app.removeUser(owner(app), vera.id);
        await app.removeUser(owner(app), ulla.id);
        app.config.setUsers(THIS_SERVER, [guest.id, viewer.id]);
        app.accessChanged();
    });

    it("shows a viewer at All sessions every session in it, read only, in the list and its live updates; never the one beside it", async () => {
        const watching = fakeTab(undefined, vera);

        await app.attach(watching.client);

        try {
            assert.deepEqual(listed(vera), [], "nothing before");
            const answer = await level(owner(app), { person: vera.id, folder, level: "all" });

            assert.equal(answer.status, 200, JSON.stringify(answer.body));
            assert.deepEqual(app.config.givenFolders(THIS_SERVER, vera.id), [folder]);
            assert.deepEqual(app.config.seenFolders(THIS_SERVER, vera.id), [folder]);
            assert.deepEqual(app.config.seenUntil(THIS_SERVER, vera.id), {});
            assert.deepEqual(app.config.seenFrom(THIS_SERVER, vera.id), {});
            assert.deepEqual(listed(vera), [String(before1)]);
            await until(() => everListed(watching).has(String(before1)), "the list, sent again");

            // By its id: to read, not to prompt.
            assert.equal((await call(vera, `c/${before1}/history`)).status, 200);
            assert.notEqual(
                (await call(vera, `c/${before1}/submit`, { text: "hi", requestId: "v1" })).status,
                200,
            );
            assert.equal(app.policy.maySteer(vera, String(before1)), false);
            assert.equal((await call(vera, `c/${besideIt}/history`)).status, 404);
            // They start nothing, in it or anywhere.
            assert.equal(app.policy.mayStart(vera, THIS_SERVER), false);
            await assert.rejects(app.commands.createSession(vera, { cwd: levelled }));

            // One someone else starts there later arrives; one beside it never does.
            const later = await newSession(app, levelled);
            const apart = await newSession(app, nextTo);

            await until(() => everListed(watching).has(String(later)), "the later session");
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.equal(everSent(watching, apart), false);
            assert.equal(everSent(watching, besideIt), false);
        } finally {
            app.detach(watching.client);
        }
    });

    it("takes it from them at once with No access", async () => {
        await level(owner(app), { person: vera.id, folder, level: "all" });

        const tab = fakeTab(before1, vera);

        await app.attach(tab.client);

        try {
            assert.ok(
                tab.events.some((each) => each.event === "view"),
                "they are in",
            );
            assert.equal(
                (await level(owner(app), { person: vera.id, folder, level: "none" })).status,
                200,
            );
            assert.equal(tab.last("missing")?.conversationId, Number(before1));
            assert.ok(!listed(vera).includes(String(before1)));
            assert.equal((await call(vera, `c/${before1}/history`)).status, 404);
            assert.deepEqual(app.config.givenFolders(THIS_SERVER, vera.id), []);
            assert.deepEqual(app.config.seenFolders(THIS_SERVER, vera.id), []);
            assert.deepEqual(app.config.seenUntil(THIS_SERVER, vera.id), {});
            assert.deepEqual(app.config.seenFrom(THIS_SERVER, vera.id), {});
        } finally {
            app.detach(tab.client);
        }
    });

    it("at Current sessions shows what was made before the change, not what another person makes after it", async () => {
        const watching = fakeTab(undefined, vera);

        await app.attach(watching.client);

        try {
            assert.equal(
                (await level(owner(app), { person: vera.id, folder, level: "past" })).status,
                200,
            );
            assert.ok(listed(vera).includes(String(before1)));
            assert.equal(typeof app.config.seenUntil(THIS_SERVER, vera.id)[folder], "number");
            await pause();

            const after1 = await newSession(app, levelled);

            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.ok(!listed(vera).includes(String(after1)));
            assert.equal(everSent(watching, after1), false);
            assert.equal((await call(vera, `c/${after1}/history`)).status, 404);

            // All sessions: the later one too.
            await level(owner(app), { person: vera.id, folder, level: "all" });
            assert.ok(listed(vera).includes(String(after1)));
            await until(() => everListed(watching).has(String(after1)), "the later one, now");

            // Back to Current sessions: nothing that exists is hidden; what starts after it is.
            await pause();
            await level(owner(app), { person: vera.id, folder, level: "past" });
            assert.ok(listed(vera).includes(String(before1)));
            assert.ok(listed(vera).includes(String(after1)));
            await pause();

            const after2 = await newSession(app, levelled);

            assert.ok(!listed(vera).includes(String(after2)));
        } finally {
            app.detach(watching.client);
            await level(owner(app), { person: vera.id, folder, level: "none" });
        }
    });

    it("at New sessions shows what another person makes after the change, not what was made before it", async () => {
        const watching = fakeTab(undefined, vera);

        await app.attach(watching.client);

        try {
            await pause();
            const answer = await level(owner(app), { person: vera.id, folder, level: "new" });

            assert.equal(answer.status, 200, JSON.stringify(answer.body));
            assert.equal(app.config.folderLevel(THIS_SERVER, vera.id, folder), "new");
            assert.equal(typeof app.config.seenFrom(THIS_SERVER, vera.id)[folder], "number");
            assert.deepEqual(app.config.seenUntil(THIS_SERVER, vera.id), {});
            // The computer's record sent to the page says the time.
            assert.deepEqual(
                (answer.body as { seesFrom?: Record<string, unknown> }).seesFrom?.[vera.id],
                app.config.seenFrom(THIS_SERVER, vera.id),
            );
            assert.deepEqual(app.thisServer(owner(app))?.seesFrom[vera.id], {
                ...app.config.seenFrom(THIS_SERVER, vera.id),
            });

            // Made before: not in the list, not by its id, not in a live update.
            assert.ok(!listed(vera).includes(String(before1)));
            assert.equal((await call(vera, `c/${before1}/history`)).status, 404);
            await pause();

            const after1 = await newSession(app, levelled);

            // Made after: in the list, by its id to read, and in the live updates.
            assert.ok(listed(vera).includes(String(after1)));
            assert.equal((await call(vera, `c/${after1}/history`)).status, 200);
            await until(() => everListed(watching).has(String(after1)), "the later session");
            assert.equal(everSent(watching, before1), false);

            // Set again, it keeps its time: what was made before stays out, what was made after stays in.
            await level(owner(app), { person: vera.id, folder, level: "new" });
            assert.ok(!listed(vera).includes(String(before1)));
            assert.ok(listed(vera).includes(String(after1)));
        } finally {
            app.detach(watching.client);
            await level(owner(app), { person: vera.id, folder, level: "none" });
        }
    });

    it("lets a user at Current sessions start sessions there and keep their own later ones; a viewer is refused Start sessions", async () => {
        assert.equal(
            (await level(owner(app), { person: ulla.id, folder, level: "past" })).status,
            200,
        );
        assert.equal(app.policy.mayUseFolder(ulla, THIS_SERVER, folder), true);
        assert.ok(listed(ulla).includes(String(before1)));
        await pause();

        const own = await app.commands.createSession(now(ulla), { cwd: levelled });
        const theirs = await newSession(app, levelled);

        assert.ok(listed(ulla).includes(String(own.id)), "their own, made later");
        assert.ok(!listed(ulla).includes(String(theirs)), "another's, made later");

        const refused = await level(owner(app), { person: vera.id, folder, level: "start" });

        assert.equal(refused.status, 400);
        assert.match(
            String((refused.body as { error?: string }).error),
            /is a viewer: they start nothing\. Choose Current sessions, New sessions, or All sessions\./,
        );
        await level(owner(app), { person: ulla.id, folder, level: "none" });
    });

    it("tells a person not in charge nothing of whether a folder exists: the same answer for a real and a missing one", async () => {
        // The guest is not in charge here and does not share what they were given.
        const real = await level(guest, { person: vera.id, folder, level: "all" });
        const missing = await level(guest, {
            person: vera.id,
            folder: join(root, "no-such-folder"),
            level: "all",
        });

        assert.deepEqual(
            { status: missing.status, says: JSON.stringify(missing.body).includes("not a folder") },
            { status: real.status, says: false },
            `real: ${real.status} ${JSON.stringify(real.body)}; missing: ${missing.status} ${JSON.stringify(missing.body)}`,
        );
    });

    it("at Current sessions hides a session whose making ended after the change, though it began before", async () => {
        const harness = app.harness;
        const make = harness.createConversation;

        let began = (): void => {};

        const beginning = new Promise<void>((resolve) => {
            began = resolve;
        });

        let release = (): void => {};

        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // A slow start (a worktree being made): the session's record is written only once this returns.
        harness.createConversation = async function (...args: Parameters<typeof make>) {
            began();
            await gate;

            return make.apply(harness, args);
        } as typeof make;

        try {
            const making = newSession(app, levelled);

            await beginning;
            await pause();
            const changed = await level(owner(app), { person: vera.id, folder, level: "past" });

            assert.equal(changed.status, 200, JSON.stringify(changed.body));
            Reflect.deleteProperty(harness, "createConversation");
            release();
            const late = await making;

            assert.ok(
                !listed(vera).includes(String(late)),
                "a session that did not exist when Current sessions was set is shown",
            );
        } finally {
            Reflect.deleteProperty(harness, "createConversation");
            release();
            await level(owner(app), { person: vera.id, folder, level: "none" });
        }
    });

    it("refuses a person not in charge a folder that was not given to them, and keeps a viewer's folder when they are made a user", async () => {
        // The guest has the whole test folder, and does not pass on what they were given.
        const refused = await level(guest, { person: vera.id, folder, level: "all" });

        assert.equal(refused.status, 403);
        assert.deepEqual(app.config.givenFolders(THIS_SERVER, vera.id), []);
        // A viewer gives nothing: they see no list of people, so nobody is a person to them.
        assert.equal((await level(vera, { person: ulla.id, folder, level: "start" })).status, 404);
        assert.deepEqual(app.config.givenFolders(THIS_SERVER, ulla.id), []);
        assert.equal(
            (await level(owner(app), { person: vera.id, folder, level: "most" })).status,
            400,
        );
        assert.equal(
            (
                await level(owner(app), {
                    person: vera.id,
                    folder: nextTo + "-missing",
                    level: "all",
                })
            ).status,
            400,
        );

        // Made a user later, the viewer keeps the folder and its level, and starts there.
        await level(owner(app), { person: vera.id, folder, level: "all" });
        app.config.giveRole(vera.id, "guest");
        app.accessChanged();
        assert.equal(app.config.folderLevel(THIS_SERVER, vera.id, folder), "all");
        assert.equal(app.policy.mayUseFolder(now(vera), THIS_SERVER, folder), true);
        assert.ok(listed(now(vera)).includes(String(before1)));
        app.config.giveRole(vera.id, "viewer");
        app.accessChanged();
    });
});
