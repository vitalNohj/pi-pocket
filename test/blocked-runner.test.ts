// A computer whose linker was made a viewer is blocked (`access.ts` `blocked`): nothing starts or runs there, nobody is
// in charge of it, and what the server was doing there stops, while its runner stays connected and everyone keeps
// seeing what they saw. A rule, not a record: it ends when its linker prompts again. A real App, a real WebSocket, and
// a real runner with its pi-env daemon, linked by a guest.
import { linkInProcess } from "../src/runner/secure-link.ts";
import {
    type App,
    cleanUp,
    context,
    linkAuthenticator,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner } from "../src/runner/runner.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import type { RunnerView } from "../src/server/runners.ts";

const there = join(root, "there");
const BLOCKED = /Lina's laptop is blocked: Lina, who linked it, is a viewer now/;
let app: App;
let server: Server;
let runner: Runner;
let address: string;
let runnerId: string;
/** Linked the computer, so is in charge of it. */
let lina: User;
/** Chosen for it by Lina, with the test folder given. */
let cho: User;
let linas: ConversationId;
let chos: ConversationId;
const tokens = new Map<string, string>();

function person(name: string, role: User["role"]): User {
    const { user, token } = app.config.addUser(name, role);

    tokens.set(user.id, token);

    return user;
}

async function request<T = Record<string, unknown>>(
    user: User,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method,
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

const current = (user: User) => app.config.userById(user.id)!;
const view = async (user: User) =>
    (await request<RunnerView[]>(user, "runners")).body.find((each) => each.id === runnerId);
/** How a command there ended: "ok", or why not. */
const ended = (running: Promise<{ ok: boolean; error?: { message?: string } }>) =>
    running.then(
        (result) => (result.ok ? "ok" : String(result.error?.message)),
        (error: unknown) => String((error as Error).message ?? error),
    );

async function prompt(id: ConversationId, user: User, text: string): Promise<unknown> {
    const { submissionId } = await app.commands.submit(id, user, {
        text,
        requestId: crypto.randomUUID(),
    });

    return (await app.harness.submission(submissionId, context))!.wait(context);
}

before(async () => {
    mkdirSync(there, { recursive: true });
    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    lina = person("Lina", "guest");
    cho = person("Cho", "guest");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (incoming, socket, head) => {
        if (!app.runners.upgrade(incoming, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The owner lets Lina link a computer of her own, and she does.
    app.setRight(owner(app), { person: lina.id, right: "linksRunners", on: true });

    const { code } = app.runners.makeCode("Lina's laptop", lina.id);
    const linked = linkInProcess((each) => app.runners.redeem(each), code);

    runnerId = linked.id;
    runner = new Runner({
        link: { server: address, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
    });
    runner.start();
    // The last test unlinks the computer, which ends its runner with an error: nobody else waits for that.
    runner.finished.catch(() => {});
    await until(() => app.runners.link(runnerId).online, "the runner to connect");
    // Lina chooses Cho for it, and gives him the test folders there.
    app.config.setRunnerUsers(runnerId, [cho.id]);
    app.config.setGivenFolders(runnerId, cho.id, [root]);
    app.config.updateUser(cho.id, { approvalDays: 0 });
    app.accessChanged();
});

after(async () => {
    // Already stopped when its computer was unlinked.
    await runner?.stop().catch(() => {});
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("a computer whose linker was made a viewer", () => {
    it("works for its linker and the people they chose while its linker prompts", async () => {
        assert.equal(app.policy.blocked(runnerId), false);
        assert.equal(app.policy.inCharge(lina, runnerId), true);
        linas = (await app.commands.createSession(lina, { runner: runnerId, cwd: there })).id;

        const stop = allowing(lina);

        chos = (
            await app.commands.createSession(cho, { runner: runnerId, cwd: there }).finally(stop)
        ).id;

        assert.equal(await ended(app.envFor(linas).exec("echo hers", {}, context)), "ok");
        assert.equal(await ended(app.envFor(chos).exec("echo his", {}, context)), "ok");
        await prompt(chos, cho, "Hello before the block");
        assert.equal((await view(lina))?.blocked, undefined);
    });

    it("is blocked: what runs there stops, nothing starts, and nobody is in charge, while it stays connected", async () => {
        // A command of Cho's session runs there, and a new session of his waits for Lina's Allow.
        const running = ended(
            app.envFor(chos).exec("touch started.txt && sleep 2 && touch done.txt", {}, context),
        );
        const waiting = app.commands.createSession(cho, { runner: runnerId, cwd: there }).then(
            () => "made",
            (error: unknown) => String((error as Error).message),
        );

        await until(() => existsSync(join(there, "started.txt")), "the command to start there");
        await until(() => app.folderRequests.list(cho).length === 1, "the new session to ask");

        // The owner makes Lina a viewer.
        const at = Date.now();

        app.setAccess(owner(app), lina.id, { role: "viewer" });
        assert.equal(app.policy.blocked(runnerId), true);

        // The command fails at once here, and is cancelled there: it never gets to its last step.
        assert.match(await running, BLOCKED);
        assert.ok(Date.now() - at < 1500, "it did not wait for the command to end");
        assert.match(await waiting, /can no longer work there/);
        await new Promise((resolve) => setTimeout(resolve, 2600));
        assert.equal(existsSync(join(there, "done.txt")), false, "the computer stopped it");

        // Its runner is still connected, and everyone who lists it reads that it is blocked.
        assert.equal(app.runners.link(runnerId).online, true);

        for (const user of [owner(app), current(lina), cho]) {
            const seen = await view(user);

            assert.equal(seen?.blocked, true, user.name);
            assert.equal(seen?.online, true, user.name);
            assert.equal(seen?.mayStart, false, user.name);
        }

        // Nobody is in charge of it: not its linker, who reads only what a person there reads.
        for (const user of [owner(app), current(lina), cho]) {
            assert.equal(app.policy.inCharge(user, runnerId), false, user.name);
            assert.equal(app.policy.mayManage(user, runnerId), false, user.name);
            assert.equal(app.policy.mayStart(user, runnerId), false, user.name);
        }

        assert.equal((await view(current(lina)))?.users, undefined, "no people list for her");
        assert.equal(
            (await request(current(lina), `runners/${runnerId}/users`, { users: [] })).status,
            403,
        );
        assert.deepEqual(app.config.runnerById(runnerId)?.users, [cho.id], "its people stay");

        // A block takes nothing from anyone: each still sees the sessions they started.
        assert.equal(app.canSee(current(lina), linas), true);
        assert.equal(app.canSee(cho, chos), true);
        assert.equal(app.sessionMeta(chos)?.createdBy, cho.id, "handed over to nobody");
        // Lina saw Cho's as who is in charge. She is not, now.
        assert.equal(app.canSee(current(lina), chos), false);

        // Nothing starts there.
        const refused = await request<{ error: string }>(cho, "sessions", {
            runner: runnerId,
            cwd: there,
        });

        assert.equal(refused.status, 403);
        assert.match(refused.body.error, /This computer is blocked/);

        const hers = await request<{ error: string }>(current(lina), "sessions", {
            runner: runnerId,
            cwd: there,
        });

        assert.equal(hers.status, 403);
        assert.match(hers.body.error, /Viewers cannot start sessions/);

        // Nothing runs there: a session's tools, its `!` commands, and whoever waits for the computer.
        assert.throws(() => app.envFor(chos), BLOCKED);
        await assert.rejects(app.runners.link(runnerId).whenOnline(), BLOCKED);

        const shell = await request<{ error: string }>(cho, `c/${chos}/shell`, {
            command: "echo no",
        });

        assert.equal(shell.status, 403);
        assert.match(shell.body.error, BLOCKED);
    });

    it("sends Pi nothing in a session there: no prompt, no task, and nobody is asked to renew", async () => {
        const count = async () =>
            (await (await app.conversation(chos)).entries({}, 60, undefined, context)).items.length;
        const before = await count();

        // Pi's answer needs no computer, only its tools do: so the prompt itself is refused, before Pi is asked.
        await assert.rejects(prompt(chos, cho, "Hello while it is blocked"), BLOCKED);

        const sent = await request<{ error: string }>(cho, `c/${chos}/submit`, {
            text: "Hello over HTTP",
            requestId: crypto.randomUUID(),
        });

        assert.equal(sent.status, 403);
        assert.match(sent.body.error, BLOCKED);

        // One of its tasks (a schedule, a webhook, a watch) is refused too, and they wait rather than fail.
        await assert.rejects(
            app.commands.submit(
                chos,
                cho,
                { text: "A task's message", requestId: crypto.randomUUID() },
                undefined,
                undefined,
                true,
            ),
            BLOCKED,
        );
        assert.equal(app.tasksMayRun(chos), false);
        assert.match(String(app.blockedOf(chos)), BLOCKED);
        assert.equal(await count(), before, "nothing was saved in the session");
        assert.deepEqual(app.folderRequests.list(cho), [], "nobody is asked for anything");
        // Stopping work is not refused.
        await app.requireTurn(chos, cho);
    });

    it("works again at once when its linker is made a user, with the same people and sessions", async () => {
        // Prompting needs her own authenticator.
        linkAuthenticator(app, lina);
        app.setAccess(owner(app), lina.id, { role: "guest" });
        assert.equal(app.policy.blocked(runnerId), false);
        assert.equal(app.policy.inCharge(current(lina), runnerId), true);
        assert.equal((await view(current(lina)))?.blocked, undefined);
        assert.deepEqual(
            (await view(current(lina)))?.users?.map((each) => each.id),
            [cho.id],
        );
        assert.equal(await ended(app.envFor(chos).exec("echo back", {}, context)), "ok");
        assert.equal(await ended(app.envFor(linas).exec("echo back", {}, context)), "ok");
        assert.equal(app.canSee(current(lina), chos), true);
        // Its sessions take prompts and run their tasks again.
        assert.equal(app.blockedOf(chos), undefined);
        assert.equal(app.tasksMayRun(chos), true);
        assert.equal(
            ((await prompt(chos, cho, "Hello after the block")) as { status?: string }).status,
            "done",
        );
    });

    it("is the owner's alone to unlink while it is blocked", async () => {
        app.setAccess(owner(app), lina.id, { role: "viewer" });
        assert.equal(app.policy.blocked(runnerId), true);
        assert.equal(
            (await request(current(lina), `runners/${runnerId}`, undefined, "DELETE")).status,
            403,
        );
        assert.notEqual(app.config.runnerById(runnerId), undefined);
        assert.equal(
            (await request(owner(app), `runners/${runnerId}`, undefined, "DELETE")).status,
            200,
        );
        assert.equal(app.config.runnerById(runnerId), undefined);
        // Its runner is sent away for good.
        await assert.rejects(runner.finished, /removed this computer/);
    });
});
