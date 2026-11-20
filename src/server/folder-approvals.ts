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
};

export interface FolderApprovalStore {
    readonly folderApprovals: readonly StoredApproval[];
    setFolderApprovals(approvals: StoredApproval[]): void;
    /** When each session's people last heard that its tasks run on borrowed time, by session (`app.ts` `tasksMayRun`). */
    readonly taskReminders: Readonly<Record<string, number>>;
    setTaskReminder(session: string, at: number | undefined): void;
    userById(id: string): User | undefined;
}

export class FolderApprovals {
    readonly #store: FolderApprovalStore;
    readonly #now: () => number;
    readonly #changed: () => void;
    readonly #approved: (approval: StoredApproval) => void;

    /** `approved`: a session was approved or renewed, by any way; whoever waits to renew it goes on. */
    constructor(
        store: FolderApprovalStore,
        options: {
            now?: () => number;
            changed?: () => void;
            approved?: (approval: StoredApproval) => void;
        } = {},
    ) {
        this.#store = store;
        this.#now = options.now ?? (() => Date.now());
        this.#changed = options.changed ?? (() => {});
        this.#approved = options.approved ?? (() => {});
    }

    /** Session `session`'s approval, live or ended (a revoked one ended then); undefined when it never had one. */
    get(session: string): StoredApproval | undefined {
        return this.#store.folderApprovals.find((each) => each.session === session);
    }

    /**
     * When `approval` ends unless used again: its last user's approval time after its last use; null for never. A last
     * user who is gone counts as the default time. A revoked one ended when it was revoked.
     */
    expiresAt(approval: StoredApproval): number | null {
        if (approval.revokedAt !== undefined) {
            return approval.revokedAt;
        }

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
     * uses it first. A renewal ends a revoke, and any week of grace of its tasks (`reminded`).
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

        if (this.remindedAt(session) !== undefined) {
            this.#store.setTaskReminder(session, undefined);
        }

        this.#approved(approval);

        return approval;
    }

    /**
     * Approve many sessions in one save, `method` by `by`: each of `targets` that never had an approval gets one, used
     * now by its `user`. One that has an approval, live or ended, keeps it. For sessions from before approvals
     * (`app.ts` `#finishUpgrade`): nobody waits for these, so no one is told. Returns how many it approved.
     */
    approveNew(
        targets: readonly { session: string; computer: string; folder: string; user: string }[],
        method: StoredApproval["method"],
        by: string,
    ): number {
        const now = this.#now();
        const known = new Set(this.#store.folderApprovals.map((each) => each.session));
        const added: StoredApproval[] = [];

        for (const target of targets) {
            if (known.has(target.session)) {
                continue;
            }

            known.add(target.session);
            added.push({
                session: target.session,
                computer: target.computer,
                folder: target.folder,
                method,
                by,
                approvedAt: now,
                usedAt: now,
                lastUser: target.user,
            });
        }

        if (added.length > 0) {
            this.#save((list) => [...list, ...added]);
        }

        return added.length;
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

    /** When session `session`'s people last heard that its approval ended while its tasks run on; undefined: not yet. */
    remindedAt(session: string): number | undefined {
        return this.#store.taskReminders[session];
    }

    /** Mark that they heard it now, at `at`. Kept by session: one that never had an approval is reminded too. */
    reminded(session: string, at: number): void {
        this.#store.setTaskReminder(session, at);
    }

    /**
     * The approvals `viewer` may list (`may`: the sessions they see as starter or as the one in charge), newest use
     * first, ended ones too, so a locked session shows how to renew it.
     */
    list(may: (approval: StoredApproval) => boolean): ApprovalView[] {
        return this.#store.folderApprovals
            .filter((each) => may(each))
            .map((each) => {
                const expiresAt = this.expiresAt(each);

                return {
                    ...each,
                    expiresAt,
                    ended: expiresAt !== null && expiresAt <= this.#now(),
                };
            })
            .sort((a, b) => b.usedAt - a.usedAt);
    }

    /**
     * Revoke session `session`'s approval, which `may` allows: it ends now, and the session locks until renewed. Else
     * 404. It is kept, as any ended one: its row offers Renew, and its tasks' week of grace counts from now
     * (`app.ts` `tasksMayRun`). One that ended already keeps its own time.
     */
    revoke(session: string, may: boolean): void {
        const found = this.get(session);

        if (!may || found === undefined) {
            throw new HttpError(404, "That approval is gone.");
        }

        if (this.#live(found)) {
            this.#replace(session, { ...found, revokedAt: this.#now() });
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
