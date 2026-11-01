/**
 * `pi-pocket runner`: lets a Pi Pocket server run sessions' tools on this computer.
 *
 * It starts Earendil's pi-env daemon here and connects out to the server over a WebSocket, so this computer needs no
 * open port, SSH, or provider key. The server sends pi-env requests (read a file, run a command); the daemon answers.
 * The link survives short drops (`protocol.ts`): the daemon keeps running, its answers wait here, and both sides send
 * again what the other missed.
 *
 *   pi-pocket runner serve                  walks through linking (or shows the saved link), then serves until stopped
 *   pi-pocket runner link <server> <code>   link this computer without questions, with a code from Computers
 *   pi-pocket runner                        serve with the saved link, without questions (services, the desktop app)
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
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { pocketVersion } from "../server/versions.ts";
import { LINK_CODE_PATH } from "./protocol.ts";
import { Runner, type RunnerLinkFile, RunnerStopped } from "./runner.ts";

const HELP = `pi-pocket runner: run a Pi Pocket server's sessions' tools on this computer.

Usage:
  pi-pocket runner serve                  Start here. Walks you through linking this computer to a
                                          server (or shows the saved link), then serves until Ctrl+C
  pi-pocket runner link <server> <code>   Link without questions, with a one-time code from the
                                          server's Menu > Computers > Link a computer
  pi-pocket runner                        Serve with the saved link, without questions
  pi-pocket runner status                 Show the server this computer is linked to
  pi-pocket runner unlink                 Forget the link (remove the computer on the server too)
  pi-pocket runner service                Linux: keep it running as a systemd user service
  pi-pocket runner service remove         Linux: stop and remove that service

Options:
  --config FILE   Where the link is kept (default ~/.pi-pocket/runner.json)
  -h, --help      Show this help

Environment: PI_POCKET_RUNNER_CONFIG, PI_POCKET_RUNNER_DAEMON (a pi-env daemon to use instead of the packaged one)

The server keeps the agent, models, keys, and history. This computer only runs the tools: files and commands in the
folders its sessions work in, as you. Only the person who linked this computer can start, see, or prompt those
sessions; nobody else on the server can.`;

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

/** A problem the person can fix and try again: the walk-through asks again, the plain commands stop. */
class Problem extends Error {}

/** Whether a Pi Pocket server answers at `server`: its `/api/pocket/info`. */
async function checkServer(server: string): Promise<void> {
    let response: Response;

    try {
        response = await fetch(`${server}/api/pocket/info`, {
            signal: AbortSignal.timeout(10_000),
        });
    } catch (error) {
        throw new Problem(`Could not reach ${server}: ${(error as Error).message}`);
    }

    const info = (await response.json().catch(() => undefined)) as { name?: unknown } | undefined;

    if (!response.ok || info?.name !== "pi-pocket") {
        throw new Problem(
            `${server} answered, but not as Pi Pocket (HTTP ${String(response.status)}). Use the address that opens Pi Pocket in your browser.`,
        );
    }
}

/** Trade a one-time code for this computer's link to `server`. */
async function redeem(server: string, code: string): Promise<Link> {
    let response: Response;

    try {
        response = await fetch(`${server}${LINK_CODE_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1" },
            body: JSON.stringify({ code: code.trim() }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (error) {
        throw new Problem(`Could not reach ${server}: ${(error as Error).message}`);
    }

    const text = await response.text();

    if (!response.ok) {
        let message = text;

        try {
            message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
            // As it is.
        }

        throw new Problem(`${server} refused the code: ${message || response.statusText}`);
    }

    let got: { id?: unknown; name?: unknown; key?: unknown } = {};

    try {
        got = JSON.parse(text) as typeof got;
    } catch {
        // Below.
    }

    if (typeof got.id !== "string" || typeof got.name !== "string" || typeof got.key !== "string") {
        throw new Problem(`${server} did not answer as a Pi Pocket server.`);
    }

    return { server, id: got.id, name: got.name, key: got.key };
}

/** The server's address as given: http(s) only, without a trailing slash. */
function serverAddress(given: string): string {
    let url: URL;

    try {
        url = new URL(given.includes("://") ? given : `http://${given}`);
    } catch {
        throw new Problem(`${given} is not a server address.`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Problem(`${given}: use an http:// or https:// address.`);
    }

    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/+$/, "");
}

async function link(file: string, args: string[]): Promise<void> {
    const [given, code] = args;

    if (given === undefined || code === undefined) {
        fail(
            "Usage: pi-pocket runner link <server> <code>   (or: pi-pocket runner serve, which asks)",
        );
    }

    try {
        const got = await redeem(serverAddress(given), code);

        writeLink(file, got);
        console.log(`Linked as "${got.name}" to ${got.server}. Its key is in ${file}.`);
        console.log("Start it with: pi-pocket runner serve");
    } catch (error) {
        fail((error as Error).message);
    }
}

/** Questions on the terminal; Ctrl+C or the end of input leaves. */
function asker() {
    const lines = createInterface({ input: process.stdin, output: process.stdout });

    lines.on("SIGINT", () => {
        console.log("");
        process.exit(130);
    });
    lines.on("close", () => {
        if (!closing) {
            console.log("");
            process.exit(130);
        }
    });

    let closing = false;

    return {
        ask: async (question: string, given = ""): Promise<string> =>
            (await lines.question(`${question}${given === "" ? "" : ` [${given}]`}: `)).trim() ||
            given,
        yes: async (question: string, yes = true): Promise<boolean> => {
            const answer = (await lines.question(`${question} ${yes ? "[Y/n]" : "[y/N]"}: `))
                .trim()
                .toLowerCase();

            return answer === "" ? yes : answer.startsWith("y");
        },
        close: () => {
            closing = true;
            lines.close();
        },
    };
}

/** Whether the runner runs as the systemd user service already. */
function serviceActive(): boolean {
    return (
        process.platform === "linux" &&
        spawnSync("systemctl", ["--user", "is-active", "--quiet", UNIT]).status === 0
    );
}

function canService(): boolean {
    return process.platform === "linux" && spawnSync("systemctl", ["--version"]).status === 0;
}

/**
 * `pi-pocket runner serve`: shows the saved link, or walks through making one (the server's address, then a code
 * from its Computers sheet), then serves. Without a terminal it serves the saved link, as `pi-pocket runner` does.
 */
async function walkThrough(file: string): Promise<void> {
    if (!process.stdin.isTTY) {
        return serve(file);
    }

    const terminal = asker();
    let saved = readLink(file);

    console.log("Pi Pocket runner: a Pi Pocket server runs its sessions' tools on this computer.");
    console.log("");

    if (saved !== undefined) {
        console.log(`Saved link: "${saved.name}" on ${saved.server}`);
        console.log(`  kept in ${file}`);

        if (serviceActive()) {
            console.log("");
            console.log(`It already runs as ${UNIT}; a second runner here would take its place.`);
            console.log(`  Its log:  journalctl --user -u ${UNIT} -f`);
            console.log("  To stop it: pi-pocket runner service remove");
            terminal.close();

            return;
        }

        console.log("");

        if (!(await terminal.yes("Use it?"))) {
            saved = undefined;
        }
    }

    if (saved === undefined) {
        console.log("Link this computer to your server:");

        let server = "";

        while (server === "") {
            try {
                server = serverAddress(
                    await terminal.ask(
                        "  Server address, as this computer reaches it (e.g. https://pocket.example.com)",
                    ),
                );
                await checkServer(server);
            } catch (error) {
                if (!(error instanceof Problem)) {
                    throw error;
                }

                console.log(`  ${error.message}`);
                server = "";
            }
        }

        console.log(`  Found Pi Pocket at ${server}.`);
        console.log("");
        console.log("  In Pi Pocket, open Menu > Computers > Link a computer, name this computer,");
        console.log("  and choose Link another computer (Make a link code in a browser).");

        while (saved === undefined) {
            const code = await terminal.ask("  The code it shows");

            if (code === "") {
                continue;
            }

            try {
                saved = await redeem(server, code);
            } catch (error) {
                if (!(error instanceof Problem)) {
                    throw error;
                }

                console.log(`  ${error.message}`);
            }
        }

        writeLink(file, saved);
        console.log(`  Linked as "${saved.name}". The key is in ${file}.`);
        console.log("");

        if (
            canService() &&
            (await terminal.yes("Keep it running as a service that starts with this computer?"))
        ) {
            terminal.close();
            service(file, []);

            return;
        }
    }

    terminal.close();
    console.log("");

    return serve(file);
}

async function serve(file: string): Promise<void> {
    const saved = readLink(file);

    if (saved === undefined) {
        fail("Not linked yet. Run pi-pocket runner serve in a terminal: it walks you through it.");
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
        fail("Not linked yet. Run pi-pocket runner serve first: it walks you through it.");
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
            // Plain `runner`: it serves the saved link and never asks.
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
        case "serve":
            return walkThrough(file);
        case undefined:
        case "start":
            return serve(file);
        case "link":
            return link(file, rest);

        case "status": {
            const saved = readLink(file);

            console.log(
                saved === undefined
                    ? "Not linked. Run: pi-pocket runner serve"
                    : `Linked as "${saved.name}" to ${saved.server} (${file}).${serviceActive() ? ` Runs as ${UNIT}.` : ""}`,
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
