/**
 * Requests for a session's approval (`folder-approvals.ts`): a person who wants to start a session on a computer they are
 * not in charge of, or to renew a locked session's approval, waits here until it is approved, denied, withdrawn, or too
 * old. Two ways approve one (`approval-methods.ts`): the requester's own authenticator code, or Allow in the app by who
 * is in charge of the computer (the owner here, a runner's linker there). The caller keeps the approval that answers it.
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
            .filter((each) => this.#sees(current, each))
            .map(({ resolve: _resolve, reject: _reject, ...view }) => view);
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

        signal?.throwIfAborted();

        // One standing request per person and session: asking again joins it.
        const standing =
            question.session === undefined
                ? undefined
                : [...this.#pending.values()].find(
                      (each) => each.person === current.id && each.session === question.session,
                  );

        if (standing !== undefined) {
            return new Promise<FolderAnswer>((resolve, reject) => {
                const { resolve: first, reject: firstReject } = standing;

                standing.resolve = (answer) => {
                    first(answer);
                    resolve(answer);
                };

                standing.reject = (error) => {
                    firstReject(error);
                    reject(error);
                };
            });
        }

        const id = randomUUID();
        let timer: NodeJS.Timeout | undefined;
        let abort: (() => void) | undefined;

        return new Promise<FolderAnswer>((resolve, reject) => {
            const request: Pending = {
                ...question,
                id,
                person: current.id,
                name: current.name,
                code: code && this.#options.hasCode(current.id),
                expiresAt: this.#now() + FOLDER_REQUEST_MS,
                resolve,
                reject,
            };

            this.#pending.set(id, request);
            timer = setTimeout(
                () =>
                    request.reject(
                        new HttpError(
                            409,
                            request.code
                                ? "Nobody approved it in time. Try again, and enter a code from your authenticator."
                                : `Nobody approved it in time. Ask whoever is in charge of ${question.computerName} to allow it.`,
                        ),
                    ),
                FOLDER_REQUEST_MS,
            );
            timer.unref?.();
            abort = () => request.reject(new HttpError(409, "Cancelled."));
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
     * `approver` approves request `id` with `proof`: their own code for their own request, or Allow by who is in charge
     * of its computer. Someone who may not see the request learns nothing of it (404).
     */
    async approve(approver: Pick<Person, "id">, id: string, proof: Proof): Promise<void> {
        const request = this.#visible(approver, id);
        const current = this.#options.person(approver.id)!;
        const requester = this.#options.person(request.person);

        if (requester === undefined) {
            request.reject(new HttpError(403, "You are not on this server."));

            return;
        }

        if (proof.method === "totp" && !request.code) {
            throw new HttpError(
                403,
                `Only whoever is in charge of ${request.computerName} can renew this session.`,
            );
        }

        const method = await this.#options.methods.verify(
            current,
            requester,
            proof,
            this.#options.inCharge(current, request.computer),
        );

        // Answered by someone else while the code was checked: nothing more to do.
        this.#pending.get(id)?.resolve({ method, by: current.id });
    }

    /** Who is in charge denies request `id`; its requester withdraws it. */
    deny(person: Pick<Person, "id">, id: string): void {
        const request = this.#visible(person, id);
        const mine = person.id === request.person;

        request.reject(
            new HttpError(
                mine ? 409 : 403,
                mine
                    ? "Cancelled."
                    : request.kind === "renew"
                      ? "It was not renewed."
                      : "This folder was not allowed.",
            ),
        );
    }

    /** End the requests `keep` refuses (a person removed, no longer chosen, or no longer given the folder). */
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

        if (current === undefined || request === undefined || !this.#sees(current, request)) {
            throw new HttpError(
                404,
                "That request is gone: it was answered, cancelled, or too old.",
            );
        }

        return request;
    }
}
