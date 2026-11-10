// Per-person access to linked computers: a real App, a real WebSocket, and a real runner with its pi-env daemon.
import { linkInProcess, newIdentity } from "../src/runner/secure-link.ts";
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    answerRequests,
    linkAuthenticator,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner } from "../src/runner/runner.ts";
import { ConfigStore, type User } from "../src/server/config.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import type { RunnerView } from "../src/server/runners.ts";

const there = join(root, "there");
// Pi can read a parent context file outside its approved folder. Other outside paths remain runner-restricted.
const outside = join(root, "AGENTS.md");
let app: App;
let server: Server;
let runner: Runner;
let address: string;
let runnerId: string;
let otherRunnerId: string;
let guest: User;
let stranger: User;
let id: ConversationId;
let tab: ReturnType<typeof fakeTab>;
const tokens = new Map<string, string>();

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function request<T = Record<string, unknown>>(
    user: User,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method,
        signal,
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
    mkdirSync(join(there, "inner"), { recursive: true });
    writeFileSync(outside, "A context file above the session folder.\n");
    writeFileSync(join(there, "inside.txt"), "Inside the session.\n");
    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    guest = person("Guest", "guest");
    stranger = person("Other guest", "guest");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { code } = app.runners.makeCode("Laptop", owner(app).id);
    const linked = linkInProcess((request) => app.runners.redeem(request), code);

    runnerId = linked.id;

    otherRunnerId = app.config.addRunner(
        "Another computer",
        owner(app).id,
        newIdentity().publicKey,
    ).id;
    runner = new Runner({
        link: { server: address, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
    });
    runner.start();
    await until(() => app.runners.link(runnerId).online, "the runner to connect");
    // The server's own rules (`access.ts`): the guest may work in the test folders there, and is not asked for a code.
    app.config.setGivenFolders(runnerId, guest.id, [root]);
    app.config.updateUser(guest.id, { approvalDays: 0 });
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("people granted a computer", () => {
    it("refuses an ungranted guest's sessions, list, and folders", async () => {
        for (const response of [
            await request(guest, "sessions", { runner: runnerId, cwd: there }),
            await request(guest, `runners/${runnerId}/fs`),
        ]) {
            assert.equal(response.status, 403);
        }

        // The list of computers holds none for them.
        assert.deepEqual((await request(guest, "runners")).body, []);

        assert.equal(app.policy.mayStart(guest, runnerId), false);
        assert.equal(app.policy.mayStart(owner(app), "missing"), false);
        assert.equal((await app.hello(guest)).runners, undefined);
        tab = fakeTab(undefined, guest);
        await app.attach(tab.client);
        assert.equal(tab.last("hello")?.runners, undefined);
    });

    it("lets the linker and the owner grant people, validates the body, and saves unique existing ids", async () => {
        const otherOwner = person("Another owner", "owner");

        // A guest who did not link it may not choose its people.
        assert.equal(
            (await request(stranger, `runners/${runnerId}/users`, { users: [guest.id] })).status,
            403,
        );

        for (const body of [{}, { users: "guest" }, { users: [7] }, null, []]) {
            assert.equal(
                (await request(owner(app), `runners/${runnerId}/users`, body)).status,
                400,
            );
        }

        const granted = await request<RunnerView>(owner(app), `runners/${runnerId}/users`, {
            users: [guest.id, guest.id, "missing", owner(app).id, otherOwner.id],
        });

        assert.equal(granted.status, 200);
        assert.deepEqual(granted.body.users, [{ id: guest.id, name: guest.name, role: "guest" }]);
        assert.deepEqual(app.config.runnerById(runnerId)?.users, [guest.id]);
        assert.deepEqual(new ConfigStore(app.dataDir).runnerById(runnerId)?.users, [guest.id]);
        assert.equal(app.policy.mayStart(guest, runnerId), true);
        // The owner linked it, so the owner is in charge; another owner record is no one special there.
        assert.equal(app.policy.mayStart(owner(app), runnerId), true);
        assert.equal(app.policy.mayStart(otherOwner, runnerId), false);
        assert.equal(app.policy.mayStart(stranger, runnerId), false);
        assert.deepEqual(
            (tab.last("runners") as unknown as RunnerView[]).map((runner) => runner.id),
            [runnerId],
        );
        assert.equal((tab.last("runners") as unknown as RunnerView[])[0]?.users, undefined);
    });

    it("starts in a folder given to the guest, with nobody asked at the computer", async () => {
        // The owner, in charge of the computer they linked, allows it from the app.
        const stop = answerRequests(app, () => true);
        const created = await request<{ id: ConversationId }>(guest, "sessions", {
            runner: runnerId,
            cwd: there,
        }).finally(stop);

        assert.equal(created.status, 200);
        id = created.body.id;
        assert.equal(app.runnerOf(id), runnerId);
        assert.equal(app.sessionMeta(id)?.createdBy, guest.id);
        assert.equal(app.runnerScope(id).person, guest.name, "the runner is told who started it");
        // Grants do not change session visibility: a session is its starter's, and the owner sees every one.
        assert.equal(app.canSee(guest, id), true);
        assert.equal(app.canSee(stranger, id), false);
        assert.equal(app.canSee(owner(app), id), true);
    });

    it("forks to the same computer and suggests its folder for copies", async () => {
        const { submissionId } = await app.commands.submit(id, guest, {
            text: "Hello from the guest",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        const entries = (await (await app.conversation(id)).entries({}, 10, undefined, context))
            .items;
        const entryId = Number(entries.find((entry) => entry.kind === "pi.assistant")!.id);
        const copy = await request<{ id: ConversationId }>(guest, `c/${id}/fork`, {
            entryId,
            place: { runner: runnerId, cwd: there },
        });

        assert.equal(copy.status, 200);
        assert.equal(app.runnerOf(copy.body.id), runnerId);
        assert.equal(app.sessionMeta(copy.body.id)?.createdBy, guest.id);
        assert.equal((await request(guest, `c/${id}/copy-place?runner=${runnerId}`)).status, 200);
        assert.equal(
            (await request(guest, `c/${id}/copy-place?runner=${otherRunnerId}`)).status,
            403,
        );
    });

    it("browses folders, keeps favorites, and gets only the granted computer in lists and hello", async () => {
        const folders = await request<{ dirs: { name: string }[] }>(
            guest,
            `runners/${runnerId}/fs?path=${encodeURIComponent(there)}`,
        );

        assert.equal(folders.status, 200);
        assert.ok(folders.body.dirs.some((entry) => entry.name === "inner"));
        assert.equal((await request(guest, `runners/${otherRunnerId}/fs`)).status, 403);
        const list = await request<RunnerView[]>(guest, "runners");

        assert.equal(list.status, 200);
        assert.deepEqual(
            list.body.map((runner) => runner.id),
            [runnerId],
        );
        assert.equal(list.body[0]?.users, undefined);
        // The computer's settings and who may use which folders stay the linker's and the owner's.
        assert.equal(list.body[0]?.given, undefined);
        assert.equal(list.body[0]?.network, undefined);
        assert.equal(app.runners.list(owner(app))[0]?.network, true);
        const hello = await app.hello(guest);

        assert.deepEqual(
            hello.runners?.map((runner) => runner.id),
            [runnerId],
        );
        const fresh = fakeTab(undefined, guest);

        await app.attach(fresh.client);
        assert.deepEqual(
            (fresh.last("hello")?.runners as RunnerView[]).map((runner) => runner.id),
            [runnerId],
        );
        app.detach(fresh.client);
        const all = await request<RunnerView[]>(owner(app), "runners");

        assert.equal(all.body.length, 2);
        assert.deepEqual(all.body.find((runner) => runner.id === runnerId)?.users, [
            { id: guest.id, name: guest.name, role: "guest" },
        ]);
        await app.folderFavorites.set(guest, { runner: runnerId, path: there, starred: true });
        assert.deepEqual((await app.folderFavorites.runners(guest))[runnerId], [there]);
    });

    it("does not let a granted guest change settings, folders, access, name, or remove a computer", async () => {
        for (const body of [{ network: false }, { downloads: "/tmp" }, { shareNew: true }]) {
            assert.equal((await request(guest, `runners/${runnerId}/settings`, body)).status, 403);
        }

        assert.equal(
            (
                await request(guest, `runners/${runnerId}/given`, {
                    person: guest.id,
                    folders: ["/"],
                })
            ).status,
            403,
        );

        assert.equal(
            (await request(guest, `runners/${runnerId}/users`, { users: [stranger.id] })).status,
            403,
        );
        assert.equal(
            (await request(guest, `runners/${runnerId}`, undefined, "DELETE")).status,
            403,
        );
        assert.equal((await request(guest, "runners/code", { name: "New name" })).status, 403);
        assert.equal((await request(guest, "runners/locks")).status, 403);
        assert.equal(
            (await request(guest, "runners/bans?address=127.0.0.1", undefined, "DELETE")).status,
            403,
        );
        // The guest started this session, so they may share it, but only with people chosen for its computer. A
        // session someone else started is not theirs to share.
        const response = await request<{ error?: string }>(guest, `sessions/${id}/share`, {
            people: [stranger.id],
        });

        assert.equal(response.status, 400);
        assert.match(String(response.body.error), /choose them for it first/);
        const others = await app.commands.createSession(owner(app), {
            runner: runnerId,
            cwd: there,
        });

        assert.equal(
            (await request(guest, `sessions/${others.id}/share`, { people: [] })).status,
            404,
        );
        assert.equal(app.runners.stored(runnerId)?.name, "Laptop");
    });

    it("lets a guest who may start sessions there read outside the session folder, but not someone invited to it", async () => {
        // Invited to this one session: they steer it, but may not start sessions on its computer, nor read past its
        // folder there.
        app.setAccess(owner(app), stranger.id, { sessions: [String(id)] });
        assert.equal(app.canSee(stranger, id), true);
        const file = await app.workspace.viewFile(id, guest, outside);

        assert.equal(file.kind, "text");
        assert.equal(
            file.kind === "text" && file.text,
            "A context file above the session folder.\n",
        );
        const allowed = await request(guest, `c/${id}/view?path=${encodeURIComponent(outside)}`);

        assert.equal(allowed.status, 200);
        assert.equal(
            (await request(stranger, `c/${id}/view?path=${encodeURIComponent(outside)}`)).status,
            404,
        );
        assert.equal((await request(stranger, `c/${id}/view?path=inside.txt`)).status, 200);
        app.setAccess(owner(app), stranger.id, { sessions: null });
        assert.equal(app.canSee(stranger, id), false);
    });

    it("does not grant people invited to one session, even with an empty session limit", async () => {
        const scoped = person("One session", "guest", [String(id)]);
        const empty = person("No sessions", "guest", []);

        app.config.setRunnerUsers(runnerId, [guest.id, scoped.id, empty.id]);
        assert.deepEqual(app.runners.stored(runnerId)?.users, [guest.id]);
        assert.equal(app.policy.mayStart(scoped, runnerId), false);
        assert.equal(app.policy.mayStart(empty, runnerId), false);
    });

    it("ends access when the guest becomes a viewer, without cleaning the saved grant", async () => {
        app.setAccess(owner(app), guest.id, { role: "viewer" });
        assert.deepEqual(app.runners.stored(runnerId)?.users, [guest.id]);
        assert.equal(
            app.policy.mayStart(guest, runnerId),
            false,
            "even a stale guest object fails",
        );
        // A chosen viewer still sees the computer, and its sessions shared with them, but starts and browses nothing.
        assert.deepEqual(
            (tab.last("runners") as unknown as RunnerView[]).map((each) => each.id),
            [runnerId],
        );
        assert.deepEqual(await app.folderFavorites.runners(guest), {});

        for (const response of [
            await request(guest, "sessions", { runner: runnerId, cwd: there }),
            await request(guest, `runners/${runnerId}/fs`),
        ]) {
            assert.equal(response.status, 403);
        }

        const viewer = app.config.userById(guest.id)!;

        // They still see the computer in their list, as one chosen for it.
        assert.deepEqual(
            (await app.hello(viewer)).runners?.map((each) => each.id),
            [runnerId],
        );
        await assert.rejects(
            app.workspace.remoteFile(viewer, id, outside),
            (error: unknown) => error instanceof HttpError && error.status === 404,
        );
        linkAuthenticator(app, guest);
        app.setAccess(owner(app), guest.id, { role: "guest" });
        assert.equal(app.policy.mayStart(guest, runnerId), true);
    });

    it("ends access when a grant is withdrawn or the person is removed", async () => {
        await request(owner(app), `runners/${runnerId}/users`, { users: [] });
        assert.equal(app.policy.mayStart(guest, runnerId), false);
        assert.deepEqual(tab.last("runners"), []);
        assert.equal((await request(guest, `runners/${runnerId}/fs`)).status, 403);
        await request(owner(app), `runners/${runnerId}/users`, { users: [guest.id] });
        await app.removeUser(owner(app), guest.id);
        assert.equal(app.policy.mayStart(guest, runnerId), false);
        assert.deepEqual(app.runners.stored(runnerId)?.users, [guest.id]);
        assert.equal((await request(guest, "runners")).status, 401);
        await assert.rejects(
            app.commands.createSession(guest, { runner: runnerId, cwd: there }),
            (error: unknown) => error instanceof HttpError && error.status === 403,
        );
    });
});
