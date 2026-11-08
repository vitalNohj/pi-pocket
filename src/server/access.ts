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
    /** Whether a saved folder covers `folder` (a missing or broad saved folder covers nothing). */
    covers(folder: string): Promise<boolean>;
    /** "Stop asking": a saved folder needs no approval. */
    stopAsking: boolean;
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
}

/**
 * May this person start a session in this folder: at once, after an approval, or not at all. An approval of a folder no
 * saved folder covers also saves it (unless it is too broad); `saved` says which question to ask.
 */
export type FolderDecision =
    { kind: "allow" } | { kind: "ask"; saved: boolean } | { kind: "refuse" };

export class AccessPolicy {
    readonly #facts: AccessFacts;

    constructor(facts: AccessFacts) {
        this.#facts = facts;
    }

    /** The current record of `person`, so a stale copy grants nothing it no longer has. */
    #current(person: Pick<Person, "id">): Person | undefined {
        return this.#facts.person(person.id);
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

    // Folders.

    /**
     * May `person` browse folders on computer `id`, to choose one for a new session: whoever may start sessions there.
     * A session's own folder, in its Files panel, follows the session instead (`maySee`, `maySteer`).
     */
    mayBrowse(person: Pick<Person, "id">, id: string): boolean {
        return this.mayStart(person, id);
    }

    /**
     * May `person` start a session in `folder` on computer `id` (a real path there). Refused when they may not start
     * sessions there. The owner needs no approval on this server, which they control. Elsewhere a folder a saved folder
     * covers needs none while "Stop asking" is on; any other folder asks: the person's own code, the owner from the
     * app, or the person at the computer.
     */
    async folder(person: Pick<Person, "id">, id: string, folder: string): Promise<FolderDecision> {
        if (!this.mayStart(person, id)) {
            return { kind: "refuse" };
        }

        if (id === THIS_SERVER && this.#current(person)?.role === "owner") {
            return { kind: "allow" };
        }

        const computer = this.#facts.computer(id)!;
        const saved = await computer.covers(folder);

        return saved && computer.stopAsking ? { kind: "allow" } : { kind: "ask", saved };
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

    requireStart(person: Pick<Person, "id">, id: string): void {
        if (!this.mayStart(person, id)) {
            throw new HttpError(
                403,
                id === THIS_SERVER
                    ? "The owner has not chosen you for this server yet."
                    : "Only the person who linked this computer or the people they chose can start sessions on it.",
            );
        }
    }

    requireManage(person: Pick<Person, "id">, id: string): void {
        if (!this.mayManage(person, id)) {
            throw new HttpError(403, "Only the owner can change this computer's settings.");
        }
    }
}
