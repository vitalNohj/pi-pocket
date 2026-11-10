/**
 * Session approvals, kept on the server for every computer. Before someone works in a session on a computer they are not
 * in charge of, someone proves it is them: its starter with their own authenticator code, or who is in charge of the
 * computer with Allow in the app (`approval-methods.ts`, `folder-requests.ts`). The proof belongs to the session.
 *
 * It lasts while the session is used. Each use resets its clock to the approval time of the person who used it
 * (`config.ts` `approvalDays`), and it ends once unused that long. An ended approval locks the session: sending, its
 * settings, and its tasks wait until it is renewed. Stopping work never needs it.
 *
 * What a person may do at all is the policy's (`access.ts`): an approval only proves, for a while, that someone is there.
 */
import { approvalDays, type StoredApproval, type User } from "./config.ts";
import { HttpError } from "./errors.ts";

export const DAY_MS = 86_400_000;

/** The least time between two saved uses of one approval by the same person. */
const USE_STEP_MS = 60_000;

/** An approval as people see it: when it ends unless used again (null: never), and whether it has. */
export type ApprovalView = StoredApproval & {
    expiresAt: number | null;
    ended: boolean;
    /** The session's title, for the lists. */
    title: string;
    /** Who used it last, by name. */
    name: string;
};

export interface FolderApprovalStore {
    readonly folderApprovals: readonly StoredApproval[];
    setFolderApprovals(approvals: StoredApproval[]): void;
    userById(id: string): User | undefined;
}

export class FolderApprovals {
    readonly #store: FolderApprovalStore;
    readonly #now: () => number;
    readonly #changed: () => void;

    constructor(
        store: FolderApprovalStore,
        options: { now?: () => number; changed?: () => void } = {},
    ) {
        this.#store = store;
        this.#now = options.now ?? (() => Date.now());
        this.#changed = options.changed ?? (() => {});
    }

    /** Session `session`'s approval, live or ended; undefined when it never had one (or it was revoked). */
    get(session: string): StoredApproval | undefined {
        return this.#store.folderApprovals.find((each) => each.session === session);
    }

    /**
     * When `approval` ends unless used again: its last user's approval time after its last use; null for never. A last
     * user who is gone counts as the default time.
     */
    expiresAt(approval: StoredApproval): number | null {
        const user = this.#store.userById(approval.lastUser);
        const days = approvalDays(user ?? {});

        return days === 0 ? null : approval.usedAt + days * DAY_MS;
    }

    /** Whether session `session`'s approval is live. */
    live(session: string): boolean {
        const approval = this.get(session);

        return approval !== undefined && this.#live(approval);
    }

    #live(approval: StoredApproval): boolean {
        const expiresAt = this.expiresAt(approval);

        return expiresAt === null || expiresAt > this.#now();
    }

    /**
     * `user` uses session `session`: true while its approval is live, and its clock starts again at their approval time.
     * False: it ended (or never was), and the session is locked.
     */
    use(session: string, user: Pick<User, "id">): boolean {
        const found = this.get(session);

        if (found === undefined || !this.#live(found)) {
            return false;
        }

        // Each message uses it: the clock moves at most once a minute for one person, so sending is not a write each time.
        if (found.lastUser !== user.id || this.#now() - found.usedAt >= USE_STEP_MS) {
            this.#replace(session, { ...found, usedAt: this.#now(), lastUser: user.id });
        }

        return true;
    }

    /**
     * Approve session `session` (on `computer`, in `folder`), or renew its approval: `method` by `by`, for `user`, who
     * uses it first. A renewal ends any week of grace (`reminded`).
     */
    approve(
        session: string,
        target: { computer: string; folder: string },
        method: StoredApproval["method"],
        by: string,
        user: Pick<User, "id">,
    ): StoredApproval {
        const now = this.#now();
        const approval: StoredApproval = {
            session,
            computer: target.computer,
            folder: target.folder,
            method,
            by,
            approvedAt: now,
            usedAt: now,
            lastUser: user.id,
        };

        this.#replace(session, approval);

        return approval;
    }

    /**
     * A copy, a linked session, or a subagent started from session `from` while its approval was live: `to` gets that
     * approval, used now by `user`, in its own folder. Pi's work from a live run asks no one.
     */
    inherit(
        from: string,
        to: string,
        target: { computer: string; folder: string },
        user: Pick<User, "id">,
    ): boolean {
        const parent = this.get(from);

        if (parent === undefined || !this.#live(parent)) {
            return false;
        }

        this.approve(to, target, parent.method, parent.by, user);

        return true;
    }

    /** Session `session`'s approval moved to another folder (a move). */
    moved(session: string, folder: string): void {
        const found = this.get(session);

        if (found !== undefined && found.folder !== folder) {
            this.#replace(session, { ...found, folder });
        }
    }

    /** Mark when session `session`'s tasks were last reminded that its approval ended. */
    reminded(session: string, at: number): void {
        const found = this.get(session);

        if (found !== undefined) {
            this.#replace(session, { ...found, reminded: at });
        }
    }

    /**
     * The approvals `viewer` may list (`may`: the sessions they see as starter or as the one in charge), newest use
     * first, ended ones too, so a locked session shows how to renew it.
     */
    list(
        may: (approval: StoredApproval) => boolean,
        title: (session: string) => string,
    ): ApprovalView[] {
        return this.#store.folderApprovals
            .filter((each) => may(each))
            .map((each) => {
                const expiresAt = this.expiresAt(each);

                return {
                    ...each,
                    expiresAt,
                    ended: expiresAt !== null && expiresAt <= this.#now(),
                    title: title(each.session),
                    name: this.#store.userById(each.lastUser)?.name ?? "Someone",
                };
            })
            .sort((a, b) => b.usedAt - a.usedAt);
    }

    /** Revoke session `session`'s approval, which `may` allows: the session locks until renewed. Else 404. */
    revoke(session: string, may: boolean): void {
        if (!may || this.get(session) === undefined) {
            throw new HttpError(404, "That approval is gone.");
        }

        this.#save((list) => list.filter((each) => each.session !== session));
    }

    /** Drop the approvals `keep` refuses: of sessions that are gone. */
    prune(keep: (approval: StoredApproval) => boolean): void {
        const list = this.#store.folderApprovals;
        const kept = list.filter((each) => keep(each));

        if (kept.length !== list.length) {
            this.#save(() => kept);
        }
    }

    #replace(session: string, approval: StoredApproval): void {
        this.#save((list) => [...list.filter((each) => each.session !== session), approval]);
    }

    #save(change: (list: StoredApproval[]) => StoredApproval[]): void {
        this.#store.setFolderApprovals(change([...this.#store.folderApprovals]));
        this.#changed();
    }
}
