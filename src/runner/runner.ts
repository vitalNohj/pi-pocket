/**
 * The runner's work: start the pi-env daemon here, keep a link to the server, and relay pi-env frames both ways.
 * `main.ts` runs it from the command line; tests run it in the same process.
 *
 * The link survives short drops (`protocol.ts`). While it is down, the daemon keeps running, the runner pings it itself,
 * and its output waits here (reading stops when too much waits, as a full pipe would). When the server answers again,
 * both sides send what the other missed. When the server does not know the session anymore (after its grace period or
 * a restart), the runner stops the daemon, which stops what it ran, and starts a new one.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { localDaemon } from "@earendil-works/pi-env";
import WebSocket from "ws";
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
    Outbox,
    parseControl,
} from "./protocol.ts";

/** Daemon pings, as pi-env's own client sends them: it stops everything after 30 s without a byte. */
const DAEMON_PING_MS = 5000;

/** Send an acknowledgement once this many bytes came in, or within ACK_MS. */
const ACK_BYTES = 256 * 1024;
const ACK_MS = 1000;

/** Stop reading the daemon's output while this much waits for the server, as a full pipe would (pi-env pauses). */
const OUTBOX_LIMIT = 32 * 1024 * 1024;

/** Reconnect waits, growing from the first to the last. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];

/** WebSocket pings to the server; a link that answers none for SILENT_MS is closed and made again. */
const PING_MS = 10_000;
const SILENT_MS = 30_000;

/** What a runner needs to connect: kept in `runner.json` by `pi-pocket runner link`. */
export type RunnerLinkFile = { server: string; id: string; name: string; key: string };

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
    readonly #url: URL;
    readonly #log: (line: string) => void;
    readonly #retry: readonly number[];
    #socket: WebSocket | undefined;
    #session!: Session;
    #stopping = false;
    #attempt = 0;
    #graceMs = 2 * 60 * 1000;
    #graceTimer: NodeJS.Timeout | undefined;
    #ackTimer: NodeJS.Timeout | undefined;
    #retryTimer: NodeJS.Timeout | undefined;
    #done!: (error?: Error) => void;
    /** Settles when the runner stops: resolves after `stop()`, rejects with `RunnerStopped` when the server ends it. */
    readonly finished: Promise<void>;

    constructor(options: RunnerOptions) {
        this.#options = options;
        this.#log = options.log ?? (() => {});
        this.#retry = options.retryMs ?? RETRY_MS;
        this.#url = new URL(options.link.server);
        this.#url.protocol = this.#url.protocol === "https:" ? "wss:" : "ws:";
        this.#url.pathname = `${this.#url.pathname.replace(/\/+$/, "")}${LINK_PATH}`;
        this.finished = new Promise<void>((resolve, reject) => {
            this.#done = (error) => (error === undefined ? resolve() : reject(error));
        });
        this.finished.catch(() => {});
    }

    /** Whether a link to the server is up and welcomed. */
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
        clearTimeout(this.#graceTimer);
        clearTimeout(this.#ackTimer);
        this.#control({ type: "bye", reason: "The runner was stopped" });
        this.#socket?.close(1000, "Stopped");
        await this.#session.daemon.stop();
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
        const made = new Session(
            (onOutput) => new Daemon(program, this.#options.cwd ?? homedir(), this.#log, onOutput),
            (session, bytes) => this.#onOutput(session, bytes),
        );

        void made.daemon.exited.then((code) => {
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
        void this.#session.daemon.stop();
        this.#session = this.#fresh();
    }

    /** Stop for good, with why. */
    #fail(message: string): void {
        this.#stopping = true;
        clearTimeout(this.#retryTimer);
        clearTimeout(this.#graceTimer);
        this.#log(message);
        void this.#session.daemon.stop().then(() => this.#done(new RunnerStopped(message)));
    }

    #connect(): void {
        if (this.#stopping) {
            return;
        }

        const link = this.#options.link;
        const ws = new WebSocket(this.#url, LINK_SUBPROTOCOL, {
            headers: { authorization: `Bearer ${link.key}` },
            maxPayload: MAX_MESSAGE,
            handshakeTimeout: 15_000,
        });

        this.#socket = ws;

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

            if (this.#socket === ws) {
                this.#socket = undefined;
            }

            if (this.#stopping) {
                return;
            }

            const why = reason.toString("utf8");

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
                    `Disconnected${why === "" ? "" : ` (${why})`}. Reconnecting automatically. Commands keep running during a short drop.`,
                );

                // After the grace period the server has ended this session: stop what still runs for it.
                this.#graceTimer ??= setTimeout(() => {
                    this.#graceTimer = undefined;

                    if (this.#session.id !== null && !this.connected) {
                        this.#restart(
                            "The connection was down too long. Stopping the previous commands and restarting the tool process.",
                        );
                    }
                }, this.#graceMs + 5000);
                this.#graceTimer.unref();
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
            this.#graceMs = message.graceMs;
            clearTimeout(this.#graceTimer);
            this.#graceTimer = undefined;

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
        } else if (message?.type === "bye") {
            this.#log(`Server message: ${message.reason}`);
        } else {
            ws.close(1002, "Unexpected message");
        }

        return welcomed;
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
            session.daemon.write(whole);
        }

        if (session.inbox.unacknowledged >= ACK_BYTES) {
            this.#ack();
        } else if (this.#ackTimer === undefined) {
            this.#ackTimer = setTimeout(() => this.#ack(), ACK_MS);
            this.#ackTimer.unref();
        }
    }
}
