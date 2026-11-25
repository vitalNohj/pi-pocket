/**
 * The roles a person has, and the few questions asked of a role by itself. A person's role is compared in four files
 * only: here, `rights.ts` (what a role can hold), `access.ts` (the access policy), and `config.ts` (the record that
 * keeps it). Everything else asks the policy a question named for what it is for (`access.ts` `AccessPolicy`), so a
 * new role is decided in one place. `test/role-boundary.test.ts` holds that line.
 *
 * The functions here are for code with no policy at hand: the record keeper, a default used when no policy is given
 * (`auth.ts`, `runners.ts`, `approval-methods.ts`, `extension-web.ts`), the sign-in pages, and the code that checks a
 * role a page asked for (`app.ts` `setAccess`). They read the record they are given, which may be stale: where it
 * matters, ask the policy, which reads the current one.
 *
 * A role is written in one place: `config.ts` `giveRole`, `pauseUser`, and `resumeUser`, and `addUser` for a new person.
 * No other file names "guest" or "viewer" at all.
 *
 * Data, and the rules read straight from it: this file imports nothing.
 */

/** owner: everything. guest: steers Pi (which can run commands here). viewer: reads, chats, and reacts, never steers. */
export type Role = "owner" | "guest" | "viewer";

/** The roles a person can be given: nobody is made the owner. */
export type GivenRole = Exclude<Role, "owner">;

/**
 * The role every new person starts with, whatever their invite is to: steering comes later, once they link an
 * authenticator, from who manages them (`config.ts` `giveRole`).
 */
export const STARTS_AS: GivenRole = "viewer";

/** Is `value` a role a person can be given. */
export function isGivenRole(value: unknown): value is GivenRole {
    return value === "guest" || value === "viewer";
}

/** Does someone with `role` prompt: steer Pi, and so need an authenticator of their own unless they are the owner. */
export function rolePrompts(role: Role): boolean {
    return role !== "viewer";
}

/** Is this record the owner's. Also asked of what a page sent, which may hold anything. */
export function isOwner(record: { role?: unknown }): boolean {
    return record.role === "owner";
}

/** Does this record prompt: the owner's, or a user's. */
export function prompts(record: { role: Role }): boolean {
    return rolePrompts(record.role);
}

/**
 * What the server says of a person's role to a page, wherever it names a person: the role, for its words and for the
 * modules that read it (`types/pocket.d.ts`), and the answers a page needs, so that it compares no role itself
 * (`web/store.js` `isOwner`, `isViewer`, `isUser`; `test/role-boundary.test.ts` holds that line too). `owner`: this
 * is the owner. `prompts`: they steer Pi; a viewer does not.
 */
export function roleSaid(record: { role: Role }): RoleSaid {
    return {
        role: record.role,
        owner: record.role === "owner",
        prompts: rolePrompts(record.role),
    };
}

/** A person's role as a page is told it (`roleSaid`). */
export type RoleSaid = { role: Role; owner: boolean; prompts: boolean };

/** The owner's record among `people`. */
export function ownerOf<T extends { role: Role }>(people: readonly T[]): T | undefined {
    return people.find((each) => each.role === "owner");
}
