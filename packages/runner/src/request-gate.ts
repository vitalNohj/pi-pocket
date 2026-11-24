/**
 * The runner keeps each pi-env request inside the session the server names (`docs/runners.md`). After the link, the
 * runner trusts its server: the server decided who may use which folder (`src/server/access.ts`). This is defense in
 * depth against a mistake there, not a second judge.
 *
 * The server names the session of each request in `SESSION_FIELD`, which is removed here. Without one, only `hello`
 * and folder listing (`lstat`, `realpath`, `opendir`, and `readdir` and `close` on a listed folder) pass. Every
 * other request must name a session, and each path it carries must be in that session's folder or below it, or in the
 * runner's own folders for attached files and browser downloads. Pi's context files above the folder and its skills
 * there and in the home folder can also be read (`piReads`).
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { folderContains, realFolder } from "./folders.ts";
import { FRAME, frame, readFrame, SESSION_FIELD, type SessionScope } from "./protocol.ts";
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

type Prepared =
    { listing: true; path: string | undefined } | { scope: SessionScope; paths: string[] };
type Checked = { prepared: Prepared } | { error: unknown };
type Queued = {
    id: number;
    request: Request;
    json: Record<string, unknown>;
    payload: Uint8Array;
    check?: Promise<Checked>;
};

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

/** What works without a session: the folder picker's listing. */
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

/** A session scope as the server sends it; undefined when it is not one. */
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

    return permissionId(scope.id) && typeof scope.folder === "string" && isAbsolute(scope.folder)
        ? (scope as SessionScope)
        : undefined;
}

export type GateOptions = {
    /** Whole frames to the daemon. */
    send: (bytes: Buffer) => void;
    /** Whole frames back to the server, as if the daemon sent them. */
    reply: (bytes: Buffer) => void;
    /** The runner's own folders for session `id`: its attached files and browser downloads. */
    shared: (id: string) => Promise<string[]>;
    /** The real temporary folder, where `mkdtemp` may make a folder for a session. */
    tmpdir: () => Promise<string>;
    /** The computer's name, for refusals. */
    name: () => string;
    /** Only the built-in daemon shares its filesystem with the runner. */
    readSnapshot?: boolean;
    /** A request of a session in `folder` reaches the daemon; the result is called when it ended (`activity.ts`). */
    working?: (folder: string) => () => void;
    /** Request path resolver; tests can delay or count path checks. */
    resolvePath?: typeof canonical;
};

export class RequestGate {
    readonly #options: GateOptions;
    readonly #resolvePath: typeof canonical;
    readonly #requests = new Map<number, Request>();
    readonly #handles = new Map<number, Handle>();
    readonly #queues = new Map<string, Set<Queued>>();
    /** The folders `mkdtemp` made for each session: codemode's work folders and temporary files. */
    readonly #temporary = new Map<string, Set<string>>();
    /** Exact real files, never folders, that a session may read for a short time (`allowRead`), by session id. */
    readonly #extraReads = new Map<string, Map<string, number>>();

    constructor(options: GateOptions) {
        this.#options = options;
        this.#resolvePath = options.resolvePath ?? canonical;
    }

    /**
     * Let session `session` read one exact file for 5 minutes: a Pi terminal session the server lets it continue, and
     * the files extensions keep beside it. The server decided that this person may (`src/server/pi-sessions.ts`).
     */
    async allowRead(session: string, path: string): Promise<void> {
        const real = await realpath(path);
        const files = this.#extraReads.get(session) ?? new Map<string, number>();
        const until = Date.now() + 5 * 60_000;

        files.set(real, until);
        this.#extraReads.set(session, files);
        setTimeout(() => {
            if (files.get(real) === until) {
                files.delete(real);
            }

            if (files.size === 0 && this.#extraReads.get(session) === files) {
                this.#extraReads.delete(session);
            }
        }, 5 * 60_000).unref();
    }

    /** A background task of session `scope`, as the server named it: its folder must be in the session's folder. */
    async task(scope: SessionScope, cwd?: string): Promise<() => void> {
        const folder = await realFolder(scope.folder);
        const paths = await this.#paths(cwd === undefined ? {} : { cwd });

        if (!(await this.#inside(scope.id, folder, paths))) {
            throw new Error(`The path is outside the session's folder on ${this.#options.name()}`);
        }

        return this.#options.working?.(folder) ?? (() => {});
    }

    /** The daemon stopped, or the runner: what waits is dropped, and use ends. */
    stop(): void {
        for (const request of this.#requests.values()) {
            request.stop.abort();
            request.finish?.();
        }

        for (const queue of this.#queues.values()) {
            queue.clear();
        }

        this.#queues.clear();
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
                    // Not at the daemon yet: it ends now.
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

        const key = request.scope?.id ?? "";
        const active = this.#queues.get(key);
        const queue = active ?? new Set<Queued>();

        queue.add({ id, request, json, payload });
        this.#queues.set(key, queue);
        this.#fill(queue);

        if (active === undefined) {
            void this.#drain(key, queue);
        }
    }

    /** Prepare at most 16 requests per session. Do not resolve paths past a request that could change them. */
    #fill(queue: Set<Queued>): void {
        let count = 0;

        for (const job of queue) {
            if (count === CHECK_LIMIT || !CHECK_AHEAD.has(job.request.op)) {
                break;
            }

            if (job.check === undefined && !job.request.stop.signal.aborted) {
                job.check = this.#prepare(job).then(
                    (prepared) => ({ prepared }),
                    (error: unknown) => ({ error }),
                );
            }

            count++;
        }
    }

    async #drain(key: string, queue: Set<Queued>): Promise<void> {
        // Authorize, record activity, and send or refuse in arrival order. Handle, folder, and shared-folder
        // checks use current state. The server asks for access before sending requests, not inside this gate.
        for (const job of queue) {
            const { id, request, json, payload } = job;

            try {
                // Even a cancelled check occupies its slot until the path lookups end; they cannot be aborted.
                const checked = await job.check;

                if (request.stop.signal.aborted) {
                    continue;
                }

                if (checked !== undefined && "error" in checked) {
                    throw checked.error;
                }

                const prepared = checked?.prepared ?? (await this.#prepare(job));

                if (request.stop.signal.aborted) {
                    continue;
                }

                await this.#authorize(job, prepared);

                if (request.stop.signal.aborted) {
                    continue;
                }

                if (request.op === READ_SNAPSHOT) {
                    await this.#snapshot(id, request, json.path, json.maxBytes);
                } else {
                    const outgoing = frame(FRAME.request, id, json, payload);

                    request.sent = true;
                    this.#options.send(outgoing);
                }
            } catch (error) {
                this.#refuse(id, request, (error as Error).message);
            } finally {
                // Start the next window only after a request that can change paths has sent or been refused.
                queue.delete(job);
                this.#fill(queue);
            }
        }

        if (this.#queues.get(key) === queue) {
            this.#queues.delete(key);
        }
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

    /** Resolve only request paths ahead of time; this does not grant access or change session state. */
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

        // Directory-handle listings (readdir and close) are not checked ahead of their turn.
        const listing =
            LISTING.has(request.op) ||
            (["readdir", "close"].includes(request.op) &&
                typeof json.handle === "number" &&
                this.#handles.get(json.handle)?.directory === true);

        if (listing) {
            const path = json.path;

            // A folder the picker cannot resolve still lists as the daemon decides.
            return {
                listing: true,
                path:
                    typeof path === "string" && isAbsolute(path)
                        ? await this.#resolvePath(path).catch(() => resolve(path))
                        : undefined,
            };
        }

        if (request.scope === undefined) {
            throw new Error(`A session on ${this.#options.name()} is required`);
        }

        return { scope: request.scope, paths: await this.#paths(json) };
    }

    /** Check live authorization; on success, count this work for the session until its result (`activity.ts`). */
    async #authorize({ request, json }: Queued, prepared: Prepared): Promise<void> {
        if ("listing" in prepared) {
            if (prepared.path !== undefined) {
                request.path = prepared.path;
            }

            return;
        }

        const { scope } = prepared;
        const handle = typeof json.handle === "number" ? this.#handles.get(json.handle) : undefined;
        const paths = handle === undefined ? prepared.paths : [handle.path, ...prepared.paths];
        // The session's folder can move or become a symlink. Do not use a cached folder to grant access.
        const folder = await realFolder(scope.folder);

        // A command runs in a folder of its session: with none named, the session's folder, never the runner's own.
        if ((request.op === "exec" || request.op === "pty") && typeof json.cwd !== "string") {
            json.cwd = folder;
        }

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
            request.op === READ_SNAPSHOT ||
            request.op === "open" ||
            (handle?.readOnly === true && READING.has(request.op));
        let allowed = temporary || (await this.#inside(scope.id, folder, paths));

        if (!allowed && reading) {
            const home = await realFolder(homedir());
            const extra = this.#extraReads.get(scope.id);

            allowed =
                paths.every((path) => piReads(folder, home, path)) ||
                (extra !== undefined &&
                    paths.length > 0 &&
                    paths.every((path) => (extra.get(path) ?? 0) > Date.now()));
        }

        if (!allowed) {
            throw new Error(`The path is outside the session's folder on ${this.#options.name()}`);
        }

        // Use the checked path, without a second lookup. A snapshot uses the first path the gate checked.
        const real = request.op === READ_SNAPSHOT ? paths[0] : prepared.paths[0];

        if (typeof json.path === "string" && real !== undefined) {
            request.path = real;
        }

        if (!request.stop.signal.aborted && request.op !== "watch") {
            request.finish = this.#options.working?.(folder);
        }
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

        // A watch can name many paths. Bound each group, and wait for every lookup in it even on error.
        for (let i = 0; i < absolute.length; i += CHECK_LIMIT) {
            const group = await Promise.allSettled(
                absolute.slice(i, i + CHECK_LIMIT).map(async (path) => this.#resolvePath(path)),
            );

            for (const result of group) {
                if (result.status === "rejected") {
                    throw result.reason;
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
