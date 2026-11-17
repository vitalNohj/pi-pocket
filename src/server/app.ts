/**
 * The Pi Pocket server core: one durable Harness over one SQLite file, shared by every session, every subagent, and
 * every connected browser. Browsers attach to a conversation's committed view; nothing a browser sees exists only in
 * memory, except who is connected, who is typing, and which tool calls wait for approval.
 *
 * What people ask of Pi lives in `commands.ts`, the people's side of a session in `collab.ts`, push notifications in
 * `alerts.ts`, provider sign-ins in `providers.ts`, and each conversation's shared live view in `room.ts`.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve as resolvePath, win32 } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
    getAgentDir,
    ModelRuntime,
    resolveModelScopeWithDiagnostics,
    type ProviderConfig,
    SettingsManager,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import {
    AgentDoc,
    type AgentState,
    type CommitPublication,
    type Conversation,
    type ConversationId,
    type Cursor,
    createRegistry,
    defineExtension,
    type DocumentCommitChange,
    hook,
    ToolTask,
    Harness,
    type HarnessSettings,
    LiveDoc,
    type LiveState,
    ProviderDoc,
    type Registry,
    type Storage,
    type SubmissionRecord,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Alerts } from "./alerts.ts";
import { ApprovalMethods, Authenticators } from "./approval-methods.ts";
import { Attribution, type Missing } from "./attribution.ts";
import { Browsers } from "./browser.ts";
import type { BrowserState } from "./browser/page.ts";
import { Collab, REACTIONS } from "./collab.ts";
import { Commands } from "./commands.ts";
import { ExtensionSessions } from "./extension-sessions.ts";
import { LinkedSessions } from "./linked-sessions.ts";
import { removeAvatar, saveAvatar } from "./avatars.ts";
import {
    APP_ROOT,
    APPROVAL_DAYS,
    approvalDays,
    ConfigStore,
    modulesWith,
    type User,
} from "./config.ts";
import {
    ArtifactAssetDoc,
    ArtifactBodyDoc,
    type ArtifactMeta,
    ArtifactsDoc,
    type ArtifactType,
    AuthorsDoc,
    BackgroundDoc,
    type BackgroundTask,
    BrowserDoc,
    ChatDoc,
    type ChatMessage,
    DecisionsDoc,
    type FolderFavorites as FolderFavoritesValue,
    FolderFavoritesDoc,
    HooksDoc,
    MemoryDoc,
    RepoWatchesDoc,
    RunFailureDoc,
    type SessionMeta,
    SessionsDoc,
    SpendDoc,
    type SubagentRecord,
    ScheduleDoc,
    SubagentsDoc,
    TurnsDoc,
    WatchDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { ExtensionCommands } from "./extension-commands.ts";
import { ExtensionWebs } from "./extension-web.ts";
import { defang, quoted } from "./fence.ts";
import { FolderFavorites } from "./folder-favorites.ts";
import { Gallery } from "./gallery.ts";
import { Goals } from "./goals.ts";
import {
    type ApprovalRequest,
    Approvals,
    type ModelRequestShaper,
    type PocketHost,
    type WebAccess,
    type WorkspaceProvider,
} from "./host.ts";
import { type GuardStatus, LancetGuard } from "./lancet.ts";
import { withReveal } from "./local-browser.ts";
import { takeLock } from "./lock.ts";
import { Memory } from "./memory.ts";
import { isThinkingLevel, modelInfo, modelList, resolveModel, THINKING_LEVELS } from "./models.ts";
import { Updates } from "./updates.ts";
import { pocketPackage, pocketVersion } from "./versions.ts";
import { serverBuild } from "./build.ts";
import { presentedBuild } from "./entry-presentation.ts";
import { compactionReader } from "./compaction.ts";
import { configureHttp } from "./net.ts";
import { expandHome, workspaceScheme } from "./paths.ts";
import { createPublicFetch } from "./public-fetch.ts";
import { PiSessions } from "./pi-sessions.ts";
import { Hooks } from "./hooks.ts";
import { Pip, PIP_EXTENSION } from "./pip.ts";
import { PIP_COMPACT_CHOICES, PipCompaction } from "./pip-compact.ts";
import { RepoWatches } from "./repo-watches.ts";
import { snippet } from "./projection.ts";
import { loadPromptTemplates, type PromptTemplate, type SkillCommand } from "./prompts.ts";
import { BASE_THEME, Themes } from "./themes.ts";
import { THEME_ID } from "./themes/format.ts";
import { LimitGate, type LimitTuning } from "./limit-gate.ts";
import { CacheKeeper } from "./cache-keeper.ts";
import { idleFiles } from "./keep-warm-store.ts";
import { measureModelStreams } from "./timing.ts";
import { Providers } from "./providers.ts";
import { CustomProviders } from "./custom-providers.ts";
import { type EmbedderMessage, PushStore } from "./push.ts";
import { type ExtensionInfo, ExtensionLoader, linkTypes, prepareDropInFolder } from "./reload.ts";
import { ResendTask } from "./resend.ts";
import {
    type Client,
    reportingOf,
    Room,
    ROOM_DOCS,
    type SubagentModel,
    subagentView,
} from "./room.ts";
import { whyUnanswered } from "./subagent-runs.ts";
import { Schedules } from "./schedules.ts";
import { BackgroundTasks } from "./background.ts";
import { Shares } from "./share.ts";
import { CommandEnvs, HiddenValues, wrapEnv } from "./hidden.ts";
import { AppEventBus } from "./app-events.ts";
import { changeSettings, shownSettings } from "./extension-settings.ts";
import { ask, browserFor, checkValues } from "./extension-points.ts";
import { PublicLinks } from "./public-links.ts";
import { Shell } from "./shell.ts";
import {
    loadSessionSkills,
    projectDistrusted,
    type ProjectTrust,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    type TrustChoice,
} from "./skills.ts";
import { KeepWarm } from "./keep-warm.ts";
import { Spend } from "./spend.ts";
import { Transcripts } from "./transcripts.ts";
import { Watches } from "./watches.ts";
import { Workspace } from "./workspace.ts";
import { REMOTE_EXTENSIONS, REMOTE_SUBAGENT_WITHOUT, Runners } from "./runners.ts";
import { AccessPolicy, inFolder, THIS_SERVER } from "./access.ts";
import { realFolder } from "../runner/folders.ts";
import { FolderRequests } from "./folder-requests.ts";
import { checkedContext } from "./admission.ts";
import { type ApprovalView, DAY_MS, FolderApprovals } from "./folder-approvals.ts";
import {
    changedThere,
    type FolderScan,
    knownScan,
    latestScan,
    projectThere,
    readRemoteText,
    saveTrust,
} from "./remote-context.ts";

const context = BACKGROUND_CONTEXT;

/** How other devices reach this server, as reported by the launcher (`bin/pi-pocket.js`). */
export type AccessInfo = {
    mode: string;
    label: string;
    /** The address other devices should use, such as a tunnel's public https URL. */
    url?: string;
};

/** The extension module that runs Lancet Guard on tool calls. */
const GUARD_FILE = "guard.ts";
/** How long the server waits, when it stops, for extension modules' cleanups that wait. */
const CLEANUP_LIMIT_MS = 3000;
/** The extension module with the browser tool. While it is off, the Browser panel is off too. */
const BROWSER_FILE = "browser.ts";
const BROWSER_EXTENSION = "pocket-browser";
/** The extension module that is PiP. */
const PIP_FILE = "pip.ts";
/** The extension module with the subagent tool, rebuilt when the models subagents may use change. */
const SUBAGENTS_FILE = "subagents.ts";
/** The hours a run may wait for a provider's limit, as the owner may choose them (0: not at all). */
const LIMIT_WAIT_CHOICES = [0, 1, 6, 12, 24];
/** The most models the owner may allow subagents. */
const MAX_SUBAGENT_MODELS = 50;

/**
 * The most conversations a tab gets live peeks for at once: the sessions on its screen, and the subagents working
 * there, each row asking for its own as the tiles do.
 */
export const MAX_PEEKS = 20;
/**
 * How a run that failed leaves its messages: the model or its provider answered with an error, no model was there to
 * ask, the run broke, or the server stopped while the model answered and no retry was left (`interrupted`, since Pi
 * Durable 1.5). Stopped (`aborted`), cleared (`reset`), and replaced (`stale`) runs did not fail.
 */
const FAILED_RUN = new Set(["model_error", "no_model", "faulted", "interrupted"]);

/** The session list goes to every tab on each change: these bound what it carries. */
const FAILURE_TEXT = 120;

/** The short failure line the session list and extensions share, or none when the run did not fail. */
function failureText(
    status: string,
    reason: string | undefined,
    detail: unknown,
): string | undefined {
    if (status !== "unanswered" || reason === undefined || !FAILED_RUN.has(reason)) {
        return undefined;
    }

    return whyUnanswered(reason, detail).slice(0, FAILURE_TEXT);
}

const ASK_SUBJECT = 200;
const ASK_REASON = 200;
const FAILED_AGENTS = 5;

type SessionAsk = {
    id: string;
    conversationId: number;
    tool: string;
    subject: string;
    reason: string;
    requestedBy?: string;
    form?: true;
    at: number;
    count: number;
};

/** A conversation's subagents document, as far as the app reads it. */
type SubagentsValue = {
    agents?: Record<string, SubagentRecord>;
    outbox?: readonly { name: string }[];
    sending?: { reports: readonly { name: string }[] };
};

type SubagentsOf = { agents: Record<string, SubagentRecord>; reporting: Set<string> };

/** How many sessions the artifacts overview reads at once. */
const OVERVIEW_BATCH = 8;

/** One artifact in the artifacts overview: where it is, and which of its versions is the current one. */
export type ArtifactOverviewEntry = {
    session: number;
    sessionTitle: string;
    id: string;
    title: string;
    type: ArtifactType;
    kind?: "page" | "deck";
    group?: string;
    /** The number of the latest version: the one a person sees first. */
    current: number;
    /** How many versions there are. */
    versions: number;
    size: number;
    updatedAt: number;
};

/** One subagent on the subagents board: the subagents bar's view, the session it works in, and the call it waits on. */
export type SubagentEntry = ReturnType<typeof subagentView> & {
    id: number;
    waiting?: true;
    approval?: { tool: string; subject: string };
};

/** Where a subagent is. Waiting for an approval comes before working: it is working, held up. */
export type SubagentState = "waiting" | "working" | "failed" | "stopped" | "done";

/**
 * An approval to start, copy, move, or link a session into a folder (`approveStart`, `approveFrom`). `check` refuses
 * once what allowed it no longer holds (unchosen, the folder taken back, the source no longer theirs to steer); it runs
 * where the new session is saved (`admission.ts`). `keep` records the approval for the session once it has an id.
 */
export type Approved = {
    check: () => void;
    keep: (session: ConversationId, folder: string) => void;
};

/**
 * This server in the Runners sheet (`thisServer`), as those who manage it see it: the people the owner chose, its saved
 * folders, and its rules. It cannot be unlinked or removed.
 */
export type ServerView = {
    id: typeof THIS_SERVER;
    name: string;
    /** Its linker: the owner. */
    createdBy: string;
    users: { id: string; name: string; role: User["role"] }[];
    /** The folders given to each chosen person here, by person id. */
    given: Record<string, string[]>;
    /** Of those, the folders in which that person sees every session, by person id. */
    sees: Record<string, string[]>;
    shareNew: boolean;
};

export function subagentState(entry: SubagentEntry): SubagentState {
    if (entry.waiting === true) {
        return "waiting";
    }

    if (entry.busy) {
        return "working";
    }

    return entry.stopped === true ? "stopped" : entry.failed === true ? "failed" : "done";
}

/**
 * On the subagents board, a session's finished subagents (done, stopped, or failed and dealt with) past this many, the
 * oldest, are left out: the session list counts them, and the board says how many more there are. Those that work,
 * wait, failed with nobody dealing with it yet, or have a report on its way always show.
 */
const BOARD_FINISHED = 24;

/** How long a read of Pi's settings serves skills and trust before it is read again. */
const SETTINGS_STALE_MS = 30_000;

/** With "Tasks expire with the session" on: how long a session's tasks run on after its approval ends. */
const TASK_GRACE_MS = 7 * 86_400_000;

/** A session's subagents as the board gets them: all but its oldest finished ones past `BOARD_FINISHED`. */
function forBoard(entries: readonly SubagentEntry[]): SubagentEntry[] {
    const finished = (entry: SubagentEntry) =>
        entry.reporting !== true &&
        (["done", "stopped"].includes(subagentState(entry)) ||
            (subagentState(entry) === "failed" && entry.dealt === true));
    const done = entries.filter(finished);

    if (done.length <= BOARD_FINISHED) {
        return [...entries];
    }

    const when = (entry: SubagentEntry) => entry.answeredAt ?? entry.askedAt ?? 0;
    const kept = new Set(done.sort((a, b) => when(b) - when(a)).slice(0, BOARD_FINISHED));

    return entries.filter((entry) => !finished(entry) || kept.has(entry));
}

/**
 * How many of a session's subagents are in each state, without the empty ones, and how many of those that failed a
 * person dealt with (`dealt`): the rest need someone. Undefined for none at all.
 */
function countSubagents(
    entries: readonly SubagentEntry[],
): (Partial<Record<SubagentState, number>> & { dealt?: number }) | undefined {
    if (entries.length === 0) {
        return undefined;
    }

    const counts: Partial<Record<SubagentState, number>> & { dealt?: number } = {};

    for (const entry of entries) {
        const state = subagentState(entry);

        counts[state] = (counts[state] ?? 0) + 1;

        if (state === "failed" && entry.dealt === true) {
            counts.dealt = (counts.dealt ?? 0) + 1;
        }
    }

    return counts;
}

function failedSubagents(
    entries: readonly SubagentEntry[],
): { name: string; conversationId: number; at: number }[] {
    return entries
        .filter((entry) => subagentState(entry) === "failed" && entry.dealt !== true)
        .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))
        .slice(0, FAILED_AGENTS)
        .map((entry) => ({
            name: entry.name,
            conversationId: Number(entry.conversationId),
            at: entry.answeredAt ?? 0,
        }));
}

export interface OpenOptions {
    dataDir: string;
    defaultCwd: string;
    supervised: boolean;
    log?: (line: string) => void;
    /** Tests register scripted providers here. */
    configureModels?: (models: ModelRuntime) => void;
    /** Tests shorten the limit gate's waits (`limit-gate.ts`). */
    limits?: Partial<LimitTuning>;
    /** The clock durable work runs by, such as scheduled messages. Tests move it ahead. */
    now?: () => number;
    /** The browser to run for the Browser panel and tool; null for none. Undefined finds one on this machine. */
    browser?: string | null;
    /** The home folder, whose `.agents/skills/` every session has. Undefined is Pi's: `$HOME`. Tests use their own. */
    home?: string;
    /** Restart the server, as Menu → Restart server does (`main.ts`); undefined where nothing can (tests). */
    restart?: () => void;
    /** Where Pi Pocket's own code is, for its updates; tests give a checkout of their own. */
    appRoot?: string;
}

export class PocketApp {
    readonly config: ConfigStore;
    /** Each person's own authenticator app, and the ways to approve with it (`approval-methods.ts`). */
    readonly authenticators: Authenticators;
    readonly approvalMethods: ApprovalMethods;
    /** Who may use which computer, folder, and session (`access.ts`): every access check asks it. */
    readonly policy: AccessPolicy;
    /** New folders on this server waiting for an approval (`folder-requests.ts`). */
    readonly folderRequests: FolderRequests;
    /** Approvals of folders and shared sessions, for every computer (`folder-approvals.ts`). */
    readonly folderApprovals: FolderApprovals;
    /** Other computers that run sessions' tools (`runners.ts`): their links, keys, and environments. */
    readonly runners: Runners;
    /** Push subscriptions and their keys; undefined until the server opened. */
    pushStore: PushStore | undefined;
    readonly approvals = new Approvals((id) => this.attribution.requesterOf(id));
    readonly guard = new LancetGuard();
    readonly dataDir: string;
    readonly defaultCwd: string;
    readonly supervised: boolean;
    readonly startedAt = Date.now();
    readonly #code = serverBuild();

    /**
     * This server's code (`serverBuild`) and how its modules present inputs: sessions a tab keeps, in its memory or on
     * the device, are good for a server of the same build, so they last across a restart but not across new code.
     */
    get build(): string {
        return presentedBuild(this.#code, this.webs.presentations());
    }
    /** Set by the launcher over IPC; undefined when the server runs on its own. */
    access: AccessInfo | undefined;
    harness!: Harness;
    models!: ModelRuntime;
    settings!: SettingsManager;
    loader!: ExtensionLoader;
    readonly commands = new Commands(this);
    readonly extensionCommands = new ExtensionCommands(this);
    readonly linkedSessions = new LinkedSessions(this);
    readonly extensionSessions = new ExtensionSessions(this);
    readonly collab = new Collab(this);
    readonly alerts = new Alerts(this);
    readonly providers = new Providers(this);
    /** OpenAI-compatible endpoints the owner adds in the Providers sheet, kept in Pi's `models.json`. */
    readonly customProviders = new CustomProviders(this);
    /** Model requests that hit a limit wait for it to clear, then go on (`limit-gate.ts`). */
    readonly limits: LimitGate;
    /** Keeps the prompt cache warm while a run waits on a tool call, and with keep warm once it ends (`cache-keeper.ts`). */
    readonly cacheKeeper: CacheKeeper;
    readonly schedules = new Schedules(this);
    /** Commands Pi runs in the background, watched until they end (`background.ts`). */
    readonly background = new BackgroundTasks(this);
    readonly goals = new Goals(this);
    readonly shell = new Shell(this);
    readonly spend = new Spend(this);
    /** The owner's keep-warm settings and each session's choice (`keep-warm.ts`). */
    readonly keepWarm = new KeepWarm({
        settings: () => this.config.keepWarm,
        saveSettings: (next) => {
            this.config.keepWarm = next;
        },
        sessionMeta: (id) => this.sessionMeta(id),
        rootOf: (id) => this.rootOf(id),
        model: (provider, id) => this.models.getModel(provider, id),
        models: () => [...this.models.getModels()],
        availableModels: () => [...this.models.getAvailableSnapshot()],
        keeper: {
            idleSummary: () => this.cacheKeeper.idleSummary(),
            idleStatus: (id) => this.cacheKeeper.idleStatus(id),
        },
        settingsChanged: () => this.keepWarmSettingsChanged(),
    });
    /** Who Pi works for in each conversation, and who wrote and queued each message. */
    readonly attribution = new Attribution(this);
    /** The conversation's folder: files, the viewer, changes, and uploads. */
    readonly workspace = new Workspace(this);
    /** The conversation's stored history, as people read it. */
    readonly transcripts = new Transcripts(this);
    /** Pi's sessions from the terminal, which the owner can continue here. */
    readonly piSessions = new PiSessions(this);
    /** PiP, the owner's assistant: its conversation, what its tools do, and the follows that report to it. */
    readonly pip = new Pip(this);
    /** PiP's context kept small: compacted sooner than a session's, with summaries of its own (`pip-compact.ts`). */
    readonly pipCompaction = new PipCompaction(this);
    /** Sessions' watches of their pull requests (`watches.ts`). */
    readonly watches = new Watches(this);
    /** PiP's standing orders on GitHub repositories: what happens there goes to PiP or a session (`repo-watches.ts`). */
    readonly repoWatches = new RepoWatches(this);
    /** Webhooks: addresses other services post to, each a message to a session or PiP (`hooks.ts`). */
    readonly hooks = new Hooks(this);
    /** Lessons Pi keeps across sessions, for a project or everywhere. */
    readonly memory = new Memory(this);
    /** Each person's favorite working folders, shared by their devices. */
    readonly folderFavorites = new FolderFavorites(this);
    /** Artifacts published to anyone with their address (`share.ts`), which needs no sign-in. */
    readonly shares = new Shares(this);
    /** Extension modules' pages for anyone with the address (`public-links.ts`), which need no sign-in. */
    readonly publicLinks = new PublicLinks(this);
    /** What happens in the app, for extensions (`app-events.ts`, `host.on`). */
    readonly events = new AppEventBus((line) => this.#log(line));
    /** Values extensions hide from what commands and tools give back (`hidden.ts`, `host.hide`). */
    readonly hidden = new HiddenValues((id) =>
        Number(this.rootOf(id as unknown as ConversationId)),
    );
    /** What extensions add to the environment of each command (`hidden.ts`, `host.commandEnv`). */
    readonly commandEnvs = new CommandEnvs((line) => this.#log(line));
    /** Other people's drop-ins, from a reviewed index: found, installed off, read, updated, removed (`gallery.ts`). */
    readonly gallery = new Gallery(this);
    /** Updates of Pi Pocket itself: the newest release, and updating to it (`updates.ts`). */
    readonly updates: Updates;
    /** Theme folders: the app's look and layout, built in and the owner's (`themes.ts`). */
    readonly themes: Themes;
    /** Each conversation's browser page, which Pi and the people in the conversation share. */
    readonly browsers: Browsers;
    /** What extension modules add to the app: their routes, browser modules, and events (`extension-web.ts`). */
    readonly webs: ExtensionWebs;
    #websTimer: NodeJS.Timeout | undefined;
    /** Whose tabs the next `hello` for browser modules goes to: those who may use any of these. */
    readonly #websFor = new Set<WebAccess>();
    /** Whether everyone's tabs must hear `hello` again, for a change to the modules' commands. */
    #websAll = false;
    readonly #clients = new Set<Client>();
    readonly #rooms = new Map<ConversationId, Promise<Room>>();
    readonly #envs = new Map<string, ExecutionEnv>();
    readonly #workspaceProviders = new Map<
        string,
        { token: symbol; provider: WorkspaceProvider }[]
    >();
    readonly #busy = new Set<ConversationId>();
    /** Copies of attached files on their way to a session's computer (`uploadsCopied`), by conversation. */
    readonly #uploads = new Map<ConversationId, Promise<void>>();
    /** When each conversation's last run ended, since this server started: peek tiles show sessions done since a look. */
    readonly #endedAt = new Map<ConversationId, number>();
    /**
     * Conversations whose last run ended because the model or provider failed (not stopped by someone), since this
     * server started: the session list marks them until their next run starts.
     */
    readonly #failed = new Map<ConversationId, string>();
    /** How many commands each session runs in the background now (`background.ts`): the list and status line show it. */
    readonly #background = new Map<ConversationId, number>();
    readonly #agents = new Map<ConversationId, AgentState>();

    /** The newest chat message (not activity) of each conversation, for unread dots in the session list. */
    readonly #lastChat = new Map<string, { at: number; userId: string }>();
    /**
     * Take turns of each session read so far, by its root: kept by every commit that changes it, so the check where a
     * save happens (`recheck`) needs no read.
     */
    readonly #turns = new Map<string, { on: boolean; driver?: string }>();
    /** Subagent conversation → the conversation that spawned it. */
    readonly #parents = new Map<ConversationId, ConversationId>();
    /** Each conversation's subagents, and those with a report on its way to it: for the board and the session list. */
    readonly #subagents = new Map<ConversationId, SubagentsOf>();
    #sessions: Record<string, SessionMeta> = {};
    #sessionsTimer: NodeJS.Timeout | undefined;
    /** The extensions installed now: every conversation runs with them, except PiP's own, which PiP alone selects. */
    #registry: Registry | undefined;
    #unsubscribeCommits: (() => void) | undefined;
    #unsubscribeRunEnds: (() => void) | undefined;
    #unsubscribeApprovals: (() => void) | undefined;
    #unsubscribeBrowsers: (() => void) | undefined;
    #lockFile: string;
    #releaseLock: (() => void) | undefined;
    #openingStorage: Storage | undefined;
    #closing: Promise<void> | undefined;
    /** A pending `#tuneRemote` after extensions changed (`#tuneRemoteSoon`). */
    #tuneTimer: NodeJS.Timeout | undefined;
    readonly #log: (line: string) => void;
    readonly #configureModels: ((models: ModelRuntime) => void) | undefined;
    /** Request shapers from the extension modules the owner turned on (`host.shapeModelRequests`). */
    readonly #shapers: ModelRequestShaper[] = [];
    /**
     * Each provider's registrations by extension modules (`host.registerModelProvider`), newest last: the newest is in
     * Pi's runtime, and removing it puts back the one before.
     */
    readonly #modelProviders = new Map<string, { token: symbol; config: ProviderConfig }[]>();
    readonly #home: string;
    /** The clock durable work runs by. */
    readonly now: () => number;

    private constructor(options: OpenOptions) {
        this.#configureModels = options.configureModels;
        this.#home = options.home ?? (process.env.HOME || homedir());
        this.now = options.now ?? Date.now;
        this.dataDir = options.dataDir;
        this.defaultCwd = options.defaultCwd;
        this.supervised = options.supervised;
        this.updates = new Updates({
            appRoot: options.appRoot ?? APP_ROOT,
            version: pocketVersion(),
            supervised: options.supervised && options.restart !== undefined,
            // The launcher says so when it goes back to the version before a new one that does not start.
            rollback: process.env.PI_POCKET_ROLLBACK === "1",
            npmRollback: process.env.PI_POCKET_NPM_ROLLBACK === "1",
            restart: () => options.restart?.(),
            quiesce: (paused) => this.pauseReloads(paused),
            busy: () => this.#busy.size,
            log: (line) => this.#log(line),
            // Releases from somewhere else: a fork's, or a copy of Pi Pocket's repository to try updates on.
            ...(process.env.PI_POCKET_UPDATES_REPO
                ? { repository: process.env.PI_POCKET_UPDATES_REPO }
                : {}),
        });
        this.config = new ConfigStore(options.dataDir);
        this.authenticators = new Authenticators(this.config.authenticators, {
            now: () => this.now(),
            locked: (lockout) => this.alerts.lockout(lockout),
        });
        this.approvalMethods = new ApprovalMethods(this.authenticators);
        this.folderApprovals = new FolderApprovals(this.config, {
            now: () => this.now(),
            changed: () => this.#approvalsChanged(),
            // The approval is the session's: renewed by one request, from its row, or by who is in charge using it,
            // everyone else waiting to renew it goes on too.
            approved: (approval) =>
                this.folderRequests.renewed(approval.session, {
                    method: approval.method,
                    by: approval.by,
                }),
        });
        this.policy = this.#makePolicy();
        this.folderRequests = new FolderRequests({
            methods: this.approvalMethods,
            person: (id) => this.config.userById(id),
            hasCode: (id) => this.authenticators.linked(id),
            inCharge: (person, computer) => this.policy.inCharge(person, computer),
            changed: () => this.#folderRequestsChanged(),
            asked: (request) =>
                this.alerts.folderRequest(
                    request,
                    request.session === undefined
                        ? (this.config.runnerById(request.computer)?.createdBy ?? this.#ownerId())
                        : this.policy.inChargeOf(request.session),
                    request.computer === THIS_SERVER ? undefined : request.computerName,
                ),
            now: () => this.now(),
        });
        this.#lockFile = join(options.dataDir, "harness.lock");
        this.#log = options.log ?? ((line) => console.log(line));
        this.runners = new Runners({
            config: this.config,
            log: (line) => this.#log(line),
            onChange: () => this.#runnersChanged(),
            // Who may use it; the owner sees every runner, to unlink one (no folders or sessions unless chosen).
            mayList: (id, user) => user.role === "owner" || this.policy.mayUse(user, id),
            mayManage: (id, user) => this.policy.mayManage(user, id),
            mayStart: (id, user) => this.policy.mayStart(user, id),
            mayUse: (id, user) => this.policy.mayUse(user, id),
            mayLink: (by, runner) =>
                this.policy.mayLink({ id: by }) &&
                (runner === undefined || this.policy.mayManage({ id: by }, runner)),
        });
        this.cacheKeeper = new CacheKeeper({
            log: (line) => this.#log(line),
            conversationOf: (sessionId) => this.#conversationOfSession(sessionId),
            isRunning: (conversationId) => this.#busy.has(conversationId as ConversationId),
            accountFor: (conversationId) => {
                const id = conversationId as ConversationId;
                const payer = this.spend.payer(id);

                return {
                    // A tool wait warms only while its run goes on; keep warm, only once it has ended.
                    check: (idle) => {
                        const person = this.config.userById(payer);

                        if (person === undefined || idle === this.#busy.has(id)) {
                            return false;
                        }

                        try {
                            this.spend.check(person, id);

                            return true;
                        } catch {
                            return false;
                        }
                    },
                    recordUsage: (message) => this.spend.recordModelUsage(id, payer, message),
                };
            },
            idlePolicy: (conversationId) => this.keepWarm.policy(conversationId),
            warmable: (conversationId) => this.keepWarm.warmable(conversationId),
            modelFacts: (spec, tier) => this.keepWarm.facts(spec, tier),
            modelOf: (provider, modelId) => this.models?.getModel(provider, modelId),
            store: idleFiles(join(options.dataDir, "keep-warm"), (line) => this.#log(line)),
            changed: (conversationId) => this.#keepWarmChanged(conversationId as ConversationId),
        });
        this.limits = new LimitGate({
            hours: () => this.config.limitWaitHours,
            epoch: (provider) => this.providers.signInEpoch(provider),
            conversationOf: (sessionId) => this.#conversationOfSession(sessionId),
            changed: () => this.#limitsChanged(),
            started: (conversationId, view) => this.alerts.limitWait(conversationId, view),
            log: (line) => this.#log(line),
            file: join(options.dataDir, "provider-limits.json"),
            ...(options.limits === undefined ? {} : { tuning: options.limits }),
        });
        this.browsers = new Browsers({
            dataDir: options.dataDir,
            ...(options.browser === undefined ? {} : { executable: options.browser }),
            log: (line) => this.#log(line),
            remote: {
                runnerOf: (id) => this.runnerOf(id as unknown as ConversationId),
                name: (runner) => this.runners.name(runner),
                connect: (runner, host, port, socket, open) =>
                    this.runners.link(runner).openNetwork(host, port, socket, {
                        ...open,
                        ...(open.conversationId === undefined
                            ? {}
                            : {
                                  session: this.runnerScope(
                                      open.conversationId as unknown as ConversationId,
                                  ),
                              }),
                    }),
                computer: async (runner, conversationId) => {
                    const link = this.runners.link(runner);
                    const info = await link.info();
                    const id = conversationId as unknown as ConversationId;
                    const scoped = conversationId === undefined ? undefined : this.runnerScope(id);

                    return {
                        name: this.runners.name(runner),
                        env: this.runners.env(runner, scoped?.folder ?? info.home, scoped),
                        tmpdir: info.tmpdir,
                        separator: info.separator,
                        ...(link.downloads === undefined ? {} : { folder: link.downloads }),
                        session: scoped?.id ?? String(conversationId),
                    };
                },
            },
            load: async (id) =>
                (await this.harness.snapshot(
                    BrowserDoc,
                    id as unknown as ConversationId,
                    context,
                )) ?? undefined,
            save: (id, saved) => {
                void this.harness
                    .commit(async (tx) => {
                        const doc = await tx.doc(BrowserDoc, id as unknown as ConversationId);

                        if (saved.url !== undefined && doc.url !== saved.url) {
                            doc.url = saved.url;
                        }

                        const viewport = saved.viewport;

                        if (
                            viewport !== undefined &&
                            JSON.stringify(doc.viewport) !== JSON.stringify(viewport)
                        ) {
                            doc.viewport = { ...viewport };
                        }
                    }, context)
                    .catch((error: unknown) =>
                        this.#log(`browser page not saved: ${describe(error)}`),
                    );
            },
        });
        this.themes = new Themes({
            builtIn: join(APP_ROOT, "web", "themes"),
            dataDir: options.dataDir,
            notify: (message) => this.ownerNotice("warning", message),
            // Everyone's tabs: a theme anyone may have chosen changed, or one came or went.
            changed: () => {
                const lists = { owner: this.themes.list(true), others: this.themes.list(false) };

                for (const client of this.#clients) {
                    client.send(
                        "themes",
                        client.user.role === "owner" ? lists.owner : lists.others,
                    );
                }

                void this.#themeDefaultStillHere();
            },
            log: (line) => this.#log(line),
        });
        this.webs = new ExtensionWebs({
            mayUse: (user, access) => this.policy.mayUseExtension(user, access),
            changed: (access) => this.#websChanged(access),
            deliver: (part, access, event, data, to) => {
                for (const client of this.#clients) {
                    if (
                        (to === undefined || client.user.id === to) &&
                        this.policy.mayUseExtension(client.user, access)
                    ) {
                        client.send("ext", { module: part.module, event, data });
                    }
                }
            },
            // Everyone's tabs hear the new list in `hello`: commands are for guests too, not by a browser module's access.
            commandsChanged: () => this.#websChanged("all"),
            presentationsChanged: () => {
                // A new build in `hello`: what tabs kept shows the inputs as presented before.
                this.#websChanged("all");

                for (const pending of this.#rooms.values()) {
                    void pending.then(
                        (room) => room.reproject(),
                        () => {},
                    );
                }
            },
            log: (line) => this.#log(line),
            // Something about a module only the owner can mend: their tabs, as what it says can name the server's folders.
            warn: (message) => this.ownerNotice("warning", message),
            links: this.publicLinks,
            settings: (module) => this.config.extensionSettings(module),
        });
    }

    /**
     * A module's model provider goes into Pi's runtime in place of the one in force, and stays until its removal. Pi
     * merges a registration into the one before, so the one before goes first: a new version starts from its own config
     * alone. When Pi refuses the config, the one before comes back and the registration throws.
     */
    #registerModelProvider(provider: string, config: ProviderConfig): () => void {
        const token = Symbol(provider);
        const registrations = this.#modelProviders.get(provider) ?? [];
        const previous = registrations.at(-1);

        if (previous !== undefined) {
            this.models.unregisterProvider(provider);
        }

        try {
            this.models.registerProvider(provider, config);
        } catch (error) {
            if (previous !== undefined) {
                this.models.registerProvider(provider, previous.config);
            }

            throw error;
        }

        // Only once Pi took it: a registration that failed has no removal, and must not stand in for the one before.
        registrations.push({ token, config });
        this.#modelProviders.set(provider, registrations);
        this.#modelProviderChanged(provider);

        return () => this.#removeModelProvider(provider, token);
    }

    /** A registration goes. When it was in force, the one before it (another module's, or an older version's) is back. */
    #removeModelProvider(provider: string, token: symbol): void {
        const registrations = this.#modelProviders.get(provider);
        const index =
            registrations?.findIndex((registration) => registration.token === token) ?? -1;

        if (registrations === undefined || index < 0) {
            return;
        }

        const inForce = index === registrations.length - 1;

        registrations.splice(index, 1);

        if (registrations.length === 0) {
            this.#modelProviders.delete(provider);
        }

        if (!inForce) {
            return;
        }

        this.models.unregisterProvider(provider);
        const before = registrations.at(-1);

        if (before !== undefined) {
            try {
                this.models.registerProvider(provider, before.config);
            } catch (error) {
                this.#log(`Model provider ${provider} could not be put back: ${describe(error)}`);
            }
        }

        this.#modelProviderChanged(provider);
    }

    /** Pi refreshes a provider locally once it changes: tabs get the models it has then, and sessions their state. */
    #modelProviderChanged(provider: string): void {
        if (this.#closing !== undefined) {
            return;
        }

        void this.models
            .refresh({ allowNetwork: false, providers: [provider] })
            .catch((error: unknown) => {
                this.#log(`Model provider ${provider} not refreshed: ${describe(error)}`);
            })
            .finally(() => {
                if (this.#closing === undefined) {
                    this.providers.modelsChanged();
                }
            });
    }

    /**
     * Browser modules came, went, or changed: the tabs of the people they are for hear which to load, once for changes
     * that come together.
     */
    #websChanged(access: readonly WebAccess[] | "all"): void {
        if (this.#closing !== undefined) {
            return;
        }

        if (access === "all") {
            this.#websAll = true;
        } else {
            for (const each of access) {
                this.#websFor.add(each);
            }
        }

        if (this.#websTimer !== undefined) {
            return;
        }

        this.#websTimer = setTimeout(() => {
            const changed = [...this.#websFor];
            const all = this.#websAll;

            this.#websTimer = undefined;
            this.#websFor.clear();
            this.#websAll = false;
            void this.#refreshClients(
                (user) => all || changed.some((each) => this.policy.mayUseExtension(user, each)),
            );
        }, 50);
    }

    /** While an update moves Pi Pocket's checkout, edited web files and modules load nothing (`updates.ts`). */
    reloadsPaused = false;

    pauseReloads(paused: boolean): void {
        this.reloadsPaused = paused;
        this.loader?.pause(paused);
        this.themes?.pause(paused);
    }

    /** Write a line to the server log. */
    log(line: string): void {
        this.#log(line);
    }

    static async open(options: OpenOptions): Promise<PocketApp> {
        const app = new PocketApp(options);

        try {
            await app.#open();
        } catch (error) {
            if (app.#releaseLock !== undefined) {
                await app.close();
            }

            throw error;
        }

        return app;
    }

    async #open(): Promise<void> {
        this.#releaseLock = takeLock(this.#lockFile);

        try {
            this.pushStore = new PushStore(this.dataDir);
        } catch (error) {
            this.#log(`Push notifications are off: ${describe(error)}`);
        }

        this.settings = SettingsManager.create(this.defaultCwd);

        try {
            configureHttp(
                this.settings.getHttpIdleTimeoutMs() || 2_147_483_647,
                this.settings.getGlobalSettings().httpProxy,
            );
        } catch (error) {
            this.#log(`HTTP setup failed, using Node defaults: ${describe(error)}`);
        }

        this.models = await ModelRuntime.create();
        // Innermost: observe the adapter payload only after the caller and all extension shapers finish.
        this.cacheKeeper.installPayloadObserver(this.models);
        installRequestShaping(this.models, this.#shapers, this.#log);
        this.providers.modelRefresh.watch(this.models);
        this.#configureModels?.(this.models);
        measureModelStreams(this.models);
        // Outside the timing wrapper: each attempt is timed on its own, not the wait before it.
        this.limits.install(this.models);
        // Outermost: it sees each real request finish, and replays it through the wrappers below.
        this.cacheKeeper.install(this.models);
        await this.models.getAvailable().catch(() => []);

        const registry = createRegistry();

        registry.install(CodingTools);
        // Durable work of the app itself, whatever extension modules are on.
        registry.install(
            defineExtension({
                name: "pocket-core",
                tasks: [
                    ResendTask,
                    this.commands.interruptTask,
                    this.shell.task,
                    this.commands.followTask,
                    this.extensionCommands.task,
                ],
                // Values extensions hide (`host.hide`) leave every tool's result before it is stored.
                hooks: [
                    hook(ToolTask, {
                        afterTool: async (call, result, api) => {
                            // A context file or skill Pi wrote on another computer counts from the next request.
                            if (
                                (call.name === "write" || call.name === "edit") &&
                                typeof call.arguments?.path === "string"
                            ) {
                                this.#projectFileChanged(api.conversationId, call.arguments.path);

                                if (!result.isError) {
                                    await this.workspace
                                        .copyRunnerImage(api.conversationId, call.arguments.path)
                                        .catch((error: unknown) => {
                                            // A failed offline copy must not turn a successful write into a failed tool.
                                            this.#log(
                                                `Could not keep a runner image: ${describe(error)}`,
                                            );
                                        });
                                }
                            }

                            const cleaned = this.hidden.result(result, api.conversationId);

                            return cleaned === result ? undefined : cleaned;
                        },
                    }),
                ],
            }),
        );
        const host: PocketHost = {
            guard: this.guard,
            approvals: this.approvals,
            agentDir: getAgentDir(),
            dataDir: this.dataDir,
            pocketVersion: pocketVersion(),
            modelInfo: (spec) => modelInfo(this.models, spec),
            skillPaths: () => {
                try {
                    return this.settings.getSkillPaths();
                } catch {
                    return [];
                }
            },
            skills: (cwd) => this.skills(cwd),
            resolveModel: (spec) => resolveModel(this.models, spec, this.signInNeeded),
            subagentModels: () => this.config.subagentModels,
            modelProblem: (ref, fresh) => this.providers.problem(ref, fresh),
            registerModelProvider: (provider, config) =>
                this.#registerModelProvider(provider, config),
            registerWorkspaceProvider: (scheme, provider) =>
                this.registerWorkspaceProvider(scheme, provider),
            registerPiSessionCompanion: (companion) => this.piSessions.registerCompanion(companion),
            shapeModelRequests: (shape) => {
                this.#shapers.push(shape);

                return () => {
                    const index = this.#shapers.indexOf(shape);

                    if (index >= 0) {
                        this.#shapers.splice(index, 1);
                    }
                };
            },
            fetchPublic: createPublicFetch(),
            requesterOf: (conversationId) => this.attribution.requesterOf(conversationId),
            runnerOf: (conversationId) => this.runnerOf(conversationId),
            envFor: (conversationId) => this.envFor(conversationId),
            roleOf: (personId) => this.config.userById(personId)?.role,
            on: (event, listener) => this.events.on(event, listener),
            ask: (request, askContext) => ask(this.approvals, request, askContext),
            hide: (value) => this.hidden.add(value),
            commandEnv: (provider) => this.commandEnvs.add(provider),
            browser: (conversationId, options) =>
                browserFor(
                    this.browsers,
                    () => this.browserOn(),
                    Number(conversationId),
                    options?.open === true,
                ),
            notice: (level, message, conversationId) => this.notice(level, message, conversationId),
            heldBack: (conversationId) => this.spend.heldBack(conversationId),
            onLimitsChanged: (listener) => this.spend.onLimitsChanged(listener),
            linkedSessions: this.linkedSessions,
            sessions: this.extensionSessions,
            cwdOf: (conversationId) => this.cwdOf(conversationId),
            schedules: this.schedules,
            background: this.background,
            goals: this.goals,
            browsers: this.browsers,
            pip: this.pip,
            pipCompaction: this.pipCompaction,
            watches: this.watches,
            repoWatches: this.repoWatches,
            memory: this.memory,
            gallery: this.gallery,
            updates: this.updates,
            text: Object.freeze({ quoted, defang }),
            thinkingLevels: THINKING_LEVELS,
            toolNames: () =>
                registry
                    .snapshot()
                    .tools()
                    .map(({ tool }) => tool.name),
        };

        this.#registry = registry;
        const dropIn = join(this.dataDir, "extensions");

        try {
            prepareDropInFolder(
                dropIn,
                modulesWith("@earendil-works/pi-durable"),
                Object.fromEntries(
                    Object.keys(pocketPackage.dependencies ?? {}).map((name) => [
                        name,
                        modulesWith(name),
                    ]),
                ),
            );
        } catch (error) {
            this.#log(`Drop-in extensions cannot import Pi Pocket's packages: ${describe(error)}`);
        }

        try {
            linkTypes(dropIn, join(APP_ROOT, "types", "pocket.d.ts"));
        } catch (error) {
            this.#log(`The drop-in folder has no _pocket.d.ts: ${describe(error)}`);
        }

        this.loader = new ExtensionLoader(
            registry,
            host,
            { builtIn: join(APP_ROOT, "src", "server", "extensions"), dropIn },
            (file) => this.config.extensionChoice(file),
            // What a module's load says can name the server's folders, or quote a provider: the owner's to read.
            {
                webs: this.webs,
                notify: (level, message) => this.ownerNotice(level, message),
                // A drop-in that says `remoteSessions` came or went: sessions on other computers get it, or lose it.
                onChange: () => this.#tuneRemoteSoon(),
            },
        );
        await this.themes.load().catch((error: unknown) => {
            this.#log(`Themes could not be read: ${describe(error)}`);
        });
        // A gallery update the server stopped in the middle of goes back first, so no extension loads half of one, and
        // a theme it had out of its folder is back before the owner's default is checked.
        await this.gallery.recover().catch((error: unknown) => {
            this.#log(`The extension gallery could not check its updates: ${describe(error)}`);
        });
        await this.#themeDefaultStillHere();
        await this.loader.loadAll();

        const storage = await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite"));

        this.#openingStorage = storage;
        this.harness = await Harness.open(
            storage,
            {
                models: this.models,
                registry,
                settings: this.#harnessSettings(),
                now: this.now,
                env: async ({ conversationId, cwd }, context) => {
                    // Offline is offline (`docs/runners.md`): a turn or tool call of a session on another computer waits
                    // here until that computer is back, rather than failing. Stop ends the wait.
                    const runner = this.runnerOf(conversationId);

                    if (runner !== undefined) {
                        await this.runners.link(runner).whenOnline(context.abortSignal);
                        // The files its messages brought are there before Pi looks for them.
                        await this.#uploads.get(conversationId as ConversationId);
                    }

                    return this.#wrapped(conversationId, cwd ?? this.defaultCwd);
                },
                conversationCreated: async (tx, conversation) => {
                    // Every conversation gets the app's documents up front, so views can read them from the start.
                    await tx.doc(AuthorsDoc, conversation.id);
                    await tx.doc(ArtifactsDoc, conversation.id);
                    await tx.doc(SubagentsDoc, conversation.id);
                },
                onReport: (report) => this.notice("warning", describe(report.error)),
            },
            context,
        );

        this.#openingStorage = undefined;
        const conversations = await this.#recover(storage);

        await this.spend.load(conversations);
        // Sessions kept warm before a restart go on, while their caches live.
        void this.cacheKeeper
            .restore()
            .catch((error: unknown) => this.#log(`Keep warm not restored: ${describe(error)}`));

        // An observer that throws is detached for good: one commit's error must not stop the app hearing of the rest.
        const commits = this.harness.observeCommits({
            advance: (publication) => {
                try {
                    this.#committed(publication);
                } catch (error) {
                    this.notice("warning", describe(error));
                }
            },
            end: () => {},
        });

        this.#unsubscribeCommits = () => commits.detach();
        // A removal a restart cut short: what is still saved for someone no longer here goes to who is in charge. After
        // the observer, so what is kept in memory follows.
        await this.#handOverGone();
        this.#unsubscribeRunEnds = this.linkedSessions.watch();
        this.#unsubscribeApprovals = this.approvals.subscribe((id) => {
            void this.#rooms.get(id)?.then(
                (room) => room.schedule(),
                () => {},
            );
            const root = this.rootOf(id);

            // A subagent's call waits on its session's peek tile too.
            if (root !== id) {
                void this.#rooms.get(root)?.then(
                    (room) => room.schedulePeek(),
                    () => {},
                );
            }

            this.#scheduleSessions();
            this.alerts.announceApprovals();
        });
        // A browser page's address, title, and loading go to the tabs watching its conversation, as they change.
        this.#unsubscribeBrowsers = this.browsers.subscribe((id, state) => {
            const conversationId = id as unknown as ConversationId;

            void this.#rooms.get(conversationId)?.then(
                (room) => {
                    for (const client of room.clients) {
                        client.send("browser", this.#browserEvent(conversationId, state));
                    }
                },
                () => {},
            );
        });

        if (this.guardOn()) {
            void this.guard.warm().catch(() => {});
        }

        await this.pip.tuneAll((line) => this.#log(line));
        await this.#tuneRemote();
        // Work a previous process left unfinished continues now.
        this.harness.resume();
    }

    /**
     * What this process keeps in memory about every conversation, read back from storage at startup: which are busy,
     * their agents, chat, subagents, and who Pi works for in each. Authors a crash kept out of the authors documents are
     * written back, in one commit. Returns every conversation's id.
     */
    async #recover(storage: Storage): Promise<ConversationId[]> {
        this.#sessions = { ...((await this.harness.snapshot(SessionsDoc, context))?.items ?? {}) };
        const conversations: ConversationId[] = [];
        const unrecorded = new Map<ConversationId, Missing[]>();
        let cursor: Cursor | undefined;

        do {
            const page = await this.harness.commit(
                (tx) => tx.scanConversations({}, 256, cursor),
                context,
            );

            for (const { id } of page.items) {
                conversations.push(id);
                const live = await this.harness.snapshot(LiveDoc, id, context);

                if (live?.run !== undefined) {
                    this.#busy.add(id);
                }

                if (this.#sessions[String(id)] !== undefined) {
                    // The settled submission is what lasted. The failure line is written after it, so a crash can leave
                    // that line missing or stale: this puts it back, or clears it when a run is still going.
                    const failure = await this.#failureOf(storage, id, live);

                    if (failure !== undefined) {
                        this.#failed.set(id, failure);
                    }
                }

                // A compaction that resumes asks the model too: it may wait for a limit.
                if ((live?.compactions?.length ?? 0) > 0) {
                    this.#compacting.add(id);
                }

                const agent = await this.harness.snapshot(AgentDoc, id, context);

                if (agent !== undefined) {
                    this.#agents.set(id, agent as AgentState);
                }

                this.#noteChat(id, (await this.harness.snapshot(ChatDoc, id, context))?.messages);
                const missing = await this.attribution.recover(
                    storage,
                    id,
                    await this.harness.snapshot(AuthorsDoc, id, context),
                );

                if (missing.length > 0) {
                    unrecorded.set(id, missing);
                }

                this.#noteSubagents(id, await this.harness.snapshot(SubagentsDoc, id, context));
                this.#noteBackground(id, await this.harness.snapshot(BackgroundDoc, id, context));
            }

            cursor = page.next;
        } while (cursor !== undefined);

        await this.attribution.repair(unrecorded);

        return conversations;
    }

    /** Every commit, as Pi Durable publishes it: what the app keeps in memory follows it, and so do the open views. */
    #committed(publication: CommitPublication): void {
        let sessionsChanged = false;
        let alreadyPaid = false;
        // How each run in this commit stopped, read before the live document ends it: both land here, in either order.
        const failedNow = new Map<ConversationId, string>();
        const abortedNow = new Set<ConversationId>();

        for (const change of publication.changes) {
            if (change.type !== "submission") {
                continue;
            }

            const text = failureText(change.value.status, change.value.reason, change.value.detail);

            if (text !== undefined) {
                failedNow.set(change.value.conversationId, text);
            } else if (change.value.status === "unanswered" && change.value.reason === "aborted") {
                abortedNow.add(change.value.conversationId);
            }
        }

        // Auxiliary requests pay their captured person in the same commit as usage, in either document order.
        // A commit with both documents must pay every usage change. Normal spend counts never change UsageDoc.
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === SpendDoc.definition.kind &&
                change.kind === "change"
            ) {
                this.spend.countedChanged(change.value as { people: Record<string, number> });
                alreadyPaid = true;
            }
        }

        // Usage in a commit is from the work that was going on before it: it is counted before a message the same
        // commit places changes whom Pi works for.
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === UsageDoc.definition.kind &&
                change.conversationId !== undefined
            ) {
                this.spend.usageChanged(
                    change.conversationId,
                    change.kind === "change" ? (change.value as UsageState) : null,
                    alreadyPaid,
                );

                // A team's top session with a limit shows the team's spend: it follows a linked session's too.
                const root = this.rootOf(change.conversationId);
                const top = this.spend.teamRoot(root);

                if (top !== root && this.#sessions[String(top)]?.budget !== undefined) {
                    void this.#rooms.get(top)?.then(
                        (room) => room.schedule(),
                        () => {},
                    );
                }
            }
        }

        for (const change of publication.changes) {
            if (change.type === "document") {
                if (this.#documentCommitted(change, failedNow, abortedNow)) {
                    sessionsChanged = true;
                }
            } else if (change.type === "submission") {
                this.attribution.submissionCommitted(change.value);

                // A run that failed because its provider's sign-in could not be renewed marks that provider; one that
                // was answered shows its provider works, and a mark it had (signed in again in Pi's terminal app, say)
                // is asked again.
                if (change.value.status === "unanswered" && change.value.reason === "model_error") {
                    this.providers.runFailed(change.value.detail);
                } else if (change.value.status === "done") {
                    const provider = this.#agents.get(change.value.conversationId)?.model?.provider;

                    if (provider !== undefined) {
                        this.providers.runAnswered(provider);
                    }
                }

                // Its run failed: the commit that settles it ends the run too, so the list hears of both at once.
                // The line is stored too, so the next process still knows; a new run clears that record.
                const text = failedNow.get(change.value.conversationId);

                if (
                    text !== undefined &&
                    this.#sessions[String(change.value.conversationId)] !== undefined &&
                    !this.#failed.has(change.value.conversationId)
                ) {
                    this.#failed.set(change.value.conversationId, text);
                    this.#storeRunFailure(change.value.conversationId, text);
                    sessionsChanged = true;
                }
            }
        }

        if (sessionsChanged) {
            this.#scheduleSessions();
        }
    }

    /**
     * Pi started work in session `id` at `at`: it moves up the list, as a message sent there does, whatever started it
     * (a scheduled message, a subagent's report, a message sent again after a restart). One moved up since `at` (a
     * message through `Commands.submit` moves it too) is left as it is. A commit listener may not commit, so this commits
     * after it.
     */
    #movedUp(id: ConversationId, at: number): void {
        setImmediate(() => {
            this.harness
                .commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta !== undefined && meta.updatedAt < at) {
                        meta.updatedAt = Date.now();
                    }
                }, context)
                .catch((error: unknown) => this.log(`session not moved up: ${describe(error)}`));
        });
    }

    /** A document changed: the views that show it update. True when the session list changed too. */
    #documentCommitted(
        change: Extract<DocumentCommitChange, { type: "document" }>,
        failedNow: ReadonlyMap<ConversationId, string>,
        abortedNow: ReadonlySet<ConversationId>,
    ): boolean {
        const kind = change.record.kind;
        const id = change.conversationId;
        // A retired document reads as none.
        const value = change.kind === "change" ? change.value : null;
        let sessionsChanged = false;

        if (
            kind === BackgroundDoc.definition.kind &&
            id !== undefined &&
            this.#noteBackground(id, value as { items: Record<string, BackgroundTask> } | null)
        ) {
            sessionsChanged = true;
        }

        if (kind === "pi.live" && id !== undefined) {
            const busy = (value as LiveState | null)?.run !== undefined;

            // A compaction asks the model too (an idle session's manual one has no run): it may wait for a limit.
            if (((value as LiveState | null)?.compactions?.length ?? 0) > 0) {
                // A compaction rewrites the context: the cache kept warm is not read again.
                if (!this.#compacting.has(id)) {
                    this.cacheKeeper.forget(Number(id), "the context was compacted");
                }

                this.#compacting.add(id);
            } else {
                this.#compacting.delete(id);
            }

            if (busy !== this.#busy.has(id)) {
                const session = Number(this.rootOf(id));
                const failure = busy ? undefined : (failedNow.get(id) ?? this.#failed.get(id));
                const outcome =
                    failure !== undefined ? "failed" : abortedNow.has(id) ? "aborted" : "done";

                // For extensions (`host.on`): PiP's runs are its person's alone.
                if (this.#sessions[String(session)]?.pip === undefined) {
                    this.events.emit(busy ? "run.started" : "run.ended", {
                        conversationId: Number(id),
                        session,
                        ...(busy
                            ? {}
                            : {
                                  outcome,
                                  ...(failure === undefined ? {} : { failure }),
                              }),
                    });
                }

                if (busy) {
                    this.#busy.add(id);
                    this.cacheKeeper.runStarted(Number(id));
                    // A new run starts over: whether it fails is its own to say.
                    this.#failed.delete(id);
                    this.#storeRunFailure(id, undefined);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#movedUp(id, Date.now());
                    }
                } else {
                    this.#busy.delete(id);
                }

                sessionsChanged = true;
                this.alerts.runChanged(id, busy);

                if (!busy) {
                    this.spend.runEnded(id);
                    // No request follows the last tool call of a run that ended or was stopped (PiP's runs too).
                    this.cacheKeeper.runEnded(Number(id));
                    this.pipCompaction.runEnded(id);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#endedAt.set(id, Date.now());
                    }
                }

                // A parent shows its subagents' busy state.
                for (const pending of this.#rooms.values()) {
                    void pending.then((room) => {
                        if (
                            Object.values(room.subagents).some(
                                (record) => record.conversationId === id,
                            )
                        ) {
                            room.schedule();
                        }
                    });
                }
            }
        } else if (kind === "pi.agent" && id !== undefined) {
            if (value !== null) {
                const was = this.#agents.get(id)?.model;
                const now = (value as AgentState).model;

                // Another model: the next request does not read this cache.
                if (
                    was !== undefined &&
                    (was.provider !== now?.provider || was.modelId !== now?.modelId)
                ) {
                    this.cacheKeeper.forget(Number(id), "the model changed");
                }

                this.#agents.set(id, value as AgentState);
            }

            const parent = this.#parents.get(id);

            // A subagent's row in its parent's subagents bar shows its model.
            if (parent !== undefined) {
                void this.#rooms.get(parent)?.then(
                    (room) => room.schedule(),
                    () => {},
                );
            }

            sessionsChanged = true;
        } else if (kind === SessionsDoc.definition.kind) {
            const before = this.#sessions;

            this.#sessions = {
                ...((value as { items?: Record<string, SessionMeta> } | null)?.items ?? {}),
            };
            sessionsChanged = true;
            this.#sessionEvents(before, this.#sessions);

            // Someone taken off a session's share list leaves it at once, before the list is sent again. So does who
            // saw a session by its folder (`access.ts` `seesFolder`) when it moved to another one, or to another
            // computer, or the worktree it works in is no longer there.
            if (
                Object.entries(before).some(([key, was]) => {
                    const now = this.#sessions[key];

                    return (
                        (was.sharedWith ?? []).some(
                            (person) => !(now?.sharedWith ?? []).includes(person),
                        ) ||
                        (now === undefined
                            ? was.worktree !== undefined
                            : now.cwd !== was.cwd ||
                              now.runner !== was.runner ||
                              now.worktree?.path !== was.worktree?.path ||
                              now.worktree?.source !== was.worktree?.source)
                    );
                })
            ) {
                this.accessChanged();
            }

            // Views show a session's title, limit, and worktree from here.
            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.schedule(),
                    () => {},
                );
            }
        } else if (kind === FolderFavoritesDoc.definition.kind) {
            this.folderFavorites.committed(value as FolderFavoritesValue | null);
        } else if (kind === MemoryDoc.definition.kind) {
            this.memory.committed();
        } else if (ROOM_DOCS.has(kind) && id !== undefined) {
            if (kind === ChatDoc.definition.kind) {
                if (this.#noteChat(id, (value as { messages?: ChatMessage[] } | null)?.messages)) {
                    sessionsChanged = true;
                }
            } else if (kind === SubagentsDoc.definition.kind) {
                this.#noteSubagents(id, value as SubagentsValue | null);
                // The list counts each session's subagents, and the board lists them.
                sessionsChanged = true;
            }

            void this.#rooms.get(id)?.then(
                (room) => room.setDoc(kind, value as Record<string, unknown> | null),
                () => {},
            );

            if (kind === TurnsDoc.definition.kind) {
                if (value === null) {
                    this.#turns.delete(String(id));
                } else {
                    this.#turns.set(String(id), value as { on: boolean; driver?: string });
                }

                for (const pending of this.#rooms.values()) {
                    void pending.then(
                        (room) => {
                            if (room.id !== id && this.rootOf(room.id) === id) {
                                room.setDoc(kind, value as Record<string, unknown> | null);
                            }
                        },
                        () => {},
                    );
                }
            }
        }

        return sessionsChanged;
    }

    /** How model requests stream here: Pi's timeout and retries. Pi Durable's requests and PiP's summaries use them. */
    streamSettings(): { timeoutMs: number; maxRetryDelayMs?: number; maxRetries?: number } {
        const read = <T>(get: () => T): T | undefined => {
            try {
                return get();
            } catch {
                return undefined;
            }
        };

        const provider = read(() => this.settings.getProviderRetrySettings());
        const idle = read(() => this.settings.getHttpIdleTimeoutMs()) ?? 300_000;

        return {
            timeoutMs: provider?.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
            ...(provider?.maxRetryDelayMs === undefined
                ? {}
                : { maxRetryDelayMs: provider.maxRetryDelayMs }),
            ...(provider?.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
        };
    }

    #harnessSettings(): HarnessSettings {
        const settings = this.settings;

        const safe = <T>(read: () => T): T | undefined => {
            try {
                return read();
            } catch {
                return undefined;
            }
        };

        const registry = () => this.#registry;
        const stream = () => this.streamSettings();
        const compaction = compactionReader(settings, (line) => this.#log(line));

        return {
            // A phase can wait for hours without changing state; repeated process kills must not park it.
            restartLimit: Infinity,
            // Every installed extension, in install order, but PiP's: its tools and prompt are for its conversation only,
            // which selects it by name (`pip.ts`).
            get extensions() {
                return registry()
                    ?.snapshot()
                    .installed()
                    .filter((extension) => extension.name !== PIP_EXTENSION);
            },
            get stream() {
                return stream();
            },
            get compaction() {
                return safe(compaction) ?? {};
            },
            get retry() {
                return safe(() => settings.getRetrySettings()) ?? {};
            },
            // Every message that waits goes in at once, so a queue of agents' messages and reports costs one turn, not
            // one each. Pi's own setting, when the owner set one, still wins.
            get steeringMode() {
                return safe(() => settings.getSettings().steeringMode) ?? "all";
            },
            get followUpMode() {
                return safe(() => settings.getSettings().followUpMode) ?? "all";
            },
        } as HarnessSettings;
    }

    /** What changed in the session list, as events for extensions (`host.on`). PiP's conversations send none. */
    #sessionEvents(before: Record<string, SessionMeta>, after: Record<string, SessionMeta>): void {
        for (const [key, meta] of Object.entries(after)) {
            const was = before[key];
            const conversationId = Number(key);

            if (meta.pip !== undefined) {
                continue;
            }

            if (was === undefined) {
                this.events.emit("session.created", {
                    conversationId,
                    cwd: meta.cwd,
                    ...(meta.createdBy === undefined ? {} : { createdBy: meta.createdBy }),
                    ...(meta.forkedFrom === undefined ? {} : { forkedFrom: meta.forkedFrom.id }),
                    ...(meta.linkedFrom === undefined ? {} : { linkedFrom: meta.linkedFrom.id }),
                });
                continue;
            }

            if ((meta.title ?? "") !== (was.title ?? "") && meta.title !== undefined) {
                this.events.emit("session.renamed", { conversationId, title: meta.title });
            }

            if ((meta.archived === true) !== (was.archived === true)) {
                // Its subagents too: none of them is kept warm, nor refreshed on the way.
                if (meta.archived === true) {
                    for (const each of this.conversationsOf(conversationId as ConversationId)) {
                        this.cacheKeeper.forget(Number(each), "the session was archived");
                    }
                }

                this.events.emit("session.archived", {
                    conversationId,
                    archived: meta.archived === true,
                });
            }
        }
    }

    registerWorkspaceProvider(scheme: string, provider: WorkspaceProvider): () => void {
        if (
            !/^[a-z][a-z0-9+.-]+$/i.test(scheme) ||
            typeof provider?.env !== "function" ||
            typeof provider?.resolveCwd !== "function"
        ) {
            throw new Error("Invalid workspace provider registration");
        }

        const key = scheme.toLowerCase();
        const token = Symbol(key);
        const registrations = this.#workspaceProviders.get(key) ?? [];

        registrations.push({ token, provider });
        this.#workspaceProviders.set(key, registrations);

        return () => {
            const live = this.#workspaceProviders.get(key);
            const index = live?.findIndex((entry) => entry.token === token) ?? -1;

            if (index >= 0) {
                live!.splice(index, 1);

                if (live!.length === 0) {
                    this.#workspaceProviders.delete(key);
                }
            }
        };
    }

    workspaceScheme(cwd: string): string | undefined {
        return workspaceScheme(cwd);
    }

    /** A workspace URI reaches a provider's machines and keys: they are the owner's. */
    requireWorkspaceOwner(user: User, cwd: string): void {
        if (!this.policy.mayUseWorkspaces(user) && this.workspaceScheme(cwd.trim()) !== undefined) {
            throw new HttpError(403, "Only the owner can use a remote workspace.");
        }
    }

    async resolveCwd(cwd: string, signal?: AbortSignal): Promise<string> {
        const scheme = this.workspaceScheme(cwd);

        if (scheme === undefined) {
            return this.workspace.checkDirectory(cwd);
        }

        const registration = this.#workspaceProviders.get(scheme)?.at(-1);

        // 400, not 503: an unknown scheme and a provider module that is off look the same here.
        // Only the owner can fix either one, and a retry does not help.
        if (registration === undefined) {
            throw new HttpError(
                400,
                `No workspace provider is registered for URI scheme ${scheme}`,
            );
        }

        signal?.throwIfAborted();
        const canonical = await registration.provider.resolveCwd(cwd, signal);

        if (this.#workspaceProviders.get(scheme)?.at(-1)?.token !== registration.token) {
            throw new HttpError(
                409,
                `Workspace provider ${scheme} changed while resolving the workspace URI`,
            );
        }

        signal?.throwIfAborted();

        if (typeof canonical !== "string" || this.workspaceScheme(canonical) !== scheme) {
            throw new Error(`Workspace provider ${scheme} returned an invalid canonical URI`);
        }

        return canonical;
    }

    /**
     * Where a conversation's commands run: its folder here, its workspace provider's env, or the computer its session
     * runs on.
     */
    envFor(id: ConversationId): ExecutionEnv {
        return this.#wrapped(id, this.cwdOf(id));
    }

    /**
     * The computer a conversation's tools run on: its session's runner, for the session and every subagent under it.
     * Undefined: this machine.
     */
    runnerOf(id: ConversationId): string | undefined {
        return this.#sessions[String(this.rootOf(id))]?.runner;
    }

    /**
     * All subagents use their root session permission. A worktree keeps its source folder's permission: the worktree
     * is in that permission's own runner folder. `cwd` checks a move before it is saved. Old sessions ask once.
     */
    /**
     * A session's permission id on its computer (`runnerScope`), without the access check: for what shows or cleans up,
     * never for what runs there.
     */
    runnerPermission(id: ConversationId): string {
        const root = this.rootOf(id);

        return this.#sessions[String(root)]?.runnerPermission ?? String(root);
    }

    runnerScope(id: ConversationId, cwd?: string) {
        const root = this.rootOf(id);
        const meta = this.#sessions[String(root)];

        // Everything a session does on its computer goes through this scope, so it runs only while the person who
        // started it may still use that computer (`Runners.mayUse`): a removed grant, a person made a viewer, or a
        // removed person stops their sessions there, also ones already running, their subagents, and their schedules.
        if (meta?.runner !== undefined) {
            this.requireRunnerAccess(meta);
        }

        const folder = cwd ?? this.cwdOf(root);
        const path =
            meta?.runner !== undefined && this.runners.link(meta.runner).platform().os === "windows"
                ? win32
                : posix;
        const relative =
            meta?.worktree === undefined ? undefined : path.relative(meta.worktree.path, folder);
        const inWorktree =
            relative !== undefined &&
            relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative);

        return {
            id: meta?.runnerPermission ?? String(root),
            folder: inWorktree ? meta!.worktree!.source : folder,
            person: this.config.userById(meta?.createdBy ?? "")?.name ?? "The owner",
        };
    }

    /**
     * The extensions a session on another computer runs with: the built-in list (`REMOTE_EXTENSIONS`), then the drop-ins
     * that say they work there (`export const remoteSessions = true`, `reload.ts`).
     */
    remoteExtensions(): string[] {
        return [...new Set([...REMOTE_EXTENSIONS, ...this.loader.remoteNames()])];
    }

    /** What conversation `id` on another computer runs with: a subagent has its session's list, less its own. */
    #remoteListOf(id: ConversationId): string[] {
        const all = this.remoteExtensions();

        return this.#parents.has(id)
            ? all.filter((name) => !REMOTE_SUBAGENT_WITHOUT.includes(name))
            : all;
    }

    /** `#tuneRemote` once a burst of extension changes settled (a reload of several drop-ins). */
    #tuneRemoteSoon(): void {
        // While the server starts, `open` tunes them once everything loaded.
        if (this.harness === undefined || this.#closing !== undefined) {
            return;
        }

        clearTimeout(this.#tuneTimer);
        this.#tuneTimer = setTimeout(() => {
            this.#tuneTimer = undefined;

            if (this.#closing !== undefined) {
                return;
            }

            void this.#tuneRemote().catch((error: unknown) => {
                this.#log(
                    `Sessions on other computers could not get their extensions: ${describe(error)}`,
                );
            });
        }, 200);
        this.#tuneTimer.unref();
    }

    /**
     * Give every conversation on another computer the list it runs with now (`remoteExtensions`): drop-ins that came or
     * went, and built-ins added to the list since it was made. One commit, only for those whose list differs.
     */
    async #tuneRemote(): Promise<void> {
        const stale = [...this.#agents]
            .filter(([id, agent]) => {
                if (this.runnerOf(id) === undefined || !Array.isArray(agent.extensions)) {
                    return false;
                }

                return JSON.stringify(agent.extensions) !== JSON.stringify(this.#remoteListOf(id));
            })
            .map(([id]) => id);

        if (stale.length === 0) {
            return;
        }

        await this.harness.commit(async (tx) => {
            for (const id of stale) {
                (await tx.doc(AgentDoc, id)).extensions = this.#remoteListOf(id);
            }
        }, context);
    }

    /**
     * Note that files a message brought are being copied to session `id`'s computer (`commands.ts`): its turns and
     * tool calls wait for the copy (the Harness's `env`). Copies of one session run one after another.
     */
    uploadsCopied(id: ConversationId, copy: Promise<void>): void {
        const before = this.#uploads.get(id) ?? Promise.resolve();
        const after = before.then(() => copy).catch(() => {});

        this.#uploads.set(id, after);
        void after.then(() => {
            if (this.#uploads.get(id) === after) {
                this.#uploads.delete(id);
            }
        });
    }

    /**
     * A folder's environment, with what extensions add to each command and hide from its output in this session. A
     * session on another computer gets that computer's, never this machine's: when it is offline, what uses it waits.
     */
    #wrapped(id: ConversationId, cwd: string): ExecutionEnv {
        const runner = this.runnerOf(id);
        const base =
            runner === undefined
                ? this.#env(cwd)
                : this.runners.env(runner, cwd, this.runnerScope(id));

        return wrapEnv(base, Number(id), cwd, this.commandEnvs, this.hidden);
    }

    /**
     * The computers list changed (linked, removed, online, away, access): tell each person their list, and when one came or went,
     * everyone who sees its sessions (the session list's offline mark, a session's "offline, reconnecting…").
     */
    #runnersChanged(): void {
        const list = this.runners.list();

        for (const client of this.#clients) {
            // An empty list also clears computers this person can no longer use.
            client.send("runners", this.runners.list(client.user));

            const server = this.thisServer(client.user);

            if (server !== undefined) {
                client.send("this-server", server);
            }
        }

        const online = new Set(list.filter((runner) => runner.online).map((runner) => runner.id));
        const before = this.#runnersOnline;

        this.#runnersOnline = online;

        if (before.size === online.size && [...online].every((id) => before.has(id))) {
            return;
        }

        this.#scheduleSessions();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => {
                    if (this.runnerOf(room.id) !== undefined) {
                        room.schedule();
                    }
                },
                () => {},
            );
        }
    }

    /** Which computers were online when the list last changed (`#runnersChanged`). */
    #runnersOnline = new Set<string>();

    #env(cwd: string): ExecutionEnv {
        const scheme = this.workspaceScheme(cwd);

        if (scheme !== undefined) {
            const provider = this.#workspaceProviders.get(scheme)?.at(-1)?.provider;

            if (provider === undefined) {
                throw new Error(`No workspace provider is registered for URI scheme ${scheme}`);
            }

            return provider.env(cwd);
        }

        let env = this.#envs.get(cwd);

        if (env === undefined) {
            env = new NodeExecutionEnv({ cwd });
            this.#envs.set(cwd, env);
        }

        return env;
    }

    // ─── Clients ────────────────────────────────────────────────────────────

    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            // Server-wide notices can name this server's folders and sessions: only whoever may use this server gets
            // them. One about PiP reaches the tabs with its panel open too: the panel has no notices of its own.
            const reaches =
                conversationId === undefined
                    ? this.policy.mayUse(client.user, THIS_SERVER)
                    : (client.conversationId === conversationId ||
                          client.pip?.conversationId === conversationId) &&
                      this.canSee(client.user, conversationId);

            if (reaches) {
                client.send("notice", { level, message });
            }
        }
    }

    /** A notice for the owner's tabs alone: about what only they may change. */
    ownerNotice(level: "info" | "warning" | "error", message: string): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            if (client.user.role === "owner") {
                client.send("notice", { level, message });
            }
        }
    }

    /** Conversations with a compaction going: its request may wait for a limit too. */
    readonly #compacting = new Set<ConversationId>();

    /** The conversation whose generation or compaction sends requests under a provider session id: only those wait. */
    async #conversationOfSession(sessionId: string): Promise<number | undefined> {
        for (const id of new Set([...this.#busy, ...this.#compacting])) {
            const mine = await this.harness
                .snapshot(ProviderDoc, id, context)
                .catch(() => undefined);

            if (mine?.sessionId === sessionId) {
                return Number(id);
            }
        }

        return undefined;
    }

    /** Conversations that were in a wait for a limit, or are now: their views and the session list show the change. */
    #limitWaiting = new Set<number>();

    /** A conversation's keep warm started, refreshed, or stopped: its session's view shows it. */
    #keepWarmChanged(id: ConversationId): void {
        void this.#rooms.get(this.rootOf(id))?.then(
            (open) => open.schedule(),
            () => {},
        );
    }

    #limitsChanged(): void {
        const now = new Set(this.limits.waits().map((wait) => wait.conversationId));
        const changed = new Set([...this.#limitWaiting, ...now]);

        this.#limitWaiting = now;

        for (const id of changed) {
            const conversation = id as unknown as ConversationId;

            // A subagent's wait shows in its session's subagents bar too.
            for (const room of new Set([conversation, this.rootOf(conversation)])) {
                void this.#rooms.get(room)?.then(
                    (open) => open.schedule(),
                    () => {},
                );
            }
        }

        if (changed.size > 0) {
            this.#scheduleSessions();
        }
    }

    /** Every open view builds itself again: what it shows from outside its documents changed (a model's sign-in). */
    refreshViews(): void {
        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.schedule(),
                () => {},
            );
        }
    }

    /** Every connected tab. */
    get clients(): ReadonlySet<Client> {
        return this.#clients;
    }

    /** Tell every browser to reload, after a web file changed. */
    reloadClients(file: string): void {
        for (const client of this.#clients) {
            client.send("reload", { file });
        }
    }

    /**
     * Start sending a tab its events. The tab may close during the waits here (opening a room, or the guard's status
     * right after a restart, when every browser reconnects at once): `detach` has then run, and the tab must not be added.
     */
    async attach(client: Client): Promise<void> {
        const arriving = !this.#online(client.user.id);

        this.#clients.add(client);
        const hello = await this.hello(client.user);

        if (!this.#clients.has(client)) {
            return;
        }

        client.send("hello", this.#helloFor(client, hello));
        this.#sendSessions(client, this.sessions(client.user));
        this.#sendPip(client);

        if (client.user.role === "owner" && this.themes.failure !== undefined) {
            client.send("notice", { level: "warning", message: this.themes.failure });
        }

        if (arriving) {
            this.#peopleChanged(client.user.id);
        }

        await this.#enter(client);
    }

    /**
     * Show a tab another session, or none (the list), on the connection it has (`connection`, the id its `hello`
     * carried): it leaves the room of the one it showed, and gets what the new one has as a new connection would, with
     * what it kept of it (`have`). No new connection means no hello, session list, or PiP state again, and nobody sees
     * this person leave and come back. `switched` goes first: every event of a session after it is the new one's. A switch
     * numbered `seq` below one already taken arrived late, and is dropped. False when no such connection is open (it
     * closed, or the server started again): the tab connects again instead.
     */
    switchTo(
        user: User,
        connection: string,
        id: ConversationId | undefined,
        have: Client["have"],
        seq: number,
    ): boolean {
        let found = false;

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            found = true;

            if (seq <= (client.switchSeq ?? -Infinity)) {
                continue;
            }

            client.switchSeq = seq;
            const previous = client.conversationId;

            if (previous !== undefined) {
                this.#leaveRoom(client, previous);
            }

            client.conversationId = id;

            if (have === undefined) {
                delete client.have;
            } else {
                client.have = have;
            }

            client.send("switched", { seq, conversationId: id ?? null });
            void this.#enter(client);

            if (id === undefined) {
                this.#scheduleSessions();
            }
        }

        return found;
    }

    /**
     * Put a tab in the room of the session it shows (`client.conversationId`), and send it what that session has: its
     * view, chat, notes, and browser. A later switch while the room opens wins: this one then leaves nothing behind.
     */
    async #enter(client: Client): Promise<void> {
        const visit = (client.visit = (client.visit ?? 0) + 1);
        const id = client.conversationId;

        if (id === undefined) {
            return;
        }

        if (!this.canSee(client.user, id)) {
            client.send("missing", {
                conversationId: id,
                message: "This session is not shared with you.",
            });
            // Keep the tab for app-wide events only: nothing about that conversation reaches it, and it is not "there".
            client.conversationId = undefined;

            return;
        }

        try {
            const room = await this.room(id);

            if (!this.#clients.has(client) || client.visit !== visit) {
                this.releaseRoom(room);

                return;
            }

            // The person's access can change while the room opens (`setAccess` evicts only tabs already there): asked
            // again now, as nothing of the session has gone yet.
            if (!this.canSee(client.user, id)) {
                this.releaseRoom(room);
                client.conversationId = undefined;
                client.send("missing", {
                    conversationId: id,
                    message: "This session is no longer shared with you.",
                });

                return;
            }

            room.keepOpen();
            room.clients.add(client);
            room.push(client, true);
            client.send("chat", { conversationId: room.id, full: true, messages: room.chat });
            client.send("notes", { conversationId: room.id, ...room.notes });
            // Also while the browser is off: turned on later, the panel has its state at once.
            client.send(
                "browser",
                this.#browserEvent(room.id, this.browsers.state(Number(room.id))),
            );

            for (const other of room.clients) {
                if (other !== client) {
                    room.push(other, false);
                }
            }

            room.pushPresence();
            this.#scheduleSessions();
        } catch (error) {
            if (client.visit === visit) {
                client.send("missing", { conversationId: id, message: describe(error) });
            }
        }
    }

    detach(client: Client): void {
        if (!this.#clients.delete(client)) {
            return;
        }

        for (const id of client.peeks ?? []) {
            this.#unpeek(client, id);
        }

        client.peeks = undefined;
        this.#closePip(client);

        if (!this.#online(client.user.id)) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        this.#leaveRoom(client, client.conversationId);
    }

    /** Take a tab out of a conversation's room: the others see it go, and the room closes once no tab is left. */
    #leaveRoom(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (!room.clients.delete(client)) {
                    return;
                }

                if (!room.has(client.user.id)) {
                    room.setTyping(client.user.id, null);
                }

                room.pushPresence();
                room.schedule();
                this.#scheduleSessions();
                this.releaseRoom(room);
            },
            () => {},
        );
    }

    /**
     * The sessions a connection shows as peek tiles on its screen now, and the subagents its subagents bar shows. Each
     * gets short `peek` updates while it stays there; the rest stop, and their views close as they do when the last tab
     * leaves. Conversations this person may not see are left out. `connection` is the id its `hello` carried. A list
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setPeeks(user: User, connection: string, ids: readonly ConversationId[], seq?: number): void {
        // Sessions, and the subagents of sessions: the subagents bar shows what each does now.
        const wanted = new Set(
            ids
                .filter(
                    (id) =>
                        this.#sessions[String(this.rootOf(id))] !== undefined &&
                        this.canSee(user, id),
                )
                .slice(0, MAX_PEEKS),
        );

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.peekSeq ?? -Infinity)) {
                    continue;
                }

                client.peekSeq = seq;
            }

            const had = client.peeks ?? new Set<ConversationId>();

            client.peeks = new Set(wanted);

            for (const id of had) {
                if (!wanted.has(id)) {
                    this.#unpeek(client, id);
                }
            }

            for (const id of wanted) {
                if (!had.has(id)) {
                    void this.#peek(client, id);
                }
            }
        }
    }

    async #peek(client: Client, id: ConversationId): Promise<void> {
        let room: Room;

        try {
            room = await this.room(id);
        } catch {
            // A session that is gone has no tile to show.
            return;
        }

        // The tab left, or scrolled the tile away, while the view opened.
        if (!this.#clients.has(client) || client.peeks?.has(id) !== true) {
            this.releaseRoom(room);

            return;
        }

        // Scrolled away and back while the view opened: the first of the two calls added it already.
        if (room.peekers.has(client)) {
            return;
        }

        room.keepOpen();
        room.peekers.add(client);
        room.pushPeek(client);
    }

    #unpeek(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (room.peekers.delete(client)) {
                    this.releaseRoom(room);
                }
            },
            () => {},
        );
    }

    /**
     * A tab opened or closed its PiP panel. While it is open, the tab gets PiP's conversation as `pipview` events, from a
     * view of its own beside the one the tab shows, and counts as looking at PiP, so its answers push nothing. Opening
     * makes this person's PiP the first time. A request numbered `seq` below one already taken arrived late, and is
     * dropped.
     */
    async setPip(user: User, connection: string, on: boolean, seq?: number): Promise<void> {
        const id = on ? await this.pip.ensure(user) : undefined;

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.pipSeq ?? -Infinity)) {
                    continue;
                }

                client.pipSeq = seq;
            }

            if (client.pip !== undefined && client.pip.conversationId !== id) {
                this.#closePip(client);
            }

            if (id !== undefined && client.pip === undefined) {
                void this.#openPip(client, id);
            }
        }

        // Made just now: the tab learns its id from the PiP state.
        this.#scheduleSessions();
    }

    async #openPip(tab: Client, id: ConversationId): Promise<void> {
        const panel: Client = {
            id: tab.id,
            user: tab.user,
            connection: tab.connection,
            conversationId: id,
            get visible() {
                return tab.visible;
            },
            // The same code shows it: what the tab understands, the panel does.
            ...(tab.protocol === undefined ? {} : { protocol: tab.protocol }),
            sentEntries: new Set<number>(),
            orderKey: "",
            // Only the view: the panel has no chat, notes, or browser of its own.
            send: (event, data) => {
                if (event === "view") {
                    tab.send("pipview", data);
                }
            },
        };

        tab.pip = panel;
        let room: Room;

        try {
            room = await this.room(id);
        } catch (error) {
            if (tab.pip === panel) {
                tab.pip = undefined;
            }

            this.#log(`PiP's view did not open: ${describe(error)}`);

            return;
        }

        // The tab left, or closed the panel, while the view opened.
        if (!this.#clients.has(tab) || tab.pip !== panel) {
            this.releaseRoom(room);

            return;
        }

        room.keepOpen();
        room.clients.add(panel);
        room.push(panel, true);
    }

    #closePip(tab: Client): void {
        const panel = tab.pip;

        tab.pip = undefined;

        if (panel?.conversationId !== undefined) {
            this.#leaveRoom(panel, panel.conversationId);
        }
    }

    /** Send a tab its person's PiP state, unless it is what the tab last got. */
    #sendPip(client: Client): void {
        const json = JSON.stringify(this.pip.state(client.user));

        if (json !== client.pipSent) {
            client.pipSent = json;
            client.send("pip", JSON.parse(json) as unknown);
        }
    }

    /** A tab was hidden or shown: hidden tabs show their person as away, and let push notifications through. */
    setVisible(user: User, tab: string, visible: boolean): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.id !== tab || client.visible === visible) {
                continue;
            }

            client.visible = visible;
            const id = client.conversationId;

            if (id !== undefined) {
                void this.#rooms.get(id)?.then(
                    (room) => room.pushPresence(),
                    () => {},
                );
            }
        }
    }

    #online(userId: string): boolean {
        for (const client of this.#clients) {
            if (client.user.id === userId) {
                return true;
            }
        }

        return false;
    }

    /**
     * Send a notification to this person's embedders (apps that show Pi Pocket and its notifications
     * themselves), over their live connections: Web Push cannot reach them. Each connected one gets
     * it; the embedder shows one per tag. Returns how many got it.
     */
    notifyEmbedders(userId: string, message: EmbedderMessage): number {
        // Web Push clips; an embedder takes the same, and the whole call for an approval.
        message = {
            ...message,
            title: message.title.slice(0, 200),
            body: message.body.slice(0, 1000),
        };
        let sent = 0;

        for (const client of this.#clients) {
            if (client.user.id === userId && client.embedder !== undefined) {
                client.send(client.embedder, message);
                sent += 1;
            }
        }

        return sent;
    }

    /** Whether any embedder that shows notifications is connected now. */
    hasEmbedders(): boolean {
        for (const client of this.#clients) {
            if (client.embedder !== undefined) {
                return true;
            }
        }

        return false;
    }

    /** Is this person looking at this conversation right now, in a visible tab? */
    watching(userId: string, id: ConversationId): boolean {
        for (const client of this.#clients) {
            if (
                client.user.id === userId &&
                (client.conversationId === id || client.pip?.conversationId === id) &&
                client.visible !== false
            ) {
                return true;
            }
        }

        return false;
    }

    /** Change someone's name: shown at once on their messages, in the people lists, and on their avatar. */
    rename(user: User, name: string): void {
        this.config.updateUser(user.id, { name });
        this.#peopleChanged();
        this.runners.changed();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.has(user.id) && room.pushPresence(),
                () => {},
            );
        }
    }

    /** Set (bytes) or clear (undefined) someone's picture; everyone's lists show it at once. */
    setAvatar(user: User, bytes: Buffer | undefined): void {
        if (bytes === undefined) {
            removeAvatar(this.dataDir, user.id);
            this.config.updateUser(user.id, { avatar: undefined });
        } else {
            saveAvatar(this.dataDir, user.id, bytes);
            this.config.updateUser(user.id, { avatar: Date.now() });
        }

        this.#peopleChanged();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.has(user.id) && room.pushPresence(),
                () => {},
            );
        }
    }

    /** Someone came, went, or changed: remember when they were last here and tell everyone. */
    #peopleChanged(userId?: string): void {
        if (userId !== undefined && this.config.userById(userId) !== undefined) {
            // Only a timestamp: a full disk must not stop the server on every connect and close.
            try {
                this.config.updateUser(userId, { lastSeen: Date.now() });
            } catch (error) {
                this.#log(`last seen not saved: ${describe(error)}`);
            }
        }

        for (const client of this.#clients) {
            client.send("users", this.people(client.user));
        }
    }

    /**
     * The people with access to this server as `viewer` may see them: who is online now, and when the others were last
     * here. People invited to one session see only those who share it, and not which sessions others are limited to.
     */
    people(viewer: User) {
        const scope = viewer.sessions;

        return this.config.users
            .filter(
                (each) =>
                    scope === undefined ||
                    each.sessions === undefined ||
                    each.sessions.some((id) => scope.includes(id)),
            )
            .map((each) => ({
                id: each.id,
                name: each.name,
                role: each.role,
                ...(each.avatar === undefined ? {} : { avatar: each.avatar }),
                online: this.#online(each.id),
                ...(each.lastSeen === undefined ? {} : { lastSeen: each.lastSeen }),
                // Which sessions they are limited to: only the ones this viewer may see themselves. An empty list still
                // says that they are limited.
                ...(each.sessions === undefined || scope !== undefined
                    ? {}
                    : {
                          sessions: each.sessions
                              .filter((id) => this.policy.maySee(viewer, id))
                              .map(Number),
                      }),
                // For the owner, who can remove it (a lost phone): that one is linked, never what it holds.
                ...(viewer.role === "owner" && each.authenticator?.confirmedAt !== undefined
                    ? { authenticator: true }
                    : {}),
                // How long a session's approval lasts after they used it (0: never ends), for the owner and themselves.
                ...(viewer.role === "owner" || viewer.id === each.id
                    ? { approvalDays: approvalDays(each) }
                    : {}),
                // Whether they have an authenticator linked (steering needs one), and may link computers.
                ...((viewer.role === "owner" || viewer.id === each.id) &&
                each.authenticator?.confirmedAt !== undefined
                    ? { hasCode: true }
                    : {}),
                ...(each.linksRunners === true && (viewer.role === "owner" || viewer.id === each.id)
                    ? { linksRunners: true }
                    : {}),
                // May they invite people, for the owner, who sets it, and for themselves.
                ...(each.invites === true && (viewer.role === "owner" || viewer.id === each.id)
                    ? { invites: true }
                    : {}),
                // A temporary account, for the owner, who can end that, and for themselves.
                ...(each.temporary === true && (viewer.role === "owner" || viewer.id === each.id)
                    ? { temporary: true }
                    : {}),
            }));
    }

    // ─── Access ─────────────────────────────────────────────────────────────

    /** A session's conversations: itself and the subagents under it that are known here. */
    conversationsOf(root: ConversationId): ConversationId[] {
        return [
            ...new Set([
                root,
                ...[...this.#agents.keys()].filter((id) => this.rootOf(id) === root),
            ]),
        ];
    }

    /** The conversation that spawned a subagent's; undefined for any other conversation. */
    parentOf(id: ConversationId): ConversationId | undefined {
        return this.#parents.get(id);
    }

    /** The session a conversation belongs to: itself, or the session its subagent chain started from. */
    rootOf(id: ConversationId): ConversationId {
        let current = id;

        for (let depth = 0; depth < 32; depth++) {
            const parent = this.#parents.get(current);

            if (parent === undefined) {
                return current;
            }

            current = parent;
        }

        return current;
    }

    /**
     * The access policy over the live records: people and this server's settings from the config, runners from their
     * links and the folders given there, approvals from `folder-approvals.ts`, and sessions from the catalogue.
     */
    #makePolicy(): AccessPolicy {
        const config = this.config;
        const ownerId = () => this.#ownerId();

        return new AccessPolicy({
            get ownerId() {
                return ownerId();
            },
            person: (id) => this.config.userById(id),
            computer: (id) => {
                if (id === THIS_SERVER) {
                    const server = this.config.server;

                    return {
                        id,
                        linker: config.users.find((each) => each.role === "owner")?.id ?? "",
                        chosen: server.users ?? [],
                        given: (person) => config.givenFolders(undefined, person),
                        sees: (person) => config.seenFolders(undefined, person),
                        shareNew: server.shareNew === true,
                    };
                }

                const runner = this.config.runnerById(id);

                if (runner === undefined) {
                    return undefined;
                }

                return {
                    id,
                    linker: runner.createdBy,
                    chosen: runner.users ?? [],
                    given: (person) => config.givenFolders(id, person),
                    sees: (person) => config.seenFolders(id, person),
                    shareNew: runner.shareNew === true,
                };
            },
            approved: (id) => this.folderApprovals.live(id),
            session: (id) => {
                const root = String(this.rootOf(Number(id) as unknown as ConversationId));
                const meta = this.#sessions[root];
                const folder = (): string => this.#accessFolder(meta!);

                return meta === undefined
                    ? undefined
                    : {
                          id: root,
                          computer: meta.runner ?? THIS_SERVER,
                          ...(meta.createdBy === undefined ? {} : { createdBy: meta.createdBy }),
                          ...(meta.sharedWith === undefined ? {} : { sharedWith: meta.sharedWith }),
                          ...(meta.pip === undefined ? {} : { pip: meta.pip }),
                          // Read only when asked for (`access.ts` `#seesByFolder`): a worktree's takes a look at
                          // every session.
                          get folder() {
                              return folder();
                          },
                      };
            },
        });
    }

    /**
     * This server as the Runners sheet shows it (`access.ts` `THIS_SERVER`), to those who manage it: the owner, its
     * linker. Undefined for anyone else, who learns nothing of its people and folders.
     */
    thisServer(user: User): ServerView | undefined {
        if (!this.policy.mayManage(user, THIS_SERVER)) {
            return undefined;
        }

        const server = this.config.server;

        return {
            id: THIS_SERVER,
            name: "This server",
            createdBy: this.config.users.find((each) => each.role === "owner")?.id ?? "",
            users: (server.users ?? []).flatMap((id) => {
                const person = this.config.userById(id);

                return person === undefined ? [] : [{ id, name: person.name, role: person.role }];
            }),
            given: Object.fromEntries(
                (server.users ?? []).map((id) => [
                    id,
                    [...this.config.givenFolders(undefined, id)],
                ]),
            ),
            sees: Object.fromEntries(
                (server.users ?? []).map((id) => [id, [...this.config.seenFolders(undefined, id)]]),
            ),
            shareNew: server.shareNew === true,
        };
    }

    /**
     * Before `user` starts a new session in `folder` on computer `computer` (undefined: this server): go on at once when
     * they are in charge of it, refuse a folder they were not given, or wait for an approval (`folder-requests.ts`):
     * their own authenticator code, or Allow by who is in charge. Returns what keeps the approval for the new session
     * once it has an id (nothing to keep for who is in charge), and what checks them again where the session is saved
     * (`Approved`). `folder` is a real path there: on this server it is resolved here, so a symlink changed later cannot
     * widen it; a runner's is checked there (`runners.ts` `checkFolder`).
     */
    async approveStart(
        user: User,
        folder: string,
        signal?: AbortSignal,
        computer: string = THIS_SERVER,
    ): Promise<Approved> {
        const real = computer === THIS_SERVER ? await realFolder(folder) : folder;
        const decision = this.policy.folder(user, computer, real);
        // Unchosen, or the folder taken back, while the approval or the preparation waited: nothing is saved.
        const check = () => this.policy.requireFolder(user, computer, real);

        // Who is in charge is not asked, but their session still gets an approval, on their clock: people it is shared
        // with use it while it is live.
        if (decision.kind === "allow") {
            return {
                check,
                keep: (session, cwd) =>
                    void this.folderApprovals.approve(
                        String(session),
                        { computer, folder: cwd },
                        "owner",
                        user.id,
                        user,
                    ),
            };
        }

        if (decision.kind === "refuse") {
            throw new HttpError(403, decision.reason);
        }

        const answer = await this.folderRequests.ask(
            user,
            {
                computer,
                computerName: this.#computerName(computer),
                folder: real,
                kind: "new",
            },
            signal,
        );

        return {
            check,
            keep: (session, cwd) =>
                void this.folderApprovals.approve(
                    String(session),
                    { computer, folder: cwd },
                    answer.method,
                    answer.by,
                    user,
                ),
        };
    }

    /**
     * A copy, a move, or a linked session that `user` makes from session `from` into `folder` on computer `computer`: it
     * needs the folder given to them (or who is in charge), and inherits `from`'s live approval, used by them. A locked
     * source is renewed first (`#renew`). Returns what keeps the approval for the new session.
     *
     * Staying in `from`'s own worktree counts as the folder that worktree came from (`#worktreeSource`): the worktree is
     * kept in the data folder, or under the runner's, which nobody is given. Only `from`'s: another session's worktree
     * is a folder like any other, given or not.
     */
    async approveFrom(
        user: User,
        from: ConversationId,
        folder: string,
        runner?: string,
        signal?: AbortSignal,
    ): Promise<Approved> {
        const computer = runner ?? THIS_SERVER;
        const real = computer === THIS_SERVER ? await realFolder(folder) : folder;
        const root = String(this.rootOf(from));
        const sameComputer = (this.policy.session(root)?.computer ?? THIS_SERVER) === computer;
        const own = this.cwdOf(from);
        const source =
            sameComputer && (inFolder(folder, own) || inFolder(real, own))
                ? this.#worktreeSource(computer, own)
                : undefined;

        const folderRule = () => this.policy.requireFolder(user, computer, source ?? real);

        folderRule();

        // From another computer, it starts as a new session there would.
        if (!sameComputer) {
            return this.approveStart(user, real, signal, computer);
        }

        await this.#requireApproval(from, user, signal);

        const inCharge = this.policy.inCharge(user, computer);
        // The approval is of the folder the worktree came from, as the source's own is (`#approvalFolder`).
        const approved = (cwd: string) => (source !== undefined && cwd === folder ? source : cwd);

        return {
            // Where it is saved: the folder is still theirs, and the source still theirs to steer, its approval live.
            check: () => {
                folderRule();
                this.requireSteer(user, from);
                this.#requireLive(from, user);
            },
            // The copy inherits the source's approval; who is in charge gives one on their own clock when it has none.
            keep: (session, cwd) =>
                this.folderApprovals.get(root) === undefined
                    ? inCharge
                        ? void this.folderApprovals.approve(
                              String(this.rootOf(session)),
                              { computer, folder: approved(cwd) },
                              "owner",
                              user.id,
                              user,
                          )
                        : undefined
                    : void this.folderApprovals.inherit(
                          root,
                          String(this.rootOf(session)),
                          { computer, folder: approved(cwd) },
                          user,
                      ),
        };
    }

    /**
     * The folder the worktree at `folder` on computer `computer` came from, when `folder` is in a session's worktree
     * there; else undefined. A copy made without a worktree of its own works in its source's, and has no record of it.
     */
    #worktreeSource(computer: string, folder: string): string | undefined {
        // The sessions' record is replaced, never changed in place (`#committed`), so the list is good while it is the
        // same record. A list of sessions asks this once for each of them (`access.ts` `#seesByFolder`).
        if (this.#worktrees?.of !== this.#sessions) {
            this.#worktrees = {
                of: this.#sessions,
                list: Object.values(this.#sessions).flatMap((meta) =>
                    meta.worktree === undefined
                        ? []
                        : [
                              {
                                  computer: meta.runner ?? THIS_SERVER,
                                  path: meta.worktree.path,
                                  source: meta.worktree.source,
                              },
                          ],
                ),
            };
        }

        return this.#worktrees.list.find(
            (each) => each.computer === computer && inFolder(folder, each.path),
        )?.source;
    }

    /** Every session's worktree, as read from the sessions' record `of`. */
    #worktrees:
        | {
              of: Record<string, SessionMeta>;
              list: { computer: string; path: string; source: string }[];
          }
        | undefined;

    /** Whether `person` sees session `id` through its folder (`access.ts` `seesFolder`), whatever else gives it to them. */
    seesByFolder(person: Pick<User, "id">, id: ConversationId): boolean {
        const meta = this.#sessions[String(this.rootOf(id))];

        return (
            meta !== undefined &&
            meta.pip === undefined &&
            this.policy.seesFolder(person, meta.runner ?? THIS_SERVER, this.#accessFolder(meta))
        );
    }

    /** The computer and folder session `id` counts as working in, for an invite to that folder (`welcome`). */
    folderOf(id: ConversationId): { computer: string; path: string } | undefined {
        const meta = this.#sessions[String(this.rootOf(id))];

        return meta === undefined || meta.pip !== undefined
            ? undefined
            : { computer: meta.runner ?? THIS_SERVER, path: this.#accessFolder(meta) };
    }

    /** The folder session `meta`'s access is judged by: where its worktree came from, its own or the one it works in. */
    #accessFolder(meta: SessionMeta): string {
        return (
            meta.worktree?.source ??
            this.#worktreeSource(meta.runner ?? THIS_SERVER, meta.cwd) ??
            meta.cwd
        );
    }

    /**
     * The owner, or who is in charge of runner `id`, gives `person` these folders on computer `id` (`THIS_SERVER` or a
     * runner): the whole list, replacing the last. A person must be chosen there first. Folders here are resolved to real
     * paths; a runner's must be folders there. Sessions in folders no longer given move to who is in charge.
     */
    async giveFolders(
        by: User,
        id: string,
        person: string,
        folders: readonly string[],
    ): Promise<void> {
        if (id !== THIS_SERVER) {
            this.runners.require(id);
        }

        this.policy.requireManage(by, id);

        const target = this.config.userById(person);

        if (target === undefined || !this.policy.mayStart(target, id)) {
            throw new HttpError(400, "Choose them for this computer first.");
        }

        const real = await Promise.all(
            folders
                .map((each) => each.trim())
                .filter((each) => each !== "")
                .map(async (each) => {
                    if (id !== THIS_SERVER) {
                        return this.runners.checkFolder(id, each);
                    }

                    const path = resolvePath(this.#home, each.replace(/^~(?=\/|$)/, this.#home));
                    const found = await realpath(path).catch(() => undefined);

                    if (found === undefined || !(await stat(found)).isDirectory()) {
                        throw new HttpError(400, `${each} is not a folder here.`);
                    }

                    return found;
                }),
        );

        this.config.setGivenFolders(id === THIS_SERVER ? undefined : id, person, real);
        await this.handOver(person, id);
        this.accessChanged();
        this.runners.changed();
    }

    /**
     * The owner, or who is in charge of runner `id`, lets `person` see every session in `folder` on computer `id`,
     * whoever started it, or no longer (`access.ts` `seesFolder`). `folder` is one of the folders given to them there,
     * as that list has it. On: the sessions in it now and the ones started later are theirs as shared ones are. Off:
     * they leave the ones they had by it at once, and each task they set up on one moves to its starter (`handOver`);
     * what they started, and what is shared with them one at a time, stays.
     */
    async seeFolder(
        by: User,
        id: string,
        person: unknown,
        folder: unknown,
        on: unknown,
    ): Promise<void> {
        if (id !== THIS_SERVER) {
            this.runners.require(id);
        }

        this.policy.requireManage(by, id);

        if (typeof person !== "string" || typeof folder !== "string" || typeof on !== "boolean") {
            throw new HttpError(400, "Send person, folder, and on.");
        }

        const target = this.config.userById(person);

        if (target === undefined || !this.policy.mayStart(target, id)) {
            throw new HttpError(400, "Choose them for this computer first.");
        }

        if (!this.config.setSeenFolder(id === THIS_SERVER ? undefined : id, person, folder, on)) {
            throw new HttpError(400, "Give them that folder first.");
        }

        if (!on) {
            await this.handOver(person, id);
        }

        this.accessChanged();
    }

    /** The owner sets how long a session's approval lasts after `person` last used it (`APPROVAL_DAYS`); null: 7 days. */
    setApprovalDays(person: string, days: unknown): void {
        const target = this.config.userById(person);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (days !== null && !(APPROVAL_DAYS as readonly unknown[]).includes(days)) {
            throw new HttpError(400, `days must be one of ${APPROVAL_DAYS.join(", ")}, or null.`);
        }

        this.config.updateUser(person, {
            approvalDays: days === null ? undefined : (days as number),
        });
        this.#peopleChanged();
        this.#approvalsChanged();
    }

    /** The owner's id. */
    #ownerId(): string {
        return this.config.users.find((each) => each.role === "owner")?.id ?? "";
    }

    #computerName(computer: string): string {
        return computer === THIS_SERVER ? "this server" : this.runners.name(computer);
    }

    /**
     * The folder a session's approval is of: where it came from, not its own worktree (kept in the data folder, or under
     * the runner's), which no one was given.
     */
    #approvalFolder(id: ConversationId): string {
        const meta = this.#sessions[String(this.rootOf(id))];

        return meta === undefined ? this.cwdOf(id) : this.#accessFolder(meta);
    }

    /**
     * Before `user` sends to session `id`, changes its settings, or edits its tasks (`requireDriver`): its approval must
     * be live (`access.ts` `steer`), and their use resets its clock. A locked session waits for a renewal (`#renew`),
     * until `signal` says the caller gave up.
     */
    async #requireApproval(id: ConversationId, user: User, signal?: AbortSignal): Promise<void> {
        const root = String(this.rootOf(id));
        const facts = this.policy.session(root);

        if (facts === undefined || facts.pip !== undefined) {
            return;
        }

        if (this.policy.steer(user, root) === "allow") {
            // Any use resets its clock to the user's time. Who is in charge renews it just by using it.
            if (
                !this.folderApprovals.use(root, user) &&
                this.policy.inCharge(user, facts.computer)
            ) {
                this.folderApprovals.approve(
                    root,
                    { computer: facts.computer, folder: this.#approvalFolder(id) },
                    "owner",
                    user.id,
                    user,
                );
            }

            return;
        }

        await this.#renew(id, user, signal);
    }

    /**
     * Renew locked session `id`'s approval for `user`: its starter with their own code, or Allow by who is in charge of
     * its computer. Anyone else who shares it asks, and only who is in charge can allow it.
     */
    async #renew(id: ConversationId, user: User, signal?: AbortSignal): Promise<void> {
        const root = String(this.rootOf(id));
        const facts = this.policy.session(root);

        if (facts === undefined) {
            return;
        }

        const answer = await this.folderRequests.ask(
            user,
            {
                computer: facts.computer,
                computerName: this.#computerName(facts.computer),
                folder: this.#approvalFolder(id),
                kind: "renew",
                session: root,
                title: this.sessionMeta(this.rootOf(id))?.title ?? "New session",
            },
            signal,
            this.policy.mayRenewWithCode(user, root),
        );

        // Renewed another way meanwhile (someone else's request, its row): this person only uses it.
        if (this.policy.steer(user, root) === "allow" && this.folderApprovals.use(root, user)) {
            return;
        }

        this.folderApprovals.approve(
            root,
            { computer: facts.computer, folder: this.#approvalFolder(id) },
            answer.method,
            answer.by,
            user,
        );
    }

    /**
     * Who is in charge renews session `id` from its row (Allow, no code), or its starter with `code`: no one has to be
     * waiting on it.
     */
    renewApproval(user: User, id: ConversationId, code?: string): Promise<void> | void {
        const root = String(this.rootOf(id));
        const facts = this.policy.session(root);

        this.requireSee(user, id);

        if (facts === undefined) {
            throw new HttpError(404, "This session is not shared with you.");
        }

        const target = { computer: facts.computer, folder: this.#approvalFolder(id) };

        if (this.policy.mayRenewFree(user, root)) {
            this.folderApprovals.approve(root, target, "owner", user.id, user);

            return;
        }

        if (code === undefined || !this.policy.mayRenewWithCode(user, root)) {
            throw new HttpError(
                403,
                `Only its starter, with their own code, or whoever is in charge of ${this.#computerName(facts.computer)} can renew it.`,
            );
        }

        return this.approvalMethods
            .verify(user, user, { method: "totp", code })
            .then(
                (method) => void this.folderApprovals.approve(root, target, method, user.id, user),
            );
    }

    /** `user` revokes session `id`'s approval: its starter, or who is in charge. The session locks until renewed. */
    revokeApproval(user: User, id: ConversationId): void {
        const root = String(this.rootOf(id));
        const facts = this.policy.session(root);

        this.folderApprovals.revoke(
            root,
            facts !== undefined &&
                this.policy.maySee(user, root) &&
                (this.policy.starter(facts) === user.id || this.policy.mayRenewFree(user, root)),
        );
    }

    /**
     * `by`, in charge of session `id`'s computer, takes that one session from `personId`, and nothing else of theirs:
     * shared with them, it is no longer; started by them, it moves to `by` with the tasks they set up in it
     * (`handOver`); invited to it alone, they are no longer. They leave it at once.
     */
    async revokeSession(by: User, id: ConversationId, personId: unknown): Promise<void> {
        const root = this.rootOf(id);
        const facts = this.policy.session(String(root));

        this.requireSee(by, root);

        if (facts === undefined || facts.pip !== undefined) {
            throw new HttpError(404, "Not a session");
        }

        this.policy.requireManage(by, facts.computer);

        const person = typeof personId === "string" ? this.config.userById(personId) : undefined;

        if (person === undefined) {
            throw new HttpError(400, "That person is not on this server.");
        }

        if (this.policy.inCharge(person, facts.computer)) {
            throw new HttpError(
                400,
                `${person.name} is in charge of ${this.#computerName(facts.computer)}: every session there is theirs.`,
            );
        }

        const invited = person.sessions?.includes(facts.id) === true;

        // Theirs by its folder alone: there is no one session to take, only the folder's switch.
        if (this.policy.seesOnlyByFolder(person, facts.id)) {
            throw new HttpError(
                400,
                `${person.name} sees every session in that folder. Turn that off on the folder.`,
            );
        }

        if (
            !invited &&
            this.policy.starter(facts) !== person.id &&
            facts.sharedWith?.includes(person.id) !== true
        ) {
            throw new HttpError(404, `${person.name} does not have that session.`);
        }

        if (invited) {
            this.config.updateUser(person.id, {
                sessions: person.sessions!.filter((each) => each !== facts.id),
            });
        }

        await this.handOver(person.id, facts.computer, facts.id);
        void this.#refreshUser(person.id);
        this.accessChanged();
        this.#peopleChanged();
        await this.collab.activity(root, by, `took the session from ${person.name}`);
    }

    /**
     * May session `id`'s tasks (webhooks, schedules, watches) run now. "Tasks expire with the session" off (the default):
     * they run for good once set up. On: while its approval is live, or the 7 days of grace after it ended (with a
     * reminder each day to its starter and who is in charge), then they pause until someone renews it, and those two
     * hear it once. A revoke ends it then, so the 7 days count from the revoke. A session with no approval at all (from
     * before approvals) counts as ended when the switch went on, or when it started if that was later. Who is in charge
     * of its computer, and a PiP, never need one.
     */
    tasksMayRun(id: ConversationId): boolean {
        const root = String(this.rootOf(id));
        const facts = this.policy.session(root);

        if (facts === undefined) {
            return false;
        }

        const starter = this.policy.starter(facts);

        if (
            this.config.server.tasksExpire !== true ||
            facts.pip !== undefined ||
            this.policy.inCharge({ id: starter }, facts.computer)
        ) {
            return true;
        }

        const approval = this.folderApprovals.get(root);
        const ended =
            approval === undefined
                ? Math.max(
                      this.config.server.tasksExpireSince ?? 0,
                      this.sessionMeta(this.rootOf(id))?.createdAt ?? 0,
                  )
                : this.folderApprovals.expiresAt(approval);

        if (ended === null || ended > this.now()) {
            return true;
        }

        const pausedAt = ended + TASK_GRACE_MS;
        const left = Math.ceil((pausedAt - this.now()) / DAY_MS);
        const reminded = this.folderApprovals.remindedAt(root);

        // Once a day of the week of grace, who is in charge and its starter hear how long its tasks have; and once
        // more when they pause. Then nothing: a task that asks each few minutes does not ring every day for good.
        if (
            reminded === undefined ||
            (reminded < pausedAt && (this.now() >= pausedAt || this.now() - reminded >= DAY_MS))
        ) {
            this.folderApprovals.reminded(root, this.now());
            this.alerts.tasksEnding(
                [starter, this.policy.inChargeOf(root)],
                root,
                this.sessionMeta(this.rootOf(id))?.title ?? "New session",
                Math.max(0, left),
            );
        }

        return left > 0;
    }

    /** The owner turns "Tasks expire with the session" on or off. */
    setTasksExpire(user: User, on: boolean): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can change this.");
        }

        this.config.setTasksExpire(on, this.now());
        this.#peopleChanged();
    }

    /** The approvals `user` may list: of sessions they started, and on computers they are in charge of. */
    sessionApprovals(user: User): ApprovalView[] {
        return this.folderApprovals.list((approval) => {
            const facts = this.policy.session(approval.session);

            return (
                facts !== undefined &&
                this.policy.maySee(user, approval.session) &&
                (this.policy.starter(facts) === user.id ||
                    this.policy.inCharge(user, facts.computer))
            );
        });
    }

    /**
     * `person` leaves computer `computer` (undefined: every one): removed, no longer chosen there, or no longer given a
     * folder. Their sessions there that they may no longer use move to who is in charge of it, and so does each task they
     * set up on a session there that they may no longer steer: on their own sessions and on sessions shared with them
     * alike. One commit moves both, so a restart never leaves a task with someone who left (`#handOverGone` finishes one
     * that removing a person began). Nothing stops.
     *
     * With `only` (a top session there), that session alone is taken from them (`revokeSession`): it is no longer
     * shared with them, and one they started moves although they may still use its folder.
     */
    async handOver(person: string, computer?: string, only?: string): Promise<void> {
        const gone = this.config.userById(person) === undefined;
        const on = (where: string) => computer === undefined || where === computer;
        const moved = new Map<string, string>();

        await this.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);

            for (const [id, meta] of Object.entries(sessions.items)) {
                const where = meta.runner ?? THIS_SERVER;

                if (only !== undefined) {
                    if (id !== only) {
                        continue;
                    }

                    const kept = meta.sharedWith?.filter((each) => each !== person);

                    if (kept === undefined || kept.length === 0) {
                        delete meta.sharedWith;
                    } else {
                        meta.sharedWith = kept;
                    }
                }

                if (meta.createdBy !== person || meta.pip !== undefined || !on(where)) {
                    continue;
                }

                const stays =
                    only === undefined &&
                    !gone &&
                    this.policy.mayUseFolder({ id: person }, where, this.#accessFolder(meta));

                if (stays) {
                    continue;
                }

                const to = this.policy.inChargeOf(id);

                meta.createdBy = to;
                meta.sharedWith = meta.sharedWith?.filter((each) => each !== to && each !== person);
                moved.set(id, to);
            }

            // Each task on a session there that they may no longer steer: the session is no longer theirs (moved
            // above, in this same commit), or no longer shared with them.
            const owner = (target: number): string | undefined => {
                const root = this.rootOf(target as unknown as ConversationId);
                const meta = sessions.items[String(root)];

                if (
                    meta === undefined ||
                    meta.pip !== undefined ||
                    !on(meta.runner ?? THIS_SERVER)
                ) {
                    return undefined;
                }

                const there = meta.runner ?? THIS_SERVER;
                const steers =
                    !gone &&
                    !moved.has(String(root)) &&
                    (((meta.createdBy === person || meta.sharedWith?.includes(person) === true) &&
                        this.policy.mayUse({ id: person }, there)) ||
                        this.policy.seesFolder({ id: person }, there, this.#accessFolder(meta)));

                return steers
                    ? undefined
                    : (moved.get(String(root)) ?? meta.createdBy ?? this.#ownerId());
            };

            const swap = (target: number, item: { by?: string; requestedBy?: string }): void => {
                if (item.by !== person && item.requestedBy !== person) {
                    return;
                }

                const to = owner(target);

                if (to === undefined) {
                    return;
                }

                if (item.by === person) {
                    item.by = to;
                }

                if (item.requestedBy === person) {
                    item.requestedBy = to;
                }
            };

            for (const hook of Object.values((await tx.doc(HooksDoc)).items)) {
                swap(hook.target, hook);
            }

            for (const watch of Object.values((await tx.doc(RepoWatchesDoc)).items)) {
                swap(watch.target, watch);
            }

            for (const key of Object.keys(sessions.items)) {
                const root = Number(key) as unknown as ConversationId;

                for (const conversation of this.conversationsOf(root)) {
                    const watch = (await tx.doc(WatchDoc, conversation)).watch;

                    if (watch !== undefined) {
                        swap(Number(conversation), watch);
                    }

                    for (const schedule of Object.values(
                        (await tx.doc(ScheduleDoc, conversation)).items,
                    )) {
                        swap(Number(conversation), schedule);
                    }
                }
            }
        }, context);

        // Pi worked for them in a session that is no longer theirs: it now works for who has it, until someone writes.
        for (const [id, to] of moved) {
            this.attribution.handedOver(Number(id) as unknown as ConversationId, person, to);
        }

        if (gone) {
            this.attribution.forget(person, (id) => this.sessionMeta(this.rootOf(id))?.createdBy);
        }
    }

    /**
     * At startup: hand over what is still saved for people no longer here, whose removal a restart cut short before its
     * hand-over was saved.
     */
    async #handOverGone(): Promise<void> {
        const known = new Set(this.config.users.map((each) => each.id));
        const left = new Set<string>();

        for (const meta of Object.values(this.#sessions)) {
            if (
                meta.pip === undefined &&
                meta.createdBy !== undefined &&
                !known.has(meta.createdBy)
            ) {
                left.add(meta.createdBy);
            }
        }

        const check = (by: string | undefined): void => {
            if (by !== undefined && !known.has(by)) {
                left.add(by);
            }
        };

        const hooks = await this.harness.snapshot(HooksDoc, context);
        const watches = await this.harness.snapshot(RepoWatchesDoc, context);

        for (const hook of Object.values(hooks?.items ?? {})) {
            check(hook.by);
        }

        for (const watch of Object.values(watches?.items ?? {})) {
            check(watch.by);
        }

        for (const key of Object.keys(this.#sessions)) {
            for (const conversation of this.conversationsOf(
                Number(key) as unknown as ConversationId,
            )) {
                check((await this.harness.snapshot(WatchDoc, conversation, context))?.watch?.by);

                for (const schedule of Object.values(
                    (await this.harness.snapshot(ScheduleDoc, conversation, context))?.items ?? {},
                )) {
                    check(schedule.by);
                    check(schedule.requestedBy);
                }
            }
        }

        for (const person of left) {
            await this.handOver(person);
        }
    }

    /** Each person's tabs hear the approvals they may list. */
    #approvalsChanged(): void {
        for (const client of this.#clients) {
            client.send("folder-approvals", this.sessionApprovals(client.user));
        }
    }

    /** Each person's tabs hear their own requests, and those on computers they are in charge of. */
    #folderRequestsChanged(): void {
        for (const client of this.#clients) {
            client.send("folder-requests", this.folderRequests.list(client.user));
        }
    }
    /**
     * May `user` browse this server's folders, to choose one for a new session (`access.ts` `mayBrowse`): whoever the
     * owner chose for this server, and steers. A session's own folder, in its Files panel, follows the session instead.
     */
    requireBrowse(user: User): void {
        this.policy.requireBrowse(user, THIS_SERVER);
    }

    /**
     * The share list a new session on computer `runner` (undefined: this server) that `user` starts begins with, as
     * a `SessionMeta` part: no one, unless that computer shares new sessions with its people.
     */
    initialShares(runner: string | undefined, user: User): { sharedWith?: string[] } {
        const shared = this.policy.initialShares(runner ?? THIS_SERVER, user.id);

        return shared.length === 0 ? {} : { sharedWith: shared };
    }

    /**
     * A session on another computer acts there as the person who started it: only while they may still use it
     * (`access.ts` `mayStart`). Who leaves a computer hands their sessions there to who is in charge (`handOver`).
     */
    requireRunnerAccess(meta: SessionMeta): void {
        const runner = meta.runner;

        if (runner === undefined) {
            return;
        }

        if (this.config.runnerById(runner) === undefined) {
            throw new HttpError(
                403,
                "The computer this session ran on was removed from this server, so it cannot run there.",
            );
        }

        const starter = meta.createdBy ?? this.#ownerId();

        if (this.policy.mayStart({ id: starter }, runner)) {
            return;
        }

        throw new HttpError(
            403,
            `${this.config.userById(starter)?.name ?? "The person who started this session"} can no longer use ${this.runners.name(runner)}, so this session cannot run there.`,
        );
    }

    /**
     * May `user` see session `id` (any conversation of its tree): the access policy decides (`access.ts` `maySee`).
     */
    canSee(user: User, id: ConversationId): boolean {
        return this.policy.maySee(user, String(id));
    }

    requireSee(user: User, id: ConversationId): void {
        this.policy.requireSee(user, String(id));
    }

    /**
     * May `user` steer session `id`: see it, and be no viewer (`access.ts` `maySteer`). Viewers read, chat, and react;
     * they never make Pi do anything. With no session, only the role counts: the session's own check comes first.
     */
    requireSteer(user: User, id?: ConversationId): void {
        if (id !== undefined) {
            this.policy.requireSteer(user, String(id));

            return;
        }

        const current = this.config.userById(user.id);

        if (current === undefined || current.role === "viewer") {
            throw new HttpError(403, "Viewers cannot prompt. Ask to be made a user.");
        }
    }

    /**
     * While take turns is on, only the driver sends to Pi or changes its settings. And the session's approval must be
     * live (`#requireApproval`), or renewed now. `task`: one of its tasks runs (`tasksMayRun` decides), not a person.
     */
    async requireDriver(id: ConversationId, user: User, task?: boolean): Promise<void> {
        await this.requireTurn(id, user);

        if (task !== true) {
            await this.#requireApproval(id, user);
        } else if (!this.tasksMayRun(id)) {
            throw new HttpError(
                403,
                "This session's approval ended, so its tasks are paused until someone renews it.",
            );
        }
    }

    /**
     * Who may steer session `id`, and has the wheel while take turns is on. All that stopping work asks (cancelling a
     * schedule, ending a watch, stopping a linked session): an approval checks who a person is before Pi works for
     * them, and stopping makes Pi do nothing, so a locked session never makes it wait.
     */
    async requireTurn(id: ConversationId, user: User): Promise<void> {
        this.requireSteer(user, id);

        const root = this.rootOf(id);
        const turns = await this.harness.snapshot(TurnsDoc, root, context);

        // Only when no commit told it meanwhile: that one is newer than this read.
        if (!this.#turns.has(String(root))) {
            this.#turns.set(String(root), turns ?? { on: false });
        }

        this.#requireWheel(turns ?? undefined, user);
    }

    /** Refuse who does not have the wheel while take turns is on. */
    #requireWheel(turns: { on: boolean; driver?: string } | undefined, user: User): void {
        if (turns?.on !== true || turns.driver === user.id) {
            return;
        }

        const driver = turns.driver === undefined ? undefined : this.config.userById(turns.driver);

        throw new HttpError(
            409,
            driver === undefined
                ? "Take turns is on: take the wheel first."
                : `${driver.name} is driving. Ask to drive first.`,
        );
    }

    /** Refuse `user` when session `id`'s approval is not live for them now (`access.ts` `steer`). Nobody is asked. */
    #requireLive(id: ConversationId, user: User): void {
        const root = String(this.rootOf(id));
        const facts = this.policy.session(root);

        if (
            facts !== undefined &&
            facts.pip === undefined &&
            this.policy.steer(user, root) !== "allow"
        ) {
            throw new HttpError(
                409,
                "This session's approval ended before this was saved. Try again.",
            );
        }
    }

    /**
     * What `requireDriver` allowed, checked again now, without a read or a wait: `user` still sees and steers session
     * `id`, has the wheel, and its approval is live (a task: its tasks may run). A command prepares between its check and
     * its save, and the person can lose any of these meanwhile; this runs where the save happens (`admission`).
     */
    recheck(id: ConversationId, user: User, task?: boolean): void {
        this.requireSteer(user, id);
        this.#requireWheel(this.#turns.get(String(this.rootOf(id))), user);

        if (task !== true) {
            this.#requireLive(id, user);
        } else if (!this.tasksMayRun(id)) {
            throw new HttpError(
                403,
                "This session's approval ended, so its tasks are paused until someone renews it.",
            );
        }
    }

    /**
     * The context for a save that `user` makes in session `id`: Pi Durable reads its signal where the queued save
     * changes anything, and `recheck` (then `also`) runs on that read (`admission.ts`). Refused there, nothing is saved.
     * Only for the save itself: what follows it (waiting for the run, a second save that completes the first) uses the
     * plain context.
     */
    admission(
        id: ConversationId,
        user: User,
        options: { task?: boolean; parent?: Context; also?: () => void } = {},
    ): Context {
        return checkedContext(options.parent ?? context, () => {
            this.recheck(id, user, options.task);
            options.also?.();
        });
    }

    #noteChat(id: ConversationId, messages: readonly ChatMessage[] | undefined): boolean {
        const last = messages?.findLast((message) => message.kind !== "event");
        const key = String(id);
        const before = this.#lastChat.get(key);

        if (last === undefined) {
            return this.#lastChat.delete(key);
        }

        if (before?.at === last.at && before.userId === last.userId) {
            return false;
        }

        this.#lastChat.set(key, { at: last.at, userId: last.userId });

        return true;
    }

    /**
     * Count the commands a session runs in the background, starting ones too. While their extension is off no watch
     * settles a task whose process died, so only a task with a live process counts. True when the count changed.
     */
    #noteBackground(
        id: ConversationId,
        doc: { items: Record<string, BackgroundTask> } | null | undefined,
    ): boolean {
        const watched = this.background.running;
        const running = Object.values(doc?.items ?? {}).filter(
            (item) =>
                (item.status === "running" || item.status === "starting") &&
                (watched || this.background.alive(id, item)),
        ).length;

        if (running === (this.#background.get(id) ?? 0)) {
            return false;
        }

        if (running === 0) {
            this.#background.delete(id);
        } else {
            this.#background.set(id, running);
        }

        return true;
    }

    #noteSubagents(id: ConversationId, doc: SubagentsValue | null | undefined): void {
        const agents = doc?.agents ?? {};

        for (const record of Object.values(agents)) {
            this.#parents.set(record.conversationId, id);
        }

        if (Object.keys(agents).length === 0) {
            this.#subagents.delete(id);
        } else {
            this.#subagents.set(id, { agents: { ...agents }, reporting: reportingOf(doc) });
        }
    }

    /**
     * Every subagent, by the session it works in (its parent's, or the session its parent's chain started from), as the
     * subagents board shows it: the subagents bar's view, with the session and the call it waits on, if any.
     */
    #subagentsBySession(): Map<string, SubagentEntry[]> {
        const asks = new Map<ConversationId, ApprovalRequest>();

        for (const approval of this.approvals.all()) {
            if (!asks.has(approval.conversationId)) {
                asks.set(approval.conversationId, approval);
            }
        }

        const sessions = new Map<string, SubagentEntry[]>();
        const limited = new Map(
            this.limits.waits().map((wait) => [wait.conversationId, wait.view.until]),
        );

        for (const [parent, { agents, reporting }] of this.#subagents) {
            const session = String(this.rootOf(parent));

            if (this.#sessions[session] === undefined) {
                continue;
            }

            const list = sessions.get(session) ?? [];

            for (const [name, record] of Object.entries(agents)) {
                const ask = asks.get(record.conversationId);

                list.push({
                    id: Number(session),
                    ...subagentView(
                        name,
                        record,
                        this.#busy.has(record.conversationId),
                        reporting.has(name),
                        limited.get(Number(record.conversationId)),
                        this.subagentModel(record.conversationId),
                    ),
                    ...(ask === undefined
                        ? {}
                        : {
                              waiting: true,
                              approval: { tool: ask.tool, subject: ask.subject.slice(0, 200) },
                          }),
                });
            }

            sessions.set(session, list);
        }

        return sessions;
    }

    /**
     * Every subagent in the sessions this person can see, for the subagents board, but a session's oldest finished ones
     * past `BOARD_FINISHED`. Archived sessions are left out, unless one of their subagents works or waits there.
     */
    subagents(user?: User): SubagentEntry[] {
        const all: SubagentEntry[] = [];

        for (const [id, list] of this.#subagentsBySession()) {
            // The access policy decides, as for the session list (`access.ts` `maySee`).
            if (user !== undefined && !this.canSee(user, Number(id) as unknown as ConversationId)) {
                continue;
            }

            if (this.#sessions[id]?.archived === true && !list.some((entry) => entry.busy)) {
                continue;
            }

            all.push(...forBoard(list));
        }

        return all;
    }

    /**
     * A tab opened or closed the subagents board: while open, it gets every subagent with each session list. A request
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setBoard(user: User, connection: string, on: boolean, seq?: number): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.boardSeq ?? -Infinity)) {
                    continue;
                }

                client.boardSeq = seq;
            }

            client.board = on;
            client.boardSent = undefined;

            if (on) {
                this.#sendBoard(client, this.subagents(client.user));
            }
        }
    }

    /** Send a tab's board its subagents, unless they are what it last got. */
    #sendBoard(client: Client, entries: SubagentEntry[]): void {
        const json = JSON.stringify(entries);

        if (json !== client.boardSent) {
            client.boardSent = json;
            client.send("subagents", entries);
        }
    }

    /** A conversation's shared view, opened when no tab has it open. Hand it to `releaseRoom` when done with it. */
    async room(id: ConversationId): Promise<Room> {
        let pending = this.#rooms.get(id);

        if (pending === undefined) {
            pending = (async () => {
                const conversation = await this.harness.conversation(id, context);

                if (conversation === undefined) {
                    throw new HttpError(404, `Conversation ${String(id)} does not exist`);
                }

                const room = new Room(this, id);

                await room.open(conversation);

                return room;
            })();
            this.#rooms.set(id, pending);
            pending.catch(() => this.#rooms.delete(id));
        }

        return pending;
    }

    /** A conversation's shared view if it is open now; undefined otherwise, without opening it. */
    openRoom(id: ConversationId): Promise<Room> | undefined {
        return this.#rooms.get(id);
    }

    /** Close a room shortly after its last tab (or peek tile) left, unless one comes back first. */
    releaseRoom(room: Room): void {
        if (room.clients.size === 0 && room.peekers.size === 0) {
            room.closeLater(() => this.#rooms.delete(room.id));
        }
    }

    /** All signed-in models, with Pi's enabledModels scope marked for the picker. */
    async modelList() {
        // Pi settings are read from JSON; the SDK expects an array of strings.
        const configured = this.settings.getEnabledModels();
        const patterns = Array.isArray(configured)
            ? configured.filter((pattern): pattern is string => typeof pattern === "string")
            : [];
        // The scope asks Pi which models are available, which reads its sign-ins: one that cannot be read leaves the
        // scope out, as in a picker without one, rather than failing `hello` and with it every tab.
        const { scopedModels } =
            patterns.length > 0
                ? await resolveModelScopeWithDiagnostics(patterns, this.models).catch(() => ({
                      scopedModels: [],
                  }))
                : { scopedModels: [] };

        return modelList(this.models, this.signInNeeded, scopedModels);
    }

    async hello(user: User) {
        const models = await this.modelList();
        const guard = await this.guardStatus();
        // Read after the guard's wait, so a connecting device does not replace a live update with an older list.
        const folderFavorites = await this.folderFavorites.list(user);
        const runnerFavorites = await this.folderFavorites.runners(user);
        const runners = this.runners.list(user);
        const thisServer = this.thisServer(user);

        return {
            ...(thisServer === undefined ? {} : { thisServer }),
            folderRequests: this.folderRequests.list(user),
            folderApprovals: this.sessionApprovals(user),
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }),
                // May they start sessions on this server (`access.ts` `mayStart`): the app offers New only then.
                mayStart: this.#mayStartHere(user),
                // May they link computers of their own (`access.ts` `mayLink`): the Runners sheet offers it.
                mayLink: this.policy.mayLink(user),
                // Does the owner let them invite people (`access.ts` `invites`): the app offers Invite someone only then.
                invites: this.policy.invites(user),
            },
            // "Tasks expire with the session", for the owner's switch (`tasksMayRun`).
            ...(user.role === "owner" && this.config.server.tasksExpire === true
                ? { tasksExpire: true }
                : {}),
            users: this.people(user),
            models,
            guard,
            server: {
                pocketVersion: pocketVersion(),
                supervised: this.supervised,
                startedAt: this.startedAt,
                home: homedir(),
                defaultCwd: this.defaultCwd,
                extensions: this.loader.extensionNames(),
                // The shortest repeat, so the Schedules sheet's editor keeps Save off for one the server refuses.
                scheduleRepeatMinutes: this.schedules.limits.repeatMinutes,
                // The browser modules this person's tabs load (`extension-ui.js`), each with the tools its module
                // installs: the only ones whose calls it may describe (`pocket.toolCall`).
                ui: this.#browserModules(user),
                // The commands this person may run: viewers none, guests the ones for conversations.
                extensionCommands: this.webs
                    .commands()
                    .filter(
                        (command) =>
                            user.role === "owner" ||
                            (user.role === "guest" && command.scope === "conversation"),
                    ),
                // Tells the web app this server has people chat and typing indicators.
                chat: true,
                // Manual refresh reloads shared model configuration and catalogs; only the owner may start it.
                refreshModels: user.role === "owner",
                // Tells the web app this server sends peek tiles (`POST /api/peeks`, `peek` events).
                peeks: true,
                // Tells the web app it may show another session on the connection it has (`POST /api/switch`).
                switches: true,
                // Sessions tabs keep are good for servers of this build (`have`).
                build: this.build,
                // Whether a browser may keep sessions on the device (IndexedDB), for every tab and across reloads:
                // `PI_POCKET_SESSION_CACHE=off` keeps them in each tab's memory only, and has browsers drop what they
                // kept on the device.
                deviceCache: process.env.PI_POCKET_SESSION_CACHE !== "off",
                // This server's clock: peek tiles compare the browser's looks with when runs ended here.
                now: Date.now(),
                // Collaboration features: 2 adds roles, take turns, reactions, pins, notes, mentions, and push.
                collab: 2,
                reactions: REACTIONS,
                approvalRule: this.config.approvalRule,
                // The model and thinking level new sessions start with, or null for the last one picked.
                defaultModel: this.config.defaultModel ?? null,
                // The theme and colors of browsers that have not chosen their own, or null for the app's own.
                themeDefault: this.config.themeDefault ?? null,
                // The models Pi may start subagents on: the owner's to see and change.
                ...(user.role === "owner"
                    ? { subagentModels: [...this.config.subagentModels] }
                    : {}),
                // This person may have a PiP, the assistant over every screen (`pip.ts`).
                pip: this.pip.available(user),
                // Tokens of context above which PiP compacts itself once idle; 0: only as sessions do.
                pipCompactAt: this.pipCompaction.compactAt,
                // The most hours a run waits for a provider's limit to clear; 0: it does not wait (`limit-gate.ts`).
                limitWaitHours: this.config.limitWaitHours,
                // Keeping prompt caches warm once a run ends (`keep-warm.ts`): the owner's time limit.
                keepWarm: this.keepWarm.hello(),
            },
            folderFavorites,
            // The same, on each computer they may use (`runners.ts`), by its id.
            runnerFavorites,
            // Linked computers (`runners.ts`), for the owner's Runners sheet and New session's Runs on.
            ...(user.role === "owner" || runners.length > 0 ? { runners } : {}),
            // Every theme folder, for Appearance and for the look this tab uses (`theme.js`).
            themes: this.themes.list(user.role === "owner"),
        };
    }

    #browserModules(user: User) {
        const tools = new Map(
            this.loader
                .list()
                .map((each) => [
                    each.file.replace(/\.ts$/, ""),
                    each.extensions.flatMap((extension) => extension.tools),
                ]),
        );

        return this.webs
            .clients(user)
            .map((each) => ({ ...each, tools: tools.get(each.module) ?? [] }));
    }

    /** A tab's hello: what everyone gets, and the id of its own connection, which its peek lists name. */
    #helloFor(client: Client, hello: Awaited<ReturnType<PocketApp["hello"]>>) {
        return withReveal(
            { ...hello, connection: client.connection },
            client.user,
            client.local === true,
        );
    }

    #scheduleSessions(): void {
        if (this.#sessionsTimer !== undefined) {
            return;
        }

        this.#sessionsTimer = setTimeout(() => {
            this.#sessionsTimer = undefined;
            // Each person gets their own list, made for them (`access.ts`): one made for someone else could carry a
            // session, or a linked origin, they may not see. People with the same rights share one.
            const lists = new Map<
                string,
                { sessions: ReturnType<PocketApp["sessions"]>; json: string }
            >();
            const boards = new Map<string, SubagentEntry[]>();

            for (const client of this.#clients) {
                const user = this.config.userById(client.user.id) ?? client.user;
                let list = lists.get(user.id);

                if (list === undefined) {
                    const sessions = this.sessions(user);

                    list = { sessions, json: JSON.stringify(sessions) };
                    lists.set(user.id, list);
                }

                this.#sendSessions(client, list.sessions, list.json);
                this.#sendPip(client);

                if (client.board === true) {
                    let entries = boards.get(user.id);

                    if (entries === undefined) {
                        entries = this.subagents(user);
                        boards.set(user.id, entries);
                    }

                    this.#sendBoard(client, entries);
                }
            }
        }, 400);
    }

    /** Send a tab its session list, unless it is what the tab last got: the list is large, and changes come often. */
    #sendSessions(
        client: Client,
        sessions: ReturnType<PocketApp["sessions"]>,
        json = JSON.stringify(sessions),
    ): void {
        if (json !== client.sessionsSent) {
            client.sessionsSent = json;
            client.send("sessions", sessions);
        }
    }

    #oldestAsks(): Map<string, SessionAsk> {
        const asks = new Map<string, SessionAsk>();

        for (const request of this.approvals.all()) {
            const session = String(this.rootOf(request.conversationId));
            const kept = asks.get(session);

            if (kept !== undefined && kept.at <= request.createdAt) {
                kept.count++;

                continue;
            }

            asks.set(session, {
                id: request.id,
                conversationId: Number(request.conversationId),
                tool: request.tool,
                subject: request.subject.slice(0, ASK_SUBJECT),
                reason: request.reason.slice(0, ASK_REASON),
                ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
                ...(request.form === undefined ? {} : { form: true as const }),
                at: request.createdAt,
                count: (kept?.count ?? 0) + 1,
            });
        }

        return asks;
    }

    /** The session list, with who is in each session and its newest chat message. Scoped people see only theirs. */
    sessions(user?: User) {
        const waiting = new Set(
            this.approvals.all().map((approval) => String(this.rootOf(approval.conversationId))),
        );
        const people = new Map<string, Map<string, string>>();
        const subagents = this.#subagentsBySession();
        const asks = this.#oldestAsks();
        // The sessions in a wait for a provider's limit, their subagents' included: when the next request goes out.
        const limited = new Map<string, number>();

        for (const wait of this.limits.waits()) {
            const session = String(this.rootOf(wait.conversationId as unknown as ConversationId));

            limited.set(session, Math.min(limited.get(session) ?? Infinity, wait.view.until));
        }

        for (const client of this.#clients) {
            if (client.conversationId === undefined) {
                continue;
            }

            const key = String(client.conversationId);
            const here = people.get(key) ?? new Map<string, string>();

            here.set(client.user.id, client.user.name);
            people.set(key, here);
        }

        return Object.entries(this.#sessions)
            .filter(
                ([id, meta]) =>
                    // PiP is not a session people pick: it shows in its own panel (`pip.ts`).
                    meta.pip === undefined &&
                    // With a person, only the sessions the access policy lets them see (`access.ts` `maySee`).
                    (user === undefined ||
                        this.canSee(user, Number(id) as unknown as ConversationId)),
            )
            .map(([id, meta]) => {
                const model = this.#agents.get(Number(id) as unknown as ConversationId)?.model;
                const busy = this.#busy.has(Number(id) as unknown as ConversationId);
                const here = [...(people.get(id) ?? new Map<string, string>())].map(
                    ([userId, name]) => ({ id: userId, name }),
                );
                const chat = this.#lastChat.get(id);
                const endedAt = this.#endedAt.get(Number(id) as unknown as ConversationId);
                const counts = countSubagents(subagents.get(id) ?? []);
                const background = this.#background.get(Number(id) as unknown as ConversationId);
                const failure = this.#failed.get(Number(id) as unknown as ConversationId);
                const failedAgents = failedSubagents(subagents.get(id) ?? []);
                const ask = asks.get(id);
                // Which of Pi's sessions it continues is the owner's to know (the Pi sessions sheet), not the list's.
                const { fromPi: _fromPi, linkedFrom, ...shown } = meta;
                // Linking does not share the origin: do not leak its id to someone who only sees the new chat.
                const origin =
                    linkedFrom === undefined ? undefined : this.#sessions[String(linkedFrom.id)];
                const visibleOrigin =
                    origin !== undefined &&
                    origin.pip === undefined &&
                    (user === undefined ||
                        this.canSee(user, linkedFrom!.id as unknown as ConversationId));

                const linkage: { linkedFrom?: SessionMeta["linkedFrom"]; linkedOrigin?: true } =
                    linkedFrom === undefined
                        ? {}
                        : visibleOrigin
                          ? { linkedFrom }
                          : { linkedOrigin: true };

                return {
                    id: Number(id),
                    ...shown,
                    ...linkage,
                    busy,
                    waiting: waiting.has(id),
                    // Its computer is offline: the list marks it, and its work waits for it.
                    ...(meta.runner !== undefined && !this.runners.link(meta.runner).online
                        ? { offline: true }
                        : {}),
                    ...(limited.has(id) ? { limited: limited.get(id)! } : {}),
                    ...(endedAt === undefined ? {} : { endedAt }),
                    ...(failure === undefined ? {} : { failed: true, failure }),
                    ...(failedAgents.length === 0 ? {} : { failedAgents }),
                    ...(ask === undefined ? {} : { approval: ask }),
                    ...(model === undefined ? {} : { model: model.modelId }),
                    ...(here.length === 0 ? {} : { people: here }),
                    ...(chat === undefined ? {} : { chatAt: chat.at, chatBy: chat.userId }),
                    ...(counts === undefined ? {} : { subagents: counts }),
                    ...(background === undefined ? {} : { background }),
                    // May this person change whom it is shared with (`access.ts` `mayShare`): its menu offers Share.
                    ...(user !== undefined && this.policy.mayShare(user, id)
                        ? { mayShare: true as const }
                        : {}),
                };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * The model a subagent runs on, for its row in the subagents bar and on the board, and whether it is another model
     * than its parent's; none before its agent is known.
     */
    subagentModel(id: ConversationId): SubagentModel | undefined {
        const agent = this.#agents.get(id);
        const ref = agent?.model;

        if (ref === undefined) {
            return undefined;
        }

        const parent = this.#parents.get(id);
        const theirs = parent === undefined ? undefined : this.#agents.get(parent)?.model;

        return {
            name: this.models.getModel(ref.provider, ref.modelId)?.name ?? ref.modelId,
            ...(agent?.thinkingLevel === undefined ? {} : { thinking: agent.thinkingLevel }),
            ...(theirs !== undefined &&
            (theirs.provider !== ref.provider || theirs.modelId !== ref.modelId)
                ? { other: true as const }
                : {}),
        };
    }

    /**
     * The folders of the newest sessions `user` sees on one computer (`runner`; undefined: this server), newest first,
     * at most 8: the folder picker's Recent for that computer.
     */
    recentFolders(user: User, runner: string | undefined): string[] {
        return [
            ...new Set(
                this.sessions(user)
                    // A workspace URI is not a folder the picker can open: its provider's module starts sessions there.
                    .filter(
                        (session) =>
                            session.runner === runner &&
                            this.workspaceScheme(session.cwd) === undefined,
                    )
                    .map((session) => session.cwd),
            ),
        ].slice(0, 8);
    }

    isBusy(id: ConversationId): boolean {
        return this.#busy.has(id);
    }

    /** The conversations with a run going. */
    busyConversations(): ConversationId[] {
        return [...this.#busy];
    }

    /** The catalogue entry of a session; undefined for subagents and other conversations. */
    sessionMeta(id: ConversationId): SessionMeta | undefined {
        return this.#sessions[String(id)];
    }

    /** Every session's catalogue entry, PiP's included, by id. */
    sessionCatalogue(): Readonly<Record<string, SessionMeta>> {
        return this.#sessions;
    }

    /** When a session's last run ended, since this server started. */
    endedAt(id: ConversationId): number | undefined {
        return this.#endedAt.get(id);
    }

    /**
     * The failure line a session should show after a restart. A run still going clears a line a crash left behind. An
     * idle session takes the line of its run's newest settled input, which the run's own commit stored, and writes a line
     * that disagrees back. Undefined when there is nothing to show.
     */
    async #failureOf(
        storage: Storage,
        id: ConversationId,
        live: { run?: unknown } | null | undefined,
    ): Promise<string | undefined> {
        const stored = (await this.harness.snapshot(RunFailureDoc, id, context))?.text;

        if (live?.run !== undefined) {
            if (stored !== undefined) {
                this.#storeRunFailure(id, undefined);
            }

            return undefined;
        }

        // The newest settled input is the last run's: submission ids grow with each commit. Notes and other writes
        // after it are skipped. A run that gave up leaves every one of its inputs unanswered, so that input still says so.
        let record: SubmissionRecord | undefined;
        let cursor: Cursor | undefined;

        do {
            const page = await storage.scanSubmissions(
                { conversationId: id, order: "descending" },
                64,
                cursor,
                context,
            );

            // A queued input, or one withdrawn from the queue, never joined a run. One a run gave up on may have no entry.
            record = page.items.find(
                (each) =>
                    each.type === "input" &&
                    (each.entry !== undefined ||
                        (each.status === "unanswered" && FAILED_RUN.has(each.reason))),
            );
            cursor = record === undefined ? page.next : undefined;
        } while (cursor !== undefined);

        const text =
            record?.status === "unanswered"
                ? failureText(record.status, record.reason, record.detail)
                : undefined;

        if (text !== stored) {
            this.#storeRunFailure(id, text);
        }

        return text;
    }

    /** Keep or clear a session's failure line, so the next process still knows. A listener may not commit. */
    #storeRunFailure(id: ConversationId, text: string | undefined): void {
        if (this.#sessions[String(id)] === undefined) {
            return;
        }

        setImmediate(() => {
            this.harness
                .commit(async (tx) => {
                    const record = await tx.doc(RunFailureDoc, id);

                    if (text === undefined) {
                        delete record.text;
                    } else {
                        record.text = text;
                    }
                }, context)
                .catch((error: unknown) => this.log(`run failure not stored: ${describe(error)}`));
        });
    }

    async conversationTitle(id: ConversationId): Promise<string> {
        const meta = this.#sessions[String(id)];

        if (meta !== undefined) {
            return meta.title ?? "New session";
        }

        return `Conversation ${String(id)}`;
    }

    /** What a tab shows of a conversation. `viewer`: whose tab; a session it was forked from that they may not see is not named. */
    conversationInfo(room: Room, viewer?: User) {
        const meta = this.#sessions[String(room.id)];
        const agent = (room.value?.docs["pi.agent"] ?? {}) as AgentState;
        const forkedFrom = meta?.forkedFrom;
        const root = this.rootOf(room.id);
        const subagent = meta === undefined && room.parent !== undefined;
        // A subagent shows what it cost itself: the session's spend and limit are on the session.
        const budget = subagent ? undefined : this.#sessions[String(root)]?.budget;

        return {
            id: room.id,
            kind:
                meta === undefined
                    ? room.parent === undefined
                        ? "conversation"
                        : "subagent"
                    : "session",
            title:
                meta?.title ??
                room.subagentName ??
                (meta === undefined ? `Conversation ${String(room.id)}` : "New session"),
            cwd: agent.cwd ?? meta?.cwd ?? this.defaultCwd,
            archived: meta?.archived === true,
            // PiP's own conversation, opened as a page: some session things (a PR to watch) are not for it.
            ...(meta?.pip === undefined ? {} : { pip: true }),
            ...(room.parent === undefined ? {} : { parent: room.parent }),
            ...(room.subagentName === undefined ? {} : { subagentName: room.subagentName }),
            // Each browser finds the source's title in its own session list, so only people who can open it get a link.
            // Someone who may not see the source learns only that there is one.
            ...(forkedFrom === undefined
                ? {}
                : {
                      forkedFrom:
                          viewer === undefined || this.policy.maySee(viewer, String(forkedFrom.id))
                              ? forkedFrom
                              : {},
                  }),
            // The session's spend with its subagents', and its limit, with what counts against it.
            spend: {
                spent: subagent
                    ? this.spend.conversationSpent(room.id)
                    : budget === undefined
                      ? this.spend.sessionSpent(root)
                      : this.spend.budgetSpent(root),
                ...(budget === undefined ? {} : { budget }),
            },
            ...(meta?.worktree === undefined
                ? {}
                : { worktree: { branch: meta.worktree.branch, source: meta.worktree.source } }),
            // Keep warm: the session's choice and what its cache keeper does now.
            ...(meta === undefined ? {} : { keepWarm: this.keepWarm.session(room.id) }),
            // Whether a fork could get a worktree of its own.
            // A session on another computer: its folder and repository are read there, never here.
            ...(this.runnerOf(room.id) === undefined
                ? meta === undefined
                    ? {}
                    : { inRepository: this.workspace.inRepository(agent.cwd ?? meta.cwd) }
                : {
                      runner: this.runnerOf(room.id)!,
                      runnerName: this.runners.name(this.runnerOf(room.id)!),
                      // Read, not checked: a view that throws would end the room's push (`room.ts`).
                      runnerPermission: this.runnerPermission(room.id),
                      // Offline is offline: the view says so, and what is sent waits for it.
                      runnerOnline: this.runners.link(this.runnerOf(room.id)!).online,
                  }),
        };
    }

    /** What a conversation runs with: its model, thinking level, folder, and instructions. */
    async agentState(id: ConversationId): Promise<AgentState | undefined> {
        return (
            this.#agents.get(id) ??
            ((await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined)
        );
    }

    /** A conversation's handle; 404 when it does not exist. */
    async conversation(id: ConversationId): Promise<Conversation> {
        const conversation = await this.harness.conversation(id, context);

        if (conversation === undefined) {
            throw new HttpError(404, `Conversation ${String(id)} does not exist`);
        }

        return conversation;
    }

    /**
     * Why this person may not allow a call, or undefined when they may. With the "others" rule, a guest cannot allow a
     * call their own message led to; the owner always can. Denying is open to anyone who can steer.
     */
    cannotAllow(user: User, request: ApprovalRequest): string | undefined {
        if (user.role === "viewer") {
            return "You can view this session but not steer Pi.";
        }

        // An ask (`host.ask`) is answered by the person Pi works for: what it asks for is theirs. With nobody known, the
        // owner answers it. Anyone who can steer can decline it.
        if (request.form !== undefined) {
            const answerer =
                request.requestedBy ?? this.config.users.find((each) => each.role === "owner")?.id;

            return answerer === user.id
                ? undefined
                : "Only the person Pi works for here can answer this.";
        }

        if (this.config.approvalRule !== "others" || user.role === "owner") {
            return undefined;
        }

        // Not knowing who asked is not knowing that it was someone else.
        if (request.requestedBy === undefined) {
            return "Nobody is known to have asked for this call, so only the owner can allow it.";
        }

        return request.requestedBy === user.id
            ? "Someone else has to allow a call that your message led to."
            : undefined;
    }

    async answerApproval(
        id: string,
        allow: boolean,
        user: User,
        values?: unknown,
    ): Promise<boolean> {
        const request = this.approvals.all().find((each) => each.id === id);

        if (request === undefined || !this.canSee(user, request.conversationId)) {
            return false;
        }

        this.requireSteer(user, request.conversationId);

        const refused = allow ? this.cannotAllow(user, request) : undefined;

        if (refused !== undefined) {
            throw new HttpError(403, refused);
        }

        let given: Record<string, string> | undefined;

        // An ask's answer is what was typed, each field filled in: a plain Allow (from a notification, say) is not one.
        if (allow && request.form !== undefined) {
            try {
                given = checkValues(request.form.fields, values);
            } catch (error) {
                throw new HttpError(400, describe(error));
            }
        }

        if (
            !this.approvals.answer(id, {
                allow,
                by: user.name,
                ...(given === undefined ? {} : { values: given }),
            })
        ) {
            return false;
        }

        const conversationId = request.conversationId;

        if (request.callId !== undefined) {
            const callId = request.callId;

            await this.harness
                .commit(async (tx) => {
                    (await tx.doc(DecisionsDoc, conversationId)).calls[callId] = {
                        allow,
                        by: user.name,
                        userId: user.id,
                        at: Date.now(),
                        ...(request.form === undefined ? {} : { ask: true as const }),
                    };
                }, context)
                .catch((error: unknown) => this.#log(`decision not recorded: ${describe(error)}`));
        }

        const form = request.form;
        const what =
            form === undefined
                ? `${allow ? "allowed" : "denied"} the ${request.tool} call: ${request.subject}`
                : `${allow ? "answered" : "declined"}: ${form.fields.some((field) => field.choices) ? request.reason : request.subject}`;

        await this.collab.activity(conversationId, user, snippet(what, 160));

        return true;
    }

    /** The owner changes what someone may do: their role, or which session they may open. */
    setAccess(
        owner: User,
        userId: string,
        patch: { role?: unknown; sessions?: unknown; temporary?: unknown },
    ): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(userId);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (target.role === "owner") {
            throw new HttpError(400, "The owner can do everything");
        }

        const change: {
            role?: "guest" | "viewer";
            sessions?: string[] | undefined;
            temporary?: false;
        } = {};

        // A temporary account becomes a full one, never the other way: an invite alone makes one temporary.
        if (patch.temporary !== undefined) {
            if (patch.temporary !== false) {
                throw new HttpError(400, "A temporary account can only be made a full one.");
            }

            change.temporary = false;
        }

        if (patch.role !== undefined) {
            if (patch.role !== "guest" && patch.role !== "viewer") {
                throw new HttpError(400, "role must be guest or viewer");
            }

            // A temporary account links no authenticator, so it stays a viewer until it is a full account.
            if (patch.role === "guest" && target.temporary === true) {
                throw new HttpError(
                    409,
                    `${target.name} has a temporary account. Turn Temporary account off first.`,
                );
            }

            // Steering needs their own authenticator: it proves it is them when a session needs an approval.
            if (
                patch.role === "guest" &&
                target.role === "viewer" &&
                !this.authenticators.linked(target.id)
            ) {
                throw new HttpError(
                    409,
                    `${target.name} must link an authenticator first: in Pi Pocket, under their name.`,
                );
            }

            change.role = patch.role;
        }

        if (patch.sessions !== undefined) {
            if (patch.sessions === null) {
                change.sessions = undefined;
            } else if (
                Array.isArray(patch.sessions) &&
                // A session they have already, or one the owner may share (`access.ts` `mayShare`): never one on a computer
                // someone else is in charge of, which the owner does not see. Such a one answers as a missing one.
                patch.sessions.every(
                    (each) =>
                        this.#sessions[String(each)] !== undefined &&
                        (target.sessions?.includes(String(each)) === true ||
                            this.policy.mayShare(owner, String(each))),
                )
            ) {
                change.sessions = patch.sessions.map(String);
            } else {
                throw new HttpError(400, "sessions must be null or a list of session ids");
            }
        }

        this.config.updateUser(userId, change);
        void this.#refreshUser(userId);
        this.accessChanged();
        this.#peopleChanged();
    }

    /**
     * Someone's rights changed: a person, the people chosen for a computer, a session's share list, or a computer's
     * rules. Tabs leave the sessions, and stop peeking at the ones, they may no longer see, at once; every list is sent
     * again, made for its person (`#scheduleSessions`). The policy reads the live records, so nothing else is kept.
     */
    accessChanged(): void {
        // A request of someone who may no longer work there ends: no longer chosen, made a viewer, or no longer given the
        // folder. A session's approval stays with the session (`handOver` gives it to who is in charge).
        this.folderRequests.prune((request) =>
            request.kind === "renew"
                ? this.policy.maySteer({ id: request.person }, request.session ?? "")
                : this.policy.mayUseFolder(
                      { id: request.person },
                      request.computer,
                      request.folder,
                  ),
        );
        this.#approvalsChanged();

        // Someone chosen, or no longer, for this server: their tabs learn whether to offer New.
        for (const user of this.config.users) {
            if (
                this.#startsHere.has(user.id) &&
                this.#startsHere.get(user.id) !== this.policy.mayStart(user, THIS_SERVER)
            ) {
                void this.#refreshUser(user.id);
            }
        }

        for (const client of [...this.#clients]) {
            if (
                client.conversationId !== undefined &&
                !this.canSee(client.user, client.conversationId)
            ) {
                this.#evict(client, "This session is no longer shared with you.");
            }

            for (const id of client.peeks ?? []) {
                if (!this.canSee(client.user, id)) {
                    client.peeks?.delete(id);
                    this.#unpeek(client, id);
                }
            }
        }

        this.runners.changed();
        this.#scheduleSessions();
    }

    /**
     * Remove `person`'s authenticator (`by`: themselves with a code, or the owner). Steering needs one (`setAccess`), so a
     * guest goes back to viewing: their tabs, requests, and lists follow at once, and the owner lets them steer again
     * once they link a new one.
     */
    removeAuthenticator(person: string, by: User, code?: string): void {
        this.authenticators.remove(person, by, code);

        const target = this.config.userById(person);

        if (target?.role === "guest") {
            this.config.updateUser(person, { role: "viewer" });
            void this.#refreshUser(person);
            this.accessChanged();
        }

        this.#peopleChanged();
    }

    async removeUser(owner: User, userId: string): Promise<void> {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (this.config.userById(userId)?.role === "owner") {
            throw new HttpError(400, "The owner cannot be removed");
        }

        await this.#forget(userId);
    }

    /**
     * Who is in charge of computer `id` chooses its people: the whole list. Who is no longer chosen leaves its sessions
     * at once; their sessions there, and their tasks, move to who is in charge (`handOver`).
     */
    async choosePeople(id: string, users: string[]): Promise<void> {
        const before =
            id === THIS_SERVER
                ? (this.config.server.users ?? [])
                : (this.config.runnerById(id)?.users ?? []);

        if (id === THIS_SERVER) {
            this.config.setServerUsers(users);
        } else {
            this.config.setRunnerUsers(id, users);
        }

        const gone = before.filter((each) => !users.includes(each));

        // Their tabs leave at once, before the hand-over's saves: no event of a session there reaches them meanwhile.
        this.accessChanged();

        if (gone.length === 0) {
            return;
        }

        // Shares on that computer end with it: chosen again later, they see only what is shared with them anew.
        await this.harness.commit(async (tx) => {
            for (const meta of Object.values((await tx.doc(SessionsDoc)).items)) {
                if ((meta.runner ?? THIS_SERVER) !== id || meta.sharedWith === undefined) {
                    continue;
                }

                const kept = meta.sharedWith.filter((each) => !gone.includes(each));

                if (kept.length === 0) {
                    delete meta.sharedWith;
                } else {
                    meta.sharedWith = kept;
                }
            }
        }, context);

        for (const person of gone) {
            await this.handOver(person, id);
        }

        this.accessChanged();
    }

    /**
     * Who is in charge of computer `id` chooses `person` for it, or no longer: its list as it is now, with that one
     * change (`choosePeople`). Read and saved in one step, so two such changes at once both count. A person who cannot be
     * chosen is refused with the reason, where the whole list leaves them out without a word.
     */
    async choosePerson(id: string, person: string, on: boolean): Promise<void> {
        const target = this.config.userById(person);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (on && this.policy.inCharge(target, id)) {
            throw new HttpError(400, `${target.name} is in charge of it, and has it anyway.`);
        }

        if (on && target.sessions !== undefined) {
            throw new HttpError(
                400,
                `${target.name} is invited to one session only. Remove that limit first.`,
            );
        }

        const now =
            id === THIS_SERVER
                ? (this.config.server.users ?? [])
                : (this.config.runnerById(id)?.users ?? []);

        await this.choosePeople(id, on ? [...now, person] : now.filter((each) => each !== person));
    }

    /**
     * Unlink runner `id` (its linker, or the owner): its link ends. Its sessions stay, as before, and run nowhere until
     * it is linked again.
     */
    async unlinkRunner(id: string): Promise<void> {
        this.runners.remove(id);
        this.accessChanged();
    }

    /**
     * Someone joined with `inviter`'s invite to every session: they see the sessions `inviter` started, and those shared
     * with everyone chosen on their computer, as they are now. Sessions started later are not theirs to see unless shared.
     * Only sessions `inviter` may see: an invite never passes on what its maker could not open.
     *
     * With `folder`, the invite was to one folder: only the sessions `inviter` started in it on that computer.
     */
    async welcome(
        person: string,
        inviter: string,
        folder?: { computer: string; path: string },
    ): Promise<void> {
        const by = this.config.userById(inviter);

        if (by === undefined) {
            return;
        }

        await this.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);

            for (const [key, meta] of Object.entries(sessions.items)) {
                if (meta.pip !== undefined || !this.policy.maySee(by, key)) {
                    continue;
                }

                const computer = meta.runner ?? THIS_SERVER;
                const chosen =
                    computer === THIS_SERVER
                        ? (this.config.server.users ?? [])
                        : (this.config.runnerById(computer)?.users ?? []);
                const starter = meta.createdBy ?? this.#ownerId();
                const everyone =
                    chosen.length > 0 &&
                    chosen.every(
                        (each) => each === starter || meta.sharedWith?.includes(each) === true,
                    );

                const given =
                    folder === undefined
                        ? starter === inviter || everyone
                        : starter === inviter &&
                          computer === folder.computer &&
                          inFolder(this.#accessFolder(meta), folder.path);

                if (given) {
                    meta.sharedWith = [...new Set([...(meta.sharedWith ?? []), person])];
                }
            }
        }, context);
        this.accessChanged();
    }

    /** The owner lets guest `person` link computers of their own, or takes that back. */
    setLinksRunners(owner: User, person: string, on: boolean): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(person);

        if (target === undefined || target.role === "owner") {
            throw new HttpError(404, "No such person");
        }

        this.config.updateUser(person, { linksRunners: on ? true : undefined });
        this.#peopleChanged();
        this.runners.changed();
    }

    /**
     * The owner lets guest `person` invite people, or takes that back. Off until the owner turns it on; an invite they
     * made before stops working with it (`auth.ts` `redeem`).
     */
    setInvites(owner: User, person: string, on: boolean): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(person);

        if (target === undefined || target.role === "owner") {
            throw new HttpError(404, "No such person");
        }

        this.config.updateUser(person, { invites: on ? true : undefined });
        void this.#refreshUser(person);
        this.#peopleChanged();
    }

    /**
     * How other devices reach this server, from the launcher. People who signed in through another Cloudflare quick
     * tunnel can never sign in again (its address is gone, and their cookie works only there), so they are removed.
     * Another device of someone here that came through it is signed out alone: the person stays.
     */
    setReach(access: AccessInfo | undefined): void {
        this.access = access;
        let current: string | undefined;

        try {
            current = access?.url === undefined ? undefined : new URL(access.url).host;
        } catch {}

        for (const user of [...this.config.users]) {
            if (user.role !== "owner" && user.tunnel !== undefined && user.tunnel !== current) {
                void this.#forget(user.id);
            }
        }

        this.config.endTunnelDevices(current);
    }

    async #forget(userId: string): Promise<void> {
        // The computers they linked go to the owner; their sessions and tasks, to who is in charge of each computer.
        this.config.removeUser(userId);

        // Their open tabs end now, before anything is saved: no event reaches them meanwhile. Reconnecting fails, so
        // they land on the sign-in screen.
        for (const client of [...this.#clients]) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("closing", {});
            this.detach(client);
            client.close?.();
        }

        for (const runner of this.config.runners) {
            if (runner.createdBy === userId) {
                this.config.setRunnerLinker(runner.id, this.#ownerId());
            }
        }

        await this.handOver(userId);
        this.#startsHere.delete(userId);
        this.folderRequests.prune((request) => request.person !== userId);
        this.runners.changed();
        removeAvatar(this.dataDir, userId);
        this.pushStore?.removeUser(userId);
        this.#peopleChanged();
    }

    /** Take a tab out of a conversation it may no longer see; it keeps app-wide events. */
    #evict(client: Client, message: string): void {
        const id = client.conversationId;

        if (id === undefined) {
            return;
        }

        client.conversationId = undefined;
        client.send("missing", { conversationId: id, message });
        this.#leaveRoom(client, id);
    }

    /** What each person's last hello said of starting sessions here, to send a new one when it changes. */
    readonly #startsHere = new Map<string, boolean>();

    #mayStartHere(user: User): boolean {
        const may = this.policy.mayStart(user, THIS_SERVER);

        this.#startsHere.set(user.id, may);

        return may;
    }

    /** Someone's rights changed: their tabs get a fresh hello and session list. */
    async #refreshUser(userId: string): Promise<void> {
        const user = this.config.userById(userId);

        if (user === undefined) {
            return;
        }

        for (const client of this.#clients) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("hello", this.#helloFor(client, await this.hello(user)));
            this.#sendSessions(client, this.sessions(user));

            // An open board too: it must not keep subagents of sessions no longer shared.
            if (client.board === true) {
                client.boardSent = undefined;
                this.#sendBoard(client, this.subagents(user));
            }
        }
    }

    /**
     * Every artifact in the sessions this person can see, for the artifacts overview: one entry for each, with its
     * current (latest) version and how many versions it has. Archived sessions are left out. Newest first.
     */
    async artifactOverview(user: User): Promise<ArtifactOverviewEntry[]> {
        const one = async (
            session: string,
            meta: SessionMeta,
        ): Promise<ArtifactOverviewEntry[]> => {
            const id = Number(session) as unknown as ConversationId;

            // A PiP is its owner's assistant, and kept out of the session list.
            if (meta.archived === true || meta.pip !== undefined || !this.canSee(user, id)) {
                return [];
            }

            try {
                const index = await this.harness.snapshot(ArtifactsDoc, id, context);
                const entries: ArtifactOverviewEntry[] = [];

                for (const [artifact, item] of Object.entries(index?.items ?? {})) {
                    const current = item.versions.at(-1);

                    if (current === undefined) {
                        continue;
                    }

                    entries.push({
                        session: Number(session),
                        sessionTitle: meta.title ?? "",
                        id: artifact,
                        title: item.title,
                        type: item.type,
                        ...(item.kind === undefined ? {} : { kind: item.kind }),
                        ...(item.group === undefined ? {} : { group: item.group }),
                        current: current.version,
                        versions: item.versions.length,
                        size: current.size,
                        updatedAt: current.createdAt,
                    });
                }

                return entries;
            } catch (error) {
                // One session's broken artifacts must not hide the others'.
                console.error(`Artifacts of session ${session} could not be read:`, error);

                return [];
            }
        };

        const sessions = Object.entries(this.#sessions);
        const found: ArtifactOverviewEntry[] = [];

        // A few sessions at a time: a person with many sessions does not make the server read all of them at once.
        for (let from = 0; from < sessions.length; from += OVERVIEW_BATCH) {
            const batch = sessions.slice(from, from + OVERVIEW_BATCH);

            found.push(...(await Promise.all(batch.map(([id, meta]) => one(id, meta)))).flat());
        }

        // The person as they are now: a share removed while this ran takes its entries out.
        const now = this.config.userById(user.id);

        return found
            .filter(
                (entry) =>
                    now !== undefined &&
                    this.canSee(now, entry.session as unknown as ConversationId),
            )
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async artifactBody(id: ConversationId, artifact: string, version?: number) {
        const index = await this.harness.snapshot(ArtifactsDoc, id, context);
        // Its own entries only: `__proto__` and the like name no artifact.
        const meta =
            index !== undefined && Object.hasOwn(index.items, artifact)
                ? (index.items[artifact] as ArtifactMeta)
                : undefined;

        if (meta === undefined) {
            throw new HttpError(404, "No such artifact");
        }

        const chosen =
            version === undefined
                ? meta.versions.at(-1)
                : meta.versions.find((each) => each.version === version);

        if (chosen === undefined) {
            throw new HttpError(404, "No such version");
        }

        const body = await this.harness.snapshot(
            ArtifactBodyDoc,
            id,
            `${artifact}@${chosen.version}`,
            context,
        );

        if (body === undefined) {
            throw new HttpError(404, "Artifact content is missing");
        }

        return { meta, version: chosen.version, content: body.content };
    }

    /** One manifest asset. Missing names must not load the rest of a potentially large bundle. */
    async artifactAsset(id: ConversationId, artifact: string, version: number, name: string) {
        const found = await this.artifactBody(id, artifact, version);
        const manifest = found.meta.versions.find((each) => each.version === found.version)!.assets;
        const asset =
            manifest !== undefined && Object.hasOwn(manifest, name) ? manifest[name] : undefined;

        if (asset === undefined) {
            throw new HttpError(404, "No such asset");
        }

        const stored = await this.harness.snapshot(ArtifactAssetDoc, asset.hash, context);

        if (stored === undefined) {
            throw new HttpError(404, "Artifact asset is missing");
        }

        return {
            name,
            type: asset.type,
            bytes: Buffer.from(stored.base64, "base64"),
            title: found.meta.title,
        };
    }

    /** A complete bundle for rendering and export. Callers must check conversation access first. */
    async artifactBundle(id: ConversationId, artifact: string, version?: number) {
        const found = await this.artifactBody(id, artifact, version);
        const manifest = found.meta.versions.find((each) => each.version === found.version)!.assets;
        const assets = await Promise.all(
            Object.entries(manifest ?? {}).map(async ([name, asset]) => {
                const stored = await this.harness.snapshot(ArtifactAssetDoc, asset.hash, context);

                if (stored === undefined) {
                    throw new HttpError(404, "Artifact asset is missing");
                }

                return { name, type: asset.type, bytes: Buffer.from(stored.base64, "base64") };
            }),
        );

        return { ...found, assets };
    }

    /** The folder a conversation works in. */
    cwdOf(id: ConversationId): string {
        return this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
    }

    /** When Pi's settings were last read: Pi's CLI, or a person, can change them while Pi Pocket runs. */
    #settingsReadAt = Date.now();

    /**
     * What says where Pi's skills are, besides a session's folder: Pi's folder and settings, and the home folder. Pi's
     * settings are read again when the copy is older than `SETTINGS_STALE_MS`, in the background: a change (such as
     * `defaultProjectTrust`) counts from the request after.
     */
    #skillSources(): SkillSources {
        if (Date.now() - this.#settingsReadAt >= SETTINGS_STALE_MS) {
            this.#settingsReadAt = Date.now();
            this.settings.reload().catch(() => {
                // Unreadable now: the last good settings stay.
            });
        }

        let settingsPaths: string[] = [];
        let defaultProjectTrust: SkillSources["defaultProjectTrust"] = "ask";

        try {
            settingsPaths = this.settings.getSkillPaths();
            defaultProjectTrust = this.settings.getDefaultProjectTrust();
        } catch {
            // Unreadable settings: the default folders still count, and no project is trusted unasked.
        }

        return { agentDir: getAgentDir(), home: this.#home, settingsPaths, defaultProjectTrust };
    }

    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[] {
        if (this.workspaceScheme(cwd) !== undefined) {
            return [];
        }

        return loadSessionSkills(cwd, this.#skillSources());
    }

    /**
     * Whether Pi trusts the project a conversation works in, and the project skills that wait for it. The owner's: the
     * skills may be in folders above the session's, which someone invited to it cannot see.
     */
    projectTrust(id: ConversationId, user: User): ProjectTrust {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner decides which projects Pi trusts.");
        }

        const runner = this.runnerOf(id);

        if (runner !== undefined) {
            return projectThere(this.#knownFolder(id), runner, this.#remoteDirs()).trust;
        }

        const cwd = this.cwdOf(id);

        if (this.workspaceScheme(cwd) !== undefined) {
            throw new HttpError(400, "Project trust is not available for remote workspaces.");
        }

        return readProjectTrust(cwd, this.#skillSources());
    }

    /** Where trust decisions and Pi's settings are, for a folder on another computer (`remote-context.ts`). */
    #remoteDirs(): { dataDir: string; agentDir: string } {
        return { dataDir: this.dataDir, agentDir: getAgentDir() };
    }

    /** The environment there of a session on another computer, unwrapped: what `remote-context.ts` reads through. */
    #remoteEnv(id: ConversationId) {
        return this.runners.env(this.runnerOf(id)!, this.cwdOf(id), this.runnerScope(id));
    }

    /** Pi wrote or edited `path`: on another computer, a context file or skill there is read again (`changedThere`). */
    #projectFileChanged(id: ConversationId, path: string): void {
        if (this.runnerOf(id) !== undefined) {
            changedThere(this.#remoteEnv(id), path);
        }
    }

    /**
     * What is known of a session's folder on another computer, at once, for what answers without waiting (the trust
     * routes): read again in the background when old. 409 before its first reading ends.
     */
    #knownFolder(id: ConversationId): FolderScan {
        const scan = knownScan(this.#remoteEnv(id), this.cwdOf(id));

        if (scan === undefined) {
            throw new HttpError(
                409,
                `Pi Pocket is still reading this folder on ${this.runners.name(this.runnerOf(id)!)}. Try again in a moment.`,
            );
        }

        return scan;
    }

    /** The owner's answer to "trust this project?", saved where Pi's CLI keeps its own, as its `/trust` does. */
    setProjectTrust(id: ConversationId, user: User, choice: TrustChoice): ProjectTrust {
        // Before anything is saved: only the owner may read it, or answer.
        const now = this.projectTrust(id, user);

        if (now.unreadable) {
            throw new HttpError(
                409,
                "Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no answer can be saved. Mend or delete it first.",
            );
        }

        if (choice === "trust-parent" && now.parent === undefined) {
            throw new HttpError(400, "This folder has no folder above it.");
        }

        const runner = this.runnerOf(id);

        if (runner === undefined) {
            saveProjectTrust(this.cwdOf(id), getAgentDir(), choice);
        } else {
            // Kept here, by computer and path there: Pi's own store names this server's folders.
            const { folder, paths } = this.#knownFolder(id);

            saveTrust(this.dataDir, runner, folder, paths, choice);
        }

        return this.projectTrust(id, user);
    }

    /**
     * Pi's skills in a conversation's folder, to run as `/skill:name`. For a session on another computer, those there, as
     * last read (`remote-context.ts`): none before the first reading ends.
     */
    skillCommands(id: ConversationId): SkillCommand[] {
        const runner = this.runnerOf(id);

        if (runner !== undefined) {
            const scan = knownScan(this.#remoteEnv(id), this.cwdOf(id));

            return scan === undefined ? [] : this.#remoteSkills(scan, runner);
        }

        try {
            return this.skills(this.cwdOf(id)).map((skill) => ({
                name: skill.name,
                description: skill.description,
                path: skill.filePath,
                baseDir: skill.baseDir,
            }));
        } catch {
            return [];
        }
    }

    #remoteSkills(scan: FolderScan, runner: string): SkillCommand[] {
        return projectThere(scan, runner, this.#remoteDirs()).skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: skill.filePath,
            baseDir: skill.baseDir,
        }));
    }

    /**
     * `skillCommands` as they are now, and how to read a skill's file: for a session on another computer, its folder
     * there read again when old (or as last read, when it cannot be reached), and the file read there.
     */
    async skillsToRun(
        id: ConversationId,
    ): Promise<{ skills: SkillCommand[]; read?: (path: string) => Promise<string> }> {
        const runner = this.runnerOf(id);

        if (runner === undefined) {
            return { skills: this.skillCommands(id) };
        }

        const env = this.#remoteEnv(id);
        const scan = await latestScan(env, this.cwdOf(id));

        return {
            skills: scan === undefined ? [] : this.#remoteSkills(scan, runner),
            read: (path) => readRemoteText(env, path),
        };
    }

    /** Pi's prompt templates, as a conversation in its folder offers them. */
    promptTemplates(id: ConversationId): PromptTemplate[] {
        let paths: string[] = [];

        try {
            paths = this.settings.getPromptTemplatePaths();
        } catch {
            // Unreadable settings: the default folders still count.
        }

        // A session on another computer: this server's own templates, in Pi's folder or where its settings say, with
        // paths from Pi's folder. None of its project there: nothing here is read for its folder.
        if (this.runnerOf(id) !== undefined) {
            return loadPromptTemplates(getAgentDir(), getAgentDir(), paths, { project: false });
        }

        const cwd = this.cwdOf(id);

        // A remote workspace has no project folder here: only Pi's own templates and whole paths.
        if (this.workspaceScheme(cwd) !== undefined) {
            return loadPromptTemplates(
                this.#home,
                getAgentDir(),
                paths.filter((path) => isAbsolute(expandHome(path.trim()))),
                { project: false },
            );
        }

        // A project told "Don't trust" offers none of its own, as its .pi/skills.
        return loadPromptTemplates(cwd, getAgentDir(), paths, {
            project: !projectDistrusted(cwd, this.#skillSources()),
        });
    }

    // ─── Extensions ─────────────────────────────────────────────────────────

    /** Whether Lancet Guard's module is on here; Pi's own setting may still turn the guard off. */
    guardOn(): boolean {
        return this.loader.enabled(GUARD_FILE);
    }

    /** Lancet Guard as it applies here: Pi's own setting, unless the guard extension is off in Pi Pocket. */
    async guardStatus(): Promise<GuardStatus> {
        const status = await this.guard.status();

        if (this.guardOn()) {
            return status;
        }

        return {
            available: status.available,
            enabled: false,
            detail: "Lancet Guard is off in Pi Pocket: bash, background, write, and edit calls run unchecked here.",
        };
    }

    /** The extension modules, as this person may see them: where the server keeps files is for the owner only. */
    async extensions(
        user: User,
    ): Promise<{ modules: ExtensionInfo[]; guard: GuardStatus; dropIns?: string }> {
        const owner = user.role === "owner";
        // A load error can name the server's folders too.
        // Modules' routes are the owner's to know: others see only whose tabs load a browser module.
        const modules = this.loader.list().map(({ path, error, web, ...module }) =>
            owner
                ? {
                      ...module,
                      ...(path === undefined ? {} : { path }),
                      ...(web === undefined ? {} : { web }),
                      ...(error === undefined ? {} : { error }),
                  }
                : {
                      ...module,
                      ...(web?.client === undefined ||
                      !this.policy.mayUseExtension(user, web.client)
                          ? {}
                          : { web: { routes: [], client: web.client } }),
                      ...(error === undefined ? {} : { error: "It failed to load." }),
                  },
        );

        // The guard row shows Pi's own setting, so the owner can tell "off here" from "off everywhere".
        return {
            modules,
            guard: await this.guard.status(),
            ...(owner ? { dropIns: join(this.dataDir, "extensions") } : {}),
        };
    }

    /** Turn an extension module on or off for every session, now and after restarts. */
    async setExtensionEnabled(user: User, file: string, enabled: boolean): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (module.required && !enabled) {
            throw new HttpError(400, `${module.title} is required and cannot be turned off`);
        }

        if (module.enabled === enabled) {
            return;
        }

        this.config.setExtensionEnabled(file, enabled);

        try {
            await this.loader.apply(file);
        } catch (error) {
            throw new HttpError(
                500,
                `${module.title} is on but failed to load: ${describe(error)}`,
            );
        } finally {
            await this.#refreshClients();
        }

        if (file === GUARD_FILE && enabled) {
            void this.guard.warm().catch(() => {});
        }

        if (file === BROWSER_FILE && !enabled) {
            await this.browsers.closeAll();
        }

        if (file === PIP_FILE && !enabled) {
            await this.pip.stopAll();
        }

        this.notice(
            enabled ? "info" : "warning",
            `${user.name} turned ${module.title} ${enabled ? "on" : "off"}.`,
        );
    }

    async reloadExtension(file: string): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (!module.enabled) {
            throw new HttpError(409, `${module.title} is off`);
        }

        try {
            await this.loader.reload(file);
        } catch (error) {
            throw new HttpError(500, `${module.title} failed to load: ${describe(error)}`);
        } finally {
            await this.#refreshClients();
        }
    }

    /**
     * The owner starts the LANCET model download. It runs on in the background; every tab hears each step in the guard's
     * status, and everyone in the app is told how it ended.
     */
    async setupGuardModel(user: User): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (this.guard.directory === undefined) {
            throw new HttpError(400, "specpi-lancet-guard is not installed in Pi");
        }

        if ((await this.guard.model())?.state === "ready") {
            return;
        }

        const refresh = () => void this.#refreshClients().catch(() => {});
        const run = this.guard.setupModel(refresh);

        this.notice("info", `${user.name} started the LANCET model download.`);
        refresh();
        run.then(
            () => {
                this.notice("info", "The LANCET model is installed.");

                if (this.guardOn()) {
                    void this.guard.warm().catch(() => {});
                }
            },
            (error: unknown) =>
                this.notice("warning", `The LANCET model download failed: ${describe(error)}`),
        ).finally(refresh);
    }

    /** The owner changes who may allow risky calls. */
    async setApprovalRule(user: User, rule: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (rule !== "anyone" && rule !== "others") {
            throw new HttpError(400, "approvalRule must be anyone or others");
        }

        if (rule === this.config.approvalRule) {
            return;
        }

        this.config.approvalRule = rule;
        await this.#refreshClients();
        this.notice(
            "info",
            rule === "others"
                ? `${user.name} made approvals need someone other than who asked.`
                : `${user.name} let anyone who can steer allow risky calls.`,
        );
    }

    /** The owner changed keep warm's settings: tabs hear the new time limit, and open views show each session's state. */
    async keepWarmSettingsChanged(): Promise<void> {
        this.cacheKeeper.reconsider();
        this.refreshViews();
        await this.#refreshClients();
    }

    /**
     * The owner chooses how many hours a run waits for a provider's limit to clear, at most; 0 turns waiting off, and
     * runs that wait now go on at once.
     */
    async setLimitWaitHours(user: User, hours: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof hours !== "number" || !LIMIT_WAIT_CHOICES.includes(hours)) {
            throw new HttpError(
                400,
                `limitWaitHours must be one of ${LIMIT_WAIT_CHOICES.join(", ")}`,
            );
        }

        if (hours === this.config.limitWaitHours) {
            return;
        }

        this.config.limitWaitHours = hours;

        // Off: the runs that wait go on at once. Another time: each wait is cut to the new longest.
        if (hours === 0) {
            this.limits.releaseAll();
        } else {
            this.limits.reconsider();
        }

        await this.#refreshClients();
    }

    /**
     * A module's settings as `user` may see them: the owner, and whoever its browser module is for. A secret's value
     * never leaves the server: only whether it is set. 404 for anyone else, and for a module that is off or has none.
     */
    extensionSettings(user: User, module: string) {
        const fields = this.webs.settingsOf(module);
        const access = this.webs.clientAccess(module);

        if (
            fields === undefined ||
            (user.role !== "owner" &&
                (access === undefined || !this.policy.mayUseExtension(user, access)))
        ) {
            throw new HttpError(404, "That module has no settings here.");
        }

        return shownSettings(fields, this.config.extensionSettings(module), false);
    }

    /** The owner changes a module's settings; the module hears it (`web.onSettings`). */
    setExtensionSettings(user: User, module: string, change: unknown) {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const fields = this.webs.settingsOf(module);

        if (fields === undefined) {
            throw new HttpError(404, "That module has no settings here.");
        }

        let next: Record<string, string | number | boolean>;

        try {
            next = changeSettings(fields, this.config.extensionSettings(module), change);
        } catch (error) {
            throw new HttpError(400, describe(error));
        }

        this.config.setExtensionSettings(module, next);
        this.webs.settingsChanged(module);

        return shownSettings(fields, next, false);
    }

    /** The owner chooses when PiP compacts itself: above so many tokens of context once idle, or (0) as sessions do. */
    async setPipCompactAt(user: User, tokens: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof tokens !== "number" || !PIP_COMPACT_CHOICES.includes(tokens)) {
            throw new HttpError(
                400,
                `pipCompactAt must be one of ${PIP_COMPACT_CHOICES.join(", ")}`,
            );
        }

        if (tokens === this.pipCompaction.compactAt) {
            return;
        }

        this.config.pipCompactAt = tokens;
        await this.#refreshClients();
    }

    /**
     * The theme and colors browsers start with until their person chooses (`config.themeDefault`): the owner's to set,
     * or `null` for the app's own. Everyone's tabs hear it in `hello`.
     */
    async setThemeDefault(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner sets the default theme");
        }

        if (choice === null) {
            this.config.themeDefault = undefined;
        } else {
            const { look, colors } = (choice ?? {}) as { look?: unknown; colors?: unknown };

            if (
                typeof look !== "string" ||
                typeof colors !== "string" ||
                !THEME_ID.test(look) ||
                !THEME_ID.test(colors.replace(/@(dark|light)$/, ""))
            ) {
                throw new HttpError(
                    400,
                    "The default is { look, colors }: a theme's id and colors' id, or null",
                );
            }

            if (!this.themes.list().some((each) => each.id === look && each.usable)) {
                throw new HttpError(404, "No such theme");
            }

            // Colors that are not here (the desktop's, on a machine without Omarchy) would leave new browsers on none.
            if (!(await this.themes.hasColors(colors))) {
                throw new HttpError(404, "No such colors here");
            }

            this.config.themeDefault = { look, colors };
        }

        await this.#refreshClients();
    }

    /**
     * The owner's default after a theme went (removed in Appearance or the gallery, or its folder deleted): a theme that
     * is gone gives way to Pocket, and colors that went with it (its own) to the desktop's; with both gone, no default.
     * Everyone's tabs hear it.
     */
    async #themeDefaultStillHere(): Promise<void> {
        const before = this.config.themeDefault;

        // When the owner's themes could not be read at the start, they are not gone: keep the default for the next start.
        if (before === undefined || this.themes.failure !== undefined) {
            return;
        }

        try {
            const lookGone =
                before.look !== BASE_THEME &&
                !this.themes.list().some((each) => each.id === before.look);
            // The desktop's colors are the app's own default: they never go.
            const colorsGone =
                before.colors !== "desktop" && !(await this.themes.hasColors(before.colors));

            if (!lookGone && !colorsGone) {
                return;
            }

            const look = lookGone ? BASE_THEME : before.look;
            const colors = colorsGone ? "desktop" : before.colors;

            this.config.themeDefault =
                look === BASE_THEME && colors === "desktop" ? undefined : { look, colors };
            await this.#refreshClients();
        } catch (error) {
            this.#log(`The default theme could not be checked: ${describe(error)}`);
        }
    }

    /**
     * The owner picks the model and thinking level new sessions start with: a signed-in model, its level kept to one it
     * has. Null leaves it to the last model picked, as before there was a choice.
     */
    async setDefaultModel(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (choice === null) {
            if (this.config.defaultModel !== undefined) {
                this.config.defaultModel = undefined;
                await this.#refreshClients();
            }

            return;
        }

        const asked = (typeof choice === "object" ? choice : {}) as {
            provider?: unknown;
            modelId?: unknown;
            thinkingLevel?: unknown;
        };

        if (
            typeof asked.provider !== "string" ||
            typeof asked.modelId !== "string" ||
            (asked.thinkingLevel !== undefined && !isThinkingLevel(asked.thinkingLevel))
        ) {
            throw new HttpError(
                400,
                `defaultModel must be null, or { provider, modelId, thinkingLevel? } with thinkingLevel one of ${THINKING_LEVELS.join(", ")}`,
            );
        }

        const model = this.models
            .getAvailableSnapshot()
            .find((each) => each.provider === asked.provider && each.id === asked.modelId);

        if (model === undefined) {
            throw new HttpError(
                400,
                `Model ${asked.provider}/${asked.modelId} is not available: sign in to its provider first.`,
            );
        }

        const thinkingLevel = clampThinkingLevel(
            model,
            (asked.thinkingLevel ?? "off") as ModelThinkingLevel,
        );
        const before = this.config.defaultModel;

        if (
            before?.provider === model.provider &&
            before.modelId === model.id &&
            before.thinkingLevel === thinkingLevel
        ) {
            return;
        }

        this.config.defaultModel = { provider: model.provider, modelId: model.id, thinkingLevel };
        await this.#refreshClients();
    }

    /**
     * Whether a provider's sign-in expired and needs a person to sign in again: the model menu and a session's model chip
     * mark its models, and subagents on another model are refused them (`resolveModel`). A session's own run still tries.
     */
    readonly signInNeeded = (provider: string): boolean =>
        this.providers.needsSignIn(provider) !== undefined;

    /**
     * The owner picks the models Pi may start subagents on (`provider/modelId`, models Pi
     * knows). Empty, the default: none, and the subagent tool offers Pi no choice of model at all. The tool is rebuilt
     * to match, so its description and parameters say what Pi may do. This replaces the whole list; the Providers sheet
     * changes one model at a time (`allowSubagentModel`).
     */
    async setSubagentModels(user: User, models: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (
            !Array.isArray(models) ||
            models.length > MAX_SUBAGENT_MODELS ||
            models.some((each) => typeof each !== "string")
        ) {
            throw new HttpError(
                400,
                `subagentModels must be a list of at most ${String(MAX_SUBAGENT_MODELS)} models, each provider/modelId`,
            );
        }

        const chosen: string[] = [];

        for (const spec of models as string[]) {
            const slash = spec.indexOf("/");
            const model =
                slash > 0
                    ? this.models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
                    : undefined;

            if (model === undefined) {
                throw new HttpError(400, `${spec} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${model.provider}/${model.id}`;

            if (!chosen.includes(key)) {
                chosen.push(key);
            }
        }

        await this.#saveSubagentModels(chosen);
    }

    /**
     * The owner allows one model for subagents, or stops allowing it, and keeps the rest as they are now: what the
     * Providers sheet sends, so two quick taps, or two tabs, never undo each other. The list is read and written with no
     * wait between, so changes that come together all count. A model stopped need not be one Pi still knows. Returns the
     * list as it is then.
     */
    async allowSubagentModel(
        user: User,
        model: unknown,
        allowed: unknown,
    ): Promise<readonly string[]> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof model !== "string" || typeof allowed !== "boolean") {
            throw new HttpError(400, "Send model (provider/modelId) and allowed (true or false).");
        }

        const current = this.config.subagentModels;
        let chosen = current.filter((each) => each !== model);

        if (allowed) {
            const slash = model.indexOf("/");
            const found =
                slash > 0
                    ? this.models.getModel(model.slice(0, slash), model.slice(slash + 1))
                    : undefined;

            if (found === undefined) {
                throw new HttpError(400, `${model} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${found.provider}/${found.id}`;

            chosen = current.includes(key) ? [...current] : [...current, key];

            if (chosen.length > MAX_SUBAGENT_MODELS) {
                throw new HttpError(
                    400,
                    `At most ${String(MAX_SUBAGENT_MODELS)} models can be allowed for subagents.`,
                );
            }
        }

        await this.#saveSubagentModels(chosen);

        return this.config.subagentModels;
    }

    /**
     * Keep the models for subagents, rebuild the subagent tool to match, and tell the owner's tabs, the only ones whose
     * hello carries the list.
     */
    async #saveSubagentModels(chosen: readonly string[]): Promise<void> {
        const before = this.config.subagentModels;

        if (JSON.stringify(before) === JSON.stringify(chosen)) {
            return;
        }

        this.config.subagentModels = chosen;

        // The tool offers a model only while some are allowed: rebuilt now, for the next request of every session.
        if (this.loader.enabled(SUBAGENTS_FILE)) {
            try {
                await this.loader.reload(SUBAGENTS_FILE);
            } catch (error) {
                // A module's error can name the server's folders: the owner's to read.
                this.ownerNotice("error", `Subagents failed to reload: ${describe(error)}`);
            }
        }

        await this.#refreshClients((user) => user.role === "owner");
        // What changed: the checklist shows the rest.
        const added = chosen.filter((each) => !before.includes(each));
        const removed = before.filter((each) => !chosen.includes(each));
        const said = [
            ...(added.length === 0 ? [] : [`${added.join(", ")} allowed for subagents`]),
            ...(removed.length === 0
                ? []
                : [`${removed.join(", ")} no longer allowed for subagents`]),
        ];

        if (said.length > 0) {
            this.ownerNotice("info", `${said.join("; ")}.`);
        }
    }

    /** Send clients a fresh hello, every one or those of the people `to` names: what it carries changed. */
    async #refreshClients(to: (user: User) => boolean = () => true): Promise<void> {
        for (const client of this.#clients) {
            if (to(client.user)) {
                client.send("hello", this.#helloFor(client, await this.hello(client.user)));
            }
        }
    }

    // ─── Browser ────────────────────────────────────────────────────────────

    /** The browser is on while its extension module is: the owner turns both off together in Extensions. */
    browserOn(): boolean {
        return this.loader.extensionNames().includes(BROWSER_EXTENSION);
    }

    #browserEvent(conversationId: ConversationId, state: BrowserState) {
        return { conversationId: Number(conversationId), ...state };
    }

    // ─── Shutdown ───────────────────────────────────────────────────────────

    close(): Promise<void> {
        this.#closing ??= (async () => {
            clearTimeout(this.#sessionsTimer);
            // Runners reconnect to the next server; their daemons keep running meanwhile (offline is offline).
            this.runners.close();
            this.alerts.close();
            this.themes.close();
            await this.cacheKeeper.close();
            this.spend.close();
            this.limits.close();
            this.background.close();
            this.#unsubscribeCommits?.();
            this.#unsubscribeRunEnds?.();
            this.#unsubscribeApprovals?.();
            this.#unsubscribeBrowsers?.();
            this.guard.close();

            // Modules' cleanups may wait (closing a connection), but not for long: the rest must close too.
            const cleaned = this.loader?.close();

            // After the loader: its last changes could set it again.
            clearTimeout(this.#websTimer);

            for (const client of this.#clients) {
                client.send("closing", {});
            }

            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.close(),
                    () => {},
                );
            }

            this.providers.close();

            // A timer that holds the process: with nothing else to do, Node would end it here, before the rest closed.
            let limit: NodeJS.Timeout | undefined;

            await Promise.race([
                cleaned,
                new Promise<void>((resolve) => {
                    limit = setTimeout(resolve, CLEANUP_LIMIT_MS);
                }),
            ]);
            clearTimeout(limit);
            let storageClosed = false;

            try {
                // Close writes no outcome: running work resumes when the next process opens the storage.
                if (this.harness !== undefined) {
                    await this.harness.close(context);
                } else {
                    await this.#openingStorage?.close(context);
                }

                storageClosed = true;

                for (const env of this.#envs.values()) {
                    await env.cleanup(context);
                }
            } finally {
                // After the harness: a browser call cut off by the stop resumes as interrupted, not as failed.
                await this.browsers.closeAll({ final: true }).catch(() => {});

                if (storageClosed) {
                    this.#releaseLock?.();
                }
            }
        })();

        return this.#closing;
    }
}

/**
 * Continue on the runtime's calls: after Pi and the caller shaped a request, each shaper may replace the payload, the
 * last one closest to the wire. With no shaper, the call goes on untouched. A shaper may answer with a promise. One
 * that throws is logged and skipped: a faulty module must not fail the model call.
 */
export function installRequestShaping(
    models: { streamSimple: ModelRuntime["streamSimple"] },
    shapers: readonly ModelRequestShaper[],
    log: (line: string) => void,
): void {
    const stream = models.streamSimple.bind(models);

    models.streamSimple = (model, context, options) => {
        if (shapers.length === 0) {
            return stream(model, context, options);
        }

        return stream(model, context, {
            ...options,
            onPayload: async (payload, payloadModel) => {
                const asked = await options?.onPayload?.(payload, payloadModel);
                let next = asked ?? payload;
                let shaped = asked;

                for (const shape of [...shapers]) {
                    try {
                        const replaced = await shape(next, model);

                        if (replaced !== undefined) {
                            next = replaced;
                            shaped = replaced;
                        }
                    } catch (error) {
                        log(`A model request shaper failed and was skipped: ${describe(error)}`);
                    }
                }

                return shaped;
            },
        });
    };
}
