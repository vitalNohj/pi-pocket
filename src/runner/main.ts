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
 *   pi-pocket runner service [remove]       keep it running as a systemd user service (Linux)
 *
 * It exits with `STOPPED_BY_SERVER` when the server ends the link for good (the computer was removed, its key is
 * wrong): a service manager or the desktop app does not start it again then.
 */
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
  pi-pocket runner service                Linux: keep it running as a systemd user service
  pi-pocket runner service remove         Linux: stop and remove that service

Options:
  --config FILE   Where the link is kept (default ~/.pi-pocket/runner.json)
  -h, --help      Show this help

Environment: PI_POCKET_RUNNER_CONFIG, PI_POCKET_RUNNER_DAEMON (a pi-env daemon to use instead of the packaged one)

The server keeps the agent, models, keys, and history. This computer only runs the tools: files and commands in the
folders its sessions work in, as you. Anyone who can prompt those sessions can do what you can here.`;

type Link = RunnerLinkFile;

/** The exit code when the server ended the link for good: starting it again would not help. */
export const STOPPED_BY_SERVER = 3;
/** The systemd user unit `service` writes. */
const UNIT = "pi-pocket-runner.service";

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
    console.log(
        "Start it with: pi-pocket runner (or, on Linux, keep it running: pi-pocket runner service)",
    );
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
            console.error(`pi-pocket runner: ${error.message}`);
            process.exit(STOPPED_BY_SERVER);
        }

        throw error;
    }
}

/** `systemctl --user …`, its output shown; false when it failed. */
function systemctl(...args: string[]): boolean {
    return spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" }).status === 0;
}

/**
 * Keep the runner running as a systemd user service, with this Node, this Pi Pocket, this link file, and this PATH
 * (the tools sessions run find what this shell finds). Linux only: elsewhere, the person keeps `pi-pocket runner`
 * running their own way, or the desktop app does.
 */
function service(file: string, args: string[]): void {
    if (process.platform !== "linux" || spawnSync("systemctl", ["--version"]).status !== 0) {
        fail(
            "service needs Linux with systemd. Elsewhere, keep `pi-pocket runner` running yourself, or use the Pi Pocket desktop app.",
        );
    }

    const unit = join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "systemd",
        "user",
        UNIT,
    );

    if (args[0] === "remove") {
        systemctl("disable", "--now", UNIT);
        rmSync(unit, { force: true });
        systemctl("daemon-reload");
        console.log(`Removed ${UNIT}. The link stays: \`pi-pocket runner unlink\` forgets it.`);

        return;
    }

    if (readLink(file) === undefined) {
        fail("Not linked yet. Run: pi-pocket runner link <server> <code>");
    }

    const launcher = realpathSync(process.argv[1] ?? "");

    // npx's copy is a cache npm can clear: the service would stop starting.
    if (launcher.includes("_npx")) {
        fail(
            "This pi-pocket runs from npx's cache, which npm can clear. Install it first (npm install -g pi-pocket), then run: pi-pocket runner service",
        );
    }

    const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1")}"`;

    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(
        unit,
        [
            "[Unit]",
            "Description=Pi Pocket runner: runs a Pi Pocket server's session tools on this computer",
            "After=network-online.target",
            "Wants=network-online.target",
            "",
            "[Service]",
            `ExecStart=${quote(process.execPath)} ${quote(launcher)} runner --config ${quote(file)}`,
            `Environment=${quote(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}`,
            "Restart=on-failure",
            "RestartSec=5",
            // The server removed this computer, or its key is wrong: starting again would not help.
            `RestartPreventExitStatus=${String(STOPPED_BY_SERVER)}`,
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ].join("\n"),
    );

    if (!systemctl("daemon-reload") || !systemctl("enable", "--now", UNIT)) {
        fail(`Wrote ${unit}, but systemd did not start it. See: systemctl --user status ${UNIT}`);
    }

    console.log(`The runner runs as ${UNIT}, and starts with your session.`);
    console.log(`  Its log:  journalctl --user -u ${UNIT} -f`);
    console.log(
        `  To keep it running while you are logged out: loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    );
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

        case "service":
            return service(file, rest);

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
