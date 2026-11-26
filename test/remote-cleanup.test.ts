// Session cleanup for a session on another computer, with real runners and pi-env daemons: its worktree and its tasks
// are on that computer, so they go there, and only while that computer can be reached and the session's approval is
// live for the owner, so nobody is asked to renew anything. Two computers: one the owner linked, and is in charge of,
// and one a guest linked, where the owner is a person she chose.
import { linkInProcess } from "../src/server/runner-link/secure-link.ts";
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner } from "../packages/runner/src/runner.ts";
import type { User } from "../src/server/config.ts";
import { BackgroundDoc, DeletedDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const repo = join(root, "computer-repo");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let app: App;
let server: Server;
/** The owner's computer: they linked it, so they are in charge of it and see every session there. */
let runner: Runner;
let computer: string;
/** Lina's computer: she linked it and chose the owner for it, with the test folders given. */
let linasRunner: Runner;
let linas: string;
let lina: User;
let base = "";
/** The permissions of the sessions made here, whose folders their computers keep: removed after. */
const permissions = new Set<string>();
const folders = new Set<string>();

async function link(name: string, linker: User): Promise<{ id: string; runner: Runner }> {
    const linked = linkInProcess(
        (request) => app.runners.redeem(request),
        app.runners.makeCode(name, linker.id).code,
    );
    const made = new Runner({
        link: { server: base, ...linked },
        version: "test",
        cwd: repo,
        log: () => {},
        retryMs: [50, 100, 200],
    });

    made.start();
    // An unlinked computer's runner ends with an error: nobody else waits for that.
    made.finished.catch(() => {});
    await until(() => app.runners.link(linked.id).online, `${name} to connect`);

    return { id: linked.id, runner: made };
}

before(async () => {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Cleanup test");
    git(repo, "config", "user.email", "cleanup@example.com");
    writeFileSync(join(repo, "main.ts"), "export const answer = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    app = await openApp(scriptedModel());
    app.background.timing.grace = 300;
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    ({ id: computer, runner } = await link("Cleanup laptop", owner(app)));
    // The owner lets Lina link a computer of her own; she does, and chooses the owner for it.
    lina = app.config.addUser("Lina", "guest").user;
    app.setRight(owner(app), { person: lina.id, right: "linksRunners", on: true });
    ({ id: linas, runner: linasRunner } = await link("Lina's laptop", lina));
    app.config.setUsers(linas, [owner(app).id]);
    app.config.setGivenFolders(linas, owner(app).id, [root]);
    app.accessChanged();

    const info = await app.runners.link(computer).info();

    folders.add(join(info.home, ".pi-pocket", "worktrees"));
    folders.add(join(info.tmpdir, "pi-pocket-tasks"));
});

after(async () => {
    // Stopped already when its computer was unlinked, or by its test.
    await runner?.stop().catch(() => {});
    await linasRunner?.stop().catch(() => {});
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    // Only what this test's sessions had there, by their permission ids.
    for (const permission of permissions) {
        for (const folder of folders) {
            rmSync(join(folder, permission), { recursive: true, force: true });
        }
    }

    cleanUp();
});

async function call(path: string, body: unknown, token = app.config.ownerToken) {
    const response = await fetch(`${base}/api/x/session-cleanup/${path}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, data: (await response.json()) as Record<string, any> };
}

/** Allow each folder request as it comes, in the name of `as`, who is in charge there. Returns a stop function. */
function allowing(as: User): () => void {
    const seen = new Set<string>();
    const timer = setInterval(() => {
        for (const each of app.folderRequests.list(as)) {
            if (!seen.has(each.id)) {
                seen.add(each.id);
                void app.folderRequests.approve(as, each.id, { method: "owner" }).catch(() => {});
            }
        }
    }, 10);

    return () => clearInterval(timer);
}

/** A session of `user` on computer `on`, in the repository there; who is in charge of `on` allows it when asked. */
async function there(
    title: string,
    worktree: boolean,
    user: User = owner(app),
    on: string = computer,
) {
    const stop = allowing(on === linas ? lina : owner(app));
    const { id } = await app.commands
        .createSession(user, {
            runner: on,
            cwd: repo,
            title,
            ...(worktree ? { worktree: true } : {}),
        })
        .finally(stop);

    permissions.add(app.runnerPermission(id));

    return id;
}

const archive = (id: ConversationId, user: User = owner(app)) =>
    app.commands.updateSession(id, user, { archived: true });

/** How many folder requests wait for an answer: a cleanup adds none. */
const waiting = () =>
    app.folderRequests.list(owner(app)).length + app.folderRequests.list(lina).length;

const running = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

test("a session on another computer leaves with its worktree and its tasks there", async () => {
    const id = await there("Work on the laptop", true);
    const worktree = app.sessionMeta(id)!.worktree!;

    await app.background.start(id, { command: "sleep 60", notify: false });

    await until(
        async () => ((await app.background.list(id))[0]?.pid ?? 0) > 0,
        "the task's process is known",
    );

    const { pid } = (await app.background.list(id))[0]!;
    // This server's own session in a folder of the same path is on another computer: it does not share the worktree.
    const here = await newSession(app, worktree.path);

    assert.equal(existsSync(join(app.dataDir, "worktrees")), false, "no worktree on the server");
    assert.equal(running(pid), true);
    await archive(id);

    const asked = waiting();
    const [plan] = (await call("plan", { ids: [id] })).data.sessions;

    assert.equal(plan.blocked, undefined);
    assert.equal(plan.worktree.path, worktree.path);
    assert.equal(
        plan.worktree.state,
        "clean",
        "read on its computer, and not shared with this one",
    );
    assert.equal(plan.worktree.bytes, 0, "a worktree there is not sized");
    assert.equal(plan.ends.background, 1);

    const done = await call("remove", { ids: [id] });

    assert.deepEqual(done.data.outcomes, [{ id: Number(id), done: true, bytes: 0 }]);
    assert.equal(existsSync(worktree.path), false, "its worktree went on its computer");
    assert.equal(
        git(repo, "branch", "--list", worktree.branch),
        worktree.branch,
        "its branch stays",
    );
    await until(() => !running(pid), "its task stopped on its computer");
    assert.equal(
        app.sessions().some((session) => session.id === Number(id)),
        false,
    );
    assert.ok(app.sessions().some((session) => session.id === Number(here)));
    assert.equal(waiting(), asked, "nobody was asked");

    const record = (await app.harness.snapshot(DeletedDoc, context))!.items[String(id)]!;

    assert.equal(record.runner, computer);
    assert.equal(record.worktree, undefined, "nothing of it is looked for on this machine");
    assert.ok(record.done !== undefined);
});

test("a session on another computer that the owner may not see is not theirs to plan or remove", async () => {
    // On Lina's computer the owner is one of the people she chose: her own session there is not shared with them.
    const id = await there("Lina's own work", true, lina, linas);
    const worktree = app.sessionMeta(id)!.worktree!;

    await archive(id, lina);
    assert.equal(app.policy.inCharge(owner(app), linas), false);
    assert.equal(app.canSee(owner(app), id), false);
    assert.deepEqual((await call("plan", { ids: [id] })).data.sessions, [], "not even its title");
    assert.equal(
        (await call("plan", { olderThanDays: 0 })).data.sessions.some(
            (each: { id: number }) => each.id === Number(id),
        ),
        false,
    );
    assert.equal((await call("clean-up", { ids: [id] })).status, 403);
    assert.equal((await call("remove", { ids: [id] })).status, 403);
    assert.equal(existsSync(worktree.path), true);
    assert.equal(app.sessionMeta(id)?.worktree?.path, worktree.path);
});

test("tasks on a computer that is not reached any more are given up, and no process is signalled", async () => {
    const guest = app.config.addUser("Remy", "guest").user;

    app.config.setUsers(computer, [guest.id]);
    app.config.setGivenFolders(computer, guest.id, [root]);
    app.config.updateUser(guest.id, { approvalDays: 0 });
    app.accessChanged();

    const id = await there("Remy's server", false, guest);

    await app.background.start(id, { command: "sleep 60", notify: false });
    await until(
        async () => ((await app.background.list(id))[0]?.pid ?? 0) > 0,
        "the task's process is known",
    );

    const { pid } = (await app.background.list(id))[0]!;

    try {
        await archive(id);
        // The person who started it may no longer use the computer, and the session is still theirs (the state a
        // hand-over that was cut off leaves): nothing of the session runs or is read there.
        app.config.setUsers(computer, []);
        assert.throws(() => app.runnerScope(id), { status: 403 });

        const asked = waiting();
        const [plan] = (await call("plan", { ids: [id] })).data.sessions;

        assert.equal(plan.blocked, undefined, "what is there stays; the session can go");
        assert.equal(plan.ends.background, 1);
        assert.deepEqual((await call("remove", { ids: [id] })).data.outcomes, [
            { id: Number(id), done: true, bytes: 0 },
        ]);
        assert.equal(waiting(), asked, "nobody was asked");

        const [task] = Object.values(
            (await app.harness.snapshot(BackgroundDoc, id, context))!.items,
        );

        assert.equal(task!.status, "lost", "no watch is left to look for it on this machine");
        // The test's computer is this machine, so a stop that took the task's process id for a local one would end it.
        await new Promise((resolve) => setTimeout(resolve, app.background.timing.grace + 500));
        assert.equal(running(pid), true, "its process was not signalled");
    } finally {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
});

test("what cannot be removed there keeps the session, and a plan never makes anyone renew an approval", async () => {
    // The owner starts the sessions. Lina can clean them up because she is in charge of their computer.
    const id = await there("Half done", true, owner(app), linas);
    const plain = await there("Nothing there", false, owner(app), linas);
    const worktree = app.sessionMeta(id)!.worktree!;
    const token = app.config.addDevice(lina.id);
    const blocked = async () => (await call("plan", { ids: [id] }, token)).data.sessions[0].blocked;

    const stays = async (why: RegExp) => {
        assert.match(await blocked(), why);

        for (const action of ["clean-up", "remove"]) {
            const [outcome] = (await call(action, { ids: [id] }, token)).data.outcomes;

            assert.equal(outcome.done, false, action);
            assert.match(outcome.why, why, action);
        }

        assert.equal(existsSync(worktree.path), true);
        assert.equal(app.sessionMeta(id)?.worktree?.path, worktree.path);
    };

    await archive(id);
    await archive(plain);

    // Uncommitted changes, read on the computer.
    writeFileSync(join(worktree.path, "draft.ts"), "export {};\n");
    assert.match(await blocked(), /uncommitted changes/);
    rmSync(join(worktree.path, "draft.ts"));
    assert.equal(await blocked(), undefined);

    // An env file that git ignores, found on the computer.
    writeFileSync(join(worktree.path, ".gitignore"), "secrets/\n");
    git(worktree.path, "add", ".gitignore");
    git(worktree.path, "commit", "-qm", "ignore");
    mkdirSync(join(worktree.path, "secrets"));
    writeFileSync(join(worktree.path, "secrets", "prod.env"), "KEY=1\n");
    await stays(/env file that git ignores/);
    rmSync(join(worktree.path, "secrets"), { recursive: true });
    assert.equal(await blocked(), undefined);

    // The starter's approval ended. Lina still plans it without asking them to renew.
    const asked = waiting();

    app.folderApprovals.revoke(String(app.rootOf(id)), true);
    assert.equal(app.policy.steer(owner(app), String(app.rootOf(id))), "locked");
    assert.equal(await blocked(), undefined);
    assert.equal(waiting(), asked, "nobody was asked");

    await linasRunner.stop();
    await until(() => !app.runners.link(linas).online, "the computer to go offline");
    await stays(/Lina's laptop is offline/);

    // A session with nothing on its computer leaves, also while that computer is away.
    assert.deepEqual((await call("remove", { ids: [plain] }, token)).data.outcomes, [
        { id: Number(plain), done: true, bytes: 0 },
    ]);
    assert.equal(
        (await app.harness.snapshot(DeletedDoc, context))!.items[String(plain)]!.runner,
        linas,
    );
});

test("a session on a computer that was unlinked leaves for the owner alone, and what it has there stays", async () => {
    const id = await there("On a computer that went", true);
    const worktree = app.sessionMeta(id)!.worktree!;

    await archive(id);
    await app.unlinkRunner(computer);
    assert.equal(app.runners.stored(computer), undefined);
    assert.equal(app.canSee(owner(app), id), true, "its starter still sees it");

    const asked = waiting();
    // Nobody is in charge of a computer that is gone: someone in charge of another computer is told nothing of it.
    const linasToken = app.config.addDevice(lina.id);

    assert.deepEqual((await call("plan", { ids: [id] }, linasToken)).data.sessions, []);
    assert.equal((await call("clean-up", { ids: [id] }, linasToken)).status, 403);
    assert.equal((await call("remove", { ids: [id] }, linasToken)).status, 403);
    assert.ok(app.sessionMeta(id) !== undefined, "it is still there");

    const [plan] = (await call("plan", { ids: [id] })).data.sessions;

    assert.equal(plan.blocked, undefined, "nothing there is reached, and the session can go");
    assert.equal(plan.worktree, undefined, "its worktree is not read: its computer is gone");
    assert.deepEqual((await call("remove", { ids: [id] })).data.outcomes, [
        { id: Number(id), done: true, bytes: 0 },
    ]);
    assert.equal(existsSync(worktree.path), true, "its worktree stays on its computer");
    assert.equal(waiting(), asked, "nobody was asked");

    const record = (await app.harness.snapshot(DeletedDoc, context))!.items[String(id)]!;

    assert.equal(record.runner, computer);
    assert.equal(record.worktree, undefined, "nothing of it is looked for on this machine");
});
