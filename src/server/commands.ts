/**
 * What people ask of Pi: start and rename sessions, send messages (steer or queue), stop, withdraw, and change the
 * model, thinking level, or folder of a conversation; compact or reset its context and set its instructions; fork it,
 * undo or send a message again; set plan mode, a goal, or scheduled messages; and remove a session's worktree. Every
 * command checks who may do it, and changes others should know about become activity lines in the session's chat.
 */
import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
    clampThinkingLevel,
    type ImageContent,
    type ModelThinkingLevel,
    type TextContent,
} from "@earendil-works/pi-ai";
import {
    type AgentChange,
    AgentDoc,
    configure as configureAgent,
    type Conversation,
    type ConversationCreateOptions,
    type ConversationId,
    type Cursor,
    defineTask,
    type EntryId,
    type InputEntry,
    type InputSubmissionDraft,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    type SettledSubmissionRecord,
    type SubmissionId,
    type Task,
    type TaskId,
    type TaskRuntime,
    type Tx,
    type UserInput,
} from "@earendil-works/pi-durable";
import { realFolder } from "./runner-link/folders.ts";
import type { SessionScope } from "./runner-link/protocol.ts";
import { checkedContext } from "./admission.ts";
import type { Approved, PocketApp } from "./app.ts";
import { FOLDER_LEVELS, type FolderLevel, type User } from "./config.ts";
import {
    AuthorsDoc,
    ChatDoc,
    DeletedDoc,
    HeldDoc,
    type HeldMessage,
    InterruptsDoc,
    NotesDoc,
    PinsDoc,
    PlanDoc,
    type Schedule,
    type SessionMeta,
    SessionsDoc,
    STOPPED,
    type SubagentRecord,
    SubagentsDoc,
} from "./docs.ts";
import {
    ATTACHMENTS_HEADING,
    CONTEXT_BLOCK,
    attachmentsHeading,
    FILE_BLOCK,
    FROM_PREFIX,
    NOTE_ENTRY,
    splitAttachments,
} from "./entry-format.ts";
import { describe, HttpError, optionalFlag, optionalText } from "./errors.ts";
import { attribute } from "./fence.ts";
import { homePath } from "./paths.ts";
import { localRepo, remoteRepo } from "./repo.ts";
import { forModel, MAX_INLINE_IMAGE, modelImage, modelImageOf } from "./model-images.ts";
import { noteShares, THIS_SERVER } from "./access.ts";
import { localAccess, Unreachable } from "./folder-access.ts";
import { clearUploads, copyUploads, uploadedThere, uploadsFolder } from "./remote-context.ts";
import { type FileView, mentionedPaths, viewFile } from "./files.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./models.ts";
import { keepWarmLabel } from "./keep-warm.ts";
import { writePiSession } from "./pi-sessions.ts";
import { readPiSession, PiSessionError, type PiSession } from "./pi-session-files.ts";
import { snippet } from "./projection.ts";
import {
    globalModelSettings,
    piGlobalSettings,
    projectModelDefault,
    rememberedLevel,
} from "./project-model.ts";
import { expandPromptTemplate, expandSkillCommand, unwrapSkill } from "./prompts.ts";
import type { RoleWord } from "./rights.ts";
import { clientKey, ownRequest, requestFor, requestPerson } from "./requests.ts";
import { newestOf } from "./room.ts";
import {
    type Interrupt,
    interruptTask,
    type Requeue,
    type Resend,
    resendContent,
    resendRequest,
    ResendTask,
    userContent,
} from "./resend.ts";
import { whyUnanswered } from "./subagent-runs.ts";
import { wantsTitle, writeTitle } from "./titles.ts";
import { checkRepeat, describeMoment, describeRepeat, knownZone, type Repeat } from "./when.ts";
import {
    createWorktree,
    discardWorktree,
    inWorktree,
    removeWorktree,
    remoteWorktrees,
    sourceFolders,
    type Worktree,
} from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

/** A mentioned file's text as it goes with a message, cut to `room` and `MAX_MENTIONED_FILE`; none without room. */
function fileBlock(
    file: string,
    view: { text: string; truncated: boolean },
    room: number,
): { part: TextContent; length: number } | undefined {
    if (room <= 0) {
        return undefined;
    }

    const most = Math.min(MAX_MENTIONED_FILE, room);
    const content = view.text.slice(0, most);
    const cut =
        view.truncated || view.text.length > most ? "\n… (the rest of the file is left out)" : "";

    return {
        part: { type: "text", text: `${FILE_BLOCK}${file}">\n${content}${cut}\n</file>` },
        length: content.length,
    };
}

export type Attachment = { path: string; name: string; mime: string; size: number };
export const MAX_UPLOAD = 50 * 1024 * 1024;

/**
 * The copy here of a file a session on another computer got as `<temp>/pi-pocket-uploads/<conversation>/<name>` there
 * (`copyUploads`): the same name in the conversation's uploads, when it is still there.
 */
function uploadedCopy(path: string, uploads: string): string | undefined {
    // `<session>`: the session's permission id since 0.28.0, its number before.
    const stored = /[/\\]pi-pocket-uploads[/\\][A-Za-z0-9._-]+[/\\]([^/\\]+)$/.exec(path)?.[1];

    if (stored === undefined || stored === "." || stored === "..") {
        return undefined;
    }

    const copy = join(uploads, stored);

    try {
        return statSync(copy).isFile() ? copy : undefined;
    } catch {
        return undefined;
    }
}

// A name can hold " (", so the path is the part that ends with "-name". Exported for tests.
export function attachedFile(line: string, uploads: string): Attachment[] {
    const tail = /, ([^,]+), (\d+) bytes\)(?: \[Image: .*)?$/.exec(line);

    if (!line.startsWith("- ") || tail === null) {
        return [];
    }

    const head = line.slice(2, tail.index);

    for (let at = head.indexOf(" ("); at !== -1; at = head.indexOf(" (", at + 1)) {
        const path = head.slice(0, at);
        const name = head.slice(at + 2);

        if (!path.endsWith(`-${name}`)) {
            continue;
        }

        const here = path.startsWith(uploads + sep) ? path : uploadedCopy(path, uploads);

        if (here !== undefined) {
            const mime = tail[1] === "unknown type" ? "" : tail[1]!;

            return [{ path: here, name, mime, size: Number(tail[2]) }];
        }
    }

    return [];
}

/** Copy a stored upload to a new session's upload directory. Missing or changed files leave no attachment. */
async function restoreUpload(file: Attachment, uploads: string): Promise<Attachment | undefined> {
    const path = join(uploads, basename(file.path));
    let created = false;

    try {
        const input = await open(
            file.path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );

        try {
            const stat = await input.stat();

            if (!stat.isFile() || stat.size !== file.size || stat.size > MAX_UPLOAD) {
                return undefined;
            }

            const output = await open(path, "wx", 0o600);

            created = true;

            try {
                if (stat.size > 0) {
                    await pipeline(
                        input.createReadStream({ end: stat.size - 1 }),
                        output.createWriteStream(),
                    );
                }
            } finally {
                await output.close();
            }

            return { ...file, path };
        } finally {
            await input.close();
        }
    } catch {
        if (created) {
            await rm(path, { force: true }).catch(() => {});
        }

        return undefined;
    }
}

export interface SubmitRequest {
    text: string;
    attachments?: Attachment[];
    /**
     * `steer` joins the running work after its current tool round; `interrupt` stops the run at once (as Stop does) and
     * sends the message to the idle conversation; anything else queues a follow-up while busy.
     */
    mode?: "steer" | "followUp" | "interrupt";
    /** Client-generated, so a retried POST does not submit twice. */
    requestId: string;
    /** Send the files the message mentions with `@` along with it, so Pi need not read them first. */
    inlineFiles?: boolean;
    /**
     * PiP only: the session a passage quoted in the message came from (Ask PiP by a selection). PiP gets which session
     * it is, unseen by people (`CONTEXT_BLOCK`).
     */
    about?: { session: number };
}

/** How many `@` mentioned files go along with a message, and how much of them. */
const MAX_MENTIONED = 10;
const MAX_MENTIONED_FILE = 100_000;
const MAX_MENTIONED_TOTAL = 300_000;
const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
};
const MAX_TITLE = 120;
/** A title as stored: one line, so it cannot pass for more lines where it is quoted (PiP's lists, reports). */
const oneLine = (title: string): string => title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
/**
 * What a subagent's name drops where it is quoted, to keep its letters, marks, and digits, in every script ("हिन्दी",
 * "サーバー"), its spaces, and ". _ -": no mark of its own then closes the quotes. Every quote mark goes, and every other
 * sign or symbol ("″", "´"); every control, those that turn the text around, hide, or end its isolate too; and the
 * modifier letters that are quote marks or apostrophes in form ("ʺ", "ʼ", "ˮ", the Greek "ʹ", NKo's "ߴ", the saltillo
 * "ꞌ").
 */
const UNQUOTED = /[^\p{L}\p{M}\p{N}\s._-]|[\u02B0-\u02FF\u0374\u07F4\u07F5\uA78B\uA78C]/gu;
/** A mark with no letter or digit under it (first, or after a space), which would sit on the quote beside it. */
const UNBORNE = /(?<![\p{L}\p{M}\p{N}])\p{M}+/gu;

/**
 * A person's activity line when they dealt with a subagent's failure, in its parent session: Pi named it, so quoted, and
 * isolated (U+2068 … U+2069), so a name that ends in right-to-left letters keeps the closing quote and what follows (the
 * line's clock) after it. It cannot end the isolate itself: such controls are among what it drops.
 */
export const dealtWith = (name: string): string => {
    const shown = snippet(name.replace(UNQUOTED, "").replace(UNBORNE, ""), 60);

    return `dealt with the failure of subagent “\u2068${shown}\u2069”`;
};

/** What dismissing a subagent's failure came to: `newer` when it failed again since the failure seen. */
type Dismissal = { dismissed: boolean; newer?: true };
/** What hiding a subagent from its parent's bar came to: `newer` when it did something since what was seen. */
type Hiding = { hidden: boolean; newer?: true; failure?: number };
/** The extension that makes plan mode block changes; without it, plan mode would do nothing. */
const PLAN_EXTENSION = "pocket-plan";
/** What Pi is told when someone approves its plan. */
const PLAN_APPROVED = "The plan is approved. Go ahead and carry it out.";
/** Longest handoff note for a new context, and longest instructions for Pi. */
const MAX_HANDOFF = 20_000;
const MAX_INSTRUCTIONS = 8000;

/** Where a new session works: a folder, and the worktree it is in when the session has one of its own. */
type Place = { cwd: string; worktree?: Worktree; skipped: string[] };

/** An entry id from a request, or a 400. */
function entryIdOf(value: unknown): number {
    const id = Number(value);

    if (!Number.isInteger(id) || id < 0) {
        throw new HttpError(400, "entryId must be a message id");
    }

    return id;
}

/** A request's model, when it names one, must name a provider and a model id. */
function checkModel(asked: { provider?: unknown; modelId?: unknown } | undefined): void {
    if (
        asked !== undefined &&
        (typeof asked !== "object" ||
            asked === null ||
            typeof asked.provider !== "string" ||
            typeof asked.modelId !== "string")
    ) {
        throw new HttpError(400, "model must name a provider and a model id");
    }
}

/**
 * Where a copy of a session runs, as a person picked it in the copy sheet (`POST /api/c/:id/fork` and `/resend`'s
 * `place`): the computer (`null`, this server; absent, the session's own), the folder there, the model and thinking
 * level, and a git worktree of its own. Absent fields keep the session's.
 */
export type CopyPlaceRequest = {
    runner?: string | null;
    cwd?: string;
    model?: { provider: string; modelId: string };
    thinkingLevel?: string;
    worktree?: boolean;
};

/** A copy's place, checked: the computer (undefined: this server), the folder, whether it moved, and the worktree. */
type Destination = {
    runner: string | undefined;
    cwd: string;
    worktree: boolean;
    /** The source session's computer and folder, when the copy runs elsewhere: Pi is told. */
    from?: { runner: string | undefined; cwd: string };
};

/** Check the shape of a request's `place`: every field optional, each of its type. */
function checkPlace(place: unknown): CopyPlaceRequest | undefined {
    if (place === undefined || place === null) {
        return undefined;
    }

    if (typeof place !== "object" || Array.isArray(place)) {
        throw new HttpError(400, "place must be an object");
    }

    const given = place as Record<string, unknown>;
    const runner = given.runner;

    if (runner !== undefined && runner !== null && (typeof runner !== "string" || runner === "")) {
        throw new HttpError(400, "place.runner must be a computer's id, or null for this server");
    }

    optionalText(given.cwd, "place.cwd");
    checkModel(given.model as { provider?: unknown; modelId?: unknown } | undefined);

    if (given.thinkingLevel !== undefined && !isThinkingLevel(given.thinkingLevel)) {
        throw new HttpError(
            400,
            `place.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`,
        );
    }

    if (given.worktree !== undefined && typeof given.worktree !== "boolean") {
        throw new HttpError(400, "place.worktree must be true or false");
    }

    return given as CopyPlaceRequest;
}

/** A person's message to a failed subagent (`subagent`, its conversation), followed to its end; `failure`, its own then. */
type Followed = { subagent: number; requestId: string; failure: number; by: string };

/**
 * What a person's run of subagent `id` came to, on its record in its parent's `doc`, kept as its reports keep what Pi's
 * work came to: answered, it is done and needs nobody; unanswered, it failed again (or was stopped), which is its
 * failure now, and needs someone even if the one before was dismissed. Not while its record holds a failure newer than
 * `failure`, the one they wrote to: nobody saw that one. The subagent's name when this cleared its failure.
 */
function settle(
    doc: { agents: Record<string, SubagentRecord> },
    id: ConversationId,
    failure: number,
    result: { status: string; reason?: string; detail?: unknown },
): string | undefined {
    const name = Object.keys(doc.agents).find((each) => doc.agents[each]!.conversationId === id);
    const record = name === undefined ? undefined : doc.agents[name]!;

    if (record === undefined || (record.failed === true && (record.answeredAt ?? 0) !== failure)) {
        return undefined;
    }

    const cleared = record.failed === true && result.status !== "unanswered" ? name : undefined;

    record.answeredAt = Date.now();
    record.failed = result.status === "unanswered";

    if (result.status === "unanswered") {
        record.error = whyUnanswered(result.reason ?? "", result.detail);
    } else {
        delete record.error;
    }

    return cleared;
}

/** What someone who sees a session but may not share it is told (`access.ts` `mayShare`). */
const CANNOT_SHARE =
    "Only the person who started this session, whoever is in charge of its computer, or someone who shares what they were given there can share it.";

/**
 * One session `user` may share with one person, or take back from them, with how that person has it now (`Commands`
 * `sharingWith`). An archived session is not listed.
 */
export type SharingRow = {
    id: number;
    title: string;
    computer: string;
    /** Its computer's name, as the sheets show it. */
    computerName: string;
    cwd: string;
    /** The folder its access is judged by (`app.ts` `folderOf`): the list groups it under that one. */
    folder: string;
    /** When anything last happened in it, and when whoever asks last sent to Pi in it (`app.ts` `usedAt`). */
    updatedAt: number;
    usedAt?: number;
    starter: { id: string; name: string };
    /**
     * How they have it: they started it; they were invited to it alone; it is shared with them; they see every session
     * in its folder; they cannot have it (`reason`); or they do not have it.
     */
    state: "started" | "invited" | "shared" | "folder" | "blocked" | "none";
    /** Can whoever asks share it with them now, and take it back from them. */
    give: boolean;
    take: boolean;
    /** Who shared it with them, when that is known. */
    by?: { id: string; name: string };
    reason?: string;
};

/** One folder on a computer whoever asks is not in charge of, with how one person has it (`Commands` `sharingWith`). */
export type SharingFolder = {
    path: string;
    /** They were given it; and `sees`: they access every session in it. */
    has: boolean;
    sees: boolean;
    /** Can whoever asks give it to them now, take it back, and change `sees`. */
    give: boolean;
    take: boolean;
    see: boolean;
    /** Who gave it to them, when that is known. */
    by?: { id: string; name: string };
    /** What they have of it as one level (`config.ts` `FolderLevel`), and the levels whoever asks can set it to. */
    level: FolderLevel;
    levels: FolderLevel[];
};

/** A computer whoever asks uses and is not in charge of: the folders they can give one person there, or gave them. */
export type SharingComputer = {
    id: string;
    name: string;
    /** Why nothing can be given to that person there. */
    reason?: string;
    folders: SharingFolder[];
};

/**
 * What a person's message (`requestId`) to subagent `id` came to; undefined when it is not there, or is left in the
 * subagent's queue with no run to take it. Pi Durable leaves a failed run's queue alone, so a message sent while a run
 * went on, which then failed, waits for the next one someone sends, if anyone does: its follow ends then, and the
 * message stays where it is. Its known request id gives back the message sent, as it is now: nothing is sent again.
 */
async function followed(
    runtime: TaskRuntime<Followed, { phase: "wait" }, null, object>,
    id: ConversationId,
    requestId: string,
    context: Context,
): Promise<SettledSubmissionRecord | undefined> {
    // Where it is: gone, left (queued with no run), or sent. One commit reads both, and writes nothing.
    const where = async () => {
        let found = "gone" as "gone" | "left" | "sent";

        await runtime.commit(async (tx) => {
            const record = await tx.submissionByRequest(id, requestId);

            if (record !== undefined) {
                found =
                    record.status === "queued" && (await tx.doc(LiveDoc, id)).run === undefined
                        ? "left"
                        : "sent";
            }
        }, context);

        return found;
    };

    if ((await where()) !== "sent") {
        return undefined;
    }

    const submission = await (
        await runtime.conversation(id, context)
    )?.submit({ type: "input", content: "", requestId }, context);
    const watch = await runtime.watchDoc(LiveDoc, id, context);
    let leave!: () => void;
    const left = new Promise<undefined>((resolve) => {
        leave = () => resolve(undefined);
    });
    // The look under way, if any: one the watch started may still be going when it stops.
    let looking: Promise<void> = Promise.resolve();

    // Each time the subagent has no run, a look at whether this message is left behind. A failed one is reported.
    const look = (live: { run?: unknown } | null) => {
        if (live !== null && live.run === undefined) {
            looking = where().then(
                (found) => (found === "left" ? leave() : undefined),
                (error: unknown) => runtime.report(error),
            );
        }

        return looking;
    };

    if (submission === undefined) {
        await watch?.stop();

        return undefined;
    }

    try {
        if (watch !== undefined) {
            // A listener is never called inline, so the value it started on is this one's to look at.
            await look(watch.value);
            watch.start((call) => (call.kind === "value" ? look(call.value) : looking));
        }

        return await Promise.race([submission.wait(context), left]);
    } finally {
        // On every way out, so no watch outlives the phase, nor a look its commit.
        await watch?.stop();
        await looking;
    }
}

export class Commands {
    readonly #app: PocketApp;
    /**
     * Follows a person's message to a failed subagent to its end and settles the failure by it (`settle`): a task of the
     * parent's, beside its work, so a restart before the run ends still settles it, as the subagent's reports do Pi's
     * work. It finds the message by its request id, and never sends one (`followed`). Answered, the parent's activity
     * says who dealt with the failure. A message left in the queue by a run that failed ends it, settling nothing.
     */
    readonly followTask: Task<Followed, { phase: "wait" }, null, object>;
    /** An Interrupt (`submit`, `moveQueued`): it stops the run it was made for, by that run's id. */
    readonly interruptTask: Task<Interrupt, { phase: "send" }, null, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.interruptTask = interruptTask(async (run, context) => {
            const harness = this.#app.harness;
            const task = run as unknown as TaskId;
            const record = await harness.getTask(task, context);

            if (record === undefined || record.state.status === "terminal") {
                return;
            }

            await harness.abortTask(task, context);
            await harness.waitForTask(task, context);
        });
        this.followTask = defineTask<Followed, { phase: "wait" }, null>({
            name: "pocket.follow-failure",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: async (task, runtime, context) => {
                    const { subagent, requestId, failure, by } = task.input;
                    const id = subagent as unknown as ConversationId;
                    const settled = await followed(runtime, id, requestId, context);
                    let cleared: string | undefined;

                    await runtime.commit(async (tx) => {
                        if (settled !== undefined) {
                            cleared = settle(
                                await tx.doc(SubagentsDoc, runtime.conversationId),
                                id,
                                failure,
                                settled,
                            );
                        }

                        return {
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        };
                    }, context);

                    const user = app.config.userById(by);

                    if (cleared !== undefined && user !== undefined) {
                        await app.collab.activity(runtime.conversationId, user, dealtWith(cleared));
                    }
                },
            },
            abort: (_task, runtime, context) =>
                runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    context,
                ),
        });
    }

    /**
     * Start a session whose tools run on computer `runner` (`runners.ts`), in a folder there; home without one. Only
     * the linker and granted people: everything runs as that computer's user. It runs with `App.remoteExtensions` only,
     * so nothing in it works on this server's disk.
     */
    async #createRemote(
        user: User,
        runner: string,
        request: { cwd?: string; worktree?: unknown },
        title: string | undefined,
        signal?: AbortSignal,
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;

        // The linker and granted people run commands as this computer's user.
        app.runners.require(runner);
        app.policy.requireStart(user, runner);

        const cwd = await app.runners.checkFolder(runner, optionalText(request.cwd, "cwd") ?? "~");

        // The server decides (`access.ts` `folder`): a folder given to them, approved by their code or who is in charge.
        const approved = await app.approveStart(user, cwd, signal, runner);

        const runnerPermission = randomUUID();

        const initial = this.#defaultModel();
        const label = title ?? `${basename(cwd) || cwd} on ${app.runners.name(runner)}`;

        return this.#inPlace(
            cwd,
            request.worktree === true,
            label,
            async (place) => {
                const conversation = await app.harness.createConversation(
                    {
                        ownership: { kind: "ownerless" },
                        agent: {
                            cwd: place.cwd,
                            ...(initial.model === undefined ? {} : { model: initial.model }),
                            ...(initial.thinkingLevel === undefined
                                ? {}
                                : { thinkingLevel: initial.thinkingLevel }),
                        },
                        init: async (tx, id) => {
                            // This initializer only adds the new session's record.
                            const sessions = await tx.doc(SessionsDoc);
                            // When its record is written, not when the request came: a worktree is made between the
                            // two, and "Current sessions" and "New sessions" (`access.ts` `seesFolder`) go by this time.
                            const now = Date.now();

                            (await tx.doc(AgentDoc, id)).extensions = app.remoteExtensions();
                            sessions.items[String(id)] = {
                                cwd: place.cwd,
                                createdAt: now,
                                updatedAt: now,
                                createdBy: user.id,
                                ...app.initialShares(runner, user),
                                runner,
                                runnerPermission,
                                title: label,
                                ...(place.worktree === undefined
                                    ? {}
                                    : { worktree: place.worktree }),
                            };
                        },
                    },
                    // Unchosen, or the folder taken back, while the worktree was made: no session is saved.
                    checkedContext(context, approved.check),
                );

                approved.keep(conversation.id, cwd);
                void this.recordRepo(conversation.id, place.cwd);

                return { id: conversation.id };
            },
            { runner, scope: { id: runnerPermission, folder: cwd } },
        );
    }

    /** Start a session in a folder; with `worktree`, in a git worktree of its own made from that folder. */
    async createSession(
        user: User,
        request: { cwd?: string; title?: string; worktree?: unknown; runner?: unknown },
        {
            projectDefaults = true,
            model,
            thinkingLevel,
            init,
            signal,
        }: {
            projectDefaults?: boolean;
            /** A model the caller already checked: it replaces the default, in the commit that makes the session. */
            model?: ModelRef;
            thinkingLevel?: ModelThinkingLevel;
            /** Runs in the commit that makes the session, after its entry is written. */
            init?: (tx: Tx, id: ConversationId) => Promise<void>;
            /** Ends the wait for the computer's answer, when the session goes to another computer. */
            signal?: AbortSignal;
        } = {},
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;
        // Each computer's own `requireStart` decides who starts a session on it: here below, `#createRemote` there.
        const given = optionalText(request.title, "title");
        const title = (given === undefined ? undefined : oneLine(given)) || undefined;
        const runner = optionalText(request.runner, "runner");

        if (runner !== undefined) {
            return this.#createRemote(user, runner, request, title, signal);
        }

        // Starting a session here: whoever the owner chose for this server, and steers.
        app.policy.requireStart(user, THIS_SERVER);
        const requested = optionalText(request.cwd, "cwd") ?? app.defaultCwd;

        app.requireWorkspaceOwner(user, requested);
        const remote = app.workspaceScheme(requested) !== undefined;

        if (remote && request.worktree === true) {
            throw new HttpError(400, "Remote workspaces do not support worktrees.");
        }

        const folder = await app.resolveCwd(requested);

        // A folder here needs an approval unless the policy says it does not (`access.ts` `folder`). A workspace URI is
        // the owner's alone, who needs none.
        const approved = remote ? undefined : await app.approveStart(user, folder, signal);

        return this.#inPlace(
            folder,
            request.worktree === true,
            title ?? basename(folder),
            async ({ cwd, worktree }) => {
                // An internal caller about to apply a person's explicit model keeps its previous starting pair.
                const initial = this.#defaultModel(
                    undefined,
                    projectDefaults && model === undefined && !remote ? cwd : undefined,
                );
                const conversation = await app.harness.createConversation(
                    {
                        ownership: { kind: "ownerless" },
                        agent: {
                            cwd,
                            ...(model !== undefined
                                ? { model }
                                : initial.model === undefined
                                  ? {}
                                  : { model: initial.model }),
                            ...(thinkingLevel !== undefined
                                ? { thinkingLevel }
                                : initial.thinkingLevel === undefined
                                  ? {}
                                  : { thinkingLevel: initial.thinkingLevel }),
                        },
                        init: async (tx, id) => {
                            // This initializer only adds the new session's record.
                            const sessions = await tx.doc(SessionsDoc);
                            // When its record is written, not when the request came: a worktree is made between the
                            // two, and "Current sessions" and "New sessions" (`access.ts` `seesFolder`) go by this time.
                            const now = Date.now();

                            sessions.items[String(id)] = {
                                cwd,
                                createdAt: now,
                                updatedAt: now,
                                createdBy: user.id,
                                ...app.initialShares(undefined, user),
                                ...(title === undefined ? {} : { title }),
                                ...(worktree === undefined ? {} : { worktree }),
                            };
                            await init?.(tx, id);
                        },
                    },
                    // Unchosen, or the folder taken back, while the approval or the worktree waited: nothing is saved.
                    approved === undefined ? context : checkedContext(context, approved.check),
                );

                approved?.keep(conversation.id, folder);
                void this.recordRepo(conversation.id, cwd);

                return { id: conversation.id };
            },
        );
    }

    /**
     * Continue one of Pi's sessions from the terminal here: a new session with its history, in its folder, with its model
     * when that one is signed in here (`pi-sessions.ts`). Local files are for whoever is in charge of this server;
     * a runner's files need its grant.
     */
    async continuePiSession(
        user: User,
        path: string,
        { runner, signal }: { runner?: string; signal?: AbortSignal } = {},
    ): Promise<{ id: ConversationId; notes?: string[] }> {
        const app = this.#app;
        let session: PiSession;
        let cwd: string;
        let runnerPermission: string | undefined;
        // The companion files beside a Pi file on a linked computer, by suffix: their bytes, read before it opens.
        const fetched = new Map<string, Uint8Array>();

        let approved: Approved | undefined;

        if (runner !== undefined) {
            app.runners.require(runner);
            app.policy.requireStart(user, runner);

            const info = (await app.piSessions.list(user, "", runner)).sessions.find(
                (each) => each.path === path,
            );

            if (info === undefined) {
                throw new HttpError(404, `Pi has no such session on ${app.runners.name(runner)}.`);
            }

            try {
                cwd = await app.runners.checkFolder(runner, info.cwd);
            } catch (error) {
                if (error instanceof HttpError && error.status === 409) {
                    throw error;
                }

                throw new HttpError(
                    400,
                    `The folder this Pi session worked in is not there anymore on ${app.runners.name(runner)}: ${info.cwd}`,
                );
            }

            // As a new session in the Pi session's folder: one given to them, approved by their code or who is in
            // charge (`access.ts` `folder`). Only then does the computer let the session read Pi's file.
            approved = await app.approveStart(user, cwd, signal, runner);
            runnerPermission = randomUUID();
            const link = app.runners.link(runner);
            const opened = await link.piSessions(
                {
                    op: "open",
                    path,
                    session: runnerPermission,
                    folder: cwd,
                    companions: app.piSessions.companionSuffixes(),
                },
                signal,
            );

            if (opened.path === undefined) {
                throw new HttpError(409, "The computer did not return the Pi session file.");
            }

            const env = app.runners.env(runner, cwd, { id: runnerPermission, folder: cwd });
            const text = await env.readTextFile(
                opened.path,
                signal === undefined ? context : withAbortSignal(signal, context),
            );

            if (!text.ok) {
                throw new HttpError(400, text.error.message);
            }

            try {
                session = readPiSession(text.value);
            } catch (error) {
                if (error instanceof PiSessionError) {
                    throw new HttpError(400, error.message);
                }

                throw error;
            }

            // Each companion the computer found and allowed, copied here: extensions read it as they do one beside a
            // Pi file on this server. One that cannot be read stays behind; the session still opens.
            for (const file of opened.companions ?? []) {
                const suffix = app.piSessions
                    .companionSuffixes()
                    .find((each) => file === `${opened.path}${each}`);

                if (suffix === undefined) {
                    continue;
                }

                const bytes = await env.readBinaryFile(
                    file,
                    signal === undefined ? context : withAbortSignal(signal, context),
                );

                if (!bytes.ok) {
                    app.log(
                        `Pi session companion ${suffix} on ${app.runners.name(runner)}: ${bytes.error.message}`,
                    );
                    continue;
                }

                fetched.set(suffix, bytes.value);
            }

            signal?.throwIfAborted();
        } else {
            session = await app.piSessions.read(user, path);

            try {
                cwd = app.workspace.checkDirectory(session.cwd);
            } catch {
                throw new HttpError(
                    400,
                    `The folder this Pi session worked in is not there anymore: ${session.cwd}`,
                );
            }

            approved = await app.approveStart(user, cwd, signal);
        }

        const start = this.#defaultModel(session);
        const title = session.title.slice(0, MAX_TITLE);
        let copies = new Map<EntryId, string>();
        const conversation = await app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: {
                    cwd,
                    ...(start.model === undefined ? {} : { model: start.model }),
                    ...(start.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: start.thinkingLevel }),
                },
                init: async (tx, id) => {
                    if (runner !== undefined) {
                        (await tx.doc(AgentDoc, id)).extensions = app.remoteExtensions();
                    }

                    // This initializer only adds the new session's record, with the time it is written.
                    const now = Date.now();

                    (await tx.doc(SessionsDoc)).items[String(id)] = {
                        cwd,
                        title,
                        createdAt: now,
                        updatedAt: now,
                        createdBy: user.id,
                        ...app.initialShares(runner, user),
                        fromPi: { session: session.id, count: session.count },
                        ...(runner === undefined ? {} : { runner, runnerPermission }),
                    };
                    copies = await writePiSession(tx, id, session, {
                        session: session.id,
                        title: session.title,
                        file: path,
                    });
                },
            },
            approved === undefined ? context : checkedContext(context, approved.check),
        );
        // What extensions keep beside Pi's file comes along, before the person opens the session: from beside the file
        // here, or the copies of those beside it on the linked computer.
        const notes =
            runner === undefined
                ? await app.piSessions.carryCompanions(path, conversation.id, copies, context)
                : await this.#carryFetched(path, conversation.id, copies, fetched);

        approved?.keep(conversation.id, cwd);
        void this.recordRepo(conversation.id, cwd);

        return { id: conversation.id, ...(notes.length === 0 ? {} : { notes }) };
    }

    /**
     * Give companions the files fetched from beside a Pi file on a linked computer: as copies in a private folder here,
     * removed once they are done, so an extension reads them as it reads one beside a Pi file on this server.
     */
    async #carryFetched(
        path: string,
        id: ConversationId,
        copies: ReadonlyMap<EntryId, string>,
        fetched: ReadonlyMap<string, Uint8Array>,
    ): Promise<string[]> {
        if (fetched.size === 0) {
            return [];
        }

        const folder = await mkdtemp(join(tmpdir(), "pi-pocket-companions-"));

        try {
            const there = new Map<string, string>();

            for (const [suffix, bytes] of fetched) {
                const copy = join(folder, `session.jsonl${suffix}`);

                await writeFile(copy, bytes, { mode: 0o600 });
                there.set(suffix, copy);
            }

            return await this.#app.piSessions.carryCompanions(path, id, copies, context, there);
        } finally {
            await rm(folder, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * Run `create` with the folder a new session works in: `cwd` itself, or, when `isolated`, the matching folder in a
     * new git worktree made from it, named after `label`. A worktree whose session `create` did not make is discarded.
     */
    async #inPlace<T>(
        cwd: string,
        isolated: boolean,
        label: string,
        create: (place: Place) => Promise<T>,
        remote?: { runner: string; scope: SessionScope },
    ): Promise<T> {
        if (!isolated) {
            return create({ cwd, skipped: [] });
        }

        const info =
            remote === undefined
                ? undefined
                : await this.#app.runners.link(remote.runner).infoNow();
        const access =
            remote === undefined || info === undefined
                ? undefined
                : remoteWorktrees(this.#app.runners.env(remote.runner, cwd, remote.scope), info);
        const folder =
            access === undefined || info === undefined || remote === undefined
                ? // By its real path, as a session's folder is saved: the data folder may be reached through a link.
                  join(await realFolder(this.#app.dataDir), "worktrees")
                : access.path.join(info.home, ".pi-pocket", "worktrees", remote.scope.id);
        const made = await createWorktree(cwd, folder, label, access);

        try {
            return await create(made);
        } catch (error) {
            await discardWorktree(made.worktree, access).catch((cleanup: unknown) =>
                this.#app.log(`worktree ${made.worktree.path} left behind: ${describe(cleanup)}`),
            );

            throw error;
        }
    }

    /** Remove a session's worktree folder; its branch stays. One with uncommitted changes stays too, unless `force`. */
    async removeWorktree(id: ConversationId, user: User, force: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const worktree = app.sessionMeta(id)?.worktree;

        if (app.workspaceScheme(app.cwdOf(id)) !== undefined) {
            throw new HttpError(400, "Remote workspaces do not support worktrees.");
        }

        if (worktree === undefined) {
            throw new HttpError(404, "This session has no worktree");
        }

        const runner = app.runnerOf(id);
        const access =
            runner === undefined
                ? localAccess
                : remoteWorktrees(
                      app.runners.env(runner, app.cwdOf(id), app.runnerScope(id)),
                      await app.runners.link(runner).infoNow(),
                  );
        const inside = async (each: ConversationId) =>
            app.runnerOf(each) === runner && (await inWorktree(worktree, app.cwdOf(each), access));

        // Anything at work there would lose its folder: this session's runs, its subagents', or another session's.
        if ((await Promise.all(app.busyConversations().map(inside))).some(Boolean)) {
            throw new HttpError(409, "Pi is working in the worktree: stop it first.");
        }

        // A fork made without a worktree of its own works in this one.
        const sessions = app.sessions().filter((session) => session.id !== Number(id));
        const shared = await Promise.all(
            sessions.map((session) => inside(session.id as unknown as ConversationId)),
        );
        const sharing = sessions.find((_session, index) => shared[index]);

        if (sharing !== undefined) {
            throw new HttpError(
                409,
                `“${sharing.title ?? "New session"}” works in this worktree too. Move it to another folder first.`,
            );
        }

        const back = await sourceFolders(worktree, access);
        const moves: { id: ConversationId; cwd: string }[] = [];

        for (const each of app.conversationsOf(id)) {
            if (await inside(each)) {
                moves.push({ id: each, cwd: await back(app.cwdOf(each)) });
            }
        }

        // Checked again after the reads above: the worktree goes only for who still drives the session.
        app.recheck(id, user);
        await removeWorktree(worktree, force === true, access);

        const cwd = moves.find((each) => each.id === id)?.cwd ?? app.cwdOf(id);

        // One save: the session and its subagents go back to the folders the worktree came from, and the session's
        // record says so. Nothing that cuts it short leaves the two apart.
        await app.commit(async (tx) => {
            for (const move of moves) {
                await configureAgent(tx, move.id, { cwd: move.cwd });
            }

            const meta = (await app.sessionsIn(tx)).items[String(id)];

            if (meta === undefined) {
                return;
            }

            delete meta.worktree;
            meta.cwd = cwd;
        }, context);
        await app.collab.activity(
            id,
            user,
            `removed the worktree; the branch ${worktree.branch} stays, and Pi works in ${homePath(cwd)} again`,
        );
    }

    /** The model and thinking level a new session starts with now. */
    defaultModel(): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
        return this.#defaultModel();
    }

    /**
     * The model a new session starts with, always one a person chose: `prefer` (with its thinking level) when it is
     * signed in here, or else the owner's default, even when it is not signed in now: the session then shows that, and
     * its first message fails in sight, where another model would spend on what nobody chose for it. Without an owner's
     * default, ordinary sessions consult trusted project defaults in their final cwd, then the last picked model (at
     * its level in Pi's `modelThinkingLevels`, when it has one), then Pi's global default. A no-cwd caller (imports and
     * PiP itself) keeps the legacy default selection. Never the first model there is: with none chosen, the session
     * starts without a model, and someone picks one.
     */
    #defaultModel(
        prefer?: {
            model: { provider: string; modelId: string } | null;
            thinkingLevel: string;
        },
        cwd?: string,
    ): {
        model?: ModelRef;
        thinkingLevel?: ModelThinkingLevel;
    } {
        const { models, config, settings } = this.#app;
        const available = models.getAvailableSnapshot();
        const pick = (provider: string | undefined, id: string | undefined) =>
            provider === undefined || id === undefined
                ? undefined
                : available.find((model) => model.provider === provider && model.id === id);
        const last = config.lastModel;
        const preferred = pick(prefer?.model?.provider, prefer?.model?.modelId);
        const chosen = config.defaultModel;
        const owners =
            chosen === undefined ? undefined : models.getModel(chosen.provider, chosen.modelId);
        const defaults =
            chosen === undefined && cwd !== undefined ? globalModelSettings(cwd) : settings;
        const project =
            chosen === undefined && cwd !== undefined
                ? projectModelDefault(cwd, defaults, models)
                : undefined;
        const lastPicked =
            chosen === undefined && project === undefined
                ? pick(last?.provider, last?.modelId)
                : undefined;
        // Ordinary sessions must not inherit a different project's settings from the server's starting folder.
        // Imported sessions and PiP's own conversation keep their existing selection behavior.
        const global = cwd === undefined ? undefined : defaults.getGlobalSettings();
        const pis =
            chosen === undefined && project === undefined && lastPicked === undefined
                ? pick(
                      cwd === undefined ? settings.getDefaultProvider() : global?.defaultProvider,
                      cwd === undefined ? settings.getDefaultModel() : global?.defaultModel,
                  )
                : undefined;
        const model = preferred ?? owners ?? project?.model ?? lastPicked ?? pis;

        if (model === undefined) {
            return {};
        }

        const level = ((preferred !== undefined
            ? prefer?.thinkingLevel
            : owners !== undefined
              ? chosen?.thinkingLevel
              : project !== undefined
                ? project.thinkingLevel
                : lastPicked !== undefined
                  ? ((cwd === undefined
                        ? undefined
                        : rememberedLevel(defaults, lastPicked.provider, lastPicked.id)) ??
                    last?.thinkingLevel)
                  : cwd === undefined
                    ? settings.getDefaultThinkingLevel()
                    : global?.defaultThinkingLevel) ?? "off") as ModelThinkingLevel;

        return {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: clampThinkingLevel(model, level),
        };
    }

    /**
     * Whom session `id` is shared with, and whom it can be: everyone who may use its computer, but who is in charge of
     * it and its starter, who have it anyway. Someone it is shared with already who may not use the computer (they came
     * with an invite, or are no longer chosen) is listed too, as `notChosen`: they keep it until taken off. For who may
     * share it (`access.ts` `mayShare`); to anyone else who sees it, 403; to whom it is hidden, 404. `locked`: a share
     * that is not `user`'s to end (`mayUnshare`), which a save of theirs leaves as it is. Who asks is not listed.
     */
    sharing(
        id: ConversationId,
        user: User,
    ): {
        sharedWith: string[];
        people: {
            id: string;
            name: string;
            role: User["role"];
            /** What the page asks of the role (`roles.ts` `roleSaid`). */
            owner: boolean;
            prompts: boolean;
            /** The one word the page says of them (`rights.ts` `roleWord`). */
            word: RoleWord;
            notChosen?: true;
            /** They see it anyway: it is in a folder they see every session of (`access.ts` `seesFolder`). */
            byFolder?: true;
            /** Shared with them by someone else: not `user`'s to end (`access.ts` `mayUnshare`). */
            locked?: true;
        }[];
        computer: string;
    } {
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        app.requireSee(user, root);

        if (meta === undefined) {
            throw new HttpError(404, "Not a session");
        }

        if (!app.policy.mayShare(user, String(root))) {
            throw new HttpError(403, CANNOT_SHARE);
        }

        const computer = meta.runner ?? THIS_SERVER;
        const starter = app.policy.starter({ id: String(root), computer, ...meta });

        const shared = meta.sharedWith ?? [];
        const people = app.config.users
            .filter(
                (person) =>
                    !app.policy.inCharge(person, computer) &&
                    person.id !== starter &&
                    person.id !== user.id &&
                    (app.policy.mayUse(person, computer) || shared.includes(person.id)),
            )
            .map((person) => ({
                id: person.id,
                name: person.name,
                ...app.policy.said(person),
                ...(app.policy.mayUse(person, computer) ? {} : { notChosen: true as const }),
                ...(app.seesByFolder(person, root) ? { byFolder: true as const } : {}),
                ...(shared.includes(person.id) &&
                !app.policy.mayUnshare(user, String(root), person.id)
                    ? { locked: true as const }
                    : {}),
            }));

        return {
            // Only the people listed: an id of someone who left, or who is in charge now, is not sent back on a save.
            sharedWith: shared.filter((id) => people.some((person) => person.id === id)),
            people,
            computer: computer === THIS_SERVER ? "This server" : app.runners.name(computer),
        };
    }

    /**
     * Share session `id` with exactly `people` (person ids), one at a time: for who may share it (`access.ts`
     * `mayShare`). Each must be able to use the session's computer; who is in charge of it sees every session there
     * anyway, and the starter has it, so neither is kept. Someone it is shared with already stays without that, until
     * taken off. A share that is not `user`'s to end (`mayUnshare`: someone else made it, and `user` neither started
     * the session nor is in charge of its computer) stays whatever the list says. Someone taken off leaves it at once
     * (`app.accessChanged`), and the tasks they set up on it go to who is in charge of its computer, in the same save.
     */
    async shareSession(id: ConversationId, user: User, people: unknown): Promise<string[]> {
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        app.requireSee(user, root);

        if (meta === undefined) {
            throw new HttpError(404, "Not a session");
        }

        if (!app.policy.mayShare(user, String(root))) {
            throw new HttpError(403, CANNOT_SHARE);
        }

        if (
            !Array.isArray(people) ||
            people.length > 200 ||
            !people.every((each): each is string => typeof each === "string")
        ) {
            throw new HttpError(400, "people must be a list of person ids.");
        }

        const computer = meta.runner ?? THIS_SERVER;
        const starter = app.policy.starter({ id: String(root), computer, ...meta });
        const shared: string[] = [];
        // Who is leaving its computer (no longer chosen there, their shares not taken back yet) no longer has it.
        const leaving = (): readonly string[] => app.config.leaving(meta.runner ?? THIS_SERVER);
        const had = new Set(meta.sharedWith ?? []);
        const before = new Set([...had].filter((each) => !leaving().includes(each)));

        for (const each of new Set(people)) {
            const person = app.config.userById(each);

            if (person === undefined) {
                throw new HttpError(400, "That person is not on this server.");
            }

            if (app.policy.inCharge(person, computer) || person.id === starter) {
                continue;
            }

            // Their share is ending (`app.ts` `#finishLeaving`): this save does not keep it.
            if (had.has(person.id) && !before.has(person.id)) {
                continue;
            }

            if (!before.has(person.id) && !app.policy.mayUse(person, computer)) {
                const place = computer === THIS_SERVER ? "this server" : app.runners.name(computer);

                throw new HttpError(
                    400,
                    app.policy.inCharge(user, computer)
                        ? `${person.name} cannot use ${place}: choose them for it first.`
                        : `${person.name} cannot use ${place}. Whoever is in charge of it chooses who uses it.`,
                );
            }

            shared.push(person.id);
        }

        // Asked as it is saved: a share someone else made since is not ended by a list that never had it.
        return await this.#saveShares(root, user, meta.runner, (now) => [
            ...shared,
            ...now.filter(
                (each) =>
                    !shared.includes(each) && !app.policy.mayUnshare(user, String(root), each),
            ),
        ]);
    }

    /**
     * Save whom session `root` is shared with: `next` gives the new list from the list as it is when this is saved, so a
     * change of one person and a change of another made at the same moment both count. Who is leaving its computer, or
     * may no longer use it, is not shared with anew. Whoever it takes off hands the tasks they set up on the session to
     * who is in charge of its computer, in the same save. The checks of who may share, and with whom, are the caller's.
     */
    async #saveShares(
        root: ConversationId,
        user: User,
        runner: string | undefined,
        next: (now: readonly string[]) => string[],
    ): Promise<string[]> {
        const app = this.#app;
        const computer = runner ?? THIS_SERVER;
        const leaving = (): readonly string[] => app.config.leaving(computer);
        let saved: string[] = [];
        // Whom it was shared with as this change was saved, but who is leaving its computer.
        let was: string[] = [];
        let handed: [string, Map<string, string>][] = [];

        await app.commit(async (tx) => {
            const sessions = await app.sessionsIn(tx);
            const item = sessions.items[String(root)];

            if (item === undefined) {
                throw new HttpError(404, "Not a session");
            }

            // Checked again here, as it is saved: someone no longer chosen for its computer since the check above is
            // not shared with anew, and never someone who is leaving it.
            const now = [...(item.sharedWith ?? [])];
            const wanted = next(now);

            was = now.filter((each) => !leaving().includes(each));

            saved = wanted.filter(
                (each) =>
                    !leaving().includes(each) &&
                    (now.includes(each) || app.policy.mayUse({ id: each }, computer)),
            );

            if (saved.length === 0) {
                delete item.sharedWith;
            } else {
                item.sharedWith = saved;
            }

            // Whoever saves it shared it with the people who are new in it: a share of theirs to end (`mayUnshare`).
            noteShares(
                item,
                saved.filter((each) => !now.includes(each)),
                user.id,
            );

            // Whoever this save takes off hands the tasks they set up on the session to who is in charge of its
            // computer, in this same save: nothing that cuts it short leaves a task with someone who lost the session.
            // Who still has it another way (by its folder, or invited to it) keeps theirs (`app.ts` `handTasks`).
            const lost: [string, Map<string, string>][] = [];

            for (const each of now) {
                if (!saved.includes(each)) {
                    lost.push([
                        each,
                        await app.handTasks(tx, sessions, each, { only: String(root) }),
                    ]);
                }
            }

            handed = lost;
        }, context);

        for (const [person, lost] of handed) {
            app.worksFor(person, lost);
        }

        const added = saved.filter((each) => !was.includes(each));
        const removed = was.filter((each) => !saved.includes(each));
        const names = (ids: string[]) =>
            ids.map((each) => app.config.userById(each)?.name ?? "someone").join(", ");

        if (added.length > 0) {
            await app.collab.activity(root, user, `shared the session with ${names(added)}`);
        }

        if (removed.length > 0) {
            await app.collab.activity(
                root,
                user,
                `stopped sharing the session with ${names(removed)}`,
            );
        }

        return saved;
    }

    /**
     * Whom `user` shares sessions with one person at a time: `personId`, as `user` sees them in People. A viewer shares
     * nothing, and is told so before the person is looked up; someone not in their People is no person to them.
     */
    #sharee(user: User, personId: string): User {
        const app = this.#app;

        if (!app.policy.prompts(user)) {
            throw new HttpError(403, "Viewers cannot share sessions. Ask to be made a user.");
        }

        const person = app.people(user).some((each) => each.id === personId)
            ? app.config.userById(personId)
            : undefined;

        if (person === undefined) {
            throw new HttpError(404, "No such person.");
        }

        if (person.id === user.id) {
            throw new HttpError(400, "That is you: your sessions are yours already.");
        }

        return person;
    }

    /**
     * Session `id` when it is `user`'s to share (`access.ts` `mayShare`), or, with `from`, to take back from that
     * person (`mayUnshare`); one hidden from them is no session to them.
     */
    #sharable(
        user: User,
        id: ConversationId,
        from?: string,
    ): { root: ConversationId; meta: SessionMeta } {
        const app = this.#app;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);

        if (
            meta === undefined ||
            !app.canSee(user, root) ||
            !(
                app.policy.mayShare(user, String(root)) ||
                (from !== undefined && app.policy.mayUnshare(user, String(root), from))
            )
        ) {
            throw new HttpError(404, "Not a session you can share.");
        }

        return { root, meta };
    }

    /**
     * What `user` can give `personId`, and take back from them, as a person's page in People lists it.
     *
     * `sessions`: the ones `user` may share (`access.ts` `mayShare`) or take back from that person (`mayUnshare`), each
     * with how the person has it now, newest first; none of them archived. A session on a computer that person is in
     * charge of is left out: every one there is theirs, and `charge` names those computers.
     *
     * `computers`: where `user` is not in charge, the folders they can give that person (their own, while they share
     * what they were given: `mayGiveFolder`) and the ones they gave them. Where `user` is in charge, the Runners rules
     * tell them every folder (`app.ts` `thisServer`, `runners.ts` `list`), so none is told here.
     *
     * `shareNew`: where `user` can share the sessions they start from now on, and whether they do.
     */
    sharingWith(
        user: User,
        personId: string,
    ): {
        person: { id: string; name: string };
        sessions: SharingRow[];
        charge: { id: string; name: string }[];
        computers: SharingComputer[];
        shareNew: { id: string; name: string; on: boolean }[];
    } {
        const app = this.#app;
        const person = this.#sharee(user, personId);
        const charge = new Map<string, string>();

        const named = (id: string | undefined): { id: string; name: string } | undefined => {
            const found = id === undefined ? undefined : app.config.userById(id);

            return found === undefined ? undefined : { id: found.id, name: found.name };
        };

        const placed = (computer: string): string =>
            computer === THIS_SERVER ? "This server" : app.runners.name(computer);
        const sessions = app.sessions(user).flatMap((row): SharingRow[] => {
            const id = row.id as unknown as ConversationId;
            const meta = app.sessionMeta(id);
            const computer = row.runner ?? THIS_SERVER;

            if (
                meta === undefined ||
                meta.archived === true ||
                (row.mayShare !== true && !app.policy.mayUnshare(user, String(id), person.id))
            ) {
                return [];
            }

            const mine = app.policy.inCharge(user, computer);
            const name = placed(computer);

            if (app.policy.inCharge(person, computer)) {
                charge.set(computer, name);

                return [];
            }

            const starter = app.policy.starter({ id: String(id), computer, ...meta });
            const state: SharingRow["state"] =
                person.sessions?.includes(String(id)) === true
                    ? "invited"
                    : starter === person.id
                      ? "started"
                      : meta.sharedWith?.includes(person.id) === true &&
                          !app.config.leaving(meta.runner ?? THIS_SERVER).includes(person.id)
                        ? "shared"
                        : app.seesByFolder(person, id)
                          ? "folder"
                          : app.policy.mayUse(person, computer)
                            ? "none"
                            : "blocked";
            const by = state === "shared" ? named(meta.sharedBy?.[person.id]) : undefined;

            return [
                {
                    id: row.id,
                    title: meta.title ?? "New session",
                    computer,
                    computerName: name,
                    cwd: meta.cwd,
                    folder: app.folderOf(id)?.path ?? meta.cwd,
                    updatedAt: meta.updatedAt,
                    ...(row.usedAt === undefined ? {} : { usedAt: row.usedAt }),
                    starter: named(starter) ?? { id: starter, name: "someone" },
                    state,
                    // One they have by its folder can be shared with them as well: it stays when the folder goes.
                    give: row.mayShare === true && (state === "none" || state === "folder"),
                    // A share ends for who made it, the session's starter, and who is in charge of its computer
                    // (`mayUnshare`); one they started, or were invited to alone, only for who is in charge
                    // (`app.ts` `revokeSession`).
                    take:
                        state === "shared"
                            ? app.policy.mayUnshare(user, String(id), person.id)
                            : mine && (state === "started" || state === "invited"),
                    ...(by === undefined ? {} : { by }),
                    ...(state === "blocked"
                        ? {
                              reason:
                                  person.sessions === undefined
                                      ? `cannot use ${name}`
                                      : "invited to one session only",
                          }
                        : {}),
                },
            ];
        });

        const places = [THIS_SERVER, ...app.config.runners.map((each) => each.id)];
        const computers = places.flatMap((id): SharingComputer[] => {
            if (
                app.policy.inCharge(user, id) ||
                app.policy.inCharge(person, id) ||
                !app.policy.mayUse(user, id)
            ) {
                return [];
            }

            const theirs = app.config.givenFolders(id, person.id);
            const sees = app.config.seenFolders(id, person.id);
            const givers = app.config.givenBy(id, person.id);
            const mine = app.policy.reshares(user, id)
                ? (app.policy.givenFolders(user, id) ?? [])
                : [];
            const paths = [
                ...new Set([...mine, ...theirs.filter((each) => givers[each] === user.id)]),
            ];

            if (paths.length === 0) {
                return [];
            }

            // Folders are for someone who uses the computer already, a viewer too, to read: who uses a computer is
            // its one in charge's choice. A user gets one to start sessions in.
            const uses = app.policy.mayUse(person, id) && person.sessions === undefined;

            return [
                {
                    id,
                    name: placed(id),
                    ...(uses
                        ? {}
                        : {
                              reason:
                                  person.sessions !== undefined
                                      ? `${person.name} is invited to one session only.`
                                      : `${person.name} cannot use ${placed(id)}. Whoever is in charge of it chooses who uses it.`,
                          }),
                    folders: paths.map((path) => {
                        const has = theirs.includes(path);
                        const on = has && sees.includes(path);
                        const by = has ? named(givers[path]) : undefined;
                        const level = app.config.folderLevel(id, person.id, path);

                        return {
                            path,
                            has,
                            sees: on,
                            give: !has && uses && app.policy.mayGiveFolder(user, id, path),
                            take: has && app.policy.mayTakeFolder(user, id, person.id, path),
                            see: has && app.policy.maySetSees(user, id, person.id, path, !on),
                            ...(by === undefined ? {} : { by }),
                            level,
                            // The Access menu offers the levels it can be set to, and the one it has.
                            levels: FOLDER_LEVELS.filter(
                                (each) =>
                                    each === level ||
                                    app.policy.maySetLevel(user, id, person, path, level, each),
                            ),
                        };
                    }),
                },
            ];
        });

        return {
            person: { id: person.id, name: person.name },
            sessions,
            charge: [...charge].map(([id, name]) => ({ id, name })),
            computers,
            shareNew: places
                .filter((id) => app.policy.mayShareNew(user, id, person))
                .map((id) => ({
                    id,
                    name: placed(id),
                    on: app.config.sharesNew(id, user.id).includes(person.id),
                })),
        };
    }

    /**
     * `user` shares the sessions in `share` with `personId`, and takes the ones in `revoke` back, each alone: one that is
     * refused (not theirs to share, a person who cannot use its computer) is named in `refused` with the reason, and the
     * others are done. Sharing is `shareSession`'s, for that one person, with the others it is shared with left as they
     * are at that moment. Taking back is `app.ts` `revokeSession` for who is in charge of the session's computer (also
     * one they started, or were invited to alone); anyone else ends only a share, and only one that is theirs to end
     * (`access.ts` `mayUnshare`: they started the session, or made that share).
     */
    async shareWith(
        user: User,
        personId: string,
        body: { share?: unknown; revoke?: unknown } | null,
    ): Promise<{
        person: { id: string; name: string };
        sessions: SharingRow[];
        charge: { id: string; name: string }[];
        computers: SharingComputer[];
        shareNew: { id: string; name: string; on: boolean }[];
        refused: { id: number; reason: string }[];
    }> {
        const app = this.#app;
        const person = this.#sharee(user, personId);

        const ids = (value: unknown, name: string): ConversationId[] => {
            if (value === undefined) {
                return [];
            }

            if (
                !Array.isArray(value) ||
                value.length > 500 ||
                !value.every((each) => Number.isInteger(each) && each >= 0)
            ) {
                throw new HttpError(400, `${name} must be a list of session ids.`);
            }

            return [...new Set(value as number[])] as unknown as ConversationId[];
        };

        const share = ids(body?.share, "share");
        const revoke = ids(body?.revoke, "revoke");

        if (share.length + revoke.length === 0) {
            throw new HttpError(400, "Name the sessions to share, or to revoke.");
        }

        if (share.some((each) => revoke.includes(each))) {
            throw new HttpError(400, "A session is either shared or revoked, not both.");
        }

        const refused: { id: number; reason: string }[] = [];
        const place = (meta: SessionMeta): string =>
            meta.runner === undefined ? "this server" : app.runners.name(meta.runner);

        const each = async (id: ConversationId, change: () => Promise<void>): Promise<void> => {
            try {
                await change();
            } catch (error) {
                if (!(error instanceof HttpError)) {
                    throw error;
                }

                refused.push({ id: Number(id), reason: error.message });
            }
        };

        for (const id of share) {
            await each(id, async () => {
                const { root, meta } = this.#sharable(user, id);
                const computer = meta.runner ?? THIS_SERVER;

                // Theirs already: every session on a computer they are in charge of, one they started, one shared.
                if (
                    app.policy.inCharge(person, computer) ||
                    app.policy.starter({ id: String(root), computer, ...meta }) === person.id ||
                    (meta.sharedWith?.includes(person.id) === true &&
                        !app.config.leaving(meta.runner ?? THIS_SERVER).includes(person.id))
                ) {
                    return;
                }

                const cannot = new HttpError(
                    400,
                    app.policy.inCharge(user, computer)
                        ? `${person.name} cannot use ${place(meta)}: choose them for it first.`
                        : `${person.name} cannot use ${place(meta)}. Whoever is in charge of it chooses who uses it.`,
                );

                if (!app.policy.mayUse(person, computer)) {
                    throw cannot;
                }

                const saved = await this.#saveShares(root, user, meta.runner, (now) =>
                    now.includes(person.id) ? [...now] : [...now, person.id],
                );

                // No longer chosen for it as it was saved.
                if (!saved.includes(person.id)) {
                    throw cannot;
                }
            });
        }

        for (const id of revoke) {
            await each(id, async () => {
                const { root, meta } = this.#sharable(user, id, person.id);

                if (app.policy.inCharge(user, meta.runner ?? THIS_SERVER)) {
                    await app.revokeSession(user, root, person.id);

                    return;
                }

                if (meta.sharedWith?.includes(person.id) !== true) {
                    throw new HttpError(
                        400,
                        person.sessions?.includes(String(root)) === true
                            ? `Only whoever is in charge of ${place(meta)} can take a session from someone invited to it alone.`
                            : `${person.name} does not have that session from you.`,
                    );
                }

                if (!app.policy.mayUnshare(user, String(root), person.id)) {
                    throw new HttpError(
                        403,
                        `Only whoever shared it with ${person.name}, its starter, or whoever is in charge of ${place(meta)} can take it back.`,
                    );
                }

                await this.#saveShares(root, user, meta.runner, (now) =>
                    now.filter((other) => other !== person.id),
                );
            });
        }

        return { ...this.sharingWith(user, personId), refused };
    }

    /**
     * Rename a session, archive it or bring it back, or set its keep warm time. A new name and a keep warm time are
     * changes of the session's settings: only who drives makes them while people take turns, and a locked session's
     * approval is renewed first (`requireDriver`). Archiving, bringing back, and turning keep warm off stop things and
     * make Pi do nothing: they need the wheel, and never wait for an approval (`requireTurn`). Either way it is saved
     * only for who may still do it then.
     */
    async updateSession(
        id: ConversationId,
        user: User,
        patch: { title?: string; archived?: boolean; keepWarm?: unknown },
    ): Promise<{ repeating: number }> {
        const app = this.#app;

        app.requireSteer(user, id);
        optionalText(patch.title, "title");

        if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
            throw new HttpError(400, "archived must be true or false");
        }

        // A choice that is none is refused before anything waits.
        const warm =
            patch.keepWarm === undefined ? undefined : app.keepWarm.choiceOf(patch.keepWarm);
        const stops = patch.title === undefined && (warm === undefined || app.keepWarm.stops(warm));

        if (stops) {
            await app.requireTurn(id, user);
        } else {
            await app.requireDriver(id, user);
        }

        const before = app.sessionMeta(id);
        // Checked again where it is saved, as the kind of change it is.
        const saving = app.admission(id, user, { stop: stops });
        let warmText: string | undefined;

        await app.commit(async (tx) => {
            const sessions = await app.sessionsIn(tx);
            const meta = sessions.items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            // Check against this commit's choice, before writing any other field. A rejected choice changes nothing.
            if (patch.keepWarm !== undefined) {
                const current = meta.keepWarm;

                app.keepWarm.applyChoice(id, patch.keepWarm, meta, app.policy.keepsWarm(user));
                warmText =
                    meta.keepWarm === current
                        ? undefined
                        : `set keep warm to ${
                              patch.keepWarm === "default"
                                  ? `the default (${keepWarmLabel(app.config.keepWarm.hours)})`
                                  : keepWarmLabel(meta.keepWarm!)
                          }`;
            }

            // A rename moves the session up the list. Archiving does not: brought back, or undone, it returns to where it was.
            if (patch.title !== undefined) {
                meta.title = oneLine(patch.title) || undefined;
                meta.updatedAt = Date.now();
            }

            if (patch.archived !== undefined) {
                meta.archived = patch.archived;
            }
        }, saving);
        const title = patch.title === undefined ? undefined : oneLine(patch.title);

        if (warmText !== undefined) {
            app.cacheKeeper.reconsider(new Set(app.conversationsOf(id)));
            await app.collab.activity(id, user, warmText);
        }

        if (title !== undefined && title !== "" && title !== before?.title) {
            await app.collab.activity(id, user, `renamed the session to “${title}”`);
        }

        if (patch.archived !== undefined && patch.archived !== (before?.archived === true)) {
            await app.collab.activity(
                id,
                user,
                patch.archived
                    ? "archived the session"
                    : "brought the session back from the archive",
            );
        }

        // Archived on another computer: its attached files are removed from that computer's temporary folder. A
        // computer that was removed, or a person who may no longer use it, leaves them: the archive is done either way.
        const runner = patch.archived === true ? app.runnerOf(id) : undefined;

        if (runner !== undefined) {
            try {
                const scope = app.runnerScope(id);

                void clearUploads(app.runners.env(runner, app.cwdOf(id), scope), scope.id);
            } catch {
                // Nothing to clear there.
            }
        }

        // Archiving leaves its repeating schedules running: the person is told how many.
        const repeating =
            patch.archived === true
                ? (await app.schedules.list(id)).filter(
                      (item) => item.every !== undefined && item.paused === undefined,
                  ).length
                : 0;

        return { repeating };
    }

    /**
     * Send a message to Pi as `user`. With `via`, an assistant (PiP) sends it for them: it is marked as sent through it,
     * and is theirs to pay for and steer, but not their own words (`requestFor`). Only server code passes `via`.
     */
    async submit(
        id: ConversationId,
        user: User,
        request: SubmitRequest,
        via?: string,
        admission?: {
            beforeSubmit(): Promise<{ user: User; context: Context }>;
            afterSubmit(): void;
        },
        task?: boolean,
    ): Promise<{ submissionId: SubmissionId; requestId: string }> {
        const app = this.#app;

        app.requireSee(user, id);
        // A task's run follows the session's tasks rule (`app.ts` `tasksMayRun`), not a person's use of it.
        await app.requireDriver(id, user, task);

        // PiP turned off takes nothing, from its person either: it would run without its rules, and be compacted without
        // its own summary (`pip-compact.ts`). What else goes to it (reports, schedules, watches) waits meanwhile.
        if (app.pip.ownerOf(id) !== undefined && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        const conversation = await app.conversation(id);
        const typed = request.text.trim();
        // `/skill:name request` sends the skill with the request; `/name arguments`, Pi's prompt template of that name.
        let expanded = typed;

        if (typed.startsWith("/skill:")) {
            const runner = app.runnerOf(id);

            // A skill on a computer that is offline cannot be read now: the message goes as typed, and Pi finds the skill
            // there when it is back (its skills are in its prompt then).
            if (runner !== undefined && !app.runners.link(runner).online) {
                app.notice(
                    "info",
                    `${app.runners.name(runner)} is offline, so the skill goes as typed. Pi reads it there when the computer is back.`,
                    id,
                );
            } else {
                const { skills, read } = await app.skillsToRun(id);

                expanded = (await expandSkillCommand(typed, skills, read)) ?? typed;
            }
        } else if (typed.startsWith("/")) {
            expanded = expandPromptTemplate(typed, app.promptTemplates(id)) ?? typed;
        }

        // A value an extension hides (`host.hide`), pasted into the message, is never stored nor sent to the model.
        const text = app.hidden.replace(expanded, id);
        const attachments = request.attachments ?? [];

        if (text === "" && attachments.length === 0) {
            throw new HttpError(400, "Nothing to send");
        }

        const agent = await app.agentState(id);
        const model =
            agent?.model === undefined
                ? undefined
                : app.models.getModel(agent.model.provider, agent.model.modelId);

        if (model === undefined) {
            throw new HttpError(409, "Pick a model for this conversation first.");
        }

        app.spend.check(user, id);

        // Most were made ready as they were uploaded (`model-images.ts`); the rest are made side by
        // side, in their order.
        const images = model.input.includes("image")
            ? attachments.filter((file) => forModel(file.mime, file.size))
            : [];
        const made = await Promise.allSettled(
            images.map((file) => modelImage(file.path, file.mime)),
        );
        const placed = this.#placeAttachments(id, attachments);
        // What differs between a file and the image the model gets goes on the file's line.
        const notes = new Map<Attachment, string>();

        made.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value.note !== undefined) {
                notes.set(images[index]!, result.value.note);
            }
        });

        const lines = attachments.map((file, index) => {
            const note = notes.get(file);
            const line = `- ${placed[index]} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`;

            return note === undefined ? line : `${line} ${note}`;
        });
        // The heading whole, with files alone too: what reads the message splits it there.
        const runner = app.runnerOf(id);
        const heading = attachmentsHeading(
            runner === undefined || app.runners.system(runner) === undefined
                ? undefined
                : app.runners.name(runner),
        );
        const written = lines.length === 0 ? text : `${text}${heading}${lines.join("\n")}`;
        const body = this.messageText(
            user,
            via === undefined ? written : `[via ${via}] ${written}`,
        );
        const about = this.#aboutSession(id, user, request.about);
        const mentioned =
            request.inlineFiles === true
                ? await this.#mentionedFiles(id, user, typed, model.input.includes("image"))
                : [];
        // A file's text that a message brings along hides what extensions hide (`host.hide`), as the message does.
        const parts: (TextContent | ImageContent)[] = [
            { type: "text", text: body },
            ...mentioned.map((part) =>
                part.type === "text" ? { ...part, text: app.hidden.replace(part.text, id) } : part,
            ),
            ...(about === undefined ? [] : [{ type: "text" as const, text: about }]),
        ];

        made.forEach((result, index) => {
            if (result.status === "fulfilled") {
                parts.push(result.value.image);
            } else {
                app.notice(
                    "warning",
                    `Could not attach ${images[index]!.name}: ${describe(result.reason)}`,
                    id,
                );
            }
        });

        const content = parts.length === 1 ? body : parts;
        const requestId =
            via === undefined
                ? ownRequest(user.id, clientKey(request.requestId))
                : requestFor(user.id, clientKey(request.requestId));
        // A failed subagent's failure as the person writes to it: what their message comes to settles it.
        const failure = await this.#failureOf(id);

        // Checked at the top, then prepared (the skill, the files, the model's images): where the message is saved, the
        // person must still see and steer the session, have the wheel, and its approval be live (`app.ts` `admission`).
        const how = task === true ? { task } : {};
        let submitContext = app.admission(id, user, how);

        // Human extension starts acquire a short policy lease after preparation. Its context checks policy again
        // when durable admission reaches the mutation line, not just before it joins the queue.
        if (admission !== undefined) {
            const accepted = await admission.beforeSubmit();

            user = accepted.user;
            submitContext = app.admission(id, user, { ...how, parent: accepted.context });
            submitContext.abortSignal?.throwIfAborted();
        }

        // A retry of a request finds its first submission: it is no new message, and no event goes out for it again.
        const known =
            app.pip.ownerOf(id) === undefined &&
            (await app.harness.commit((tx) => tx.submissionByRequest(id, requestId), context)) !==
                undefined;
        // Only a person's own message interrupts, never one sent for them (`via`). The same durable handoff as a
        // queued message's Interrupt keeps everything waiting, before it stops the run. Admission releases its lease
        // once that handoff is stored, not while the task stops the run and puts the messages back.
        const draft = {
            type: "input" as const,
            content,
            whenBusy: request.mode === "steer" ? ("steer" as const) : ("followUp" as const),
            requestId,
        };
        const admitted = await (
            request.mode === "interrupt" && via === undefined
                ? this.#interrupt(id, { content, requestId }, submitContext)
                : this.#submitInput(conversation, draft, user, via, text, known, submitContext)
        ).finally(() => admission?.afterSubmit());
        let submissionId: SubmissionId;

        if ("task" in admitted) {
            if (admitted.started) {
                await app.collab.activity(id, user, "interrupted the run");
            }

            await app.harness.waitForTask(admitted.task, context);
            const sent = await app.harness.commit(
                (tx) => tx.submissionByRequest(id, requestId),
                context,
            );

            if (sent === undefined) {
                throw new HttpError(409, "The Interrupt message could not be sent. Try again.");
            }

            submissionId = sent.id;
        } else {
            submissionId = admitted.submissionId;
        }

        const submission = (await app.harness.submission(submissionId, context))!;

        app.collab.setTyping(id, user, null);
        // The title comes from the message as it was stored: without hidden values.
        const titled = app.hidden.replace(typed, id);

        await this.#touched(
            id,
            titled,
            text === titled ? undefined : text,
            task !== true && via === undefined ? user.id : undefined,
        );
        this.#reportUnanswered(id, submission.wait(context));

        if (failure !== undefined) {
            await this.#followFailure(id, user, failure, requestId);
        }

        // For extensions (`host.on`): once for each message (two retries at once, too), never for PiP's conversation,
        // which is its person's alone.
        if (app.pip.ownerOf(id) === undefined && !known && this.#announce(submission.id)) {
            app.events.emit("message.sent", {
                conversationId: Number(id),
                by: user.id,
                submissionId: String(submission.id),
                text,
                ...(via === undefined ? {} : { via }),
            });
        }

        return { submissionId: submission.id, requestId };
    }

    /** A retry (`known`) asks no annotator again, and PiP's conversation gets no notes. */
    async #submitInput(
        conversation: Conversation,
        draft: InputSubmissionDraft & { requestId: string },
        user: User,
        via: string | undefined,
        text: string,
        known: boolean,
        submitContext: Context,
    ): Promise<{ submissionId: SubmissionId }> {
        const app = this.#app;
        const noted =
            !known && app.pip.ownerOf(conversation.id) === undefined
                ? await app.turnNotes.submit(
                      conversation,
                      draft,
                      { by: user.id, ...(via === undefined ? {} : { via }), text, at: app.now() },
                      submitContext,
                  )
                : undefined;

        if (noted !== undefined) {
            return { submissionId: noted };
        }

        return { submissionId: (await conversation.submit(draft, submitContext)).id };
    }

    /** Submissions `message.sent` went out for lately: a retry that raced its first try finds its id here. */
    readonly #announced = new Set<string>();

    /** Whether to send `message.sent` for a submission: once only, as far as this process knows. */
    #announce(submissionId: unknown): boolean {
        const key = String(submissionId);

        if (this.#announced.has(key)) {
            return false;
        }

        this.#announced.add(key);

        // The newest few hundred are enough: a retry comes within seconds.
        if (this.#announced.size > 500) {
            this.#announced.delete(this.#announced.values().next().value!);
        }

        return true;
    }

    /** When a subagent (`id`, its conversation) failed, if it is failed now (not stopped); undefined otherwise. */
    async #failureOf(id: ConversationId): Promise<number | undefined> {
        const parent = this.#app.parentOf(id);

        if (parent === undefined) {
            return undefined;
        }

        const agents = (await this.#app.harness.snapshot(SubagentsDoc, parent, context))?.agents;
        const record = Object.values(agents ?? {}).find((each) => each.conversationId === id);

        return record?.failed === true && record.error !== STOPPED
            ? (record.answeredAt ?? 0)
            : undefined;
    }

    /**
     * Follow a person's message (`requestId`) to failed subagent `id` to its end, in a task of its parent's (`followTask`).
     * The message went: a failure to start following it is logged, not answered.
     */
    async #followFailure(
        id: ConversationId,
        user: User,
        failure: number,
        requestId: string,
    ): Promise<void> {
        const app = this.#app;
        const parent = app.parentOf(id);

        if (parent === undefined) {
            return;
        }

        try {
            await app.harness.commit(async (tx) => {
                await tx.createTask(
                    this.followTask,
                    { subagent: Number(id), requestId, failure, by: user.id },
                    {
                        ownership: { kind: "conversation" },
                        background: true,
                        conversationId: parent,
                    },
                );
            }, context);
        } catch (error) {
            app.log(`not following a message to ${String(id)}: ${describe(error)}`);
        }
    }

    /**
     * A person dealt with a failed subagent (`id`, its conversation): seen or dismissed, it needs nobody now, on the
     * board, the rail, or the session list, until it fails again. `at` is the failure they saw (its `answeredAt`): a
     * newer one still needs them, and `newer` says so. Not dismissed either when it has no failure, or someone dealt
     * with it already.
     */
    async dismissSubagent(id: ConversationId, user: User, at: unknown): Promise<Dismissal> {
        const app = this.#app;

        app.requireSteer(user, id);

        if (typeof at !== "number" || !Number.isFinite(at)) {
            throw new HttpError(400, "at must be the time of the failure seen");
        }

        if (app.parentOf(id) === undefined) {
            throw new HttpError(404, "Not a subagent");
        }

        return this.#dismissFailure(id, user, at);
    }

    /**
     * A person hid a finished subagent (`id`, its conversation) from its parent's subagents bar, for everyone, or showed
     * it again (`hidden` false: they opened it). `at` is the newest thing they saw it do (its `askedAt` or `answeredAt`):
     * it stays hidden until it does something newer, and one that did already is not hidden, which `newer` says. Hiding
     * a failure deals with it too. Not hidden while it works. The board and Pi see it as before.
     */
    async hideSubagent(
        id: ConversationId,
        user: User,
        hidden: unknown,
        at: unknown,
    ): Promise<Hiding> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (typeof hidden !== "boolean") {
            throw new HttpError(400, "hidden must be true or false");
        }

        if (hidden && (typeof at !== "number" || !Number.isFinite(at))) {
            throw new HttpError(400, "at must be the time of the newest thing seen");
        }

        const parent = app.parentOf(id);

        if (parent === undefined) {
            throw new HttpError(404, "Not a subagent");
        }

        if (hidden && app.isBusy(id)) {
            return { hidden: false };
        }

        const answer = await app.harness.commit(async (tx): Promise<Hiding> => {
            const agents = (await tx.doc(SubagentsDoc, parent)).agents;
            const record = Object.values(agents).find((each) => each.conversationId === id);

            if (record === undefined) {
                return { hidden: false };
            }

            if (!hidden) {
                delete record.hiddenAt;

                return { hidden: false };
            }

            if (newestOf(record) !== at) {
                return { hidden: false, newer: true };
            }

            record.hiddenAt = at;

            return {
                hidden: true,
                ...(record.failed === true ? { failure: record.answeredAt ?? 0 } : {}),
            };
        }, context);

        // A failure hidden needs nobody either; a stop has no failure to deal with, and `#dismissFailure` knows it.
        if (answer.failure !== undefined) {
            await this.#dismissFailure(id, user, answer.failure);
        }

        return { hidden: answer.hidden, ...(answer.newer ? { newer: true } : {}) };
    }

    /**
     * Mark a subagent's failure, the one at `at`, dealt with by `user`, as the parent's activity says: as
     * `dismissSubagent` answers.
     */
    async #dismissFailure(id: ConversationId, user: User, at: number): Promise<Dismissal> {
        const parent = this.#app.parentOf(id);
        let name: string | undefined;

        if (parent === undefined) {
            return { dismissed: false };
        }

        const answer = await this.#app.harness.commit(async (tx): Promise<Dismissal> => {
            const agents = (await tx.doc(SubagentsDoc, parent)).agents;

            name = Object.keys(agents).find((each) => agents[each]!.conversationId === id);
            const record = name === undefined ? undefined : agents[name]!;
            // Its failure is known by when it failed; a failure from before that was recorded has none.
            const failure = record?.answeredAt ?? 0;

            if (
                record === undefined ||
                record.failed !== true ||
                record.error === STOPPED ||
                record.dealtAt === failure
            ) {
                return { dismissed: false };
            }

            if (at !== failure) {
                return { dismissed: false, newer: true };
            }

            record.dealtAt = failure;

            return { dismissed: true };
        }, context);

        if (answer.dismissed && name !== undefined) {
            await this.#app.collab.activity(parent, user, dealtWith(name));
        }

        return answer;
    }

    /**
     * For a message to PiP that asks about a passage: which session it came from, for PiP alone (`CONTEXT_BLOCK`). Only
     * a session its person may see, and never another PiP; nothing for a message to anyone else.
     */
    #aboutSession(
        id: ConversationId,
        user: User,
        about: SubmitRequest["about"],
    ): string | undefined {
        const app = this.#app;

        if (about === undefined) {
            return undefined;
        }

        const session = typeof about === "object" && about !== null ? about.session : undefined;

        if (app.pip.ownerOf(id) === undefined) {
            throw new HttpError(400, "Only a message to PiP says which session it is about");
        }

        if (typeof session !== "number" || !Number.isSafeInteger(session) || session <= 0) {
            throw new HttpError(400, "about.session must be a session's number");
        }

        const target = session as unknown as ConversationId;
        const meta = app.sessionMeta(target);

        if (meta === undefined || meta.pip !== undefined) {
            throw new HttpError(404, "There is no such session.");
        }

        app.requireSee(user, target);

        // Anyone in that session can name it: no invisible characters carry words past people to PiP.
        const plain = (text: string, max: number) =>
            attribute(snippet(text.replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " "), max));
        const title = plain(app.hidden.replace(meta.title ?? "untitled", target), 120);
        const folder = plain(meta.cwd, 300);

        return [
            `${CONTEXT_BLOCK} session="${session}" title="${title}" folder="${folder}">`,
            `The quoted passage at the start of this message comes from session ${session}.`,
            "Read that session with session_read for more context when the question needs it.",
            "</pocket-context>",
        ].join("\n");
    }

    /**
     * The files a message mentions with `@`, for Pi: text files as `<file>` blocks, as Pi's terminal app sends files
     * given on its command line, and images as images when the model takes them. Only files this person may load
     * through the session; anything else stays a mention, which Pi can read itself.
     */
    async #mentionedFiles(
        id: ConversationId,
        user: User,
        text: string,
        images: boolean,
    ): Promise<(TextContent | ImageContent)[]> {
        const app = this.#app;
        const parts: (TextContent | ImageContent)[] = [];
        let total = 0;

        // Its folder is on another computer: the files are read there. While it is offline, the message goes without
        // them, and Pi reads what it names there with its tools once it is back.
        const runner = app.runnerOf(id);

        if (runner !== undefined) {
            return app.runners.link(runner).online
                ? this.#mentionedThere(id, user, text, images)
                : parts;
        }

        for (const mention of mentionedPaths(text).slice(0, MAX_MENTIONED)) {
            let file: string | undefined;

            for (const candidate of mention.candidates) {
                try {
                    const resolved = app.workspace.readableFile(user, id, candidate);

                    if (statSync(resolved).isFile()) {
                        file = resolved;
                        break;
                    }
                } catch {
                    // Not there, or not this person's to load.
                }
            }

            if (file === undefined) {
                continue;
            }

            try {
                const mime = IMAGE_MIME[extname(file).toLowerCase()];

                if (mime !== undefined) {
                    if (images && statSync(file).size <= MAX_INLINE_IMAGE) {
                        parts.push((await modelImage(file, mime)).image);
                    }

                    continue;
                }

                const view = await viewFile(file);
                const part =
                    view.kind === "text"
                        ? fileBlock(file, view, MAX_MENTIONED_TOTAL - total)
                        : undefined;

                if (part !== undefined) {
                    total += part.length;
                    parts.push(part.part);
                }
            } catch (error) {
                app.notice("warning", `Could not send ${mention.written}: ${describe(error)}`, id);
            }
        }

        return parts;
    }

    /**
     * `#mentionedFiles` for a session on another computer: each file read there, as the person may read it there
     * (`Workspace.remoteFile`), with the same limits. Every mention is looked up side by side, as each is a round trip.
     * The computer offline: one warning, and the message goes without them.
     */
    async #mentionedThere(
        id: ConversationId,
        user: User,
        text: string,
        images: boolean,
    ): Promise<(TextContent | ImageContent)[]> {
        const app = this.#app;
        let unreachable: unknown;

        type Found =
            | { mention: { written: string }; image: { bytes: Uint8Array; mime: string } }
            | { mention: { written: string }; file: string; view: FileView };
        const found = await Promise.all(
            mentionedPaths(text)
                .slice(0, MAX_MENTIONED)
                .map(async (mention): Promise<Found | undefined> => {
                    const mime = IMAGE_MIME[extname(mention.candidates[0]!).toLowerCase()];

                    // Not sent to a model without images: not read either.
                    if (mime !== undefined && !images) {
                        return undefined;
                    }

                    for (const candidate of mention.candidates) {
                        try {
                            const { access, file } = await app.workspace.remoteFile(
                                user,
                                id,
                                candidate,
                            );

                            if (mime !== undefined) {
                                const peek = await access.peek(file, MAX_INLINE_IMAGE);

                                if (peek.kind !== "file") {
                                    continue;
                                }

                                return peek.size <= MAX_INLINE_IMAGE
                                    ? { mention, image: { bytes: peek.bytes, mime } }
                                    : undefined;
                            }

                            const view = await viewFile(file, access);

                            if (view.kind !== "folder" && view.kind !== "other") {
                                return { mention, file, view };
                            }
                        } catch (error) {
                            // Not there, or not this person's to load; or the computer cannot be reached.
                            if (
                                error instanceof Unreachable ||
                                (error instanceof HttpError && error.status === 409)
                            ) {
                                unreachable = error;

                                return undefined;
                            }
                        }
                    }

                    return undefined;
                }),
        );

        if (unreachable !== undefined) {
            app.notice(
                "warning",
                `Could not send the files the message names: ${describe(unreachable)}`,
                id,
            );
        }

        const parts: (TextContent | ImageContent)[] = [];
        let total = 0;

        for (const each of found) {
            if (each === undefined) {
                continue;
            }

            try {
                if ("image" in each) {
                    parts.push((await modelImageOf(each.image.bytes, each.image.mime)).image);
                    continue;
                }

                const part =
                    each.view.kind === "text"
                        ? fileBlock(each.file, each.view, MAX_MENTIONED_TOTAL - total)
                        : undefined;

                if (part !== undefined) {
                    total += part.length;
                    parts.push(part.part);
                }
            } catch (error) {
                app.notice(
                    "warning",
                    `Could not send ${each.mention.written}: ${describe(error)}`,
                    id,
                );
            }
        }

        return parts;
    }

    /**
     * Where Pi finds the files a message brings: here, as uploaded. For a session on another computer, they go to its
     * temporary folder (`<temp>/pi-pocket-uploads/<conversation>/`, with the same names, which `attachedFile` takes back
     * to these), and archiving the session removes them. The message names those paths at once, also while the computer
     * is offline: the copy runs when it is back, and the session's next turn waits for it (`app.uploadsCopied`). A file
     * that could not be copied gets a warning.
     */
    #placeAttachments(id: ConversationId, attachments: readonly Attachment[]): string[] {
        const app = this.#app;
        const runner = app.runnerOf(id);

        if (runner === undefined || attachments.length === 0) {
            return attachments.map((file) => file.path);
        }

        const system = app.runners.system(runner);

        // Not known before the computer first connected with a runner that tells its temporary folder: kept here.
        if (system === undefined) {
            app.notice(
                "warning",
                `${app.runners.name(runner)} has not said where its temporary folder is yet, so Pi cannot open the attached files there. Send them again once it is online.`,
                id,
            );

            return attachments.map((file) => file.path);
        }

        const folder = uploadsFolder(system, app.runnerScope(id).id);

        app.uploadsCopied(
            id,
            copyUploads(
                app.runners.env(runner, app.cwdOf(id), app.runnerScope(id)),
                folder,
                attachments,
            ).then((failed) => {
                if (failed.length > 0) {
                    app.notice(
                        "warning",
                        `Could not copy ${failed.join(", ")} to ${app.runners.name(runner)}: Pi cannot open ${failed.length === 1 ? "it" : "them"} there.`,
                        id,
                    );
                }
            }),
        );

        return attachments.map((file) => uploadedThere(folder, file.path));
    }

    /** A message to Pi as the model gets it: with more than one person on this server, it says who is talking. */
    messageText(user: Pick<User, "name">, text: string): string {
        return this.#app.config.users.length > 1
            ? `[from: ${user.name.replace(/[[\]]/g, "")}] ${text}`
            : text;
    }

    /**
     * A session just got a message: it moves up the list, and its first message names it. A long first message gets a
     * short title written for it afterwards (`titles.ts`), and so does a command (`/skill:name`, a prompt template),
     * whose name says little: written from the command and what it `expanded` to, which says what it asks (a skill's
     * instructions without the paths of its files, which would pull the title toward a folder's name). `by`: the person
     * whose own message it was, not a task's run or another agent's: they used the session now (`docs.ts`
     * `SessionMeta.usedBy`).
     */
    async #touched(
        id: ConversationId,
        text: string,
        expanded?: string,
        by?: string,
    ): Promise<void> {
        if (this.#app.sessionMeta(id) === undefined) {
            return;
        }

        let provisional: string | undefined;

        await this.#app.commit(async (tx) => {
            const meta = (await this.#app.sessionsIn(tx)).items[String(id)];

            if (meta === undefined) {
                return;
            }

            const now = Date.now();

            // The first use kept leaves its starter the last activity before it as theirs (`app.ts` `usedAt`).
            if (by !== undefined && meta.pip === undefined) {
                const starter = this.#app.policy.starter({
                    id: String(id),
                    computer: meta.runner ?? THIS_SERVER,
                    ...meta,
                });

                meta.usedBy = {
                    ...(meta.usedBy ?? (starter === by ? {} : { [starter]: meta.updatedAt })),
                    [by]: now,
                };
            }

            meta.updatedAt = now;

            if (meta.title === undefined && text !== "") {
                meta.title = provisional = text.replace(/\s+/g, " ").slice(0, 80);
            }
        }, context);

        if (provisional !== undefined && (expanded !== undefined || wantsTitle(text))) {
            void writeTitle(
                this.#app,
                id,
                expanded === undefined ? text : `${text}\n\n${unwrapSkill(expanded)}`,
                provisional,
            );
        }
    }

    /**
     * A line in the transcript about something a person did that Pi should know about, such as undoing a file's
     * changes. Pi gets it too, with its next message; while Pi works, it waits for a place in the conversation.
     */
    async note(id: ConversationId, user: User, text: string): Promise<void> {
        const conversation = await this.#app.conversation(id);
        const model = [
            {
                role: "user" as const,
                content: [{ type: "text" as const, text: `[note] ${user.name} ${text}` }],
                timestamp: Date.now(),
            },
        ];

        // The person's, as their messages are: Pi works for them from there.
        await conversation.submit(
            {
                type: "write",
                entry: { kind: NOTE_ENTRY, data: { text, by: user.id, name: user.name }, model },
                requestId: ownRequest(user.id, `note-${randomUUID()}`),
            },
            context,
        );
    }

    /** A message Pi could not answer, other than one someone stopped, shows as an error to the people there. */
    #reportUnanswered(
        id: ConversationId,
        settled: Promise<{ status: string; reason?: string; detail?: unknown }>,
    ): void {
        const app = this.#app;

        void settled.then(
            (result) => {
                if (result.status === "unanswered" && result.reason !== "aborted") {
                    const detail =
                        result.detail === undefined
                            ? ""
                            : `: ${JSON.stringify(result.detail).slice(0, 400)}`;

                    app.notice("error", `No answer (${result.reason})${detail}`, id);
                }
            },
            (error: unknown) => app.notice("error", describe(error), id),
        );
    }

    /**
     * Send the request of a run that waits for a provider's limit now, rather than at its time (`limit-gate.ts`): of
     * this conversation, or of its subagents. The request goes whether or not the limit has cleared: the provider
     * rejects it at no cost, or answers. Who may see and steer the session may. False: nothing there waits.
     */
    async retryLimit(id: ConversationId, user: User): Promise<boolean> {
        const app = this.#app;

        app.requireSteer(user, id);

        let sent = app.limits.retryNow(Number(id));

        for (const wait of app.limits.waits()) {
            if (app.rootOf(wait.conversationId as unknown as ConversationId) === id) {
                sent = app.limits.retryNow(wait.conversationId) || sent;
            }
        }

        if (sent) {
            await app.collab.activity(id, user, "tried again without waiting for the limit");
        }

        return sent;
    }

    /** Stop the run. Anyone who can steer may, even while someone else drives: stopping is the safe direction. */
    async abort(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSteer(user, id);
        const conversation = await app.conversation(id);
        const busy = app.isBusy(id);
        // People's waiting messages are held, before the stop can withdraw them: they wait until someone sends them. PiP's
        // panel has no place to show them, so a Stop there withdraws them, as before.
        const held = app.pip.ownerOf(id) === undefined ? await this.#hold(id) : 0;

        // Subagents' reports go: a person meant the work stopped.
        await this.#discardReports(id);
        await this.#stoppedByPerson(id);
        void conversation
            .abort(context)
            .catch((error: unknown) => app.notice("error", `Abort failed: ${describe(error)}`, id));

        if (busy || held > 0) {
            await app.collab.activity(
                id,
                user,
                held === 0
                    ? "stopped the run"
                    : `stopped the run; ${held} queued ${held === 1 ? "message waits" : "messages wait"} to be sent`,
            );
        }
    }

    /** A subagent a person stops: its report to its parent says a person did, not that it failed. */
    async #stoppedByPerson(id: ConversationId): Promise<void> {
        const parent = this.#app.parentOf(id);

        if (parent === undefined || !this.#app.isBusy(id)) {
            return;
        }

        await this.#app.harness.commit(async (tx) => {
            const agents = (await tx.doc(SubagentsDoc, parent)).agents;
            const name = Object.keys(agents).find((each) => agents[each]!.conversationId === id);

            if (name !== undefined) {
                agents[name]!.stoppedBy = "person";
            }
        }, context);
    }

    /**
     * Take the queue's messages out of it into `HeldDoc`, in one commit, so the stop that follows cannot withdraw them.
     * Writes stay queued, and a batch of subagents' reports goes back to its courier. How many were held.
     */
    async #hold(id: ConversationId): Promise<number> {
        const app = this.#app;
        // Request ids of the queued messages, from Pi Durable's records: a commit cannot read a submission by its id.
        const requests = new Map<number, string | undefined>();

        for (let attempt = 0; ; attempt++) {
            const queued = (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

            for (const item of queued) {
                if (item.mode !== "write" && !requests.has(Number(item.id))) {
                    const record = await (
                        await app.harness.submission(item.id, context)
                    )?.status(context);

                    requests.set(Number(item.id), record?.requestId);
                }
            }

            const held = await app.harness.commit(async (tx) => {
                const items = (await tx.doc(InboxDoc, id)).items;
                // Every table read comes before the commit's first table write.
                const subagents = await tx.doc(SubagentsDoc, id);
                const batch =
                    subagents.sending === undefined
                        ? undefined
                        : await tx.submissionByRequest(id, subagents.sending.request);
                const now = app.now();
                const taken = new Set<SubmissionId>();
                const adding: HeldMessage[] = [];

                for (const item of items) {
                    if (item.mode === "write" || item.id === batch?.id) {
                        continue;
                    }

                    if (!requests.has(Number(item.id))) {
                        // Queued since the requests were read. Stop must not fail: after a few tries, it goes.
                        if (attempt < 3) {
                            return "again";
                        }

                        continue;
                    }

                    const first = requests.get(Number(item.id));
                    const person = requestPerson(first);

                    taken.add(item.id);
                    adding.push({
                        key: String(item.id),
                        content: copyJson(item.content) as JsonValue,
                        mode: item.mode,
                        // The person is in the request id: the new one keeps it, for who wrote it and whose work it is.
                        requestId:
                            first === undefined
                                ? `held-${String(item.id)}`
                                : `${first.replace(/(~\d+)+$/, "")}~${String(item.id)}`,
                        ...(item.entry === undefined
                            ? {}
                            : { entry: copyJson(item.entry) as JsonValue }),
                        ...(person?.wrote === true ? { by: person.userId } : {}),
                        heldAt: now,
                    });
                }

                if (taken.size === 0) {
                    return 0;
                }

                for (let at = items.length - 1; at >= 0; at--) {
                    if (taken.has(items[at]!.id)) {
                        items.splice(at, 1);
                    }
                }

                for (const item of taken) {
                    tx.settleSubmission(item, { status: "unanswered", reason: "aborted" });
                }

                (await tx.doc(HeldDoc, id)).items.push(...adding);

                return taken.size;
            }, context);

            if (held !== "again") {
                return held;
            }
        }
    }

    /**
     * Send the messages a Stop held, in their order, each as it was queued: they go to Pi as the people who wrote them.
     * Sending them is sending to Pi: it takes the wheel and the spend limit, as a message does. Each keeps its request
     * id, so a retry after a failure sends none twice.
     */
    async sendHeld(id: ConversationId, user: User): Promise<number> {
        const app = this.#app;

        app.requireSteer(user, id);
        await app.requireDriver(id, user);

        if (app.pip.ownerOf(id) !== undefined && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        app.spend.check(user, id);
        const conversation = await app.conversation(id);
        const held = (await app.harness.snapshot(HeldDoc, id, context))?.items ?? [];
        const saving = app.admission(id, user);
        let sent = 0;

        for (const { key } of held) {
            // Each goes in the commit that takes it from the list: one withdrawn meanwhile is not there to send.
            const went = await app.harness.commit(async (tx) => {
                const doc = await tx.doc(HeldDoc, id);
                const item = doc.items.find((each) => each.key === key);

                if (item === undefined) {
                    return false;
                }

                await conversation.submit(tx, {
                    type: "input",
                    content: item.content as unknown as UserInput,
                    whenBusy: item.mode,
                    requestId: item.requestId,
                    ...(item.entry === undefined
                        ? {}
                        : { entry: item.entry as unknown as InputEntry }),
                });
                doc.items = doc.items.filter((each) => each.key !== key);

                return true;
            }, saving);

            sent += went ? 1 : 0;
        }

        if (sent > 0) {
            await app.collab.activity(
                id,
                user,
                `sent the ${sent === 1 ? "held message" : `${sent} held messages`}`,
            );
        }

        return sent;
    }

    /** Take a held message away for good. Anyone may their own; someone else's needs the right to drive, as in the queue. */
    async dropHeld(id: ConversationId, user: User, key: string): Promise<void> {
        const app = this.#app;

        app.requireSteer(user, id);
        const item = await this.#heldItem(id, key);

        // Someone else's: the driver's to drop. It stops work, so it never waits for the session's approval.
        if (item.by !== user.id) {
            await app.requireTurn(id, user);
        }

        await this.#unhold(id, key);

        if (item.by !== undefined && item.by !== user.id) {
            const author = app.config.userById(item.by)?.name ?? "someone";

            await app.collab.activity(id, user, `withdrew ${author}’s held message`);
        }
    }

    /** Take one's own held message back into the message box, as Edit does for a queued one. */
    async editHeld(
        id: ConversationId,
        user: User,
        key: string,
    ): Promise<{ text: string; attachments: Attachment[] }> {
        const app = this.#app;

        app.requireSteer(user, id);
        const item = await this.#heldItem(id, key);

        if (item.by !== user.id) {
            throw new HttpError(403, "Only its sender can edit a held message.");
        }

        await this.#unhold(id, key);
        const [written, files] = splitAttachments(
            userContent({ content: item.content as unknown as UserInput }).text.replace(
                FROM_PREFIX,
                "",
            ),
        );
        const uploads = app.workspace.uploadDirectory(id);

        return {
            text: written,
            attachments: (files ?? "").split("\n").flatMap((line) => attachedFile(line, uploads)),
        };
    }

    async #heldItem(id: ConversationId, key: string): Promise<HeldMessage> {
        const item = (await this.#app.harness.snapshot(HeldDoc, id, context))?.items.find(
            (each) => each.key === key,
        );

        if (item === undefined) {
            throw new HttpError(409, "That message is no longer held.");
        }

        return item;
    }

    async #unhold(id: ConversationId, key: string): Promise<void> {
        const gone = await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(HeldDoc, id);
            const before = doc.items.length;

            doc.items = doc.items.filter((item) => item.key !== key);

            return doc.items.length < before;
        }, context);

        if (!gone) {
            throw new HttpError(409, "That message is no longer held.");
        }
    }

    /**
     * Mark the batch of subagents' reports in `id`'s queue (or, given `submissionId`, only if that is it) as a person's
     * to withdraw: the courier then lets it go instead of sending it again, as it does with one a spend limit's stop
     * withdrew.
     */
    async #discardReports(id: ConversationId, submissionId?: number): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, id);
            const sending = state.sending;

            if (sending === undefined || sending.discarded === true) {
                return;
            }

            if (submissionId !== undefined) {
                const record = await tx.submissionByRequest(id, sending.request);

                if (record === undefined || Number(record.id) !== submissionId) {
                    return;
                }
            }

            state.sending = { ...sending, discarded: true };
        }, context);
    }

    /** Take back a queued message. Anyone may take back their own; someone else's needs the right to drive. */
    async withdraw(id: ConversationId, user: User, submissionId: number): Promise<string> {
        const app = this.#app;

        app.requireSteer(user, id);
        const by = await app.attribution.submitter(submissionId);

        // Someone else's: the driver's to take back. It stops work, so it never waits for the session's approval.
        if (by !== user.id) {
            await app.requireTurn(id, user);
        }

        await this.#discardReports(id, submissionId);
        const result = await app.harness.abortSubmission(
            submissionId as unknown as SubmissionId,
            context,
            id,
        );

        if (by !== undefined && by !== user.id) {
            const author = app.config.userById(by)?.name ?? "someone";

            await app.collab.activity(id, user, `withdrew ${author}’s queued message`);
        }

        return result;
    }

    async editQueued(
        id: ConversationId,
        user: User,
        submissionId: number,
    ): Promise<{ text: string; attachments: Attachment[] }> {
        const app = this.#app;

        app.requireSteer(user, id);

        if (!Number.isInteger(submissionId) || submissionId <= 0) {
            throw new HttpError(400, "Say which queued message to edit.");
        }

        if ((await app.attribution.submitter(submissionId)) !== user.id) {
            throw new HttpError(403, "Only its sender can edit a queued message.");
        }

        const item = (await app.harness.snapshot(InboxDoc, id, context))?.items.find(
            (entry) => Number(entry.id) === submissionId,
        );
        const result =
            item === undefined || item.mode === "write"
                ? "not_found"
                : await app.harness.abortSubmission(
                      submissionId as unknown as SubmissionId,
                      context,
                      id,
                  );

        if (item === undefined || item.mode === "write" || result !== "aborted") {
            throw new HttpError(409, "That message has already gone to Pi.");
        }

        return this.queuedDraft(id, item.content);
    }

    /** What Edit returns, also sent to the sender with the waiting card so the box can show it at once. */
    queuedDraft(
        id: ConversationId,
        content: UserInput,
    ): { text: string; attachments: Attachment[] } {
        // A `/skill:` or prompt template message comes back as it was sent: expanded.
        const [written, files] = splitAttachments(
            userContent({ content }).text.replace(FROM_PREFIX, ""),
        );
        const uploads = this.#app.workspace.uploadDirectory(id);

        return {
            text: written,
            attachments: (files ?? "").split("\n").flatMap((line) => attachedFile(line, uploads)),
        };
    }

    /**
     * Move a queued message to Steer or Queue, or send it now as an Interrupt. Only its sender may, as with taking it
     * back (`withdraw`): who else may move someone's message is left to the maintainers. Interrupt stops the run like
     * the composer's Interrupt, but only this message goes now: the others in the queue, from everyone, stay queued
     * in their order, with their senders and modes (Stop withdraws them; the stop here would, so the task queues them
     * again). Subagents' reports it withdraws wait again for the courier. The message leaves the queue, and the others
     * are noted in the task, in one commit.
     */
    async moveQueued(
        id: ConversationId,
        user: User,
        submissionId: number,
        mode: string,
    ): Promise<void> {
        const app = this.#app;

        app.requireSteer(user, id);

        if (!Number.isInteger(submissionId) || submissionId <= 0) {
            throw new HttpError(400, "Say which queued message to move.");
        }

        if (mode !== "steer" && mode !== "followUp" && mode !== "interrupt") {
            throw new HttpError(400, "Move a message to steer, followUp, or interrupt.");
        }

        // Its sender moves it, as with taking it back: after a restart this process may not know the sender yet.
        if ((await app.attribution.submitter(submissionId)) !== user.id) {
            throw new HttpError(403, "Only its sender can move a queued message.");
        }

        // To the queue, it only waits longer. To Steer or Interrupt, it acts on the run now: that is the driver's turn,
        // as sending is.
        if (mode !== "followUp") {
            await app.requireDriver(id, user);
        }

        if (mode !== "interrupt") {
            const moved = await app.harness.commit(
                async (tx) => {
                    const item = (await tx.doc(InboxDoc, id)).items.find(
                        (entry) => Number(entry.id) === submissionId,
                    );

                    if (item === undefined || item.mode === "write") {
                        return false;
                    }

                    item.mode = mode;

                    return true;
                },
                mode === "followUp" ? context : app.admission(id, user),
            );

            if (!moved) {
                throw new HttpError(409, "That message has already gone to Pi.");
            }

            return;
        }

        await this.#interrupt(
            id,
            { submissionId, requestId: ownRequest(user.id, `interrupt-${submissionId}`) },
            app.admission(id, user),
        );
        await app.collab.activity(id, user, "interrupted the run");
    }

    /** Store an Interrupt and every waiting input together, before stopping only the run seen in this commit. */
    async #interrupt(
        id: ConversationId,
        input: { requestId: string } & ({ content: UserInput } | { submissionId: number }),
        admissionContext: Context = context,
    ): Promise<{ submissionId: SubmissionId } | { task: TaskId; started: boolean }> {
        const app = this.#app;
        const conversation = await app.conversation(id);
        // Request ids of the queued messages, from Pi Durable's records: a commit cannot read a submission by its id.
        const requests = new Map<number, string | undefined>();

        await this.#stoppedByPerson(id);

        for (let attempt = 0; ; attempt++) {
            const queued = (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

            for (const item of queued) {
                if (item.mode !== "write" && !requests.has(Number(item.id))) {
                    const record = await (
                        await app.harness.submission(item.id, context)
                    )?.status(context);

                    requests.set(Number(item.id), record?.requestId);
                }
            }

            const admitted = await app.harness.commit(async (tx) => {
                const known = await tx.submissionByRequest(id, input.requestId);
                const interrupts = await tx.doc(InterruptsDoc, id);
                const pending = interrupts.pending[input.requestId];

                // The task is the receipt until the actual submission exists. Two concurrent POSTs, and a retry after
                // a restart between stop and send, find that same handoff rather than stopping a newer run.
                if (known !== undefined) {
                    return { submissionId: known.id };
                }

                if (pending !== undefined) {
                    return { task: pending as unknown as TaskId, started: false };
                }

                const items = (await tx.doc(InboxDoc, id)).items;
                const item =
                    "submissionId" in input
                        ? items.find((entry) => Number(entry.id) === input.submissionId)
                        : undefined;

                if (item?.mode === "write" || ("submissionId" in input && item === undefined)) {
                    throw new HttpError(409, "That message has already gone to Pi.");
                }

                // Every table read comes before the commit's first table write.
                const subagents = await tx.doc(SubagentsDoc, id);
                const batch =
                    subagents.sending === undefined
                        ? undefined
                        : await tx.submissionByRequest(id, subagents.sending.request);
                const live = await tx.doc(LiveDoc, id);

                if (live.run === undefined && "content" in input) {
                    return {
                        submissionId: await conversation.submit(tx, {
                            type: "input",
                            content: input.content,
                            requestId: input.requestId,
                        }),
                    };
                }

                const others: Requeue[] = [];
                const stay = new Set<SubmissionId>();

                for (const other of items) {
                    // Writes stay in the queue by themselves; the reports go back to their courier when withdrawn.
                    if (other.id === item?.id || other.mode === "write" || other.id === batch?.id) {
                        continue;
                    }

                    if (!requests.has(Number(other.id))) {
                        // Queued since the requests were read.
                        if (attempt >= 3) {
                            throw new HttpError(409, "The queue is changing; try again.");
                        }

                        return "again";
                    }

                    const first = requests.get(Number(other.id));

                    stay.add(other.id);
                    others.push({
                        content: copyJson(other.content) as UserInput,
                        mode: other.mode,
                        // The person is in the request id: the new one keeps it, for who wrote it and whose work it is.
                        requestId:
                            first === undefined
                                ? `interrupt-${input.requestId}-${others.length}`
                                : `${first.replace(/(~\d+)+$/, "")}~${other.id}`,
                        ...(other.entry === undefined
                            ? {}
                            : { entry: copyJson(other.entry) as InputEntry }),
                    });
                }

                const content =
                    "content" in input ? input.content : (copyJson(item!.content) as UserInput);
                const run = live.run === undefined ? undefined : Number(live.run.taskId);

                // Taken out of the queue here, so the stop's withdrawal cannot reach them: the task puts them back.
                for (let at = items.length - 1; at >= 0; at--) {
                    const queued = items[at]!.id;

                    if (queued === item?.id || stay.has(queued)) {
                        items.splice(at, 1);
                    }
                }

                if (item !== undefined) {
                    tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
                }

                for (const taken of stay) {
                    tx.settleSubmission(taken, {
                        status: "unanswered",
                        reason: "aborted",
                    });
                }

                const task = await tx.createTask(
                    this.interruptTask,
                    {
                        content,
                        requestId: input.requestId,
                        ...(item?.entry === undefined
                            ? {}
                            : { entry: copyJson(item.entry) as InputEntry }),
                        ...(run === undefined ? {} : { run }),
                        others,
                    },
                    { ownership: { kind: "conversation" }, background: true, conversationId: id },
                );

                interrupts.pending[input.requestId] = Number(task);

                return { task, started: true };
            }, admissionContext);

            if (admitted !== "again") {
                return admitted;
            }
        }
    }

    async configure(
        id: ConversationId,
        user: User,
        request: {
            model?: { provider: string; modelId: string };
            thinkingLevel?: string;
            cwd?: string;
            pipPanel?: boolean;
        },
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (request.pipPanel === true && app.pip.ownerOf(id) !== user.id) {
            throw new HttpError(403, "Only your own PiP can use this control.");
        }

        const asked = request.model as { provider?: unknown; modelId?: unknown } | undefined;

        checkModel(asked);

        if (
            optionalText(request.thinkingLevel, "thinkingLevel") !== undefined &&
            !isThinkingLevel(request.thinkingLevel)
        ) {
            throw new HttpError(400, `thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
        }

        optionalText(request.cwd, "cwd");

        // A move picks another folder of the session's computer: only who may start sessions there may, as for a new
        // one. Anyone else sees files in its folder only: moving it would move what they see.
        if (request.cwd !== undefined && !app.policy.mayStartThere(user, String(id))) {
            throw new HttpError(
                403,
                app.config.userById(user.id)?.sessions === undefined
                    ? "Only people who may start sessions on this computer can move a session to another folder."
                    : "You were invited to one session and cannot move it to another folder.",
            );
        }

        if (request.cwd !== undefined) {
            app.requireWorkspaceOwner(user, request.cwd);
        }

        // 404 when it does not exist.
        await app.conversation(id);

        const current = await app.agentState(id);
        const ref = request.model ?? current?.model;
        const model =
            ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

        if (request.model !== undefined && model === undefined) {
            throw new HttpError(
                400,
                `Unknown model ${request.model.provider}/${request.model.modelId}`,
            );
        }

        // A model picked with no level takes the level Pi's TUI keeps for it; PiP's panel keeps its own.
        const remembered =
            request.model === undefined ||
            request.thinkingLevel !== undefined ||
            request.pipPanel === true
                ? undefined
                : rememberedLevel(
                      piGlobalSettings(app.defaultCwd),
                      request.model.provider,
                      request.model.modelId,
                  );
        const wanted = (request.thinkingLevel ??
            remembered ??
            current?.thinkingLevel ??
            "off") as ModelThinkingLevel;
        const thinkingLevel = model === undefined ? wanted : clampThinkingLevel(model, wanted);
        const runner = app.runnerOf(id);

        // A new folder on a computer is like a new session there: only the people who may start sessions on it.
        if (runner !== undefined && request.cwd !== undefined) {
            app.policy.requireStart(user, runner);
        }

        const cwd =
            request.cwd === undefined
                ? undefined
                : runner === undefined
                  ? await app.resolveCwd(request.cwd)
                  : await app.runners.checkFolder(runner, request.cwd);

        let moving: Approved | undefined;

        // Moving to another folder: one given to them, under the session's own approval (renewed first when locked).
        if (
            cwd !== undefined &&
            app.workspaceScheme(cwd) === undefined &&
            cwd !== (current?.cwd ?? app.cwdOf(id))
        ) {
            moving = await app.approveFrom(user, id, cwd, runner);
        }

        // Where the change is saved: they still drive the session, and the new folder is still theirs.
        const saving = app.admission(id, user, moving === undefined ? {} : { also: moving.check });

        const change = {
            ...(request.model === undefined
                ? {}
                : { model: { provider: request.model.provider, modelId: request.model.modelId } }),
            thinkingLevel,
            ...(cwd === undefined ? {} : { cwd }),
        };

        // Who had the session by its folder alone and loses it by this move, with the tasks they hand over.
        let handed: [string, Map<string, string>][] = [];

        // One save: where Pi works and the session's record of it change together. Access is judged by the record, so
        // nothing that cuts a move short leaves a session judged by a folder it no longer works in.
        await app.commit(async (tx) => {
            if (request.pipPanel === true) {
                // Check and save together: a turn may have started while the picker was open.
                const live = await tx.doc(LiveDoc, id);

                if (live.run !== undefined || (live.compactions?.length ?? 0) > 0) {
                    throw new HttpError(409, "PiP is working. Change its model when it is idle.");
                }

                Object.assign(await tx.doc(AgentDoc, id), change);
            } else {
                await configureAgent(tx, id, change);
            }

            if (cwd !== undefined) {
                const sessions = await app.sessionsIn(tx);
                const meta = sessions.items[String(id)];

                if (meta !== undefined) {
                    meta.cwd = cwd;
                    // Moved out of a folder someone accesses all sessions in, it leaves them: the tasks they set up
                    // on it go to who is in charge of its computer, in this same save (`app.ts` `handMoved`).
                    handed = await app.handMoved(tx, sessions, String(id));
                }
            }
        }, saving);

        for (const [person, lost] of handed) {
            app.worksFor(person, lost);
        }

        if (cwd !== undefined && app.sessionMeta(id) !== undefined) {
            app.folderApprovals.moved(String(app.rootOf(id)), cwd);
            void this.recordRepo(id, cwd);
        }

        if (ref !== undefined && request.pipPanel !== true) {
            app.config.lastModel = { provider: ref.provider, modelId: ref.modelId, thinkingLevel };
        }

        const changes: string[] = [];
        const modelChanged =
            request.model !== undefined &&
            (request.model.provider !== current?.model?.provider ||
                request.model.modelId !== current?.model?.modelId);

        if (modelChanged) {
            changes.push(`switched the model to ${model?.name ?? request.model!.modelId}`);
        }

        if (
            request.thinkingLevel !== undefined &&
            thinkingLevel !== (current?.thinkingLevel ?? "off")
        ) {
            changes.push(`set thinking to ${thinkingLevel}`);
        }

        if (cwd !== undefined && cwd !== current?.cwd) {
            changes.push(`moved the session to ${homePath(cwd)}`);
        }

        if (changes.length > 0) {
            await app.collab.activity(id, user, changes.join(" and "));
        }
    }

    /** Start a new context: Pi no longer sees what came before, though everyone still can. An optional note carries over. */
    async reset(id: ConversationId, user: User, note: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const handoff = optionalText(note, "note")?.trim() || undefined;

        if (handoff !== undefined && handoff.length > MAX_HANDOFF) {
            throw new HttpError(413, `Handoff notes are limited to ${MAX_HANDOFF} characters`);
        }

        await (await app.conversation(id)).reset(handoff, app.admission(id, user));
        // The next request starts from nothing: the cache kept warm is not read again.
        app.cacheKeeper.forget(Number(id), "a new context started");
        await app.collab.activity(
            id,
            user,
            handoff === undefined
                ? "started a new context"
                : "started a new context with a handoff note",
        );
    }

    /**
     * Set what Pi is told in every request of a session, after its own system prompt: ground rules everyone here shares.
     * Empty text clears them. Subagents keep theirs: they say who the subagent is.
     */
    async setInstructions(id: ConversationId, user: User, text: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions have instructions for Pi");
        }

        const instructions = (optionalText(text, "instructions") ?? "").trim();

        if (instructions.length > MAX_INSTRUCTIONS) {
            throw new HttpError(413, `Instructions are limited to ${MAX_INSTRUCTIONS} characters`);
        }

        const before = (await app.agentState(id))?.instructions ?? "";

        if (instructions === before) {
            return;
        }

        await (
            await app.conversation(id)
        ).configure(
            { instructions: instructions === "" ? null : instructions },
            app.admission(id, user),
        );
        await app.collab.activity(
            id,
            user,
            instructions === ""
                ? "cleared the instructions for Pi"
                : "changed the instructions for Pi",
        );
    }

    /** Turn plan mode on or off: while it is on, Pi reads and proposes a plan, and anything that changes something is blocked. */
    async setPlan(id: ConversationId, user: User, on: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (typeof on !== "boolean") {
            throw new HttpError(400, "on must be true or false");
        }

        this.#requireSession(id);

        if (on && !app.loader.extensionNames().includes(PLAN_EXTENSION)) {
            throw new HttpError(409, "Plan mode is turned off in Extensions.");
        }

        if (await this.#switchPlan(id, user, on)) {
            await app.collab.activity(
                id,
                user,
                on ? "turned on plan mode" : "turned off plan mode",
            );
        }
    }

    /** Approve Pi's plan: plan mode goes off, and Pi is told to carry the plan out. */
    async approvePlan(id: ConversationId, user: User): Promise<{ submissionId: SubmissionId }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        this.#requireSession(id);

        if (!(await this.#switchPlan(id, user, false))) {
            throw new HttpError(409, "Plan mode is not on.");
        }

        await app.collab.activity(id, user, "approved the plan");

        return this.submit(id, user, { text: PLAN_APPROVED, requestId: randomUUID() });
    }

    /** Plan mode is set for a whole session, not for one of its subagents. */
    #requireSession(id: ConversationId): void {
        if (this.#app.parentOf(id) !== undefined) {
            throw new HttpError(
                400,
                "Plan mode is set for the whole session, in its main conversation.",
            );
        }
    }

    /** Set plan mode for a session and the subagents under it; true when that changed it. */
    #switchPlan(id: ConversationId, user: User, on: boolean): Promise<boolean> {
        return this.#app.harness.commit(
            async (tx) => {
                if ((await tx.doc(PlanDoc, id)).on === on) {
                    return false;
                }

                // Subagents follow their session: one already at work stops changing things too.
                const conversations = [id];

                for (let index = 0; index < conversations.length; index++) {
                    for (const agent of Object.values(
                        (await tx.doc(SubagentsDoc, conversations[index]!)).agents,
                    )) {
                        conversations.push(agent.conversationId);
                    }
                }

                const at = Date.now();

                for (const each of conversations) {
                    Object.assign(await tx.doc(PlanDoc, each), { on, by: user.id, at });
                }

                return true;
            },
            this.#app.admission(id, user),
        );
    }

    /** Set up a message to Pi for later, or on repeat: `when` is when, then what it says (`in 2h check the deploy`). */
    async schedule(
        id: ConversationId,
        user: User,
        request: {
            when?: unknown;
            text?: unknown;
            next?: unknown;
            every?: unknown;
            zone?: unknown;
            compactBefore?: unknown;
        },
    ): Promise<Schedule> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const zone = optionalText(request.zone, "zone");
        const compactBefore = optionalFlag(request.compactBefore, "compactBefore");

        if (zone !== undefined && !knownZone(zone)) {
            throw new HttpError(400, `Unknown time zone ${zone}`);
        }

        // From the Schedules sheet's editor: the text, and when as data, instead of `when` typed in words.
        const given = request.next !== undefined || request.every !== undefined;
        const at = given ? this.#scheduleTime(request) : undefined;

        app.spend.check(user, id);
        const schedule = await app.schedules.add(
            id,
            {
                when: optionalText(request.when, "when") ?? "",
                ...(at === undefined ? {} : { at, text: optionalText(request.text, "text") ?? "" }),
                by: user,
                ...(zone === undefined ? {} : { zone }),
                ...(compactBefore === undefined ? {} : { compactBefore }),
            },
            app.admission(id, user),
        );
        const when =
            schedule.every === undefined
                ? `for ${describeMoment(schedule.next, schedule.zone)}`
                : describeRepeat(schedule.every);

        await app.collab.activity(id, user, `scheduled “${snippet(schedule.text, 60)}” ${when}`);

        return schedule;
    }

    /**
     * Change a scheduled message: its text, and when it goes out: `next` (a moment) for one that goes out once, `every`
     * for a repeat (with `next` its first time, for one every so many minutes), in `zone`.
     */
    async updateSchedule(
        id: ConversationId,
        user: User,
        scheduleId: string,
        request: {
            text?: unknown;
            next?: unknown;
            every?: unknown;
            zone?: unknown;
            version?: unknown;
            compactBefore?: unknown;
        },
    ): Promise<Schedule> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const zone = optionalText(request.zone, "zone");
        const version = optionalText(request.version, "version");
        const compactBefore = optionalFlag(request.compactBefore, "compactBefore");

        if (zone !== undefined && !knownZone(zone)) {
            throw new HttpError(400, `Unknown time zone ${zone}`);
        }

        const at = this.#scheduleTime(request);

        app.spend.check(user, id);
        const schedule = await app.schedules.update(
            id,
            scheduleId,
            {
                text: optionalText(request.text, "text") ?? "",
                ...at,
                ...(zone === undefined ? {} : { zone }),
                ...(version === undefined ? {} : { version }),
                ...(compactBefore === undefined ? {} : { compactBefore }),
                by: user,
            },
            // Where it is saved: they still drive that session, its approval live.
            app.admission(id, user),
        );
        const when =
            schedule.every === undefined
                ? `for ${describeMoment(schedule.next, schedule.zone)}`
                : describeRepeat(schedule.every);

        await app.collab.activity(
            id,
            user,
            `changed the scheduled “${snippet(schedule.text, 60)}” to ${when}`,
        );

        return schedule;
    }

    /** A schedule's time as the editor sends it, its repeat checked: `next` (a moment), `every` (a repeat), or both. */
    #scheduleTime(request: { next?: unknown; every?: unknown }): {
        next?: number;
        every?: Repeat;
    } {
        if (request.next !== undefined && typeof request.next !== "number") {
            throw new HttpError(400, "next must be a time in milliseconds");
        }

        try {
            return {
                ...(request.next === undefined ? {} : { next: request.next }),
                ...(request.every === undefined || request.every === null
                    ? {}
                    : {
                          every: checkRepeat(request.every, {
                              repeatMinutes: this.#app.schedules.limits.repeatMinutes,
                          }),
                      }),
            };
        } catch (error) {
            throw new HttpError(400, describe(error));
        }
    }

    /**
     * Pause a scheduled message, or resume it: paused, it sends nothing until someone resumes it. Pausing stops work,
     * so it never waits for the session's approval (`requireTurn`); resuming makes Pi work again, so its approval is
     * live or renewed first (`requireDriver`), and it is saved only for who still drives the session.
     */
    async pauseSchedule(
        id: ConversationId,
        user: User,
        scheduleId: string,
        paused: unknown,
    ): Promise<Schedule> {
        const app = this.#app;

        app.requireSee(user, id);

        if (typeof paused !== "boolean") {
            throw new HttpError(400, "paused must be true or false");
        }

        if (paused) {
            await app.requireTurn(id, user);
        } else {
            await app.requireDriver(id, user);
            app.spend.check(user, id);
        }

        const { schedule, changed } = await app.schedules.pause(
            id,
            scheduleId,
            paused,
            user,
            paused ? undefined : app.admission(id, user),
        );

        if (changed) {
            await app.collab.activity(
                id,
                user,
                `${paused ? "paused" : "resumed"} the scheduled “${snippet(schedule.text, 60)}”`,
            );
        }

        return schedule;
    }

    /** Cancel a scheduled message. Stopping work: it never waits for the session's approval (`requireTurn`). */
    async cancelSchedule(id: ConversationId, user: User, scheduleId: string): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireTurn(id, user);
        const schedule = await app.schedules.cancel(id, scheduleId);

        if (schedule === undefined) {
            throw new HttpError(404, "No such scheduled message");
        }

        await app.collab.activity(
            id,
            user,
            `cancelled the scheduled “${snippet(schedule.text, 60)}”`,
        );
    }

    /** Watch the session's pull request (its branch's, or `pr`): Pi hears of failed checks, conflicts, and reviews. */
    async watchPr(id: ConversationId, user: User, pr: unknown): Promise<{ number: number }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        app.spend.check(user, id);
        const asked = optionalText(pr, "pr");
        // Starting one asks GitHub first, which takes time: it is saved only for who still drives the session.
        const watch = await app.watches.start(
            id,
            user.id,
            asked === undefined ? {} : { pr: asked },
            app.admission(id, user),
        );

        await app.collab.activity(
            id,
            user,
            `started watching PR #${watch.number} “${snippet(watch.title, 60)}”`,
        );

        return { number: watch.number };
    }

    /**
     * Stop watching the session's pull request, or clear a watch that ended. Stopping work: it never waits for the
     * session's approval (`requireTurn`).
     */
    async unwatchPr(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireTurn(id, user);
        const watch = await app.watches.stop(id);

        if (watch?.status === "watching") {
            await app.collab.activity(id, user, `stopped watching PR #${watch.number}`);
        }
    }

    /**
     * The webhooks a person may manage, each with where it sends (a session's title, or PiP), and the address other
     * services reach this server at, when it has a public one.
     */
    async hooks(user: User) {
        const app = this.#app;
        const hooks = (await app.hooks.list(user)).map((hook) => {
            const target = hook.target as unknown as ConversationId;
            const meta = app.sessionMeta(target);

            return {
                ...hook,
                // A session the person can no longer open keeps its title to itself.
                targetTitle:
                    meta?.pip !== undefined
                        ? "PiP"
                        : app.canSee(user, target)
                          ? (meta?.title ?? "New session")
                          : "a session you cannot open",
                pip: meta?.pip !== undefined,
            };
        });

        // Repository watches (`repo-watches.ts`), which PiP sets up: shown with the hooks, to see and remove.
        const repoWatches = (await app.repoWatches.list(user)).map((watch) => {
            const target = watch.target as unknown as ConversationId;
            const meta = app.sessionMeta(target);

            return {
                ...watch,
                targetTitle:
                    meta?.pip !== undefined
                        ? "PiP"
                        : app.canSee(user, target)
                          ? (meta?.title ?? "New session")
                          : "a session you cannot open",
                pip: meta?.pip !== undefined,
            };
        });

        return { hooks, repoWatches, base: app.access?.url ?? null };
    }

    /** Make a webhook that messages a session (or PiP) for this person. */
    async addHook(
        user: User,
        body: {
            target?: unknown;
            name?: unknown;
            instructions?: unknown;
            signed?: unknown;
            anyone?: unknown;
        },
    ) {
        const app = this.#app;
        // "pip": this person's PiP, made now if they have none yet.
        const target =
            body.target === "pip" && app.pip.available(user)
                ? Number(await app.pip.ensure(user))
                : Number(body.target);

        if (!Number.isSafeInteger(target) || target < 0) {
            throw new HttpError(400, "Say which session the webhook messages.");
        }

        const id = target as unknown as ConversationId;
        const hook = await app.hooks.add(user, id, body);

        if (app.sessionMeta(id)?.pip === undefined) {
            await app.collab.activity(id, user, `made the webhook “${snippet(hook.name, 60)}”`);
        }

        return hook;
    }

    async removeHook(user: User, hookId: string): Promise<void> {
        const app = this.#app;
        const hook = await app.hooks.remove(user, hookId);
        const target = hook.target as unknown as ConversationId;

        // No line where the remover can no longer go.
        if (
            app.sessionMeta(target) !== undefined &&
            app.sessionMeta(target)?.pip === undefined &&
            app.canSee(user, target)
        ) {
            await app.collab.activity(
                target,
                user,
                `removed the webhook “${snippet(hook.name, 60)}”`,
            );
        }
    }

    /** Pi keeps working until `command` passes, checked after each of its answers. */
    async setGoal(id: ConversationId, user: User, command: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can have a goal");
        }

        const goal = await app.goals.set(
            id,
            user.id,
            optionalText(command, "command") ?? "",
            app.admission(id, user),
        );

        await app.collab.activity(
            id,
            user,
            `set a goal: keep going until \`${snippet(goal.command, 80)}\` passes`,
        );
    }

    /** Drop the goal: Pi stops checking. Anyone who can steer may, as with stopping a run. */
    async clearGoal(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSteer(user, id);
        const goal = await app.goals.get(id);

        if (!(await app.goals.clear(id)) || goal === undefined) {
            return;
        }

        if (goal.status === "working") {
            await app.collab.activity(
                id,
                user,
                `dropped the goal \`${snippet(goal.command, 80)}\``,
            );
        }
    }

    /**
     * Copy a session up to one of Pi's replies (`entryId`), or up to its latest. `place` says where the copy runs and
     * with which model (`CopyPlaceRequest`); without it, as the session does.
     */
    async fork(
        id: ConversationId,
        user: User,
        request: { entryId?: unknown; worktree?: unknown; place?: unknown },
        signal?: AbortSignal,
    ): Promise<{ id: ConversationId }> {
        this.#requireForkable(id, user);
        const place = checkPlace(request.place);
        const worktree = place?.worktree ?? request.worktree === true;
        const agent = await this.#copyAgent(id, place);

        if (request.entryId === undefined) {
            return {
                id: await this.#branch(
                    id,
                    user,
                    {
                        at: await this.#latestReply(id),
                        label: "fork",
                        worktree,
                        place,
                        ...(agent === undefined ? {} : { agent }),
                    },
                    signal,
                ),
            };
        }

        const entryId = entryIdOf(request.entryId);
        const entry = await this.#app.transcripts.visibleEntry(id, entryId);

        if (entry === undefined) {
            throw new HttpError(404, "No such message");
        }

        // A fork goes on from one of Pi's replies. One that called tools would leave the fork waiting for their results.
        const reply = entry.model?.[0];

        if (
            entry.kind !== "pi.assistant" ||
            (reply?.role === "assistant" && reply.stopReason === "toolUse")
        ) {
            throw new HttpError(400, "Fork from one of Pi's finished replies.");
        }

        return {
            id: await this.#branch(
                id,
                user,
                {
                    at: entryId,
                    label: "fork",
                    worktree,
                    place,
                    ...(agent === undefined ? {} : { agent }),
                },
                signal,
            ),
        };
    }

    /** The model and thinking level a copy gets when its place names them; undefined: the session's. */
    async #copyAgent(
        id: ConversationId,
        place: CopyPlaceRequest | undefined,
    ): Promise<AgentChange | undefined> {
        if (place?.model === undefined && place?.thinkingLevel === undefined) {
            return undefined;
        }

        const source = await this.#app.agentState(id);
        const ref = place.model ?? source?.model;
        const model =
            ref === undefined ? undefined : this.#app.models.getModel(ref.provider, ref.modelId);

        if (place.model !== undefined && model === undefined) {
            throw new HttpError(
                400,
                `Unknown model ${place.model.provider}/${place.model.modelId}`,
            );
        }

        const wanted = (place.thinkingLevel ??
            source?.thinkingLevel ??
            "off") as ModelThinkingLevel;

        return {
            ...(place.model === undefined
                ? {}
                : { model: { provider: place.model.provider, modelId: place.model.modelId } }),
            thinkingLevel: model === undefined ? wanted : clampThinkingLevel(model, wanted),
        };
    }

    /**
     * Send one of this session's messages again in a fork that ends just before it: edited (`text`), or as it was, maybe
     * to another model (`model`). The original stays as it is.
     */
    async resend(
        id: ConversationId,
        user: User,
        request: {
            entryId?: unknown;
            text?: unknown;
            model?: unknown;
            worktree?: unknown;
            place?: unknown;
        },
        signal?: AbortSignal,
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;

        this.#requireForkable(id, user);
        const entryId = entryIdOf(request.entryId);
        const edited = optionalText(request.text, "text")?.trim();
        const place = checkPlace(request.place);

        checkModel(request.model as { provider?: unknown; modelId?: unknown } | undefined);
        const given = (place?.model ?? request.model) as
            { provider: string; modelId: string } | undefined;
        const current = (await app.agentState(id))?.model;
        // The session's own model, named again, is no other model.
        const asked =
            given !== undefined &&
            (given.provider !== current?.provider || given.modelId !== current?.modelId)
                ? given
                : undefined;

        const entry = await app.transcripts.visibleEntry(id, entryId);

        if (entry?.kind !== "pi.user") {
            throw new HttpError(404, "No such message to Pi");
        }

        app.spend.check(user, id);
        const source = await app.agentState(id);
        const ref =
            asked === undefined
                ? source?.model
                : { provider: asked.provider as string, modelId: asked.modelId as string };
        const model =
            ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

        if (ref === undefined || model === undefined) {
            throw new HttpError(
                400,
                ref === undefined
                    ? "Pick a model first."
                    : `Unknown model ${ref.provider}/${ref.modelId}`,
            );
        }

        const original = userContent(entry.model?.[0]);
        // Who sent it comes first, then the heading, whole or (from before 0.14.0) without its blank line.
        const [written, files, heading] = splitAttachments(original.text.replace(FROM_PREFIX, ""));
        // An edit that changes nothing is the same as sending the message again.
        const edit =
            edited !== undefined && edited !== written.trim()
                ? app.hidden.replace(edited, id)
                : undefined;

        if (edit === "" && files === undefined) {
            throw new HttpError(400, "Nothing to send");
        }

        // Sent again, edited or not, the message is from whoever sent it again, with the original's files attached: what
        // Pi does next is on them.
        const body = edit ?? written.trim();
        const text = this.messageText(
            user,
            files === undefined ? body : `${body}${heading ?? ATTACHMENTS_HEADING}${files}`,
        );
        const author =
            (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[String(entryId)] ??
            user.id;
        const images = model.input.includes("image") ? original.images : [];
        const resend: Resend = {
            text,
            by: user.id,
            ...(images.length === 0 ? {} : { images: { entry: entryId as unknown as EntryId } }),
        };

        const previous = (
            await (
                await app.conversation(id)
            ).entries({ maxEntryId: (entryId - 1) as unknown as EntryId }, 1, undefined, context)
        ).items[0];
        const agent: AgentChange = {
            model: ref,
            thinkingLevel: clampThinkingLevel(
                model,
                (place?.thinkingLevel ?? source?.thinkingLevel ?? "off") as ModelThinkingLevel,
            ),
        };
        const label = edit !== undefined ? "edit" : asked !== undefined ? model.name : "retry";
        const forked = await this.#branch(
            id,
            user,
            {
                at: previous?.id as unknown as number | undefined,
                label,
                agent,
                worktree: place?.worktree ?? request.worktree === true,
                place,
                resend,
            },
            signal,
        );
        const submission = await (
            await app.conversation(forked)
        ).submit(
            {
                type: "input",
                content: resendContent(text, images),
                requestId: resendRequest(resend),
            },
            context,
        );
        const whose =
            author === user.id
                ? "a message"
                : `${app.config.userById(author)?.name ?? "someone"}’s message`;
        const line =
            edit !== undefined
                ? "edited a message and sent it again"
                : asked !== undefined
                  ? `sent ${whose} again to ${model.name}`
                  : `sent ${whose} again`;

        await app.collab.activity(forked, user, line, false);
        this.#reportUnanswered(forked, submission.wait(context));

        return { id: forked };
    }

    /** Replace the session with a fork just before its newest message to Pi, and give the message back as a draft. */
    async undo(
        id: ConversationId,
        user: User,
        request: { entryId?: unknown },
    ): Promise<{
        id: ConversationId;
        text: string;
        attachments: Attachment[];
        attachmentsOmitted: boolean;
    }> {
        const app = this.#app;

        this.#requireForkable(id, user);

        // The copy is made in one commit here: one on another computer would need that computer's permission first.
        if (app.runnerOf(id) !== undefined) {
            throw new HttpError(400, "Undo works for sessions on this server only.");
        }

        // It is made as a fork is: only who may start sessions here undoes, not a person invited to one session.
        const starts = () => app.policy.requireStart(user, THIS_SERVER);

        starts();
        await app.requireDriver(id, user);
        const entryId = entryIdOf(request.entryId);

        // Where it is saved: the session is still theirs to steer, with the wheel, its approval live, and they may
        // still start sessions here.
        const saving = app.admission(id, user, { also: starts });
        // Check the queue and newest message on the same commit that makes the fork and archives its source.
        const { forked, entry, wasArchived } = await app.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, id);
            const inbox = await tx.doc(InboxDoc, id);

            if (live.run !== undefined || live.compactions?.length || inbox.items.length > 0) {
                throw new HttpError(
                    409,
                    "Wait for Pi to finish and the queue to empty, or stop it first.",
                );
            }

            const entry = await this.#newestUserMessage(tx, id, entryId as unknown as EntryId);

            if (entry === undefined || Number(entry.id) !== entryId) {
                throw new HttpError(400, "Only the last message to Pi can be undone.");
            }

            const [previous] = (
                await tx.scanEntries(
                    {
                        conversationId: id,
                        maxEntryId: (entryId - 1) as unknown as EntryId,
                    },
                    1,
                )
            ).items;
            const source = (await app.sessionsIn(tx)).items[String(id)];

            if (source === undefined) {
                throw new HttpError(400, "Only sessions can be forked");
            }

            const agent = await tx.doc(AgentDoc, id);
            const cwd = agent.cwd ?? source.cwd;
            const ownership = { kind: "ownerless" } as const;
            const fork =
                previous === undefined
                    ? await tx.createConversation({ ownership })
                    : await tx.forkConversation(id, previous.id, { ownership });
            const next = await tx.doc(AgentDoc, fork.id);

            // A fork normally gets the agent from the fork point. Undo keeps the settings in use now.
            next.cwd = cwd;

            if (agent.model === undefined) {
                delete next.model;
            } else {
                next.model = { ...agent.model };
            }

            if (agent.thinkingLevel === undefined) {
                delete next.thinkingLevel;
            } else {
                next.thinkingLevel = agent.thinkingLevel;
            }

            if (previous === undefined && agent.instructions !== undefined) {
                next.instructions = agent.instructions;
            }

            await this.#initFork(tx, id, user, fork.id, {
                at: previous === undefined ? undefined : Number(previous.id),
                title: source.title,
                cwd,
                worktree: source.worktree === undefined ? undefined : { ...source.worktree },
                // It takes the session's place, so it stays its starter's, shared with the same people.
                keeps: {
                    createdBy: source.createdBy,
                    sharedWith:
                        source.sharedWith === undefined ? undefined : [...source.sharedWith],
                    sharedBy: source.sharedBy === undefined ? undefined : { ...source.sharedBy },
                    usedBy: source.usedBy === undefined ? undefined : { ...source.usedBy },
                },
            });
            const wasArchived = source.archived === true;

            source.archived = true;

            return { forked: fork.id, entry, wasArchived };
        }, saving);

        // Nothing new is given: the session's approval and the people invited to it alone go with it.
        app.replaced(id, forked, user);

        const message = entry.model?.[0];
        const original = userContent(message);
        const [text, files] = splitAttachments(original.text.replace(FROM_PREFIX, ""));
        const attachments: Attachment[] = [];
        const lines = files?.split("\n") ?? [];

        if (lines.length > 0) {
            // An inherited message's uploads belong to the session where the entry was written, and a message sent
            // again keeps the paths of the session it came from. Submit accepts only uploads of the new session, so
            // restore them there rather than loosening that check.
            try {
                const sources = this.#uploadLineage(entry.conversationId, user);
                const to = app.workspace.uploadDirectory(forked);

                for (const line of lines) {
                    for (const from of sources) {
                        const [file] = attachedFile(line, from);

                        if (file === undefined || file.path !== join(from, basename(file.path))) {
                            continue;
                        }

                        const restored = await restoreUpload(file, to);

                        if (restored !== undefined) {
                            attachments.push(restored);
                        }

                        break;
                    }
                }
            } catch {
                // A draft can still be restored if its files are no longer available.
            }
        }

        await app.collab.activity(forked, user, "undid a message", false);

        if (!wasArchived) {
            await app.collab.activity(id, user, "archived the session", false);
        }

        // Inline files not stored as uploads cannot go back as attachments. Mentions remain in the draft text.
        const inlineTextFiles =
            Array.isArray(message?.content) &&
            message.content.some(
                (part, index) =>
                    index > 0 && part.type === "text" && part.text.startsWith(FILE_BLOCK),
            );
        const uploadedImages = attachments.filter((file) => forModel(file.mime, file.size)).length;

        return {
            id: forked,
            text,
            attachments,
            attachmentsOmitted:
                attachments.length < lines.length ||
                inlineTextFiles ||
                original.images.length > uploadedImages,
        };
    }

    /**
     * The upload folders a message of session `id` can name: its own, then each session it was forked from, as long as
     * `user` may see that session.
     */
    #uploadLineage(id: ConversationId, user: User): string[] {
        const app = this.#app;
        const folders: string[] = [];
        const seen = new Set<number>();
        let current: ConversationId | undefined = id;

        while (current !== undefined && !seen.has(Number(current)) && app.canSee(user, current)) {
            seen.add(Number(current));
            folders.push(app.workspace.uploadDirectory(current));
            const parent: number | undefined = app.sessionMeta(current)?.forkedFrom?.id;

            current = parent === undefined ? undefined : (parent as unknown as ConversationId);
        }

        return folders;
    }

    /** Only the newest input can be undone; skip replies, tools and notes after it. */
    async #newestUserMessage(tx: Tx, conversationId: ConversationId, minEntryId: EntryId) {
        let cursor: Cursor | undefined;

        do {
            const page = await tx.scanEntries({ conversationId, minEntryId }, 64, cursor);
            const entry = page.items.find((each) => each.kind === "pi.user");

            if (entry !== undefined) {
                return entry;
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return undefined;
    }

    /** A reply that called tools is not finished: a fork from it would wait for their results. */
    async #latestReply(id: ConversationId): Promise<number | undefined> {
        const conversation = await this.#app.conversation(id);
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries({}, 64, cursor, context);

            for (const entry of page.items) {
                const reply = entry.model?.[0];

                if (
                    entry.kind === "pi.assistant" &&
                    !(reply?.role === "assistant" && reply.stopReason === "toolUse")
                ) {
                    return Number(entry.id);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return undefined;
    }

    /** A computer and a folder on it, as people read them: "Macbook in ~/work/app", "This server in ~/pi-pocket". */
    #where(runner: string | undefined, cwd: string): string {
        if (runner === undefined) {
            return `This server in ${homePath(cwd)}`;
        }

        const home = this.#app.runners.stored(runner)?.platform?.home;
        const short =
            home !== undefined &&
            (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))
                ? `~${cwd.slice(home.length)}`
                : cwd;

        return `${this.#app.runners.name(runner)} in ${short}`;
    }

    /**
     * The repository folder `cwd` is a checkout of, on computer `runner` (undefined: this server), for `SessionMeta.repo`.
     * Undefined when there is none, or the lookup failed or took too long (`repo.ts`): it never fails a session.
     */
    async repoOf(
        runner: string | undefined,
        cwd: string,
        id?: ConversationId,
    ): Promise<string | undefined> {
        try {
            return runner === undefined
                ? await localRepo(cwd)
                : await remoteRepo(
                      this.#app.runners.env(
                          runner,
                          cwd,
                          id === undefined ? undefined : this.#app.runnerScope(id),
                      ),
                      cwd,
                      context,
                  );
        } catch {
            return undefined;
        }
    }

    /**
     * Note session `id`'s repository (`SessionMeta.repo`) for its folder `cwd`, after it was made or moved: in the
     * background, so nothing waits for git. A folder that changed again meanwhile keeps the newer answer.
     */
    recordRepo(id: ConversationId, cwd: string): Promise<void> {
        const app = this.#app;
        const runner = app.sessionMeta(id)?.runner;

        return this.repoOf(runner, cwd, id)
            .then((repo) =>
                app.commit(async (tx) => {
                    const meta = (await app.sessionsIn(tx)).items[String(id)];

                    if (meta === undefined || meta.cwd !== cwd || meta.repo === repo) {
                        return;
                    }

                    if (repo === undefined) {
                        delete meta.repo;
                    } else {
                        meta.repo = repo;
                    }
                }, context),
            )
            .catch((error: unknown) => app.log(`repository of ${cwd}: ${describe(error)}`));
    }

    /**
     * The folder the copy sheet suggests for a copy of session `id` on computer `runner` (null: this server): on the
     * session's own computer, its folder; on another, the folder of the newest session there in the same repository,
     * else of the newest one there in a folder of the same name, else home. Read from the session catalogue only.
     */
    copySuggestion(
        id: ConversationId,
        user: User,
        runner: string | null,
    ): { cwd: string; reason: "current" | "repository" | "name" | "home" } {
        const app = this.#app;

        this.#requireForkable(id, user);
        const meta = app.sessionMeta(id)!;
        const target = runner ?? undefined;

        if (target !== undefined) {
            app.runners.require(target);
        }

        app.policy.requireStart(user, target ?? THIS_SERVER);

        if (target === meta.runner) {
            return { cwd: app.cwdOf(id), reason: "current" };
        }

        const last = (path: string) => path.split(/[\\/]/).findLast((part) => part !== "") ?? "";
        const name = last(app.cwdOf(id)).toLowerCase();
        const there = Object.entries(app.sessionCatalogue())
            .filter(
                ([each, other]) =>
                    other.runner === target &&
                    other.pip === undefined &&
                    each !== String(id) &&
                    app.canSee(user, Number(each) as unknown as ConversationId),
            )
            .map(([, other]) => other)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const same =
            meta.repo === undefined ? undefined : there.find((other) => other.repo === meta.repo);

        if (same !== undefined) {
            return { cwd: same.cwd, reason: "repository" };
        }

        const named =
            name === "" ? undefined : there.find((other) => last(other.cwd).toLowerCase() === name);

        if (named !== undefined) {
            return { cwd: named.cwd, reason: "name" };
        }

        return {
            cwd:
                target === undefined
                    ? homedir()
                    : (app.runners.stored(target)?.platform?.home ?? "~"),
            reason: "home",
        };
    }

    /**
     * Forks are new sessions: who may start one may fork, from a session they can steer. Where the fork goes decides
     * who may start it there (`#destination`, `copySuggestion`).
     */
    #requireForkable(id: ConversationId, user: User): void {
        const app = this.#app;

        app.requireSteer(user, id);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can be forked");
        }

        // The fork works in this session's folder: a remote one is the owner's to start sessions in.
        app.requireWorkspaceOwner(user, app.cwdOf(id));

        // A fork would carry PiP's tools and none of PiP: they act as PiP's person, which a fork is not.
        if (app.sessionMeta(id)?.pip !== undefined) {
            throw new HttpError(400, "PiP's conversation cannot be forked. Start fresh instead.");
        }
    }

    /**
     * Where a copy of session `id` runs: on the computer and in the folder `place` names, else where the session runs.
     * A copy is a new session there: only people who may start sessions on that computer may copy to it (`access.ts`
     * `mayStart`), also from a session shared with them, and the folder must be there. A
     * computer that is gone or offline fails with its name; the copy is never made here instead.
     */
    async #destination(
        id: ConversationId,
        user: User,
        place: CopyPlaceRequest | undefined,
        worktree: boolean,
    ): Promise<Destination> {
        const app = this.#app;
        const meta = app.sessionMeta(id)!;
        const own = { runner: meta.runner, cwd: (await app.agentState(id))?.cwd ?? meta.cwd };
        const runner = place?.runner === undefined ? own.runner : (place.runner ?? undefined);

        if (runner !== undefined && app.runners.stored(runner) === undefined) {
            throw new HttpError(403, "That computer is not linked to this server.");
        }

        // A copy is a new session there: who may start one there may copy to it.
        app.policy.requireStart(user, runner ?? THIS_SERVER);

        const asked = place?.cwd?.trim() || undefined;
        const cwd =
            runner === undefined
                ? app.workspace.checkDirectory(
                      asked ?? (own.runner === undefined ? own.cwd : app.defaultCwd),
                  )
                : asked === undefined && runner === own.runner
                  ? own.cwd
                  : await app.runners.checkFolder(runner, asked ?? "~");
        const moved = runner !== own.runner || cwd !== own.cwd;

        return { runner, cwd, worktree, ...(moved ? { from: own } : {}) };
    }

    /**
     * Start a session from this one's history through entry `at`, or from none of it, named after this one with
     * `label`; in a git worktree of its own when asked.
     */
    async #branch(
        id: ConversationId,
        user: User,
        branch: {
            at: number | undefined;
            label: string;
            agent?: AgentChange;
            worktree: boolean;
            place?: CopyPlaceRequest | undefined;
            resend?: Resend;
        },
        signal?: AbortSignal,
    ): Promise<ConversationId> {
        const meta = this.#app.sessionMeta(id)!;
        const sourceTitle = meta.title ?? "New session";
        const title = `${sourceTitle} · ${branch.label}`.slice(0, MAX_TITLE);
        const destination = await this.#destination(id, user, branch.place, branch.worktree);

        const runner = destination.runner;
        const runnerPermission = runner === undefined ? undefined : randomUUID();

        // Approve before git or copies use the folder: the copy inherits this session's approval (renewed first when
        // locked); on another computer, it starts as a new session there would. The worktree is the copy's own folder.
        const approved = await this.#app.approveFrom(user, id, destination.cwd, runner, signal);

        // Given up while it waited: no copy is made.
        signal?.throwIfAborted();

        return this.#inPlace(
            destination.cwd,
            branch.worktree,
            title,
            async (place) => {
                const copy = await this.#fork(id, user, {
                    ...branch,
                    title,
                    sourceTitle,
                    place,
                    destination,
                    runnerPermission,
                    check: approved.check,
                });

                approved.keep(copy, destination.cwd);

                return copy;
            },
            runner === undefined || runnerPermission === undefined
                ? undefined
                : {
                      runner,
                      scope: { id: runnerPermission, folder: destination.cwd },
                  },
        );
    }

    /**
     * Make the fork in `place`. It starts its own chat, with the pins of messages it inherited; both sessions get an
     * activity line about it. With `resend`, the fork comes with the task that sends that message.
     */
    async #fork(
        id: ConversationId,
        user: User,
        fork: {
            at: number | undefined;
            title: string;
            sourceTitle: string;
            agent?: AgentChange;
            place: Place;
            destination: Destination;
            runnerPermission?: string;
            resend?: Resend;
            /** What allowed the copy, checked again where it is saved (`app.ts` `Approved`). */
            check: () => void;
        },
    ): Promise<ConversationId> {
        const app = this.#app;
        const source = await app.agentState(id);
        // The worktree and the copied files took time: the copy is saved only for who may still make it.
        const saving = checkedContext(context, fork.check);
        const { at, title, place, destination } = fork;
        // A copy runs on the computer it was sent to: one on another computer with the extensions that work there, one
        // here with all of them, also when its session ran elsewhere (the inherited list goes). A fresh one copies no
        // agent state.
        const runner = destination.runner;
        const fromRunner = app.sessionMeta(id)?.runner !== undefined;
        // Always the folder it runs in now: a fork's agent state is the one at its entry (`AgentDoc` forks `asOf`), whose
        // folder can be from before the session moved or was copied to another computer, and is no folder there.
        const agent: AgentChange = { ...fork.agent, cwd: place.cwd };

        const runnerPermission = fork.runnerPermission;

        const from = destination.from;
        const moved =
            from === undefined
                ? undefined
                : `made this copy to run on ${this.#where(runner, place.cwd)}. Paths earlier in this conversation were on ${this.#where(from.runner, from.cwd)}`;
        const init: ConversationCreateOptions["init"] = (tx, forked) =>
            this.#initFork(tx, id, user, forked, {
                at,
                title,
                cwd: place.cwd,
                worktree: place.worktree,
                // A copy is a new session: it takes its starter's shares, not the shares of the original.
                ...app.initialShares(runner, user),
                ...(runner === undefined ? {} : { runner, runnerPermission }),
                fromRunner,
                ...(moved === undefined ? {} : { moved }),
                ...(fork.resend === undefined ? {} : { resend: fork.resend }),
            });

        const ownership = { kind: "ownerless" } as const;
        const forked =
            at === undefined
                ? // Before the first message there is nothing to fork: a new session that runs like this one.
                  await app.harness.createConversation(
                      {
                          ownership,
                          agent: {
                              ...(source?.model === undefined ? {} : { model: source.model }),
                              ...(source?.thinkingLevel === undefined
                                  ? {}
                                  : { thinkingLevel: source.thinkingLevel }),
                              ...(source?.instructions === undefined
                                  ? {}
                                  : { instructions: source.instructions }),
                              cwd: place.cwd,
                              ...agent,
                          },
                          init,
                      },
                      saving,
                  )
                : await (
                      await app.conversation(id)
                  ).fork(at as unknown as EntryId, { ownership, agent, init }, saving);
        const where =
            place.worktree !== undefined
                ? ` into a worktree on ${place.worktree.branch}${place.skipped.length === 0 ? "" : ` (${place.skipped.length} big new files were not copied)`}`
                : from !== undefined
                  ? ` to run on ${this.#where(runner, place.cwd)}`
                  : "";

        await app.collab.activity(
            forked.id,
            user,
            `forked this from “${fork.sourceTitle}”${where}`,
            false,
        );
        await app.collab.activity(id, user, `forked “${title}” from this session${where}`, false);
        void this.recordRepo(forked.id, place.cwd);

        return forked.id;
    }

    /** Register the new session and keep only the pins and authors of the messages it inherited. */
    async #initFork(
        tx: Tx,
        id: ConversationId,
        user: User,
        forked: ConversationId,
        fork: {
            at: number | undefined;
            title: string | undefined;
            cwd: string;
            worktree: Worktree | undefined;
            /** Whom it starts shared with (`SessionMeta.sharedWith`); absent: no one. */
            sharedWith?: string[];
            /**
             * It takes the place of session `id` (Undo), and is no new session of `user`'s: it keeps that session's
             * starter (none: the owner's, as any session without one) and the people it is shared with.
             */
            keeps?: {
                createdBy: string | undefined;
                sharedWith: string[] | undefined;
                /** Who made each of those shares, and when each person used it (`SessionMeta`). */
                sharedBy?: Record<string, string> | undefined;
                usedBy?: Record<string, number> | undefined;
            };
            /** The computer it runs on, with its permission there; absent: this server. */
            runner?: string;
            runnerPermission?: string;
            /** Its session ran on another computer. */
            fromRunner?: boolean;
            /** The note for Pi when it runs on another computer or folder than its session. */
            moved?: string;
            resend?: Resend;
        },
    ): Promise<void> {
        const app = this.#app;
        const { at, title, cwd, worktree, runner, runnerPermission, moved, resend } = fork;

        // Removed while the copy was made: its uploads may be on their way out (`session-cleanup.ts`).
        if ((await tx.doc(DeletedDoc)).items[String(id)] !== undefined) {
            throw new HttpError(409, "That session was removed.");
        }

        // This initializer only adds the new session's record.
        const sessions = await tx.doc(SessionsDoc);
        const now = Date.now();
        const starter = fork.keeps === undefined ? user.id : fork.keeps.createdBy;
        const sharedWith = fork.keeps === undefined ? fork.sharedWith : fork.keeps.sharedWith;

        sessions.items[String(forked)] = {
            cwd,
            ...(title === undefined ? {} : { title }),
            createdAt: now,
            updatedAt: now,
            ...(starter === undefined ? {} : { createdBy: starter }),
            ...(sharedWith === undefined ? {} : { sharedWith }),
            ...(fork.keeps?.sharedBy === undefined ? {} : { sharedBy: fork.keeps.sharedBy }),
            ...(fork.keeps?.usedBy === undefined ? {} : { usedBy: fork.keeps.usedBy }),
            forkedFrom: { id: Number(id), ...(at === undefined ? {} : { entryId: at }) },
            ...(runner === undefined ? {} : { runner, runnerPermission }),
            ...(worktree === undefined ? {} : { worktree }),
        };
        const forkedAgent = await tx.doc(AgentDoc, forked);

        if (runner !== undefined) {
            forkedAgent.extensions = app.remoteExtensions();
        } else if (fork.fromRunner === true) {
            // Copied from a session on another computer: here it runs with everything again.
            delete forkedAgent.extensions;
        }

        // Paths in the history it inherited are on the other computer, or in the other folder: Pi reads this with
        // its next message, before the one a resend sends.
        if (moved !== undefined && at !== undefined) {
            await tx.appendEntry(forked, {
                kind: NOTE_ENTRY,
                data: { text: moved, by: user.id, name: user.name },
                model: [
                    {
                        role: "user",
                        content: [{ type: "text", text: `[note] ${user.name} ${moved}` }],
                        timestamp: now,
                    },
                ],
            });
        }

        await app.memory.forked(tx, id, forked, title ?? "");

        if (resend !== undefined) {
            await tx.createTask(ResendTask, resend, {
                ownership: { kind: "conversation" },
                background: true,
                conversationId: forked,
            });
        }

        if (at === undefined) {
            // A new session, rather than a fork with inherited documents, gets plan mode and notes by hand.
            Object.assign(await tx.doc(PlanDoc, forked), copyJson(await tx.doc(PlanDoc, id)));
            Object.assign(await tx.doc(NotesDoc, forked), copyJson(await tx.doc(NotesDoc, id)));

            return;
        }

        // The copied chat is the parent's conversation, not this one's.
        const chat = await tx.doc(ChatDoc, forked);

        chat.messages.splice(0);
        const pins = await tx.doc(PinsDoc, forked);

        for (let index = pins.items.length - 1; index >= 0; index--) {
            const pin = pins.items[index]!;

            if (pin.entryId === undefined || pin.entryId > at) {
                pins.items.splice(index, 1);
            }
        }

        const authors = await tx.doc(AuthorsDoc, forked);

        for (const entryId of Object.keys(authors.entries)) {
            if (Number(entryId) > at) {
                delete authors.entries[entryId];
            }
        }
    }

    async compact(id: ConversationId, user: User, instructions: string | undefined): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        // PiP's summaries are its own, written by its extension's hook with outside text left out: while PiP is off,
        // there is no hook, and Pi Durable's summary would read what came from outside as it is.
        const pip = app.pip.ownerOf(id) !== undefined;

        if (pip && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        // Compacting asks the model for a summary, which costs like any other request.
        app.spend.check(user, id);
        const conversation = await app.conversation(id);
        const taskId = await conversation.compact(instructions, app.admission(id, user));
        const done = pip ? "PiP's context compacted." : "Compacted.";

        app.notice("info", pip ? "Compacting PiP's context…" : "Compacting…", id);
        await app.collab.activity(id, user, "started compacting the context", false);
        void app.harness.waitForTask(taskId, context).then(
            (receipt) => {
                const outcome = receipt.state.outcome;

                if (outcome.status === "completed") {
                    const { entryId, submissionId } = outcome.result;
                    // PiP's own summary could not be written: it declined, rather than let Pi Durable write one.
                    const failed = pip ? app.pipCompaction.failure(Number(taskId)) : undefined;

                    if (failed !== undefined) {
                        app.notice("error", `PiP's context was not compacted: ${failed}`, id);
                    } else {
                        app.notice(
                            "info",
                            entryId === undefined && submissionId === undefined
                                ? "Nothing to compact: the context fits in the recent window."
                                : done,
                            id,
                        );
                    }
                } else if (outcome.status === "aborted") {
                    app.notice("info", "Compaction aborted.", id);
                } else {
                    const why = "error" in outcome ? outcome.error?.message : undefined;

                    app.notice("error", `Compaction ${outcome.status}${why ? `: ${why}` : ""}`, id);
                }
            },
            (error: unknown) => app.notice("error", describe(error), id),
        );
    }
}
