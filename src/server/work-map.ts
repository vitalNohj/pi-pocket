/**
 * The work map: which sessions worked in which git worktrees, on this server, over the last 14 days. A session's own
 * folder says little (many sit in a home folder), so the paths in its tool calls say where it worked: each path is
 * matched to the worktree it is in. A call that edits or writes, or a shell command that commits, moves, or deletes,
 * changed files there; any other call read them. The worktrees come from git: those of every repository a session
 * worked in, so a repository's quiet branches show too.
 *
 * Reading a session's history is the slow part (some have tens of thousands of entries), so each session's touches
 * are kept, by worktree, and only its entries newer than those read are read again. Git's answers are kept a minute.
 * Owner only: it reads every session's history and every repository's state on this computer.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { gitDirOf } from "./branches.ts";
import { APP_ROOT } from "./config.ts";
import type { SessionMeta } from "./docs.ts";
import { git, GitError } from "./git.ts";

const context = BACKGROUND_CONTEXT;

/** How far back the map looks. */
export const WORK_MAP_DAYS = 14;
const WINDOW_MS = WORK_MAP_DAYS * 86_400_000;
/** How long git's answers are kept: the map is opened now and then, and git takes seconds over many worktrees. */
const GIT_KEPT_MS = 60_000;
/** How many git commands run at once, across every worktree. */
const GIT_AT_ONCE = 6;
/** How long one git command may take here: a stuck mount must not hold the map. */
const GIT_TIMEOUT_MS = 15_000;
/** The most commits listed for a branch's own line in the timeline, or for its repository's main line. */
const MAX_COMMITS = 400;

/** Tools that change files by their nature. */
const WRITE_TOOLS = /(^|_)(write|edit|wet_edit|promote_write|multi_edit|apply_patch)$/i;
/** A shell command that changes files or history: git's own, redirects into a file, and moves or deletes. */
const WRITE_COMMAND =
    /\bgit\b[^|;&\n]*\b(commit|push|checkout\s+-b|switch\s+-c|merge|rebase|cherry-pick|reset|stash|apply|am)\b|>\s*["']?\/|\bsed\s+-i|\bmv\s|\brm\s|\bcp\s|\btee\s/;
/** Absolute paths in a call's arguments: home and temporary folders, project folders, and mounted volumes. */
const PATHS =
    /(?:~|\/(?:home|Users|root|tmp|srv|opt|workspace|mnt|var\/tmp|(?:private\/)?var\/folders|private\/tmp|Volumes))(?:\/[\w.@+-]+)+/g;

/** The distinct worktrees named by paths in a tool call's JSON arguments. */
export function worktreesInCall(
    text: string,
    home: string,
    worktreeOf: (path: string) => string | null,
): Set<string> {
    const seen = new Set<string>();

    for (const match of text.matchAll(PATHS)) {
        const path = match[0].startsWith("~") ? home + match[0].slice(1) : match[0];
        const folder = worktreeOf(path);

        if (folder !== null) {
            seen.add(folder);
        }
    }

    return seen;
}

/** One session's work in one worktree: per hour (since 1970, so it stays put as the window moves), reads and writes. */
type Touch = { hours: Map<number, [number, number]> };

/** What is kept of a session between maps: its touches by folder (a worktree's path), and the newest entry read. */
type Kept = { newest: number; touches: Map<string, Touch> };

/** Let the server answer others between pages of a long history. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A worktree as the map shows it. Times are hours since the window opened; negative ones are before it. */
export type WorkMapWorktree = {
    id: string;
    branch: string;
    head: string;
    headTime: number | null;
    subject: string;
    isMain: boolean;
    ahead: number;
    behind: number;
    fork: number | null;
    dirty: number;
    prunable: boolean;
    exists: boolean;
    task: string;
    pr: string;
    commits: number[];
};

export type WorkMapRepo = {
    name: string;
    main: string;
    base: string;
    commits: number[];
    worktrees: WorkMapWorktree[];
};

export type WorkMapSession = {
    id: number;
    title: string;
    cwd: string;
    kind: "chat" | "fork" | "linked" | "worker" | "firstmate" | "supervision";
    parent: number | null;
    archived: boolean;
    calls: number;
    created: number;
    updated: number;
    /** `wt` is a worktree's id; `h` is `[hour, reads, writes]` for each hour it worked there. */
    touches: { wt: string; r: number; w: number; h: [number, number, number][] }[];
};

export type WorkMap = {
    /** The home folder, to show paths as `~/…`; and the folder this server runs from. */
    home: string;
    appRoot: string;
    generatedAt: string;
    windowStart: string;
    hours: number;
    repos: WorkMapRepo[];
    sessions: WorkMapSession[];
};

/** A small pool: at most `GIT_AT_ONCE` git commands at a time, the rest wait their turn. */
function limiter(size: number) {
    let running = 0;
    const waiting: (() => void)[] = [];

    return async <T>(work: () => Promise<T>): Promise<T> => {
        if (running >= size) {
            await new Promise<void>((resolve) => waiting.push(resolve));
        }

        running++;

        try {
            return await work();
        } finally {
            running--;
            waiting.shift()?.();
        }
    };
}

/** A real path, or the path as it is when it cannot be resolved (a folder since removed). */
function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** A repository's main folder: where its shared git folder is, `…/.git` for `…`. Undefined for a bare one. */
function mainOf(folder: string): string | undefined {
    const gitDir = gitDirOf(folder);

    if (gitDir === undefined) {
        return undefined;
    }

    // A worktree's git folder is `<main>/.git/worktrees/<name>`.
    const common = /^(.*)[/\\]worktrees[/\\][^/\\]+$/.exec(gitDir)?.[1] ?? gitDir;

    return common.endsWith(`${sep}.git`) ? dirname(common) : undefined;
}

/** The kind of session, for the map's colors: Firstmate's own, a worker it started, a linked one, a fork, or a chat. */
function kindOf(meta: SessionMeta): WorkMapSession["kind"] {
    const title = meta.title ?? "";

    if (title === "Firstmate") {
        return "firstmate";
    }

    if (title === "Firstmate supervision") {
        return "supervision";
    }

    if (meta.linkedFrom !== undefined) {
        return /^fm-/.test(title) ? "worker" : "linked";
    }

    return meta.forkedFrom !== undefined ? "fork" : "chat";
}

export class WorkMaps {
    readonly #app: PocketApp;
    readonly #kept = new Map<number, Kept>();
    readonly #git = limiter(GIT_AT_ONCE);
    /** Git's answers by repository's main folder, with when they were read. */
    readonly #repos = new Map<
        string,
        { at: number; repo: Promise<WorkMapRepo | undefined>; reading: boolean }
    >();
    /** The folder each path's worktree is, so paths seen often are matched once. Cleared with each map. */
    #folders = new Map<string, string | null>();
    /** The map being made: a second ask while it is, waits for it. */
    #making: Promise<WorkMap> | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The map now: a second ask while one is being made gets that one. */
    map(): Promise<WorkMap> {
        this.#making ??= this.#make().finally(() => {
            this.#making = undefined;
        });

        return this.#making;
    }

    async #make(): Promise<WorkMap> {
        const now = Date.now();
        const since = now - WINDOW_MS;
        const hour0 = Math.floor(since / 3_600_000);
        const hourOf = (at: number) => Math.floor(at / 3_600_000) - hour0;

        this.#folders = new Map();

        const catalogue = this.#app.sessionCatalogue();
        const sessions: WorkMapSession[] = [];
        const touched = new Set<string>();

        for (const [key, meta] of Object.entries(catalogue)) {
            // PiP's own session, a session on another computer, and one not used in the window are not on the map.
            if (
                meta.pip !== undefined ||
                meta.runner !== undefined ||
                meta.updatedAt < since ||
                /^[a-z][a-z0-9+.-]+:\/\//i.test(meta.cwd)
            ) {
                continue;
            }

            const id = Number(key);
            const kept = await this.#read(id as unknown as ConversationId, since, meta.cwd);
            const touches: WorkMapSession["touches"] = [];
            let calls = 0;

            for (const [wt, touch] of kept.touches) {
                const h: [number, number, number][] = [];
                let r = 0;
                let w = 0;

                for (const [hour, [reads, writes]] of touch.hours) {
                    // Hours past the window are no longer on the map, nor kept.
                    if (hour < hour0) {
                        touch.hours.delete(hour);
                        continue;
                    }

                    h.push([hour - hour0, reads, writes]);
                    r += reads;
                    w += writes;
                }

                if (h.length === 0) {
                    kept.touches.delete(wt);
                    continue;
                }

                calls += r + w;
                touches.push({ wt, r, w, h: h.sort((a, b) => a[0] - b[0]) });
                touched.add(wt);
            }

            if (touches.length === 0) {
                continue;
            }

            sessions.push({
                id,
                title: meta.title ?? `Session ${id}`,
                cwd: meta.cwd,
                kind: kindOf(meta),
                parent: meta.linkedFrom?.id ?? meta.forkedFrom?.id ?? null,
                archived: meta.archived === true,
                calls,
                created: hourOf(meta.createdAt),
                updated: hourOf(meta.updatedAt),
                touches,
            });
        }

        // Every repository a session worked in, with all its worktrees.
        const mains = new Set<string>();

        for (const folder of touched) {
            const main = mainOf(folder);

            if (main !== undefined) {
                mains.add(real(main));
            }
        }

        const repos = (await Promise.all([...mains].map((main) => this.#repo(main, since)))).filter(
            (repo): repo is WorkMapRepo => repo !== undefined,
        );
        const known = new Set(repos.flatMap((repo) => repo.worktrees.map((wt) => wt.id)));

        // A touch of a folder git no longer lists (a worktree since removed) is left out, and so is a session left
        // with none.
        for (const session of sessions) {
            session.touches = session.touches.filter((touch) => known.has(touch.wt));
        }

        return {
            home: process.env.HOME ?? "",
            appRoot: real(APP_ROOT),
            generatedAt: new Date(now).toISOString(),
            windowStart: new Date(hour0 * 3_600_000).toISOString(),
            hours: Math.ceil((now - hour0 * 3_600_000) / 3_600_000),
            repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
            sessions: sessions.filter((session) => session.touches.length > 0),
        };
    }

    /**
     * A session's touches: those kept, plus those of its entries newer than the ones read last time. A call with no path
     * in a repository (a relative path, `npm test`) works in the session's folder, when that is in one.
     */
    async #read(id: ConversationId, since: number, cwd: string): Promise<Kept> {
        const kept = this.#kept.get(Number(id)) ?? { newest: 0, touches: new Map() };
        const conversation = await this.#app.harness.conversation(id, context);

        if (conversation === undefined) {
            return kept;
        }

        const own = this.#worktreeOf(real(cwd));
        let newest = kept.newest;
        let cursor: Cursor | undefined;

        scan: do {
            const page = await conversation.entries(
                kept.newest > 0 ? { minEntryId: (kept.newest + 1) as unknown as EntryId } : {},
                256,
                cursor,
                context,
            );

            for (const entry of page.items) {
                newest = Math.max(newest, Number(entry.id));

                // A fork's inherited entries are its source's work.
                if (entry.conversationId !== id || entry.kind !== "pi.assistant") {
                    continue;
                }

                for (const message of entry.model ?? []) {
                    if (message.role !== "assistant") {
                        continue;
                    }

                    // Newest first: once past the window, the rest is older still.
                    if (message.timestamp < since) {
                        break scan;
                    }

                    const hour = Math.floor(message.timestamp / 3_600_000);

                    for (const block of message.content) {
                        if (block.type === "toolCall") {
                            this.#note(kept, block.name, block.arguments, hour, own);
                        }
                    }
                }
            }

            cursor = page.next;
            await breathe();
        } while (cursor !== undefined);

        kept.newest = newest;
        this.#kept.set(Number(id), kept);

        return kept;
    }

    /** Note one tool call's touches: each worktree its paths are in, read or written, else the session's own (`own`). */
    #note(kept: Kept, name: string, args: unknown, hour: number, own: string | null): void {
        const text = JSON.stringify(args ?? {});
        const writes =
            WRITE_TOOLS.test(name) ||
            (/bash|shell|exec/i.test(name) && WRITE_COMMAND.test(text)) ||
            // A script that calls the edit or write tool, or runs such a command.
            (/codemode/i.test(name) &&
                (/tools\.\w*(write|edit)\w*\(/i.test(text) || WRITE_COMMAND.test(text)));
        const seen = worktreesInCall(text, process.env.HOME ?? "", (path) =>
            this.#worktreeOf(path),
        );

        if (
            seen.size === 0 &&
            own !== null &&
            !/^(mcp__\w+__)?(compress|search_context|decompress|acp_status|acp_cache|memory|ask|tool_search|schedule|artifact|subagent|watch_pr|fm_\w+|\w+_fm_\w+)$/.test(
                name,
            )
        ) {
            seen.add(own);
        }

        for (const folder of seen) {
            const touch = kept.touches.get(folder) ?? { hours: new Map() };
            const counts = touch.hours.get(hour) ?? [0, 0];

            counts[writes ? 1 : 0]++;
            touch.hours.set(hour, counts);
            kept.touches.set(folder, touch);
        }
    }

    /** The worktree a path is in: the folder of its nearest `.git`, or null when it is in no repository. */
    #worktreeOf(path: string): string | null {
        let folder = path;

        for (let depth = 0; depth < 12 && folder.length > 1; depth++) {
            const known = this.#folders.get(folder);

            if (known !== undefined) {
                return known;
            }

            if (existsSync(`${folder}${sep}.git`)) {
                const found = real(folder);

                this.#folders.set(path, found);
                this.#folders.set(folder, found);

                return found;
            }

            folder = dirname(folder);
        }

        this.#folders.set(path, null);

        return null;
    }

    /**
     * A repository's facts. Read once, then kept: an older answer than `GIT_KEPT_MS` is still given at once, while a new
     * one is read behind it for the next map.
     */
    #repo(main: string, since: number): Promise<WorkMapRepo | undefined> {
        const kept = this.#repos.get(main);
        const fresh = kept !== undefined && Date.now() - kept.at < GIT_KEPT_MS;

        if (kept !== undefined && (fresh || kept.reading)) {
            return kept.repo;
        }

        const reading = this.#readRepo(main, since).catch((error: unknown) => {
            if (error instanceof GitError) {
                return undefined;
            }

            throw error;
        });
        const entry = { at: kept?.at ?? 0, repo: kept?.repo ?? reading, reading: true };

        this.#repos.set(main, entry);
        reading.then(
            (repo) =>
                this.#repos.set(main, {
                    at: Date.now(),
                    repo: Promise.resolve(repo),
                    reading: false,
                }),
            () => this.#repos.set(main, { ...entry, reading: false }),
        );

        return entry.repo;
    }

    async #readRepo(main: string, since: number): Promise<WorkMapRepo | undefined> {
        const run = (cwd: string, args: string[]) =>
            this.#git(() => git(cwd, args, { timeoutMs: GIT_TIMEOUT_MS }));
        const hour0 = Math.floor(since / 3_600_000);
        const hourOf = (seconds: number) =>
            seconds > 0 ? Math.floor((seconds * 1000) / 3_600_000) - hour0 : null;
        const sinceArg = `--since=${Math.floor(since / 1000)}`;
        const base = (await run(main, ["branch", "--show-current"])).trim() || "HEAD";
        const [list, mainLog] = await Promise.all([
            run(main, ["worktree", "list", "--porcelain", "-z"]),
            run(main, [
                "log",
                "--first-parent",
                "--format=%ct",
                sinceArg,
                `--max-count=${MAX_COMMITS}`,
                base,
            ]),
        ]);
        const commits = mainLog
            .split("\n")
            .filter(Boolean)
            .map((seconds) => hourOf(Number(seconds)) ?? 0);
        const worktrees: (WorkMapWorktree & { sha: string })[] = [];

        // Records are separated by an empty field; each field is "key value" or a bare key.
        for (const record of list.split("\0\0")) {
            const fields = new Map<string, string>();

            for (const field of record.split("\0")) {
                if (field === "") {
                    continue;
                }

                const space = field.indexOf(" ");

                fields.set(
                    space === -1 ? field : field.slice(0, space),
                    space === -1 ? "" : field.slice(space + 1),
                );
            }

            const path = fields.get("worktree");
            const sha = fields.get("HEAD") ?? "";

            if (path === undefined || fields.has("bare")) {
                continue;
            }

            worktrees.push({
                id: real(path),
                sha,
                branch: (fields.get("branch") ?? "").replace(/^refs\/heads\//, ""),
                head: sha.slice(0, 8),
                headTime: null,
                subject: "",
                isMain: real(path) === main,
                ahead: 0,
                behind: 0,
                fork: null,
                dirty: 0,
                prunable: fields.has("prunable"),
                exists: existsSync(path),
                task: "",
                pr: "",
                commits: [],
            });
        }

        // Every head's time and subject in one command.
        const heads = [
            ...new Set(
                worktrees.map((wt) => wt.sha).filter((sha) => /^[0-9a-f]{40,64}$/.test(sha)),
            ),
        ];
        const shown = new Map<string, { time: number; subject: string }>();

        if (heads.length > 0) {
            const out = await run(main, [
                "log",
                "--no-walk=unsorted",
                "--format=%H%x00%ct%x00%s%x00",
                ...heads,
            ]).catch(() => "");
            const fields = out.split("\0");

            for (let at = 0; at + 3 <= fields.length; at += 3) {
                shown.set(fields[at]!.trim(), {
                    time: Number(fields[at + 1]),
                    subject: fields[at + 2] ?? "",
                });
            }
        }

        await Promise.all(
            worktrees.map(async (wt) => {
                const head = shown.get(wt.sha);

                wt.headTime = head === undefined ? null : hourOf(head.time);
                wt.subject = (head?.subject ?? "").slice(0, 120);

                const status = wt.exists
                    ? run(wt.id, ["status", "--porcelain=v1", "-z"]).catch(() => "")
                    : Promise.resolve("");

                if (wt.isMain || head === undefined) {
                    wt.dirty = (await status)
                        .split("\0")
                        .filter((each) => /^.. /.test(each)).length;

                    return;
                }

                // Its own commits, and where it split off: the boundary commit is the fork point.
                const [own, behind, changed] = await Promise.all([
                    run(main, [
                        "log",
                        "--boundary",
                        "--format=%m%x00%ct",
                        `${base}..${wt.sha}`,
                    ]).catch(() => ""),
                    run(main, ["rev-list", "--count", `${wt.sha}..${base}`]).catch(() => "0"),
                    status,
                ]);
                let fork = 0;

                for (const line of own.split("\n")) {
                    const [mark, seconds = "0"] = line.split("\0");

                    if (mark === ">") {
                        wt.ahead++;

                        if (Number(seconds) * 1000 >= since && wt.commits.length < MAX_COMMITS) {
                            wt.commits.push(hourOf(Number(seconds)) ?? 0);
                        }
                    } else if (mark === "-") {
                        fork = Math.max(fork, Number(seconds));
                    }
                }

                // No boundary: the branch is in main, so it split off where its head is.
                wt.fork = hourOf(fork || head.time);
                wt.behind = Number(behind.trim()) || 0;
                wt.dirty = changed.split("\0").filter((each) => /^.. /.test(each)).length;
            }),
        );

        return {
            name: main.split(sep).filter(Boolean).at(-1) ?? main,
            main,
            base,
            commits,
            worktrees: worktrees
                .map(({ sha: _sha, ...wt }) => wt)
                .sort((a, b) => Number(b.isMain) - Number(a.isMain)),
        };
    }
}
