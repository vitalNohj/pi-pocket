/**
 * `pi-pocket-runner`: lets a Pi Pocket server run sessions' tools on this computer. Where Pi Pocket is installed with
 * its runner, `pi-pocket runner` runs this same code (`invoked.ts`).
 *
 * It starts Earendil's pi-env daemon here and connects out to the server over a WebSocket, so this computer needs no
 * open port, SSH, or provider key. The server sends pi-env requests (read a file, run a command); the daemon answers.
 * The link survives drops of any length (`protocol.ts`): the daemon keeps running, its answers wait here, and both
 * sides send again what the other missed.
 *
 * In a terminal, plain `pi-pocket-runner` opens a menu: start, link, unlink, help. Each is also a command for scripts:
 *
 *   pi-pocket-runner start                  run with the saved link (also used by a program that runs the runner)
 *   pi-pocket-runner link <server> <code>   link this computer, with a code from Menu > Runners
 *   pi-pocket-runner status                 show the link
 *   pi-pocket-runner service [remove]       run as a service, task, or launch agent
 *   pi-pocket-runner unlink                 delete the link file
 *
 * After the link, this computer trusts its server, which is pinned by its key (`secure-link.ts`). The server decides who
 * may use which folder here, with each person's own authenticator code (Pi Pocket's `src/server/access.ts`); the
 * runner asks nobody. It keeps each request inside the folder of the session the server names (`request-gate.ts`).
 * Plain HTTP to the server is refused unless it is this computer or a device of this computer's tailnet, or the person
 * allowed it when linking (`transport.ts`).
 *
 * It exits with `STOPPED_BY_SERVER` when the server ends the link for good (the computer was removed, its key is
 * wrong): the desktop app does not start it again then.
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
import { homedir } from "node:os";
import { createInterface as createQuestions } from "node:readline/promises";
import { dirname, join } from "node:path";
import { runnerVersion } from "./version.ts";
import { ALONE, type Invoked } from "./invoked.ts";
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
} from "./term.ts";
import { LINK_CODE_PATH } from "./protocol.ts";
import { fingerprint, LinkProblem, linkWithCode, publicOf } from "./secure-link.ts";
import { Runner, type RunnerLinkFile, RunnerStopped } from "./runner.ts";
import { activityLine } from "./activity.ts";
import { checkTransport, pinnedLookup, refusal, unsafe } from "./transport.ts";
import { checkTools, toolsStatus } from "./tools.ts";
import {
    canService,
    installService,
    removeService,
    SERVICE_UNAVAILABLE,
    serviceActive,
    serviceExitCode,
    serviceHelp,
    serviceMenu,
    serviceName,
    STOPPED_BY_SERVER,
} from "./service.ts";

/** How this runner was started: `main` sets it first, for every text that names the command. */
let started: Invoked = ALONE;

/** The help, with the command as it was started. */
function help(): string {
    const command = started.command;

    return `${command}: run session tools on this computer.

A Pi Pocket server keeps Pi, models, provider keys, and session history. Sessions
started on this computer read and write files and run commands here, as your
user account. Only link a server you trust. Who may use this computer, and which
folders, is set in Pi Pocket: Menu > Runners.

In a terminal, run ${command} for a menu. For scripts:

  ${command} start
    Run with the saved link while this terminal or the desktop app is open.
  ${command} link <server> <code> [--allow-http]
    Link this computer. Get a code in Pi Pocket: Menu > Runners > Link a computer.
    --allow-http also allows plain HTTP to that server (only on a network you trust).
  ${command} status
    Show the link: the server, both keys, and this computer's tools.
${serviceHelp(command)}
  ${command} unlink
    Delete the saved link. Linking again needs a new link code from
    Menu > Runners. Also remove this computer there.

Options:
  --config FILE       Link file (default: ~/.pi-pocket/runner.json)
  --confirm-via stdio For a program that runs the runner, such as the desktop
                      app: say on stdout when sessions work here
                      (PI-POCKET-ACTIVITY)
  -h, --help          Show this help

Environment:
  PI_POCKET_RUNNER_CONFIG   Link file, unless --config is set
  PI_POCKET_RUNNER_DAEMON   Use this pi-env daemon instead of the packaged one

Plain HTTP is used only to this computer, or to a device on your tailnet as
Tailscale reports it. Anything else needs https://, or --allow-http.`;
}

type Link = RunnerLinkFile;

/** The exit code when the server ended the link for good: starting it again would not help. */
export { STOPPED_BY_SERVER } from "./service.ts";
const UNLINKED =
    "Deleted the saved link from this computer.\nTo link again, get a new link code in Pi Pocket: Menu > Runners > Link a computer.\nIn Pi Pocket, also remove this computer from Menu > Runners to stop its runner and cancel its key.";

/** A problem the person can fix and try again: the menu says it and goes on, the commands stop. */
class Problem extends Error {}

function fail(message: string): never {
    restoreTerminal();
    console.error(`${started.command}: ${message}`);
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
            // Linked before the secure link: its key was one the server also knew, and the server's own is unknown.
            if (typeof value.serverKey !== "string") {
                throw new Problem(
                    `This computer was linked by an older Pi Pocket runner, without the server's key. Link it again: in Menu > Runners, choose Link again on ${value.name}, then run ${started.command} link ${value.server} <code>. It keeps its sessions.`,
                );
            }

            return value as Link;
        }
    } catch (error) {
        if (error instanceof Problem) {
            throw error;
        }
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

/**
 * Link this computer to `server` with a one-time code (`secure-link.ts`): it makes this computer's key, proves the code
 * without sending it, and pins the server's key once the server proves it knows the code too.
 */
async function redeem(server: string, code: string, allowHttp: boolean): Promise<Link> {
    const lookup = pinnedLookup(await checkTransport(server, allowHttp));

    try {
        return {
            server,
            ...(await linkWithCode(`${server}${LINK_CODE_PATH}`, code, lookup)),
            ...(allowHttp ? { allowHttp: true } : {}),
        };
    } catch (error) {
        if (!(error instanceof LinkProblem)) {
            throw error;
        }

        switch (error.kind) {
            case "unreachable":
                throw new Problem(
                    `Could not reach ${server} (${error.message}). Check the address and network, then try again.`,
                );
            case "refused":
                // The server's message says what to do (a new code in Menu → Runners).
                throw new Problem(`${server} did not accept the code: ${error.message}`);
            case "invalid":
                throw new Problem(
                    `${server} returned an invalid link. Check the server address and update Pi Pocket there, then make a new code in Menu > Runners.`,
                );
            case "unproven":
                throw new Problem(
                    `${server} did not prove it made this code. Someone may be in the middle: nothing was saved. Check the address, then try again.`,
                );
        }
    }
}

/** What linking trusts, said where people link (the Runners sheet and the desktop app say it too). */
const TRUST =
    "This computer will trust the server fully. Sessions started here run commands and change\nfiles as your user, with everything you can reach. Nothing runs in a sandbox.";

/** `pi-pocket-runner link <server> <code>`: no questions; plain HTTP only where `transport.ts` allows it. */
async function link(file: string, args: string[]): Promise<void> {
    // `--allow-http`: the person allowed plain HTTP to this server (the desktop app's switch); kept with the link.
    const allow = args.includes("--allow-http");
    const [given, code] = args.filter((arg) => arg !== "--allow-http");

    if (given === undefined || code === undefined) {
        fail(
            `Enter a server address and a one-time code.\nExample: ${started.command} link https://pocket.example.com ABCD-EFGH-JKLM\nIn a terminal, ${started.command} walks you through it.`,
        );
    }

    try {
        const server = serverAddress(given);
        const transport = await checkTransport(server, allow);

        if (!transport.ok) {
            throw new Problem(refusal(server, transport, started.command));
        }

        const got = await redeem(server, code, allow);

        writeLink(file, got);
        console.log(`Linked "${got.name}" to ${got.server}.`);
        console.log(TRUST.replace(/\n/g, " "));
        console.log(`Link file: ${file}. It contains this computer's key. Do not share it.`);
        console.log(`To start the runner, run: ${started.command} start`);
    } catch (error) {
        fail((error as Error).message);
    }
}

// ─── Running ────────────────────────────────────────────────────────────

/** Run with the saved link until stopped; `stdio`: tell the program that runs it where sessions work. */
async function serve(
    file: string,
    via: "terminal" | "stdio" | "none",
    asService = false,
): Promise<void> {
    let saved: Link | undefined;

    try {
        saved = readLink(file);
    } catch (error) {
        fail((error as Error).message);
    }

    if (saved === undefined) {
        fail(`This computer is not linked. In a terminal, run: ${started.command}`);
    }

    const runner = new Runner({
        link: saved,
        version: runnerVersion(),
        command: started.command,
        ...(process.env.PI_POCKET_RUNNER_DAEMON === undefined
            ? {}
            : { daemon: process.env.PI_POCKET_RUNNER_DAEMON }),
        log,
        // For the program that runs it: whether sessions work here, and in which folders (`activity.ts`).
        ...(via === "stdio" ? { activity: (state) => console.log(activityLine(state)) } : {}),
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

    // In a terminal the keys may be raw (after the menu): Ctrl+C arrives as a key, not a signal.
    if (via === "terminal" && interactive) {
        onKeys((key) => key === "ctrl-c" && stop());
    }

    log(`${started.command} ${runnerVersion()}: "${saved.name}", for ${saved.server}`);
    log("Who may use this computer, and which folders, is set in Pi Pocket: Menu > Runners.");

    if (via === "terminal") {
        log("Press Ctrl+C to stop.");
    }

    runner.start();

    try {
        await runner.finished;
    } catch (error) {
        restoreTerminal();

        if (error instanceof RunnerStopped) {
            console.error(`${started.command}: ${error.message}`);
            process.exit(serviceExitCode(STOPPED_BY_SERVER, asService));
        }

        throw error;
    }
}

async function status(file: string): Promise<string> {
    const saved = readLink(file);
    const tools = toolsStatus(await checkTools(), process.platform);

    if (saved === undefined) {
        return `This computer is not linked.\nIn a terminal, run ${started.command} to link it.\n${tools}`;
    }

    return [
        `Computer: ${saved.name}`,
        `Server: ${saved.server}`,
        // As Menu > Runners shows them: each side's key, to compare by eye.
        `Server key: ${fingerprint(saved.serverKey)}`,
        `This computer's key: ${fingerprint(publicOf(saved.key))}`,
        `Link file: ${file}`,
        tools,
        `Plain HTTP: ${saved.allowHttp === true ? "allowed to this server" : "only to this computer or your tailnet"}`,
        ...(serviceActive() ? [`Service: ${serviceName()} (running)`] : []),
    ].join("\n");
}

// ─── The service ────────────────────────────────────────────────────────

/** Install or remove the platform's service (`service.ts`), keeping the saved link. */
function service(file: string, args: string[]): void {
    if (!canService()) {
        fail(SERVICE_UNAVAILABLE);
    }

    try {
        if (args[0] === "remove") {
            console.log(removeService(file));

            return;
        }

        const saved = readLink(file);

        if (saved === undefined) {
            fail(`This computer is not linked. In a terminal, run: ${started.command}`);
        }

        const messages = installService({
            node: process.execPath,
            launcher: realpathSync(process.argv[1] ?? ""),
            file,
            path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            home: homedir(),
            ...started,
        });

        for (const message of messages) {
            console.log(message);
        }
    } catch (error) {
        fail((error as Error).message);
    }
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
    console.log(yellow(`  ${TRUST.replace(/\n/g, "\n  ")}`));
    console.log(dim("  Empty answer to go back."));
    console.log("");

    let server = "";
    let allowHttp = false;

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

                allowHttp = true;
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
    console.log("  and choose Get a link code.");
    console.log(dim("  The code works once, for 10 minutes."));

    for (;;) {
        const code = await ask("One-time code (example: ABCD-EFGH-JKLM)");

        if (code === "") {
            return undefined;
        }

        try {
            const got = await redeem(server, code, allowHttp);

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

/** `pi-pocket-runner` in a terminal: what is linked, and a menu of what to do. */
async function menu(file: string): Promise<void> {
    console.log("");
    console.log(`  ${accent("π")} ${bold("Pi Pocket runner")} ${dim(runnerVersion())}`);
    console.log(dim("  Run session tools on this computer, for a Pi Pocket server you trust."));

    for (;;) {
        let saved: Link | undefined;

        try {
            saved = readLink(file);
        } catch (error) {
            fail((error as Error).message);
        }

        console.log("");
        console.log(
            saved === undefined
                ? `  ${yellow("Not linked yet.")}`
                : `  Linked as ${bold(saved.name)} to ${saved.server}`,
        );
        console.log("");

        const serviceLabels = serviceMenu();
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
                              console.log(`\n${help()}`);

                              return false;
                          },
                      },
                      { label: "Quit", detail: "", run: async () => true },
                  ]
                : [
                      {
                          label: "Start",
                          detail: "run here until Ctrl+C",
                          run: async () => {
                              await serve(file, "terminal");

                              return true;
                          },
                      },
                      ...(canService()
                          ? [
                                serviceActive()
                                    ? {
                                          label: serviceLabels.stop,
                                          detail: "keep the link",
                                          run: async () => {
                                              service(file, ["remove"]);

                                              return false;
                                          },
                                      }
                                    : {
                                          label: serviceLabels.start,
                                          detail: serviceLabels.detail,
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
                                          detail: "delete the link on this computer",
                                      },
                                  ],
                                  0,
                                  { clear: true },
                              );

                              if (sure === 1) {
                                  rmSync(file, { force: true });
                                  console.log(`  ${UNLINKED.replace(/\n/g, "\n  ")}`);
                              }

                              return false;
                          },
                      },
                      {
                          label: "Help",
                          detail: "commands and options",
                          run: async () => {
                              console.log(`\n${help()}`);

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

/** Run the runner with its own words, `argv`. `invoked`: how it was started (`invoked.ts`). */
export async function main(argv: string[], invoked: Invoked = ALONE): Promise<void> {
    started = invoked;
    const args = [...argv];

    if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
        console.log(help());

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
            // A person at a terminal gets the menu; the desktop app runs with stdio confirmation.
            return via === undefined && interactive ? menu(file) : serve(file, via ?? "none");
        case "start":
            return args.includes("--service")
                ? serve(file, "none", true)
                : serve(file, via ?? (interactive ? "terminal" : "none"));
        case "service":
            return service(file, rest);
        case "serve":
            // Before the menu, `serve` walked through linking; it now opens the menu.
            return interactive ? menu(file) : serve(file, via ?? "none");
        case "link":
            return link(file, rest);
        case "status":
            try {
                console.log(await status(file));
            } catch (error) {
                fail((error as Error).message);
            }

            return;
        case "unlink":
            // No code: unlinking only removes access.
            rmSync(file, { force: true });
            console.log(
                rest.includes("--json") ? JSON.stringify({ ok: true, unlinked: true }) : UNLINKED,
            );

            return;
        default:
            fail(`Unknown command "${command}".\n\n${help()}`);
    }
}
