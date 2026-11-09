/**
 * Approvals of new folders on this server (`access.ts` `folder` said "ask"): a person who wants a session in a folder no
 * saved folder covers waits here until it is approved, denied, withdrawn, or too old. Two ways approve one
 * (`approval-methods.ts`): the person's own authenticator code, or the owner from the app. An approved folder is saved
 * for this server (unless it is too broad: a root, the home folder, or above it), so the next session there asks only
 * while "Stop asking" is off.
 *
 * Requests live in memory: a restart ends them, and the person asks again. Nothing here is a document.
 */
import { randomUUID } from "node:crypto";
import { broadFolder } from "../runner/folders.ts";
import type { Person } from "./access.ts";
import type { ApprovalMethods, MethodId, Proof } from "./approval-methods.ts";
import { HttpError } from "./errors.ts";

/** How long a request waits for an answer, as a runner's question with a code does. */
export const FOLDER_REQUEST_MS = 300_000;

/** What the session is: a new one, a copy, a move of one, or one an agent links. */
export type FolderRequestKind = "new" | "fork" | "move" | "linked";

/** A request as people see it: the requester theirs, the owner every one. */
export type FolderRequestView = {
    id: string;
    person: string;
    name: string;
    folder: string;
    kind: FolderRequestKind;
    /** A saved folder covers it: approving starts the session, and saves nothing. */
    saved: boolean;
    /** Approving does not save it: too broad to save. */
    broad: boolean;
    /** The requester has an authenticator linked, so they can approve with a code. */
    code: boolean;
    expiresAt: number;
};

type Pending = FolderRequestView & {
    resolve: (method: MethodId) => void;
    reject: (error: Error) => void;
};

export type FolderRequestOptions = {
    methods: ApprovalMethods;
    /** The current record of a person (a person removed meanwhile is gone). */
    person: (id: string) => (Person & { name: string }) | undefined;
    /** Whether `person` has an authenticator linked now. */
    hasCode: (person: string) => boolean;
    /** This server's home folder, for the broad-folder rule. */
    home: string;
    /** Save an approved folder for this server. */
    save: (folder: string) => void;
    /** The requests changed: tell each person's tabs theirs, and the owner all. */
    changed: () => void;
    /** A new request: the owner hears of it (a notice, a push). */
    asked: (request: FolderRequestView) => void;
    now?: () => number;
};

export class FolderRequests {
    readonly #pending = new Map<string, Pending>();
    readonly #options: FolderRequestOptions;
    readonly #now: () => number;

    constructor(options: FolderRequestOptions) {
        this.#options = options;
        this.#now = options.now ?? (() => Date.now());
    }

    /** The requests `person` sees: the owner every one; anyone else their own. */
    list(person: Pick<Person, "id">): FolderRequestView[] {
        const current = this.#options.person(person.id);

        if (current === undefined) {
            return [];
        }

        return [...this.#pending.values()]
            .filter((each) => current.role === "owner" || each.person === current.id)
            .map(({ resolve: _resolve, reject: _reject, ...view }) => view);
    }

    /**
     * Wait for an approval of `folder` (a real path here) for `person`. Resolves with how it was approved; rejects when
     * it is denied, withdrawn (also by `signal`), or too old. An approved folder is saved, unless saved already or broad.
     */
    async ask(
        person: Pick<Person, "id">,
        folder: string,
        kind: FolderRequestKind,
        saved: boolean,
        signal?: AbortSignal,
    ): Promise<MethodId> {
        const current = this.#options.person(person.id);

        if (current === undefined) {
            throw new HttpError(403, "You are not on this server.");
        }

        signal?.throwIfAborted();

        const id = randomUUID();
        const broad = broadFolder(folder, this.#options.home);
        let timer: NodeJS.Timeout | undefined;
        let abort: (() => void) | undefined;

        const method = await new Promise<MethodId>((resolve, reject) => {
            const request: Pending = {
                id,
                person: current.id,
                name: current.name,
                folder,
                kind,
                saved,
                broad,
                code: this.#options.hasCode(current.id),
                expiresAt: this.#now() + FOLDER_REQUEST_MS,
                resolve,
                reject,
            };

            this.#pending.set(id, request);
            timer = setTimeout(
                () =>
                    reject(
                        new HttpError(
                            409,
                            "Nobody approved the folder in time. Try again, and enter a code from your authenticator or ask the owner.",
                        ),
                    ),
                FOLDER_REQUEST_MS,
            );
            timer.unref?.();
            abort = () => reject(new HttpError(409, "Cancelled."));
            signal?.addEventListener("abort", abort, { once: true });
            this.#options.changed();

            const { resolve: _resolve, reject: _reject, ...view } = request;

            this.#options.asked(view);
        }).finally(() => {
            clearTimeout(timer);

            if (abort !== undefined) {
                signal?.removeEventListener("abort", abort);
            }

            this.#pending.delete(id);
            this.#options.changed();
        });

        if (!saved && !broad) {
            this.#options.save(folder);
        }

        return method;
    }

    /**
     * `approver` approves request `id` with `proof`: their own code for their own request, or the owner from the app.
     * Someone who may not see the request learns nothing of it (404).
     */
    async approve(approver: Pick<Person, "id">, id: string, proof: Proof): Promise<void> {
        const request = this.#visible(approver, id);
        const current = this.#options.person(approver.id)!;
        const requester = this.#options.person(request.person);

        if (requester === undefined) {
            request.reject(new HttpError(403, "You are not on this server."));

            return;
        }

        const method = await this.#options.methods.verify(current, requester, proof);

        // Answered by someone else while the code was checked: nothing more to do.
        this.#pending.get(id)?.resolve(method);
    }

    /** The owner denies request `id`; its requester withdraws it. */
    deny(person: Pick<Person, "id">, id: string): void {
        const request = this.#visible(person, id);
        const current = this.#options.person(person.id)!;

        request.reject(
            new HttpError(
                current.id === request.person ? 409 : 403,
                current.id === request.person
                    ? "Cancelled."
                    : "The owner did not allow this folder.",
            ),
        );
    }

    /**
     * End the requests of people who may no longer start sessions here (`mayStart`: removed, no longer chosen, made a
     * viewer): nobody can approve them into a session now.
     */
    prune(mayStart: (person: string) => boolean): void {
        for (const request of [...this.#pending.values()]) {
            if (!mayStart(request.person)) {
                request.reject(new HttpError(403, "You can no longer start sessions here."));
            }
        }
    }

    #visible(person: Pick<Person, "id">, id: string): Pending {
        const current = this.#options.person(person.id);
        const request = this.#pending.get(id);

        if (
            current === undefined ||
            request === undefined ||
            (current.role !== "owner" && request.person !== current.id)
        ) {
            throw new HttpError(
                404,
                "That request is gone: it was answered, cancelled, or too old.",
            );
        }

        return request;
    }
}
