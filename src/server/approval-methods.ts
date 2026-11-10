/**
 * How a session's approval is proven (`folder-approvals.ts`): the methods, and the check of each one's proof. All proofs
 * are checked here, on the server; a linked runner only runs what the server sends it, so a new method (passkeys,
 * later) is one more entry in `ApprovalMethods`, with no change to the policy (`access.ts`) or to runners.
 *
 * - `totp`: the person's own authenticator code, from the app they linked to their account (`Authenticators`).
 * - `owner`: who is in charge of the computer (the owner here, a runner's linker there), signed in, allows it from the
 *   app. No code: they are in charge.
 */
import { authenticatorLink, checkCode, newSecret, type TotpState } from "./totp.ts";
import type { Person } from "./access.ts";
import { HttpError } from "./errors.ts";

/** A proof that someone approves a request. */
export type Proof = { method: "totp"; code: string } | { method: "owner" };

export type MethodId = Proof["method"];

/** One way to approve: whether `approver`, with `proof`, approves a request made by `requester`. */
export interface ApprovalMethod<P extends Proof = Proof> {
    readonly id: P["method"];
    verify(approver: Person, requester: Person, proof: P, inCharge: boolean): Promise<boolean>;
    /** The error for a refused proof: why, and what to do (a lockout says when to try again). */
    refusal(approver: Person): HttpError;
}

/** A person's linked authenticator, as stored with their account. Its secret never leaves the server. */
export type StoredAuthenticator = TotpState & {
    /** When it was linked; absent until its first code confirms the link. */
    confirmedAt?: number;
};

/** Where each person's authenticator is kept (their account in `config.ts`; a map in tests). */
export interface AuthenticatorStore {
    get(person: string): StoredAuthenticator | undefined;
    /** Save it, also after a wrong code (failures and lockouts count), or remove it with undefined. */
    set(person: string, authenticator: StoredAuthenticator | undefined): void;
}

/** A new lockout of a person's codes: until when, and which one within a day (`LOCK_STEPS_MS`). */
export type Lockout = { person: string; until: number; count: number };

export type AuthenticatorOptions = {
    now?: () => number;
    /** Too many wrong codes just locked `person`'s codes out: the app tells the owner. */
    locked?: (lockout: Lockout) => void;
};

/** Each person links their own authenticator app to their account, and approves with its codes. */
export class Authenticators {
    readonly #store: AuthenticatorStore;
    readonly #now: () => number;
    readonly #locked: (lockout: Lockout) => void;

    constructor(store: AuthenticatorStore, options: AuthenticatorOptions = {}) {
        this.#store = store;
        this.#now = options.now ?? (() => Date.now());
        this.#locked = options.locked ?? (() => {});
    }

    /** Until when `person`'s codes are refused after too many wrong ones; undefined when they are not. */
    lockedUntil(person: string): number | undefined {
        const until = this.#store.get(person)?.lockedUntil;

        return until !== undefined && until > this.#now() ? until : undefined;
    }

    /**
     * Check `code` against a copy of `state`, save the result (wrong codes and lockouts count), and report a new
     * lockout. The refusal names when codes work again, so a locked-out person knows to wait.
     */
    #checkSaved(
        person: string,
        state: StoredAuthenticator,
        code: string,
        save: (state: StoredAuthenticator, valid: boolean) => StoredAuthenticator,
    ): boolean {
        const copy = structuredClone(state);
        const valid = checkCode(copy, code, this.#now());

        this.#store.set(person, save(copy, valid));

        if (copy.lockedUntil !== undefined && copy.lockedUntil !== state.lockedUntil) {
            this.#locked({ person, until: copy.lockedUntil, count: copy.lockouts?.length ?? 1 });
        }

        return valid;
    }

    /** The error for a refused code: wrong or used, or locked out until a time. */
    refusal(person: string): HttpError {
        const until = this.lockedUntil(person);

        if (until === undefined) {
            return new HttpError(400, "That code is wrong or used. Try the next one.");
        }

        const minutes = Math.ceil((until - this.#now()) / 60_000);

        return new HttpError(
            429,
            `Too many wrong codes. Try again in ${String(minutes)} minute${minutes === 1 ? "" : "s"}.`,
        );
    }

    /** Whether `person` has a linked authenticator. */
    linked(person: string): boolean {
        return this.#store.get(person)?.confirmedAt !== undefined;
    }

    /**
     * Start linking a new authenticator for `person`, replacing one not yet confirmed. A confirmed one must be removed
     * first (with one of its codes), so nobody can swap in their own authenticator for someone else's.
     */
    begin(person: string, name: string): { secret: string; link: string } {
        const current = this.#store.get(person);

        if (current?.confirmedAt !== undefined) {
            throw new HttpError(409, "Remove your authenticator first, then link a new one.");
        }

        const secret = newSecret();

        this.#store.set(person, { secret });

        return { secret, link: authenticatorLink(secret, name) };
    }

    /** Confirm the authenticator `begin` made with its first code. */
    confirm(person: string, code: string): void {
        const current = this.#store.get(person);

        if (current === undefined || current.confirmedAt !== undefined) {
            throw new HttpError(409, "Start linking an authenticator first.");
        }

        const valid = this.#checkSaved(person, current, code, (state, ok) =>
            ok ? { ...state, confirmedAt: this.#now() } : state,
        );

        if (!valid) {
            throw this.refusal(person);
        }
    }

    /** Remove `person`'s authenticator: they need a code to remove it, as to approve. The owner removes anyone's. */
    remove(person: string, by: Person, code?: string): void {
        if (by.role !== "owner" || by.id === person) {
            if (this.linked(person) && (code === undefined || !this.check(person, code))) {
                throw this.refusal(person);
            }
        }

        this.#store.set(person, undefined);
    }

    /** Check a code of `person`'s linked authenticator; each code works once. */
    check(person: string, code: string): boolean {
        const current = this.#store.get(person);

        if (current?.confirmedAt === undefined) {
            return false;
        }

        return this.#checkSaved(person, current, code, (state) => state);
    }
}

export class ApprovalMethods {
    readonly #methods = new Map<MethodId, ApprovalMethod>();

    constructor(authenticators: Authenticators) {
        this.#add<Extract<Proof, { method: "totp" }>>({
            id: "totp",
            // A person approves their own request with their own code; no one else's code counts for them.
            verify: (approver, requester, proof) =>
                Promise.resolve(
                    approver.id === requester.id &&
                        typeof proof.code === "string" &&
                        authenticators.check(approver.id, proof.code),
                ),
            refusal: (approver) => authenticators.refusal(approver.id),
        });
        // Allow in the app: who is in charge of the request's computer (the owner here, a runner's linker there).
        this.#add({
            id: "owner",
            verify: (_approver, _requester, _proof, inCharge) => Promise.resolve(inCharge),
            refusal: () =>
                new HttpError(403, "Only who is in charge of this computer can allow this."),
        });
    }

    #add<P extends Proof>(method: ApprovalMethod<P>): void {
        this.#methods.set(method.id, method as unknown as ApprovalMethod);
    }

    /**
     * Throws unless `approver` approves `requester`'s request with `proof`; returns the method that approved it.
     * `inCharge`: the approver is in charge of the request's computer.
     */
    async verify(
        approver: Person,
        requester: Person,
        proof: Proof,
        inCharge = false,
    ): Promise<MethodId> {
        const method = this.#methods.get(proof.method);

        if (method === undefined) {
            throw new HttpError(400, "Unknown approval method.");
        }

        if (!(await method.verify(approver, requester, proof, inCharge))) {
            throw method.refusal(approver);
        }

        return method.id;
    }
}
