/**
 * Requests for a session's approval (`folder-approvals.ts`): a person who wants to start a session on a computer they are
 * not in charge of, or to renew a locked session's approval, waits here until it is approved, denied, withdrawn, or too
 * old. Two ways approve one (`approval-methods.ts`): the requester's own authenticator code, or Allow in the app by who
 * is in charge of the computer (the owner here, a runner's linker there). The caller keeps the approval that answers it.
 *
 * A session's approval belongs to the session: once it is renewed, by any request or from its row, everyone waiting to
 * renew it goes on (`renewed`). A caller who gives up leaves only its own wait; the request ends with its last one.
 *
 * Requests live in memory: a restart ends them, and the person asks again. Nothing here is a document.
 */
import { randomUUID } from "node:crypto";
import type { Person } from "./access.ts";
import type { ApprovalMethods, MethodId, Proof } from "./approval-methods.ts";
import { HttpError } from "./errors.ts";

/** How long a request waits for an answer. */
export const FOLDER_REQUEST_MS = 300_000;

/** What it is for: a new session, or renewing a locked one's approval (`renew`). */
export type FolderRequestKind = "new" | "renew";

/** What a request asks for, and where. */
export type FolderQuestion = {
    /** `THIS_SERVER` or a runner's id. */
    computer: string;
    /** The computer's name, for people. */
    computerName: string;
    folder: string;
    kind: FolderRequestKind;
    /** The session whose approval it renews (`renew`). */
    session?: string;
    /** Its title, for people. */
    title?: string;
};

/** A request as people see it: the requester theirs, who is in charge every one on their computer. */
export type FolderRequestView = FolderQuestion & {
    id: string;
    person: string;
    name: string;
    /** The requester may answer it with a code: they have an authenticator linked, and may renew with it. */
    code: boolean;
    expiresAt: number;
};

/** Who answered a request, and how. */
export type FolderAnswer = { method: MethodId; by: string };

/** One caller waiting on a request: the same person may wait on it more than once (two actions in a locked session). */
type Waiter = { resolve: (answer: FolderAnswer) => void; reject: (error: Error) => void };

type Pending = { view: FolderRequestView; waiters: Set<Waiter>; timer: NodeJS.Timeout };

export type FolderRequestOptions = {
    methods: ApprovalMethods;
    /** The current record of a person (a person removed meanwhile is gone). */
    person: (id: string) => (Person & { name: string }) | undefined;
    /** Whether `person` has an authenticator linked now. */
    hasCode: (person: string) => boolean;
    /** Whether `person` is in charge of computer `computer` (`access.ts` `inCharge`): they see and allow its requests. */
    inCharge: (person: Pick<Person, "id">, computer: string) => boolean;
    /** The requests changed: tell each person's tabs what they see. */
    changed: () => void;
    /** A new request: who is in charge of its computer hears of it (a notice, a push). */
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

    /** The requests `person` sees: their own, and every one on a computer they are in charge of. */
    list(person: Pick<Person, "id">): FolderRequestView[] {
        const current = this.#options.person(person.id);

        if (current === undefined) {
            return [];
        }

        return [...this.#pending.values()]
            .filter((each) => this.#sees(current, each.view))
            .map((each) => ({ ...each.view }));
    }

    #sees(person: Pick<Person, "id">, request: FolderRequestView): boolean {
        return request.person === person.id || this.#options.inCharge(person, request.computer);
    }

    /**
     * Wait for an approval of `question` for `person`. Resolves with who approved it and how; rejects when it is denied,
     * withdrawn (also by `signal`), or too old. `code`: the requester may answer with their own code (false for someone
     * who may not renew this session themselves: only who is in charge can).
     */
    async ask(
        person: Pick<Person, "id">,
        question: FolderQuestion,
        signal?: AbortSignal,
        code = true,
    ): Promise<FolderAnswer> {
        const current = this.#options.person(person.id);

        if (current === undefined) {
            throw new HttpError(403, "You are not on this server.");
        }

        if (signal?.aborted === true) {
            throw new HttpError(409, "Cancelled.");
        }

        // One standing request per person and session: asking again waits on it too.
        const request =
            (question.session === undefined
                ? undefined
                : [...this.#pending.values()].find(
                      (each) =>
                          each.view.person === current.id && each.view.session === question.session,
                  )) ?? this.#open(current, question, code);

        return new Promise<FolderAnswer>((resolve, reject) => {
            // This caller gives up: only its own wait ends, and the request with its last one.
            const abort = () => {
                request.waiters.delete(waiter);
                reject(new HttpError(409, "Cancelled."));

                if (request.waiters.size === 0) {
                    this.#settle(request, new HttpError(409, "Cancelled."));
                }
            };

            const waiter: Waiter = {
                resolve: (answer) => {
                    signal?.removeEventListener("abort", abort);
                    resolve(answer);
                },
                reject: (error) => {
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                },
            };

            request.waiters.add(waiter);
            signal?.addEventListener("abort", abort, { once: true });
        });
    }

    /** A new request of `person`: it stands until it is answered, too old, or its last waiter gives up. */
    #open(person: Person & { name: string }, question: FolderQuestion, code: boolean): Pending {
        const view: FolderRequestView = {
            ...question,
            id: randomUUID(),
            person: person.id,
            name: person.name,
            code: code && this.#options.hasCode(person.id),
            expiresAt: this.#now() + FOLDER_REQUEST_MS,
        };
        const request: Pending = {
            view,
            waiters: new Set(),
            timer: setTimeout(
                () =>
                    this.#settle(
                        request,
                        new HttpError(
                            409,
                            view.code
                                ? "Nobody approved it in time. Try again, and enter a code from your authenticator."
                                : `Nobody approved it in time. Ask whoever is in charge of ${question.computerName} to allow it.`,
                        ),
                    ),
                FOLDER_REQUEST_MS,
            ),
        };

        request.timer.unref?.();
        this.#pending.set(view.id, request);
        this.#options.changed();
        this.#options.asked({ ...view });

        return request;
    }

    /** End `request` with `outcome` for everyone waiting on it. One that already ended stays as it ended. */
    #settle(request: Pending, outcome: FolderAnswer | Error): void {
        if (this.#pending.get(request.view.id) !== request) {
            return;
        }

        this.#pending.delete(request.view.id);
        clearTimeout(request.timer);

        for (const waiter of [...request.waiters]) {
            if (outcome instanceof Error) {
                waiter.reject(outcome);
            } else {
                waiter.resolve(outcome);
            }
        }

        request.waiters.clear();
        this.#options.changed();
    }

    /**
     * Session `session`'s approval was renewed (`answer`: by whom, and how): everyone waiting to renew it goes on, also
     * those whose own request nobody answered. The approval is the session's, not a person's.
     */
    renewed(session: string, answer: FolderAnswer): void {
        for (const request of [...this.#pending.values()]) {
            if (request.view.kind === "renew" && request.view.session === session) {
                this.#settle(request, answer);
            }
        }
    }

    /**
     * `approver` approves request `id` with `proof`: their own code for their own request, or Allow by who is in charge
     * of its computer. Someone who may not see the request learns nothing of it (404).
     */
    async approve(approver: Pick<Person, "id">, id: string, proof: Proof): Promise<void> {
        const request = this.#visible(approver, id);
        const { view } = request;
        const current = this.#options.person(approver.id)!;
        const requester = this.#options.person(view.person);

        if (requester === undefined) {
            this.#settle(request, new HttpError(403, "You are not on this server."));

            return;
        }

        if (proof.method === "totp" && !view.code) {
            throw new HttpError(
                403,
                `Only whoever is in charge of ${view.computerName} can renew this session.`,
            );
        }

        const method = await this.#options.methods.verify(
            current,
            requester,
            proof,
            this.#options.inCharge(current, view.computer),
        );

        // Answered by someone else while the code was checked: nothing more to do (`#settle`).
        this.#settle(request, { method, by: current.id });
    }

    /** Who is in charge denies request `id`; its requester withdraws it. */
    deny(person: Pick<Person, "id">, id: string): void {
        const request = this.#visible(person, id);
        const mine = person.id === request.view.person;

        this.#settle(
            request,
            new HttpError(
                mine ? 409 : 403,
                mine
                    ? "Cancelled."
                    : request.view.kind === "renew"
                      ? "It was not renewed."
                      : "This folder was not allowed.",
            ),
        );
    }

    /** End the requests `keep` refuses (a person removed, no longer chosen, or no longer given the folder). */
    prune(keep: (request: FolderRequestView) => boolean): void {
        for (const request of [...this.#pending.values()]) {
            if (!keep(request.view)) {
                this.#settle(request, new HttpError(403, "You can no longer work there."));
            }
        }
    }

    #visible(person: Pick<Person, "id">, id: string): Pending {
        const current = this.#options.person(person.id);
        const request = this.#pending.get(id);

        if (current === undefined || request === undefined || !this.#sees(current, request.view)) {
            throw new HttpError(
                404,
                "That request is gone: it was answered, cancelled, or too old.",
            );
        }

        return request;
    }
}
