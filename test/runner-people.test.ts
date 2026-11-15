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
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner } from "../src/runner/runner.ts";
import { ConfigStore, type User } from "../src/server/config.ts";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
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
            users: [guest.id, guest.id, "missing", owner(app).id],
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

    it("judges a folder there by where it really is: a link in a given folder that leads out of it is refused", async () => {
        // Given only `there`; `away` is beside it, outside what was given.
        const away = join(root, "away-from-there");

        mkdirSync(away, { recursive: true });
        symlinkSync(join(there, "inner"), join(there, "in-link"));
        symlinkSync(away, join(there, "out-link"));
        app.config.setGivenFolders(runnerId, guest.id, [there]);
        // Who is in charge allows the folder asked for; a refused one is never asked.
        const asked: { folder: string }[] = [];
        const stop = answerRequests(app, () => true, asked as never);

        try {
            // A link that stays inside: the session works in the real folder, and that is the folder asked about.
            const inside = await request<{ id: ConversationId }>(guest, "sessions", {
                runner: runnerId,
                cwd: join(there, "in-link"),
            });

            assert.equal(inside.status, 200);
            assert.equal(app.cwdOf(inside.body.id), join(there, "inner"));
            assert.deepEqual(
                asked.map((each) => each.folder),
                [join(there, "inner")],
            );

            // A link that leads out: refused, as the folder it leads to is.
            const outsideStart = await request<{ error: string }>(guest, "sessions", {
                runner: runnerId,
                cwd: join(there, "out-link"),
            });

            assert.equal(outsideStart.status, 403);
            assert.match(outsideStart.body.error, /not given you this folder/);
            assert.equal(
                (await request(guest, "sessions", { runner: runnerId, cwd: away })).status,
                403,
            );

            // The picker lists inside the link that stays in, and only the given folders for the one that leads out.
            const listed = await request<{ path: string; dirs: unknown[] }>(
                guest,
                `runners/${runnerId}/fs?path=${encodeURIComponent(join(there, "out-link"))}`,
            );

            assert.equal(listed.status, 200);
            assert.equal(listed.body.path, "");
            assert.deepEqual(listed.body.dirs, [{ name: there, path: there }]);
            assert.equal(
                (
                    await request<{ path: string }>(
                        guest,
                        `runners/${runnerId}/fs?path=${encodeURIComponent(join(there, "in-link"))}`,
                    )
                ).body.path,
                join(there, "inner"),
            );
            assert.equal(asked.length, 1, "a folder that is not given is refused without asking");
        } finally {
            stop();
            app.config.setGivenFolders(runnerId, guest.id, [root]);
        }
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

    it("lets a guest read outside the session folder in the folders given to them, but not someone invited to it", async () => {
        // The guest was given the test folder there, above the session's folder. Invited to this one session: they steer
        // it, but are given no folder there, so they read only its folder.
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
            (error: unknown) =>
                error instanceof HttpError &&
                error.status === 403 &&
                /can no longer use/.test(error.message),
        );
        linkAuthenticator(app, guest);
        app.setAccess(owner(app), guest.id, { role: "guest" });
        assert.equal(app.policy.mayStart(guest, runnerId), true);
    });

    it("hands a session to who is in charge when its starter's grant is withdrawn, and it keeps running", async () => {
        const stop = answerRequests(app, () => true);
        const { id: theirs } = await app.commands
            .createSession(guest, { runner: runnerId, cwd: there })
            .finally(stop);
        const shell = async () => app.envFor(theirs).exec("echo still-here", {}, context);

        assert.ok((await shell()).ok, "runs while granted");
        await request(owner(app), `runners/${runnerId}/users`, { users: [] });
        // Now the linker's (`app.ts` `handOver`): it runs on, and the guest no longer reaches it.
        assert.equal(app.sessionMeta(theirs)?.createdBy, owner(app).id);
        assert.ok((await shell()).ok, "runs on for who is in charge");
        assert.equal(
            (await request(guest, `c/${theirs}/shell`, { command: "echo no" })).status,
            404,
        );
        await request(owner(app), `runners/${runnerId}/users`, { users: [guest.id] });
    });

    it("reads only the folder of another person's session shared with them, not Pi's whole access", async () => {
        const ownerSession = await app.commands.createSession(owner(app), {
            runner: runnerId,
            cwd: there,
        });

        const stop = answerRequests(app, () => true);
        const { id: own } = await app.commands
            .createSession(guest, { runner: runnerId, cwd: there })
            .finally(stop);

        await app.commands.shareSession(ownerSession.id, owner(app), [guest.id]);
        // Given only `there`: a file above it is not theirs to read, in another's session nor their own, though Pi
        // there can read it. In the folder given, they read in both.
        app.config.setGivenFolders(runnerId, guest.id, [there]);

        try {
            for (const session of [ownerSession.id, own]) {
                await assert.rejects(
                    app.workspace.remoteFile(guest, session, outside),
                    (error: unknown) => error instanceof HttpError && error.status === 404,
                );
                assert.equal(
                    (await app.workspace.remoteFile(guest, session, join(there, "inside.txt")))
                        .file,
                    join(there, "inside.txt"),
                );
            }

            // Who is in charge of the computer reads what Pi can.
            assert.equal((await app.workspace.remoteFile(owner(app), own, outside)).file, outside);
        } finally {
            app.config.setGivenFolders(runnerId, guest.id, [root]);
        }
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
    it("keeps the server up when a computer is removed while its session is open, and still archives it", async () => {
        const linked = linkInProcess(
            (each) => app.runners.redeem(each),
            app.runners.makeCode("Spare", owner(app).id).code,
        );
        const spare = new Runner({
            link: { server: address, ...linked },
            version: "test",
            cwd: there,
            log: () => {},
            retryMs: [50, 100],
        });
        const thrown: unknown[] = [];
        const record = (error: unknown) => thrown.push(error);

        process.on("uncaughtException", record);
        spare.start();
        spare.finished.catch(() => {});

        try {
            await until(() => app.runners.link(linked.id).online, "the spare computer online");

            const { id: spareSession } = await app.commands.createSession(owner(app), {
                cwd: there,
                runner: linked.id,
            });
            const open = fakeTab(spareSession, owner(app));

            await app.attach(open.client);
            await until(() => open.events.some((event) => event.event === "view"), "the view");
            app.runners.remove(linked.id);
            // The view is pushed again on a timer (\`room.ts\`): give it time to run.
            await new Promise((resolve) => setTimeout(resolve, 500));
            await app.commands.updateSession(spareSession, owner(app), { archived: true });
            assert.deepEqual(thrown, []);
            await assert.rejects(
                Promise.resolve().then(() => app.runnerScope(spareSession)),
                (error: unknown) =>
                    error instanceof HttpError &&
                    error.status === 403 &&
                    /was removed/.test(error.message),
            );
        } finally {
            process.off("uncaughtException", record);
            // It ended itself when the server removed it: stopping it again says so.
            await spare.stop().catch(() => {});
        }
    });
});

describe("review drill fixes for people on a computer", () => {
    // Earlier tests removed the guest: a fresh one, with no grant.
    const visitor = () => app.config.users.find((user) => user.name === "Visitor")!;

    before(() => {
        person("Visitor", "guest");
    });

    it("keeps a private session's subagents off another person's board", async () => {
        const { id: hidden } = await app.commands.createSession(owner(app), {
            runner: runnerId,
            cwd: there,
        });

        // A subagent record, as the subagent tool writes it: the board reads it from the session.
        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(SubagentsDoc, hidden);

            doc.agents.secret = {
                conversationId: 999_001 as unknown as ConversationId,
                reported: [],
                asked: "the private task text",
                askedAt: Date.now(),
            };
        }, context);
        await until(
            () => app.subagents(owner(app)).some((entry) => entry.id === Number(hidden)),
            "the owner's board",
        );

        // Private, as every session starts: not shared with the visitor.
        assert.equal(app.canSee(visitor(), hidden), false);
        assert.equal(
            app.subagents(visitor()).some((entry) => entry.id === Number(hidden)),
            false,
            "another person's board",
        );

        const board = await request<{ id: number }[]>(visitor(), "subagents");

        assert.equal(board.status, 200);
        assert.equal(
            board.body.some((entry) => entry.id === Number(hidden)),
            false,
            "GET /api/subagents",
        );
    });

    it("tells what a computer is only to the people who may use it, not to an owner who only lists it", async () => {
        const lina = person("Lina", "guest");
        const cho = person("Cho", "guest");
        const linas = app.config.addRunner("Lina's laptop", lina.id, newIdentity().publicKey).id;

        // As its runner reported when it connected.
        app.config.updateRunner(linas, {
            platform: {
                os: "linux",
                arch: "arm64",
                home: "/home/lina",
                version: "9.9.9",
                tmpdir: "/tmp/lina",
            },
            tools: { git: true, gh: true, github: true },
        });
        app.config.setRunnerUsers(linas, [cho.id]);

        try {
            const seenBy = async (user: User) =>
                (await request<RunnerView[]>(user, "runners")).body.find(
                    (each) => each.id === linas,
                );

            // Who is in charge of it, and someone chosen for it: all of it.
            for (const user of [lina, cho]) {
                const view = await seenBy(user);

                assert.equal(view?.os, "linux", user.name);
                assert.equal(view?.home, "/home/lina", user.name);
                assert.equal(view?.version, "9.9.9", user.name);
                assert.deepEqual(view?.tools, { git: true, gh: true, github: true }, user.name);
            }

            // The owner, not chosen there: that it is there, whose it is, and whether it is on. Nothing of what it is.
            const owners = await seenBy(owner(app));

            assert.equal(owners?.name, "Lina's laptop");
            assert.equal(owners?.createdBy, lina.id);
            assert.equal(owners?.mayStart, false);

            for (const key of ["os", "arch", "home", "version", "tmpdir", "tools"] as const) {
                assert.equal(
                    (owners as unknown as Record<string, unknown>)[key],
                    undefined,
                    `the owner's list has no ${key}`,
                );
            }

            // Nor its people, their folders, or its settings: those are its linker's, to see and to change.
            for (const key of ["users", "given", "network", "downloads", "fingerprint"] as const) {
                assert.equal(owners?.[key], undefined, `the owner's list has no ${key}`);
            }

            assert.deepEqual(
                (await seenBy(lina))?.users?.map((each) => each.id),
                [cho.id],
            );

            // The owner changes nothing there: not who may use it, not one person, not a folder, not a setting.
            for (const [path, body] of [
                ["users", { users: [owner(app).id] }],
                ["users", { person: owner(app).id, on: true }],
                ["users", { person: cho.id, on: false }],
                ["given", { person: cho.id, folders: ["/home/lina"] }],
                ["settings", { shareNew: true }],
                ["settings", { network: false }],
            ] as const) {
                const refused = await request<{ error: string }>(
                    owner(app),
                    `runners/${linas}/${path}`,
                    body,
                );

                assert.equal(refused.status, 403, `${path} ${JSON.stringify(body)}`);
                assert.match(refused.body.error, /Only the person who linked this computer/);
            }

            assert.deepEqual(
                app.runners.stored(linas)?.users,
                [cho.id],
                "its people are as they were",
            );
            assert.deepEqual([...app.config.givenFolders(linas, cho.id)], []);
            assert.equal(app.runners.stored(linas)?.shareNew, undefined);
            assert.equal(app.policy.mayUse(owner(app), linas), false);

            // The same list goes out when a tab opens.
            assert.ok(JSON.stringify(await app.hello(lina)).includes("/home/lina"));
            assert.ok(!JSON.stringify(await app.hello(owner(app))).includes("/home/lina"));
            // Someone nobody chose there does not get it at all.
            assert.equal(await seenBy(visitor()), undefined);
        } finally {
            app.config.removeRunner(linas);
        }
    });

    it("never lets another person download the computer's runner link or Pi's sign-ins", async () => {
        const home = join(there, "home");

        mkdirSync(join(home, ".pi-pocket"), { recursive: true });
        mkdirSync(join(home, ".pi", "agent"), { recursive: true });
        writeFileSync(join(home, ".pi-pocket", "runner.json"), '{"key":"FAKE_KEY"}');
        writeFileSync(join(home, ".pi", "agent", "auth.json"), '{"token":"FAKE"}');
        writeFileSync(join(home, "notes.txt"), "Shared notes.\n");

        const { id: shared } = await app.commands.createSession(owner(app), {
            runner: runnerId,
            cwd: home,
        });

        app.config.setRunnerUsers(runnerId, [
            ...(app.runners.stored(runnerId)?.users ?? []),
            visitor().id,
        ]);
        await app.commands.shareSession(shared, owner(app), [visitor().id]);
        // The computer's home is this test's folder: the secrets are where the runner keeps them.
        const link = app.runners.link(runnerId);
        const info = await link.infoNow();
        const original = info.home;

        info.home = home;

        try {
            const download = async (path: string) =>
                (
                    await fetch(
                        `${address}/api/c/${shared}/download?path=${encodeURIComponent(path)}`,
                        { headers: { authorization: `Bearer ${tokens.get(visitor().id)}` } },
                    )
                ).status;

            assert.equal(await download("notes.txt"), 200, "a file of the folder");
            assert.equal(await download(".pi-pocket/runner.json"), 404, "the runner link");
            assert.equal(await download(".pi/agent/auth.json"), 404, "Pi's sign-ins");
            assert.equal(await download(".PI-POCKET/runner.json"), 404, "in another case");
        } finally {
            info.home = original;
        }
    });

    it("lets a guest in charge of their computer choose the owner, as anyone else, and share a session there with them", async () => {
        const host = person("Runner host", "guest");
        const theirs = app.config.addRunner("Host's laptop", host.id, newIdentity().publicKey).id;
        const scoped = person("Host's one session", "guest", [String(id)]);
        const { id: hers } = await app.commands.createSession(owner(app), { cwd: root });

        // A session on the host's computer, the host's own.
        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(hers)]!;

            meta.runner = theirs;
            meta.createdBy = host.id;
        }, context);
        assert.equal(app.policy.mayUse(owner(app), theirs), false, "nothing there for the owner");
        assert.equal(app.canSee(owner(app), hers), false);

        // Chosen as anyone is. Never who is in charge (they have it anyway), nor someone invited to one session.
        const chosen = await request<RunnerView>(host, `runners/${theirs}/users`, {
            users: [owner(app).id, host.id, scoped.id],
        });

        assert.equal(chosen.status, 200);
        assert.deepEqual(
            chosen.body.users?.map((each) => each.id),
            [owner(app).id],
        );
        assert.equal(app.policy.mayUse(owner(app), theirs), true);
        assert.equal(app.policy.inCharge(owner(app), theirs), false, "still the host's");
        assert.equal(app.canSee(owner(app), hers), false, "a private session stays private");

        // The host shares a session there with the owner, who is listed as anyone chosen.
        const sharing = await request<{ people: { id: string }[] }>(host, `sessions/${hers}/share`);

        assert.deepEqual(
            sharing.body.people.map((each) => each.id),
            [owner(app).id],
        );
        assert.equal(
            (await request(host, `sessions/${hers}/share`, { people: [owner(app).id] })).status,
            200,
        );
        assert.deepEqual(app.sessionMeta(hers)?.sharedWith, [owner(app).id]);
        assert.equal(app.canSee(owner(app), hers), true);

        // On this server the owner is in charge, so they are never among its chosen people.
        const here = [...(app.config.server.users ?? [])];

        app.config.setServerUsers([...here, owner(app).id]);
        assert.deepEqual(app.config.server.users ?? [], here);
    });

    it("offers Share to who may share a session, and keeps listing someone it is shared with who is not chosen there", async () => {
        const host = person("Share host", "guest");
        const theirs = app.config.addRunner(
            "Share host's laptop",
            host.id,
            newIdentity().publicKey,
        ).id;
        const worker = person("Share worker", "guest");
        const invited = person("Share invitee", "viewer");
        const { id: session } = await app.commands.createSession(owner(app), { cwd: root });

        // The worker's session on the host's computer. The owner is chosen there; the invitee came with an invite, and is
        // chosen for nothing.
        app.config.setRunnerUsers(theirs, [worker.id, owner(app).id]);
        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(session)]!;

            meta.runner = theirs;
            meta.createdBy = worker.id;
            meta.sharedWith = [owner(app).id, invited.id];
        }, context);

        const row = (user: User) =>
            app.sessions(user).find((each) => each.id === Number(session)) as
                { mayShare?: true } | undefined;

        // Who is in charge of its computer, and its starter: Share. The owner only sees it there: no Share, and 403.
        assert.equal(row(host)?.mayShare, true, "in charge of its computer");
        assert.equal(row(worker)?.mayShare, true, "its starter");
        assert.notEqual(row(owner(app)), undefined, "shared with the owner");
        assert.equal(row(owner(app))?.mayShare, undefined, "the owner is not in charge there");
        assert.equal((await request(owner(app), `sessions/${session}/share`)).status, 403);
        assert.equal(row(invited)?.mayShare, undefined);

        // Everyone it is shared with is listed, also who is not chosen there: they can be seen and taken off.
        type Sharing = { sharedWith: string[]; people: { id: string; notChosen?: true }[] };
        const sharing = await request<Sharing>(host, `sessions/${session}/share`);

        assert.deepEqual(
            sharing.body.people.map((each) => [each.id, each.notChosen === true]),
            [
                [owner(app).id, false],
                [invited.id, true],
            ],
        );
        assert.deepEqual(sharing.body.sharedWith, [owner(app).id, invited.id]);

        // Saved as it is: they stay. Someone new who is not chosen there is still refused.
        assert.equal(
            (await request(host, `sessions/${session}/share`, { people: sharing.body.sharedWith }))
                .status,
            200,
        );
        assert.equal(app.canSee(invited, session), true);
        assert.equal(
            (
                await request(host, `sessions/${session}/share`, {
                    people: [...sharing.body.sharedWith, stranger.id],
                })
            ).status,
            400,
        );

        // Taken off, they leave, and do not come back without being chosen.
        await request(host, `sessions/${session}/share`, { people: [owner(app).id] });
        assert.equal(app.canSee(invited, session), false);
        assert.equal(
            (await request(host, `sessions/${session}/share`, { people: [invited.id] })).status,
            400,
        );
        assert.deepEqual(
            (await request<Sharing>(host, `sessions/${session}/share`)).body.people.map(
                (each) => each.id,
            ),
            [owner(app).id],
        );
    });

    it("links nothing with a code whose maker may no longer link computers, or was removed", async () => {
        const linker = person("Linker", "guest");
        const named = (name: string) => app.config.runners.filter((each) => each.name === name);
        const code = async (name: string) =>
            (await request<{ code: string }>(linker, "runners/code", { name })).body.code;
        const link = (with_: string) => linkInProcess((each) => app.runners.redeem(each), with_);

        app.setLinksRunners(owner(app), linker.id, true);

        // Allowed: their code links a computer of their own.
        const first = link(await code("Linker's laptop"));

        assert.equal(app.config.runnerById(first.id)?.createdBy, linker.id);

        // The owner takes the right back while a code waits: it links nothing.
        const waiting = await code("Linker's desktop");

        app.setLinksRunners(owner(app), linker.id, false);
        assert.throws(() => link(waiting), /wrong, already used, or expired/);
        assert.deepEqual(named("Linker's desktop"), []);
        // Used up: giving the right back does not bring the code back.
        app.setLinksRunners(owner(app), linker.id, true);
        assert.throws(() => link(waiting), /wrong, already used, or expired/);

        // A code to link their computer again is worth no more.
        const again = (
            await request<{ code: string }>(linker, "runners/code", { runner: first.id })
        ).body.code;
        const key = app.config.runnerById(first.id)?.publicKey;

        app.setLinksRunners(owner(app), linker.id, false);
        assert.throws(() => link(again), /wrong, already used, or expired/);
        assert.equal(app.config.runnerById(first.id)?.publicKey, key, "its key stays");

        // Removed while a code waits: no computer of nobody appears.
        app.setLinksRunners(owner(app), linker.id, true);
        const last = await code("Linker's phone");

        await app.removeUser(owner(app), linker.id);
        assert.throws(() => link(last), /wrong, already used, or expired/);
        assert.deepEqual(named("Linker's phone"), []);
    });
});
