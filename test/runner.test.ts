// A session's environment on another computer (`src/server/runners.ts`, `src/runner/`): the server's `RunnerEnv`, a
// real WebSocket, the runner, and the real pi-env daemon, all on this machine. Pi Durable's own conformance suite checks
// that it acts as `NodeExecutionEnv` does; the rest checks linking, keys, and what survives a drop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { Runner, RunnerStopped } from "../src/runner/runner.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-runner-test-"));

type Setup = {
    server: Server;
    address: string;
    config: ConfigStore;
    runners: Runners;
    lines: string[];
};

async function serve(graceMs = 60_000): Promise<Setup> {
    const config = new ConfigStore(mkdtempSync(join(root, "data-")));
    const lines: string[] = [];
    const runners = new Runners({ config, log: (line) => lines.push(line), graceMs });
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
): { runner: Runner; id: string } {
    const { code } = setup.runners.makeCode(name, "owner");
    const linked = setup.runners.redeem(code);
    const runner = new Runner({
        link: { server: setup.address, ...linked },
        version: "test",
        cwd: root,
        log: (line) => lines.push(line),
        retryMs: [50, 100, 200],
    });

    runner.start();

    return { runner, id: linked.id };
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
                await use(setup.runners.env(id, cwd));
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

describe("runner link", () => {
    it("a command keeps running across a short drop, and its output arrives", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Laptop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const cwd = mkdtempSync(join(root, "drop-"));
            const env = setup.runners.env(id, cwd);
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

    it("after the grace period, work in flight fails as lost and a new session starts", async () => {
        const setup = await serve(300);
        const { runner, id } = startRunner(setup, "Desktop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const env = setup.runners.env(id, root);
            const first = await env.exec("echo $$", {}, context);

            assert.ok(first.ok);

            const pending = env.exec("sleep 30", {}, context);

            await new Promise((resolve) => setTimeout(resolve, 200));
            // The link stays down longer than the grace period: block the runner's reconnects for a while.
            const listener = setup.server.listeners("upgrade")[0] as (...args: unknown[]) => void;

            setup.server.removeAllListeners("upgrade");
            setup.server.on("upgrade", (_request, socket) => socket.destroy());
            runner.drop();

            const result = await pending;

            assert.equal(result.ok, false);
            assert.match(result.ok ? "" : result.error.message, /disconnected too long/);

            setup.server.removeAllListeners("upgrade");
            setup.server.on("upgrade", listener);
            await until(() => runner.connected, "the runner to start over");
            assert.equal(await exec(env, "echo again"), "again\n");
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("a computer that is offline fails fast, and says so", async () => {
        const setup = await serve();

        try {
            const { runner: gone, id } = startRunner(setup, "Away");

            await until(() => gone.connected, "the runner to connect");
            await gone.stop();
            await until(() => !setup.runners.list()[0]!.online, "the computer to be offline");

            const result = await setup.runners.env(id, root).exec("true", {}, context);

            assert.equal(result.ok, false);
            assert.match(result.ok ? "" : result.error.message, /is offline/);
        } finally {
            await close(setup);
        }
    });

    it("codes work once; wrong keys and removed computers are refused", async () => {
        const setup = await serve();

        try {
            const { code } = setup.runners.makeCode("Server box", "owner");

            assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

            const linked = setup.runners.redeem(code.toLowerCase());

            assert.throws(() => setup.runners.makeCode("Server box ", "owner"), /already/);

            assert.throws(() => setup.runners.redeem(code), /wrong, already used, or expired/);
            assert.equal(setup.config.runnerByKey(linked.key)?.name, "Server box");
            assert.equal(setup.config.runnerByKey("nope"), undefined);
            assert.ok(!JSON.stringify(setup.config.runners).includes(linked.key));

            const wrong = new Runner({
                link: { server: setup.address, ...linked, key: "wrong" },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            wrong.start();
            await assert.rejects(wrong.finished, RunnerStopped);

            const runner = new Runner({
                link: { server: setup.address, ...linked },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            runner.start();
            await until(() => runner.connected, "the runner to connect");

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

mkdirSync(root, { recursive: true });
