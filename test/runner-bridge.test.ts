// The two ways to start the runner, as real processes: `pi-pocket runner` through Pi Pocket's bridge
// (`src/runner/main.ts`), and the runner's own command, `pi-pocket-runner`; and Pi Pocket without its runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const POCKET = join(ROOT, "bin", "pi-pocket.js");
const ALONE = join(ROOT, "packages", "runner", "bin", "pi-pocket-runner.js");
const NOT_INSTALLED =
    "The runner is not installed. Install it with: npm install -g pi-pocket-runner";

const scratch = mkdtempSync(join(tmpdir(), "pi-pocket-bridge-test-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[], cwd = ROOT) {
    return spawnSync(process.execPath, args, {
        cwd,
        encoding: "utf8",
        // No saved link of the person's own: a test must never reach a real server.
        env: { ...process.env, PI_POCKET_RUNNER_CONFIG: join(scratch, "none.json") },
        timeout: 60_000,
    });
}

/** The error lines, without the launchers' warning about a Node.js that lacks security fixes. */
function errors(stderr: string): string[] {
    return stderr
        .split("\n")
        .filter((line) => line !== "" && !/^Node\.js \S+ lacks security fixes/.test(line));
}

describe("the runner's bridge", () => {
    it("`pi-pocket runner --help` shows the runner's help with that command", () => {
        const result = run([POCKET, "runner", "--help"]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^pi-pocket runner: run session tools on this computer\./m);
        assert.match(result.stdout, /^ {2}pi-pocket runner start$/m);
    });

    it("`pi-pocket-runner --help` names its own command, never `pi-pocket runner`", () => {
        const result = run([ALONE, "--help"]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^pi-pocket-runner: run session tools on this computer\./m);
        assert.match(result.stdout, /^ {2}pi-pocket-runner start$/m);
        assert.doesNotMatch(result.stdout, /pi-pocket runner/);
    });

    it("an unknown command fails with the command it was started with as the prefix", () => {
        for (const [args, prefix] of [
            [[POCKET, "runner", "bogus"], "pi-pocket runner: "],
            [[ALONE, "bogus"], "pi-pocket-runner: "],
        ] as const) {
            const result = run([...args]);

            assert.equal(result.status, 1, result.stderr);
            assert.ok(
                errors(result.stderr)[0]?.startsWith(`${prefix}Unknown command "bogus".`),
                result.stderr,
            );
        }
    });

    it("without the runner, `pi-pocket runner` says how to install it", () => {
        const pocket = pocketWithout("none");
        const result = run([join(pocket, "bin", "pi-pocket.js"), "runner", "--help"], pocket);

        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(errors(result.stderr), [NOT_INSTALLED]);
        assert.equal(result.stdout, "");
    });

    it("prefers the runner beside this Pi Pocket over an installed one, and uses the installed one alone", () => {
        const both = pocketWithout("both");

        fakeRunner(join(both, "packages", "runner"), "beside");
        fakeRunner(join(both, "node_modules", "pi-pocket-runner"), "installed");
        const installed = pocketWithout("installed");

        fakeRunner(join(installed, "node_modules", "pi-pocket-runner"), "installed");

        for (const [pocket, which] of [
            [both, "beside"],
            [installed, "installed"],
        ] as const) {
            const result = run([join(pocket, "bin", "pi-pocket.js"), "runner", "x"], pocket);

            assert.equal(result.status, 0, result.stderr);
            assert.equal(
                result.stdout,
                `${which} ${JSON.stringify([["x"], { command: "pi-pocket runner", words: ["runner"], install: "pi-pocket@latest" }])}\n`,
            );
        }
    });
});

/** A Pi Pocket with only its launcher and the bridge, in a new folder: no runner, beside or installed. */
function pocketWithout(name: string): string {
    const pocket = join(scratch, name);

    mkdirSync(join(pocket, "bin"), { recursive: true });
    mkdirSync(join(pocket, "src", "runner"), { recursive: true });
    copyFileSync(POCKET, join(pocket, "bin", "pi-pocket.js"));
    copyFileSync(join(ROOT, "bin", "strip-types.js"), join(pocket, "bin", "strip-types.js"));
    copyFileSync(join(ROOT, "src", "runner", "main.ts"), join(pocket, "src", "runner", "main.ts"));
    writeFileSync(join(pocket, "package.json"), JSON.stringify({ type: "module" }));

    return pocket;
}

/** A runner package in `folder` whose `main` prints `which` and what it was given. */
function fakeRunner(folder: string, which: string): void {
    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, "package.json"),
        JSON.stringify({
            name: "pi-pocket-runner",
            type: "module",
            exports: { "./main": "./main.js" },
        }),
    );
    writeFileSync(
        join(folder, "main.js"),
        `export async function main(...given) { console.log(${JSON.stringify(which)}, JSON.stringify(given)); }\n`,
    );
}
