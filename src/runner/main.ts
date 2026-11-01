/**
 * `pi-pocket runner`: lets a Pi Pocket server run sessions' tools on this computer.
 *
 * It starts Earendil's pi-env daemon here and connects out to the server over a WebSocket, so this computer needs no
 * open port, SSH, or provider key. The server sends pi-env requests (read a file, run a command); the daemon answers.
 * The link survives short drops (`protocol.ts`): the daemon keeps running, its answers wait here, and both sides send
 * again what the other missed.
 *
 *   pi-pocket runner link <server> <code>   link this computer, with a code from the server's Computers settings
 *   pi-pocket runner                        connect and serve, until stopped
 *   pi-pocket runner status                 show what this computer is linked to
 *   pi-pocket runner unlink                 forget the link
 */
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pocketVersion } from "../server/versions.ts";
import { LINK_CODE_PATH } from "./protocol.ts";
import { Runner, type RunnerLinkFile, RunnerStopped } from "./runner.ts";

const HELP = `pi-pocket runner: run a Pi Pocket server's sessions' tools on this computer.

Usage:
  pi-pocket runner link <server> <code>   Link this computer to a server, with a one-time code
                                          from its Settings > Computers > Link a computer
  pi-pocket runner                        Connect and serve until stopped (Ctrl+C)
  pi-pocket runner status                 Show the server this computer is linked to
  pi-pocket runner unlink                 Forget the link (remove the computer on the server too)

Options:
  --config FILE   Where the link is kept (default ~/.pi-pocket/runner.json)
  -h, --help      Show this help

Environment: PI_POCKET_RUNNER_CONFIG, PI_POCKET_RUNNER_DAEMON (a pi-env daemon to use instead of the packaged one)

The server keeps the agent, models, keys, and history. This computer only runs the tools: files and commands in the
folders its sessions work in, as you. Anyone who can prompt those sessions can do what you can here.`;

type Link = RunnerLinkFile;

function fail(message: string): never {
    console.error(`pi-pocket runner: ${message}`);
    process.exit(1);
}

function log(line: string): void {
    const time = new Date().toLocaleTimeString([], { hour12: false });

    console.log(`[${time}] ${line}`);
}

function configFile(args: string[]): string {
    const at = args.indexOf("--config");

    if (at >= 0) {
        const value = args[at + 1];

        if (value === undefined) {
            fail("--config needs a file");
        }

        args.splice(at, 2);

        return value;
    }

    return process.env.PI_POCKET_RUNNER_CONFIG ?? join(homedir(), ".pi-pocket", "runner.json");
}

function readLink(file: string): Link | undefined {
    if (!existsSync(file)) {
        return undefined;
    }

    try {
        const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Link>;

        if (
            typeof value.server === "string" &&
            typeof value.id === "string" &&
            typeof value.name === "string" &&
            typeof value.key === "string"
        ) {
            return value as Link;
        }
    } catch {
        // Below.
    }

    fail(`${file} is not a runner link. Remove it, then link again.`);
}

function writeLink(file: string, link: Link): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;

    writeFileSync(temp, `${JSON.stringify(link, null, "\t")}\n`, { mode: 0o600 });
    renameSync(temp, file);

    try {
        chmodSync(file, 0o600);
    } catch {
        // Windows: the file is in the person's own profile.
    }
}

/** The server's address as given: http(s) only, without a trailing slash. */
function serverAddress(given: string): string {
    let url: URL;

    try {
        url = new URL(given.includes("://") ? given : `http://${given}`);
    } catch {
        fail(`${given} is not a server address`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        fail(`${given}: use an http:// or https:// address`);
    }

    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/+$/, "");
}

async function link(file: string, args: string[]): Promise<void> {
    const [given, code] = args;

    if (given === undefined || code === undefined) {
        fail("Usage: pi-pocket runner link <server> <code>");
    }

    const server = serverAddress(given);
    let response: Response;

    try {
        response = await fetch(`${server}${LINK_CODE_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1" },
            body: JSON.stringify({ code }),
        });
    } catch (error) {
        fail(`Could not reach ${server}: ${(error as Error).message}`);
    }

    const text = await response.text();

    if (!response.ok) {
        let message = text;

        try {
            message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
            // As it is.
        }

        fail(`${server} refused the code: ${message || response.statusText}`);
    }

    const got = JSON.parse(text) as { id?: unknown; name?: unknown; key?: unknown };

    if (typeof got.id !== "string" || typeof got.name !== "string" || typeof got.key !== "string") {
        fail(`${server} did not answer as a Pi Pocket server`);
    }

    writeLink(file, { server, id: got.id, name: got.name, key: got.key });
    console.log(`Linked as "${got.name}" to ${server}. Its key is in ${file}.`);
    console.log("Start it with: pi-pocket runner");
}

async function serve(file: string): Promise<void> {
    const saved = readLink(file);

    if (saved === undefined) {
        fail(`Not linked yet. Run: pi-pocket runner link <server> <code>\n\n${HELP}`);
    }

    const runner = new Runner({
        link: saved,
        version: pocketVersion(),
        ...(process.env.PI_POCKET_RUNNER_DAEMON === undefined
            ? {}
            : { daemon: process.env.PI_POCKET_RUNNER_DAEMON }),
        log,
    });
    let stopping = false;

    const stop = () => {
        if (stopping) {
            process.exit(130);
        }

        stopping = true;
        log("Stopping.");
        void runner.stop();
        setTimeout(() => process.exit(0), 3000).unref();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    log(`pi-pocket runner ${pocketVersion()}: "${saved.name}", for ${saved.server}`);
    runner.start();

    try {
        await runner.finished;
    } catch (error) {
        if (error instanceof RunnerStopped) {
            fail(error.message);
        }

        throw error;
    }
}

export async function main(argv: string[]): Promise<void> {
    const args = [...argv];

    if (args.includes("-h") || args.includes("--help")) {
        console.log(HELP);

        return;
    }

    const file = configFile(args);
    const [command, ...rest] = args;

    switch (command) {
        case undefined:
        case "start":
            return serve(file);
        case "link":
            return link(file, rest);

        case "status": {
            const saved = readLink(file);

            console.log(
                saved === undefined
                    ? "Not linked. Run: pi-pocket runner link <server> <code>"
                    : `Linked as "${saved.name}" to ${saved.server} (${file}).`,
            );

            return;
        }

        case "unlink":
            rmSync(file, { force: true });
            console.log(
                "Forgot the link. Remove the computer on the server too, under Settings > Computers.",
            );

            return;
        default:
            fail(`Unknown command ${command}.\n\n${HELP}`);
    }
}
