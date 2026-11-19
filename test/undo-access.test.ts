// Undo replaces a session with a fork of it and archives the original (`commands.ts` `undo`). It gives nothing new and
// takes nothing away: the replacement stays its starter's, shared with the same people, with the same approval, and
// the people invited to the original alone, or about to be, are invited to it. A real App over HTTP.
import {
    type App,
    answerRequests,
    approveSession,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
/** Chosen for this server, with nothing shared. */
let other: User;

let stopAnswering: () => void = () => {};

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
const meta = (id: ConversationId | number) => app.sessionMeta(String(id) as never);

/** The newest message to Pi in session `id`: the one Undo takes back. */
async function lastPrompt(id: ConversationId): Promise<number> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        64,
        undefined,
        context,
    );

    return Number(page.items.findLast((entry) => entry.kind === "pi.user")!.id);
}

/** The owner's session with one answered message, shared with the guest and the viewer, approved for the guest. */
async function sharedSession(): Promise<ConversationId> {
    const id = await newSession(app);

    await say(app, id, "something to take back");
    await app.commands.shareSession(id, owner(app), [guest.id, viewer.id]);
    approveSession(app, id, guest);

    return id;
}

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    guest = person("Guest", "guest");
    viewer = person("Viewer", "viewer");
    other = person("Other", "guest");
    app.config.setServerUsers([guest.id, viewer.id, other.id]);

    for (const each of [guest, viewer, other]) {
        app.config.setGivenFolders(undefined, each.id, [realpathSync(root)]);
        app.config.updateUser(each.id, { approvalDays: 0 });
    }

    stopAnswering = answerRequests(app, () => true);
    app.accessChanged();
});

after(async () => {
    stopAnswering();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("undoing the last message", () => {
    it("lets a person a session is shared with undo it, and the session stays its starter's and everyone's it was", async () => {
        const id = await sharedSession();
        // Someone invited to this session alone, and an invite to it that nobody used yet.
        const invited = person("Invited", "viewer", [String(id)]);
        const unused = await call<{ code: string }>(owner(app), "invite", {
            role: "viewer",
            session: String(id),
        });

        assert.equal(unused.status, 200);

        const undone = await call<{ id: number; text: string }>(guest, `sessions/${id}/undo`, {
            entryId: await lastPrompt(id),
        });

        assert.equal(undone.status, 200);
        assert.equal(undone.body.text, "something to take back");

        const next = undone.body.id;

        assert.notEqual(next, Number(id));
        assert.equal(meta(id)?.archived, true, "the original is archived");
        // It took the session's place: no new session of the guest's.
        assert.equal(meta(next)?.createdBy, meta(id)?.createdBy, "its starter is the session's");
        assert.notEqual(meta(next)?.createdBy, guest.id);
        assert.deepEqual(meta(next)?.sharedWith, [guest.id, viewer.id]);

        for (const each of [owner(app), guest, viewer, app.config.userById(invited.id)!]) {
            assert.ok(listed(each).includes(String(next)), `${each.name} still has it`);
        }

        assert.ok(!listed(other).includes(String(next)), "and nobody new has it");
        assert.deepEqual(app.config.userById(invited.id)?.sessions, [String(id), String(next)]);
        assert.ok(app.folderApprovals.live(String(next)), "its approval goes with it");

        // Whoever joins with the invite made before lands in the session as it is now.
        const joined = await fetch(`${address}/join/${unused.body.code}`, {
            method: "POST",
            body: "name=Late%20joiner",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
        });

        assert.equal(joined.status, 303);
        assert.deepEqual(app.config.users.find((each) => each.name === "Late joiner")?.sessions, [
            String(next),
        ]);

        // The guest prompts on, with nobody asked again.
        const sent = await call(guest, `c/${next}/submit`, {
            text: "something else",
            requestId: crypto.randomUUID(),
        });

        assert.equal(sent.status, 200);
    });

    it("is refused to a viewer, to someone the session is not shared with, and replaces nothing", async () => {
        const id = await sharedSession();
        const entryId = await lastPrompt(id);
        const before = app.sessions().length;

        assert.equal((await call(viewer, `sessions/${id}/undo`, { entryId })).status, 403);
        assert.equal((await call(other, `sessions/${id}/undo`, { entryId })).status, 404);
        assert.equal(app.sessions().length, before, "no session was made");
        assert.notEqual(meta(id)?.archived, true, "and the session is not archived");
    });

    it("keeps a session the guest started theirs, private as it was", async () => {
        const { body } = await call<{ id: number }>(guest, "sessions", { cwd: work });
        const id = String(body.id) as unknown as ConversationId;

        await call(guest, `c/${id}/configure`, {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });

        const sent = await call<{ submissionId: string }>(guest, `c/${id}/submit`, {
            text: "mine to take back",
            requestId: crypto.randomUUID(),
        });

        assert.equal(sent.status, 200);
        await (await app.harness.submission(sent.body.submissionId as never, context))!.wait(
            context,
        );

        const undone = await call<{ id: number }>(guest, `sessions/${id}/undo`, {
            entryId: await lastPrompt(id),
        });

        assert.equal(undone.status, 200);
        assert.equal(meta(undone.body.id)?.createdBy, guest.id);
        assert.equal(meta(undone.body.id)?.sharedWith, undefined);
        assert.ok(!listed(viewer).includes(String(undone.body.id)));
    });
});
