/**
 * The roles a person has, and the few questions asked of a role by itself. A person's role is compared in four files
 * only: here, `rights.ts` (what a role can hold), `access.ts` (the access policy), and `config.ts` (the record that
 * keeps it). Everything else asks the policy a question named for what it is for (`access.ts` `AccessPolicy`), so a
 * new role is decided in one place. `test/role-boundary.test.ts` holds that line.
 *
 * The functions here are for code with no policy at hand: the record keeper, a default used when no policy is given
 * (`auth.ts`, `runners.ts`, `approval-methods.ts`, `extension-web.ts`), the sign-in pages, and the code that changes a
 * role (`app.ts` `setAccess`). They read the record they are given, which may be stale: where it matters, ask the
 * policy, which reads the current one.
 *
 * Data, and the rules read straight from it: this file imports nothing.
 */

/** owner: everything. guest: steers Pi (which can run commands here). viewer: reads, chats, and reacts, never steers. */
export type Role = "owner" | "guest" | "viewer";

/** The roles a person can be given: nobody is made the owner. */
export type GivenRole = Exclude<Role, "owner">;

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

/** The owner's record among `people`. */
export function ownerOf<T extends { role: Role }>(people: readonly T[]): T | undefined {
    return people.find((each) => each.role === "owner");
}
