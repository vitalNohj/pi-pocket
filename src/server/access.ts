/**
 * Who may use which computer, folder, and session in Pi Pocket: one policy for this server and linked runners alike.
 *
 * Every check that lists, opens, starts, or names a session or a folder asks this class. It reads its facts through
 * `AccessFacts`, so the app gives it the current records (a person removed or changed a moment ago counts at once) and
 * the tests give it plain objects.
 *
 * This is access inside Pi Pocket only. Sessions run as the computer's own system user, so an agent's shell commands can
 * read whatever that user can read, on this server as on a runner.
 */
import { HttpError } from "./errors.ts";
import type { Role } from "./config.ts";
import type { WebAccess } from "./host.ts";

/** The id of this server's own computer record, as `SessionMeta.runner` is absent for its sessions. */
export const THIS_SERVER = "this-server";

/** A person as the policy needs them. */
export type Person = { id: string; role: Role; sessions?: readonly string[] };

/** A computer: this server, or a linked runner. */
export type Computer = {
    id: string;
    /** Who linked it; for this server, the owner. Changes its settings and chooses its people. */
    linker: string;
    /** The people the linker chose: they may use it. Viewers among them only see. */
    chosen: readonly string[];
    /** The folders the owner gave `person` here (real paths); each covers the folders in it. The owner needs none. */
    given(person: string): readonly string[];
    /** Share new sessions with its chosen people. Off unless the linker turns it on. */
    shareNew: boolean;
};

/** The facts of a top session (a subagent's are its top session's). */
export type SessionFacts = {
    /** The top session's id. */
    id: string;
    /** The computer it runs on: `THIS_SERVER` or a runner's id. */
    computer: string;
    /** Who started it; absent (older sessions): the owner. */
    createdBy?: string;
    /** People it is shared with, one at a time. */
    sharedWith?: readonly string[];
    /** Set on a PiP: the person it belongs to. */
    pip?: string;
};

export interface AccessFacts {
    /** The owner's id. */
    readonly ownerId: string;
    /** The current record of a person; undefined once removed. */
    person(id: string): Person | undefined;
    computer(id: string): Computer | undefined;
    /** The facts of the top session of `id`, whichever session of its tree `id` names. */
    session(id: string): SessionFacts | undefined;
    /** How many days `person`'s approvals last unused; 0: they are never asked (`config.ts` `approvalDays`). */
    approvalDays(person: string): number;
    /**
     * Whether `person` has a live approval (`folder-approvals.ts`) of `folder` on `computer` (a whole-computer one covers every
     * folder), or of shared session `session`; using it starts its clock again.
     */
    approved(
        person: string,
        target: { computer: string } & ({ folder: string } | { session: string }),
    ): boolean;
}

/**
 * May this person work in this folder: at once, after an approval, or not at all. `whole`: the approval covers the
 * whole computer (the owner, on a runner); else this folder alone.
 */
export type FolderDecision =
    { kind: "allow" } | { kind: "ask"; whole: boolean } | { kind: "refuse"; reason: string };

/** Whether `folder` is `given` or inside it, with either separator (a runner may run Windows). */
export function inFolder(folder: string, given: string): boolean {
    const base = given.replace(/[\\/]+$/, "");

    return (
        folder === given ||
        base === "" ||
        folder === base ||
        folder.startsWith(`${base}/`) ||
        folder.startsWith(`${base}\\`)
    );
}

export class AccessPolicy {
    readonly #facts: AccessFacts;

    constructor(facts: AccessFacts) {
        this.#facts = facts;
    }

    /** The current record of `person`, so a stale copy grants nothing it no longer has. */
    #current(person: Pick<Person, "id">): Person | undefined {
        return this.#facts.person(person.id);
    }

    /** The facts of session `id`'s top session, whichever session of its tree `id` names. */
    session(id: string): SessionFacts | undefined {
        return this.#facts.session(id);
    }

    /** Who started session `facts`: older sessions, with no starter, are the owner's. */
    starter(facts: SessionFacts): string {
        return facts.createdBy ?? this.#facts.ownerId;
    }

    // Computers.

    /**
     * May `person` use computer `id`: see it and the sessions on it they may see. The owner, its linker, and the people
     * the linker chose. A person invited to one session uses no computer: they see that session only.
     */
    mayUse(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const computer = this.#facts.computer(id);

        if (current === undefined || computer === undefined) {
            return false;
        }

        if (current.role === "owner") {
            return true;
        }

        return (
            current.sessions === undefined &&
            (computer.linker === current.id || computer.chosen.includes(current.id))
        );
    }

    /** May `person` start sessions on computer `id`: they may use it, and they steer. */
    mayStart(person: Pick<Person, "id">, id: string): boolean {
        return this.mayUse(person, id) && this.#current(person)?.role !== "viewer";
    }

    /** May `person` change computer `id`'s settings, people, and saved folders: the owner and its linker. */
    mayManage(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const computer = this.#facts.computer(id);

        return (
            current !== undefined &&
            computer !== undefined &&
            (current.role === "owner" ||
                (computer.linker === current.id &&
                    current.role !== "viewer" &&
                    current.sessions === undefined))
        );
    }

    /** Only the owner links computers. */
    mayLink(person: Pick<Person, "id">): boolean {
        return this.#current(person)?.role === "owner";
    }

    /**
     * May `person` use a workspace a provider module opens (a URI, not a folder on a computer): the owner alone, as its
     * provider, not this policy, decides what it reaches.
     */
    mayUseWorkspaces(person: Pick<Person, "id">): boolean {
        return this.#current(person)?.role === "owner";
    }

    /**
     * May `person` use an extension's routes, browser module, or settings open to `access` on this server: the owner
     * always; anyone else must be able to use this server, and then "steer" lets guests in and "view" viewers too. What
     * a module does there is server wide, so a person invited to one session never may (`extension-web.ts` lets the
     * trusted diagrams client through for them alone).
     */
    mayUseExtension(person: Pick<Person, "id">, access: WebAccess): boolean {
        const current = this.#current(person);

        if (current === undefined) {
            return false;
        }

        if (current.role === "owner") {
            return true;
        }

        return (
            this.mayUse(current, THIS_SERVER) &&
            (access === "view" || (access === "steer" && current.role === "guest"))
        );
    }

    /**
     * May `person` invite someone new: to session `session` alone, who may share it (`mayShare`); to this server, who
     * may start sessions on it. A new person starts with no access until the owner chooses them, so this asks no more.
     * An owner invite is the owner's alone; it is a role, not access, and `api.ts` checks it.
     */
    mayInvite(person: Pick<Person, "id">, session?: string): boolean {
        return session === undefined
            ? this.mayStart(person, THIS_SERVER)
            : this.mayShare(person, session);
    }

    /**
     * May `person` read files in session `id`'s computer outside its folder, in its Files panel, mentions, and changes:
     * who may start sessions on that computer reads what Pi can there. Anyone else who sees the session reads its
     * folder only.
     */
    mayReadComputer(person: Pick<Person, "id">, id: string): boolean {
        const facts = this.#facts.session(id);

        return facts !== undefined && this.mayStart(person, facts.computer);
    }

    // Folders.

    /**
     * May `person` browse folders on computer `id`, to choose one for a new session: whoever may start sessions there.
     * A session's own folder, in its Files panel, follows the session instead (`maySee`, `maySteer`).
     */
    mayBrowse(person: Pick<Person, "id">, id: string): boolean {
        return this.mayStart(person, id);
    }

    /**
     * The folders `person` may work in on computer `id`: those the owner gave them there; undefined for the owner, who
     * may use every folder. Empty for who may not start sessions there.
     */
    givenFolders(person: Pick<Person, "id">, id: string): readonly string[] | undefined {
        const current = this.#current(person);

        if (current?.role === "owner") {
            return undefined;
        }

        return current !== undefined && this.mayStart(current, id)
            ? (this.#facts.computer(id)?.given(current.id) ?? [])
            : [];
    }

    /** May `person` work in `folder` on computer `id` at all (a real path there): the owner anywhere, others where given. */
    mayUseFolder(person: Pick<Person, "id">, id: string, folder: string): boolean {
        const given = this.givenFolders(person, id);

        return given === undefined
            ? this.mayStart(person, id)
            : given.some((each) => inFolder(folder, each));
    }

    /**
     * May `person` start a session in `folder` on computer `id` (a real path there), or copy or move one there.
     * Refused unless they may start sessions there and the owner gave them the folder (or one it is in). The owner needs
     * no approval on this server, which they control, and a person whose approval time is "never" needs none. Anyone
     * else needs a live approval: of this folder, or for the owner on a runner of the whole computer.
     */
    folder(person: Pick<Person, "id">, id: string, folder: string): FolderDecision {
        const current = this.#current(person);

        if (current === undefined || !this.mayStart(current, id)) {
            return {
                kind: "refuse",
                reason: this.#startRefusal(current, id),
            };
        }

        if (!this.mayUseFolder(current, id, folder)) {
            return {
                kind: "refuse",
                reason: "The owner has not given you this folder. Ask them to add it for you.",
            };
        }

        const owner = current.role === "owner";

        if ((owner && id === THIS_SERVER) || this.#facts.approvalDays(current.id) === 0) {
            return { kind: "allow" };
        }

        return this.#facts.approved(current.id, { computer: id, folder })
            ? { kind: "allow" }
            : { kind: "ask", whole: owner };
    }

    /**
     * May `person` send to session `id`'s agent now: they steer it (`maySteer`), and their approval for it is live. Their
     * own session needs a live approval of its folder (what started it); a session shared with them, of that session (an
     * approval the share made, or a later code). The owner is never asked on this server; on a runner, their approval of
     * the computer counts. Viewers never send. "ask": a code would let them.
     */
    steer(person: Pick<Person, "id">, id: string, folder: string): "allow" | "ask" {
        const current = this.#current(person);
        const facts = this.#facts.session(id);

        if (current === undefined || facts === undefined || !this.maySteer(current, id)) {
            return "ask";
        }

        if (
            facts.pip !== undefined ||
            (current.role === "owner" && facts.computer === THIS_SERVER) ||
            this.#facts.approvalDays(current.id) === 0 ||
            current.sessions !== undefined
        ) {
            return "allow";
        }

        const mine = this.starter(facts) === current.id;

        return this.#facts.approved(
            current.id,
            mine || current.role === "owner"
                ? { computer: facts.computer, folder }
                : { computer: facts.computer, session: facts.id },
        )
            ? "allow"
            : "ask";
    }

    // Sessions.

    /**
     * May `person` see session `id` (any session of its tree). A PiP is its person's alone. The owner sees every other
     * session. A person invited to one session sees that session. Anyone else must be able to use its computer, and
     * have started it or have it shared with them.
     */
    maySee(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const facts = this.#facts.session(id);

        if (current === undefined || facts === undefined) {
            return false;
        }

        if (facts.pip !== undefined) {
            return facts.pip === current.id;
        }

        if (current.role === "owner") {
            return true;
        }

        if (current.sessions !== undefined) {
            return current.sessions.includes(facts.id);
        }

        return (
            this.mayUse(current, facts.computer) &&
            (this.starter(facts) === current.id || facts.sharedWith?.includes(current.id) === true)
        );
    }

    /** May `person` steer session `id`: send to its agent, run its tools. They may see it, and are no viewer. */
    maySteer(person: Pick<Person, "id">, id: string): boolean {
        return this.maySee(person, id) && this.#current(person)?.role !== "viewer";
    }

    /**
     * May `person` change whom session `id` is shared with, or invite someone to it alone (an invite shares it too): the
     * owner, and its starter while they may steer it.
     */
    mayShare(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const facts = this.#facts.session(id);

        if (current === undefined || facts === undefined || facts.pip !== undefined) {
            return false;
        }

        return (
            current.role === "owner" ||
            (this.starter(facts) === current.id && this.maySteer(current, id))
        );
    }

    /**
     * Whom a new session on computer `id` that `starter` starts is shared with: no one, unless the computer shares new
     * sessions with its chosen people.
     */
    initialShares(id: string, starter: string): string[] {
        const computer = this.#facts.computer(id);

        return computer?.shareNew === true
            ? computer.chosen.filter((each) => each !== starter)
            : [];
    }

    // The same checks, as errors for the HTTP and command handlers.

    requireSee(person: Pick<Person, "id">, id: string): void {
        if (!this.maySee(person, id)) {
            throw new HttpError(404, "This session is not shared with you.");
        }
    }

    requireSteer(person: Pick<Person, "id">, id: string): void {
        this.requireSee(person, id);

        if (!this.maySteer(person, id)) {
            throw new HttpError(
                403,
                "You can view this session but not steer Pi. Ask the owner for steering rights.",
            );
        }
    }

    /** Refuse who may not start sessions on computer `id` (`mayStart`), which also covers browsing its folders. */
    requireStart(person: Pick<Person, "id">, id: string): void {
        if (this.mayStart(person, id)) {
            return;
        }

        throw new HttpError(403, this.#startRefusal(this.#current(person), id));
    }

    #startRefusal(current: Person | undefined, id: string): string {
        return current?.sessions !== undefined
            ? "You were invited to one session and cannot start new ones."
            : current?.role === "viewer" && this.mayUse(current, id)
              ? "You can view sessions but not start them. Ask the owner for steering rights."
              : id === THIS_SERVER
                ? "The owner has not chosen you for this server yet."
                : "The owner has not chosen you for this computer yet.";
    }

    /** Refuse `folder` on computer `id` to who may not work in it (`mayUseFolder`). */
    requireFolder(person: Pick<Person, "id">, id: string, folder: string): void {
        this.requireStart(person, id);

        if (!this.mayUseFolder(person, id, folder)) {
            throw new HttpError(
                403,
                "The owner has not given you this folder. Ask them to add it for you.",
            );
        }
    }

    /** Refuse who may not browse computer `id`'s folders (`mayBrowse`): the same people who may start sessions there. */
    requireBrowse(person: Pick<Person, "id">, id: string): void {
        this.requireStart(person, id);
    }

    requireManage(person: Pick<Person, "id">, id: string): void {
        if (!this.mayManage(person, id)) {
            throw new HttpError(403, "Only the owner can change this computer's settings.");
        }
    }
}
