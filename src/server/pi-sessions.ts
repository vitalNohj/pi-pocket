/**
 * Pi's sessions from the terminal, to continue in Pi Pocket. Pi keeps each in a JSONL file in its sessions folder
 * (`~/.pi/agent/sessions/`, a folder per project; or the one folder `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in
 * Pi's settings names), and finds them all with `SessionManager.listAll`, as `pi -r` lists every folder's. Their files
 * are only read, never written: Pi's own loader mends a file whose last line is cut off, and a `pi` still running may be
 * writing that line.
 *
 * A session continues here as a copy of where Pi left it, its current branch. People get every message of it to read,
 * and Pi gets the context Pi itself builds from the file (`buildSessionProjection`): a compaction becomes Pi Durable's,
 * keeping the same messages, and a context edit edits the same message. Pi's system prompt, its extensions' state, and
 * its model changes stay behind; Pi Pocket's prompt and tools apply. Nothing Pi did runs again: a tool call that never
 * finished gets a result saying so (Pi's says "No result provided"). Where Pi would send a tool result whose call is
 * not there (a stray one, or one whose call a context edit took out), Pi Durable leaves it out, as providers refuse it.
 */
import { stat } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
    AssistantEntry,
    CompactionEntry,
    type ContextEdit,
    type ConversationId,
    type EntryId,
    ToolResultEntry,
    type Tx,
    UserEntry,
} from "@earendil-works/pi-durable";
import { COMPANION_SUFFIX } from "../runner/protocol.ts";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { FROM_PI_ENTRY, type FromPiData } from "./entry-format.ts";
import { HttpError } from "./errors.ts";

import {
    FOUND_FOR_MS,
    MAX_LISTED,
    SESSION_DIR_VARIABLE,
    PiSessionError,
    piSessionOf,
    readSessionEntries,
    readPiTail,
    titleOf,
    type PiSession,
} from "./pi-session-files.ts";
export { PiSessionError, readPiSession, type PiSession, type PiEntry } from "./pi-session-files.ts";
type Listed = { info: SessionInfo; words: string };

/**
 * Write a Pi session's copy into a new conversation, from its `init`: its messages, then where it came from. One
 * commit, so a copy is whole or not there at all (a big one too: its text is held once already). Returns, for each
 * entry written that copies one of Pi's, the id of Pi's.
 */
export async function writePiSession(
    tx: Tx,
    id: ConversationId,
    session: PiSession,
    data: FromPiData,
): Promise<Map<EntryId, string>> {
    const made = new Map<string, EntryId>();
    const copies = new Map<EntryId, string>();

    for (const entry of session.entries) {
        const written =
            entry.kind === "compaction"
                ? await tx.appendEntry(CompactionEntry, id, {
                      model: [entry.message],
                      // A kept entry is written before its compaction, as Pi keeps them.
                      head: entry.head === null ? "self" : made.get(entry.head)!,
                      data: { reason: "threshold" },
                  })
                : entry.kind === "toolResult"
                  ? await tx.appendEntry(ToolResultEntry, id, {
                        model: [entry.message],
                        data: { diagnostics: [] },
                    })
                  : await tx.appendEntry(entry.kind === "user" ? UserEntry : AssistantEntry, id, {
                        model: [entry.message],
                    });

        if (entry.from !== undefined) {
            copies.set(written.id, entry.from);

            if (!made.has(entry.from)) {
                made.set(entry.from, written.id);
            }
        }
    }

    const edits: ContextEdit[] = session.edits.flatMap(({ target, messages }) => {
        const entry = made.get(target);

        if (entry === undefined) {
            return [];
        }

        return [
            messages.length === 0
                ? { target: entry, action: "omit" as const }
                : { target: entry, action: "replace" as const, messages },
        ];
    });

    // Last, after every entry it edits; it adds nothing for Pi itself.
    await tx.appendEntry(id, {
        kind: FROM_PI_ENTRY,
        data,
        ...(edits.length === 0 ? {} : { edits }),
    });

    return copies;
}

/** A Pi session as the list shows it. */
export type PiSessionSummary = {
    path: string;
    title: string;
    cwd: string;
    modified: number;
    messages: number;
    /** The newest session here that continues it, and whether Pi went on in the terminal since. */
    pocket?: { id: number; behind: boolean };
};

/**
 * What an extension keeps beside Pi's session files, and how it carries it into a session continued here: Pi Pocket
 * looks for `<session file><suffix>` beside the file Pi lists, shows the person it is there, and, once the copy is
 * written, gives `continued` its path and the copy's context. It never reads the file itself.
 */
export type PiSessionCompanion = {
    /** What follows the session file's name, as `.notes.md`: a dot, then letters, digits, dots, dashes, or underscores. */
    suffix: string;
    /** What the preview calls it, in words for people. */
    label: string;
    /**
     * Carry the file into the session: it runs once the copy is written, before the person sees the session. What it
     * returns, if anything, is shown to the person; what it throws is too, and the session continues without it.
     */
    continued(input: PiSessionContinued): Promise<string | void> | string | void;
};

/** What `continued` of a companion gets. */
export type PiSessionContinued = {
    conversationId: ConversationId;
    /** Pi's session file. */
    piFile: string;
    /** The companion file beside it. */
    companion: string;
    /**
     * The new session's context, as its first request sends it: each message, the entry here it is from, and the entry
     * of Pi's that entry copies (none for one made here, as a result for a call that never finished).
     */
    entries: readonly { from?: string; id: EntryId; message: Message }[];
};

/** How long a companion's `continued` may take before the session opens without it. */
const COMPANION_TIMEOUT_MS = 60_000;

/** Local Pi files are the owner's. A runner controls access to its own Pi files. */
export class PiSessions {
    readonly #app: PocketApp;
    readonly #companions: { token: symbol; companion: PiSessionCompanion }[] = [];

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Register a companion; returns how to remove it again. */
    registerCompanion(companion: PiSessionCompanion): () => void {
        if (
            typeof companion?.suffix !== "string" ||
            !COMPANION_SUFFIX.test(companion.suffix) ||
            typeof companion.label !== "string" ||
            companion.label.trim() === "" ||
            typeof companion.continued !== "function"
        ) {
            throw new Error("Invalid Pi session companion");
        }

        const token = Symbol(companion.suffix);

        this.#companions.push({ token, companion });

        return () => {
            const index = this.#companions.findIndex((each) => each.token === token);

            if (index >= 0) {
                this.#companions.splice(index, 1);
            }
        };
    }

    /** The registered companions' suffixes: what a linked computer is asked to allow beside a Pi file it opens. */
    companionSuffixes(): string[] {
        return [...new Set(this.#companions.map(({ companion }) => companion.suffix))];
    }

    /**
     * The registered companions whose file is beside `path`, each with that file. `there`: the files beside it on
     * this server, by default; for a Pi file on a linked computer, copies of those found there.
     */
    async #companionsOf(
        path: string,
        there?: ReadonlyMap<string, string>,
    ): Promise<{ companion: PiSessionCompanion; file: string }[]> {
        const found = await Promise.all(
            this.#companions.map(async ({ companion }) => {
                if (there !== undefined) {
                    const file = there.get(companion.suffix);

                    return file === undefined ? [] : [{ companion, file }];
                }

                const file = `${path}${companion.suffix}`;
                const info = await stat(file).catch(() => undefined);

                return info?.isFile() === true ? [{ companion, file }] : [];
            }),
        );

        return found.flat();
    }

    /** The labels of the companions beside one of Pi's sessions, for its preview. */
    async #companionLabels(path: string): Promise<string[]> {
        return [
            ...new Set((await this.#companionsOf(path)).map(({ companion }) => companion.label)),
        ];
    }

    /**
     * Give each companion beside `path` the continued session: in turn, each within its time. Returns what they say
     * for the person, a line each; one that fails or takes too long says so, and the others still run.
     */
    async carryCompanions(
        path: string,
        conversationId: ConversationId,
        copies: ReadonlyMap<EntryId, string>,
        context: Context,
        there?: ReadonlyMap<string, string>,
    ): Promise<string[]> {
        const found = await this.#companionsOf(path, there);

        if (found.length === 0) {
            return [];
        }

        const conversation = await this.#app.harness.conversation(conversationId, context);
        const view = await conversation!.context(context);
        // The context's messages, each with its entry: what each entry contributes, in order, as the request sends it.
        const entries: PiSessionContinued["entries"] = view.entries.flatMap((entry, index) =>
            (view.contributions[index] ?? []).map((message) => ({
                id: entry.id,
                message,
                ...(copies.has(entry.id) ? { from: copies.get(entry.id)! } : {}),
            })),
        );
        const said: string[] = [];

        for (const { companion, file } of found) {
            let timer: NodeJS.Timeout | undefined;

            try {
                const answer = await Promise.race([
                    Promise.resolve(
                        companion.continued({
                            conversationId,
                            piFile: path,
                            companion: file,
                            entries,
                        }),
                    ),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error("it took too long")),
                            COMPANION_TIMEOUT_MS,
                        );
                    }),
                ]);

                if (typeof answer === "string" && answer.trim() !== "") {
                    said.push(answer.trim());
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);

                this.#app.log(`Pi session companion ${companion.suffix} failed: ${message}`);
                said.push(`${companion.label}: ${message}`);
            } finally {
                clearTimeout(timer);
            }
        }

        return said;
    }

    /**
     * The last list, for a few seconds: reading every session's file again for each look, or each letter of a search,
     * is slow with many. It holds the words of every session, so it is let go when its time is up.
     */
    #found: { at: number; list: Promise<Listed[]> } | undefined;

    /**
     * Pi's sessions, newest first, as `pi -r` lists them all, each with what a search looks through, in lower case:
     * made once per list, not for every letter typed. `fresh` reads them again.
     */
    #find(fresh = true): Promise<Listed[]> {
        if (!fresh && this.#found !== undefined && Date.now() - this.#found.at < FOUND_FOR_MS) {
            return this.#found.list;
        }

        let configured: string | undefined;

        try {
            configured = this.#app.settings.getSessionDir();
        } catch {
            // Unreadable settings: Pi's own folder.
        }

        const folder = process.env[SESSION_DIR_VARIABLE] || configured;
        const list = (folder ? SessionManager.listAll(folder) : SessionManager.listAll()).then(
            (infos) =>
                infos.map((info) => {
                    const words = [
                        info.name ?? "",
                        info.cwd,
                        info.firstMessage,
                        info.allMessagesText,
                    ]
                        .join("\n")
                        .toLowerCase();

                    // Kept once, as the search's words: a session's whole text is the bulk of the list.
                    info.allMessagesText = "";

                    return { info, words };
                }),
        );
        const found = { at: Date.now(), list };

        this.#found = found;
        setTimeout(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        }, FOUND_FOR_MS).unref();
        // A list that failed is not kept.
        list.catch(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        });

        return list;
    }

    /** The newest session here that continues each of Pi's, by its id. */
    #continued(runner?: string): Map<string, { id: number; count: number }> {
        const found = new Map<string, { id: number; count: number }>();

        // Newest first: the first one seen of each is the one to open.
        for (const session of this.#app.sessions()) {
            const meta = this.#app.sessionMeta(session.id as unknown as ConversationId);
            const from = meta?.fromPi;

            if (meta?.runner === runner && from !== undefined && !found.has(from.session)) {
                found.set(from.session, { id: session.id, count: from.count });
            }
        }

        return found;
    }

    #requireOwner(user: User): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can continue Pi's sessions here.");
        }
    }

    /** Pi's sessions on this machine, newest first; with `query`, those whose title, folder, or words have it. */
    async list(user: User, query = "", runner?: string): Promise<{ sessions: PiSessionSummary[] }> {
        if (runner !== undefined) {
            this.#requireRunner(user, runner);
            const result = await this.#app.runners
                .link(runner)
                .piSessions({ op: "list", person: user.name });
            const needle = query.trim().toLowerCase();
            const continued = this.#continued(runner);

            return {
                sessions: (result.sessions ?? [])
                    .filter(
                        (info) =>
                            needle === "" ||
                            `${info.title}\n${info.cwd}`.toLowerCase().includes(needle),
                    )
                    .map((info) => {
                        const pocket = continued.get(info.id);

                        return {
                            path: info.path,
                            id: info.id,
                            title: info.title,
                            cwd: info.cwd,
                            modified: info.modified,
                            messages: info.messages,
                            ...(pocket === undefined
                                ? {}
                                : {
                                      pocket: {
                                          id: pocket.id,
                                          behind: info.messages > pocket.count,
                                      },
                                  }),
                        };
                    }),
            };
        }

        this.#requireOwner(user);
        const continued = this.#continued();
        const needle = query.trim().toLowerCase();
        // Opening the list reads it again; a search narrows the one just read.
        const found = (await this.#find(needle === ""))
            .filter((each) => needle === "" || each.words.includes(needle))
            .map((each) => each.info);

        return {
            sessions: found.slice(0, MAX_LISTED).map((info) => {
                const pocket = continued.get(info.id);

                return {
                    path: info.path,
                    title: titleOf(info),
                    cwd: info.cwd,
                    modified: info.modified.getTime(),
                    messages: info.messageCount,
                    ...(pocket === undefined
                        ? {}
                        : { pocket: { id: pocket.id, behind: info.messageCount > pocket.count } }),
                };
            }),
        };
    }

    #requireRunner(user: User, runner: string): void {
        this.#app.runners.require(runner);

        if (!this.#app.runners.mayUse(runner, user)) {
            throw new HttpError(
                403,
                "Only the person who linked this computer or the people they chose can use its Pi sessions.",
            );
        }
    }

    /** What Pi lists of one of its sessions: only a file Pi lists is read, so nothing else can be read through this. */
    async #listed(user: User, path: string): Promise<SessionInfo> {
        this.#requireOwner(user);

        const find = async (fresh: boolean) =>
            (await this.#find(fresh)).find((each) => each.info.path === path)?.info;
        // The list the sheet just showed, or, for a session new since, the list as it is now.
        const info = (await find(false)) ?? (await find(true));

        if (info === undefined) {
            throw new HttpError(404, "Pi has no such session. It may have been deleted.");
        }

        return info;
    }

    /** Read one of Pi's listed sessions with `read`, in words for people when it cannot be. */
    async #reading<T>(path: string, read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (error) {
            // Gone since the list was read (it is kept a few seconds): as Pi not having it.
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                throw new HttpError(404, "Pi has no such session. It may have been deleted.");
            }

            if (error instanceof PiSessionError) {
                throw new HttpError(400, error.message);
            }

            throw error;
        }
    }

    /** One of Pi's sessions, read whole, to continue it. */
    async read(user: User, path: string): Promise<PiSession> {
        await this.#listed(user, path);

        return this.#reading(path, async () => piSessionOf(await readSessionEntries(path)));
    }

    /**
     * One of Pi's sessions, to decide whether to continue it: where it worked, and its last messages. Quick for a big
     * one: what Pi lists of it, and its file's end.
     */
    async preview(user: User, path: string, runner?: string, signal?: AbortSignal) {
        if (runner !== undefined) {
            this.#requireRunner(user, runner);
            const info = (await this.list(user, "", runner)).sessions.find(
                (each) => each.path === path,
            );

            if (info === undefined) {
                throw new HttpError(
                    404,
                    `Pi has no such session on ${this.#app.runners.name(runner)}.`,
                );
            }

            const result = await this.#app.runners
                .link(runner)
                .piSessions({ op: "preview", path, person: user.name }, signal, user.id);
            const preview = result.preview;

            if (preview === undefined) {
                throw new HttpError(409, "The computer did not return the Pi session preview.");
            }

            const cwdExists = await this.#app.runners.checkFolder(runner, info.cwd).then(
                () => true,
                () => false,
            );
            const modelHere =
                preview.model !== null &&
                this.#app.models
                    .getAvailableSnapshot()
                    .some((each) => `${each.provider}/${each.id}` === preview.model);

            // What extensions keep beside it stays on that computer: none is shown or carried here.
            return {
                ...info,
                cwdExists,
                modelHere,
                model: preview.model,
                last: preview.last,
                companions: [] as string[],
            };
        }

        const info = await this.#listed(user, path);
        const { model, last } = await this.#reading(path, () => readPiTail(path));
        const pocket = this.#continued().get(info.id);
        let cwdExists = true;

        try {
            this.#app.workspace.checkDirectory(info.cwd);
        } catch {
            cwdExists = false;
        }

        const modelHere =
            model !== null &&
            this.#app.models
                .getAvailableSnapshot()
                .some((each) => each.provider === model.provider && each.id === model.modelId);

        return {
            path,
            title: titleOf(info),
            cwd: info.cwd,
            cwdExists,
            messages: info.messageCount,
            model: model === null ? null : `${model.provider}/${model.modelId}`,
            modelHere,
            last,
            companions: await this.#companionLabels(path),
            ...(pocket === undefined
                ? {}
                : { pocket: { id: pocket.id, behind: info.messageCount > pocket.count } }),
        };
    }
}
