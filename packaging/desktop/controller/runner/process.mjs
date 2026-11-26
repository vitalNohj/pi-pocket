import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { boundedLines } from "./output.mjs";

// The native helper accepts only these operations. Its stdin is a private lifetime pipe, not runner stdin.
// For link, write the code once on that pipe. Only the helper gives it to the CLI as argv.
export function installedRunner({ stateDir, executable = process.execPath }) {
    const windows = process.platform === "win32";
    const nodeBin = dirname(executable);
    const install = join(nodeBin, ...(windows ? [".."] : ["..", ".."]));
    const helper = join(install, windows ? "runner-host.exe" : "runner-host");

    return (request, onLine) => {
        const { action } = request;

        if (!["link", "status", "start", "unlink"].includes(action) || !existsSync(helper)) {
            return { done: Promise.resolve(125), stop: () => Promise.resolve() };
        }

        const args = [stateDir, action];

        if (action === "link") {
            args.push(request.server, request.allowHttp ? "allow-http" : "tls");
        }

        const env = { ...process.env };
        const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

        env[pathKey] = [nodeBin, env[pathKey]].filter(Boolean).join(delimiter);

        // Do not let inherited Node hooks or a development tool daemon replace parts of the bundled runner.
        for (const key of Object.keys(env)) {
            if (
                ["NODE_OPTIONS", "NODE_PATH", "PI_POCKET_RUNNER_DAEMON"].includes(key.toUpperCase())
            ) {
                delete env[key];
            }
        }

        const child = spawn(helper, args, {
            cwd: homedir(),
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let failed = false;
        let expired = false;
        let deadline;
        const done = new Promise((resolve) => {
            child.on("error", () => {
                failed = true;
            });
            child.once("close", (code) => {
                clearTimeout(deadline);
                resolve(failed ? 125 : expired ? 124 : (code ?? 1));
            });
        });

        const stop = () => {
            child.stdin.end();

            return done;
        };

        child.stdout.on(
            "data",
            boundedLines((line) => onLine(line, true)),
        );
        child.stderr.on(
            "data",
            boundedLines((line) => onLine(line, false)),
        );
        child.stdin.on("error", () => {}); // The helper can finish before reading its pipe.

        if (action === "link") {
            child.stdin.write(`${request.code}\n`);
        }

        if (action !== "start") {
            deadline = setTimeout(() => {
                expired = true;
                void stop();
            }, 45_000);
            deadline.unref();
        }

        return { done, stop };
    };
}
