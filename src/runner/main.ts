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

const HELP = `pi-pocket runner: run session tools on this computer.

Start here:
  pi-pocket runner serve

Commands:
  pi-pocket runner serve
    Link this computer or use a saved link, then start the runner.
  pi-pocket runner link <server> <code>
    Save a link without questions. Get a code from Menu > Computers.
  pi-pocket runner
    Run with the saved link. Does not ask questions.
  pi-pocket runner status
    Show the saved link and whether the service is running.
  pi-pocket runner unlink
    Delete the saved link. Also remove this computer in Menu > Computers.
  pi-pocket runner service
    Linux with systemd: start a service that runs after you close the terminal.
  pi-pocket runner service remove
    Stop and remove the service. Keep the saved link.

Example:
  pi-pocket runner link https://pocket.example.com ABCD-EFGH-JKLM

Options:
  --config FILE   Link file (default: ~/.pi-pocket/runner.json)
  -h, --help      Show this help

Environment:
  PI_POCKET_RUNNER_CONFIG   Link file, unless --config is set
  PI_POCKET_RUNNER_DAEMON   Use this pi-env daemon instead of the packaged one

The server keeps Pi, models, provider keys, and session history.
This computer reads and writes files and runs commands as your user account.
Only link a server you trust.
Only the person who linked this computer can start sessions on it.
Sessions are private by default. The owner can turn on
"Let others use these sessions" in Menu > Computers.`;

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
            fail("--config needs a file path. Example: --config ~/.pi-pocket/runner.json");
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

    fail(
        `${file} is not a valid link file. Move or remove that file, then run: pi-pocket runner serve`,
    );
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
        throw new Problem(
            `Could not reach ${server} (${(error as Error).message}). Check the address and network, then try again.`,
        );
    }

    const info = (await response.json().catch(() => undefined)) as { name?: unknown } | undefined;

    if (!response.ok || info?.name !== "pi-pocket") {
        throw new Problem(
            `Pi Pocket did not answer at ${server} (HTTP ${String(response.status)}). Use the address that opens Pi Pocket in your browser.`,
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
        throw new Problem(
            `Could not reach ${server} (${(error as Error).message}). Check the address and network, then try again.`,
        );
    }

    const text = await response.text();

    if (!response.ok) {
        let message = text;

        try {
            message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
            // As it is.
        }

        throw new Problem(
            `${server} did not accept the code: ${message || response.statusText}\n  Make a new code in Menu > Computers > Link a computer, then try again.`,
        );
    }

    let got: { id?: unknown; name?: unknown; key?: unknown } = {};

    try {
        got = JSON.parse(text) as typeof got;
    } catch {
        // Below.
    }

    if (typeof got.id !== "string" || typeof got.name !== "string" || typeof got.key !== "string") {
        throw new Problem(
            `${server} returned an invalid link. Check the server address, then make a new code in Menu > Computers.`,
        );
    }

    return { server, id: got.id, name: got.name, key: got.key };
}

/** The server's address as given: http(s) only, without a trailing slash. */
function serverAddress(given: string): string {
    let url: URL;

    try {
        url = new URL(given.includes("://") ? given : `http://${given}`);
    } catch {
        throw new Problem(
            `"${given}" is not a server address. Enter an address such as https://pocket.example.com.`,
        );
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Problem(
            `"${given}" is not an HTTP address. Use http:// or https:// (example: https://pocket.example.com).`,
        );
    }

    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/+$/, "");
}

async function link(file: string, args: string[]): Promise<void> {
    const [given, code] = args;

    if (given === undefined || code === undefined) {
        fail(
            "Enter a server address and a one-time code.\nExample: pi-pocket runner link https://pocket.example.com ABCD-EFGH-JKLM\nFor step-by-step setup, run: pi-pocket runner serve",
        );
    }

    try {
        const got = await redeem(serverAddress(given), code);

        writeLink(file, got);
        console.log(`Linked "${got.name}" to ${got.server}.`);
        console.log(`Link file: ${file}. It contains this computer's key. Do not share it.`);
        console.log("To start the runner, run: pi-pocket runner serve");
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
            const answer = (
                await lines.question(
                    `${question}\n  Type y or n (example: n; Enter for ${yes ? "y" : "n"}): `,
                )
            )
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

    console.log("Pi Pocket runner: run session tools on this computer.");
    console.log("Commands run as your user account. Only link a server you trust.");
    console.log("");

    if (saved !== undefined) {
        console.log(`Saved link: "${saved.name}" on ${saved.server}`);
        console.log(`Link file: ${file}`);

        if (serviceActive()) {
            console.log("");
            console.log(`The runner is already running as ${UNIT}.`);
            console.log("A second runner with this link would replace it.");
            console.log(`  View logs: journalctl --user -u ${UNIT} -f`);
            console.log("  Stop the service: pi-pocket runner service remove");
            terminal.close();

            return;
        }

        console.log("");

        if (!(await terminal.yes("Use this saved link?"))) {
            saved = undefined;
        }
    }

    if (saved === undefined) {
        console.log("Link this computer to Pi Pocket:");

        let server = "";

        while (server === "") {
            try {
                server = serverAddress(
                    await terminal.ask(
                        "  Type the server address (example: https://pocket.example.com)",
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
        console.log("  In Pi Pocket, open Menu > Computers > Link a computer.");
        console.log("  Enter a name for this computer. Choose Get a link code in a browser,");
        console.log("  or Link another computer in the desktop app.");
        console.log("  The code works once and expires after 10 minutes.");

        while (saved === undefined) {
            const code = await terminal.ask("  Paste the one-time code (example: ABCD-EFGH-JKLM)");

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
        console.log(`  Linked "${saved.name}" to ${saved.server}.`);
        console.log(`  Link file: ${file}. It contains this computer's key. Do not share it.`);
        console.log("");

        if (
            canService() &&
            (await terminal.yes(
                "Keep the runner running after you close this terminal (systemd user service)?",
            ))
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
        fail("This computer is not linked. In a terminal, run: pi-pocket runner serve");
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
        log("Stopping the runner and its commands.");
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
            "The service command needs Linux with systemd. Keep pi-pocket runner open in a terminal, or use the Pi Pocket desktop app.",
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
        console.log(`Stopped and removed ${UNIT}. The saved link is still in ${file}.`);
        console.log("To delete the saved link, run: pi-pocket runner unlink");

        return;
    }

    if (readLink(file) === undefined) {
        fail("This computer is not linked. To link it, run: pi-pocket runner serve");
    }

    const launcher = realpathSync(process.argv[1] ?? "");

    // npx's copy is a cache npm can clear: the service would stop starting.
    if (launcher.includes("_npx")) {
        fail(
            "A service cannot use Pi Pocket from the npx cache. Install it with: npm install -g pi-pocket@latest\nThen run: pi-pocket runner service",
        );
    }

    const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1")}"`;

    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(
        unit,
        [
            "[Unit]",
            "Description=Pi Pocket runner: run session tools on this computer",
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
        fail(
            `The service file is in ${unit}, but the runner did not start. Check the error with: systemctl --user status ${UNIT}`,
        );
    }

    console.log(`The runner is running as ${UNIT}. It starts with your user session.`);
    console.log(`  View logs: journalctl --user -u ${UNIT} -f`);
    console.log("  Stop the service: pi-pocket runner service remove");
    console.log(
        `  To run while you are logged out: loginctl enable-linger ${process.env.USER ?? "$USER"}`,
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
                    ? "This computer is not linked.\nTo link it, run: pi-pocket runner serve"
                    : `Computer: ${saved.name}\nServer: ${saved.server}\nLink file: ${file}${serviceActive() ? `\nService: ${UNIT} (running)` : ""}`,
            );

            return;
        }

        case "service":
            return service(file, rest);

        case "unlink":
            rmSync(file, { force: true });
            console.log(
                "Deleted the saved link from this computer.\nIn Pi Pocket, also remove this computer from Menu > Computers to stop its runner and cancel its key.",
            );

            return;
        default:
            fail(`Unknown command "${command}". Choose a command below.\n\n${HELP}`);
    }
}
