/**
 * How a person approves a new folder for a session: the methods, and the check of each one's proof. All proofs are
 * checked here, on the server; a linked runner trusts the result it is sent (`runners.ts`), so a new method (passkeys,
 * later) is one more entry in `ApprovalMethods`, with no change to the policy (`access.ts`) or to runners.
 *
 * - `totp`: the person's own authenticator code, from the app they linked to their account (`Authenticators`).
 * - `owner`: the owner, signed in, approves someone else's request from the app.
 *
 * Without a proof, a runner still asks at the computer, as before.
 */
import { authenticatorLink, checkCode, newSecret, type TotpState } from "../runner/totp.ts";
import type { Person } from "./access.ts";
import { HttpError } from "./errors.ts";

/** A proof that someone approves a request. */
export type Proof = { method: "totp"; code: string } | { method: "owner" };

export type MethodId = Proof["method"];

/** One way to approve: whether `approver`, with `proof`, approves a request made by `requester`. */
export interface ApprovalMethod<P extends Proof = Proof> {
    readonly id: P["method"];
    verify(approver: Person, requester: Person, proof: P): Promise<boolean>;
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

/** Each person links their own authenticator app to their account, and approves with its codes. */
export class Authenticators {
    readonly #store: AuthenticatorStore;
    readonly #now: () => number;

    constructor(store: AuthenticatorStore, now = () => Date.now()) {
        this.#store = store;
        this.#now = now;
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

        const state = structuredClone(current);
        const valid = checkCode(state, code, this.#now());

        this.#store.set(person, valid ? { ...state, confirmedAt: this.#now() } : state);

        if (!valid) {
            throw new HttpError(400, "That code is wrong or used. Try the next one.");
        }
    }

    /** Remove `person`'s authenticator: they need a code to remove it, as to approve. The owner removes anyone's. */
    remove(person: string, by: Person, code?: string): void {
        if (by.role !== "owner" || by.id === person) {
            if (this.linked(person) && (code === undefined || !this.check(person, code))) {
                throw new HttpError(400, "That code is wrong or used. Try the next one.");
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

        const state = structuredClone(current);
        const valid = checkCode(state, code, this.#now());

        this.#store.set(person, state);

        return valid;
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
        });
        this.#add({
            id: "owner",
            verify: (approver) => Promise.resolve(approver.role === "owner"),
        });
    }

    #add<P extends Proof>(method: ApprovalMethod<P>): void {
        this.#methods.set(method.id, method as unknown as ApprovalMethod);
    }

    /** Throws unless `approver` approves `requester`'s request with `proof`; returns the method that approved it. */
    async verify(approver: Person, requester: Person, proof: Proof): Promise<MethodId> {
        const method = this.#methods.get(proof.method);

        if (method === undefined) {
            throw new HttpError(400, "Unknown approval method.");
        }

        if (!(await method.verify(approver, requester, proof))) {
            throw new HttpError(
                proof.method === "owner" ? 403 : 400,
                proof.method === "owner"
                    ? "Only the owner can approve this."
                    : "That code is wrong or used. Try the next one.",
            );
        }

        return method.id;
    }
}
