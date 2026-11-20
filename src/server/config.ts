import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthenticatorStore, StoredAuthenticator } from "./approval-methods.ts";
import type { StoredLinkLimits } from "./link-limits.ts";
import { codeHash, newIdentity, type Identity } from "../runner/secure-link.ts";

/** The repository root: `web/` and `src/` live here, and `node_modules/` too, except in an npx or local install. */
export const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The node_modules folder with the package `name`, as Node looks for it from `from`: Pi Pocket's own, or one above
 * it, where npm puts Pi Pocket's packages in an npx or local install. Pi Pocket's own when none has it.
 */
export function modulesWith(name: string, from = APP_ROOT): string {
    for (let folder = from; ;) {
        const modules = basename(folder) === "node_modules" ? folder : join(folder, "node_modules");

        if (existsSync(join(modules, name, "package.json"))) {
            return modules;
        }

        const parent = dirname(folder);

        if (parent === folder) {
            return join(from, "node_modules");
        }

        folder = parent;
    }
}

/** Where Pi Pocket keeps its database, users, uploads, and logs. */
export function dataDir(): string {
    return process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket");
}

/** owner: everything. guest: steers Pi (which can run commands here). viewer: reads, chats, and reacts, never steers. */
export type Role = "owner" | "guest" | "viewer";

export interface User {
    id: string;
    name: string;
    role: Role;
    /** sha256 of the user's login token; the token itself is only kept for the owner. */
    tokenHash: string;
    createdAt: number;
    lastSeen?: number;
    /** Conversation ids of the only sessions this person may open; absent means every session. */
    sessions?: string[];
    /**
     * The Cloudflare quick tunnel host (`abc-def.trycloudflare.com`) this person's device signed in through. Its sign-in
     * cookie works only there, and each tunnel gets a new address, so they are removed once that tunnel is gone.
     */
    tunnel?: string;
    /** The most Pi may spend for this person, in dollars; never for the owner. */
    budget?: number;
    /** When their profile picture was set (`avatars.ts`); absent means they have none. */
    avatar?: number;
    /**
     * The authenticator app this person linked, to approve with its codes (`approval-methods.ts`). Its secret never
     * leaves the server: nothing that sends a person's record to a browser may include it.
     */
    authenticator?: StoredAuthenticator;
    /**
     * How many days a session's approval lasts once this person last used it (`folder-approvals.ts`); 0: never ends.
     * Absent: 7 days.
     */
    approvalDays?: number;
    /** The owner let this guest link computers of their own (`access.ts` `mayLink`). */
    linksRunners?: true;
    /** The owner let this guest invite people (`access.ts` `mayInvite`). The owner always may. */
    invites?: true;
    /**
     * The owner let this guest keep sessions warm: turn it on for a session and pick its time (`access.ts`
     * `keepsWarm`). Without it they may only turn it off. The owner always may.
     */
    keepsWarm?: true;
    /**
     * A temporary account, as its invite said: it links no authenticator, so it stays a viewer. Only the owner ends
     * that, and it never comes back (`app.ts` `setAccess`).
     */
    temporary?: true;
    /** Their other devices, each signed in with a link from one of their own (`auth.ts` `createDeviceLink`). */
    devices?: StoredDevice[];
}

/** Who is signed in, as `hello` says it to a tab, and as the app page carries it (`serveApp`). */
export function helloUser(user: User) {
    return {
        id: user.id,
        name: user.name,
        role: user.role,
        ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }),
    };
}

/**
 * Another device of one person. It has a token of its own, kept by its hash, so signing it out, or the end of the
 * tunnel it came through, ends that device alone.
 */
export interface StoredDevice {
    tokenHash: string;
    createdAt: number;
    /** The Cloudflare quick tunnel host it signed in through: its cookie works only there (as `User.tunnel`). */
    tunnel?: string;
}

/** The approval times on offer, in days; 0 is "never ends". */
export const APPROVAL_DAYS = [1, 7, 14, 30, 0] as const;

/** A person's approval time until the owner sets one: 7 days, the owner's too. */
export function approvalDays(user: Pick<User, "approvalDays">): number {
    return user.approvalDays ?? 7;
}

/**
 * A session's approval, kept on the server (`folder-approvals.ts`): someone proved it was them before work there (their
 * own code, or the Allow of who is in charge of its computer). It lasts while the session is used: each use resets its
 * clock to the approval time of who used it, and it ends once unused that long.
 */
export interface StoredApproval {
    /** The session's top id. */
    session: string;
    /** `THIS_SERVER` or a runner's id. */
    computer: string;
    /** The session's folder there, for the lists. */
    folder: string;
    /** How it was approved last: a code, or who is in charge from the app. */
    method: "totp" | "owner";
    /** Who approved it last, by id. */
    by: string;
    approvedAt: number;
    /** When it was last used; its clock starts here. */
    usedAt: number;
    /** Who used it last: their approval time sets how long it lasts from `usedAt`. */
    lastUser: string;
    /** When it was revoked: it ended then, whatever its clock says, until it is renewed. */
    revokedAt?: number;
}

/** An invite not yet used, kept by its code's sha256 (the code itself is only shown to whoever made it). */
export type StoredInvite = {
    codeHash: string;
    expiresAt: number;
    /** Who made it: it works only while they are still here and, for someone new, may still invite. */
    createdBy: string;
} & InviteFor;

/** What an invite is for: someone new, or another device of the person who made it. */
export type InviteFor =
    | {
          role: Exclude<Role, "owner">;
          /** The one session it is for; absent means the sessions shared with them. */
          session?: string;
          /** The one folder it is for: its maker's sessions in it on that computer, not all of theirs. */
          folder?: { computer: string; path: string };
          /** The account it makes is temporary (`User.temporary`). */
          temporary?: true;
          device?: never;
          person?: never;
      }
    | {
          device: true;
          /** Who the device signs in as, when not whoever made the link: the owner makes one for someone else. */
          person?: string;
          role?: never;
          session?: never;
          folder?: never;
          temporary?: never;
      };

/**
 * A computer whose runner (`pi-pocket runner`) may connect, so sessions can run their tools there (`runners.ts`). Kept by
 * its public key: its private key is only on that computer, and proves each connection (`secure-link.ts`).
 */
export interface StoredRunner {
    id: string;
    name: string;
    /**
     * The runner's Ed25519 public key, raw base64url. Absent: linked before the secure link, so it must link again (a
     * code made for this computer keeps its id, and so its sessions).
     */
    publicKey?: string;
    createdAt: number;
    /** Who linked it: the owner, who changes its settings and access. */
    createdBy: string;
    /** People the owner granted access to start sessions on this computer. */
    users?: string[];
    /**
     * People no longer chosen here whose shares and sessions here are not taken back yet (`app.ts` `#finishLeaving`).
     * Set in the same save that drops them from `users`, so no share here counts for them from then on (`access.ts`
     * `Computer.leaving`), also after a restart that cut the rest short.
     */
    leaving?: string[];
    /** The folders the owner gave each chosen person here, by person id (`access.ts`). The owner needs none. */
    given?: Record<string, string[]>;
    /** Of those folders, the ones in which that person sees every session, by person id (`access.ts` `seesFolder`). */
    sees?: Record<string, string[]>;
    /**
     * The chosen people who may take the wheel from a driver here, and turn take turns off under them (`access.ts`
     * `overridesTurns`), by person id. Who is in charge always may.
     */
    wheel?: string[];
    /**
     * The chosen people who may allow a call their own message led to here while approvals need someone else
     * (`access.ts` `allowsOwn`), by person id. Who is in charge always may.
     */
    allows?: string[];
    /** When it last connected. */
    lastSeen?: number;
    /**
     * What it reported when it last connected: its OS, architecture, home folder, and runner version; and its temporary
     * folder (absent before it was kept), where the files people attach go while it is offline (`remote-context.ts`).
     */
    platform?: { os: string; arch: string; home: string; version: string; tmpdir?: string };
    /** Programs ready on this computer, as its runner last reported. */
    tools?: { git: boolean; gh: boolean; github: boolean };
    /** New sessions on it start shared with its people (`access.ts` `initialShares`). Absent: with no one. */
    shareNew?: true;
    /**
     * What its runner does for sessions, sent to it at each connection and on change (`runner-settings`): `network`
     * false, its sessions' browsers do not use its network; `downloads`, an absolute folder there for their downloads.
     */
    settings?: { network?: false; downloads?: string };
}

/**
 * This server as a computer (`access.ts` `THIS_SERVER`): the same settings a runner has, with the owner as its linker.
 * Since the access policy; before it, everyone with access to the whole server could use it. Absent: no one chosen, no
 * saved folders, asking on, new sessions shared with no one.
 */
export interface StoredServer {
    /** The people the owner chose: they may use this server. Viewers among them only see. */
    users?: string[];
    /** People no longer chosen here whose shares and sessions here are not taken back yet (`StoredRunner.leaving`). */
    leaving?: string[];
    /** The folders the owner gave each chosen person (real paths here), by person id (`access.ts`). */
    given?: Record<string, string[]>;
    /** Of those folders, the ones in which that person sees every session, by person id (`access.ts` `seesFolder`). */
    sees?: Record<string, string[]>;
    /**
     * The chosen people who may take the wheel from a driver here, and turn take turns off under them (`access.ts`
     * `overridesTurns`), by person id. Who is in charge always may.
     */
    wheel?: string[];
    /**
     * The chosen people who may allow a call their own message led to here while approvals need someone else
     * (`access.ts` `allowsOwn`), by person id. Who is in charge always may.
     */
    allows?: string[];
    /** New sessions here start shared with its people. */
    shareNew?: true;
    /**
     * Tasks that run on their own (webhooks, schedules, watches) stop with their session's approval: a week after it
     * ends, with reminders, until someone renews it. Off (absent): they run for good once set up.
     */
    tasksExpire?: true;
    /**
     * When `tasksExpire` was turned on. A session with no approval at all (from before approvals) counts as ended then,
     * so its tasks get their week too.
     */
    tasksExpireSince?: number;
}

/** A one-time code that links a computer, not yet used: kept by its sha256, for a few minutes. */
export interface StoredRunnerCode {
    /** The code's SHA-256 (`secure-link.ts` `codeHash`): the key of the runner's proof that it knows the code. */
    codeHash: string;
    name: string;
    createdBy: string;
    expiresAt: number;
    /** A code to link a known computer again (a new key, the same id and sessions); absent: a new computer. */
    runner?: string;
}

/** The theme (a theme folder's id, or "pocket") and the colors ("desktop", a palette's id, or a folder's) a browser
 * starts with until its person chooses. */
export interface ThemeDefault {
    look: string;
    colors: string;
}
export interface ModelChoice {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
}

interface PocketConfig {
    version: 1;
    /** Printed in the login URL at every start. Keep this file private. */
    ownerToken: string;
    users: User[];
    /** Invites not yet used: kept here so one that lasts a day or a week outlives a restart. */
    invites?: StoredInvite[];
    lastModel?: ModelChoice;
    /** The model and thinking level new sessions start with, as the owner chose; absent: the last one picked. */
    defaultModel?: ModelChoice;
    /** The theme and colors of browsers that have not chosen their own (`theme.js`), as the owner chose; absent: Pocket. */
    themeDefault?: ThemeDefault;
    /** Extension modules (file names in `src/server/extensions/`) the owner turned off. */
    disabledExtensions?: string[];
    /** Extension modules the owner turned on. Matters for modules that are off by default, like Lancet Guard. */
    enabledExtensions?: string[];
    /** "others": a guest cannot allow a risky call that their own message led to. Absent: anyone who can steer may. */
    approvals?: ApprovalRule;
    /** The tokens of context above which PiP compacts itself once idle; 0: only as sessions do. Absent: the default. */
    pipCompactAt?: number;
    /**
     * The models (`provider/modelId`) Pi may start subagents on, as the owner allowed them.
     * Absent or empty: none, and subagents always run on their session's model.
     */
    subagentModels?: string[];
    /** The most hours a run waits for a model's limit to clear (`limit-gate.ts`); 0: it does not wait. Absent: 6. */
    limitWaitHours?: number;
    /** Keeping prompt caches warm once a run ends (`cache-keeper.ts`), as the owner set it. Absent: off. */
    keepWarm?: Partial<KeepWarmSettings>;
    /**
     * The owner's values for the settings extension modules declare (`web.settings`), by module and setting name. A
     * setting with no value here has its default. Since 0.22.0; an older Pi Pocket ignores it.
     */
    extensionSettings?: Record<string, Record<string, string | number | boolean>>;
    /** Computers whose runners may connect (`runners.ts`). Since 0.29.0; an older Pi Pocket ignores them. */
    runners?: StoredRunner[];
    /** One-time codes that link a computer, not yet used. */
    runnerCodes?: StoredRunnerCode[];
    /**
     * This server's own key for the runner link (`secure-link.ts`): made once, and pinned by every runner it links. A
     * new one means every runner links again.
     */
    serverIdentity?: Identity;
    /** Wrong link codes (`link-limits.ts`): each address's lockouts toward a ban, and the banned addresses. */
    runnerLinkLimits?: StoredLinkLimits;
    /** This server as a computer: its people, their folders, and rules (`access.ts`). */
    server?: StoredServer;
    /** Approvals of folders and shared sessions, on every computer (`folder-approvals.ts`). */
    folderApprovals?: StoredApproval[];
    /**
     * When each session's starter and who is in charge last heard that its approval ended while its tasks run on, by
     * the session's top id (`app.ts` `tasksMayRun`). Gone once it is renewed, or the owner turns `tasksExpire` off.
     */
    taskReminders?: Record<string, number>;
    /**
     * This file follows the access rules (`access.ts`): written when it is made, and when an older one is brought up to
     * date (`#migrate`). Absent: an older file, which may be from before the rules (`knowsAccess`).
     */
    access?: 1;
    /**
     * A file from before the access rules, not finished yet: the people who keep the sessions that were here, still to
     * be shared with them when the app starts (`keepAccess`, `app.ts` `#finishUpgrade`). Empty: nobody to share with,
     * and the sessions people were invited to are still to approve. Absent: done, or never such a file.
     */
    accessUpgrade?: string[];
}

/**
 * The parts of `StoredServer` and `StoredRunner` the owner can change. `network` and `downloads` are a runner's alone;
 * `downloads` null puts its downloads back in its temporary folder.
 */
export type ComputerSettings = { shareNew?: boolean; network?: boolean; downloads?: string | null };

/** The hours a run waits for a model's limit to clear, until the owner says otherwise. */
export const DEFAULT_LIMIT_WAIT_HOURS = 6;

/** The fixed time limits on offer, in hours. */
const KEEP_WARM_HOURS = [0.5, 1, 2, 4, 8] as const;

/**
 * How long a session is kept warm once its run ends: 0 is off; "break-even" until the refreshes have cost as much as
 * one more cache write (`breakEvenRefreshes` in `idle-plan.ts`); a number is that many hours (0.5: 30 minutes).
 */
export type KeepWarmTime = 0 | "break-even" | (typeof KEEP_WARM_HOURS)[number];

/** The owner's values for one model, over what Pi knows of it. Each one left out: Pi's, or none. */
export type KeepWarmModel = {
    /** How long its prompt cache lives, in minutes. */
    lifetime?: number;
    /** Dollars per million tokens to read its cache, for a model whose maker publishes none. */
    read?: number;
};

/** The owner's settings for keeping a session's prompt cache warm once its run ends. */
export type KeepWarmSettings = {
    hours: KeepWarmTime;
    /** Dollars at most for each session's idle stretch; 0: no cost cap. */
    maxCost: number;
    /** Refreshes at most for each session's idle stretch. */
    maxRefreshes: number;
    /** Percent of a model's cache lifetime between refreshes. */
    share: number;
    /** Whether subagents are kept warm too. */
    subagents: boolean;
    /** The owner's facts by model (`provider/modelId`). */
    models: Record<string, KeepWarmModel>;
};

/** The ranges accepted from the owner's settings and saved configuration. */
export const KEEP_WARM_RANGES = {
    maxCost: [0, 1000],
    maxRefreshes: [1, 10_000],
    share: [10, 95],
} as const;

const DEFAULT_KEEP_WARM: Readonly<KeepWarmSettings> = Object.freeze({
    hours: 0,
    maxCost: 2,
    maxRefreshes: 30,
    share: 90,
    subagents: false,
    models: {},
});

/** Whether `value` is a time a session may be kept warm for: off, break-even, or one of the fixed hours. */
export function isKeepWarmTime(value: unknown): value is KeepWarmTime {
    return (
        value === 0 || value === "break-even" || KEEP_WARM_HOURS.some((hours) => hours === value)
    );
}

const finite = (each: unknown, low: number, high: number): number | undefined =>
    typeof each === "number" && Number.isFinite(each) && each >= low && each <= high
        ? each
        : undefined;

/** One model's facts from a file people may have edited: what is out of range is left out. */
export function keepWarmModelFrom(raw: unknown): KeepWarmModel | undefined {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }

    const value = raw as Record<string, unknown>;
    const lifetime = finite(value.lifetime, 1, 7 * 24 * 60);
    const read = finite(value.read, 0, 10_000);
    const model: KeepWarmModel = {
        ...(lifetime === undefined ? {} : { lifetime: Math.round(lifetime) }),
        ...(read === undefined ? {} : { read }),
    };

    return Object.keys(model).length === 0 ? undefined : model;
}

/** Settings read from a file people may have edited: anything out of range has its default. */
export function keepWarmFrom(raw: unknown): KeepWarmSettings {
    const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const models: Record<string, KeepWarmModel> = {};

    if (typeof value.models === "object" && value.models !== null) {
        for (const [spec, each] of Object.entries(value.models)) {
            const model = spec.indexOf("/") > 0 ? keepWarmModelFrom(each) : undefined;

            if (model !== undefined) {
                models[spec] = model;
            }
        }
    }

    return {
        hours: isKeepWarmTime(value.hours) ? value.hours : DEFAULT_KEEP_WARM.hours,
        maxCost: finite(value.maxCost, ...KEEP_WARM_RANGES.maxCost) ?? DEFAULT_KEEP_WARM.maxCost,
        maxRefreshes: Math.round(
            finite(value.maxRefreshes, ...KEEP_WARM_RANGES.maxRefreshes) ??
                DEFAULT_KEEP_WARM.maxRefreshes,
        ),
        share: Math.round(
            finite(value.share, ...KEEP_WARM_RANGES.share) ?? DEFAULT_KEEP_WARM.share,
        ),
        subagents: value.subagents === true,
        models,
    };
}

/** Who may allow a risky tool call: anyone who can steer, or (for guests) only someone other than who asked. */
export type ApprovalRule = "anyone" | "others";

/** What a computer's record keeps per person about folders: the ones given, and the ones they see every session in. */
type FolderGrants = { given?: Record<string, string[]>; sees?: Record<string, string[]> };

/** Keep `list` as `person`'s under `key`; an empty one leaves no entry, and no entries leave no record. */
function setList(
    target: FolderGrants,
    key: keyof FolderGrants,
    person: string,
    list: readonly string[],
): void {
    const { [person]: _was, ...rest } = target[key] ?? {};
    const next = list.length === 0 ? rest : { ...rest, [person]: [...list] };

    if (Object.keys(next).length === 0) {
        delete target[key];
    } else {
        target[key] = next;
    }
}

/**
 * What only the access rules write (`access.ts`), in the file and on a person: one of these says its server had the
 * rules already. A runner's keys are not among them: a server could link runners before it had the rules.
 */
const ACCESS_KEYS = ["server", "folderApprovals", "taskReminders", "serverIdentity"] as const;
const ACCESS_PERSON_KEYS = [
    "authenticator",
    "approvalDays",
    "linksRunners",
    "invites",
    "keepsWarm",
    "temporary",
    "devices",
] as const;

/**
 * Was `config`, a file with no word on it (`PocketConfig.access`), kept by a server that had the access rules. Any
 * sign counts: a file wrongly taken for one from before would give its people the whole server, where the other
 * mistake only leaves them waiting for the owner to choose them.
 */
function knowsAccess(config: PocketConfig): boolean {
    return (
        ACCESS_KEYS.some((key) => key in config) ||
        config.users.some((user) => ACCESS_PERSON_KEYS.some((key) => key in user))
    );
}

/**
 * A file from before the access rules: its people keep what that server gave them. Then, everyone not held to a
 * session had the whole server: a guest started sessions in any folder, prompted every session, and invited people;
 * a viewer read every session. So each of them is chosen for this server, and a guest is given every folder (`/`
 * holds them all, `access.ts` `inFolder`) and may invite. The sessions that are here are shared with them once the
 * app starts (`app.ts` `#finishUpgrade`), which takes the people returned here. It is what they had, not a rule for
 * what comes: a session started later is its starter's alone, as on any server, until the owner shares new ones
 * (`StoredServer.shareNew`). A person held to sessions has those as before, and nothing changes for them.
 */
function keepAccess(config: PocketConfig): string[] {
    const people = config.users.filter(
        (user) => user.role !== "owner" && user.sessions === undefined,
    );
    const guests = people.filter((user) => user.role === "guest");

    if (people.length > 0) {
        config.server = {
            users: people.map((user) => user.id),
            ...(guests.length === 0
                ? {}
                : { given: Object.fromEntries(guests.map((user) => [user.id, ["/"]])) }),
        };
    }

    for (const guest of guests) {
        guest.invites = true;
    }

    return people.map((user) => user.id);
}

/** A right one chosen person holds on one computer, set by who is in charge of it (`access.ts`). */
export type ComputerRight = "wheel" | "allows";

export const COMPUTER_RIGHTS: readonly ComputerRight[] = ["wheel", "allows"];

/** What a computer's record keeps about those rights, and the people chosen for it. */
type Rights = { users?: string[]; wheel?: string[]; allows?: string[] };

/** What a computer's record keeps about the people chosen for it, and those leaving it (`StoredRunner.leaving`). */
type Leaving = { users?: string[]; leaving?: string[] };

/** The people `chosen` no longer names are leaving `target`: marked before its list changes, for the same save. */
function markLeaving(target: Leaving, chosen: readonly string[]): void {
    const dropped = (target.users ?? []).filter((each) => !chosen.includes(each));

    if (dropped.length > 0) {
        target.leaving = [...new Set([...(target.leaving ?? []), ...dropped])];
    }
}

/** `people` are no longer leaving `target`; a list with nobody in it leaves no entry. Whether anything changed. */
function dropLeaving(target: Leaving, people: readonly string[]): boolean {
    const before = target.leaving ?? [];
    const rest = before.filter((each) => !people.includes(each));

    if (rest.length === 0) {
        delete target.leaving;
    } else {
        target.leaving = rest;
    }

    return rest.length !== before.length;
}

/** Keep each right to the people `keep` names; a right nobody holds leaves no entry. */
function trimRights(target: Rights, keep: (person: string) => boolean): void {
    for (const right of COMPUTER_RIGHTS) {
        const list = (target[right] ?? []).filter(keep);

        if (list.length === 0) {
            delete target[right];
        } else {
            target[right] = list;
        }
    }
}

function newToken(): string {
    return randomBytes(24).toString("base64url");
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");

    return left.length === right.length && timingSafeEqual(left, right);
}

/** The most invites one person keeps live at once. */
export const MAX_INVITES = 50;

/** The most other devices one person keeps signed in; one more signs out the one signed in longest ago. */
export const MAX_DEVICES = 20;

/** `config.json` in the data directory, written atomically with mode 0600. */
export class ConfigStore {
    readonly file: string;
    #config: PocketConfig;

    constructor(directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.file = join(directory, "config.json");

        if (existsSync(this.file)) {
            this.#config = JSON.parse(readFileSync(this.file, "utf8")) as PocketConfig;
            this.#migrate();
        } else {
            const ownerToken = newToken();

            this.#config = {
                version: 1,
                access: 1,
                ownerToken,
                users: [
                    {
                        id: randomUUID(),
                        name: "Owner",
                        role: "owner",
                        tokenHash: hashToken(ownerToken),
                        createdAt: Date.now(),
                    },
                ],
            };
            this.save();
        }
    }

    /**
     * Bring an older file up to date. The one global switch that shared every runner session went with the access
     * policy: each session now has its own share list, and every existing one starts private (the owner's choice). A
     * computer linked before the secure link (`secure-link.ts`) loses its shared key, which no longer opens anything:
     * it links again, keeping its id and sessions. Open link codes stay: they were kept by the same hash. An owner
     * invite, which handed out the owner's token, is now a device link (`auth.ts`): one not yet used ends.
     *
     * A file from before the access rules (`knowsAccess`) gives its people what that server gave them (`keepAccess`),
     * in this one save. Any other older file keeps who is chosen as it is.
     */
    #migrate(): void {
        const old = this.#config as PocketConfig & { sharedRunnerSessions?: boolean };
        let changed = false;

        if (old.access === undefined) {
            if (!knowsAccess(old)) {
                old.accessUpgrade = keepAccess(old);
            }

            old.access = 1;
            changed = true;
        }

        const invites = old.invites?.filter((each) => (each.role as Role | undefined) !== "owner");

        if (invites !== undefined && invites.length !== old.invites?.length) {
            old.invites = invites;
            changed = true;
        }

        if ("sharedRunnerSessions" in old) {
            delete old.sharedRunnerSessions;
            changed = true;
        }

        for (const runner of old.runners ?? []) {
            if ("keyHash" in runner) {
                delete (runner as StoredRunner & { keyHash?: string }).keyHash;
                changed = true;
            }
        }

        if (changed) {
            this.save();
        }
    }

    get ownerToken(): string {
        return this.#config.ownerToken;
    }

    get users(): readonly User[] {
        return this.#config.users;
    }

    get lastModel(): ModelChoice | undefined {
        return this.#config.lastModel;
    }

    set lastModel(choice: ModelChoice | undefined) {
        this.#config.lastModel = choice;
        this.save();
    }

    get themeDefault(): ThemeDefault | undefined {
        return this.#config.themeDefault;
    }

    set themeDefault(choice: ThemeDefault | undefined) {
        if (choice === undefined) {
            delete this.#config.themeDefault;
        } else {
            this.#config.themeDefault = choice;
        }

        this.save();
    }

    get defaultModel(): ModelChoice | undefined {
        return this.#config.defaultModel;
    }

    set defaultModel(choice: ModelChoice | undefined) {
        if (choice === undefined) {
            delete this.#config.defaultModel;
        } else {
            this.#config.defaultModel = choice;
        }

        this.save();
    }

    /** The owner's values for a module's settings (`web.settings`): a copy, by name. */
    extensionSettings(module: string): Record<string, string | number | boolean> {
        return { ...(this.#config.extensionSettings?.[module] ?? {}) };
    }

    /** The modules the owner set values for, on or off. */
    extensionSettingModules(): string[] {
        return Object.keys(this.#config.extensionSettings ?? {});
    }

    /** Keep a module's values, all of them at once; none drops its entry. */
    setExtensionSettings(module: string, values: Record<string, string | number | boolean>): void {
        const all = { ...(this.#config.extensionSettings ?? {}) };

        if (Object.keys(values).length === 0) {
            delete all[module];
        } else {
            all[module] = { ...values };
        }

        if (Object.keys(all).length === 0) {
            delete this.#config.extensionSettings;
        } else {
            this.#config.extensionSettings = all;
        }

        this.save();
    }

    /** The owner's choice of when PiP compacts itself (`pip-compact.ts`); undefined: its default. */
    get pipCompactAt(): number | undefined {
        return this.#config.pipCompactAt;
    }

    set pipCompactAt(tokens: number | undefined) {
        if (tokens === undefined) {
            delete this.#config.pipCompactAt;
        } else {
            this.#config.pipCompactAt = tokens;
        }

        this.save();
    }

    /** The models Pi may start subagents on (`provider/modelId`); empty: none. */
    get subagentModels(): readonly string[] {
        const models = this.#config.subagentModels;

        // Read from a file people may have edited: only provider/modelId strings count.
        return Array.isArray(models)
            ? models
                  .filter((each) => typeof each === "string")
                  .map((each) => each.trim())
                  .filter((each) => each.indexOf("/") > 0)
            : [];
    }

    set subagentModels(models: readonly string[]) {
        if (models.length === 0) {
            delete this.#config.subagentModels;
        } else {
            this.#config.subagentModels = [...models];
        }

        this.save();
    }

    /** How many hours a run waits for a limit to clear, at most; 0: not at all. */
    get limitWaitHours(): number {
        const hours = this.#config.limitWaitHours;

        return typeof hours === "number" && Number.isFinite(hours) && hours >= 0
            ? Math.min(hours, 24)
            : DEFAULT_LIMIT_WAIT_HOURS;
    }

    set limitWaitHours(hours: number) {
        if (hours === DEFAULT_LIMIT_WAIT_HOURS) {
            delete this.#config.limitWaitHours;
        } else {
            this.#config.limitWaitHours = Math.min(Math.max(hours, 0), 24);
        }

        this.save();
    }

    /** How sessions are kept warm once their run ends: a copy, every field set. */
    get keepWarm(): KeepWarmSettings {
        return keepWarmFrom(this.#config.keepWarm);
    }

    set keepWarm(settings: KeepWarmSettings) {
        const kept: Partial<KeepWarmSettings> = {};
        const clean = keepWarmFrom(settings);

        for (const key of Object.keys(clean) as (keyof KeepWarmSettings)[]) {
            const same =
                key === "models"
                    ? Object.keys(clean.models).length === 0
                    : clean[key] === DEFAULT_KEEP_WARM[key];

            if (!same) {
                (kept as Record<string, unknown>)[key] = clean[key];
            }
        }

        if (Object.keys(kept).length === 0) {
            delete this.#config.keepWarm;
        } else {
            this.#config.keepWarm = kept;
        }

        this.save();
    }

    get approvalRule(): ApprovalRule {
        return this.#config.approvals ?? "anyone";
    }

    set approvalRule(rule: ApprovalRule) {
        if (rule === "anyone") {
            delete this.#config.approvals;
        } else {
            this.#config.approvals = rule;
        }

        this.save();
    }

    get disabledExtensions(): readonly string[] {
        return this.#config.disabledExtensions ?? [];
    }

    get enabledExtensions(): readonly string[] {
        return this.#config.enabledExtensions ?? [];
    }

    /** Whether the owner turned a module on or off; undefined when they never chose, so its default applies. */
    extensionChoice(file: string): boolean | undefined {
        if (this.#config.disabledExtensions?.includes(file)) {
            return false;
        }

        if (this.#config.enabledExtensions?.includes(file)) {
            return true;
        }

        return undefined;
    }

    setExtensionEnabled(file: string, enabled: boolean): void {
        const disabled = new Set(this.#config.disabledExtensions ?? []);
        const turnedOn = new Set(this.#config.enabledExtensions ?? []);

        if (enabled) {
            disabled.delete(file);
            turnedOn.add(file);
        } else {
            disabled.add(file);
            turnedOn.delete(file);
        }

        if (disabled.size === 0) {
            delete this.#config.disabledExtensions;
        } else {
            this.#config.disabledExtensions = [...disabled].sort();
        }

        if (turnedOn.size === 0) {
            delete this.#config.enabledExtensions;
        } else {
            this.#config.enabledExtensions = [...turnedOn].sort();
        }

        this.save();
    }

    /** Whose token this is: their first one, or one of their other devices'. */
    userByToken(token: string): User | undefined {
        const hash = hashToken(token);

        return this.#config.users.find(
            (user) =>
                sameHash(user.tokenHash, hash) ||
                user.devices?.some((each) => sameHash(each.tokenHash, hash)) === true,
        );
    }

    /** Sign another device in as person `id`: its new token, or undefined when they are gone. */
    addDevice(id: string, tunnel?: string): string | undefined {
        const user = this.userById(id);

        if (user === undefined) {
            return undefined;
        }

        const token = newToken();

        user.devices = [
            ...(user.devices ?? []),
            {
                tokenHash: hashToken(token),
                createdAt: Date.now(),
                ...(tunnel === undefined ? {} : { tunnel }),
            },
        ].slice(-MAX_DEVICES);
        this.save();

        return token;
    }

    /** Whether `token` is one of someone's other devices', not their first one. */
    isDevice(token: string): boolean {
        const hash = hashToken(token);

        return this.#config.users.some(
            (user) => user.devices?.some((each) => sameHash(each.tokenHash, hash)) === true,
        );
    }

    /** Sign out the device that holds `token`. A person's first token is not a device's: it stays. */
    removeDevice(token: string): boolean {
        const hash = hashToken(token);

        return this.#endDevices((each) => sameHash(each.tokenHash, hash));
    }

    /** Sign out the devices that came through a Cloudflare quick tunnel other than `current`: its address is gone. */
    endTunnelDevices(current: string | undefined): boolean {
        return this.#endDevices((each) => each.tunnel !== undefined && each.tunnel !== current);
    }

    #endDevices(ending: (device: StoredDevice) => boolean): boolean {
        let changed = false;

        for (const user of this.#config.users) {
            const kept = user.devices?.filter((each) => !ending(each));

            if (kept === undefined || kept.length === user.devices?.length) {
                continue;
            }

            if (kept.length === 0) {
                delete user.devices;
            } else {
                user.devices = kept;
            }

            changed = true;
        }

        if (changed) {
            this.save();
        }

        return changed;
    }

    userById(id: string): User | undefined {
        return this.#config.users.find((user) => user.id === id);
    }

    addUser(
        name: string,
        role: Role,
        sessions?: string[],
        temporary = false,
    ): { user: User; token: string } {
        const token = newToken();
        const user: User = {
            id: randomUUID(),
            name,
            role,
            tokenHash: hashToken(token),
            createdAt: Date.now(),
            ...(sessions === undefined ? {} : { sessions: [...sessions] }),
            ...(temporary ? { temporary: true } : {}),
        };

        this.#config.users.push(user);
        this.save();

        return { user, token };
    }

    updateUser(
        id: string,
        patch: Partial<
            Pick<
                User,
                | "name"
                | "lastSeen"
                | "role"
                | "sessions"
                | "tunnel"
                | "budget"
                | "avatar"
                | "approvalDays"
                | "linksRunners"
                | "invites"
                | "keepsWarm"
            >
        > & {
            /** Only ever turned off: a temporary account becomes a full one, never the other way. */
            temporary?: false;
        },
    ): void {
        const user = this.userById(id);

        if (user === undefined) {
            return;
        }

        // The owner stays the owner, and nobody else becomes one.
        if (patch.role !== undefined && (user.role === "owner" || patch.role === "owner")) {
            delete patch.role;
        }

        if ("sessions" in patch && user.role === "owner") {
            delete patch.sessions;
        }

        if ("budget" in patch && user.role === "owner") {
            delete patch.budget;
        }

        Object.assign(user, patch);

        if (user.sessions === undefined) {
            delete user.sessions;
        }

        if (user.budget === undefined) {
            delete user.budget;
        }

        if (user.avatar === undefined) {
            delete user.avatar;
        }

        if (user.approvalDays === undefined) {
            delete user.approvalDays;
        }

        if (user.linksRunners !== true) {
            delete user.linksRunners;
        }

        if (user.invites !== true) {
            delete user.invites;
        }

        if (user.keepsWarm !== true) {
            delete user.keepsWarm;
        }

        if (user.temporary !== true) {
            delete user.temporary;
        }

        this.save();
    }

    /** Each person's linked authenticator, kept with their account. Setting one for someone removed does nothing. */
    get authenticators(): AuthenticatorStore {
        return {
            get: (id) => this.userById(id)?.authenticator,
            set: (id, authenticator) => {
                const user = this.userById(id);

                if (user === undefined) {
                    return;
                }

                if (authenticator === undefined) {
                    delete user.authenticator;
                } else {
                    user.authenticator = authenticator;
                }

                this.save();
            },
        };
    }

    /**
     * Remove someone (never the owner), the invites they made, which could no longer be used, and the device links
     * the owner made for them.
     */
    removeUser(id: string): void {
        this.#config.users = this.#config.users.filter(
            (user) => user.id !== id || user.role === "owner",
        );

        if (!this.#config.users.some((user) => user.id === id)) {
            this.#config.invites = this.#config.invites?.filter(
                (invite) => invite.createdBy !== id && invite.person !== id,
            );

            // Nothing they were given outlives them; their sessions and tasks move to who is in charge (`app.ts`).
            for (const computer of [this.#config.server, ...(this.#config.runners ?? [])]) {
                if (computer !== undefined) {
                    setList(computer, "given", id, []);
                    setList(computer, "sees", id, []);
                    trimRights(computer, (each) => each !== id);
                    dropLeaving(computer, [id]);
                }
            }

            // Nor a link code they made and nobody used yet.
            if (this.#config.runnerCodes?.some((code) => code.createdBy === id) === true) {
                this.#config.runnerCodes = this.#config.runnerCodes.filter(
                    (code) => code.createdBy !== id,
                );
            }
        }

        this.save();
    }

    /** Keep a new invite. A person keeps at most `MAX_INVITES` live: beyond that, their oldest ends. */
    addInvite(code: string, invite: { expiresAt: number; createdBy: string } & InviteFor): void {
        this.#pruneInvites();
        const theirs = (this.#config.invites ?? []).filter(
            (each) => each.createdBy === invite.createdBy,
        );
        const ending = new Set(theirs.slice(0, Math.max(0, theirs.length - MAX_INVITES + 1)));

        this.#config.invites = [
            ...(this.#config.invites ?? []).filter((each) => !ending.has(each)),
            { codeHash: hashToken(code), ...invite },
        ];
        this.save();
    }

    /**
     * Session `to` took session `from`'s place (`app.ts` `replaced`): an invite to `from` alone that nobody used yet is
     * to `to`. Says whether there was one.
     */
    moveInvites(from: string, to: string): boolean {
        let moved = false;

        for (const invite of this.#config.invites ?? []) {
            if (invite.device === undefined && invite.session === from) {
                invite.session = to;
                moved = true;
            }
        }

        if (moved) {
            this.save();
        }

        return moved;
    }

    /** A live invite by its code, or undefined when there is none or it expired. */
    invite(code: string): StoredInvite | undefined {
        this.#pruneInvites();
        const hash = hashToken(code);

        return this.#config.invites?.find((invite) => sameHash(invite.codeHash, hash));
    }

    /** Remove an invite, and say whether it was there (and live). */
    removeInvite(code: string): boolean {
        const found = this.invite(code);

        if (found === undefined) {
            return false;
        }

        this.#config.invites = this.#config.invites?.filter((invite) => invite !== found);
        this.save();

        return true;
    }

    #pruneInvites(): void {
        const now = Date.now();
        const live = (this.#config.invites ?? []).filter((invite) => invite.expiresAt >= now);

        if (live.length !== (this.#config.invites ?? []).length) {
            this.#config.invites = live;
            this.save();
        }
    }

    /**
     * Replace the owner token, signing out every device of the owner: the ones that used the old token, and the ones
     * signed in with a device link. The device links the owner made and nobody used end too, also one for someone else.
     */
    rotateOwnerToken(): string {
        const token = newToken();

        this.#config.ownerToken = token;
        const owner = this.#config.users.find((user) => user.role === "owner");

        if (owner !== undefined) {
            owner.tokenHash = hashToken(token);
            delete owner.devices;
        }

        if (this.#config.invites !== undefined) {
            this.#config.invites = this.#config.invites.filter(
                (invite) => !(invite.device === true && invite.createdBy === owner?.id),
            );
        }

        this.save();

        return token;
    }

    get runners(): readonly StoredRunner[] {
        return this.#config.runners ?? [];
    }

    /** This server's key for the runner link: made the first time it is asked for, then kept. */
    get serverIdentity(): Identity {
        if (this.#config.serverIdentity === undefined) {
            this.#config.serverIdentity = newIdentity();
            this.save();
        }

        return this.#config.serverIdentity;
    }

    runnerById(id: string): StoredRunner | undefined {
        return this.#config.runners?.find((runner) => runner.id === id);
    }

    /** Give a computer linked again its runner's new public key. */
    relinkRunner(id: string, publicKey: string): StoredRunner | undefined {
        const runner = this.runnerById(id);

        if (runner !== undefined) {
            runner.publicKey = publicKey;
            this.save();
        }

        return runner;
    }

    /** Add a computer with its runner's public key; its private key stays on that computer. */
    addRunner(name: string, createdBy: string, publicKey: string): StoredRunner {
        const runner: StoredRunner = {
            id: randomUUID(),
            name,
            publicKey,
            createdAt: Date.now(),
            createdBy,
        };

        this.#config.runners = [...(this.#config.runners ?? []), runner];
        this.save();

        return runner;
    }

    updateRunner(
        id: string,
        patch: Partial<Pick<StoredRunner, "name" | "lastSeen" | "platform" | "tools">>,
    ): void {
        const runner = this.runnerById(id);

        if (runner !== undefined) {
            Object.assign(runner, patch);
            this.save();
        }
    }

    /**
     * The people who may be chosen for a computer: everyone but who is in charge of it (`inCharge`: they have it
     * anyway) and people invited to one session. On a runner someone else linked, the owner is chosen as anyone is.
     */
    #choosable(users: readonly string[], inCharge: (user: User) => boolean): string[] {
        return [...new Set(users)].filter((id) => {
            const user = this.userById(id);

            return user !== undefined && !inCharge(user) && user.sessions === undefined;
        });
    }

    /** Runner `id`'s linker left: `linker` (the owner) is in charge of it now. */
    setRunnerLinker(id: string, linker: string): void {
        const runner = this.runnerById(id);

        if (runner !== undefined) {
            runner.createdBy = linker;
            runner.users = runner.users?.filter((each) => each !== linker);
            // In charge of it now: nothing of theirs here is taken back.
            dropLeaving(runner, [linker]);
            trimRights(runner, (each) => each !== linker);
            this.save();
        }
    }

    /** Choose the people who may use runner `id`: anyone but its linker, who is in charge of it. */
    setRunnerUsers(id: string, users: string[]): void {
        const runner = this.runnerById(id);

        if (runner !== undefined) {
            const chosen = this.#choosable(users, (user) => user.id === runner.createdBy);

            markLeaving(runner, chosen);
            runner.users = chosen;
            trimRights(runner, (each) => chosen.includes(each));
            this.save();
        }
    }

    /** This server as a computer (`StoredServer`): a copy, so a change goes through the setters below. */
    get server(): Readonly<StoredServer> {
        return this.#config.server ?? {};
    }

    /**
     * The people of a file from before the access rules whose sessions here are still to share with them
     * (`PocketConfig.accessUpgrade`); undefined once that is done, and for any other file.
     */
    get accessUpgrade(): readonly string[] | undefined {
        return this.#config.accessUpgrade;
    }

    /** Those sessions are shared and approved: only `app.ts` `#finishUpgrade` says so, after its saves. */
    clearAccessUpgrade(): void {
        if (this.#config.accessUpgrade !== undefined) {
            delete this.#config.accessUpgrade;
            this.save();
        }
    }

    /** Choose the people who may use this server: anyone but the owner, who is in charge of it. */
    setServerUsers(users: string[]): void {
        this.#changeServer((server) => {
            const chosen = this.#choosable(users, (user) => user.role === "owner");

            markLeaving(server, chosen);
            server.users = chosen;
            trimRights(server, (each) => chosen.includes(each));
        });
    }

    /** The people leaving computer `id` (undefined: this server): `StoredRunner.leaving`. */
    leaving(id: string | undefined): readonly string[] {
        return (id === undefined ? this.#config.server : this.runnerById(id))?.leaving ?? [];
    }

    /**
     * What `people` had on computer `id` (undefined: this server) is taken back: they are no longer leaving it. Only
     * `app.ts` `#finishLeaving` says so, after its saves; choosing a person again does not.
     */
    clearLeaving(id: string | undefined, people: readonly string[]): void {
        if (id === undefined) {
            if ((this.#config.server?.leaving ?? []).some((each) => people.includes(each))) {
                this.#changeServer((server) => void dropLeaving(server, people));
            }

            return;
        }

        const runner = this.runnerById(id);

        if (runner !== undefined && dropLeaving(runner, people)) {
            this.save();
        }
    }

    /** The people who hold `right` on computer `id` (undefined: this server): `StoredRunner.wheel`, `.allows`. */
    rightHolders(id: string | undefined, right: ComputerRight): readonly string[] {
        const computer = id === undefined ? this.#config.server : this.runnerById(id);

        return computer?.[right] ?? [];
    }

    /**
     * Give `person` `right` on computer `id` (undefined: this server), or take it back. Only someone chosen there: for
     * anyone else nothing changes, and the answer is false.
     */
    setRight(id: string | undefined, person: string, right: ComputerRight, on: boolean): boolean {
        const apply = (target: Rights): boolean => {
            if (!(target.users ?? []).includes(person)) {
                return false;
            }

            const rest = (target[right] ?? []).filter((each) => each !== person);

            target[right] = on ? [...rest, person] : rest;
            trimRights(target, () => true);

            return true;
        };

        if (id === undefined) {
            let done = false;

            this.#changeServer((server) => {
                done = apply(server);
            });

            return done;
        }

        const runner = this.runnerById(id);

        if (runner === undefined || !apply(runner)) {
            return false;
        }

        this.save();

        return true;
    }

    /**
     * The folders the owner gave `person` on computer `id` (undefined: this server), real paths there. A folder given
     * covers the folders in it.
     */
    givenFolders(id: string | undefined, person: string): readonly string[] {
        const computer = id === undefined ? this.#config.server : this.runnerById(id);

        return computer?.given?.[person] ?? [];
    }

    /**
     * Set the folders given to `person` on computer `id` (undefined: this server); an empty list takes them all. A
     * folder taken back is no longer one they see every session in (`setSeenFolder`).
     */
    setGivenFolders(id: string | undefined, person: string, folders: readonly string[]): void {
        const apply = (target: FolderGrants): void => {
            const unique = [...new Set(folders)];

            setList(target, "given", person, unique);
            setList(
                target,
                "sees",
                person,
                (target.sees?.[person] ?? []).filter((each) => unique.includes(each)),
            );
        };

        if (id === undefined) {
            this.#changeServer(apply);

            return;
        }

        const runner = this.runnerById(id);

        if (runner !== undefined) {
            apply(runner);
            this.save();
        }
    }

    /**
     * Of the folders given to `person` on computer `id` (undefined: this server), the ones in which they see every
     * session, their own or not (`access.ts` `seesFolder`).
     */
    seenFolders(id: string | undefined, person: string): readonly string[] {
        const computer = id === undefined ? this.#config.server : this.runnerById(id);

        return computer?.sees?.[person] ?? [];
    }

    /**
     * `person` sees every session in `folder` on computer `id` (undefined: this server), or no longer. Only a folder
     * given to them there, as it is written in that list: any other changes nothing, and the answer is false.
     */
    setSeenFolder(id: string | undefined, person: string, folder: string, on: boolean): boolean {
        if (!this.givenFolders(id, person).includes(folder)) {
            return false;
        }

        const apply = (target: FolderGrants): void => {
            const rest = (target.sees?.[person] ?? []).filter((each) => each !== folder);

            setList(target, "sees", person, on ? [...rest, folder] : rest);
        };

        if (id === undefined) {
            this.#changeServer(apply);

            return true;
        }

        const runner = this.runnerById(id);

        if (runner === undefined) {
            return false;
        }

        apply(runner);
        this.save();

        return true;
    }

    /**
     * The owner turns "Tasks expire with the session" on or off (`app.ts` `tasksMayRun`), at `now`. On while it was on
     * changes nothing: the time it went on stays. Off forgets that time and every reminder.
     */
    setTasksExpire(on: boolean, now: number): void {
        if (!on) {
            delete this.#config.taskReminders;
        }

        this.#changeServer((server) => {
            if (!on) {
                delete server.tasksExpire;
                delete server.tasksExpireSince;
            } else if (server.tasksExpire !== true) {
                server.tasksExpire = true;
                server.tasksExpireSince = now;
            }
        });
    }

    /** Change a computer's rules (`id` undefined: this server). */
    setComputerSettings(id: string | undefined, change: ComputerSettings): void {
        const apply = (target: { shareNew?: true }): void => {
            if (change.shareNew === true) {
                target.shareNew = true;
            } else if (change.shareNew === false) {
                delete target.shareNew;
            }
        };

        if (id === undefined) {
            this.#changeServer(apply);

            return;
        }

        const runner = this.runnerById(id);

        if (runner !== undefined) {
            apply(runner);

            const settings = { ...runner.settings };

            if (change.network === false) {
                settings.network = false;
            } else if (change.network === true) {
                delete settings.network;
            }

            if (typeof change.downloads === "string") {
                settings.downloads = change.downloads;
            } else if (change.downloads === null) {
                delete settings.downloads;
            }

            if (Object.keys(settings).length === 0) {
                delete runner.settings;
            } else {
                runner.settings = settings;
            }

            this.save();
        }
    }

    /** Every approval kept (`folder-approvals.ts` reads and changes them through `setFolderApprovals`). */
    get folderApprovals(): readonly StoredApproval[] {
        return this.#config.folderApprovals ?? [];
    }

    setFolderApprovals(approvals: StoredApproval[]): void {
        if (approvals.length === 0) {
            delete this.#config.folderApprovals;
        } else {
            this.#config.folderApprovals = approvals;
        }

        this.save();
    }

    /** When each session's people were last reminded that its tasks run on an ended approval (`folder-approvals.ts`). */
    get taskReminders(): Readonly<Record<string, number>> {
        return this.#config.taskReminders ?? {};
    }

    /** Session `session`'s people were reminded at `at`; undefined forgets it (renewed). */
    setTaskReminder(session: string, at: number | undefined): void {
        const reminders = { ...this.#config.taskReminders };

        if (at === undefined) {
            delete reminders[session];
        } else {
            reminders[session] = at;
        }

        if (Object.keys(reminders).length === 0) {
            delete this.#config.taskReminders;
        } else {
            this.#config.taskReminders = reminders;
        }

        this.save();
    }

    #changeServer(change: (server: StoredServer) => void): void {
        const server: StoredServer = structuredClone(this.#config.server ?? {});

        change(server);

        if (server.users?.length === 0) {
            delete server.users;
        }

        if (Object.keys(server).length === 0) {
            delete this.#config.server;
        } else {
            this.#config.server = server;
        }

        this.save();
    }

    /** Forget a computer: its key stops working. */
    removeRunner(id: string): boolean {
        const before = this.#config.runners ?? [];
        const after = before.filter((runner) => runner.id !== id);

        if (after.length === before.length) {
            return false;
        }

        this.#config.runners = after;
        this.save();

        return true;
    }

    /** Keep a one-time code that links a computer named `name`, until `expiresAt`. */
    addRunnerCode(
        code: string,
        name: string,
        createdBy: string,
        expiresAt: number,
        runner?: string,
    ): void {
        const now = Date.now();

        this.#config.runnerCodes = [
            ...(this.#config.runnerCodes ?? []).filter(
                (each) => each.expiresAt >= now && (runner === undefined || each.runner !== runner),
            ),
            {
                codeHash: codeHash(code),
                name,
                createdBy,
                expiresAt,
                ...(runner === undefined ? {} : { runner }),
            },
        ];
        this.save();
    }

    /** The saved part of the wrong link code limits (`link-limits.ts`). */
    get runnerLinkLimits(): StoredLinkLimits | undefined {
        return this.#config.runnerLinkLimits;
    }

    set runnerLinkLimits(value: StoredLinkLimits) {
        this.#config.runnerLinkLimits = value;
        this.save();
    }

    /** Forget every open link code (too many wrong codes reached the server: `link-limits.ts`). */
    voidRunnerCodes(): void {
        if ((this.#config.runnerCodes ?? []).length > 0) {
            this.#config.runnerCodes = [];
            this.save();
        }
    }

    /**
     * Use a one-time code: returns what it was for and forgets it; undefined when none fits or it expired. The code
     * itself never comes here: `proves(hash)` says whether the runner proved it knows the code kept as `hash`.
     */
    takeRunnerCode(proves: (hash: string) => boolean): StoredRunnerCode | undefined {
        const now = Date.now();
        const codes = this.#config.runnerCodes ?? [];
        const found = codes.find((each) => proves(each.codeHash));
        const left = codes.filter((each) => each !== found && each.expiresAt >= now);

        if (found !== undefined || left.length !== codes.length) {
            this.#config.runnerCodes = left;
            this.save();
        }

        return found !== undefined && found.expiresAt >= now ? found : undefined;
    }

    save(): void {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;

        writeFileSync(temp, `${JSON.stringify(this.#config, null, "\t")}\n`, { mode: 0o600 });
        renameSync(temp, this.file);
        chmodSync(this.file, 0o600);
    }
}
