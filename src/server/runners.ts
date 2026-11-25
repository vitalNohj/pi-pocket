/**
 * Computers that run sessions' tools: each one's runner (`pi-pocket-runner`, `packages/runner/`) connects out to this server
 * over a WebSocket and relays Earendil's pi-env protocol to a pi-env daemon on that computer. Here, each computer has
 * one `RunnerLink`, which talks to its daemon as pi-env's own `Connection` does to a daemon it started; a session that
 * runs there gets a `RemoteExecutionEnv` on that link (`RunnerEnv`). The agent, models, keys, and history stay here.
 *
 * Offline is offline (`docs/runners.md`): while a computer is away, its daemon session is kept for as long as this server
 * runs, and requests and their answers wait for it, however long that is. Nothing fails because a computer is offline.
 * Only when its runner had to start a new daemon (it quit, or this server restarted) does what was in flight fail as
 * lost: those processes are gone.
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
import { type RawData, WebSocketServer } from "ws";
import {
    checkLinkRequest,
    CLOSE_IDENTITY,
    fingerprint,
    isPublicKey,
    linkAnswerProof,
    type LinkAnswer,
    type LinkRequest,
    ServerLinkSocket,
} from "./runner-link/secure-link.ts";
import {
    type ControlMessage,
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
    type RunnerSettingsMessage,
    type SessionScope,
    type Stop,
    type PiSessionsQuery,
    type PiSessionsResult,
    type TaskRequest,
    type TaskResult,
    SESSION_FIELD,
    readStreamData,
    STREAM_DATA,
} from "./runner-link/protocol.ts";
import { MAX_SNAPSHOT_BYTES, READ_SNAPSHOT } from "./runner-link/read-snapshot.ts";
import { LinkNetwork, NetError, type OpenOptions } from "./runner-network.ts";
import { BACKGROUND_CONTEXT as BACKGROUND, type Context } from "@earendil-works/chord/context";
import type { FileInfo } from "@earendil-works/pi-durable/env";
import type { ConfigStore, StoredRunner, User } from "./config.ts";
import type { ComputerRight } from "./rights.ts";
import { HttpError } from "./errors.ts";
import { isOwner, type Role } from "./roles.ts";
import { limitParallel } from "./folder-access.ts";
import { LinkLimits, type LinkLocks, WRONG_CODE } from "./link-limits.ts";
import { runnerPin } from "./versions.ts";

/**
 * The built-in extensions a session on another computer runs with: exactly these, in order. Drop-ins that say they work
 * there (`export const remoteSessions = true`) follow them (`App.remoteExtensions`); other drop-ins never load. Each
 * works through the session's environment, which is that computer's, or on app state only. Subagents and linked
 * sessions keep the computer, and codemode calls its tools without saving output on this server. The others (PiP, the
 * gallery, updates) are about this server itself, not a session's computer.
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
    "pocket-subagents",
    "pocket-agent-teams",
    "pocket-codemode",
    "pocket-background",
    "pocket-goals",
    "pocket-plan",
    "pocket-memory",
    "pocket-triggers",
    // Its pages load through the computer (`runner-network.ts`), and it opens no files of this server.
    "pocket-browser",
    "pocket-artifacts",
    // Design renders here, with a bounded copy of the session folder (`design/mirror.ts`).
    "pocket-design",
] as const;

/** What a subagent of a session on another computer runs without: it starts no agents of its own, and asks nobody. */
export const REMOTE_SUBAGENT_WITHOUT: readonly string[] = [
    "pocket-subagents",
    "pocket-agent-teams",
    "pocket-ask",
];

/** How long a one-time link code works. */
export const CODE_MINUTES = 10;

/**
 * What another computer installs to get a runner, and the command that runs it there. By default the runner's package
 * at the version this Pi Pocket pins, from npm. On a server that runs a build npm does not have,
 * `PI_POCKET_RUNNER_PACKAGE` names what to install (a fork's tarball, say): its command is `pi-pocket-runner` when the
 * value contains `pi-pocket-runner`, else `pi-pocket runner`, for a whole Pi Pocket (as the desktop app sets it).
 */
export function runnerInstall(): { package: string; command: string } {
    const given = process.env.PI_POCKET_RUNNER_PACKAGE?.trim();

    if (!given) {
        return { package: `pi-pocket-runner@${runnerPin()}`, command: "pi-pocket-runner" };
    }

    return {
        package: given,
        command: given.includes("pi-pocket-runner") ? "pi-pocket-runner" : "pi-pocket runner",
    };
}

/** Send an acknowledgement once this many bytes came in, or within ACK_MS. */
const ACK_BYTES = 256 * 1024;
const ACK_MS = 1000;

/** WebSocket pings: one every PING_MS; a link that answers none for SILENT_MS is closed. */
const PING_MS = 10_000;
const SILENT_MS = 30_000;

/** How long a runner has to say hello after it connects. */
const HELLO_MS = 10_000;
/** How long the server waits for a computer to read its Pi sessions: a list of hundreds can take a few seconds. */
const PI_SESSIONS_MS = 60_000;

/** The link socket a runner talks over, sealed with the link's keys (`secure-link.ts`). */
type WebSocket = ServerLinkSocket;

/** A computer, as people see it. */
export type RunnerView = {
    id: string;
    name: string;
    online: boolean;
    /** Linked before the secure link: it must link again, with a code made for it (`makeCode` with its id). */
    relink?: true;
    /** Its runner's key, as a person can compare it with what `pi-pocket-runner status` shows there. */
    fingerprint?: string;
    /** Offline, with its work waiting for it (its daemon session is kept until it is back). */
    away: boolean;
    lastSeen?: number;
    os?: string;
    arch?: string;
    home?: string;
    version?: string;
    tools?: Hello["tools"];
    createdBy: string;
    /** Granted people, visible only in the owner's list. */
    users?: { id: string; name: string; role: Role }[];
    /** The folders given to each granted person there, by person id; only in the owner's list. */
    given?: Record<string, string[]>;
    /** Of those, the folders in which that person sees every session, by person id; only in the owner's list. */
    sees?: Record<string, string[]>;
    /** Of those, the ones that person sees only the sessions made up to a time in: that time, by folder. */
    seesUntil?: Record<string, Record<string, number>>;
    /**
     * The granted people who hold each right given one person at a time there (`rights.ts`): `wheel`, to take the
     * wheel from a driver (`access.ts` `overridesTurns`); `allows`, to allow a call their own message led to
     * (`allowsOwn`); `reshares`, to share what they were given there (`reshares`). Managers' list.
     */
    rights?: Record<ComputerRight, string[]>;
    /** False when this person may not start sessions there: the owner sees a runner someone else linked, to unlink it. */
    mayStart?: false;
    /** Its sessions' browsers use its network (on unless turned off); only in the managers' list. */
    network?: boolean;
    /** Where its sessions' browser downloads go, when not its temporary folder; only in the managers' list. */
    downloads?: string;
    /** Its runner allows plain HTTP to this server (set when it was linked, there). */
    allowHttp?: true;
    /** Its linker was made a viewer: nothing starts or runs there until they prompt again (`access.ts` `blocked`). */
    blocked?: true;
    /**
     * Is whoever is told this in charge of it (`access.ts` `inCharge`): its linker, or on a runner the owner linked,
     * who manages runners. Said to a person; the app asks nothing else to know whose it is to change.
     */
    inCharge?: boolean;
    /**
     * The users in charge of it because they manage runners (`access.ts` `managesRunners`), by id; only for who is in
     * charge of it. Their row under it says so: its switch is what they keep once they manage runners no longer.
     */
    managers?: string[];
};

function lost(message: string): RemoteError {
    return new RemoteError({ code: "unknown", message, lost: true });
}

/**
 * A page of a folder's entries (`readdir`) without the ones the daemon could not `lstat`. pi-env fails a whole listing
 * (`listDir`, `openDirReader`) for one such entry, as Node's `readdir` does; here a listing shows what it can read, so
 * the folder picker, the Files panel, and the agent's tools all see the rest. On Windows a file with a reserved name
 * (`nul`, `con`, `com1.txt`, made by a POSIX tool) is one: its `lstat` reaches the device, not the file, and fails
 * with `EISDIR`. The daemon sends no kind with a failed entry, so it is left out; reading it still fails, by itself.
 */
export function readableEntries(reply: Reply): Reply {
    const entries = reply.json.entries;

    if (!Array.isArray(entries)) {
        return reply;
    }

    const readable = entries.filter(
        (entry: unknown) => (entry as { error?: unknown } | null)?.error === undefined,
    );

    return readable.length === entries.length
        ? reply
        : { ...reply, json: { ...reply.json, entries: readable } };
}

type Pending = {
    resolve: (reply: Reply) => void;
    reject: (error: Error) => void;
    onEvent?: (json: Record<string, unknown>, payload: Uint8Array) => void;
    /** The session field the request carried: its cancel carries it too, as the runner checks (`request-gate.ts`). */
    from?: unknown;
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
    /** Whether its daemon has said hello: `ready` is settled, so `info` answers without the computer. */
    known = false;
    readonly number: number;
    readonly readSnapshot: boolean;

    constructor(number: number, readSnapshot: boolean) {
        this.number = number;
        this.readSnapshot = readSnapshot;
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
    /** Unlike daemon requests, these survive a reset of the daemon session. */
    readonly #piResults = new Map<
        string,
        { resolve: (message: PiSessionsResult) => void; reject: (error: Error) => void }
    >();
    readonly #taskRequests = new Map<
        string,
        {
            message: TaskRequest;
            resolve: (result: TaskResult) => void;
            reject: (error: Error) => void;
        }
    >();
    /** The network streams of the current connection. Its runner refuses them when its network is not shared. */
    #network: LinkNetwork | undefined;
    /** Whether its runner allows plain HTTP to this server (`hello.allowHttp`), for the Runners sheet. */
    allowHttp = false;
    /** Who waits for the computer to be online with a daemon that said hello (`whenOnline`). */
    readonly #waiting = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

    constructor(id: string, runners: Runners) {
        this.id = id;
        this.#runners = runners;
    }

    get name(): string {
        return this.#runners.stored(this.id)?.name ?? "The computer";
    }

    get supportsReadSnapshot(): boolean {
        return this.#session?.readSnapshot === true;
    }

    /** Its system as it last said (`hello`), kept with the computer. */
    platform(): { os?: string; arch?: string } {
        const platform = this.#runners.stored(this.id)?.platform;

        return platform === undefined ? {} : { os: platform.os, arch: platform.arch };
    }

    /** Where its sessions' browser downloads go (`StoredRunner.settings.downloads`); undefined: its temporary folder. */
    get downloads(): string | undefined {
        return this.#runners.stored(this.id)?.settings?.downloads;
    }

    /** Send its runner the settings the server keeps for it (`runner-settings`): at each welcome, and when they change. */
    sendSettings(): void {
        const settings = this.#runners.stored(this.id)?.settings;

        this.#control({
            type: "runner-settings",
            network: settings?.network !== false,
            ...(settings?.downloads === undefined ? {} : { downloads: settings.downloads }),
        } satisfies RunnerSettingsMessage);
    }

    get online(): boolean {
        return this.#socket !== undefined;
    }

    /** Offline with work waiting: its daemon session is kept until it is back. */
    get away(): boolean {
        return this.#socket === undefined && this.#session?.live === true;
    }

    /**
     * Wait until the computer is online and its daemon said hello. A session's turn and each of its tool calls wait here
     * (`app.ts`), so Pi does not start on a message, or a tool, while its computer is offline. Ends when `signal` aborts,
     * and fails only when the computer was removed, or is blocked.
     */
    async whenOnline(signal?: AbortSignal): Promise<void> {
        for (;;) {
            if (this.#closed || this.#runners.stored(this.id) === undefined) {
                throw lost(`${this.name} was removed from this server`);
            }

            this.#refuse();

            signal?.throwIfAborted();

            const session = this.#session;

            if (this.#socket !== undefined && session !== undefined && session.live) {
                try {
                    await session.ready;

                    return;
                } catch {
                    // That daemon failed its hello: wait for the next connection.
                }
            }

            await new Promise<void>((resolve, reject) => {
                const waiter = {
                    resolve: () => {
                        signal?.removeEventListener("abort", aborted);
                        resolve();
                    },
                    reject: (error: Error) => {
                        signal?.removeEventListener("abort", aborted);
                        reject(error);
                    },
                };

                const aborted = () => {
                    this.#waiting.delete(waiter);
                    reject(signal!.reason);
                };

                this.#waiting.add(waiter);
                signal?.addEventListener("abort", aborted, { once: true });
            });
        }
    }

    /** Tell whoever waits for the computer (`whenOnline`) to look again. */
    #wake(error?: Error): void {
        const waiting = [...this.#waiting];

        this.#waiting.clear();

        for (const waiter of waiting) {
            if (error === undefined) {
                waiter.resolve();
            } else {
                waiter.reject(error);
            }
        }
    }

    /**
     * What its daemon said in `hello`. Known after it first connected (also while it is offline since): then at once;
     * else when it is first online. pi-env asks for it before most operations.
     */
    async info(): Promise<RemoteInfo> {
        const session = this.#session;

        if (session?.live === true && session.known) {
            return session.ready;
        }

        await this.whenOnline();

        return this.#session!.ready;
    }

    /**
     * `info`, for what a person waits on (a panel, the folder picker): a 409 that says the computer is offline, at once,
     * rather than waiting for it.
     */
    async infoNow(): Promise<RemoteInfo> {
        if (!this.online) {
            throw new HttpError(
                409,
                `${this.name} is offline. It continues when its runner is back.`,
            );
        }

        return this.info();
    }

    async session(): Promise<number> {
        await this.info();

        return this.#ready().number;
    }

    async request(
        op: string,
        json: Record<string, unknown>,
        options: RequestOptions = {},
        scope?: SessionScope,
    ): Promise<Reply> {
        // Nothing is sent to a blocked computer: every request of a session, a panel, or a task leaves from here.
        this.#refuse();

        // The runner keeps each request inside the folder of the session it names (`request-gate.ts`).
        if (scope !== undefined) {
            json = { ...json, [SESSION_FIELD]: scope };
        }

        if (options.session !== undefined) {
            const current = this.#session;

            if (current === undefined || current.number !== options.session || !current.live) {
                throw lost(`${this.name}: its connection was lost`);
            }

            return this.#answer(op, this.#send(current, op, json, options));
        }

        await this.info();
        // It was blocked while this waited for its daemon.
        this.#refuse();

        return this.#answer(op, this.#send(this.#ready(), op, json, options));
    }

    /** The daemon's answer as the env gets it: a folder's page without entries it could not read. */
    async #answer(op: string, reply: Promise<Reply>): Promise<Reply> {
        return op === "readdir" ? readableEntries(await reply) : reply;
    }

    /** Kill one `exec` without aborting it. */
    kill(id: number, session: number): void {
        const current = this.#session;

        if (current?.number === session && current.live) {
            this.#write(
                current,
                frame(FRAME.cancel, id, this.#cancel(current, id, { mode: "kill" })),
            );
        }
    }

    /** A cancel's JSON, with the session field of the request it cancels. */
    #cancel(
        session: LinkSession,
        id: number,
        json: Record<string, unknown>,
    ): Record<string, unknown> {
        const from = session.pending.get(id)?.from;

        return from === undefined ? json : { ...json, [SESSION_FIELD]: from };
    }

    /** Throw while this computer is blocked (`Runners.blocked`): the server sends it nothing then. */
    #refuse(http = false): void {
        if (this.#runners.blocked(this.id)) {
            const reason = this.#runners.blockedReason(this.id);

            throw http ? new HttpError(403, reason) : lost(reason);
        }
    }

    /**
     * The computer is blocked (`access.ts` `blocked`): what the server runs there stops now. Each request in flight is
     * cancelled there, as Stop does, and fails here; who waits for the computer stops waiting; its network streams end.
     * The connection and its daemon session stay, so the computer shows as connected, and works again at once when the
     * block ends. A background task already started there is the computer's own process: it keeps running.
     */
    block(): void {
        const reason = this.#runners.blockedReason(this.id);
        const session = this.#session;

        // Before its daemon said hello, the only request out is the hello itself.
        if (session?.live === true && session.known) {
            for (const [id, pending] of [...session.pending]) {
                // Before the request is forgotten: its cancel carries the session field it had.
                const cancel = this.#cancel(session, id, {});

                session.pending.delete(id);
                this.#write(session, frame(FRAME.cancel, id, cancel));
                pending.reject(lost(reason));
            }
        }

        const tasks = [...this.#taskRequests.values()];
        const sessions = [...this.#piResults.values()];

        // Forgotten first: an answer that still comes finds nothing.
        this.#taskRequests.clear();
        this.#piResults.clear();

        for (const pending of tasks) {
            pending.reject(lost(reason));
        }

        for (const pending of sessions) {
            pending.reject(new HttpError(403, reason));
        }

        this.#wake(lost(reason));
        this.#network?.refuseAll(new NetError("refused", reason));
    }

    /** The computer was removed: what runs there stops, and its runner is told to go for good. */
    remove(): void {
        this.#closed = true;

        if (this.#session !== undefined) {
            this.#end(this.#session, lost(`${this.name} was removed from this server`));
        }

        this.#wake(lost(`${this.name} was removed from this server`));

        for (const pending of this.#taskRequests.values()) {
            pending.reject(lost(`${this.name} was removed from this server`));
        }

        this.#taskRequests.clear();
        this.#drop(CLOSE.removed, "This computer was removed from the server", "removed");
    }

    /**
     * The server is stopping. Requests in flight stay unanswered: the process ends, and Pi Durable reports their tool
     * calls as interrupted when it starts again, as for local work. The runner reconnects and starts over.
     */
    shutdown(): void {
        this.#closed = true;
        this.#drop(1001, "The server is restarting");
    }

    /**
     * Its computer was linked again: the runner with the old key is sent away for good; the new runner connects with
     * its own.
     */
    relinked(): void {
        this.#drop(1000, "This computer was linked again", "relinked");
    }

    /** The live session, after `info` waited for one; lost when its runner started over meanwhile. */
    #ready(): LinkSession {
        const session = this.#session;

        if (session === undefined || !session.live) {
            throw lost(`${this.name} restarted, so the command it was running stopped`);
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
            const onAbort = () =>
                this.#write(session, frame(FRAME.cancel, id, this.#cancel(session, id, {})));
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
                ...(json[SESSION_FIELD] === undefined ? {} : { from: json[SESSION_FIELD] }),
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
            sendAway(socket, CLOSE.removed, "Removed", "removed");

            return;
        }

        if (this.#socket !== undefined && this.#socket !== socket) {
            // The same computer connected again before the old link was noticed gone: the new one wins. The old one's
            // close handler still runs, to stop its pings; it changes nothing else once this is no longer its socket.
            sendAway(this.#socket, CLOSE.replaced, "Replaced by a newer connection", "replaced");
        }

        this.#socket = socket;
        this.allowHttp = hello.allowHttp === true;
        this.#runners.toolsSeen(this.id, hello.tools);

        this.#network?.drop();
        this.#network = this.#networkOf(socket);

        const network = this.#network;

        const current = this.#session;
        const resent =
            current !== undefined && current.live && hello.session === current.id
                ? current.outbox.resend(hello.received)
                : undefined;
        let session: LinkSession;

        if (current !== undefined && resent !== undefined) {
            session = current;
            this.#control({
                type: "welcome",
                session: session.id,
                resume: true,
                received: session.inbox.received,
            });
            this.sendSettings();

            for (const message of resent) {
                socket.send(message);
            }

            this.#runners.log(`${this.name} is back; its work goes on.`);
        } else {
            if (current !== undefined) {
                this.#end(
                    current,
                    lost(`${this.name} restarted, so the command it was running stopped`),
                );
            }

            session = new LinkSession(++this.#sessions, hello.readSnapshot === true);
            this.#session = session;
            this.#control({
                type: "welcome",
                session: session.id,
                resume: false,
                received: 0,
            });
            this.sendSettings();
            session.ready = this.#send(session, "hello", { protocol: 1 }, {}).then((reply) => {
                if (reply.json.protocol !== 1) {
                    throw lost(
                        `${this.name}: unsupported pi-env protocol ${String(reply.json.protocol)}`,
                    );
                }

                const info = reply.json as unknown as RemoteInfo;

                session.known = true;
                this.#runners.seen(this.id, info, hello.version);

                return info;
            });
            session.ready.then(
                () => this.#wake(),
                () => this.#wake(),
            );
            this.#runners.log(`${this.name} connected (pi-env session ${session.number}).`);
        }

        // Welcome always goes first. Replay requests whose result the previous connection lost.
        void session.ready
            .then(() => {
                if (this.#socket === socket) {
                    for (const pending of this.#taskRequests.values()) {
                        this.#control(pending.message);
                    }
                }
            })
            .catch(() => {});
        this.#runners.changed();

        if (session.known) {
            this.#wake();
        }

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
                const bytes = toBuffer(data);
                const stream = bytes[0] === STREAM_DATA ? readStreamData(bytes) : undefined;

                if (stream !== undefined) {
                    network.data(stream.id, stream.bytes);
                } else if (bytes[0] === STREAM_DATA) {
                    this.#drop(1002, "Invalid network stream data");
                } else {
                    this.#data(session, bytes);
                }
            } else {
                const message = parseControl(toBuffer(data).toString("utf8"));

                // One computer's message can end its own link, never the server.
                try {
                    if (message?.type.startsWith("net-") === true) {
                        network.message(message as Parameters<LinkNetwork["message"]>[0]);
                    } else {
                        this.#onControl(session, message);
                    }
                } catch (error) {
                    this.#runners.log(
                        `${this.name} sent a message this server could not handle: ${(error as Error).message}`,
                    );
                    this.#drop(1002, "A message the server could not handle");
                }
            }
        });
        socket.on("close", () => {
            clearInterval(pinger);
            network.drop();

            if (this.#socket !== socket) {
                return;
            }

            this.#socket = undefined;
            this.#network = undefined;
            this.#runners.changed();

            if (!session.live || this.#session !== session) {
                return;
            }

            this.#runners.log(`${this.name} went offline; its work waits until it is back.`);
        });
    }

    #onControl(session: LinkSession, message: ControlMessage | undefined): void {
        if (message?.type === "ack") {
            if (!session.outbox.acknowledge(message.received)) {
                this.#drop(1002, "Acknowledged bytes it was never sent");
            }
        } else if (message?.type === "pi-sessions-result") {
            this.#piResults.get(message.id)?.resolve(message);
        } else if (message?.type === "task-result") {
            this.#taskRequests.get(message.id)?.resolve(message);
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

    /**
     * Pi's terminal sessions on this computer (`pi-sessions.ts`): the list, one's last messages, or the one file a new
     * session may read. The server decided who may; offline fails at once, and a computer that does not answer in time
     * fails too.
     */
    async piSessions(request: PiSessionsQuery, signal?: AbortSignal): Promise<PiSessionsResult> {
        this.#refuse(true);
        await this.infoNow();
        this.#refuse(true);

        if (signal?.aborted) {
            throw new HttpError(409, "Cancelled.");
        }

        const id = randomUUID();
        let timer: NodeJS.Timeout | undefined;
        let cancelled: (() => void) | undefined;

        try {
            const answer = await new Promise<PiSessionsResult>((resolve, reject) => {
                cancelled = () => reject(new HttpError(409, "Cancelled."));
                timer = setTimeout(
                    () => reject(new HttpError(409, `The computer ${this.name} did not answer.`)),
                    PI_SESSIONS_MS,
                );
                signal?.addEventListener("abort", cancelled, { once: true });
                this.#piResults.set(id, { resolve, reject });
                this.#control({ type: "pi-sessions", id, ...request });
            });

            if (!answer.ok) {
                throw new HttpError(
                    403,
                    answer.reason ?? `${this.name} refused the Pi session request.`,
                );
            }

            return answer;
        } finally {
            clearTimeout(timer);
            this.#piResults.delete(id);

            if (cancelled !== undefined) {
                signal?.removeEventListener("abort", cancelled);
            }
        }
    }

    /** Start a background task for the session `scope` names, in its folder there (`tasks.ts`). */
    async taskStart(
        scope: SessionScope,
        request: Omit<
            Extract<TaskRequest, { op: "start" }>,
            "type" | "id" | "op" | "permission" | "scope"
        >,
    ): Promise<number> {
        const result = await this.#taskRequest({
            ...request,
            type: "task",
            id: randomUUID(),
            op: "start",
            permission: scope.id,
            scope,
        });

        if (result.pid === undefined) {
            throw new Error("The background task did not return its process id.");
        }

        return result.pid;
    }

    /** The runner's tasks of a session; `ended`: its shell ended, while what it started may still run. */
    async taskList(
        scope: SessionScope,
    ): Promise<{ task: string; pid: number; ended?: boolean; left?: number[] }[]> {
        const result = await this.#taskRequest({
            type: "task",
            id: randomUUID(),
            op: "list",
            permission: scope.id,
            scope,
        });

        return result.tasks ?? [];
    }

    async taskSignal(scope: SessionScope, task: string, signal: "TERM" | "KILL"): Promise<void> {
        await this.#taskRequest({
            type: "task",
            id: randomUUID(),
            op: "signal",
            permission: scope.id,
            scope,
            task,
            signal,
        });
    }

    async #taskRequest(message: TaskRequest): Promise<TaskResult> {
        await this.whenOnline();

        const result = await new Promise<TaskResult>((resolve, reject) => {
            this.#taskRequests.set(message.id, { message, resolve, reject });
            this.#control(message);
        }).finally(() => this.#taskRequests.delete(message.id));

        if (!result.ok) {
            throw new HttpError(
                403,
                result.error ?? "The runner refused the background task request.",
            );
        }

        return result;
    }

    /**
     * Open a TCP connection to `host`:`port` from the computer, and relay `socket` to it (`runner-network.ts`). Rejects
     * with a `NetError` that names the computer when it is offline, its runner is too old, or it refused or failed.
     */
    openNetwork(host: string, port: number, socket: Duplex, options?: OpenOptions): Promise<void> {
        if (this.#runners.blocked(this.id)) {
            return Promise.reject(new NetError("refused", this.#runners.blockedReason(this.id)));
        }

        if (this.#closed || this.#socket === undefined || this.#network === undefined) {
            return Promise.reject(
                new NetError(
                    "offline",
                    `${this.name} is offline. Start Pi Pocket's runner there, then try again.`,
                ),
            );
        }

        return this.#network.open(host, port, socket, options);
    }

    /** Network streams over `socket`: their data waits behind pi-env's (`tunnels.ts`). */
    #networkOf(socket: WebSocket): LinkNetwork {
        return new LinkNetwork({
            name: () => this.name,
            send: (message, done) => {
                if (this.#socket !== socket || socket.readyState !== socket.OPEN) {
                    return false;
                }

                socket.send(message, done);

                return true;
            },
            control: (message) => {
                if (this.#socket === socket && socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify(message));
                }
            },
        });
    }

    /** End a daemon session: what it was doing fails with `error`. */
    #end(session: LinkSession, error: Error): void {
        if (!session.live) {
            return;
        }

        session.live = false;

        if (this.#session === session) {
            this.#session = undefined;
        }

        const pending = [...session.pending.values()];

        session.pending.clear();

        for (const request of pending) {
            request.reject(error);
        }
    }

    /** End the connection. `stop`: its runner is sent away for good (`sendAway`); without it, the runner comes back. */
    #drop(code: number, reason: string, stop?: Stop): void {
        const socket = this.#socket;

        if (socket === undefined) {
            return;
        }

        if (stop === undefined) {
            socket.close(code, reason);
        } else {
            sendAway(socket, code, reason, stop);
        }
    }
}

/**
 * Send a runner away for good. What stops it is `stop`, in a `bye` sealed with the link's keys (`protocol.ts` `Bye`):
 * only this server can say it. The close code after it is for logs; alone, it stops nothing. `said`: what the runner
 * shows, when that is more than the close reason.
 */
function sendAway(
    socket: WebSocket,
    code: number,
    reason: string,
    stop: Stop,
    said = reason,
): void {
    socket.send(JSON.stringify({ type: "bye", reason: said, stop } satisfies ControlMessage));
    socket.close(code, reason);
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
    readonly link: RunnerLink;
    /** The session its requests name, so its runner keeps them inside its folder (`request-gate.ts`). */
    readonly scope: SessionScope | undefined;

    constructor(link: RunnerLink, cwd: string, scope?: SessionScope) {
        const connection = {
            info: () => link.info(),
            session: () => link.session(),
            request: (op: string, json: Record<string, unknown>, options?: RequestOptions) =>
                link.request(op, json, options, scope),
            kill: (id: number, session: number) => link.kill(id, session),
            close: () => {},
        };

        super({
            connection: connection as unknown as Connection,
            id: `runner:${link.id}${scope === undefined ? "" : `:${scope.id}`}`,
            cwd,
        });
        this.runner = link.id;
        this.link = link;
        this.scope = scope;
    }

    /** Probe one absolute path. No snapshot means Pi should use the ordinary remote reader. */
    async readSnapshot(
        path: string,
        context: Context,
    ): Promise<{ info: FileInfo; bytes: Uint8Array } | undefined> {
        if (this.scope === undefined || !this.link.supportsReadSnapshot) {
            return;
        }

        try {
            const session = await this.link.session();

            if (!this.link.supportsReadSnapshot) {
                return;
            }

            const { json, payload } = await this.link.request(
                READ_SNAPSHOT,
                // An older runner ignores maxBytes and returns a snapshot only up to 8 KiB.
                { path, maxBytes: MAX_SNAPSHOT_BYTES },
                { signal: context.abortSignal, session },
                this.scope,
            );

            if (
                typeof json.name === "string" &&
                typeof json.mtimeMs === "number" &&
                Number.isFinite(json.mtimeMs) &&
                payload.length <= MAX_SNAPSHOT_BYTES
            ) {
                return {
                    info: {
                        name: json.name,
                        path,
                        kind: "file",
                        size: payload.length,
                        mtimeMs: json.mtimeMs,
                    },
                    bytes: payload,
                };
            }
        } catch {
            // Preserve pi-env's errors and alternative path resolution. Never use an incomplete snapshot.
        }
    }

    /** The computer, for the system prompt: its name, and its system as it last said. */
    computer(): { name: string; os?: string; arch?: string } {
        return { name: this.link.name, ...this.link.platform() };
    }
}

/** The computers whose runners may connect, and their links. */
export class Runners {
    readonly #config: ConfigStore;
    readonly #linkLimits: LinkLimits;
    readonly #log: (line: string) => void;
    readonly #onChange: () => void;
    /**
     * Whether the Runners sheet lists computer `id` for this person: the access policy's "may start sessions there"
     * (`access.ts` `mayStart`). A viewer sees sessions shared with them in the session list, not the computer here.
     */
    readonly #mayList: (id: string, user: User) => boolean;
    /** May this person change computer `id`'s people and settings (`access.ts` `mayManage`). */
    readonly #mayManage: (id: string, user: User) => boolean;
    readonly #mayStart: (id: string, user: User) => boolean;
    readonly #mayUse: (id: string, user: User) => boolean;
    /** May the person with this id still link a computer, or link `runner` again (`access.ts` `mayLink`, `mayManage`). */
    readonly #mayLink: (by: string, runner?: string) => boolean;
    /** Is computer `id` blocked: its linker was made a viewer (`access.ts` `blocked`). */
    readonly #blocked: (id: string) => boolean;
    readonly #managers: (id: string) => string[];
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
        /** The clock for the wrong link code limits (tests give their own). */
        now?: () => number;
        /** The access policy's "may start sessions there"; absent (tests of the link alone): the owner only. */
        mayList?: (id: string, user: User) => boolean;
        /** The access policy's "may manage"; absent: the owner only. */
        mayManage?: (id: string, user: User) => boolean;
        /** The access policy's "may start sessions there"; absent: as `mayList`. */
        mayStart?: (id: string, user: User) => boolean;
        /** The access policy's "may use it" (in charge of it, or chosen for it); absent: as `mayList`. */
        mayUse?: (id: string, user: User) => boolean;
        /**
         * May the person with id `by` link a computer now, or link `runner` again: asked when their code is used, so a
         * code does not outlive its maker's right. Absent (tests of the link alone): yes.
         */
        mayLink?: (by: string, runner?: string) => boolean;
        /** The access policy's "is blocked" (its linker is a viewer now); absent: never. */
        blocked?: (id: string) => boolean;
        /** The ids of the users in charge of `id` because they manage runners; absent: none. */
        managers?: (id: string) => string[];
    }) {
        this.#config = options.config;
        this.#log = options.log;
        this.#onChange = options.onChange ?? (() => {});

        const ownerOnly = (_id: string, user: User) => {
            const current = this.#config.userById(user.id);

            return current !== undefined && isOwner(current);
        };

        this.#mayList = options.mayList ?? ownerOnly;
        this.#mayManage = options.mayManage ?? ownerOnly;
        this.#mayStart = options.mayStart ?? this.#mayList;
        this.#mayUse = options.mayUse ?? this.#mayList;
        this.#mayLink = options.mayLink ?? (() => true);
        this.#blocked = options.blocked ?? (() => false);
        this.#managers = options.managers ?? (() => []);

        const config = options.config;

        this.#linkLimits = new LinkLimits(options.now, {
            read: () => config.runnerLinkLimits,
            write: (value) => {
                config.runnerLinkLimits = value;
            },
        });
    }

    log(line: string): void {
        this.#log(`Runners: ${line}`);
    }

    /** Is computer `id` blocked: its linker was made a viewer, so nothing starts or runs there (`access.ts`). */
    blocked(id: string): boolean {
        return this.#blocked(id);
    }

    /** What a person is told about blocked computer `id`: its name, and whose role it waits for. */
    blockedReason(id: string): string {
        const runner = this.#config.runnerById(id);
        const linker =
            runner === undefined ? undefined : this.#config.userById(runner.createdBy)?.name;
        const who =
            linker === undefined
                ? "the person who linked it is a viewer now"
                : `${linker}, who linked it, is a viewer now`;

        return `${runner?.name ?? "This computer"} is blocked: ${who}. It works again when they are made a user.`;
    }

    /** Stop what runs for the server on each blocked computer (`RunnerLink.block`): called when access changed. */
    enforce(): void {
        for (const [id, link] of this.#links) {
            if (this.#blocked(id)) {
                link.block();
            }
        }
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
            platform: {
                os: info.os,
                arch: info.arch,
                home: info.home,
                version,
                tmpdir: info.tmpdir,
            },
        });
        // Its system shows in Runners from now: the list went out when it connected, before this was known.
        this.#onChange();
    }

    /**
     * The system of computer `id` as it last said (`hello`), also while it is offline: its OS and temporary folder.
     * Undefined before a runner that tells its temporary folder first connected.
     */
    system(id: string): { os: string; tmpdir: string } | undefined {
        const platform = this.stored(id)?.platform;

        return platform?.tmpdir === undefined
            ? undefined
            : { os: platform.os, tmpdir: platform.tmpdir };
    }

    /** Each hello refreshes readiness, including a resumed daemon session. */
    toolsSeen(id: string, tools: Hello["tools"]): void {
        this.#config.updateRunner(id, { tools });
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
    env(id: string, cwd: string, scope?: SessionScope): RunnerEnv {
        const key = `${id}\0${cwd}\0${scope?.id ?? ""}\0${scope?.folder ?? ""}`;
        let env = this.#envs.get(key);

        if (env === undefined) {
            env = new RunnerEnv(this.link(id), cwd, scope);
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
            throw new HttpError(404, "That computer is not linked to this server.");
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
            .infoNow()
            .catch((error: unknown) => {
                throw error instanceof HttpError
                    ? error
                    : new HttpError(409, error instanceof Error ? error.message : String(error));
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

    /**
     * Check that `path` is a folder on computer `id`; its real path there, links followed. The access policy compares
     * that path with the folders given (`access.ts` `inFolder`), and the runner keeps a session in the real folder
     * (`request-gate.ts`): a link in a given folder that leads out of it is outside it here as there.
     */
    async checkFolder(id: string, path: string): Promise<string> {
        const { env, path: absolute } = await this.#resolve(id, path);
        const real = await env.canonicalPath(absolute, BACKGROUND);
        const info = real.ok ? await env.fileInfo(real.value, BACKGROUND) : real;

        if (!real.ok || !info.ok || info.value.kind !== "directory") {
            throw new HttpError(
                400,
                `${absolute} is not a folder on ${this.name(id)}${info.ok ? "" : `: ${info.error.message}`}`,
            );
        }

        return real.value;
    }

    /** The real path of `path` on computer `id`, links followed; undefined when it does not exist there. */
    async realPath(id: string, path: string): Promise<string | undefined> {
        const { env, path: absolute } = await this.#resolve(id, path);
        const real = await env.canonicalPath(absolute, BACKGROUND);

        return real.ok ? real.value : undefined;
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

        const run = limitParallel(8);
        const picked = await Promise.all(
            listed.value
                .filter((entry) => hidden || !entry.name.startsWith("."))
                .map(({ kind, name, path }) => {
                    if (kind === "directory") {
                        return { name, path };
                    }

                    if (kind !== "symlink") {
                        return undefined;
                    }

                    return run(async () => {
                        // Only this link's real path is needed for its stat.
                        const real = await resolved.env.canonicalPath(path, BACKGROUND);
                        const target = await resolved.env.fileInfo(
                            real.ok ? real.value : path,
                            BACKGROUND,
                        );

                        return target.ok && target.value.kind === "directory"
                            ? { name, path }
                            : undefined;
                    });
                }),
        );
        // Equal names keep their listing order, not the order of replies.
        const dirs = picked
            .filter((entry) => entry !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name));

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

    /** Who is locked out of linking now, and whether all of it is paused (`link-limits.ts`), for the Runners sheet. */
    linkLocks(): LinkLocks {
        return this.#linkLimits.locks();
    }

    /** Lift the ban on `address` (the owner's, in Runners). */
    liftLinkBan(address: string): void {
        if (!this.#linkLimits.lift(address)) {
            throw new HttpError(404, "That address is not banned.");
        }

        this.log(`The link ban on ${address} was lifted.`);
        this.changed();
    }

    /** With a person, only the computers they may use; owners see all, and the granted people. */
    list(user?: User): RunnerView[] {
        return this.#config.runners
            .filter((runner) => user === undefined || this.#mayList(runner.id, user))
            .map((runner) => {
                const link = this.#links.get(runner.id);
                // Its people, folders, and settings are the business of who is in charge of it: its linker.
                const manages = user === undefined || this.#mayManage(runner.id, user);
                // What the computer is (its system, home folder, runner version, and sign-ins) is for the people who
                // may use it. The owner lists a computer someone else linked only to unlink it, and learns none of it.
                const uses = user === undefined || this.#mayUse(runner.id, user);

                return {
                    id: runner.id,
                    name: runner.name,
                    createdBy: runner.createdBy,
                    ...(runner.publicKey === undefined
                        ? { relink: true as const }
                        : manages
                          ? { fingerprint: fingerprint(runner.publicKey) }
                          : {}),
                    ...(manages
                        ? {
                              users: (runner.users ?? []).flatMap((id) => {
                                  const person = this.#config.userById(id);

                                  return person === undefined
                                      ? []
                                      : [{ id, name: person.name, role: person.role }];
                              }),
                              given: Object.fromEntries(
                                  (runner.users ?? []).map((id) => [
                                      id,
                                      [...this.#config.givenFolders(runner.id, id)],
                                  ]),
                              ),
                              sees: Object.fromEntries(
                                  (runner.users ?? []).map((id) => [
                                      id,
                                      [...this.#config.seenFolders(runner.id, id)],
                                  ]),
                              ),
                              seesUntil: Object.fromEntries(
                                  (runner.users ?? []).map((id) => [
                                      id,
                                      { ...this.#config.seenUntil(runner.id, id) },
                                  ]),
                              ),
                              rights: this.#config.rightsOn(runner.id),
                              managers: this.#managers(runner.id),
                          }
                        : {}),
                    // Its settings are its managers' business; a granted person sees only that it is there.
                    ...(manages
                        ? {
                              network: runner.settings?.network !== false,
                              ...(runner.settings?.downloads === undefined
                                  ? {}
                                  : { downloads: runner.settings.downloads }),
                              ...(link?.allowHttp === true ? { allowHttp: true as const } : {}),
                          }
                        : {}),
                    ...(this.#blocked(runner.id) ? { blocked: true as const } : {}),
                    ...(user === undefined ? {} : { inCharge: manages }),
                    ...(user !== undefined && !this.#mayStart(runner.id, user)
                        ? { mayStart: false as const }
                        : {}),
                    online: link?.online === true,
                    away: link?.away === true,
                    ...(runner.lastSeen === undefined ? {} : { lastSeen: runner.lastSeen }),
                    ...(uses ? (runner.platform ?? {}) : {}),
                    ...(uses && runner.tools !== undefined ? { tools: runner.tools } : {}),
                };
            });
    }

    /**
     * A one-time code that links a computer named `name`: `pi-pocket-runner link <server> <code>` on it. With `runner`, a
     * code that links that computer again: its runner gets a new key, and it keeps its id, people, and sessions.
     */
    makeCode(
        name: string,
        createdBy: string,
        runner?: string,
    ): { code: string; expiresAt: number; package: string; command: string; fingerprint: string } {
        const again = runner === undefined ? undefined : this.#config.runnerById(runner);

        if (runner !== undefined && again === undefined) {
            throw new HttpError(404, "No such computer");
        }

        const clean = again?.name ?? name.replace(/\s+/g, " ").trim().slice(0, 60);

        if (clean === "") {
            throw new HttpError(400, "Give the computer a name.");
        }

        if (again === undefined && this.#config.runners.some((each) => each.name === clean)) {
            throw new HttpError(
                409,
                `A computer named ${clean} is already linked. Choose another name.`,
            );
        }

        // 12 characters of an alphabet without look-alikes (no 0/O, 1/I/L): 60 bits, easy to read out and type.
        const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
        const raw = [...randomBytes(12)].map((byte) => alphabet[byte % 31]).join("");
        const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
        const expiresAt = Date.now() + CODE_MINUTES * 60_000;

        this.#config.addRunnerCode(code, clean, createdBy, expiresAt, again?.id);

        return {
            code,
            expiresAt,
            ...runnerInstall(),
            fingerprint: fingerprint(this.#config.serverIdentity.publicKey),
        };
    }

    /**
     * A runner proves it knows a one-time code and gives its public key (`secure-link.ts`): it gets this server's key
     * and proof that this server knows the code too. The code never travels. `address`: the client's
     * (`link-limits.ts` `clientAddress`). Wrong codes are counted: too many from one address lock it out, and its
     * third lockout bans it; too many in all pause new linking and void the open codes. Linked computers and their keys
     * stay as they are.
     */
    redeem(request: LinkRequest, address = "unknown"): LinkAnswer {
        this.#linkLimits.check(address);

        if (!isPublicKey(request.runnerKey) || typeof request.proof !== "string") {
            throw new HttpError(
                400,
                "Update Pi Pocket's runner on this computer, then link it again.",
            );
        }

        const found = this.#config.takeRunnerCode((hash) => checkLinkRequest(hash, request));

        if (found === undefined) {
            const result = this.#linkLimits.wrong(address);

            if (result.banned) {
                this.log(
                    `Too many wrong link codes from ${address}, for the third time: it is banned from linking until you lift the ban in Runners.`,
                );
            } else if (result.locked) {
                this.log(
                    `Too many wrong link codes from ${address}: it is locked out for 10 minutes.`,
                );
            }

            if (result.ceiling) {
                this.#config.voidRunnerCodes();
                this.log(
                    "Too many wrong link codes reached this server: new linking is paused for 10 minutes, and open codes were voided. Linked computers are not affected.",
                );
            }

            this.changed();

            throw new HttpError(403, WRONG_CODE);
        }

        // A code is worth its maker's right to link, now: taken back, or the person removed, it links nothing. The code
        // is used up, and this is no wrong code: the runner knew it.
        if (!this.#mayLink(found.createdBy, found.runner)) {
            this.log(
                `A link code for ${found.name} was refused: the person who made it may no longer link it.`,
            );

            throw new HttpError(403, WRONG_CODE);
        }

        const again =
            found.runner === undefined
                ? undefined
                : this.#config.relinkRunner(found.runner, request.runnerKey);

        if (found.runner !== undefined && again === undefined) {
            throw new HttpError(404, "That computer was removed. Make a new link code in Runners.");
        }

        const runner =
            again ?? this.#config.addRunner(found.name, found.createdBy, request.runnerKey);

        // Linked again: the old connection, with the old key, ends now.
        if (again !== undefined) {
            this.#links.get(runner.id)?.relinked();
        }

        this.log(`${runner.name} was ${again === undefined ? "linked" : "linked again"}.`);
        this.changed();

        const serverKey = this.#config.serverIdentity.publicKey;
        const answer = { id: runner.id, name: runner.name, serverKey };

        return { ...answer, proof: linkAnswerProof(found.codeHash, request.runnerKey, answer) };
    }

    /** Forget a computer: its runner is sent away, and its key stops working. */
    remove(id: string): void {
        const runner = this.#config.runnerById(id);

        if (runner === undefined) {
            throw new HttpError(404, "No such computer");
        }

        this.#links.get(id)?.remove();
        this.#links.delete(id);

        for (const key of this.#envs.keys()) {
            if (key.startsWith(`${id}\0`)) {
                this.#envs.delete(key);
            }
        }

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

        const offered = String(request.headers["sec-websocket-protocol"] ?? "")
            .split(",")
            .map((each) => each.trim());

        if (!offered.includes(LINK_SUBPROTOCOL)) {
            refuse(426, `This server speaks ${LINK_SUBPROTOCOL}: update the runner or the server`);

            return true;
        }

        this.#server.handleUpgrade(request, socket, head, (ws) => {
            // Who it is comes from the handshake: the runner proves its computer's key (`secure-link.ts`).
            const link = new ServerLinkSocket(ws, {
                identity: this.#config.serverIdentity,
                runnerKey: (id) => this.#config.runnerById(id)?.publicKey,
                unknown: CLOSE.removed,
            });

            link.once("open", () => {
                const runner = this.#config.runnerById(link.id!);

                if (runner === undefined) {
                    sendAway(link, CLOSE.removed, "Removed", "removed");
                } else if (runner.publicKey !== link.key) {
                    // Linked again while it proved the old key, which opens nothing now.
                    sendAway(link, CLOSE_IDENTITY, "This computer was linked again", "relinked");
                } else {
                    this.#accept(link, runner, link.key);
                }
            });
            link.on("error", () => {});
        });

        return true;
    }

    /** `key`: the public key the runner proved in the handshake (`ServerLinkSocket`). */
    #accept(socket: WebSocket, runner: StoredRunner, key: string | undefined): void {
        const timer = setTimeout(() => socket.close(1002, "No hello"), HELLO_MS);

        socket.once("close", () => clearTimeout(timer));
        socket.once("message", (data: RawData, binary: boolean) => {
            clearTimeout(timer);

            const hello = binary ? undefined : parseControl(toBuffer(data).toString("utf8"));

            if (hello?.type !== "hello") {
                socket.close(1002, "Say hello first");

                return;
            }

            if (hello.protocol !== LINK_PROTOCOL) {
                sendAway(
                    socket,
                    CLOSE.protocol,
                    "Protocol",
                    "protocol",
                    `This server speaks link protocol ${LINK_PROTOCOL}, the runner ${hello.protocol}`,
                );

                return;
            }

            // Still here: removed while it was saying hello.
            const now = this.#config.runnerById(runner.id);

            if (now === undefined) {
                sendAway(socket, CLOSE.removed, "Removed", "removed");

                return;
            }

            // Linked again while it was saying hello: linking again ends the connections it finds (`relinked`), and
            // this one was not yet one. The key it proved is the old one, which opens nothing now.
            if (now.publicKey !== key) {
                sendAway(socket, CLOSE_IDENTITY, "This computer was linked again", "relinked");

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
