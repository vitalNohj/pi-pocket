/**
 * `pi-pocket runner`: lets a Pi Pocket server run sessions' tools on this computer.
 *
 * It starts Earendil's pi-env daemon here and connects out to the server over a WebSocket, so this computer needs no
 * open port, SSH, or provider key. The server sends pi-env requests (read a file, run a command); the daemon answers.
 * The link survives short drops (`protocol.ts`): the daemon keeps running, its answers wait here, and both sides send
 * again what the other missed.
 *
 * In a terminal, plain `pi-pocket runner` opens a menu: start, link, settings, the service, unlink, help. Each of
 * those is also a command for scripts, which never asks:
 *
 *   pi-pocket runner start                  run with the saved link (services and the desktop app run this)
 *   pi-pocket runner link <server> <code>   link this computer, with a code from Menu > Runners
 *   pi-pocket runner settings [name value]  show or change a setting: confirm on|off, http allow|refuse
 *   pi-pocket runner status                 show the link and its settings
 *   pi-pocket runner service [remove]       keep it running as a systemd user service (Linux)
 *   pi-pocket runner unlink                 forget the link
 *
 * Before a session starts here, the runner asks its person (setting `confirm`, on by default): on its terminal, or
 * through the desktop app (`--confirm-via stdio`). Plain HTTP to the server is refused unless it is this computer or a
 * device of this computer's tailnet, or the person allowed it (`transport.ts`).
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
import { createInterface } from "node:readline";
import { createInterface as createQuestions } from "node:readline/promises";
import { dirname, join } from "node:path";
import { pocketVersion } from "../server/versions.ts";
import {
    accent,
    bold,
    choose,
    type Choice,
    dim,
    green,
    interactive,
    onKeys,
    restoreTerminal,
    yellow,
} from "../launcher/term.ts";
import { LINK_CODE_PATH } from "./protocol.ts";
import {
    Runner,
    type RunnerLinkFile,
    type RunnerSettings,
    RunnerStopped,
    type SessionAnswer,
    type SessionQuestion,
} from "./runner.ts";
import { checkTransport, refusal, unsafe } from "./transport.ts";

const HELP = `pi-pocket runner: run session tools on this computer.

A Pi Pocket server keeps Pi, models, provider keys, and session history. Sessions
you start on this computer read and write files and run commands here, as your
user account. Only link a server you trust.

In a terminal, run pi-pocket runner for a menu. For scripts:

  pi-pocket runner start
    Run with the saved link. Services and the desktop app use this.
  pi-pocket runner link <server> <code> [--allow-http]
    Link this computer. Get a code in Pi Pocket: Menu > Runners > Link a computer.
    --allow-http also allows plain HTTP to that server (only on a network you trust).
  pi-pocket runner settings
    Show the settings. Change one with: pi-pocket runner settings <name> <value>
      confirm on|off       Ask here before a new session starts (default: on)
      http allow|refuse    Plain HTTP to a server that is not this computer or
                           on your tailnet (default: refuse)
  pi-pocket runner status
    Show the link, its settings, and the service.
  pi-pocket runner service
    Linux with systemd: keep the runner running after you close the terminal.
  pi-pocket runner service remove
    Stop and remove the service. Keep the saved link.
  pi-pocket runner unlink
    Delete the saved link. Also remove this computer in Menu > Runners.

Options:
  --config FILE       Link file (default: ~/.pi-pocket/runner.json)
  --confirm-via stdio For the desktop app: ask through stdin and stdout
  -h, --help          Show this help

Environment:
  PI_POCKET_RUNNER_CONFIG   Link file, unless --config is set
  PI_POCKET_RUNNER_DAEMON   Use this pi-env daemon instead of the packaged one

Plain HTTP is used only to this computer, or to a device on your tailnet as
Tailscale reports it. Anything else needs https://, or "http allow".`;

type Link = RunnerLinkFile;

/** The exit code when the server ended the link for good: starting it again would not help. */
export const STOPPED_BY_SERVER = 3;
/** The systemd user unit `service` writes. */
const UNIT = "pi-pocket-runner.service";
/** What the desktop app reads on stdout: a question (`CONFIRM`), and that it no longer stands (`CONFIRM-END`). */
const CONFIRM_LINE = "PI-POCKET-CONFIRM";
const CONFIRM_END_LINE = "PI-POCKET-CONFIRM-END";

/** A problem the person can fix and try again: the menu says it and goes on, the commands stop. */
class Problem extends Error {}

function fail(message: string): never {
    restoreTerminal();
    console.error(`pi-pocket runner: ${message}`);
    process.exit(1);
}

function log(line: string): void {
    const time = new Date().toLocaleTimeString([], { hour12: false });

    for (const each of line.split("\n")) {
        console.log(`[${time}] ${each}`);
    }
}

/** Take `--name value` out of `args`; undefined when absent. */
function option(args: string[], name: string, example: string): string | undefined {
    const at = args.indexOf(name);

    if (at < 0) {
        return undefined;
    }

    const value = args[at + 1];

    if (value === undefined || value.startsWith("--")) {
        fail(`${name} needs a value. Example: ${name} ${example}`);
    }

    args.splice(at, 2);

    return value;
}

// ─── The link file ──────────────────────────────────────────────────────

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

    throw new Problem(
        `${file} is not a valid link file. Move or remove it, then link this computer again.`,
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

/** The settings with their defaults filled in. */
function settingsOf(link: Link | undefined): Required<RunnerSettings> {
    return {
        confirm: link?.settings?.confirm !== false,
        allowHttp: link?.settings?.allowHttp === true,
    };
}

/** Change settings in the link file, keeping the rest. */
function changeSettings(file: string, change: RunnerSettings): Link {
    const saved = readLink(file);

    if (saved === undefined) {
        throw new Problem("This computer is not linked yet. Link it first.");
    }

    const next = { ...saved, settings: { ...saved.settings, ...change } };

    writeLink(file, next);

    return next;
}

// ─── Linking ────────────────────────────────────────────────────────────

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
async function redeem(server: string, code: string, settings: RunnerSettings): Promise<Link> {
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
            `${server} did not accept the code: ${message || response.statusText}\nMake a new code in Menu > Runners > Link a computer, then try again.`,
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
            `${server} returned an invalid link. Check the server address, then make a new code in Menu > Runners.`,
        );
    }

    return { server, id: got.id, name: got.name, key: got.key, settings };
}

/** `pi-pocket runner link <server> <code>`: no questions; plain HTTP only where `transport.ts` allows it. */
async function link(file: string, args: string[]): Promise<void> {
    // `--allow-http`: the person allowed plain HTTP to this server (the desktop app's switch); kept with the link.
    const allow = args.includes("--allow-http");
    const [given, code] = args.filter((arg) => arg !== "--allow-http");

    if (given === undefined || code === undefined) {
        fail(
            "Enter a server address and a one-time code.\nExample: pi-pocket runner link https://pocket.example.com ABCD-EFGH-JKLM\nIn a terminal, pi-pocket runner walks you through it.",
        );
    }

    try {
        const server = serverAddress(given);
        const saved = existsSync(file) ? settingsOf(readLink(file)) : settingsOf(undefined);
        const kept = allow ? { ...saved, allowHttp: true } : saved;
        const transport = await checkTransport(server, kept.allowHttp);

        if (!transport.ok) {
            throw new Problem(refusal(server, transport));
        }

        const got = await redeem(server, code, kept);

        writeLink(file, got);
        console.log(`Linked "${got.name}" to ${got.server}.`);
        console.log(`Link file: ${file}. It contains this computer's key. Do not share it.`);
        console.log("To start the runner, run: pi-pocket runner start");
    } catch (error) {
        fail((error as Error).message);
    }
}

// ─── Settings ───────────────────────────────────────────────────────────

/** The settings, one per line, as `settings` prints them and the desktop app reads them. */
function settingsLines(settings: Required<RunnerSettings>): string[] {
    return [
        `confirm ${settings.confirm ? "on" : "off"}`,
        `http ${settings.allowHttp ? "allow" : "refuse"}`,
    ];
}

/** `pi-pocket runner settings [name value]`: show the settings, or change one. */
function settingsCommand(file: string, args: string[]): void {
    const [name, value] = args;

    try {
        if (name === undefined) {
            if (readLink(file) === undefined) {
                throw new Problem("This computer is not linked yet. Link it first.");
            }

            console.log(settingsLines(settingsOf(readLink(file))).join("\n"));

            return;
        }

        if (name === "confirm" && (value === "on" || value === "off")) {
            changeSettings(file, { confirm: value === "on" });
            console.log(
                value === "on"
                    ? "This computer asks before a new session starts here."
                    : "Sessions start here without asking. Anyone allowed to start sessions on this computer can run commands as you.",
            );

            return;
        }

        if (name === "http" && (value === "allow" || value === "refuse")) {
            changeSettings(file, { allowHttp: value === "allow" });
            console.log(
                value === "allow"
                    ? "Plain HTTP to this server is allowed. Anyone on the network can read this computer's key and its commands."
                    : "Plain HTTP is used only to this computer or a device on your tailnet.",
            );

            return;
        }

        throw new Problem(
            "Use: pi-pocket runner settings confirm on|off, or: pi-pocket runner settings http allow|refuse",
        );
    } catch (error) {
        fail((error as Error).message);
    }
}

// ─── Asking before sessions ─────────────────────────────────────────────

/** In words: what would start, by whom, where. */
function describe(question: SessionQuestion): string {
    const what = question.kind === "fork" ? "a copy of a session" : "a new session";

    return `${question.person} wants to start ${what} on this computer.\n  Server: ${question.server}\n  Folder: ${question.folder}\n  The session can read and change files and run commands as you, also outside this folder.`;
}

/** Ask on this terminal, with the arrow keys; one question at a time. */
function terminalAsker(): (question: SessionQuestion) => Promise<SessionAnswer> {
    let queue = Promise.resolve();

    return (question) => {
        const answer = queue.then(async (): Promise<SessionAnswer> => {
            if (question.signal.aborted) {
                return { allow: false, reason: "Nobody answered in time." };
            }

            process.stdout.write("\x07");
            console.log("");
            console.log(yellow(`  ${describe(question)}`));
            console.log("");

            const picked = await choose(
                "Allow it?",
                [
                    { label: "Deny", detail: "the session does not start" },
                    { label: "Allow", detail: "start it on this computer" },
                ],
                0,
                { signal: question.signal, clear: true },
            );

            return picked === 1
                ? { allow: true }
                : {
                      allow: false,
                      reason: question.signal.aborted
                          ? "Nobody answered in time."
                          : "The person at this computer denied it.",
                  };
        });

        queue = answer.then(
            () => {},
            () => {},
        );

        return answer;
    };
}

/**
 * Ask through the desktop app: a `PI-POCKET-CONFIRM` line on stdout, the answer as a JSON line on stdin, and a
 * `PI-POCKET-CONFIRM-END` line when the question no longer stands.
 */
function stdioAsker(): (question: SessionQuestion) => Promise<SessionAnswer> {
    const waiting = new Map<number, (answer: SessionAnswer) => void>();
    let next = 1;

    createInterface({ input: process.stdin }).on("line", (line) => {
        try {
            const got = JSON.parse(line) as { id?: unknown; allow?: unknown };

            if (typeof got.id === "number" && typeof got.allow === "boolean") {
                waiting.get(got.id)?.(
                    got.allow
                        ? { allow: true }
                        : { allow: false, reason: "The person at this computer denied it." },
                );
            }
        } catch {
            // Not an answer.
        }
    });

    return (question) => {
        const id = next++;

        return new Promise<SessionAnswer>((resolve) => {
            const done = (answer: SessionAnswer) => {
                waiting.delete(id);
                question.signal.removeEventListener("abort", ended);
                resolve(answer);
            };

            const ended = () => {
                console.log(`${CONFIRM_END_LINE} ${JSON.stringify({ id })}`);
                done({ allow: false, reason: "Nobody answered in time." });
            };

            waiting.set(id, done);
            question.signal.addEventListener("abort", ended, { once: true });
            console.log(
                `${CONFIRM_LINE} ${JSON.stringify({
                    id,
                    server: question.server,
                    computer: question.computer,
                    person: question.person,
                    folder: question.folder,
                    kind: question.kind,
                })}`,
            );
        });
    };
}

// ─── Running ────────────────────────────────────────────────────────────

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
 * Run with the saved link until stopped. `via`: how to ask before sessions (this terminal, the desktop app, or
 * nobody: a service has no one to ask, so with asking on its sessions are refused, and it says so).
 */
async function serve(file: string, via: "terminal" | "stdio" | "none"): Promise<void> {
    let saved: Link | undefined;

    try {
        saved = readLink(file);
    } catch (error) {
        fail((error as Error).message);
    }

    if (saved === undefined) {
        fail("This computer is not linked. In a terminal, run: pi-pocket runner");
    }

    const ask = via === "terminal" ? terminalAsker() : via === "stdio" ? stdioAsker() : undefined;
    const runner = new Runner({
        link: saved,
        version: pocketVersion(),
        ...(process.env.PI_POCKET_RUNNER_DAEMON === undefined
            ? {}
            : { daemon: process.env.PI_POCKET_RUNNER_DAEMON }),
        log,
        // Read each time: `settings` from another terminal (or the desktop app) applies without a restart.
        settings: () => {
            try {
                return readLink(file)?.settings ?? {};
            } catch {
                return saved.settings ?? {};
            }
        },
        ...(ask === undefined ? {} : { ask }),
    });
    let stopping = false;

    const stop = () => {
        if (stopping) {
            process.exit(130);
        }

        stopping = true;
        restoreTerminal();
        log("Stopping the runner and its commands.");
        void runner.stop();
        setTimeout(() => process.exit(0), 3000).unref();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    // In a terminal the keys are raw (for the questions): Ctrl+C arrives as a key, not a signal.
    if (via === "terminal" && interactive) {
        onKeys((key) => key === "ctrl-c" && stop());
    }

    const current = settingsOf(saved);

    log(`pi-pocket runner ${pocketVersion()}: "${saved.name}", for ${saved.server}`);
    log(
        current.confirm
            ? via === "none"
                ? "Asking before new sessions is on, but nobody can answer here, so sessions are refused. To start them without asking, run: pi-pocket runner settings confirm off"
                : "Asks before a new session starts here."
            : "Starts new sessions without asking.",
    );

    if (via === "terminal") {
        log("Press Ctrl+C to stop.");
    }

    runner.start();

    try {
        await runner.finished;
    } catch (error) {
        restoreTerminal();

        if (error instanceof RunnerStopped) {
            console.error(`pi-pocket runner: ${error.message}`);
            process.exit(STOPPED_BY_SERVER);
        }

        throw error;
    }
}

// ─── The service ────────────────────────────────────────────────────────

/** `systemctl --user …`, its output shown; false when it failed. */
function systemctl(...args: string[]): boolean {
    return spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" }).status === 0;
}

/**
 * Keep the runner running as a systemd user service, with this Node, this Pi Pocket, this link file, and this PATH
 * (the tools sessions run find what this shell finds). Linux only: elsewhere, the person keeps the runner running
 * their own way, or the desktop app does.
 */
function service(file: string, args: string[]): void {
    if (!canService()) {
        fail(
            "The service command needs Linux with systemd. Keep the runner open in a terminal, or use the Pi Pocket desktop app.",
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

        return;
    }

    let saved: Link | undefined;

    try {
        saved = readLink(file);
    } catch (error) {
        fail((error as Error).message);
    }

    if (saved === undefined) {
        fail("This computer is not linked. In a terminal, run: pi-pocket runner");
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
            // `start`: it serves the saved link and never asks on a terminal.
            `ExecStart=${quote(process.execPath)} ${quote(launcher)} runner start --config ${quote(file)}`,
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
    console.log(
        `  To run while you are logged out: loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    );

    if (settingsOf(saved).confirm) {
        console.log(
            yellow(
                "  A service cannot ask before new sessions, so with asking on, sessions on this computer are refused.\n  To start them without asking: pi-pocket runner settings confirm off",
            ),
        );
    }
}

function status(file: string): string {
    const saved = readLink(file);

    if (saved === undefined) {
        return "This computer is not linked.\nIn a terminal, run pi-pocket runner to link it.";
    }

    const settings = settingsOf(saved);

    return [
        `Computer: ${saved.name}`,
        `Server: ${saved.server}`,
        `Link file: ${file}`,
        `Ask before new sessions: ${settings.confirm ? "on" : "off"}`,
        `Plain HTTP: ${settings.allowHttp ? "allowed to this server" : "only to this computer or your tailnet"}`,
        ...(serviceActive() ? [`Service: ${UNIT} (running)`] : []),
    ].join("\n");
}

// ─── The menu ───────────────────────────────────────────────────────────

/**
 * Read one line on the terminal, out of raw mode (so it echoes and edits as usual), then back: the menus' keys go on
 * where they were. An empty answer is the person going back.
 */
async function ask(question: string): Promise<string> {
    restoreTerminal();
    process.stdin.setEncoding("utf8");
    const lines = createQuestions({ input: process.stdin, output: process.stdout });

    try {
        return (await lines.question(`  ${question}: `)).trim();
    } finally {
        lines.close();
    }
}

/** Link through questions: the address, a check, the code. Undefined when the person gave up. */
async function linkInteractively(file: string): Promise<Link | undefined> {
    console.log("");
    console.log(bold("  Link this computer"));
    console.log(dim("  Empty answer to go back."));
    console.log("");

    let server = "";
    let settings: Required<RunnerSettings> = settingsOf(undefined);

    while (server === "") {
        const given = await ask(
            "Server address, as you open Pi Pocket in a browser (example: https://pocket.example.com)",
        );

        if (given === "") {
            return undefined;
        }

        try {
            server = serverAddress(given);

            const transport = await checkTransport(server, false);

            if (!transport.ok) {
                console.log("");
                console.log(yellow(`  ${unsafe(server, transport).replace(/\n/g, "\n  ")}`));
                console.log("");

                const picked = await choose(
                    "Plain HTTP to this server?",
                    [
                        {
                            label: "Enter another address",
                            detail: "https://, or one on your tailnet",
                        },
                        { label: "Allow plain HTTP", detail: "only on a network you trust" },
                    ],
                    0,
                    { clear: true },
                );

                if (picked !== 1) {
                    server = "";
                    continue;
                }

                settings = { ...settings, allowHttp: true };
            } else if (transport.why === "tailscale") {
                console.log(dim(`  ${server} is on your tailnet: plain HTTP is safe there.`));
            }

            await checkServer(server);
        } catch (error) {
            if (!(error instanceof Problem)) {
                throw error;
            }

            console.log(`  ${error.message.replace(/\n/g, "\n  ")}`);
            server = "";
        }
    }

    console.log(green(`  Found Pi Pocket at ${server}.`));
    console.log("");
    console.log("  In Pi Pocket, open Menu > Runners > Link a computer, name this computer,");
    console.log("  and choose Get a link code (Link another computer in the desktop app).");
    console.log(dim("  The code works once, for 10 minutes."));

    for (;;) {
        const code = await ask("One-time code (example: ABCD-EFGH-JKLM)");

        if (code === "") {
            return undefined;
        }

        try {
            const got = await redeem(server, code, settings);

            writeLink(file, got);
            console.log(green(`  Linked "${got.name}" to ${got.server}.`));
            console.log(
                dim(`  Link file: ${file}. It contains this computer's key. Do not share it.`),
            );

            return got;
        } catch (error) {
            if (!(error instanceof Problem)) {
                throw error;
            }

            console.log(`  ${error.message.replace(/\n/g, "\n  ")}`);
        }
    }
}

/** The settings, each toggled with Enter, until Back. */
async function settingsMenu(file: string): Promise<void> {
    let at = 0;

    for (;;) {
        const settings = settingsOf(readLink(file));
        const picked = await choose(
            "Runner settings",
            [
                {
                    label: `Ask before new sessions: ${settings.confirm ? "on" : "off"}`,
                    detail: settings.confirm
                        ? "this terminal or the desktop app asks first"
                        : "sessions start without asking",
                },
                {
                    label: `Allow plain HTTP: ${settings.allowHttp ? "on" : "off"}`,
                    detail: settings.allowHttp
                        ? "to this server, on any network"
                        : "only this computer and your tailnet",
                },
                { label: "Back", detail: "" },
            ],
            at,
            { clear: true },
        );

        if (picked === undefined || picked === 2) {
            return;
        }

        at = picked;

        if (picked === 0) {
            changeSettings(file, { confirm: !settings.confirm });
        } else {
            changeSettings(file, { allowHttp: !settings.allowHttp });
        }
    }
}

/** `pi-pocket runner` in a terminal: what is linked, and a menu of what to do. */
async function menu(file: string): Promise<void> {
    console.log("");
    console.log(`  ${accent("π")} ${bold("Pi Pocket runner")} ${dim(pocketVersion())}`);
    console.log(dim("  Run session tools on this computer, for a Pi Pocket server you trust."));

    for (;;) {
        let saved: Link | undefined;

        try {
            saved = readLink(file);
        } catch (error) {
            fail((error as Error).message);
        }

        const running = serviceActive();

        console.log("");
        console.log(
            saved === undefined
                ? `  ${yellow("Not linked yet.")}`
                : `  Linked as ${bold(saved.name)} to ${saved.server}${running ? green(" · running as a service") : ""}`,
        );
        console.log("");

        const choices: (Choice & { run: () => Promise<boolean> })[] =
            saved === undefined
                ? [
                      {
                          label: "Link this computer",
                          detail: "with a code from Menu > Runners",
                          run: async () => {
                              await linkInteractively(file);

                              return false;
                          },
                      },
                      {
                          label: "Help",
                          detail: "commands and options",
                          run: async () => {
                              console.log(`\n${HELP}`);

                              return false;
                          },
                      },
                      { label: "Quit", detail: "", run: async () => true },
                  ]
                : [
                      {
                          label: "Start",
                          detail: running
                              ? "already running as a service"
                              : "run here until Ctrl+C",
                          disabled: running,
                          run: async () => {
                              await serve(file, "terminal");

                              return true;
                          },
                      },
                      {
                          label: "Settings",
                          detail: "asking before sessions, plain HTTP",
                          run: async () => {
                              await settingsMenu(file);

                              return false;
                          },
                      },
                      ...(canService()
                          ? [
                                running
                                    ? {
                                          label: "Stop the service",
                                          detail: "keep the link",
                                          run: async () => {
                                              service(file, ["remove"]);

                                              return false;
                                          },
                                      }
                                    : {
                                          label: "Run as a service",
                                          detail: "keep running after this terminal closes",
                                          run: async () => {
                                              service(file, []);

                                              return false;
                                          },
                                      },
                            ]
                          : []),
                      {
                          label: "Link again",
                          detail: "replace the link with a new code",
                          run: async () => {
                              await linkInteractively(file);

                              return false;
                          },
                      },
                      {
                          label: "Unlink",
                          detail: "delete the link on this computer",
                          run: async () => {
                              const sure = await choose(
                                  `Unlink ${saved.name}?`,
                                  [
                                      { label: "Cancel", detail: "" },
                                      {
                                          label: "Unlink",
                                          detail: "also remove it in Menu > Runners on the server",
                                      },
                                  ],
                                  0,
                                  { clear: true },
                              );

                              if (sure === 1) {
                                  if (running) {
                                      service(file, ["remove"]);
                                  }

                                  rmSync(file, { force: true });
                                  console.log(
                                      "  Deleted the link. In Pi Pocket, also remove this computer in Menu > Runners.",
                                  );
                              }

                              return false;
                          },
                      },
                      {
                          label: "Help",
                          detail: "commands and options",
                          run: async () => {
                              console.log(`\n${HELP}`);

                              return false;
                          },
                      },
                      { label: "Quit", detail: "", run: async () => true },
                  ];

        const picked = await choose("What next?", choices, 0, { clear: true });

        if (picked === undefined) {
            break;
        }

        try {
            if (await choices[picked]!.run()) {
                break;
            }
        } catch (error) {
            if (!(error instanceof Problem)) {
                throw error;
            }

            console.log(`  ${error.message}`);
        }
    }

    restoreTerminal();
}

// ─── Commands ───────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
    const args = [...argv];

    if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
        console.log(HELP);

        return;
    }

    const file =
        option(args, "--config", "~/.pi-pocket/runner.json") ??
        process.env.PI_POCKET_RUNNER_CONFIG ??
        join(homedir(), ".pi-pocket", "runner.json");
    const via = option(args, "--confirm-via", "stdio");

    if (via !== undefined && via !== "stdio") {
        fail(`--confirm-via takes stdio, not "${via}".`);
    }

    const [command, ...rest] = args;

    switch (command) {
        case undefined:
            // A person at a terminal gets the menu; anything else (an older service, the desktop app) serves.
            return via === undefined && interactive ? menu(file) : serve(file, via ?? "none");
        case "start":
            return serve(file, via ?? (interactive ? "terminal" : "none"));
        case "serve":
            // Before the menu, `serve` walked through linking; it now opens the menu.
            return interactive ? menu(file) : serve(file, via ?? "none");
        case "link":
            return link(file, rest);
        case "settings":
            return settingsCommand(file, rest);
        case "status":
            try {
                console.log(status(file));
            } catch (error) {
                fail((error as Error).message);
            }

            return;
        case "service":
            return service(file, rest);
        case "unlink":
            rmSync(file, { force: true });
            console.log(
                "Deleted the saved link from this computer.\nIn Pi Pocket, also remove this computer from Menu > Runners to stop its runner and cancel its key.",
            );

            return;
        default:
            fail(`Unknown command "${command}".\n\n${HELP}`);
    }
}
