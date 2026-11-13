// A session's environment on another computer (`src/server/runners.ts`, `src/runner/`): the server's `RunnerEnv`, a
// real WebSocket, the runner, and the real pi-env daemon, all on this machine. Pi Durable's own conformance suite checks
// that it acts as `NodeExecutionEnv` does; the rest checks linking, keys, and what survives a drop.
import assert from "node:assert/strict";
import { linkInProcess, newIdentity, publicOf } from "../src/runner/secure-link.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import {
    broadFolder,
    coveredFolder,
    folderContains,
    realFolder,
    sameFolder,
} from "../src/runner/folders.ts";
import { Runner, type RunnerOptions, RunnerStopped } from "../src/runner/runner.ts";
import { checkTools, toolsStatus } from "../src/runner/tools.ts";
import { ConfigStore } from "../src/server/config.ts";
import { readableEntries, Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-runner-test-"));

type Setup = {
    server: Server;
    address: string;
    config: ConfigStore;
    runners: Runners;
    lines: string[];
};

async function serve(): Promise<Setup> {
    const config = new ConfigStore(mkdtempSync(join(root, "data-")));
    const lines: string[] = [];
    const runners = new Runners({ config, log: (line) => lines.push(line) });
    const server = createServer((request, response) => {
        response.writeHead(404).end();
    });

    server.on("upgrade", (request, socket, head) => {
        if (!runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;

    return { server, address: `http://127.0.0.1:${port}`, config, runners, lines };
}

/** Link a computer the way `pi-pocket runner link` does, and start its runner. */
function startRunner(
    setup: Setup,
    name: string,
    lines: string[] = [],
    more: Partial<RunnerOptions> = {},
): { runner: Runner; id: string } {
    const { code } = setup.runners.makeCode(name, "owner");
    const linked = linkInProcess((request) => setup.runners.redeem(request), code);
    const options: RunnerOptions = {
        link: { server: setup.address, ...linked },
        version: "test",
        cwd: root,
        log: (line) => lines.push(line),
        retryMs: [50, 100, 200],
        ...more,
    };
    const runner = new Runner(options);

    started.set(runner, options);
    runner.start();

    return { runner, id: linked.id };
}

/**
 * The environment of a session in `cwd` on computer `id`: each request names the session and its folder, and its runner
 * keeps the request inside that folder (`request-gate.ts`). The server decided who may use it.
 */
async function sessionEnv(setup: Setup, id: string, cwd: string, session = randomUUID()) {
    await setup.runners.link(id).whenOnline();

    return setup.runners.env(id, cwd, { id: session, folder: cwd, person: "Owner" });
}

/** The options each test runner started with, to start it again (`startRunnerFor`). */
const started = new WeakMap<Runner, RunnerOptions>();

/** A new runner linked as `before` was (the same link file): as when the app starts again. */
function startRunnerFor(before: Runner): { runner: Runner } {
    const runner = new Runner(started.get(before)!);

    started.set(runner, started.get(before)!);
    runner.start();

    return { runner };
}

/** Two connected in-memory streams, as a socket and its peer. */
function socketPair(): [Duplex, Duplex] {
    let a: Duplex;
    let b: Duplex;
    const make = (peer: () => Duplex) =>
        new Duplex({
            write(chunk, _encoding, done) {
                peer().push(chunk);
                done();
            },
            final(done) {
                peer().push(null);
                done();
            },
            read() {},
            destroy(error, done) {
                if (!peer().destroyed) {
                    peer().destroy();
                }

                done(error);
            },
        });

    a = make(() => b);
    b = make(() => a);

    return [a, b];
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function close(setup: Setup): Promise<void> {
    setup.runners.close();
    setup.server.closeAllConnections();
    await new Promise((resolve) => setup.server.close(resolve));
}

after(() => rmSync(root, { recursive: true, force: true }));

describe("runner conformance", () => {
    let setup: Setup;
    let runner: Runner;
    let id: string;

    before(async () => {
        setup = await serve();
        ({ runner, id } = startRunner(setup, "Conformance"));
        await until(() => runner.connected, "the runner to connect");
    });
    after(async () => {
        await runner.stop();
        await close(setup);
    });

    // Jest-style `expect` over node:assert, for the suite.
    const expect = (actual: unknown) => ({
        toBeTruthy: () => assert.ok(actual),
        toBe: (expected: unknown) => assert.equal(actual, expected),
        toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
        toMatchObject: (expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
        toBeGreaterThan: (expected: number) => assert.ok((actual as number) > expected),
        rejects: {
            toThrow: async (message: string) => {
                await assert.rejects(actual as Promise<unknown>, (error: Error) => {
                    assert.ok(error.message.includes(message), error.message);

                    return true;
                });
            },
        },
    });

    registerEnvConformance(
        {
            describe: (name: string, body: () => void) => describe(name, body),
            it: (name: string, body: () => Promise<void>, timeout?: number) =>
                it(name, { timeout: timeout ?? 20_000 }, body),
            expect,
        } as unknown as Parameters<typeof registerEnvConformance>[0],
        "RunnerEnv",
        async (use) => {
            const cwd = mkdtempSync(join(root, "env-"));

            try {
                await use(await sessionEnv(setup, id, cwd));
            } finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        },
        { listFiles: true },
    );
});

async function exec(env: ExecutionEnv, command: string): Promise<string> {
    let output = "";
    const result = await env.exec(command, { onOutput: (text) => (output += text) }, context);

    assert.ok(result.ok, result.ok ? "" : result.error.message);

    return output;
}

describe("runner tools", () => {
    it("reports missing programs without crashing, and checks GitHub sign-in separately", async () => {
        const folder = mkdtempSync(join(root, "tools-"));
        const previous = process.env.PATH;

        process.env.PATH = folder;

        try {
            assert.deepEqual(await checkTools(), { git: false, gh: false, github: false });
            writeFileSync(join(folder, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
            writeFileSync(join(folder, "gh"), '#!/bin/sh\n[ "$1" = "--version" ]\n', {
                mode: 0o700,
            });
            assert.deepEqual(await checkTools(), { git: true, gh: true, github: false });
            writeFileSync(join(folder, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
            assert.deepEqual(await checkTools(), { git: true, gh: true, github: true });
        } finally {
            process.env.PATH = previous;
        }
    });

    it("gives installation and sign-in commands for each system", () => {
        const absent = { git: false, gh: false, github: false };

        assert.match(toolsStatus(absent, "darwin"), /xcode-select --install.*brew install gh/);
        assert.match(
            toolsStatus(absent, "win32"),
            /winget install Git.Git.*winget install GitHub.cli/,
        );
        assert.match(
            toolsStatus(absent, "linux"),
            /sudo apt install git.*https:\/\/github.com\/cli\/cli#installation/,
        );
        assert.match(
            toolsStatus({ git: true, gh: true, github: false }, "linux"),
            /git ✓.*gh auth login/,
        );
        assert.equal(
            toolsStatus({ git: true, gh: true, github: true }, "linux"),
            "git ✓ · GitHub ✓",
        );
    });

    it("carries tools in Hello, exposes them in RunnerView, and refreshes them at reconnect", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Tools");

        try {
            await until(() => runner.connected, "the runner to connect");
            const tools = await checkTools();

            assert.deepEqual(setup.runners.list()[0]?.tools, tools);
            assert.deepEqual(setup.config.runnerById(id)?.tools, tools);
            setup.config.updateRunner(id, {
                tools: { git: !tools.git, gh: !tools.gh, github: !tools.github },
            });
            runner.drop();
            await until(
                () => runner.connected && setup.runners.list()[0]?.tools?.git === tools.git,
                "tools to refresh after reconnect",
            );
            assert.deepEqual(setup.runners.list()[0]?.tools, tools);
        } finally {
            await runner.stop();
            await close(setup);
        }
    });
});

describe("runner link", () => {
    it("a command keeps running across a drop, and its output arrives", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Laptop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const cwd = mkdtempSync(join(root, "drop-"));
            const env = await sessionEnv(setup, id, cwd);
            const pending = exec(env, "echo before; sleep 1; echo during; sleep 1; echo after");

            await new Promise((resolve) => setTimeout(resolve, 300));
            runner.drop();
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(runner.connected, false);

            assert.equal(await pending, "before\nduring\nafter\n");
            assert.ok(setup.lines.some((line) => line.includes("is back; its work goes on")));

            // A handle opened before the drop still works after it.
            const written = await env.writeFile("kept.txt", "kept", context);

            assert.ok(written.ok);
            runner.drop();
            await until(() => runner.connected, "the runner to come back");
            assert.equal(await exec(env, "cat kept.txt"), "kept");
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("offline is offline: a command keeps running however long the link is down, and finishes when it is back", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Desktop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const env = await sessionEnv(setup, id, root);
            const pending = exec(env, "echo start; sleep 2; echo end");

            await new Promise((resolve) => setTimeout(resolve, 300));
            // The link stays down well past the command's end: the server refuses the runner's reconnects for a while.
            const listener = setup.server.listeners("upgrade")[0] as (...args: unknown[]) => void;

            setup.server.removeAllListeners("upgrade");
            setup.server.on("upgrade", (_request, socket) => socket.destroy());
            runner.drop();
            await until(() => setup.runners.list()[0]!.away, "the computer to be offline");
            await new Promise((resolve) => setTimeout(resolve, 3_000));

            // Nothing failed meanwhile, and work asked for while it is offline waits too.
            const later = exec(env, "echo later");
            let settled = false;

            void pending.finally(() => (settled = true));
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(settled, false);
            assert.ok(setup.lines.some((line) => line.includes("went offline; its work waits")));

            setup.server.removeAllListeners("upgrade");
            setup.server.on("upgrade", listener);

            assert.equal(await pending, "start\nend\n");
            assert.equal(await later, "later\n");
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("when the runner started over, what was in flight fails as lost, and new work runs", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Desktop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const env = await sessionEnv(setup, id, root);
            const pending = env.exec("sleep 30", {}, context);

            await new Promise((resolve) => setTimeout(resolve, 300));
            // The app quit: its runner and the commands it ran are gone. A new runner connects as the same computer.
            await runner.stop();

            const { runner: again } = startRunnerFor(runner);

            try {
                const result = await pending;

                assert.equal(result.ok, false);
                // Stopped on purpose (the app quit), it says so; one that crashed says it restarted.
                assert.match(result.ok ? "" : result.error.message, /stopped|restarted/);
                assert.equal(await exec(env, "echo again"), "again\n");
            } finally {
                await again.stop();
            }
        } finally {
            await close(setup);
        }
    });

    it("a folder lists every entry it can read, without the ones whose lstat fails", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Monolith");

        try {
            await until(() => runner.connected, "the runner to connect");

            const folder = mkdtempSync(join(root, "home-"));

            mkdirSync(join(folder, "alpha"));
            mkdirSync(join(folder, "beta"));
            writeFileSync(join(folder, "notes.txt"), "notes");
            // A name the daemon cannot lstat: 255 bytes that are not UTF-8 become 765 bytes of U+FFFD, too long for
            // Linux (ENAMETOOLONG), as `nul` on Windows fails with EISDIR.
            writeFileSync(
                Buffer.concat([Buffer.from(`${folder}/`), Buffer.alloc(255, 0xff)]),
                "unreadable",
            );

            const listed = await setup.runners.folders(id, folder, false);

            assert.deepEqual(
                listed.dirs.map((dir) => dir.name),
                ["alpha", "beta"],
            );

            const env = await sessionEnv(setup, id, folder);
            const all = await env.listDir(folder, context);

            assert.ok(all.ok, all.ok ? "" : all.error.message);
            assert.deepEqual(all.value.map((entry) => entry.name).sort(), [
                "alpha",
                "beta",
                "notes.txt",
            ]);

            const reader = await env.openDirReader(folder, context);

            assert.ok(reader.ok, reader.ok ? "" : reader.error.message);

            const page = await reader.value.next(10, context);

            await reader.value.close(context);
            assert.ok(page.ok, page.ok ? "" : page.error.message);
            assert.equal(page.value.entries.length, 3);
            assert.equal(page.value.done, true);
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("an entry that fails with EISDIR (Windows' `nul`) is left out of its page", () => {
        const page = {
            json: {
                entries: [
                    { name: "Documents", info: { kind: "directory" } },
                    {
                        name: "nul",
                        error: {
                            code: "EISDIR",
                            message:
                                "EISDIR: illegal operation on a directory, lstat 'C:\\Users\\vital\\nul'",
                        },
                    },
                    { name: "Projects", info: { kind: "directory" } },
                ],
                done: true,
            },
            payload: new Uint8Array(),
            session: 1,
        };

        assert.deepEqual(readableEntries(page).json, {
            entries: [
                { name: "Documents", info: { kind: "directory" } },
                { name: "Projects", info: { kind: "directory" } },
            ],
            done: true,
        });

        const clean = { ...page, json: { entries: [page.json.entries[0]], done: true } };

        assert.equal(readableEntries(clean), clean);
    });

    it("a computer that is offline: work waits for it, and an abort ends the wait", async () => {
        const setup = await serve();

        try {
            const { runner: gone, id } = startRunner(setup, "Away");

            await until(() => gone.connected, "the runner to connect");
            // Approved while online: the permission is the computer's, and outlasts its runner.
            const env = await sessionEnv(setup, id, root);

            await gone.stop();
            await until(() => !setup.runners.list()[0]!.online, "the computer to be offline");

            const link = setup.runners.link(id);
            const controller = new AbortController();
            const waiting = link.whenOnline(controller.signal);

            setTimeout(() => controller.abort(new Error("stopped")), 200);
            await assert.rejects(waiting, /stopped/);
            // What a person waits on says it at once.
            await assert.rejects(link.infoNow(), /Away is offline/);

            // Its system is still known, from when it was online.
            assert.ok(setup.runners.system(id)?.tmpdir);

            const ran = exec(env, "echo back");
            const { runner: again } = startRunnerFor(gone);

            try {
                assert.equal(await ran, "back\n");
            } finally {
                await again.stop();
            }
        } finally {
            await close(setup);
        }
    });

    it("opens network connections on the computer, and resets them when the link drops", async () => {
        const setup = await serve();
        const echo = createNetServer((socket) => socket.pipe(socket));
        const gone = createNetServer();

        await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
        await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
        // A port nothing listens on any more.
        const closedPort = (gone.address() as AddressInfo).port;

        await new Promise((resolve) => gone.close(resolve));
        const { runner, id } = startRunner(setup, "Net");

        try {
            await until(() => runner.connected, "the runner to connect");

            const link = setup.runners.link(id);
            const [near, far] = socketPair();
            const opened = runner.opened;
            const session = { id: randomUUID(), folder: root, person: "Owner" };

            await link.openNetwork("localhost", (echo.address() as AddressInfo).port, far, {
                first: [Buffer.from("first ")],
                session,
            });
            assert.equal(runner.opened, opened + 1);

            let echoed = "";

            near.on("data", (chunk: Buffer) => (echoed += chunk.toString()));
            // A megabyte each way: more than a credit window, so credit has to come back.
            const big = "x".repeat(1024 * 1024);

            near.write(big);
            await until(() => echoed.length === 6 + big.length, "the echo");
            assert.ok(echoed.startsWith("first x"));

            // Nothing listens: the computer's error comes back.
            await assert.rejects(
                link.openNetwork("127.0.0.1", closedPort, socketPair()[1], { session }),
                (error: Error) => /refused/i.test(error.message),
            );
            // A stream that names no session is refused before it connects.
            await assert.rejects(
                link.openNetwork(
                    "localhost",
                    (echo.address() as AddressInfo).port,
                    socketPair()[1],
                ),
                /named no session/,
            );
            assert.equal(runner.opened, opened + 1);

            const closed = new Promise((resolve) => near.once("close", resolve));

            runner.drop();
            await closed;
            await until(() => runner.connected, "the runner to reconnect");
            await runner.stop();
            await until(() => !setup.runners.list()[0]!.online, "the computer to be offline");
            await assert.rejects(
                link.openNetwork("localhost", 80, socketPair()[1]),
                /Net is offline/,
            );
        } finally {
            await runner.stop();
            echo.close();
            await close(setup);
        }
    });

    it("gets its settings from the server at once, and again after a drop", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Folder");

        try {
            await until(() => runner.connected, "the runner to connect");
            assert.deepEqual(runner.settings, { network: true });

            setup.config.setComputerSettings(id, { downloads: join(root, "My Downloads") });
            setup.runners.link(id).sendSettings();
            await until(
                () => runner.settings.downloads === join(root, "My Downloads"),
                "the folder to reach the runner",
            );
            assert.equal(setup.runners.link(id).downloads, join(root, "My Downloads"));

            setup.config.setComputerSettings(id, { network: false });
            runner.drop();
            await until(
                () => runner.connected && !runner.settings.network,
                "the settings again after the drop",
            );
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("codes work once; wrong keys and removed computers are refused", async () => {
        const setup = await serve();

        try {
            const { code } = setup.runners.makeCode("Server box", "owner");

            assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

            const linked = linkInProcess(
                (request) => setup.runners.redeem(request),
                code.toLowerCase(),
            );

            assert.throws(() => setup.runners.makeCode("Server box ", "owner"), /already/);

            assert.throws(
                () => linkInProcess((request) => setup.runners.redeem(request), code),
                /wrong, already used, or expired/,
            );
            // The server keeps the runner's public key; its private key stays on the computer.
            assert.equal(setup.config.runnerById(linked.id)?.publicKey, publicOf(linked.key));
            assert.ok(!JSON.stringify(setup.config.runners).includes(linked.key));

            // Another key for the same computer does not prove it.
            const wrong = new Runner({
                link: { server: setup.address, ...linked, key: newIdentity().privateKey },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            wrong.start();
            // The server signs its refusal of a key that is not the one it keeps, so the runner knows to stop.
            await assert.rejects(wrong.finished, (error: Error) => {
                assert.ok(error instanceof RunnerStopped);
                assert.match(error.message, /linked this computer again with a new key/);

                return true;
            });

            const runner = new Runner({
                link: { server: setup.address, ...linked },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            runner.start();
            await until(() => runner.connected, "the runner to connect");
            // The runner is connected before the server has read its hello: under load, wait for what it told.
            await until(
                () => setup.runners.list()[0]?.version !== undefined,
                "the server to know the runner",
            );

            const listed = setup.runners.list()[0]!;

            assert.equal(listed.online, true);
            assert.equal(listed.version, "test");
            assert.ok(listed.os !== undefined && listed.home !== undefined);

            setup.runners.remove(linked.id);
            await assert.rejects(runner.finished, /removed this computer/);
            assert.equal(setup.runners.list().length, 0);
        } finally {
            await close(setup);
        }
    });
});

describe("allowed folders", () => {
    it("compares descendants, roots, and platform case without matching siblings", () => {
        assert.equal(folderContains("/work/project", "/work/project/nested", "linux"), true);
        assert.equal(folderContains("/work/project", "/work/project-two", "linux"), false);
        assert.equal(folderContains("/Work", "/work/project", "linux"), false);
        assert.equal(folderContains("/Work", "/work/project", "darwin"), true);
        assert.equal(folderContains("C:\\Work", "c:\\work\\project", "win32"), true);
        assert.equal(folderContains("C:\\Work", "c:\\work-two", "win32"), false);
        assert.equal(folderContains("/", "/work", "linux"), true);
        assert.equal(folderContains("C:\\", "C:\\work", "win32"), true);
        assert.equal(folderContains("/work\\", "/work", "linux"), false);
        assert.equal(broadFolder("/", "/home/person", "linux"), true);
        assert.equal(broadFolder("/home", "/home/person", "linux"), true);
        assert.equal(broadFolder("/home/person", "/home/person", "linux"), true);
        assert.equal(broadFolder("/home/person/project", "/home/person", "linux"), false);
        assert.equal(broadFolder("C:\\", "C:\\Users\\person", "win32"), true);
        assert.equal(broadFolder("/USERS", "/Users/person", "darwin"), true);
    });

    it("uses real paths, skips deleted entries, and can remove an entry that no longer exists", async () => {
        const folder = mkdtempSync(join(root, "real-"));
        const alias = `${folder}-alias`;
        const missing = join(folder, "missing");

        symlinkSync(folder, alias, process.platform === "win32" ? "junction" : "dir");
        assert.equal(await realFolder(alias), await realFolder(folder));
        assert.equal(await coveredFolder(folder, [alias]), true);
        assert.equal(await coveredFolder(missing, [missing]), false);
        assert.equal(await realFolder(missing), missing);
        assert.equal(await sameFolder(alias, folder), true);
        assert.equal(await sameFolder(missing, missing), true);
    });
});

mkdirSync(root, { recursive: true });
