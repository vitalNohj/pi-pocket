/**
 * The runner, not the server, authorizes every pi-env request before the daemon sees it (`docs/runners.md`).
 *
 * A server that negotiated approvals (`welcome.approvals`) names the session of each request in `SESSION_FIELD`, which
 * is removed here. Without a valid session permission, only `hello` and folder listing (`lstat`, `realpath`,
 * `opendir`, and `readdir` and `close` on a listed folder) pass. Every other request needs a valid permission for the
 * session it names, and each path it carries must be in that permission's folder or below it, or in the runner's own
 * folders for attached files and browser downloads. Pi's context files above the folder and its skills there and in
 * the home folder can also be read (`piReads`). An expired permission makes the request wait while the computer
 * asks again.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { folderContains, realFolder } from "./folders.ts";
import type { Approvals, SessionScope } from "./approvals.ts";
import type { RunnerRequestTiming } from "./perf.ts";
import { FRAME, frame, readFrame, SESSION_FIELD } from "./protocol.ts";
import { captureSnapshot, READ_SNAPSHOT, snapshotCandidate } from "./read-snapshot.ts";

type Request = {
    scope?: SessionScope;
    op: string;
    path?: string;
    directory: boolean;
    stop: AbortController;
    sent: boolean;
    finish?: () => void;
    /** For `close`: the handle it closes. pi-env's answer is `{}`, so it is known only from the request. */
    handle?: number;
};

type Handle = { scope?: SessionScope; path: string; directory: boolean; readOnly: boolean };

/**
 * The requests of pi-env's client (protocol 1) that Pi Pocket uses. Anything else is refused, so an op a later pi-env
 * adds, with a path in a field this gate does not read, cannot pass its folder check unseen. pi-env 1.5.2 added
 * `process`, `processWrite` and `processCloseStdin` (a program with plain pipes, for MCP servers): Pi Pocket starts
 * none, so they stay refused until something here needs them and this gate checks their fields.
 */
const KNOWN_OPS = new Set([
    "hello",
    "lstat",
    "realpath",
    "write",
    "writeChunk",
    "truncate",
    "fsync",
    "rename",
    "mkdir",
    "rm",
    "mkdtemp",
    "open",
    "pread",
    "fstat",
    "scanLines",
    READ_SNAPSHOT,
    "opendir",
    "readdir",
    "close",
    "listFiles",
    "exec",
    "watch",
    "pty",
    "ptyWrite",
    "ptyResize",
    "ptyForeground",
]);

/** What works without a session permission: the folder picker's listing. */
const LISTING = new Set(["hello", "lstat", "realpath", "opendir"]);

/** These operations cannot change paths before a later request checks them. `open` only opens a reader. */
const CHECK_AHEAD = new Set([
    ...LISTING,
    "open",
    "pread",
    "fstat",
    "scanLines",
    "listFiles",
    "watch",
    READ_SNAPSHOT,
]);
const CHECK_LIMIT = 16;

/** What only reads a file opened with `open`. */
const READING = new Set(["pread", "fstat", "scanLines", "close"]);

/** Pi's context files, as `remote-context.ts` on the server looks for them. */
const CONTEXT_FILES = new Set([
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
]);

/**
 * What Pi reads for a session besides its folder: the context files in the folders above it, the `.agents/skills/`
 * folders there, and the skills in the home folder. A session may read these, never change them. Its commands could
 * read them anyway.
 */
function piReads(folder: string, home: string, path: string): boolean {
    const skills = [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")];
    const parent = dirname(path);

    for (let current = folder; ; current = dirname(current)) {
        if (
            CONTEXT_FILES.has(basename(path)) &&
            folderContains(current, parent) &&
            folderContains(parent, current)
        ) {
            return true;
        }

        skills.push(join(current, ".agents", "skills"));

        if (dirname(current) === current) {
            break;
        }
    }

    return skills.some((root) => folderContains(root, path));
}

/** Resolve existing ancestors too: a missing child behind an outside symlink must not pass the path check. */
export async function canonical(path: string): Promise<string> {
    let at = resolve(path);
    const tail: string[] = [];

    for (;;) {
        try {
            return join(await realpath(at), ...tail);
        } catch (error) {
            const parent = dirname(at);
            const code = (error as NodeJS.ErrnoException).code ?? "";

            if (parent === at || !["ENOENT", "ENOTDIR"].includes(code)) {
                throw error;
            }

            tail.unshift(at.slice(parent.length).replace(/^[/\\]/, ""));
            at = parent;
        }
    }
}

type Prepared = { paths: string[] } | { listing: true; path: string | undefined };
type Checked = { prepared: Prepared } | { error: unknown };
type Check = { epoch: number; barrierSends: number; result: Promise<Checked> };
type Queued = {
    id: number;
    request: Request;
    json: Record<string, unknown>;
    payload: Uint8Array;
    check?: Check;
};

/** One session's requests, in arrival order, and the question that asks for all of them. */
type Waiting = {
    requests: Set<Queued>;
    question?: AbortController;
    epoch: number;
    barrierSends: number;
    draining: boolean;
};

/**
 * A signal that aborts when every request of the session that waits was cancelled, also one that came later. A
 * session's question asks for all of them, so a cancelled one does not end it while another one still waits.
 */
function whileWaiting(waiting: Waiting): AbortSignal {
    const question = new AbortController();

    waiting.question = question;
    // The answer may change the permission and the paths must be resolved anew after the wait.
    waiting.epoch++;
    cancelled(waiting);

    return question.signal;
}

function cancelled(waiting: Waiting): void {
    if (
        waiting.question !== undefined &&
        [...waiting.requests].every(({ request }) => request.stop.signal.aborted)
    ) {
        waiting.question.abort();
    }
}

/**
 * A permission id the server makes: a UUID, or a session number for a session from before UUIDs. It names folders on
 * this computer (`<temp>/pi-pocket-tasks/<id>`, `<downloads>/<id>`), so nothing else is taken: not `.ssh`, not `..`.
 */
export function permissionId(id: unknown): id is string {
    return (
        typeof id === "string" &&
        (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
            /^[1-9][0-9]{0,15}$/.test(id))
    );
}

export function sessionScope(value: unknown): SessionScope | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const scope = value as Record<string, unknown>;

    return permissionId(scope.id) &&
        typeof scope.folder === "string" &&
        isAbsolute(scope.folder) &&
        typeof scope.person === "string"
        ? (scope as SessionScope)
        : undefined;
}

export type GateOptions = {
    approvals: Approvals;
    /** Ask the computer again for a session without a valid permission; true when it was approved. */
    ask: (scope: SessionScope, signal: AbortSignal) => Promise<boolean>;
    /** Whole frames to the daemon. */
    send: (bytes: Buffer) => void;
    /** Whole frames back to the server, as if the daemon sent them. */
    reply: (bytes: Buffer) => void;
    /** The runner's own folders for session `id` (its permission): its attached files and browser downloads. */
    shared: (id: string) => Promise<string[]>;
    /** The real temporary folder, where `mkdtemp` may make a folder for a session. */
    tmpdir: () => Promise<string>;
    /** The computer's name, for refusals. */
    name: () => string;
    /** Only the built-in daemon shares its filesystem with the runner. */
    readSnapshot?: boolean;
    /** Resolve a request's path. Defaults to `canonical`. */
    resolvePath?: typeof canonical;
    timing?: RunnerRequestTiming;
    /** A request of a session in `folder` reaches the daemon; the result is called when it ended (`activity.ts`). */
    working?: (folder: string) => () => void;
};

export class RequestGate {
    readonly #options: GateOptions;
    readonly #resolvePath: typeof canonical;
    readonly #requests = new Map<number, Request>();
    readonly #handles = new Map<number, Handle>();
    /** Each session's requests that wait for their check: its question stands while one of them still waits. */
    readonly #waiting = new Map<string, Waiting>();
    /** The folders `mkdtemp` made for each session: codemode's work folders and temporary files. */
    readonly #temporary = new Map<string, Set<string>>();
    /** Exact real files, never folders, bound to this generation of a session's permission. */
    readonly #extraReads = new Map<string, { approvedAt: number; files: Map<string, number> }>();

    constructor(options: GateOptions) {
        this.#options = options;
        this.#resolvePath = options.resolvePath ?? canonical;
    }

    /** Allow one listed Pi file for at most 5 minutes, only with the still-valid session permission. */
    async allowRead(session: string, path: string): Promise<void> {
        const permission = await this.#options.approvals.valid(session);

        if (permission === undefined) {
            throw new Error(`Session not approved on ${this.#options.name()}`);
        }

        const real = await realpath(path);
        const previous = this.#extraReads.get(session);
        const grant =
            previous?.approvedAt === permission.approvedAt
                ? previous
                : { approvedAt: permission.approvedAt, files: new Map<string, number>() };
        const until = Date.now() + 5 * 60_000;

        grant.files.set(real, until);
        this.#extraReads.set(session, grant);
        setTimeout(() => {
            if (grant.files.get(real) === until) {
                grant.files.delete(real);
            }

            if (grant.files.size === 0 && this.#extraReads.get(session) === grant) {
                this.#extraReads.delete(session);
            }
        }, 5 * 60_000).unref();
    }

    revokeReads(session: string): void {
        if (session === "all") {
            this.#extraReads.clear();
        } else {
            this.#extraReads.delete(session);
        }
    }

    /** A control request uses the same live permission and canonical path check as an exec request, without asking. */
    async task(id: string, cwd?: string): Promise<() => void> {
        const permission = await this.#options.approvals.valid(id);

        if (permission === undefined) {
            throw new Error(`Session not approved on ${this.#options.name()}`);
        }

        const paths = await this.#paths(cwd === undefined ? {} : { cwd });

        if (!(await this.#inside(id, permission.folder, paths))) {
            throw new Error(
                `The path is outside the session's approved folder on ${this.#options.name()}`,
            );
        }

        const used = this.#options.approvals.begin(id);
        const working = this.#options.working?.(permission.folder);

        return () => {
            used();
            working?.();
        };
    }

    /** The daemon stopped, or the runner: what waits is dropped, and use ends. */
    stop(): void {
        for (const request of this.#requests.values()) {
            request.stop.abort();
            request.finish?.();
        }

        this.#requests.clear();
        this.#handles.clear();
        this.#temporary.clear();
        this.#extraReads.clear();
    }

    /** A whole frame from the server. Throws for a frame the protocol does not allow. */
    input(whole: Buffer): void {
        const { type, id, json, payload } = readFrame(whole);

        if (type === FRAME.ping) {
            return;
        }

        if (type === FRAME.cancel) {
            const request = this.#requests.get(id);
            // The session that sent the request cancels it; pi-env's client sends its own session with each frame.
            const from = sessionScope(json[SESSION_FIELD]);

            delete json[SESSION_FIELD];

            if (request !== undefined && from?.id === request.scope?.id) {
                request.stop.abort();

                if (request.sent) {
                    this.#options.send(frame(FRAME.cancel, id, json));
                } else {
                    // Cancel is a control frame, not an auth decision. A caller may wait for this reply before
                    // answering the question or releasing a snapshot read. The question can still have other waiters.
                    this.#refuse(id, request, "The request was cancelled");
                }
            }

            return;
        }

        if (type !== FRAME.request || this.#requests.has(id)) {
            throw new Error("Invalid request frame");
        }

        const named = sessionScope(json[SESSION_FIELD]);
        const op = String(json.op);
        const request: Request = {
            ...(named === undefined ? {} : { scope: named }),
            op,
            directory: op === "opendir",
            stop: new AbortController(),
            sent: false,
            ...(op === "close" && typeof json.handle === "number" ? { handle: json.handle } : {}),
        };

        delete json[SESSION_FIELD];
        this.#requests.set(id, request);
        this.#options.timing?.begin(id, KNOWN_OPS.has(op) ? op : "unknown", whole.length);

        const key = request.scope?.id ?? "";
        const waiting = this.#waiting.get(key) ?? {
            requests: new Set<Queued>(),
            epoch: 0,
            barrierSends: 0,
            draining: false,
        };

        waiting.requests.add({ id, request, json, payload });
        this.#waiting.set(key, waiting);
        request.stop.signal.addEventListener("abort", () => cancelled(waiting), { once: true });
        this.#fill(waiting);

        if (!waiting.draining) {
            waiting.draining = true;
            void this.#drain(key, waiting);
        }
    }

    /** Start a bounded window of independent checks, never past a question or an operation that can change paths. */
    #fill(waiting: Waiting): void {
        if (waiting.question !== undefined) {
            return;
        }

        let count = 0;

        for (const job of waiting.requests) {
            const ahead = CHECK_AHEAD.has(job.request.op);

            if (count === CHECK_LIMIT || (count > 0 && !ahead)) {
                break;
            }

            if (job.check === undefined && !job.request.stop.signal.aborted) {
                this.#options.timing?.check(job.id);
                job.check = {
                    epoch: waiting.epoch,
                    barrierSends: waiting.barrierSends,
                    result: this.#prepare(job).then(
                        (prepared) => ({ prepared }),
                        (error: unknown) => ({ error }),
                    ),
                };
            }

            if (!ahead) {
                break;
            }

            count++;
        }
    }

    async #drain(key: string, waiting: Waiting): Promise<void> {
        // Only the first request can ask, count as use of the permission, or go to the daemon. A send or refusal
        // ends its turn, so later requests never observe a handle or permission decision out of order.
        for (const job of waiting.requests) {
            const { id, request, json, payload, check } = job;

            try {
                const result = await check?.result;

                if (request.stop.signal.aborted) {
                    throw new Error("The request was cancelled");
                }

                // Earlier read-only requests cannot change these paths. A question or a dispatch outside the
                // read-only window can, so do not use a result from before either one.
                let prepared: Prepared;

                if (
                    result === undefined ||
                    check?.epoch !== waiting.epoch ||
                    check.barrierSends !== waiting.barrierSends
                ) {
                    prepared = await this.#prepare(job);
                } else if ("error" in result) {
                    throw result.error;
                } else {
                    prepared = result.prepared;
                }

                await this.#authorize(job, prepared, waiting);

                if (request.stop.signal.aborted) {
                    throw new Error("The request was cancelled");
                }

                if (request.op === READ_SNAPSHOT) {
                    this.#options.timing?.checked(id, "snapshot");
                    await this.#snapshot(id, request, json.path, json.maxBytes);
                } else {
                    const outgoing = frame(FRAME.request, id, json, payload);

                    if (!CHECK_AHEAD.has(request.op)) {
                        waiting.barrierSends++;
                    }

                    request.sent = true;
                    this.#options.timing?.checked(id, "daemon");
                    this.#options.send(outgoing);
                }
            } catch (error) {
                this.#refuse(id, request, (error as Error).message);
            } finally {
                waiting.requests.delete(job);
                this.#fill(waiting);
            }
        }

        this.#waiting.delete(key);
    }

    /** Read only the path the gate authorized. Aliases and failures stay on the normal tool path. */
    async #snapshot(id: number, request: Request, path: unknown, maxBytes: unknown): Promise<void> {
        const signal = request.stop.signal;
        const real = request.path;
        let snapshot;

        if (real !== undefined && real === path) {
            const before = await snapshotCandidate(real, maxBytes);

            if (before !== undefined) {
                snapshot = await captureSnapshot(real, before, signal);
            }
        }

        if (this.#requests.get(id) !== request || signal.aborted) {
            return;
        }

        this.#requests.delete(id);
        request.finish?.();
        this.#options.reply(
            snapshot === undefined
                ? frame(FRAME.result, id, {})
                : frame(
                      FRAME.result,
                      id,
                      { name: snapshot.name, mtimeMs: snapshot.mtimeMs },
                      snapshot.bytes,
                  ),
        );
    }

    /** Answer a request that does not reach the daemon, once. */
    #refuse(id: number, request: Request, message: string): void {
        if (this.#requests.get(id) === request) {
            this.#requests.delete(id);
            request.finish?.();
            this.#options.reply(frame(FRAME.error, id, { code: "EACCES", message }));
        }
    }

    /** Resolve the parts of the check that do not grant access or change session state. */
    async #prepare({ request, json }: Queued): Promise<Prepared> {
        if (!KNOWN_OPS.has(request.op)) {
            throw new Error(
                `The runner on ${this.#options.name()} does not know the request "${request.op}"`,
            );
        }

        const snapshot = request.op === READ_SNAPSHOT;

        if (snapshot && (this.#options.readSnapshot !== true || typeof json.path !== "string")) {
            throw new Error(`A file snapshot is not available on ${this.#options.name()}`);
        }

        // Directory-handle listing is checked only in order, after earlier requests have reached the daemon.
        if (LISTING.has(request.op) || this.#directoryListing(request, json)) {
            const path = json.path;
            // A folder the picker cannot resolve still lists as the daemon decides.
            const real =
                typeof path === "string" && isAbsolute(path)
                    ? await this.#resolvePath(path).catch(() => resolve(path))
                    : undefined;

            return { listing: true, path: real };
        }

        return { paths: await this.#paths(json) };
    }

    #directoryListing(request: Request, json: Record<string, unknown>): boolean {
        return (
            ["readdir", "close"].includes(request.op) &&
            typeof json.handle === "number" &&
            this.#handles.get(json.handle)?.directory === true
        );
    }

    /** Check current session state at this request's turn, not while waiting behind an earlier request. */
    async #authorize(
        { request, json }: Queued,
        prepared: Prepared,
        waiting: Waiting,
    ): Promise<void> {
        if ("listing" in prepared) {
            if (!LISTING.has(request.op) && !this.#directoryListing(request, json)) {
                throw new Error("The handle is no longer open for listing");
            }

            request.path = prepared.path;

            return;
        }

        const scope = request.scope;
        const snapshot = request.op === READ_SNAPSHOT;

        if (scope === undefined) {
            throw new Error(`A session permission on ${this.#options.name()} is required`);
        }

        // Resolve the grant's own folder at this request's turn. A folder replaced while it waited must not
        // keep its permission just because the request paths were resolved before the change.
        let permission = await this.#options.approvals.valid(scope);

        if (permission === undefined && snapshot) {
            // With no approved path to snapshot, let the normal open ask once, at its usual point in the read.
            return;
        }

        if (permission === undefined && !request.stop.signal.aborted) {
            this.revokeReads(scope.id);

            // Expired, revoked, or never approved: ask again, and wait. No later check starts while it is open.
            try {
                if (await this.#options.ask(scope, whileWaiting(waiting))) {
                    prepared = { paths: await this.#paths(json) };
                    permission = await this.#options.approvals.valid(scope);
                }
            } finally {
                delete waiting.question;
            }
        }

        if (permission === undefined) {
            throw new Error(`Session not approved on ${this.#options.name()}`);
        }

        // A command runs in a folder of its session: with none named, its approved folder (inside by definition),
        // never the runner's own.
        if ((request.op === "exec" || request.op === "pty") && typeof json.cwd !== "string") {
            json.cwd = permission.folder;
        }

        const handle = typeof json.handle === "number" ? this.#handles.get(json.handle) : undefined;
        const paths = handle === undefined ? prepared.paths : [handle.path, ...prepared.paths];

        if (
            typeof json.handle === "number" &&
            (handle === undefined || handle.scope?.id !== scope.id)
        ) {
            throw new Error("The handle belongs to another session");
        }

        if (typeof json.target === "number") {
            const target = this.#requests.get(json.target);

            if (target?.scope?.id !== scope.id) {
                throw new Error("The request belongs to another session");
            }
        }

        // A new temporary folder: in the temporary folder itself, and from then on the session's own.
        const temporary =
            request.op === "mkdtemp" &&
            paths.length === 1 &&
            dirname(paths[0]!) === (await this.#options.tmpdir());

        // Pi's context files and skills: read only, in a file opened to read.
        const reading =
            snapshot ||
            request.op === "open" ||
            (handle?.readOnly === true && READING.has(request.op));
        const extra = this.#extraReads.get(scope.id);

        if (extra !== undefined && extra.approvedAt !== permission.approvedAt) {
            this.revokeReads(scope.id);
        }

        const extraReading =
            reading &&
            extra?.approvedAt === permission.approvedAt &&
            paths.length > 0 &&
            paths.every((path) => (extra.files.get(path) ?? 0) > Date.now());

        if (
            !temporary &&
            !(await this.#inside(scope.id, permission.folder, paths)) &&
            !(reading && (extraReading || (await this.#piReads(permission.folder, paths))))
        ) {
            throw new Error(
                `The path is outside the session's approved folder on ${this.#options.name()}`,
            );
        }

        if (snapshot || typeof json.path === "string") {
            // The path as checked above, not a second resolution of the same name.
            request.path = snapshot ? paths[0] : prepared.paths[0];
        }

        if (!request.stop.signal.aborted && request.op !== "watch") {
            const used = this.#options.approvals.begin(scope.id);
            const working = this.#options.working?.(permission.folder);

            request.finish = () => {
                used();
                working?.();
            };
        }
    }

    async #piReads(folder: string, paths: string[]): Promise<boolean> {
        const home = await realFolder(homedir());

        return paths.every((path) => piReads(folder, home, path));
    }

    /** Each path a request names, made absolute and real. A relative or non-text path is refused. */
    async #paths(json: Record<string, unknown>): Promise<string[]> {
        const given: unknown[] = [json.path, json.cwd, json.to];

        if (Array.isArray(json.targets)) {
            for (const target of json.targets) {
                given.push((target as { path?: unknown } | null)?.path);
            }
        }

        const absolute: string[] = [];

        for (const path of given) {
            if (path === undefined) {
                continue;
            }

            if (typeof path !== "string" || !isAbsolute(path)) {
                throw new Error("A request path must be absolute");
            }

            absolute.push(path);
        }

        const paths: string[] = [];

        const real = async (path: string) => {
            try {
                return { value: await this.#resolvePath(path) } as const;
            } catch (error) {
                return { error } as const;
            }
        };

        // Watch requests may name many paths. Keep each group bounded and wait for it even if one path fails.
        for (let i = 0; i < absolute.length; i += CHECK_LIMIT) {
            const group = await Promise.all(absolute.slice(i, i + CHECK_LIMIT).map(real));

            for (const result of group) {
                if ("error" in result) {
                    throw result.error;
                }

                paths.push(result.value);
            }
        }

        return paths;
    }

    async #inside(session: string, folder: string, paths: readonly string[]): Promise<boolean> {
        if (paths.every((path) => folderContains(folder, path))) {
            return true;
        }

        const shared = [
            ...(await this.#options.shared(session)),
            ...(this.#temporary.get(session) ?? []),
        ];

        return paths.every(
            (path) =>
                folderContains(folder, path) || shared.some((root) => folderContains(root, path)),
        );
    }

    /** A whole frame from the daemon: results end their request's use and keep their handle's session. */
    output(whole: Buffer): void {
        const { type, id, json } = readFrame(whole);
        const request = this.#requests.get(id);

        if (request === undefined || (type !== FRAME.result && type !== FRAME.error)) {
            return;
        }

        if (
            type === FRAME.result &&
            typeof json.handle === "number" &&
            request.path !== undefined
        ) {
            this.#handles.set(json.handle, {
                ...(request.scope === undefined ? {} : { scope: request.scope }),
                path: request.path,
                directory: request.directory,
                readOnly: request.op === "open",
            });
        }

        if (
            type === FRAME.result &&
            request.op === "mkdtemp" &&
            request.scope !== undefined &&
            typeof json.path === "string" &&
            request.path !== undefined
        ) {
            const made = this.#temporary.get(request.scope.id) ?? new Set<string>();

            // Its real path: the asked one, resolved, with the name the daemon chose.
            made.add(join(dirname(request.path), basename(json.path)));
            this.#temporary.set(request.scope.id, made);
        }

        if (request.handle !== undefined) {
            this.#handles.delete(request.handle);
        }

        request.finish?.();
        this.#requests.delete(id);
    }
}
