// Every place that lists, opens, starts, or names a session or a folder on this server asks the access policy
// (`access.ts`): for each, one person who may gets in, and one who may not is refused. A real App over HTTP, with
// people the owner chose for this server, a person invited to one session, and someone nobody chose.
import {
    type App,
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
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
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
    app.config.setServerUsers([guest.id, viewer.id]);
    // The folders here need no approval: who may start a session is what these tests check, not which folders need one
    // (`folder-requests.test.ts`).
    app.config.saveServerFolder(realpathSync(root));
    app.config.setComputerSettings(undefined, { stopAsking: true });
    app.accessChanged();
    await app.commands.shareSession(shared, owner(app), [guest.id, viewer.id]);
});

after(async () => {
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

        app.config.setServerUsers([viewer.id]);
        app.accessChanged();

        try {
            assert.deepEqual((await call(guest, "folder-favorites")).body, []);
        } finally {
            app.config.setServerUsers([guest.id, viewer.id]);
            app.accessChanged();
        }

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
        app.config.setServerUsers([viewer.id]);
        app.accessChanged();

        try {
            await assert.rejects(
                app.linkedSessions.start(source, { message: "another" }, crypto.randomUUID()),
                { status: 404 },
            );
        } finally {
            app.config.setServerUsers([guest.id, viewer.id]);
            app.accessChanged();
        }
    });
});

describe("other lists that name sessions or folders", () => {
    it("give a chosen guest only the sessions they may see: spend, artifacts, the board, and recent folders", async () => {
        await app.commands.updateSession(hidden, owner(app), { title: "Hidden title" });
        const spend = await call<{ sessions: { id: number }[] }>(guest, "spend");

        assert.equal(spend.status, 200);
        assert.ok(spend.body.sessions.some((each) => String(each.id) === String(shared)));
        assert.ok(!spend.body.sessions.some((each) => String(each.id) === String(hidden)));

        for (const path of ["artifacts", "running", "running/board", "subagents"]) {
            const answer = await call(guest, path);

            assert.equal(answer.status, 200, path);
            assert.ok(!JSON.stringify(answer.body).includes("Hidden title"), path);
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

    it("give someone nobody chose nothing, and keep the search of Pi's sessions the owner's", async () => {
        const spend = await call<{ sessions: unknown[] }>(stranger, "spend");

        assert.deepEqual(spend.body.sessions, []);

        for (const path of ["artifacts", "running", "subagents"]) {
            const answer = await call(stranger, path);

            assert.ok(!JSON.stringify(answer.body).includes("Hidden title"), path);
            assert.ok(!JSON.stringify(answer.body).includes(`"id":${Number(shared)}`), path);
        }

        assert.equal((await call(owner(app), "pi-sessions?q=fork")).status, 200);
        assert.equal((await call(guest, "pi-sessions?q=fork")).status, 403);
    });
});

describe("approvals", () => {
    it("are answered only by who may steer the session they belong to", async () => {
        assert.equal(await app.answerApproval("no-such-approval", true, stranger), false);
        assert.equal(await app.answerApproval("no-such-approval", true, guest), false);
    });
});
