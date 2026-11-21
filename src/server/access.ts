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
import {
    canHold,
    comesWith,
    declared,
    holds,
    type ComputerRight,
    type PersonRight,
    type RightKey,
} from "./rights.ts";
import type { WebAccess } from "./host.ts";

/** The id of this server's own computer record, as `SessionMeta.runner` is absent for its sessions. */
export const THIS_SERVER = "this-server";

/** What a person who uses a blocked computer is told (`AccessPolicy.blocked`). */
export const BLOCKED =
    "This computer is blocked: the person who linked it is a viewer now. It works again when they are made a user.";

/**
 * A person as the policy needs them. `rights`: what they were given beyond their role, each declared in `rights.ts`
 * (to link computers of their own, invite people, manage people, keep sessions warm). `paused`: they were a user
 * until their authenticator was removed, and are one again when they link one (`config.ts` `User.paused`).
 */
export type Person = {
    id: string;
    role: Role;
    sessions?: readonly string[];
    rights?: readonly PersonRight[];
    paused?: object;
};

/** A computer: this server, or a linked runner. */
export type Computer = {
    id: string;
    /**
     * Who is in charge of it: for this server, the owner; for a runner, who linked it. They choose its people, give
     * them folders, see every session on it, and are never asked for an approval there.
     */
    linker: string;
    /** The people the one in charge chose: they may use it. Viewers among them only see. */
    chosen: readonly string[];
    /**
     * The people no longer chosen whose shares and sessions here are not taken back yet. No share here counts for them
     * (`#sharedWith`): being dropped ends their shares at once, before the saves that remove them, and whatever cuts
     * those saves short.
     */
    leaving: readonly string[];
    /** The folders the one in charge gave `person` here (real paths); each covers the folders in it. */
    given(person: string): readonly string[];
    /** Of those, the folders in which `person` sees every session, whoever started it (`seesFolder`). */
    sees(person: string): readonly string[];
    /**
     * The chosen people the one in charge gave `right` here (`rights.ts`): to take the wheel from a driver
     * (`overridesTurns`), or to allow a call their own message led to (`allowsOwn`).
     */
    holders(right: ComputerRight): readonly string[];
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
    /**
     * The folder its access is judged by, a real path on its computer: its own, or the folder its git worktree came
     * from. Absent: in no folder anyone was given.
     */
    folder?: string;
};

export interface AccessFacts {
    /** The owner's id. */
    readonly ownerId: string;
    /** The current record of a person; undefined once removed. */
    person(id: string): Person | undefined;
    computer(id: string): Computer | undefined;
    /** The id of every computer: `THIS_SERVER`, then each linked runner. */
    computers(): readonly string[];
    /** The facts of the top session of `id`, whichever session of its tree `id` names. */
    session(id: string): SessionFacts | undefined;
    /** Whether session `id`'s approval (`folder-approvals.ts`) is live: someone used it within their approval time. */
    approved(id: string): boolean;
}

/** May this person work in this folder: at once, after an approval, or not at all. */
export type FolderDecision =
    { kind: "allow" } | { kind: "ask" } | { kind: "refuse"; reason: string };

/**
 * Whether `folder` is `given` or inside it, by the path rules of the computer the two are on. Both are real paths
 * there, so `given` tells which rules: one that starts with `/` is on Linux or macOS, where `\` is a character of a
 * name like any other and only `/` parts folders; any other (`C:\work`, `\\host\share`) is on Windows, where both
 * do. So `/a/proj` does not hold the folder beside it that is named `proj\x`.
 */
export function inFolder(folder: string, given: string): boolean {
    const windows = !given.startsWith("/");
    const base = given.replace(windows ? /[\\/]+$/ : /\/+$/, "");

    return (
        folder === given ||
        base === "" ||
        folder === base ||
        folder.startsWith(`${base}/`) ||
        (windows && folder.startsWith(`${base}\\`))
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
     * Is `person` in charge of computer `id`: the owner of this server, the linker of a runner. On a runner someone else
     * linked, the owner is no one special: they use it only if its linker chose them. A linker made a viewer is in
     * charge of nothing: their runner is blocked (`blocked`) until they prompt again, and then nobody is in charge of it.
     */
    inCharge(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const computer = this.#facts.computer(id);

        if (current === undefined || computer === undefined || current.sessions !== undefined) {
            return false;
        }

        return id === THIS_SERVER
            ? current.role === "owner"
            : computer.linker === current.id && current.role !== "viewer";
    }

    /**
     * Is computer `id` blocked: a runner whose linker was made a viewer. Nothing starts or runs there, and nobody
     * changes its people, folders, or settings, or allows anything on it; the owner still lists it, and unlinks it.
     * Its people keep seeing what they saw, its linker the sessions they started. A rule, not a record: it ends when
     * its linker prompts again.
     */
    blocked(id: string): boolean {
        const computer = id === THIS_SERVER ? undefined : this.#facts.computer(id);

        return computer !== undefined && this.#facts.person(computer.linker)?.role === "viewer";
    }

    /**
     * May `person` use computer `id`: see it and the sessions on it they may see. Who is in charge of it, and the people
     * they chose. A person invited to one session uses no computer: they see that session only. A runner's linker uses
     * it also as a viewer, when they are no longer in charge of it: they still see the sessions they started there.
     */
    mayUse(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const computer = this.#facts.computer(id);

        if (current === undefined || computer === undefined) {
            return false;
        }

        return (
            this.inCharge(current, id) ||
            (current.sessions === undefined &&
                (computer.chosen.includes(current.id) || computer.linker === current.id))
        );
    }

    /**
     * Does `person` prompt on computer `id`: they may use it, and are no viewer. What they have there (their folders,
     * the sessions they see by a folder) follows this, also while the computer is blocked, so a block takes nothing
     * from anyone.
     */
    #promptsHere(person: Pick<Person, "id">, id: string): boolean {
        return this.mayUse(person, id) && this.#current(person)?.role !== "viewer";
    }

    /**
     * May `person` start sessions on computer `id`, and may a session they started run there: they prompt there, and
     * the computer is not blocked.
     */
    mayStart(person: Pick<Person, "id">, id: string): boolean {
        return this.#promptsHere(person, id) && !this.blocked(id);
    }

    /**
     * Does `person` hold `right`: the one check for every right given one person at a time (`rights.ts`). The methods
     * that name a right (`mayLink`, `managesPeople`, `invites`, `keepsWarm`, `overridesTurns`, `allowsOwn`) ask here.
     *
     * A person's right, held everywhere: the owner has them all; a user has one they were given, or one that comes
     * with another they hold, while they can hold it at all (`rights.ts` `holds`).
     *
     * A computer's right, held on computer `computer`: who is in charge of it has them all; else someone chosen there
     * who prompts (not a viewer, not held to one session) and was given it.
     */
    has(person: Pick<Person, "id">, right: PersonRight): boolean;
    has(person: Pick<Person, "id">, right: ComputerRight, computer: string): boolean;
    has(person: Pick<Person, "id">, right: RightKey, computer?: string): boolean {
        if (declared(right).scope === "person") {
            const current = this.#current(person);

            return current !== undefined && holds(current, right as PersonRight);
        }

        if (computer === undefined) {
            return false;
        }

        if (this.inCharge(person, computer)) {
            return true;
        }

        const current = this.#current(person);
        const there = this.#facts.computer(computer);

        return (
            current !== undefined &&
            there !== undefined &&
            current.role !== "viewer" &&
            current.sessions === undefined &&
            there.chosen.includes(current.id) &&
            there.holders(right as ComputerRight).includes(current.id)
        );
    }

    /**
     * What `by` may do with `target`'s right `right`: the one rule for giving a person's right, asked for its switch
     * (`app.ts` `people`) and by the setter (`setRight`), so that the app holds no rule of its own. Undefined: it is
     * not theirs to change (`mayManagePerson`; a right only the owner gives), or `target` cannot hold it: no switch.
     * "with": `target` has it with another right, so it stays on. "lacking": `by` lacks it themselves, and gives only
     * what they have, else a second account of theirs would get more than they have: they take it back, and do not
     * turn it on. "open": theirs to turn on and off.
     */
    offer(
        by: Pick<Person, "id">,
        target: Pick<Person, "id">,
        right: PersonRight,
    ): "open" | "lacking" | "with" | undefined {
        const current = this.#current(by);
        const other = this.#current(target);

        if (
            current === undefined ||
            other === undefined ||
            !this.mayManagePerson(current, other) ||
            (declared(right).gives === "owner" && current.role !== "owner") ||
            !canHold(other, right)
        ) {
            return undefined;
        }

        if (comesWith(right).some((each) => holds(other, each))) {
            return "with";
        }

        return current.role === "owner" ||
            other.rights?.includes(right) === true ||
            holds(current, right)
            ? "open"
            : "lacking";
    }

    /**
     * May `person` take the wheel from someone who is driving a session on computer `id`, hand it over for them, or turn
     * take turns off under them: who is in charge of it, and the users they let. Whether they may change that session at
     * all is `maySteer`.
     */
    overridesTurns(person: Pick<Person, "id">, id: string): boolean {
        return this.has(person, "wheel", id);
    }

    /**
     * May `person` allow a call their own message led to on computer `id` while approvals need someone else: who is in
     * charge of it, and the users they let. A call nobody is known to have asked for stays with who is in charge.
     */
    allowsOwn(person: Pick<Person, "id">, id: string): boolean {
        return this.has(person, "allows", id);
    }

    /** May `person` change computer `id`'s settings, choose its people, and give them folders: who is in charge of it. */
    mayManage(person: Pick<Person, "id">, id: string): boolean {
        return this.inCharge(person, id);
    }

    /** May `person` unlink runner `id`: its linker, and the owner, who decides what links to this server. */
    mayUnlink(person: Pick<Person, "id">, id: string): boolean {
        return (
            id !== THIS_SERVER &&
            (this.#current(person)?.role === "owner" || this.inCharge(person, id))
        );
    }

    /** May `person` link computers of their own: the owner, and the guests the owner lets. */
    mayLink(person: Pick<Person, "id">): boolean {
        return this.has(person, "linksRunners");
    }

    /**
     * Does `person` manage people: the owner, and the users the owner lets (`managesUsers`). Never a viewer, and never
     * someone invited to one session. They see on a person's page what the owner sees.
     */
    managesPeople(person: Pick<Person, "id">): boolean {
        return this.has(person, "managesUsers");
    }

    /**
     * Does `person` manage runners: the owner, and the users the owner lets (`managesRunners`). They are in charge of
     * this server and of the runners the owner linked, as the owner is (`inCharge`), and unlink any runner
     * (`mayUnlink`).
     */
    managesRunners(person: Pick<Person, "id">): boolean {
        return this.has(person, "managesRunners");
    }

    /**
     * Does `person` manage this server: the owner, and the users the owner lets (`managesServer`). They change its
     * settings (extensions, providers, models, themes, spend limits, memory lessons) and restart it. Not the owner's
     * account, or anyone's PiP.
     */
    managesServer(person: Pick<Person, "id">): boolean {
        return this.has(person, "managesServer");
    }

    /**
     * May `by` change what `target` may do, or remove them. Nobody changes the owner. The owner changes everyone else.
     * A user who manages people changes nobody who manages people, which they do themselves: only the owner does, so
     * that nobody raises their own rights or takes another manager's away.
     */
    mayManagePerson(by: Pick<Person, "id">, target: Pick<Person, "id">): boolean {
        const current = this.#current(by);
        const other = this.#current(target);

        if (current === undefined || other === undefined || other.role === "owner") {
            return false;
        }

        return (
            current.role === "owner" || (this.managesPeople(current) && !this.managesPeople(other))
        );
    }

    /**
     * May `by` make a sign-in link that signs a device in as `target`, someone else (`auth.ts` `createDeviceLink`): it
     * gives whoever opens it all that `target` has. The owner, for anyone. Who manages people, only for a viewer they
     * may change, who makes no such link themselves: never for a user, whose sessions and computers are their own, and
     * so not for a paused one, who is a user again once they link an authenticator.
     */
    maySignInAs(by: Pick<Person, "id">, target: Pick<Person, "id">): boolean {
        const current = this.#current(by);
        const other = this.#current(target);

        if (current === undefined || other === undefined) {
            return false;
        }

        return (
            current.role === "owner" ||
            (this.mayManagePerson(current, other) &&
                other.role === "viewer" &&
                other.paused === undefined)
        );
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
     * May `person` turn keep warm on for a session, or pick its time: the owner always, and the guests the owner lets,
     * since a refresh may be charged. Turning it off needs none of this; whether they may change that session at all
     * is `maySteer`.
     */
    keepsWarm(person: Pick<Person, "id">): boolean {
        return this.has(person, "keepsWarm");
    }

    /**
     * Does the owner let `person` invite people at all: the owner always, the guests the owner lets, and who manages
     * people (`managesPeople`), who has it with that. Never someone invited to one session.
     */
    invites(person: Pick<Person, "id">): boolean {
        return this.has(person, "invites");
    }

    /**
     * May `person` invite someone new: only who the owner lets (`invites`), and then to session `session` alone, who
     * may share it (`mayShare`); to their own sessions, or a folder's, who may start sessions on some computer: this
     * server or a runner, their own or one they were chosen for. Not on this server alone: an invite gives only what
     * its maker has (`app.ts` `welcome`: the sessions they started, and a computer only where they are in charge of
     * it), wherever that is. Every invite starts as a viewer (`auth.ts`), so it gives no more. Another device of
     * one's own takes a device link (`auth.ts` `createDeviceLink`), which anyone makes for themselves.
     */
    mayInvite(person: Pick<Person, "id">, session?: string): boolean {
        const current = this.#current(person);

        if (!this.invites(person)) {
            return false;
        }

        if (session !== undefined) {
            return this.mayShare(person, session);
        }

        return (
            current !== undefined &&
            current.sessions === undefined &&
            current.role !== "viewer" &&
            (current.role === "owner" ||
                this.#facts.computers().some((id) => this.mayStart(current, id)))
        );
    }

    /**
     * May `person` start sessions on session `id`'s computer: they may move it to another folder there, switch its
     * branch, and publish it, as they could start one there.
     */
    mayStartThere(person: Pick<Person, "id">, id: string): boolean {
        const facts = this.#facts.session(id);

        return facts !== undefined && this.mayStart(person, facts.computer);
    }

    /**
     * The folders `person` may read on session `id`'s computer besides the session's own folder, in its Files panel,
     * viewer, mentions, attachments, and changes. Undefined: anywhere Pi can, for who is in charge of that computer.
     * Anyone else: the folders given to them there, or none.
     */
    readableFolders(person: Pick<Person, "id">, id: string): readonly string[] | undefined {
        const facts = this.#facts.session(id);

        if (facts === undefined) {
            return [];
        }

        return this.givenFolders(person, facts.computer);
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
     * The folders `person` may work in on computer `id`: those its one in charge gave them there; undefined for who is
     * in charge, who may use every folder. Empty for who does not prompt there: not chosen, or a viewer.
     */
    givenFolders(person: Pick<Person, "id">, id: string): readonly string[] | undefined {
        const current = this.#current(person);

        if (current !== undefined && this.inCharge(current, id)) {
            return undefined;
        }

        return current !== undefined && this.#promptsHere(current, id)
            ? (this.#facts.computer(id)?.given(current.id) ?? [])
            : [];
    }

    /** May `person` work in `folder` on computer `id` (a real path there): who is in charge anywhere, others where given. */
    mayUseFolder(person: Pick<Person, "id">, id: string, folder: string): boolean {
        const given = this.givenFolders(person, id);

        return given === undefined
            ? this.mayStart(person, id)
            : given.some((each) => inFolder(folder, each));
    }

    /**
     * Does `person` see every session in `folder` on computer `id` (a real path there), whoever started it: the one in
     * charge turned that on for a folder given to them that holds it. Only while the folder is theirs to work in, so
     * taking them off the computer, taking the folder back, or making them a viewer ends it at once. Such a session is
     * theirs as one shared with them is: they prompt it too.
     */
    seesFolder(person: Pick<Person, "id">, id: string, folder: string): boolean {
        const current = this.#current(person);

        if (current === undefined) {
            return false;
        }

        const given = this.givenFolders(current, id) ?? [];
        const sees = this.#facts.computer(id)?.sees(current.id) ?? [];

        return sees.some((each) => given.includes(each) && inFolder(folder, each));
    }

    /**
     * May `person` start a new session in `folder` on computer `id` (a real path there). Refused unless they may start
     * sessions there and were given the folder. Who is in charge needs no approval; anyone else proves it is them, with
     * their own code or the Allow of the one in charge, and that approval belongs to the new session.
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
            return { kind: "refuse", reason: this.#folderRefusal(id) };
        }

        return this.inCharge(current, id) ? { kind: "allow" } : { kind: "ask" };
    }

    /**
     * May `person` send to session `id`'s agent now: they steer it (`maySteer`), and the session's approval is live, or
     * they are in charge of its computer (never asked there). "locked": its approval ended; its starter's code or the
     * Allow of the one in charge renews it. Stopping work needs no approval (`maySteer` alone). The lock is the
     * session's, for everyone on it: a person invited to this one session is locked out with the rest.
     */
    steer(person: Pick<Person, "id">, id: string): "allow" | "locked" {
        const current = this.#current(person);
        const facts = this.#facts.session(id);

        if (current === undefined || facts === undefined || !this.maySteer(current, id)) {
            return "locked";
        }

        if (facts.pip !== undefined || this.inCharge(current, facts.computer)) {
            return "allow";
        }

        return this.#facts.approved(facts.id) ? "allow" : "locked";
    }

    /** May `person` renew session `id`'s approval without a code: who is in charge of its computer. */
    mayRenewFree(person: Pick<Person, "id">, id: string): boolean {
        const facts = this.#facts.session(id);

        return facts !== undefined && this.inCharge(person, facts.computer);
    }

    /** May `person` renew session `id`'s approval with their own code: its starter, while they steer it. */
    mayRenewWithCode(person: Pick<Person, "id">, id: string): boolean {
        const facts = this.#facts.session(id);

        return (
            facts !== undefined && this.starter(facts) === person.id && this.maySteer(person, id)
        );
    }

    /**
     * Who is in charge of session `id`'s computer: its runner's linker, or the owner. Of a blocked runner (`blocked`),
     * still its linker, though they decide nothing there until they prompt again.
     */
    inChargeOf(id: string): string {
        const facts = this.#facts.session(id);
        const computer = facts === undefined ? undefined : this.#facts.computer(facts.computer);

        return facts === undefined || facts.computer === THIS_SERVER || computer === undefined
            ? this.#facts.ownerId
            : computer.linker;
    }

    // Sessions.

    /**
     * May `person` see session `id` (any session of its tree). A PiP is its person's alone. Who is in charge of its
     * computer sees every session there. A person invited to one session sees that session. Anyone else sees the ones
     * they started, while they may use that computer, the ones shared with them, and every one in a folder they were
     * given to see all of (`seesFolder`).
     */
    maySee(person: Pick<Person, "id">, id: string): boolean {
        const facts = this.#facts.session(id);

        return facts !== undefined && this.seesWith(person, facts);
    }

    /**
     * `maySee` for a top session as `facts` say it is: the one rule, also for a save that changes a session and asks
     * what follows before the change is stored (`app.ts` `handOver`).
     */
    seesWith(person: Pick<Person, "id">, facts: SessionFacts): boolean {
        const current = this.#current(person);

        if (current === undefined) {
            return false;
        }

        if (facts.pip !== undefined) {
            return facts.pip === current.id;
        }

        if (current.sessions !== undefined) {
            return current.sessions.includes(facts.id);
        }

        if (this.inCharge(current, facts.computer)) {
            return true;
        }

        // A removed computer's sessions run nowhere: their starter and the people they were shared with still see them,
        // to read and archive them. Nobody else: unlinking a computer shows no one its private sessions.
        if (this.#facts.computer(facts.computer) === undefined) {
            return this.starter(facts) === current.id || this.#sharedWith(current, facts);
        }

        return (
            this.#sharedWith(current, facts) ||
            (this.starter(facts) === current.id && this.mayUse(current, facts.computer)) ||
            this.#seesByFolder(current, facts)
        );
    }

    /**
     * Is session `facts` shared with `person`, one at a time. Not while they are leaving its computer
     * (`Computer.leaving`): no longer chosen there, with their shares there not taken back yet.
     */
    #sharedWith(person: Pick<Person, "id">, facts: SessionFacts): boolean {
        return (
            facts.sharedWith?.includes(person.id) === true &&
            this.#facts.computer(facts.computer)?.leaving.includes(person.id) !== true
        );
    }

    /**
     * Does `person` see session `facts` by its folder alone (`seesFolder`). The session's folder is read only for
     * someone who has such a folder on its computer: finding it costs a look at every session there (a worktree).
     */
    #seesByFolder(person: Pick<Person, "id">, facts: SessionFacts): boolean {
        if ((this.#facts.computer(facts.computer)?.sees(person.id) ?? []).length === 0) {
            return false;
        }

        const folder = facts.folder;

        return folder !== undefined && this.seesFolder(person, facts.computer, folder);
    }

    /**
     * Has `person` session `id` by its folder and nothing else: not as its starter, not shared with them, not invited to
     * it. Such a one is taken back with the folder's switch, not alone.
     */
    seesOnlyByFolder(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const facts = this.#facts.session(id);

        return (
            current !== undefined &&
            facts !== undefined &&
            facts.pip === undefined &&
            current.sessions === undefined &&
            this.starter(facts) !== current.id &&
            !this.#sharedWith(current, facts) &&
            !this.inCharge(current, facts.computer) &&
            this.#seesByFolder(current, facts)
        );
    }

    /**
     * May `person` see and manage a task (a webhook, a watch) that `by` made for session `target`: its maker, and who is
     * in charge of the session's computer while they may see it. Never a task on someone's PiP, or on a computer they
     * are not in charge of: its address and secret stay with the people it is for.
     */
    mayManageTask(person: Pick<Person, "id">, by: string, target: string): boolean {
        const current = this.#current(person);

        if (current === undefined) {
            return false;
        }

        if (by === current.id) {
            return true;
        }

        const facts = this.#facts.session(target);

        return (
            facts !== undefined &&
            this.maySee(current, target) &&
            this.inCharge(current, facts.computer)
        );
    }

    /** May `person` steer session `id`: send to its agent, run its tools. They may see it, and are no viewer. */
    maySteer(person: Pick<Person, "id">, id: string): boolean {
        return this.maySee(person, id) && this.#current(person)?.role !== "viewer";
    }

    /**
     * May `person` change whom session `id` is shared with, or invite someone to it alone (an invite shares it too): who
     * is in charge of its computer, and its starter while they may steer it.
     */
    mayShare(person: Pick<Person, "id">, id: string): boolean {
        const current = this.#current(person);
        const facts = this.#facts.session(id);

        if (current === undefined || facts === undefined || facts.pip !== undefined) {
            return false;
        }

        return (
            this.inCharge(current, facts.computer) ||
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
            throw new HttpError(403, "Viewers cannot prompt. Ask to be made a user.");
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
              ? "Viewers cannot start sessions. Ask to be made a user."
              : current !== undefined && this.blocked(id) && this.mayUse(current, id)
                ? BLOCKED
                : id === THIS_SERVER
                  ? "The owner has not chosen you for this server yet."
                  : "The person who linked this computer has not chosen you for it yet.";
    }

    #folderRefusal(id: string): string {
        return id === THIS_SERVER
            ? "The owner has not given you this folder. Ask them to add it for you."
            : "The person who linked this computer has not given you this folder. Ask them to add it for you.";
    }

    /** Refuse `folder` on computer `id` to who may not work in it (`mayUseFolder`). */
    requireFolder(person: Pick<Person, "id">, id: string, folder: string): void {
        this.requireStart(person, id);

        if (!this.mayUseFolder(person, id, folder)) {
            throw new HttpError(403, this.#folderRefusal(id));
        }
    }

    /** Refuse who may not browse computer `id`'s folders (`mayBrowse`): the same people who may start sessions there. */
    requireBrowse(person: Pick<Person, "id">, id: string): void {
        this.requireStart(person, id);
    }

    requireManage(person: Pick<Person, "id">, id: string): void {
        if (!this.mayManage(person, id)) {
            throw new HttpError(
                403,
                id === THIS_SERVER
                    ? "Only the owner can change this server's settings."
                    : "Only the person who linked this computer can change its settings.",
            );
        }
    }

    /** Refuse who does not manage this server (`managesServer`): its settings are the owner's, and theirs. */
    requireManagesServer(person: Pick<Person, "id">): void {
        if (!this.managesServer(person)) {
            throw new HttpError(403, "Only someone who manages the server can do that.");
        }
    }

    requireUnlink(person: Pick<Person, "id">, id: string): void {
        if (!this.mayUnlink(person, id)) {
            throw new HttpError(403, "Only the owner or who linked this computer can remove it.");
        }
    }
}
