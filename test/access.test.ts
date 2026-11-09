// The access policy (`access.ts`) and the approval methods (`approval-methods.ts`), rule by rule: for each, a person it
// lets in, and a person it refuses. Plain facts, no app: the check points that use the policy have their own tests.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type AccessFacts,
    AccessPolicy,
    type Computer,
    type Person,
    type SessionFacts,
    THIS_SERVER,
} from "../src/server/access.ts";
import {
    ApprovalMethods,
    Authenticators,
    type Lockout,
    type StoredAuthenticator,
} from "../src/server/approval-methods.ts";
import { HttpError } from "../src/server/errors.ts";
import { STEP_MS, totp } from "../src/runner/totp.ts";

const owner: Person = { id: "owner", role: "owner" };
const guest: Person = { id: "guest", role: "guest" };
const viewer: Person = { id: "viewer", role: "viewer" };
const stranger: Person = { id: "stranger", role: "guest" };
const linker: Person = { id: "linker", role: "guest" };
const invited: Person = { id: "invited", role: "guest", sessions: ["30"] };
const invitedViewer: Person = { id: "invited-viewer", role: "viewer", sessions: ["30"] };

function computer(id: string, patch: Partial<Computer> = {}): Computer {
    return {
        id,
        linker: id === THIS_SERVER ? owner.id : linker.id,
        chosen: [guest.id, viewer.id],
        // The guest was given /given (and what is in it); no one else anything.
        given: (person) => (person === guest.id ? ["/given"] : []),
        shareNew: false,
        ...patch,
    };
}

/** Approvals, as `folder-approvals.ts` keeps them: `person|computer|folder` or `person|computer|session:id`. */
type Approved = Set<string>;

function world(
    computers: Computer[] = [computer(THIS_SERVER), computer("runner")],
    sessions: SessionFacts[] = [
        { id: "10", computer: THIS_SERVER, createdBy: guest.id },
        { id: "11", computer: THIS_SERVER, createdBy: stranger.id, sharedWith: [guest.id] },
        { id: "12", computer: THIS_SERVER },
        { id: "20", computer: "runner", createdBy: guest.id },
        { id: "30", computer: THIS_SERVER, createdBy: owner.id },
        { id: "40", computer: THIS_SERVER, pip: guest.id },
    ],
    people: Person[] = [owner, guest, viewer, stranger, linker, invited, invitedViewer],
    approved: Approved = new Set(),
    days: Record<string, number> = {},
): { policy: AccessPolicy; people: Map<string, Person> } {
    const byId = new Map(people.map((each) => [each.id, each]));
    // Subagents name their top session: 101 is a subagent of 10, 201 of 20.
    const parents = new Map([
        ["101", "10"],
        ["201", "20"],
    ]);
    const facts: AccessFacts = {
        ownerId: owner.id,
        person: (id) => byId.get(id),
        computer: (id) => computers.find((each) => each.id === id),
        session: (id) => sessions.find((each) => each.id === (parents.get(id) ?? id)),
        approvalDays: (person) => days[person] ?? 7,
        approved: (person, target) =>
            "folder" in target
                ? approved.has(`${person}|${target.computer}|${target.folder}`) ||
                  approved.has(`${person}|${target.computer}|*`)
                : approved.has(`${person}|${target.computer}|session:${target.session}`),
    };

    return { policy: new AccessPolicy(facts), people: byId };
}

describe("may this person use this computer", () => {
    it("lets the owner, the linker, and chosen people use a computer", () => {
        const { policy } = world();

        for (const id of [THIS_SERVER, "runner"]) {
            assert.equal(policy.mayUse(owner, id), true);
            assert.equal(policy.mayUse(guest, id), true);
            assert.equal(policy.mayUse(viewer, id), true);
        }

        assert.equal(policy.mayUse(linker, "runner"), true);
    });

    it("refuses someone not chosen, someone removed, and a computer that is gone", () => {
        const { policy } = world();

        assert.equal(policy.mayUse(stranger, THIS_SERVER), false);
        assert.equal(policy.mayUse(stranger, "runner"), false);
        // The linker of a runner is not chosen for this server.
        assert.equal(policy.mayUse(linker, THIS_SERVER), false);
        assert.equal(policy.mayUse({ id: "removed" }, THIS_SERVER), false);
        assert.equal(policy.mayUse(owner, "unlinked"), false);
    });

    it("refuses a person invited to one session, also when they are chosen", () => {
        const { policy } = world([computer(THIS_SERVER, { chosen: [invited.id] })]);

        assert.equal(policy.mayUse(invited, THIS_SERVER), false);
    });

    it("reads the current record, so a person changed a moment ago has their new rights", () => {
        const { policy, people } = world();

        assert.equal(policy.mayStart(guest, THIS_SERVER), true);
        people.set(guest.id, { ...guest, role: "viewer" });
        assert.equal(policy.mayStart(guest, THIS_SERVER), false);
        people.delete(guest.id);
        assert.equal(policy.mayUse(guest, THIS_SERVER), false);
    });

    it("lets chosen people who steer start sessions, and refuses viewers", () => {
        const { policy } = world();

        assert.equal(policy.mayStart(guest, THIS_SERVER), true);
        assert.equal(policy.mayStart(guest, "runner"), true);
        assert.equal(policy.mayStart(viewer, THIS_SERVER), false);
        assert.equal(policy.mayStart(viewer, "runner"), false);
        assert.equal(policy.mayStart(stranger, THIS_SERVER), false);
        assert.throws(() => policy.requireStart(viewer, THIS_SERVER), { status: 403 });
        assert.throws(
            () => policy.requireStart(stranger, THIS_SERVER),
            (error: HttpError) => error.status === 403 && /not chosen you/.test(error.message),
        );
    });

    it("lets the owner and the linker manage a computer, and refuses chosen people", () => {
        const { policy } = world();

        assert.equal(policy.mayManage(owner, THIS_SERVER), true);
        assert.equal(policy.mayManage(owner, "runner"), true);
        assert.equal(policy.mayManage(linker, "runner"), true);
        assert.equal(policy.mayManage(guest, THIS_SERVER), false);
        assert.equal(policy.mayManage(guest, "runner"), false);
        assert.throws(() => policy.requireManage(guest, "runner"), { status: 403 });
    });

    it("refuses a linker who became a viewer the right to manage their computer", () => {
        const { policy, people } = world();

        people.set(linker.id, { ...linker, role: "viewer" });
        assert.equal(policy.mayManage(linker, "runner"), false);
    });

    it("lets only the owner link computers", () => {
        const { policy } = world();

        assert.equal(policy.mayLink(owner), true);
        assert.equal(policy.mayLink(guest), false);
        assert.equal(policy.mayLink(linker), false);
    });
});

describe("may this person use this folder", () => {
    it("lets the owner use any folder on this server at once", () => {
        const { policy } = world();

        assert.deepEqual(policy.folder(owner, THIS_SERVER, "/anywhere"), { kind: "allow" });
    });

    it("asks the owner once for a whole runner, then lets them into every folder there", () => {
        assert.deepEqual(world().policy.folder(owner, "runner", "/anywhere"), {
            kind: "ask",
            whole: true,
        });

        const { policy } = world(undefined, undefined, undefined, new Set(["owner|runner|*"]));

        assert.deepEqual(policy.folder(owner, "runner", "/anywhere"), { kind: "allow" });
        assert.deepEqual(policy.folder(owner, "runner", "/elsewhere"), { kind: "allow" });
    });

    it("asks a chosen guest for a folder given to them, or one inside it, until approved", () => {
        const asked = world().policy;

        for (const folder of ["/given", "/given/app", "/given/app/deep"]) {
            assert.deepEqual(asked.folder(guest, THIS_SERVER, folder), {
                kind: "ask",
                whole: false,
            });
        }

        const { policy } = world(
            undefined,
            undefined,
            undefined,
            new Set([`guest|${THIS_SERVER}|/given/app`]),
        );

        assert.deepEqual(policy.folder(guest, THIS_SERVER, "/given/app"), { kind: "allow" });
        // Each folder needs its own approval, also one beside it in the same given folder.
        assert.deepEqual(policy.folder(guest, THIS_SERVER, "/given/other"), {
            kind: "ask",
            whole: false,
        });
        // An approval on this server does not count on a runner.
        assert.deepEqual(policy.folder(guest, "runner", "/given/app"), {
            kind: "ask",
            whole: false,
        });
    });

    it("refuses a guest a folder not given to them, also one beside or above a given folder", () => {
        const { policy } = world();

        for (const folder of ["/", "/other", "/givenx", "/giv"]) {
            assert.equal(policy.folder(guest, THIS_SERVER, folder).kind, "refuse", folder);
        }

        assert.match(
            (policy.folder(guest, THIS_SERVER, "/other") as { reason: string }).reason,
            /not given you this folder/,
        );
    });

    it("never asks a person whose approval time is never, but still keeps them to their folders", () => {
        const { policy } = world(undefined, undefined, undefined, undefined, { guest: 0 });

        assert.deepEqual(policy.folder(guest, THIS_SERVER, "/given/app"), { kind: "allow" });
        assert.equal(policy.folder(guest, THIS_SERVER, "/other").kind, "refuse");
    });

    it("refuses a folder to someone not chosen, a viewer, and someone invited to one session", () => {
        const { policy } = world([computer(THIS_SERVER, { given: () => ["/given"] })]);

        for (const person of [stranger, viewer, invited]) {
            assert.equal(policy.folder(person, THIS_SERVER, "/given").kind, "refuse", person.id);
        }

        assert.match(
            (policy.folder(stranger, THIS_SERVER, "/given") as { reason: string }).reason,
            /not chosen you for this server/,
        );
    });

    it("names the folders a person may use: the owner every one, others theirs, strangers none", () => {
        const { policy } = world();

        assert.equal(policy.givenFolders(owner, "runner"), undefined);
        assert.deepEqual(policy.givenFolders(guest, THIS_SERVER), ["/given"]);
        assert.deepEqual(policy.givenFolders(stranger, THIS_SERVER), []);
        assert.equal(policy.mayUseFolder(guest, THIS_SERVER, "C:\\given"), false);
    });

    it("lets chosen people who steer browse folders, and refuses viewers and strangers", () => {
        const { policy } = world();

        assert.equal(policy.mayBrowse(owner, THIS_SERVER), true);
        assert.equal(policy.mayBrowse(guest, THIS_SERVER), true);
        assert.equal(policy.mayBrowse(viewer, THIS_SERVER), false);
        assert.equal(policy.mayBrowse(stranger, THIS_SERVER), false);
        assert.equal(policy.mayBrowse(stranger, "runner"), false);
    });
});

describe("may this person see and steer this session", () => {
    it("lets the starter see and steer their own session, and its subagents", () => {
        const { policy } = world();

        for (const id of ["10", "101", "20", "201"]) {
            assert.equal(policy.maySee(guest, id), true, id);
            assert.equal(policy.maySteer(guest, id), true, id);
        }
    });

    it("refuses a session someone else started that is not shared, on the server and on a runner", () => {
        const { policy } = world([
            computer(THIS_SERVER, { chosen: [guest.id, viewer.id, stranger.id] }),
            computer("runner", { chosen: [guest.id, viewer.id, stranger.id] }),
        ]);

        // Chosen for both computers, yet the sessions are the guest's alone.
        for (const id of ["10", "101", "20", "201"]) {
            assert.equal(policy.maySee(stranger, id), false, id);
            assert.equal(policy.maySteer(stranger, id), false, id);
        }

        assert.throws(() => policy.requireSee(stranger, "10"), { status: 404 });
    });

    it("lets a person see a session shared with them, and refuses it once they are not chosen", () => {
        const { policy } = world();

        assert.equal(policy.maySee(guest, "11"), true);
        assert.equal(policy.maySteer(guest, "11"), true);

        // Shared with the guest, but the guest is no longer chosen for this server.
        const unchosen = world([computer(THIS_SERVER, { chosen: [] })]).policy;

        assert.equal(unchosen.maySee(guest, "11"), false);
    });

    it("gives older sessions, with no starter, to the owner", () => {
        const { policy } = world();
        const facts: SessionFacts = { id: "12", computer: THIS_SERVER };

        assert.equal(policy.starter(facts), owner.id);
        assert.equal(policy.maySee(owner, "12"), true);
        assert.equal(policy.maySee(guest, "12"), false);
    });

    it("lets the owner see and steer every session, and refuses them someone's PiP", () => {
        const { policy } = world();

        for (const id of ["10", "11", "12", "20", "30"]) {
            assert.equal(policy.maySteer(owner, id), true, id);
        }

        assert.equal(policy.maySee(owner, "40"), false);
        assert.equal(policy.maySee(guest, "40"), true);
    });

    it("lets a person invited to one session into it alone", () => {
        const { policy } = world();

        assert.equal(policy.maySee(invited, "30"), true);
        assert.equal(policy.maySteer(invited, "30"), true);
        assert.equal(policy.maySee(invited, "10"), false);
        assert.equal(policy.maySee(invited, "12"), false);
    });

    it("lets a viewer see what they may see, and refuses them steering", () => {
        const { policy } = world(
            [computer(THIS_SERVER), computer("runner")],
            [
                { id: "50", computer: THIS_SERVER, createdBy: guest.id, sharedWith: [viewer.id] },
                {
                    id: "30",
                    computer: THIS_SERVER,
                    createdBy: owner.id,
                },
            ],
        );

        assert.equal(policy.maySee(viewer, "50"), true);
        assert.equal(policy.maySteer(viewer, "50"), false);
        assert.throws(() => policy.requireSteer(viewer, "50"), { status: 403 });
        assert.equal(policy.maySee(invitedViewer, "30"), true);
        assert.equal(policy.maySteer(invitedViewer, "30"), false);
    });

    it("refuses a session that does not exist, and a person who does not", () => {
        const { policy } = world();

        assert.equal(policy.maySee(owner, "999"), false);
        assert.equal(policy.maySee({ id: "removed" }, "10"), false);
        assert.throws(() => policy.requireSteer(owner, "999"), { status: 404 });
    });
});

describe("may this person send to a session now", () => {
    it("lets the owner send on this server at once, and asks for a runner until it is approved", () => {
        assert.equal(world().policy.steer(owner, "10", "/anywhere"), "allow");
        assert.equal(world().policy.steer(owner, "20", "/given"), "ask");
        assert.equal(
            world(undefined, undefined, undefined, new Set(["owner|runner|*"])).policy.steer(
                owner,
                "20",
                "/given",
            ),
            "allow",
        );
    });

    it("lets a starter send while their folder's approval lasts, and asks once it ended", () => {
        assert.equal(world().policy.steer(guest, "10", "/given/app"), "ask");

        const { policy } = world(
            undefined,
            undefined,
            undefined,
            new Set([`guest|${THIS_SERVER}|/given/app`]),
        );

        assert.equal(policy.steer(guest, "10", "/given/app"), "allow");
        // A subagent goes by its top session.
        assert.equal(policy.steer(guest, "101", "/given/app"), "allow");
    });

    it("asks for a shared session's own approval, not a folder's", () => {
        const folderOnly = world(
            undefined,
            undefined,
            undefined,
            new Set([`guest|${THIS_SERVER}|/given/app`]),
        ).policy;

        assert.equal(folderOnly.steer(guest, "11", "/given/app"), "ask");

        const { policy } = world(
            undefined,
            undefined,
            undefined,
            new Set([`guest|${THIS_SERVER}|session:11`]),
        );

        assert.equal(policy.steer(guest, "11", "/given/app"), "allow");
    });

    it("never asks whose time is never, a PiP's person, or someone invited to one session", () => {
        assert.equal(
            world(undefined, undefined, undefined, undefined, { guest: 0 }).policy.steer(
                guest,
                "11",
                "/x",
            ),
            "allow",
        );
        assert.equal(world().policy.steer(guest, "40", "/x"), "allow");
        assert.equal(world().policy.steer(invited, "30", "/x"), "allow");
    });

    it("refuses a viewer and someone the session is not shared with, approved or not", () => {
        const { policy } = world(
            undefined,
            undefined,
            undefined,
            new Set([`viewer|${THIS_SERVER}|session:11`, `stranger|${THIS_SERVER}|session:10`]),
        );

        assert.equal(policy.steer(viewer, "11", "/x"), "ask");
        assert.equal(policy.steer(stranger, "10", "/x"), "ask");
    });
});

describe("who may share a session", () => {
    it("lets the owner and the starter share it", () => {
        const { policy } = world();

        assert.equal(policy.mayShare(owner, "10"), true);
        assert.equal(policy.mayShare(guest, "10"), true);
        assert.equal(policy.mayShare(owner, "12"), true);
    });

    it("refuses someone it is shared with, a stranger, a starter no longer chosen, and any PiP", () => {
        const { policy } = world();

        assert.equal(policy.mayShare(guest, "11"), false);
        assert.equal(policy.mayShare(stranger, "10"), false);
        assert.equal(policy.mayShare(guest, "40"), false);
        assert.equal(policy.mayShare(owner, "40"), false);

        const unchosen = world([computer(THIS_SERVER, { chosen: [] })]).policy;

        assert.equal(unchosen.mayShare(guest, "10"), false);
    });

    it("shares new sessions with no one unless the computer shares them with its people", () => {
        assert.deepEqual(world().policy.initialShares(THIS_SERVER, guest.id), []);

        const sharing = world([computer(THIS_SERVER, { shareNew: true })]).policy;

        assert.deepEqual(sharing.initialShares(THIS_SERVER, guest.id), [viewer.id]);
        assert.deepEqual(sharing.initialShares("gone", guest.id), []);
    });
});

describe("approval methods", () => {
    const at = 1_800_000_000_000;

    function authenticators(): {
        auth: Authenticators;
        store: Map<string, StoredAuthenticator>;
        clock: { now: number };
        lockouts: Lockout[];
    } {
        const store = new Map<string, StoredAuthenticator>();
        const clock = { now: at };
        const lockouts: Lockout[] = [];
        const auth = new Authenticators(
            {
                get: (id) => store.get(id),
                set: (id, value) => (value === undefined ? store.delete(id) : store.set(id, value)),
            },
            { now: () => clock.now, locked: (lockout) => lockouts.push(lockout) },
        );

        return { auth, store, clock, lockouts };
    }

    /** Five wrong codes for `person`, then the clock moves on a step, inside the lockout. */
    function guessFive(auth: Authenticators, person: string, clock: { now: number }): void {
        for (let i = 0; i < 5; i++) {
            assert.equal(auth.check(person, "000000"), false);
        }

        clock.now += STEP_MS;
    }

    function code(secret: string, now: number): string {
        return totp(secret, Math.floor(now / STEP_MS));
    }

    it("links a person's authenticator once its first code confirms it", () => {
        const { auth, clock } = authenticators();
        const { secret, link } = auth.begin(guest.id, "Guest");

        assert.match(link, /^otpauth:\/\/totp\//);
        assert.equal(auth.linked(guest.id), false);
        assert.throws(() => auth.confirm(guest.id, "000000"), { status: 400 });
        assert.equal(auth.linked(guest.id), false);
        auth.confirm(guest.id, code(secret, clock.now));
        assert.equal(auth.linked(guest.id), true);
        assert.throws(() => auth.begin(guest.id, "Guest"), { status: 409 });
    });

    it("lets a person approve their own request with their code, once", async () => {
        const { auth, clock } = authenticators();
        const methods = new ApprovalMethods(auth);
        const { secret } = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(secret, clock.now));
        clock.now += STEP_MS;
        const fresh = code(secret, clock.now);

        assert.equal(await methods.verify(guest, guest, { method: "totp", code: fresh }), "totp");
        // A used code fails, also when it is still in its time window.
        await assert.rejects(methods.verify(guest, guest, { method: "totp", code: fresh }), {
            status: 400,
        });
    });

    it("refuses someone else's code, a wrong code, and a person with no authenticator", async () => {
        const { auth, clock } = authenticators();
        const methods = new ApprovalMethods(auth);
        const { secret } = auth.begin(owner.id, "Owner");

        auth.confirm(owner.id, code(secret, clock.now));
        clock.now += STEP_MS;

        // The owner's code does not approve the guest's request as `totp`: the owner uses `owner` for that.
        await assert.rejects(
            methods.verify(owner, guest, { method: "totp", code: code(secret, clock.now) }),
            { status: 400 },
        );
        await assert.rejects(methods.verify(guest, guest, { method: "totp", code: "123456" }), {
            status: 400,
        });
        await assert.rejects(methods.verify(owner, owner, { method: "totp", code: "x" }), {
            status: 400,
        });
    });

    it("locks an authenticator after five wrong codes, tells the owner, and says when to try again", async () => {
        const { auth, clock, lockouts } = authenticators();
        const methods = new ApprovalMethods(auth);
        const { secret } = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(secret, clock.now));
        guessFive(auth, guest.id, clock);

        assert.deepEqual(lockouts, [{ person: guest.id, until: at + 10 * 60_000, count: 1 }]);
        assert.equal(auth.check(guest.id, code(secret, clock.now)), false);
        await assert.rejects(
            methods.verify(guest, guest, { method: "totp", code: code(secret, clock.now) }),
            (error: HttpError) =>
                error.status === 429 && /Try again in 10 minutes/.test(error.message),
        );
        // Another wrong code while locked does not lock it again, nor tell the owner twice.
        assert.equal(auth.check(guest.id, "000000"), false);
        assert.equal(lockouts.length, 1);
        clock.now = at + 10 * 60_000 + STEP_MS;
        assert.equal(auth.lockedUntil(guest.id), undefined);
        assert.equal(auth.check(guest.id, code(secret, clock.now)), true);
    });

    it("locks for longer each time within a day: 10 minutes, then 30, then an hour", () => {
        const { auth, clock, lockouts } = authenticators();
        const { secret } = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(secret, clock.now));

        for (const minutes of [10, 30, 60, 60]) {
            const start = clock.now;

            guessFive(auth, guest.id, clock);
            assert.equal(
                auth.lockedUntil(guest.id),
                start + minutes * 60_000,
                `${String(minutes)} min`,
            );
            clock.now = auth.lockedUntil(guest.id)! + STEP_MS;
            // A right code in between does not start the count over.
            assert.equal(auth.check(guest.id, code(secret, clock.now)), true);
            clock.now += STEP_MS;
        }

        assert.deepEqual(
            lockouts.map((each) => each.count),
            [1, 2, 3, 4],
        );
    });

    it("starts again at 10 minutes once a day has passed since the earlier lockouts", () => {
        const { auth, clock } = authenticators();
        const { secret } = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(secret, clock.now));
        guessFive(auth, guest.id, clock);
        clock.now += 24 * 60 * 60_000;

        const start = clock.now;

        guessFive(auth, guest.id, clock);
        assert.equal(auth.lockedUntil(guest.id), start + 10 * 60_000);
    });

    it("refuses a code from someone who never locked out with a plain wrong-code message", async () => {
        const { auth, clock, lockouts } = authenticators();
        const methods = new ApprovalMethods(auth);
        const { secret } = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(secret, clock.now));
        await assert.rejects(methods.verify(guest, guest, { method: "totp", code: "000000" }), {
            status: 400,
            message: "That code is wrong or used. Try the next one.",
        });
        assert.deepEqual(lockouts, []);
    });

    it("lets the owner approve anyone's request from the app, and refuses anyone else", async () => {
        const methods = new ApprovalMethods(authenticators().auth);

        assert.equal(await methods.verify(owner, guest, { method: "owner" }), "owner");
        await assert.rejects(methods.verify(guest, guest, { method: "owner" }), { status: 403 });
        await assert.rejects(methods.verify(linker, guest, { method: "owner" }), { status: 403 });
    });

    it("refuses a method it does not know", async () => {
        const methods = new ApprovalMethods(authenticators().auth);

        await assert.rejects(
            methods.verify(owner, owner, { method: "passkey" } as unknown as { method: "owner" }),
            { status: 400 },
        );
    });

    it("needs a person's code to remove their authenticator, unless the owner removes it", () => {
        const { auth, clock } = authenticators();
        const { secret } = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(secret, clock.now));
        assert.throws(() => auth.remove(guest.id, guest), { status: 400 });
        assert.equal(auth.linked(guest.id), true);
        clock.now += STEP_MS;
        auth.remove(guest.id, guest, code(secret, clock.now));
        assert.equal(auth.linked(guest.id), false);

        const other = auth.begin(guest.id, "Guest");

        auth.confirm(guest.id, code(other.secret, clock.now + STEP_MS));
        auth.remove(guest.id, owner);
        assert.equal(auth.linked(guest.id), false);
    });
});
