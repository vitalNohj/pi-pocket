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
import type { User } from "../src/server/config.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
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
    app.config.setServerUsers([guest.id, viewer.id]);

    // The folders here are given, and the owner allows every new session at once: who may start a session is what these
    // tests check, not approvals (`folder-requests.test.ts`).
    for (const each of [guest, viewer]) {
        app.config.setGivenFolders(undefined, each.id, [realpathSync(root)]);
        app.config.updateUser(each.id, { approvalDays: 0 });
    }

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
            app.config.setServerUsers([viewer.id]);
            app.accessChanged();
            await until(() => startsIn(tab) === false, "a hello that says no");
        } finally {
            app.config.setServerUsers([guest.id, viewer.id]);
            app.accessChanged();
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

    it("give someone nobody chose nothing, and keep the search of Pi's sessions the owner's", async () => {
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
