/**
 * Requests for an approval (`access.ts` said "ask"): a person who wants to work in a folder, or to steer a session shared
 * with them, without a live approval (`folder-approvals.ts`) waits here until it is approved, denied, withdrawn, or too old.
 * Two ways approve one (`approval-methods.ts`): the person's own authenticator code, or the owner from the app. The
 * caller keeps the approval that answers it.
 *
 * Requests live in memory: a restart ends them, and the person asks again. Nothing here is a document.
 */
import { randomUUID } from "node:crypto";
import type { Person } from "./access.ts";
import type { ApprovalMethods, MethodId, Proof } from "./approval-methods.ts";
import { HttpError } from "./errors.ts";

/** How long a request waits for an answer, as a runner's question with a code does. */
export const FOLDER_REQUEST_MS = 300_000;

/**
 * What it is for: a new session, a copy, a move of one, one an agent links, or sending to a session (their own, whose
 * folder's approval ended, or one shared with them).
 */
export type FolderRequestKind = "new" | "fork" | "move" | "linked" | "steer";

/** What a request asks for, and where. */
export type FolderQuestion = {
    /** `THIS_SERVER` or a runner's id. */
    computer: string;
    /** The computer's name, for people. */
    computerName: string;
    folder: string;
    kind: FolderRequestKind;
    /** The approval covers the whole computer (the owner, on a runner), not this folder alone. */
    whole?: boolean;
    /** A shared session's id: the approval is for steering it. */
    session?: string;
};

/** A request as people see it: the requester theirs, the owner every one. */
export type FolderRequestView = FolderQuestion & {
    id: string;
    person: string;
    name: string;
    /** The requester has an authenticator linked, so they can approve with a code. */
    code: boolean;
    expiresAt: number;
};

/** Who answered a request, and how. */
export type FolderAnswer = { method: MethodId; by: string };

type Pending = FolderRequestView & {
    resolve: (answer: FolderAnswer) => void;
    reject: (error: Error) => void;
};

export type FolderRequestOptions = {
    methods: ApprovalMethods;
    /** The current record of a person (a person removed meanwhile is gone). */
    person: (id: string) => (Person & { name: string }) | undefined;
    /** Whether `person` has an authenticator linked now. */
    hasCode: (person: string) => boolean;
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
     * Wait for an approval of `question` for `person`. Resolves with who approved it and how; rejects when it is denied,
     * withdrawn (also by `signal`), or too old.
     */
    async ask(
        person: Pick<Person, "id">,
        question: FolderQuestion,
        signal?: AbortSignal,
    ): Promise<FolderAnswer> {
        const current = this.#options.person(person.id);

        if (current === undefined) {
            throw new HttpError(403, "You are not on this server.");
        }

        signal?.throwIfAborted();

        const id = randomUUID();
        let timer: NodeJS.Timeout | undefined;
        let abort: (() => void) | undefined;

        return new Promise<FolderAnswer>((resolve, reject) => {
            const request: Pending = {
                ...question,
                id,
                person: current.id,
                name: current.name,
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
                            "Nobody approved it in time. Try again, and enter a code from your authenticator or ask the owner.",
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
        this.#pending.get(id)?.resolve({ method, by: current.id });
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
     * End the requests `keep` refuses (a person removed, no longer chosen, made a viewer, or no longer given the folder):
     * nobody can approve them now.
     */
    prune(keep: (request: FolderRequestView) => boolean): void {
        for (const request of [...this.#pending.values()]) {
            if (!keep(request)) {
                request.reject(new HttpError(403, "You can no longer work there."));
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
