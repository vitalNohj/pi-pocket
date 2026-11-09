/**
 * The runner's work: start the pi-env daemon here, keep a link to the server, and relay pi-env frames both ways.
 * `main.ts` runs it from the command line; tests run it in the same process.
 *
 * The link survives drops of any length (`protocol.ts`). While it is down, the daemon keeps running, the runner pings it
 * itself, and its output waits here (reading stops when too much waits, as a full pipe would). When the server answers
 * again, both sides send what the other missed. When the server does not know the session anymore (it restarted), the
 * runner stops the daemon, which stops what it ran, and starts a new one.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import { WebSocket as RawWebSocket } from "ws";
import { CLOSE_IDENTITY, RunnerLinkSocket } from "./secure-link.ts";
import { checkTransport, refusal, type Transport } from "./transport.ts";

/** The link to the server, sealed with the link's keys (`secure-link.ts`). */
type WebSocket = RunnerLinkSocket;
const WebSocket = { OPEN: RawWebSocket.OPEN } as const;

import { checkTools } from "./tools.ts";
import { realFolder } from "./folders.ts";
import { Activity, type ActivityOptions, type ActivityState } from "./activity.ts";
import { RequestGate, sessionScope } from "./request-gate.ts";
import { Tasks } from "./tasks.ts";
import type { RunnerSettingsMessage, RunnerTools, TaskRequest, TaskResult } from "./protocol.ts";
import {
    CLOSE,
    type ControlMessage,
    FRAME,
    FrameSplitter,
    frame,
    Inbox,
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    MAX_MESSAGE,
    type NetOpen,
    Outbox,
    parseControl,
    readStreamData,
    STREAM_DATA,
} from "./protocol.ts";
import { CONNECT_MS, MAX_STREAMS, StreamLink } from "./tunnels.ts";

/** Daemon pings, as pi-env's own client sends them: it stops everything after 30 s without a byte. */
const DAEMON_PING_MS = 5000;

/** Send an acknowledgement once this many bytes came in, or within ACK_MS. */
const ACK_BYTES = 256 * 1024;
const ACK_MS = 1000;

/** Stop reading the daemon's output while this much waits for the server, as a full pipe would (pi-env pauses). */
const OUTBOX_LIMIT = 32 * 1024 * 1024;

/** Reconnect waits, growing from the first to the last. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];
/** How long git and GitHub readiness is kept between connections (an install or a sign-in shows after this). */
const TOOLS_FOR_MS = 5 * 60_000;

/** WebSocket pings to the server; a link that answers none for SILENT_MS is closed and made again. */
const PING_MS = 10_000;
const SILENT_MS = 30_000;

/** What a runner needs to connect: kept in `runner.json` by `pi-pocket runner link`. */
export type RunnerLinkFile = {
    server: string;
    id: string;
    name: string;
    /** This computer's own private key for the link (`secure-link.ts`), PKCS#8 DER, base64url. Never sent. */
    key: string;
    /** The server's public key, pinned when this computer linked: a server without its private key is refused. */
    serverKey: string;
    /** Plain HTTP to this server, allowed when this computer linked (`--allow-http`). Needed before it connects. */
    allowHttp?: boolean;
};

/**
 * This computer's settings, kept on the server and sent with `runner-settings` (`protocol.ts`). Only `allowHttp` is
 * kept here, in the link file: the runner needs it before it can reach the server.
 */
export type RunnerSettings = {
    /** Use plain HTTP to this server even where it is not this computer or a tailnet device. Default: false. */
    allowHttp?: boolean;
    /** Open the network connections of sessions' browsers from this computer. Default: true. */
    network?: boolean;
    /** Where sessions' browser downloads go, an absolute folder: `<folder>/<session>/`. Default: the temporary folder. */
    downloads?: string;
};

export type RunnerOptions = {
    link: RunnerLinkFile;
    version: string;
    /** The pi-env daemon to start; default the one packaged for this computer. */
    daemon?: string;
    /** The folder the daemon starts in; default the home folder. */
    cwd?: string;
    log?: (line: string) => void;
    /** Reconnect waits; tests make them short. */
    retryMs?: readonly number[];
    /** Check the server's transport before each connect; tests and HTTPS skip it. Default: `checkTransport`. */
    transport?: (server: string, allowHttp: boolean) => Promise<Transport>;
    /** Told when sessions start or stop working on this computer, and where (`activity.ts`). */
    activity?: (state: ActivityState) => void;
    /** Smoothing of `activity`; tests shorten it. */
    activityTiming?: Omit<ActivityOptions, "now">;
};

/** Why a runner stopped for good: the server removed it, another one took its place, or the protocols differ. */
export class RunnerStopped extends Error {}

/** The pi-env daemon on this computer: started with a fresh token, its output read after its sync line. */
class Daemon {
    readonly child: ChildProcessWithoutNullStreams;
    readonly exited: Promise<number | null>;
    #synced = false;
    #pending: Buffer[] = [];
    readonly #token = randomBytes(16).toString("hex");
    readonly #ping: NodeJS.Timeout;

    constructor(
        program: string,
        cwd: string,
        log: (line: string) => void,
        onOutput: (bytes: Buffer) => void,
    ) {
        this.child = spawn(program, ["serve", "--token", this.#token], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.exited = new Promise((resolve) => {
            this.child.once("exit", (code) => resolve(code));
            this.child.once("error", (error) => {
                log(
                    `The tool process could not start: ${error.message}\nCheck PI_POCKET_RUNNER_DAEMON, or reinstall Pi Pocket.`,
                );
                resolve(null);
            });
        });
        this.child.stdin.on("error", () => {});
        this.child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();

            if (text !== "") {
                log(`Tool process: ${text}`);
            }
        });
        this.child.stdout.on("data", (chunk: Buffer) => {
            if (this.#synced) {
                onOutput(chunk);

                return;
            }

            // Shell startup files may print before the daemon runs: skip everything before its sync line.
            this.#pending.push(chunk);

            const all = Buffer.concat(this.#pending);
            const marker = Buffer.from(`PI-ENV ${this.#token}\n`, "utf8");
            const at = all.indexOf(marker);

            if (at === -1) {
                this.#pending = [all.subarray(Math.max(0, all.length - marker.length))];

                return;
            }

            this.#synced = true;
            this.#pending = [];

            const rest = all.subarray(at + marker.length);

            if (rest.length > 0) {
                onOutput(rest);
            }
        });
        this.#ping = setInterval(() => this.write(frame(FRAME.ping, 0, {})), DAEMON_PING_MS);
        this.#ping.unref();
    }

    /** Write whole frames only: the runner's pings go between them. */
    write(bytes: Buffer): void {
        if (this.child.exitCode === null && !this.child.stdin.destroyed) {
            this.child.stdin.write(bytes);
        }
    }

    pause(): void {
        this.child.stdout.pause();
    }

    resume(): void {
        this.child.stdout.resume();
    }

    /** Stop it: it kills every process group it started when its input ends. */
    stop(): Promise<number | null> {
        clearInterval(this.#ping);
        this.child.stdin.end();

        const timer = setTimeout(() => this.child.kill(), 2000);

        timer.unref();
        void this.exited.then(() => clearTimeout(timer));

        return this.exited;
    }
}

/** One daemon and its link session with the server: what both sides keep across drops. */
class Session {
    readonly outbox = new Outbox();
    readonly inbox = new Inbox();
    readonly splitter = new FrameSplitter();
    readonly daemon: Daemon;
    readonly outputFrames = new FrameSplitter();
    gate!: RequestGate;
    /** The server's id for it, once welcomed. */
    id: string | null = null;
    paused = false;

    constructor(
        make: (onOutput: (bytes: Buffer) => void) => Daemon,
        onOutput: (session: Session, bytes: Buffer) => void,
    ) {
        this.daemon = make((bytes) => onOutput(this, bytes));
    }
}

export class Runner {
    readonly #options: RunnerOptions;
    #toolsChecked: { at: number; tools: Promise<RunnerTools> } | undefined;
    readonly #url: URL;
    readonly #log: (line: string) => void;
    readonly #retry: readonly number[];
    #socket: WebSocket | undefined;
    #session!: Session;
    #stopping = false;
    readonly #tasks: Tasks;
    /** Starts are replayed after reconnects, once per id for this runner's lifetime. */
    readonly #taskResults = new Map<string, Promise<TaskResult>>();
    /** Whether sessions work on this computer now, and where (`activity.ts`). */
    readonly #activity: Activity;
    /** This computer's settings, as the server last sent them (`runner-settings`). */
    #server: Omit<RunnerSettingsMessage, "type"> = { network: true };
    #attempt = 0;
    #ackTimer: NodeJS.Timeout | undefined;
    #retryTimer: NodeJS.Timeout | undefined;
    /** Why the last connect was refused before it began (`transport.ts`), so it is said once. */
    #refused: string | undefined;
    /** The network streams of the current connection. */
    #streams: StreamLink | undefined;
    /** Network connections opened so far, for tests. */
    opened = 0;
    /** Network connections still connecting, by stream id. */
    readonly #connecting = new Map<number, Socket>();
    #done!: (error?: Error) => void;
    /** Settles when the runner stops: resolves after `stop()`, rejects with `RunnerStopped` when the server ends it. */
    readonly finished: Promise<void>;

    constructor(options: RunnerOptions) {
        this.#options = options;
        this.#activity = new Activity((state) => options.activity?.(state), options.activityTiming);
        this.#log = options.log ?? (() => {});
        this.#tasks = new Tasks((scope, cwd) => this.#session.gate.task(scope, cwd), this.#log);
        this.#retry = options.retryMs ?? RETRY_MS;
        this.#url = new URL(options.link.server);
        this.#url.protocol = this.#url.protocol === "https:" ? "wss:" : "ws:";
        this.#url.pathname = `${this.#url.pathname.replace(/\/+$/, "")}${LINK_PATH}`;
        this.finished = new Promise<void>((resolve, reject) => {
            this.#done = (error) => {
                // Stopped: nothing works here any more, said at once.
                this.#activity.stop();

                if (error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            };
        });
        this.finished.catch(() => {});
    }

    /** Whether a link to the server is up and welcomed. */
    /** This computer's settings, as the server last sent them: for its status, and tests. */
    get settings(): Omit<RunnerSettingsMessage, "type"> {
        return this.#server;
    }

    get connected(): boolean {
        return this.#socket?.readyState === WebSocket.OPEN && this.#session?.id !== null;
    }

    /** The daemon's process id, for tests. */
    get daemonPid(): number | undefined {
        return this.#session?.daemon.child.pid;
    }

    start(): void {
        this.#session = this.#fresh();
        this.#connect();
    }

    /** Stop: tell the server, end the link, and stop the daemon, which stops what it ran. */
    async stop(): Promise<void> {
        if (this.#stopping) {
            return this.finished;
        }

        this.#stopping = true;
        clearTimeout(this.#retryTimer);
        clearTimeout(this.#ackTimer);
        this.#session.gate.stop();
        this.#control({ type: "bye", reason: "The runner was stopped" });
        this.#socket?.close(1000, "Stopped");
        await Promise.all([this.#session.daemon.stop(), this.#tasks.stop()]);
        this.#done();
    }

    /** For tests: cut the link as a network drop would, without a goodbye. The runner reconnects. */
    drop(): void {
        this.#socket?.terminate();
    }

    #control(message: ControlMessage): void {
        if (this.#socket?.readyState === WebSocket.OPEN) {
            this.#socket.send(JSON.stringify(message));
        }
    }

    #ack(): void {
        clearTimeout(this.#ackTimer);
        this.#ackTimer = undefined;

        const session = this.#session;

        if (session.inbox.unacknowledged > 0 && this.#socket?.readyState === WebSocket.OPEN) {
            session.inbox.acknowledged();
            this.#control({ type: "ack", received: session.inbox.received });
        }
    }

    #onOutput(from: Session, bytes: Buffer): void {
        if (from !== this.#session) {
            return;
        }

        for (const whole of from.outputFrames.push(bytes)) {
            from.gate.output(whole);
        }

        this.#relay(from, bytes);
    }

    #relay(from: Session, bytes: Buffer): void {
        if (from !== this.#session) {
            return;
        }

        const message = from.outbox.write(bytes);

        if (this.#socket?.readyState === WebSocket.OPEN && from.id !== null) {
            this.#socket.send(message);
        }

        if (!from.paused && from.outbox.unacknowledged > OUTBOX_LIMIT) {
            from.paused = true;
            from.daemon.pause();
        }
    }

    #fresh(): Session {
        const program = this.#options.daemon ?? localDaemon();
        // The daemon's temporary folder: it takes it from the environment as it starts, as this does.
        const temporary = realFolder(tmpdir());
        const made = new Session(
            (onOutput) => new Daemon(program, this.#options.cwd ?? homedir(), this.#log, onOutput),
            (session, bytes) => this.#onOutput(session, bytes),
        );

        made.gate = new RequestGate({
            send: (bytes) => made.daemon.write(bytes),
            reply: (bytes) => this.#relay(made, bytes),
            shared: async (id) => this.#shared(await temporary, id),
            tmpdir: () => temporary,
            name: () => this.#options.link.name,
            working: (folder) => this.#activity.begin(folder),
        });
        void made.daemon.exited.then((code) => {
            made.gate.stop();

            if (this.#session !== made || this.#stopping) {
                return;
            }

            this.#log(
                `The tool process stopped (exit code ${String(code)}). Restarting it automatically. If this repeats, reinstall Pi Pocket.`,
            );
            this.#session = this.#fresh();
            // The server's session belonged to the old daemon: say hello again, as a new one.
            this.#socket?.close(1000, "pi-env restarted");
        });

        return made;
    }

    #restart(why: string): void {
        this.#log(why);
        this.#session.gate.stop();
        void this.#session.daemon.stop();
        this.#session = this.#fresh();
    }

    /** Stop for good, with why. */
    #fail(message: string): void {
        this.#stopping = true;
        clearTimeout(this.#retryTimer);
        this.#session.gate.stop();
        this.#log(message);
        void Promise.all([this.#session.daemon.stop(), this.#tasks.stop()]).then(() =>
            this.#done(new RunnerStopped(message)),
        );
    }

    /**
     * The runner's own folders that session `id` (its permission) may use besides its folder: its own attached files
     * (`<temp>/pi-pocket-uploads/<id>`), background tasks (`<temp>/pi-pocket-tasks/<id>`), browser downloads
     * (`<temp>/pi-pocket-downloads/<id>`, or `<id>` in the downloads folder), and its git worktrees
     * (`<home>/.pi-pocket/worktrees/<id>`). Only its own: never another session's, and never the downloads or worktrees
     * folder itself.
     */
    async #shared(temporary: string, id: string): Promise<string[]> {
        // A permission id names one folder: nothing that climbs or splits a path.
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
            return [];
        }

        const downloads = this.#settings().downloads;

        return [
            join(temporary, "pi-pocket-uploads", id),
            join(temporary, "pi-pocket-tasks", id),
            join(temporary, "pi-pocket-downloads", id),
            join(await realFolder(homedir()), ".pi-pocket", "worktrees", id),
            ...(downloads === undefined ? [] : [join(await realFolder(downloads), id)]),
        ];
    }

    async #task(ws: WebSocket, message: TaskRequest): Promise<void> {
        let result = message.op === "start" ? this.#taskResults.get(message.id) : undefined;

        if (result === undefined) {
            result = this.#tasks.request(message).catch((error: unknown): TaskResult => ({
                type: "task-result",
                id: message.id,
                ok: false,
                error: (error as Error).message,
            }));

            if (message.op === "start") {
                this.#taskResults.set(message.id, result);
            }
        }

        const answer = await result;

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(answer));
        }
    }

    /** This computer's settings now: plain HTTP from its link, the rest from the server. */
    #settings(): RunnerSettings {
        return {
            ...(this.#options.link.allowHttp === true ? { allowHttp: true } : {}),
            network: this.#server.network,
            ...(this.#server.downloads === undefined ? {} : { downloads: this.#server.downloads }),
        };
    }

    /** Check that the server may be reached this way (`transport.ts`), then connect; refused, it stops for good. */
    #connect(): void {
        if (this.#stopping) {
            return;
        }

        const check = this.#options.transport ?? checkTransport;

        void check(this.#options.link.server, this.#settings().allowHttp === true).then(
            (transport) => {
                if (this.#stopping) {
                    return;
                }

                // Refused: it tries again, since Tailscale may only be starting (at boot, say), and says why once.
                if (!transport.ok) {
                    const why = refusal(this.#options.link.server, transport);

                    if (why !== this.#refused) {
                        this.#refused = why;
                        this.#log(why);
                    }

                    const wait = this.#retry[Math.min(this.#attempt, this.#retry.length - 1)]!;

                    this.#attempt++;
                    this.#retryTimer = setTimeout(() => this.#connect(), wait);

                    return;
                }

                this.#refused = undefined;

                if (this.#attempt === 0 && transport.why === "allowed") {
                    this.#log(
                        `Warning: plain HTTP to ${this.#options.link.server}, as allowed in this runner's settings. Anyone on the network can read this computer's key and its commands.`,
                    );
                }

                void this.#tools().then((tools) => this.#open(tools));
            },
            (error: unknown) => this.#fail(`Could not check the server address: ${String(error)}`),
        );
    }

    /**
     * git and GitHub readiness for the hello. Checked again after `TOOLS_FOR_MS` only: a reconnect after a short drop
     * must not wait for `gh auth status`, which asks GitHub.
     */
    #tools(): Promise<RunnerTools> {
        const now = Date.now();

        if (this.#toolsChecked === undefined || now - this.#toolsChecked.at > TOOLS_FOR_MS) {
            this.#toolsChecked = { at: now, tools: checkTools() };
        }

        return this.#toolsChecked.tools;
    }

    #open(tools: RunnerTools): void {
        if (this.#stopping) {
            return;
        }

        const link = this.#options.link;
        // Sealed with this computer's key and the server's pinned one (`secure-link.ts`): a server that cannot prove
        // its key is not this computer's server, and the runner stops.
        const ws = new RunnerLinkSocket(
            new RawWebSocket(this.#url, LINK_SUBPROTOCOL, {
                maxPayload: MAX_MESSAGE + 64,
                handshakeTimeout: 15_000,
            }),
            link,
            () => {},
        );

        this.#socket = ws;

        const streams = new StreamLink({
            send: (message, done) => {
                if (ws.readyState !== WebSocket.OPEN) {
                    return false;
                }

                ws.send(message, done);

                return true;
            },
            control: (message) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                }
            },
        });

        this.#streams = streams;

        let welcomed = false;
        let silent = Date.now();
        const pinger = setInterval(() => {
            if (Date.now() - silent > SILENT_MS) {
                ws.terminate();

                return;
            }

            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, PING_MS);

        pinger.unref();
        ws.on("unexpected-response", (_request, response) => {
            if (response.statusCode === 401) {
                this.#fail(
                    `${link.server} no longer accepts this computer's key. Run pi-pocket runner serve. Type n to replace the saved link.`,
                );
            } else {
                this.#log(
                    `${link.server} returned HTTP ${String(response.statusCode)}. Retrying automatically. If this continues, check that Pi Pocket is running at this address.`,
                );
            }

            ws.terminate();
        });
        ws.on("open", () => {
            silent = Date.now();
            ws.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL,
                    session: this.#session.id,
                    received: this.#session.inbox.received,
                    version: this.#options.version,
                    tasks: true,
                    tools,
                    ...(link.allowHttp === true ? { allowHttp: true } : {}),
                } satisfies ControlMessage),
            );
        });
        ws.on("pong", () => (silent = Date.now()));
        ws.on("message", (data, binary) => {
            silent = Date.now();

            const bytes = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data);

            if (!binary) {
                welcomed = this.#onControl(ws, welcomed, parseControl(bytes.toString("utf8")));

                return;
            }

            if (!welcomed) {
                ws.close(1002, "Data before welcome");

                return;
            }

            if (bytes[0] === STREAM_DATA) {
                const data = readStreamData(bytes);

                if (data !== undefined) {
                    streams.data(data.id, data.bytes);
                }

                return;
            }

            this.#onData(ws, bytes);
        });
        ws.on("error", (error) => {
            if (this.#attempt <= 1) {
                this.#log(
                    `Connection error (${error.message}). If the runner does not connect, check the address and network.`,
                );
            }
        });
        ws.on("close", (code, reason) => {
            clearInterval(pinger);
            // Network streams do not survive a drop: the browser on the server opens them again.
            streams.dropAll();

            for (const socket of this.#connecting.values()) {
                socket.destroy();
            }

            this.#connecting.clear();

            if (this.#streams === streams) {
                this.#streams = undefined;
            }

            if (this.#socket === ws) {
                this.#socket = undefined;
            }

            if (this.#stopping) {
                return;
            }

            const why = reason.toString("utf8");

            if (code === CLOSE_IDENTITY) {
                this.#fail(
                    `${link.server} did not prove it is the server this computer linked to. Someone may be in the middle. If you replaced the server's data folder, link this computer again with a new code from Menu > Runners.`,
                );

                return;
            }

            if (code === CLOSE.removed) {
                this.#fail(
                    `${link.server} removed this computer. To link again, run pi-pocket runner serve. Type n to replace the saved link.`,
                );

                return;
            }

            if (code === CLOSE.replaced) {
                this.#fail(
                    "Another runner is using this computer's link. This runner has stopped. Stop the other runner before you start this one again.",
                );

                return;
            }

            if (code === CLOSE.protocol) {
                this.#fail(
                    `${why}. Update Pi Pocket on this computer and the server, then start the runner again.`,
                );

                return;
            }

            if (welcomed) {
                this.#log(
                    `Disconnected${why === "" ? "" : ` (${why})`}. Reconnecting automatically. Commands keep running; their sessions continue when the link is back.`,
                );
            }

            const wait = this.#retry[Math.min(this.#attempt, this.#retry.length - 1)]!;

            this.#attempt++;
            this.#retryTimer = setTimeout(() => this.#connect(), wait);
        });
    }

    /** A control message; returns whether the link is welcomed now. */
    #onControl(ws: WebSocket, welcomed: boolean, message: ControlMessage | undefined): boolean {
        const session = this.#session;

        if (message?.type === "welcome" && !welcomed) {
            this.#attempt = 0;

            if (message.resume) {
                const resent =
                    session.id === message.session
                        ? session.outbox.resend(message.received)
                        : undefined;

                if (resent === undefined) {
                    // The server kept bytes this side can no longer send: start over cleanly.
                    this.#control({
                        type: "bye",
                        reason: "The runner lost its place; it starts over",
                    });
                    this.#restart(
                        "The connection could not resume. Restarting the tool process and connecting again.",
                    );
                    ws.close(1000, "Start over");

                    return false;
                }

                for (const each of resent) {
                    ws.send(each);
                }

                this.#log(
                    `Reconnected to ${this.#options.link.server}. Running commands continue.`,
                );

                return true;
            }

            let current = session;

            // A new session on the server: a daemon that served an old one starts over, so nothing it ran outlives it.
            if (session.id !== null) {
                this.#restart(
                    "The server reset the connection. Stopping the previous commands and restarting the tool process.",
                );
                current = this.#session;
            }

            current.id = message.session;

            // Output the daemon gave before this session was welcomed (none, normally).
            for (const each of current.outbox.resend(0) ?? []) {
                ws.send(each);
            }

            this.#log(`Connected to ${this.#options.link.server} as "${this.#options.link.name}".`);

            return true;
        }

        if (message?.type === "ack") {
            if (!session.outbox.acknowledge(message.received)) {
                ws.close(1002, "Acknowledged bytes it was never sent");
            } else if (session.paused && session.outbox.unacknowledged < OUTBOX_LIMIT / 2) {
                session.paused = false;
                session.daemon.resume();
            }
        } else if (message?.type === "runner-settings") {
            this.#server = {
                network: message.network,
                ...(message.downloads === undefined ? {} : { downloads: message.downloads }),
            };
        } else if (message?.type === "task" && welcomed) {
            void this.#task(ws, message);
        } else if (message?.type === "net-open" && welcomed) {
            this.#scopedStream(ws, message);
        } else if (
            message?.type === "net-end" ||
            message?.type === "net-reset" ||
            message?.type === "net-credit"
        ) {
            if (message.type === "net-reset") {
                this.#connecting.get(message.id)?.destroy();
                this.#connecting.delete(message.id);
            }

            this.#streams?.message(message);
        } else if (message?.type === "bye") {
            this.#log(`Server message: ${message.reason}`);
        } else {
            ws.close(1002, "Unexpected message");
        }

        return welcomed;
    }

    /**
     * A network stream for a session's browser. The server checked who may use it; the stream needs a session it names,
     * so a stray one opens nothing.
     */
    #scopedStream(ws: WebSocket, open: NetOpen): void {
        const scope = sessionScope(open.session);

        if (scope !== undefined) {
            this.#openStream(ws, open, this.#activity.begin(scope.folder));
        } else if (ws.readyState === WebSocket.OPEN) {
            ws.send(
                JSON.stringify({
                    type: "net-failed",
                    id: open.id,
                    code: "refused",
                    message: `The server named no session for this connection to ${this.#options.link.name}`,
                } satisfies ControlMessage),
            );
        }
    }

    /**
     * The server asks for a TCP connection from this computer, for a session's browser: open it here, with this
     * computer's names and routes, unless its settings say not to share the network.
     */
    #openStream(ws: WebSocket, open: NetOpen, finish: () => void): void {
        const streams = this.#streams;

        const fail = (code: "refused" | "unreachable" | "timeout" | "limit", message: string) => {
            finish();

            // Errors only, not every connection: a page opens many.
            if (code !== "refused") {
                this.#log(`Browser connection failed: ${message}`);
            }

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        type: "net-failed",
                        id: open.id,
                        code,
                        message,
                    } satisfies ControlMessage),
                );
            }
        };

        if (streams === undefined || streams.has(open.id) || this.#connecting.has(open.id)) {
            finish();
            ws.close(1002, "A stream id in use");

            return;
        }

        if (this.#settings().network === false) {
            fail("refused", `${this.#options.link.name} does not share its network`);

            return;
        }

        if (streams.size + this.#connecting.size >= MAX_STREAMS) {
            fail("limit", `${this.#options.link.name} has too many open connections`);

            return;
        }

        const host = open.host.replace(/^\[|\]$/g, "");
        const socket = connectTcp({ host, port: open.port, allowHalfOpen: true });
        const timer = setTimeout(() => {
            socket.destroy();
            fail("timeout", `No answer from ${open.host}:${open.port} in ${CONNECT_MS / 1000} s`);
        }, CONNECT_MS);

        // Not `socket.connecting`: Node clears it before a failed connect's error event.
        let connected = false;

        timer.unref();
        this.#connecting.set(open.id, socket);
        socket.once("close", () => {
            finish();
            clearTimeout(timer);

            if (this.#connecting.get(open.id) === socket) {
                this.#connecting.delete(open.id);
            }
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (!connected && this.#connecting.get(open.id) === socket) {
                clearTimeout(timer);
                this.#connecting.delete(open.id);
                fail("unreachable", `${open.host}:${open.port}: ${error.code ?? error.message}`);
            }
        });
        socket.once("connect", () => {
            connected = true;
            clearTimeout(timer);
            this.#connecting.delete(open.id);

            if (ws.readyState !== WebSocket.OPEN || this.#streams !== streams) {
                socket.destroy();

                return;
            }

            this.opened++;
            ws.send(JSON.stringify({ type: "net-opened", id: open.id } satisfies ControlMessage));
            streams.attach(open.id, socket);
        });
    }

    #onData(ws: WebSocket, bytes: Buffer): void {
        const session = this.#session;
        const fresh = session.inbox.take(bytes);

        if (fresh === undefined) {
            ws.close(1002, "A gap in the stream");

            return;
        }

        let frames: Buffer[];

        try {
            frames = session.splitter.push(fresh);
        } catch (error) {
            this.#restart(
                `The server sent invalid tool data: ${(error as Error).message}\nRestarting the tool process. Update Pi Pocket if this repeats.`,
            );
            ws.close(1002, "Corrupt frame");

            return;
        }

        for (const whole of frames) {
            try {
                session.gate.input(whole);
            } catch {
                ws.close(1002, "Invalid request frame");
            }
        }

        if (session.inbox.unacknowledged >= ACK_BYTES) {
            this.#ack();
        } else if (this.#ackTimer === undefined) {
            this.#ackTimer = setTimeout(() => this.#ack(), ACK_MS);
            this.#ackTimer.unref();
        }
    }
}
