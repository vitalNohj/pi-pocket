// A stopped browser leaves nothing that holds its server: a process it started can outlive it with its pipes open.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const CDP = pathToFileURL(fileURLToPath(new URL("../src/server/browser/cdp.ts", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "pocket-browser-exit-"));
/** The processes the fake browsers left, to stop when the tests end. */
const strays: number[] = [];

after(() => {
    for (const pid of strays) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // It ended by itself.
        }
    }

    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * A browser that answers the two calls a launch makes, and starts a process of its own that outlives it with the
 * browser's error output open, as a crash handler can.
 */
const FAKE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Socket } from "node:net";

const input = new Socket({ fd: 3 });
const output = new Socket({ fd: 4 });
const stray = spawn("sleep", ["120"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });

stray.unref();
writeFileSync(process.env.STRAY_PID_FILE, String(stray.pid));
let kept = "";

input.setEncoding("utf8");
input.on("data", (chunk) => {
    kept += chunk;

    for (let end = kept.indexOf("\\0"); end !== -1; end = kept.indexOf("\\0")) {
        const message = JSON.parse(kept.slice(0, end));

        kept = kept.slice(end + 1);
        output.write(
            JSON.stringify({
                id: message.id,
                result:
                    message.method === "Browser.getVersion"
                        ? { product: "Chrome/1.0.0.0", userAgent: "Fake" }
                        : {},
            }) + "\\0",
        );
    }
});
process.on("SIGTERM", () => process.exit(0));
`;

/** What a server does with a browser it is done with, and then nothing more: it must end by itself. */
const HELPER = `
const { Chromium } = await import(process.argv[2]);
const browser = await Chromium.launch(process.argv[3], process.argv[4], []);

browser.kill();
await browser.exited;
console.log("stopped");
`;

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

test(
    "a process that outlives the browser with its error output open does not keep the server from ending",
    { skip: process.platform === "win32" ? "the fake browser is a shell script" : false },
    async () => {
        const fake = join(root, "fake.mjs");
        const executable = join(root, "fake-browser");
        const helper = join(root, "helper.mjs");
        const pidFile = join(root, "stray.pid");

        writeFileSync(fake, FAKE);
        writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
        chmodSync(executable, 0o755);
        writeFileSync(helper, HELPER);
        const proc = spawn(
            process.execPath,
            [
                "--disable-warning=ExperimentalWarning",
                helper,
                CDP.href,
                executable,
                join(root, "profile"),
            ],
            { env: { ...process.env, STRAY_PID_FILE: pidFile }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";

        proc.stdout.on("data", (chunk) => (output += String(chunk)));
        proc.stderr.on("data", (chunk) => (output += String(chunk)));
        const ended = await new Promise<number | string | null>((done) => {
            const timer = setTimeout(() => {
                proc.kill("SIGKILL");
                done("still running 10 seconds after the browser stopped");
            }, 10_000);

            proc.once("exit", (code) => {
                clearTimeout(timer);
                done(code);
            });
        });
        const stray = Number(readFileSync(pidFile, "utf8"));

        strays.push(stray);
        assert.match(output, /stopped/, output);
        // The process the browser left is still there, with the pipe open: the server ended all the same.
        assert.equal(alive(stray), true, "the stray process outlives the browser");
        assert.equal(ended, 0, output);
    },
);
