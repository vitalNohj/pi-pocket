/**
 * Approvals kept on the server, for every computer: a person may work in a folder on a computer, or steer a session
 * shared with them. A person approves with their own authenticator code, or the owner approves from the app
 * (`approval-methods.ts`, `folder-requests.ts`). An approval lasts while it is used: it ends once unused for the
 * person's approval time (`config.ts` `approvalDays`), and each use starts that clock again.
 *
 * What a person may do at all is the policy's (`access.ts`): an approval only proves, for a while, that it is them.
 */
import { randomUUID } from "node:crypto";
import { approvalDays, type StoredApproval, type User } from "./config.ts";
import { HttpError } from "./errors.ts";

const DAY_MS = 86_400_000;

/** The least time between two saved uses of one approval. */
const USE_STEP_MS = 60_000;

/** The folder of an approval that covers a whole computer: the owner's, on a runner. */
export const WHOLE_COMPUTER = "*";

/** What an approval is for: a folder (or `WHOLE_COMPUTER`) on a computer, or a shared session there. */
export type ApprovalTarget = { computer: string } & ({ folder: string } | { session: string });

/** An approval as people see it, with when it ends unless used again. */
export type ApprovalView = StoredApproval & { name: string; expiresAt: number | null };

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

    /**
     * When `approval` ends unless used again; null: never (its person is never asked, or a task's, which lasts while its
     * task does). Undefined: its person is gone.
     */
    #expiresAt(approval: StoredApproval): number | null | undefined {
        const person = this.#store.userById(approval.person);

        if (person === undefined) {
            return undefined;
        }

        if (approval.task !== undefined) {
            return null;
        }

        const days = approvalDays(person);

        return days === 0 ? null : approval.usedAt + days * DAY_MS;
    }

    #live(approval: StoredApproval): boolean {
        const expiresAt = this.#expiresAt(approval);

        return expiresAt !== undefined && (expiresAt === null || expiresAt > this.#now());
    }

    #matches(approval: StoredApproval, person: string, target: ApprovalTarget): boolean {
        return (
            approval.task === undefined &&
            approval.person === person &&
            approval.computer === target.computer &&
            ("folder" in target
                ? approval.session === undefined &&
                  (approval.folder === target.folder || approval.folder === WHOLE_COMPUTER)
                : approval.session === target.session)
        );
    }

    /**
     * Whether `person` has a live approval for `target`; using it starts its clock again. A whole-computer approval
     * covers every folder there.
     */
    use(person: string, target: ApprovalTarget): boolean {
        const found = this.#store.folderApprovals.find(
            (each) => this.#matches(each, person, target) && this.#live(each),
        );

        if (found === undefined) {
            return false;
        }

        // Each message uses it: the clock moves at most once a minute, so sending is not a config write each time.
        if (this.#now() - found.usedAt >= USE_STEP_MS) {
            this.#save((list) =>
                list.map((each) =>
                    each.id === found.id ? { ...each, usedAt: this.#now() } : each,
                ),
            );
        }

        return true;
    }

    /** Whether `person` has a live approval for `target`, without using it. */
    has(person: string, target: ApprovalTarget): boolean {
        return this.find(person, target) !== undefined;
    }

    /** `person`'s live approval for `target`, without using it. */
    find(person: string, target: ApprovalTarget): StoredApproval | undefined {
        return this.#store.folderApprovals.find(
            (each) => this.#matches(each, person, target) && this.#live(each),
        );
    }

    /**
     * Keep an approval for recurring task `task` (`schedule:<task>`, `hook:<id>`, ...): `person`'s, of `target`, as
     * `method` and `by` gave it. It does not end while unused, for the task runs when nobody is there; it covers the
     * task's runs alone, never a session someone starts. Revoking it stops the task's runs.
     */
    addTask(
        person: string,
        target: ApprovalTarget,
        task: string,
        label: string,
        method: StoredApproval["method"],
        by: string,
    ): void {
        const now = this.#now();
        const approval: StoredApproval = {
            id: randomUUID(),
            person,
            computer: target.computer,
            ...("folder" in target ? { folder: target.folder } : { session: target.session }),
            method,
            by,
            approvedAt: now,
            usedAt: now,
            task,
            label,
        };

        this.#save((list) => [...list.filter((each) => each.task !== task), approval]);
    }

    /** Task `task`'s approval, while its person is here; undefined when there is none (revoked, or never given). */
    task(task: string): StoredApproval | undefined {
        return this.#store.folderApprovals.find((each) => each.task === task && this.#live(each));
    }

    /** Task `task` is gone: its approval goes with it. */
    dropTask(task: string): void {
        if (this.#store.folderApprovals.some((each) => each.task === task)) {
            this.#save((list) => list.filter((each) => each.task !== task));
        }
    }

    /** Keep a new approval of `target` for `person`, in place of an older one for the same. */
    add(
        person: string,
        target: ApprovalTarget,
        method: StoredApproval["method"],
        by: string,
    ): StoredApproval {
        const now = this.#now();
        const approval: StoredApproval = {
            id: randomUUID(),
            person,
            computer: target.computer,
            ...("folder" in target ? { folder: target.folder } : { session: target.session }),
            method,
            by,
            approvedAt: now,
            usedAt: now,
        };

        this.#save((list) => [
            ...list.filter(
                (each) =>
                    !(
                        each.person === person &&
                        each.computer === target.computer &&
                        each.folder === approval.folder &&
                        each.session === approval.session
                    ),
            ),
            approval,
        ]);

        return approval;
    }

    /** The live approvals `viewer` sees: the owner every one, anyone else their own. Newest first. */
    list(viewer: Pick<User, "id" | "role">): ApprovalView[] {
        return this.#store.folderApprovals
            .filter(
                (each) =>
                    (viewer.role === "owner" || each.person === viewer.id) && this.#live(each),
            )
            .map((each) => ({
                ...each,
                name: this.#store.userById(each.person)?.name ?? "Someone",
                expiresAt: this.#expiresAt(each) ?? null,
            }))
            .sort((a, b) => b.usedAt - a.usedAt);
    }

    /** `viewer` revokes approval `id`: their own, or anyone's for the owner. Anyone else learns nothing of it (404). */
    revoke(viewer: Pick<User, "id" | "role">, id: string): void {
        const found = this.#store.folderApprovals.find((each) => each.id === id);

        if (found === undefined || (viewer.role !== "owner" && found.person !== viewer.id)) {
            throw new HttpError(404, "That approval is gone.");
        }

        this.#save((list) => list.filter((each) => each.id !== id));
    }

    /** Drop the approvals `keep` refuses (a person no longer chosen, a folder no longer given), and the expired ones. */
    prune(keep: (approval: StoredApproval) => boolean): void {
        const list = this.#store.folderApprovals;
        const kept = list.filter((each) => this.#live(each) && keep(each));

        if (kept.length !== list.length) {
            this.#save(() => kept);
        }
    }

    #save(change: (list: StoredApproval[]) => StoredApproval[]): void {
        this.#store.setFolderApprovals(change([...this.#store.folderApprovals]));
        this.#changed();
    }
}
