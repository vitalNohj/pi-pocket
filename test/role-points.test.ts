// The checks that used to compare a person's role, and now ask the access policy a question named for what the check
// is for (`access.ts` `isOwner`, `prompts`, `reachesMachine`, ...; `roles.ts`): for each, someone it lets through, and
// someone it refuses. A real App over HTTP. The questions themselves are tested in `access.test.ts`, and the line
// that keeps a new compare out in `role-boundary.test.ts`. The other moved checks keep the tests they had: photos
// (`avatars.test.ts`), pins (`pinned-sessions.test.ts`), the wallpaper (`app.test.ts`), the servers on this machine
// (`browser.test.ts`), Pi's own folder (`readable-file.test.ts`), PiP (`pip.test.ts`), spend limits (`spend.test.ts`).
import {
    type App,
    answerRequests,
    approveSession,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import type { ApprovalRequest } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let guest: User;
let viewer: User;
/** On this server, chosen by nobody, in no session with the viewer. */
let stranger: User;
/** The owner's, shared with `guest` and `viewer`. */
let shared: ConversationId;

let stopAnswering: () => void = () => {};

function person(name: string, role: User["role"]): User {
    const { user, token } = app.config.addUser(name, role);

    tokens.set(user.id, token);

    return user;
}

async function call(
    user: User,
    path: string,
    body?: unknown,
): Promise<{ status: number; error?: string }> {
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
    const answer = (await response.json().catch(() => ({}))) as { error?: string };

    return { status: response.status, error: answer.error };
}

/** Where `user` is shown typing in `shared`, to a tab of theirs that is there. */
async function typing(user: User): Promise<string | undefined> {
    const room = await app.room(shared);

    return room.presence().people.find((each) => each.id === user.id)?.typing;
}

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    shared = await newSession(app);
    guest = person("Guest", "guest");
    viewer = person("Viewer", "viewer");
    stranger = person("Stranger", "guest");
    app.config.setUsers(THIS_SERVER, [guest.id, viewer.id]);

    for (const each of [guest, viewer]) {
        app.config.setGivenFolders(THIS_SERVER, each.id, [realpathSync(root)]);
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

describe("who reaches this machine itself", () => {
    it("lets the owner ask for a file manager, and refuses a user who sees the session", async () => {
        // No path: the owner is past the check, and nothing opens on the machine that runs this test.
        const mine = await call(owner(app), `c/${shared}/reveal`, {});

        assert.deepEqual([mine.status, mine.error], [400, "path is required"]);

        const theirs = await call(guest, `c/${shared}/reveal`, { path: work });

        assert.deepEqual(
            [theirs.status, theirs.error],
            [403, "Only the owner opens a file manager"],
        );
    });

    it("sends a notice about what only the owner changes to the owner's tabs alone", async () => {
        const mine = fakeTab(shared, owner(app));
        const theirs = fakeTab(shared, guest);

        await app.attach(mine.client);
        await app.attach(theirs.client);

        try {
            app.ownerNotice("warning", "only for the owner");

            const told = (tab: typeof mine) =>
                tab.events.some(
                    (each) => each.event === "notice" && each.data.message === "only for the owner",
                );

            assert.equal(told(mine), true);
            assert.equal(told(theirs), false);
        } finally {
            app.detach(mine.client);
            app.detach(theirs.client);
        }
    });

    it("lets an owner-only extension route start an app-wide session for the owner, not for a user it is open to", async () => {
        // Session cleanup's owner parts are open to who manages runners (`access.ts` `mayUseExtension`): they use the
        // route, and still start no app-wide session through it.
        const manager = person("Manager", "guest");

        app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: true });

        const mine = new ExtensionRequest(
            app,
            owner(app).id,
            "owner",
            undefined,
            "session-cleanup",
        );
        const theirs = new ExtensionRequest(app, manager.id, "owner", undefined, "session-cleanup");

        assert.equal(theirs.current().id, manager.id, "the route is open to them");

        try {
            assert.equal(typeof (await mine.createSession({ cwd: work })).id, "number");
            await assert.rejects(theirs.createSession({ cwd: work }), {
                status: 403,
                message: "Only the owner can start an app-wide session here.",
            });
        } finally {
            mine.close();
            theirs.close();
        }
    });
});

describe("who prompts", () => {
    it("lets a user past the check with no session, and refuses a viewer who sees the session", async () => {
        // `hidden` is missing: the user is past both checks, and the next one answers.
        await assert.rejects(app.commands.hideSubagent(shared, guest, undefined, undefined), {
            status: 400,
            message: "hidden must be true or false",
        });
        await assert.rejects(app.commands.hideSubagent(shared, viewer, true, 1), {
            status: 403,
            message: "Viewers cannot prompt. Ask to be made a user.",
        });
    });

    it("lets who is in charge allow a held call, and tells a viewer they only view", () => {
        const request: ApprovalRequest = {
            id: "a1",
            conversationId: shared,
            taskId: 1 as unknown as ApprovalRequest["taskId"],
            tool: "bash",
            subject: "ls",
            reason: "test",
            createdAt: app.now(),
        };

        assert.equal(app.cannotAllow(owner(app), request), undefined);
        assert.equal(app.cannotAllow(viewer, request), "You can view this session but not prompt.");
    });

    it("shows a user typing to Pi, and a viewer only typing in the chat", async () => {
        const theirs = fakeTab(shared, guest);
        const reads = fakeTab(shared, viewer);

        await app.attach(theirs.client);
        await app.attach(reads.client);

        try {
            app.collab.setTyping(shared, guest, "pi");
            app.collab.setTyping(shared, viewer, "pi");
            assert.equal(await typing(guest), "pi");
            assert.equal(await typing(viewer), undefined);

            app.collab.setTyping(shared, viewer, "chat");
            assert.equal(await typing(viewer), "chat");
        } finally {
            app.collab.setTyping(shared, guest, null);
            app.collab.setTyping(shared, viewer, null);
            app.detach(theirs.client);
            app.detach(reads.client);
        }
    });

    it("hands the wheel to a user who steers the session, never to a viewer", async () => {
        await app.collab.turns(shared, owner(app), { action: "on" });

        try {
            await assert.rejects(
                app.collab.turns(shared, owner(app), { action: "handover", to: viewer.id }),
                { status: 400, message: "They cannot drive this session" },
            );
            await app.collab.turns(shared, owner(app), { action: "handover", to: guest.id });
        } finally {
            await app.collab.turns(shared, owner(app), { action: "off" });
        }
    });

    it("gives a folder, a level to start in it, and a permission on a computer to a user, never to a viewer", async () => {
        // The folder exactly as it was given to the guest: what they may pass on (`access.ts` `mayGiveFolder`).
        const folder = realpathSync(root);
        const other = person("Other", "guest");

        app.config.setUsers(THIS_SERVER, [guest.id, viewer.id, other.id]);
        app.accessChanged();
        // The guest shares what they were given here: the words for a viewer are theirs to hear.
        app.setRight(owner(app), {
            person: guest.id,
            right: "reshares",
            on: true,
            computer: THIS_SERVER,
        });

        try {
            await app.giveFolder(guest, THIS_SERVER, other.id, folder, true);
            await assert.rejects(app.giveFolder(guest, THIS_SERVER, viewer.id, folder, true), {
                status: 400,
                message: "Viewer is a viewer, and folders are given to users only.",
            });
        } finally {
            app.setRight(owner(app), {
                person: guest.id,
                right: "reshares",
                on: false,
                computer: THIS_SERVER,
            });
        }

        await app.setFolderLevel(owner(app), THIS_SERVER, guest.id, folder, "start");
        await assert.rejects(
            app.setFolderLevel(owner(app), THIS_SERVER, viewer.id, folder, "start"),
            {
                status: 400,
                message:
                    "Viewer is a viewer: they start nothing. Choose Sessions so far or All sessions.",
            },
        );

        app.setRight(owner(app), {
            person: guest.id,
            right: "wheel",
            on: true,
            computer: THIS_SERVER,
        });
        assert.throws(
            () =>
                app.setRight(owner(app), {
                    person: viewer.id,
                    right: "wheel",
                    on: true,
                    computer: THIS_SERVER,
                }),
            { status: 400, message: "A viewer cannot prompt: make them a user first." },
        );
    });

    it("answers from the current record: a stale copy of a user made a viewer types to Pi no longer", async () => {
        const made = person("Was a user", "guest");
        const stale = { ...made };

        app.config.setUsers(THIS_SERVER, [...(app.config.server.users ?? []), made.id]);
        app.accessChanged();
        // The whole list: sharing replaces it.
        await app.commands.shareSession(shared, owner(app), [guest.id, viewer.id, made.id]);

        const tab = fakeTab(shared, made);

        await app.attach(tab.client);

        try {
            app.collab.setTyping(shared, stale, "pi");
            assert.equal(await typing(made), "pi");
            app.collab.setTyping(shared, stale, null);

            app.config.updateUser(made.id, { role: "viewer" });
            app.accessChanged();
            assert.equal(stale.role, "guest");
            app.collab.setTyping(shared, stale, "pi");
            assert.equal(await typing(made), undefined);
        } finally {
            app.detach(tab.client);
        }
    });
});

describe("who sees everyone in People", () => {
    it("shows a user everyone, and a viewer only the people they meet", () => {
        const names = (user: User) => app.people(user).map((each) => each.name);

        assert.ok(names(guest).includes(stranger.name));
        assert.ok(names(viewer).includes(guest.name), "they share a session");
        assert.ok(!names(viewer).includes(stranger.name));
    });
});

describe("the owner's record", () => {
    it("is never removed, changed, or made another role; a user's is", async () => {
        const extra = person("Extra", "guest");
        const me = owner(app);

        const removed = await call(me, `users/${me.id}/remove`, {});

        assert.deepEqual([removed.status, removed.error], [400, "The owner cannot be removed"]);

        const changed = await call(me, `users/${me.id}`, { role: "viewer" });

        assert.deepEqual([changed.status, changed.error], [400, "The owner can do everything"]);
        assert.equal(app.config.userById(me.id)?.role, "owner");

        assert.equal((await call(me, `users/${extra.id}`, { role: "viewer" })).status, 200);
        assert.equal(app.config.userById(extra.id)?.role, "viewer");
        assert.equal((await call(me, `users/${extra.id}/remove`, {})).status, 200);
        assert.equal(app.config.userById(extra.id), undefined);
    });

    it("is given to nobody: a person is made a user or a viewer only", async () => {
        const extra = person("Another", "viewer");

        for (const role of ["owner", "admin"]) {
            const answer = await call(owner(app), `users/${extra.id}`, { role });

            assert.deepEqual([answer.status, answer.error], [400, "role must be guest or viewer"]);
        }

        assert.equal(app.config.userById(extra.id)?.role, "viewer");
    });
});
