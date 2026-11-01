/**
 * Computers that run sessions' tools: each one's runner (`pi-pocket runner`, `src/runner/`) connects out to this server
 * over a WebSocket and relays Earendil's pi-env protocol to a pi-env daemon on that computer. Here, each computer has
 * one `RunnerLink`, which talks to its daemon as pi-env's own `Connection` does to a daemon it started; a session that
 * runs there gets a `RemoteExecutionEnv` on that link (`RunnerEnv`). The agent, models, keys, and history stay here.
 *
 * The link survives short drops (`src/runner/protocol.ts`): while a runner is away, requests and their answers wait, up
 * to the grace period. After it, or when the runner had to start a new daemon, what was in flight fails as lost.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
    type Connection,
    RemoteError,
    RemoteExecutionEnv,
    type RemoteInfo,
    type Reply,
    type RequestOptions,
} from "@earendil-works/pi-env";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
    type ControlMessage,
    DEFAULT_GRACE_MS,
    FRAME,
    FrameSplitter,
    Inbox,
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    MAX_MESSAGE,
    CLOSE,
    Outbox,
    parseControl,
    readFrame,
    frame,
    type Hello,
} from "../runner/protocol.ts";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ConfigStore, StoredRunner } from "./config.ts";
import { HttpError } from "./errors.ts";

/**
 * The extensions a session on another computer runs with: exactly these, in order, and none other (no drop-ins). Each
 * works through the session's environment, which is that computer's, or on app state only. The others read or run
 * things on this server's disk (background tasks, the browser, artifacts, design, memory, PR watches), or start
 * conversations that do not yet keep the computer (subagents, teams): they come back as they learn to.
 */
export const REMOTE_EXTENSIONS = [
    "coding-tools",
    // Core's own: its hook takes the values extensions hide (`host.hide`) out of tool results.
    "pocket-core",
    "pocket-prompt",
    "pocket-guard",
    "pocket-ask",
    "pocket-ask-someone",
    "pocket-schedules",
    "pocket-tool-search",
    "pocket-goals",
    "pocket-plan",
] as const;

/** How long a one-time link code works. */
export const CODE_MINUTES = 10;

/** Send an acknowledgement once this many bytes came in, or within ACK_MS. */
const ACK_BYTES = 256 * 1024;
const ACK_MS = 1000;

/** WebSocket pings: one every PING_MS; a link that answers none for SILENT_MS is closed. */
const PING_MS = 10_000;
const SILENT_MS = 30_000;

/** How long a runner has to say hello after it connects. */
const HELLO_MS = 10_000;

/** A computer, as people see it. */
export type RunnerView = {
    id: string;
    name: string;
    online: boolean;
    /** Away, with its work kept for the grace period. */
    away: boolean;
    lastSeen?: number;
    os?: string;
    arch?: string;
    home?: string;
    version?: string;
};

function lost(message: string): RemoteError {
    return new RemoteError({ code: "unknown", message, lost: true });
}

type Pending = {
    resolve: (reply: Reply) => void;
    reject: (error: Error) => void;
    onEvent?: (json: Record<string, unknown>, payload: Uint8Array) => void;
};

/** One daemon session on the computer: its streams, its requests, and what its daemon said in `hello`. */
class LinkSession {
    readonly id = randomUUID();
    readonly outbox = new Outbox();
    readonly inbox = new Inbox();
    readonly splitter = new FrameSplitter();
    readonly pending = new Map<number, Pending>();
    live = true;
    ready!: Promise<RemoteInfo>;
    grace: NodeJS.Timeout | undefined;
    readonly number: number;

    constructor(number: number) {
        this.number = number;
    }
}

/**
 * The link to one computer's daemon. Has the part of pi-env's `Connection` that `RemoteExecutionEnv` uses (`info`,
 * `session`, `request`, `kill`, `close`), so the env works on it unchanged.
 */
export class RunnerLink {
    readonly id: string;
    readonly #runners: Runners;
    #session: LinkSession | undefined;
    #socket: WebSocket | undefined;
    #sessions = 0;
    #nextId = 1;
    #ackTimer: NodeJS.Timeout | undefined;
    #closed = false;

    constructor(id: string, runners: Runners) {
        this.id = id;
        this.#runners = runners;
    }

    get name(): string {
        return this.#runners.stored(this.id)?.name ?? "The computer";
    }

    /** Its system as it last said (`hello`), kept with the computer. */
    platform(): { os?: string; arch?: string } {
        const platform = this.#runners.stored(this.id)?.platform;

        return platform === undefined ? {} : { os: platform.os, arch: platform.arch };
    }

    get online(): boolean {
        return this.#socket !== undefined;
    }

    /** Away: dropped, but its daemon session is kept until the grace period ends. */
    get away(): boolean {
        return this.#socket === undefined && this.#session?.live === true;
    }

    async info(): Promise<RemoteInfo> {
        return (await this.#ready()).ready;
    }

    async session(): Promise<number> {
        const session = await this.#ready();

        await session.ready;

        return session.number;
    }

    async request(
        op: string,
        json: Record<string, unknown>,
        options: RequestOptions = {},
    ): Promise<Reply> {
        if (options.session !== undefined) {
            const current = this.#session;

            if (current === undefined || current.number !== options.session || !current.live) {
                throw lost(`${this.name}: its connection was lost`);
            }

            return this.#send(current, op, json, options);
        }

        const session = await this.#ready();

        await session.ready;

        return this.#send(session, op, json, options);
    }

    /** Kill one `exec` without aborting it. */
    kill(id: number, session: number): void {
        const current = this.#session;

        if (current?.number === session && current.live) {
            this.#write(current, frame(FRAME.cancel, id, { mode: "kill" }));
        }
    }

    /** The computer was removed: what runs there stops, and its runner is told to go for good. */
    remove(): void {
        this.#closed = true;

        if (this.#session !== undefined) {
            this.#end(this.#session, lost(`${this.name} was removed from this server`));
        }

        this.#drop(CLOSE.removed, "This computer was removed from the server");
    }

    /**
     * The server is stopping. Requests in flight stay unanswered: the process ends, and Pi Durable reports their tool
     * calls as interrupted when it starts again, as for local work. The runner reconnects and starts over.
     */
    shutdown(): void {
        this.#closed = true;
        clearTimeout(this.#session?.grace);
        this.#drop(1001, "The server is restarting");
    }

    /** The live session, or an error saying why there is none. */
    async #ready(): Promise<LinkSession> {
        if (this.#closed || this.#runners.stored(this.id) === undefined) {
            throw lost(`${this.name} was removed from this server`);
        }

        const session = this.#session;

        if (session === undefined || !session.live) {
            throw lost(
                `${this.name} is offline. Start its runner (pi-pocket runner) and try again.`,
            );
        }

        return session;
    }

    #send(
        session: LinkSession,
        op: string,
        json: Record<string, unknown>,
        options: RequestOptions,
    ): Promise<Reply> {
        if (!session.live) {
            return Promise.reject(lost(`${this.name}: its connection was lost`));
        }

        const id = this.#nextId++;

        if (this.#nextId > 0xfffffff0) {
            this.#nextId = 1;
        }

        return new Promise<Reply>((resolve, reject) => {
            const onAbort = () => this.#write(session, frame(FRAME.cancel, id, {}));
            const done = () => options.signal?.removeEventListener("abort", onAbort);

            session.pending.set(id, {
                resolve: (value) => {
                    done();
                    resolve(value);
                },
                reject: (error) => {
                    done();
                    reject(error);
                },
                ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
            });
            options.signal?.addEventListener("abort", onAbort, { once: true });
            options.onStart?.(id, session.number);
            this.#write(session, frame(FRAME.request, id, { ...json, op }, options.payload));

            if (options.signal?.aborted === true) {
                onAbort();
            }
        });
    }

    /** Add bytes to the session's stream, and send them now when its runner is here. */
    #write(session: LinkSession, bytes: Buffer): void {
        if (!session.live) {
            return;
        }

        const message = session.outbox.write(bytes);

        if (this.#socket !== undefined && this.#session === session) {
            this.#socket.send(message);
        }
    }

    /** A runner connected and said hello: resume its session, or start a new one. */
    attach(socket: WebSocket, hello: Hello): void {
        if (this.#closed) {
            socket.close(CLOSE.removed, "Removed");

            return;
        }

        if (this.#socket !== undefined && this.#socket !== socket) {
            // The same computer connected again before the old link was noticed gone: the new one wins.
            this.#socket.removeAllListeners("close");
            this.#socket.close(CLOSE.replaced, "Replaced by a newer connection");
        }

        this.#socket = socket;

        const current = this.#session;
        const resent =
            current !== undefined && current.live && hello.session === current.id
                ? current.outbox.resend(hello.received)
                : undefined;
        let session: LinkSession;

        if (current !== undefined && resent !== undefined) {
            session = current;
            clearTimeout(session.grace);
            session.grace = undefined;
            this.#control({
                type: "welcome",
                session: session.id,
                resume: true,
                received: session.inbox.received,
                graceMs: this.#runners.graceMs,
            });

            for (const message of resent) {
                socket.send(message);
            }

            this.#runners.log(`${this.name} is back; its work goes on.`);
        } else {
            if (current !== undefined) {
                this.#end(current, lost(`${this.name} started over; the work it was doing ended`));
            }

            session = new LinkSession(++this.#sessions);
            this.#session = session;
            this.#control({
                type: "welcome",
                session: session.id,
                resume: false,
                received: 0,
                graceMs: this.#runners.graceMs,
            });
            session.ready = this.#send(session, "hello", { protocol: 1 }, {}).then((reply) => {
                if (reply.json.protocol !== 1) {
                    throw lost(
                        `${this.name}: unsupported pi-env protocol ${String(reply.json.protocol)}`,
                    );
                }

                const info = reply.json as unknown as RemoteInfo;

                this.#runners.seen(this.id, info, hello.version);

                return info;
            });
            session.ready.catch(() => {});
            this.#runners.log(`${this.name} connected (pi-env session ${session.number}).`);
        }

        this.#runners.changed();

        let silent = Date.now();
        const pinger = setInterval(() => {
            if (Date.now() - silent > SILENT_MS) {
                socket.terminate();

                return;
            }

            socket.ping();
        }, PING_MS);

        pinger.unref();
        socket.on("pong", () => (silent = Date.now()));
        socket.on("message", (data, binary) => {
            silent = Date.now();

            if (this.#socket !== socket) {
                return;
            }

            if (binary) {
                this.#data(session, toBuffer(data));
            } else {
                this.#onControl(session, parseControl(toBuffer(data).toString("utf8")));
            }
        });
        socket.on("close", () => {
            clearInterval(pinger);

            if (this.#socket !== socket) {
                return;
            }

            this.#socket = undefined;
            this.#runners.changed();

            if (!session.live || this.#session !== session) {
                return;
            }

            this.#runners.log(
                `${this.name} dropped; its work is kept for ${Math.round(this.#runners.graceMs / 1000)} s.`,
            );
            session.grace = setTimeout(() => {
                this.#end(
                    session,
                    lost(`${this.name} was away too long; the work it was doing ended`),
                );
                this.#runners.changed();
            }, this.#runners.graceMs);
            session.grace.unref();
        });
    }

    #onControl(session: LinkSession, message: ControlMessage | undefined): void {
        if (message?.type === "ack") {
            if (!session.outbox.acknowledge(message.received)) {
                this.#drop(1002, "Acknowledged bytes it was never sent");
            }
        } else if (message?.type === "bye") {
            this.#runners.log(`${this.name} left: ${message.reason}`);
            this.#end(session, lost(`${this.name}: ${message.reason}`));
            this.#drop(1000, "Bye");
            this.#runners.changed();
        } else {
            this.#drop(1002, "Unexpected message");
        }
    }

    /** Bytes of the daemon's stream: complete frames go to their requests. */
    #data(session: LinkSession, message: Buffer): void {
        if (!session.live) {
            return;
        }

        const fresh = session.inbox.take(message);

        if (fresh === undefined) {
            this.#drop(1002, "A gap in the stream");

            return;
        }

        let frames: Buffer[];

        try {
            frames = session.splitter.push(fresh);
        } catch (error) {
            this.#end(session, lost(`${this.name}: ${(error as Error).message}`));
            this.#drop(1002, "Corrupt frame");

            return;
        }

        for (const whole of frames) {
            let parsed: ReturnType<typeof readFrame>;

            try {
                parsed = readFrame(whole);
            } catch (error) {
                this.#end(session, lost(`${this.name}: ${(error as Error).message}`));
                this.#drop(1002, "Corrupt frame");

                return;
            }

            this.#dispatch(session, parsed);
        }

        if (session.inbox.unacknowledged >= ACK_BYTES) {
            this.#ack(session);
        } else if (session.inbox.unacknowledged > 0 && this.#ackTimer === undefined) {
            this.#ackTimer = setTimeout(() => {
                this.#ackTimer = undefined;

                if (this.#session === session) {
                    this.#ack(session);
                }
            }, ACK_MS);
            this.#ackTimer.unref();
        }
    }

    #ack(session: LinkSession): void {
        if (this.#socket === undefined || !session.live) {
            return;
        }

        session.inbox.acknowledged();
        this.#control({ type: "ack", received: session.inbox.received });
    }

    #dispatch(session: LinkSession, parsed: ReturnType<typeof readFrame>): void {
        const { type, id, json, payload } = parsed;
        const pending = session.pending.get(id);

        if (type === FRAME.event) {
            pending?.onEvent?.(json, payload);

            return;
        }

        if ((type !== FRAME.result && type !== FRAME.error) || pending === undefined) {
            return;
        }

        session.pending.delete(id);

        if (type === FRAME.result) {
            pending.resolve({ json, payload, session: session.number });
        } else {
            pending.reject(new RemoteError(json));
        }
    }

    #control(message: ControlMessage): void {
        this.#socket?.send(JSON.stringify(message));
    }

    /** End a daemon session: what it was doing fails with `error`. */
    #end(session: LinkSession, error: Error): void {
        if (!session.live) {
            return;
        }

        session.live = false;
        clearTimeout(session.grace);

        if (this.#session === session) {
            this.#session = undefined;
        }

        const pending = [...session.pending.values()];

        session.pending.clear();

        for (const request of pending) {
            request.reject(error);
        }
    }

    #drop(code: number, reason: string): void {
        const socket = this.#socket;

        if (socket !== undefined) {
            socket.close(code, reason);
        }
    }
}

function toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/** A session's environment on a computer: pi-env's, with which computer it is. */
export class RunnerEnv extends RemoteExecutionEnv {
    readonly runner: string;
    readonly #link: RunnerLink;

    constructor(link: RunnerLink, cwd: string) {
        super({ connection: link as unknown as Connection, id: `runner:${link.id}`, cwd });
        this.runner = link.id;
        this.#link = link;
    }

    /** The computer, for the system prompt: its name, and its system as it last said. */
    computer(): { name: string; os?: string; arch?: string } {
        return { name: this.#link.name, ...this.#link.platform() };
    }
}

/** The computers whose runners may connect, and their links. */
export class Runners {
    readonly graceMs: number;
    readonly #config: ConfigStore;
    readonly #log: (line: string) => void;
    readonly #onChange: () => void;
    readonly #links = new Map<string, RunnerLink>();
    readonly #envs = new Map<string, RunnerEnv>();
    readonly #server = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_MESSAGE,
        handleProtocols: (protocols) =>
            protocols.has(LINK_SUBPROTOCOL) ? LINK_SUBPROTOCOL : false,
    });

    constructor(options: {
        config: ConfigStore;
        log: (line: string) => void;
        onChange?: () => void;
        graceMs?: number;
    }) {
        this.#config = options.config;
        this.#log = options.log;
        this.#onChange = options.onChange ?? (() => {});
        this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    }

    log(line: string): void {
        this.#log(`Runners: ${line}`);
    }

    changed(): void {
        this.#onChange();
    }

    stored(id: string): StoredRunner | undefined {
        return this.#config.runnerById(id);
    }

    /** Note what a computer's daemon reported, for the computers list. */
    seen(id: string, info: RemoteInfo, version: string): void {
        this.#config.updateRunner(id, {
            lastSeen: Date.now(),
            platform: { os: info.os, arch: info.arch, home: info.home, version },
        });
    }

    /** The link to a computer, made when first asked for, also for a computer not (or no longer) here. */
    link(id: string): RunnerLink {
        let link = this.#links.get(id);

        if (link === undefined) {
            link = new RunnerLink(id, this);
            this.#links.set(id, link);
        }

        return link;
    }

    /** The environment of a session that runs in `cwd` on computer `id`. */
    env(id: string, cwd: string): RunnerEnv {
        const key = `${id}\0${cwd}`;
        let env = this.#envs.get(key);

        if (env === undefined) {
            env = new RunnerEnv(this.link(id), cwd);
            this.#envs.set(key, env);
        }

        return env;
    }

    /** A computer's name, for prompts and messages; its id when it is gone. */
    name(id: string): string {
        return this.#config.runnerById(id)?.name ?? id;
    }

    /** Throw unless computer `id` is linked here. */
    require(id: string): StoredRunner {
        const runner = this.#config.runnerById(id);

        if (runner === undefined) {
            throw new HttpError(404, "No such computer. Link it first.");
        }

        return runner;
    }

    /** A folder on computer `id` as a session means it: `~` is the home there; others are absolute or under home. */
    async #resolve(
        id: string,
        path: string,
    ): Promise<{ env: RunnerEnv; path: string; home: string; separator: string }> {
        this.require(id);

        const info = await this.link(id)
            .info()
            .catch((error: unknown) => {
                throw new HttpError(409, error instanceof Error ? error.message : String(error));
            });
        const env = this.env(id, info.home);
        const trimmed = path.trim() === "" ? "~" : path.trim();
        const expanded =
            trimmed === "~"
                ? info.home
                : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
                  ? `${info.home}${info.separator}${trimmed.slice(2)}`
                  : trimmed;
        const absolute = await env.absolutePath(expanded, BACKGROUND);

        if (!absolute.ok) {
            throw new HttpError(400, absolute.error.message);
        }

        return { env, path: absolute.value, home: info.home, separator: info.separator };
    }

    /** Check that `path` is a folder on computer `id`; its absolute path. */
    async checkFolder(id: string, path: string): Promise<string> {
        const { env, path: absolute } = await this.#resolve(id, path);
        const info = await env.fileInfo(absolute, BACKGROUND);

        if (!info.ok || info.value.kind !== "directory") {
            throw new HttpError(
                400,
                `${absolute} is not a folder on ${this.name(id)}${info.ok ? "" : `: ${info.error.message}`}`,
            );
        }

        return absolute;
    }

    /** The folders in `path` on computer `id`, for the folder picker, as `GET /api/fs` lists this machine's. */
    async folders(
        id: string,
        path: string,
        hidden: boolean,
    ): Promise<{
        path: string;
        parent: string | null;
        home: string;
        dirs: { name: string; path: string }[];
    }> {
        const resolved = await this.#resolve(id, path);
        const listed = await resolved.env.listDir(resolved.path, BACKGROUND);

        if (!listed.ok) {
            throw new HttpError(
                400,
                `${resolved.path} on ${this.name(id)}: ${listed.error.message}`,
            );
        }

        const dirs: { name: string; path: string }[] = [];

        for (const entry of listed.value) {
            if (!hidden && entry.name.startsWith(".")) {
                continue;
            }

            let folder = entry.kind === "directory";

            if (entry.kind === "symlink") {
                const target = await resolved.env.fileInfo(
                    await resolved.env
                        .canonicalPath(entry.path, BACKGROUND)
                        .then((real) => (real.ok ? real.value : entry.path)),
                    BACKGROUND,
                );

                folder = target.ok && target.value.kind === "directory";
            }

            if (folder) {
                dirs.push({ name: entry.name, path: entry.path });
            }
        }

        dirs.sort((a, b) => a.name.localeCompare(b.name));

        const sep = resolved.separator;
        const trimmed = resolved.path.replace(/[\\/]+$/, "");
        const at = trimmed.lastIndexOf(sep);
        const parent =
            at < 0 || trimmed === ""
                ? null
                : at === 0
                  ? sep
                  : /^[A-Za-z]:$/.test(trimmed.slice(0, at))
                    ? `${trimmed.slice(0, at)}${sep}`
                    : trimmed.slice(0, at);

        return {
            path: resolved.path,
            parent: parent === resolved.path ? null : parent,
            home: resolved.home,
            dirs: dirs.slice(0, 1000),
        };
    }

    list(): RunnerView[] {
        return this.#config.runners.map((runner) => {
            const link = this.#links.get(runner.id);

            return {
                id: runner.id,
                name: runner.name,
                online: link?.online === true,
                away: link?.away === true,
                ...(runner.lastSeen === undefined ? {} : { lastSeen: runner.lastSeen }),
                ...(runner.platform ?? {}),
            };
        });
    }

    /** A one-time code that links a computer named `name`: `pi-pocket runner link <server> <code>` on it. */
    makeCode(name: string, createdBy: string): { code: string; expiresAt: number } {
        const clean = name.replace(/\s+/g, " ").trim().slice(0, 60);

        if (clean === "") {
            throw new HttpError(400, "Give the computer a name");
        }

        if (this.#config.runners.some((runner) => runner.name === clean)) {
            throw new HttpError(409, `A computer is already named ${clean}`);
        }

        // 12 characters of an alphabet without look-alikes (no 0/O, 1/I/L): 60 bits, easy to read out and type.
        const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
        const raw = [...randomBytes(12)].map((byte) => alphabet[byte % 31]).join("");
        const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
        const expiresAt = Date.now() + CODE_MINUTES * 60_000;

        this.#config.addRunnerCode(code, clean, createdBy, expiresAt);

        return { code, expiresAt };
    }

    /** A runner gives its one-time code: it gets its computer's key, kept only there. */
    redeem(code: string): { id: string; name: string; key: string } {
        const found = this.#config.takeRunnerCode(code.trim().toUpperCase());

        if (found === undefined) {
            throw new HttpError(403, "This link code is wrong, used, or expired. Make a new one.");
        }

        const { runner, key } = this.#config.addRunner(found.name, found.createdBy);

        this.log(`${runner.name} was linked.`);
        this.changed();

        return { id: runner.id, name: runner.name, key };
    }

    /** Forget a computer: its runner is sent away, and its key stops working. */
    remove(id: string): void {
        const runner = this.#config.runnerById(id);

        if (runner === undefined) {
            throw new HttpError(404, "No such computer");
        }

        this.#links.get(id)?.remove();
        this.#links.delete(id);
        this.#config.removeRunner(id);
        this.log(`${runner.name} was removed.`);
        this.changed();
    }

    /**
     * An HTTP upgrade: a runner connecting, when it is for the link path. Returns false for any other upgrade, which
     * the caller ends.
     */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
        const path = new URL(request.url ?? "/", "http://pocket").pathname;

        if (path !== LINK_PATH) {
            return false;
        }

        const refuse = (status: number, message: string) => {
            socket.end(
                `HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
            );
        };

        const auth = request.headers.authorization ?? "";
        const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        const runner = key === "" ? undefined : this.#config.runnerByKey(key);

        if (runner === undefined) {
            refuse(401, "Unknown runner key");

            return true;
        }

        const offered = String(request.headers["sec-websocket-protocol"] ?? "")
            .split(",")
            .map((each) => each.trim());

        if (!offered.includes(LINK_SUBPROTOCOL)) {
            refuse(426, `This server speaks ${LINK_SUBPROTOCOL}: update the runner or the server`);

            return true;
        }

        this.#server.handleUpgrade(request, socket, head, (ws) => this.#accept(ws, runner));

        return true;
    }

    #accept(socket: WebSocket, runner: StoredRunner): void {
        const timer = setTimeout(() => socket.close(1002, "No hello"), HELLO_MS);

        socket.once("message", (data, binary) => {
            clearTimeout(timer);

            const hello = binary ? undefined : parseControl(toBuffer(data).toString("utf8"));

            if (hello?.type !== "hello") {
                socket.close(1002, "Say hello first");

                return;
            }

            if (hello.protocol !== LINK_PROTOCOL) {
                socket.send(
                    JSON.stringify({
                        type: "bye",
                        reason: `This server speaks link protocol ${LINK_PROTOCOL}, the runner ${hello.protocol}: update the older one`,
                    }),
                );
                socket.close(CLOSE.protocol, "Protocol");

                return;
            }

            // Still here: removed while it was saying hello.
            if (this.#config.runnerById(runner.id) === undefined) {
                socket.close(CLOSE.removed, "Removed");

                return;
            }

            this.link(runner.id).attach(socket, hello);
        });
        socket.on("error", (error) => this.log(`${runner.name}: ${error.message}`));
    }

    close(): void {
        for (const link of this.#links.values()) {
            link.shutdown();
        }

        this.#links.clear();
        this.#server.close();
    }
}
