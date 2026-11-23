// The access policy (`access.ts`) and the approval methods (`approval-methods.ts`), rule by rule: for each, a person it
// lets in, and a person it refuses. Plain facts, no app: the check points that use the policy have their own tests.
//
// "In charge" of a computer: the owner of this server, the linker of a runner. The owner is no one special on a runner
// someone else linked.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type AccessFacts,
    AccessPolicy,
    type Computer,
    forgetPerson,
    inFolder,
    noteShares,
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
import { STEP_MS, totp } from "../src/server/totp.ts";
import type { ComputerRight } from "../src/server/rights.ts";

const owner: Person = { id: "owner", role: "owner" };
const guest: Person = { id: "guest", role: "guest" };
const viewer: Person = { id: "viewer", role: "viewer" };
const stranger: Person = { id: "stranger", role: "guest" };
const linker: Person = { id: "linker", role: "guest", rights: ["linksRunners"] };
const invited: Person = { id: "invited", role: "guest", sessions: ["30"] };
/** A user who shares what they were given (`rights.ts` `reshares`), and one who does not. */
const lead: Person = { id: "lead", role: "guest", rights: ["reshares"] };
const plain: Person = { id: "plain", role: "guest" };

/** On a computer, `people` hold `right`, and nobody the other one. */
const held = (right: ComputerRight, people: string[]): Pick<Computer, "holders"> => ({
    holders: (asked) => (asked === right ? people : []),
});

function computer(id: string, patch: Partial<Computer> = {}): Computer {
    return {
        id,
        linker: id === THIS_SERVER ? owner.id : linker.id,
        chosen: [guest.id, viewer.id],
        leaving: [],
        // The guest was given /given (and what is in it); no one else anything.
        given: (person) => (person === guest.id ? ["/given"] : []),
        sees: () => [],
        givenBy: () => ({}),
        holders: () => [],
        shareNew: false,
        ...patch,
    };
}

function world(
    computers: Computer[] = [computer(THIS_SERVER), computer("runner")],
    sessions: SessionFacts[] = [
        { id: "10", computer: THIS_SERVER, createdBy: guest.id },
        { id: "11", computer: THIS_SERVER, createdBy: stranger.id, sharedWith: [guest.id] },
        { id: "12", computer: THIS_SERVER },
        { id: "20", computer: "runner", createdBy: guest.id },
        { id: "21", computer: "runner", createdBy: linker.id },
        { id: "30", computer: THIS_SERVER, createdBy: owner.id },
        { id: "40", computer: THIS_SERVER, pip: guest.id },
    ],
    people: Person[] = [owner, guest, viewer, stranger, linker, invited],
    approved: Set<string> = new Set(),
): { policy: AccessPolicy; people: Map<string, Person>; approved: Set<string> } {
    const byId = new Map(people.map((each) => [each.id, each]));
    // Subagents name their top session: 101 is a subagent of 10, 201 of 20.
    const parents = new Map([
        ["101", "10"],
        ["201", "20"],
    ]);
    const facts: AccessFacts = {
        ownerId: owner.id,
        person: (id) => byId.get(id),
        computers: () => computers.map((each) => each.id),
        computer: (id) => computers.find((each) => each.id === id),
        session: (id) => sessions.find((each) => each.id === (parents.get(id) ?? id)),
        approved: (id) => approved.has(id),
    };

    return { policy: new AccessPolicy(facts), people: byId, approved };
}

describe("who is in charge of a computer", () => {
    it("puts the owner in charge of this server, and a runner's linker in charge of it", () => {
        const { policy } = world();

        assert.equal(policy.inCharge(owner, THIS_SERVER), true);
        assert.equal(policy.inCharge(linker, "runner"), true);
        assert.equal(policy.inChargeOf("20"), linker.id);
        assert.equal(policy.inChargeOf("10"), owner.id);
    });

    it("puts no one else in charge: not the owner of someone else's runner, nor a chosen guest", () => {
        const { policy } = world();

        assert.equal(policy.inCharge(owner, "runner"), false);
        assert.equal(policy.inCharge(guest, THIS_SERVER), false);
        assert.equal(policy.inCharge(guest, "runner"), false);
        assert.equal(policy.inCharge(linker, THIS_SERVER), false);
    });
});

describe("may this person use this computer", () => {
    it("lets who is in charge and the people they chose use a computer", () => {
        const { policy } = world();

        assert.equal(policy.mayUse(owner, THIS_SERVER), true);
        assert.equal(policy.mayUse(linker, "runner"), true);

        for (const id of [THIS_SERVER, "runner"]) {
            assert.equal(policy.mayUse(guest, id), true);
            assert.equal(policy.mayUse(viewer, id), true);
        }
    });

    it("refuses someone not chosen, the owner on a runner they were not chosen for, and a gone computer", () => {
        const { policy } = world();

        assert.equal(policy.mayUse(stranger, THIS_SERVER), false);
        assert.equal(policy.mayUse(stranger, "runner"), false);
        assert.equal(policy.mayUse(owner, "runner"), false);
        assert.equal(policy.mayUse(linker, THIS_SERVER), false);
        assert.equal(policy.mayUse({ id: "removed" }, THIS_SERVER), false);
        assert.equal(policy.mayUse(owner, "unlinked"), false);
    });

    it("lets the owner use someone else's runner once its linker chose them", () => {
        const { policy } = world([
            computer(THIS_SERVER),
            computer("runner", { chosen: [owner.id] }),
        ]);

        assert.equal(policy.mayUse(owner, "runner"), true);
        assert.equal(policy.inCharge(owner, "runner"), false);
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
        assert.equal(policy.mayStart(viewer, THIS_SERVER), false);
        assert.throws(() => policy.requireStart(viewer, THIS_SERVER), {
            status: 403,
            message: /Viewers cannot start sessions/,
        });
        assert.throws(() => policy.requireStart(stranger, "runner"), {
            message: /You are not chosen for this computer yet/,
        });
    });

    it("lets who is in charge manage a computer, and refuses chosen people and the owner of a runner", () => {
        const { policy } = world();

        assert.equal(policy.mayManage(owner, THIS_SERVER), true);
        assert.equal(policy.mayManage(linker, "runner"), true);
        assert.equal(policy.mayManage(guest, THIS_SERVER), false);
        assert.equal(policy.mayManage(owner, "runner"), false);
        assert.throws(() => policy.requireManage(owner, "runner"), { status: 403 });
    });

    it("lets the linker and the owner unlink a runner, and refuses chosen people and this server", () => {
        const { policy } = world();

        assert.equal(policy.mayUnlink(linker, "runner"), true);
        assert.equal(policy.mayUnlink(owner, "runner"), true);
        assert.equal(policy.mayUnlink(guest, "runner"), false);
        assert.equal(policy.mayUnlink(owner, THIS_SERVER), false);
    });

    it("lets the owner and the guests the owner lets link computers, and refuses anyone else", () => {
        const { policy } = world();

        assert.equal(policy.mayLink(owner), true);
        assert.equal(policy.mayLink(linker), true);
        assert.equal(policy.mayLink(guest), false);
        assert.equal(policy.mayLink(viewer), false);
        const invitedLinker: Person = {
            ...invited,
            id: "invited-linker",
            rights: ["linksRunners"],
        };

        assert.equal(
            world(undefined, undefined, [invitedLinker]).policy.mayLink(invitedLinker),
            false,
        );
    });
});

describe("may this person use this folder", () => {
    it("lets who is in charge use any folder at once", () => {
        const { policy } = world();

        assert.deepEqual(policy.folder(owner, THIS_SERVER, "/anywhere"), { kind: "allow" });
        assert.deepEqual(policy.folder(linker, "runner", "/anywhere"), { kind: "allow" });
        assert.equal(policy.givenFolders(owner, THIS_SERVER), undefined);
    });

    it("asks a chosen guest for a folder given to them, or one inside it", () => {
        const { policy } = world();

        for (const folder of ["/given", "/given/app", "/given/a\\b"]) {
            assert.deepEqual(policy.folder(guest, THIS_SERVER, folder), { kind: "ask" }, folder);
        }
    });

    it("judges a folder by its computer's path rules: a backslash parts folders on Windows alone", () => {
        // Where paths start with `/`, `\` is a character of a name: these are folders beside the given one.
        const { policy } = world();

        for (const folder of ["/given\\win", "/given\\", "/given\\..\\other"]) {
            assert.equal(policy.folder(guest, THIS_SERVER, folder).kind, "refuse", folder);
            assert.equal(policy.mayUseFolder(guest, THIS_SERVER, folder), false, folder);
        }

        // A given folder whose own name ends in `\` is that folder, not the one without it.
        assert.equal(inFolder("/a/proj/src", "/a/proj\\"), false);
        assert.equal(inFolder("/a/proj\\/src", "/a/proj\\"), true);
        assert.equal(inFolder("/a/proj/src", "/a/proj//"), true);

        // On Windows both part folders, also mixed, and a folder beside is still outside.
        const windows = world([
            computer(THIS_SERVER),
            computer("runner", {
                given: (person) => (person === guest.id ? ["C:\\Users\\a\\app"] : []),
            }),
        ]).policy;

        for (const folder of [
            "C:\\Users\\a\\app",
            "C:\\Users\\a\\app\\src",
            "C:\\Users\\a\\app/src",
        ]) {
            assert.deepEqual(windows.folder(guest, "runner", folder), { kind: "ask" }, folder);
        }

        for (const folder of ["C:\\Users\\a\\apple", "C:\\Users\\a", "D:\\Users\\a\\app"]) {
            assert.equal(windows.folder(guest, "runner", folder).kind, "refuse", folder);
        }

        assert.equal(inFolder("D:\\work", "D:\\"), true);
        assert.equal(inFolder("/anything", "/"), true);
    });

    it("refuses a guest a folder not given, also one beside or above a given folder", () => {
        const { policy } = world();

        for (const folder of ["/", "/give", "/given-other", "/other"]) {
            assert.equal(policy.folder(guest, THIS_SERVER, folder).kind, "refuse", folder);
        }

        assert.throws(() => policy.requireFolder(guest, "runner", "/other"), {
            message: /Ask whoever is in charge of this computer to add it/,
        });
    });

    it("refuses a folder to someone not chosen, a viewer, and someone invited to one session", () => {
        const { policy } = world();

        for (const person of [stranger, viewer, invited]) {
            assert.equal(policy.folder(person, THIS_SERVER, "/given").kind, "refuse", person.id);
        }
    });

    it("names the folders a person may use: who is in charge every one, others theirs, strangers none", () => {
        const { policy } = world();

        assert.equal(policy.givenFolders(linker, "runner"), undefined);
        assert.deepEqual(policy.givenFolders(guest, "runner"), ["/given"]);
        assert.deepEqual(policy.givenFolders(stranger, THIS_SERVER), []);
        assert.equal(policy.mayBrowse(guest, THIS_SERVER), true);
        assert.equal(policy.mayBrowse(viewer, THIS_SERVER), false);
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

    it("shows a removed computer's sessions only to their starter and the people they were shared with", () => {
        // The runner is unlinked: its sessions stay, and run nowhere.
        const { policy } = world(
            [computer(THIS_SERVER)],
            [
                { id: "20", computer: "runner", createdBy: guest.id },
                { id: "21", computer: "runner", createdBy: linker.id, sharedWith: [viewer.id] },
            ],
        );

        assert.equal(policy.maySee(guest, "20"), true, "its starter");
        assert.equal(policy.maySee(viewer, "21"), true, "shared with them");
        assert.equal(policy.maySee(linker, "21"), true, "its starter, the linker");
        // Unlinking shows no one else a private session: not the owner, who saw nothing there before.
        assert.equal(policy.maySee(owner, "20"), false);
        assert.equal(policy.maySee(owner, "21"), false);
        assert.equal(policy.maySee(stranger, "20"), false);
    });

    it("lets who is in charge see every session on their computer", () => {
        const { policy } = world();

        for (const id of ["10", "11", "12", "30"]) {
            assert.equal(policy.maySee(owner, id), true, id);
        }

        assert.equal(policy.maySee(linker, "20"), true);
        assert.equal(policy.maySee(linker, "21"), true);
    });

    it("refuses the owner a session on someone else's runner, unless shared with them", () => {
        const shared: SessionFacts[] = [
            { id: "20", computer: "runner", createdBy: guest.id },
            { id: "22", computer: "runner", createdBy: guest.id, sharedWith: [owner.id] },
        ];
        const { policy } = world(undefined, shared);

        assert.equal(policy.maySee(owner, "20"), false);
        assert.equal(policy.maySee(owner, "22"), true);
    });

    it("refuses a session someone else started that is not shared", () => {
        const { policy } = world();

        assert.equal(policy.maySee(guest, "30"), false);
        assert.equal(policy.maySee(guest, "21"), false);
        assert.equal(policy.maySee(stranger, "10"), false);
    });

    it("lets a person see a session shared with them, and their own only while they may use its computer", () => {
        const { policy } = world([computer(THIS_SERVER, { chosen: [viewer.id] })]);

        assert.equal(policy.maySee(guest, "11"), true);
        assert.equal(policy.maySee(guest, "10"), false);
    });

    it("gives older sessions, with no starter, to the owner", () => {
        const { policy } = world();

        assert.equal(policy.starter({ id: "12", computer: THIS_SERVER }), owner.id);
        assert.equal(policy.maySee(guest, "12"), false);
    });

    it("keeps a PiP its person's alone, the owner's too", () => {
        const { policy } = world();

        assert.equal(policy.maySee(guest, "40"), true);
        assert.equal(policy.maySee(owner, "40"), false);
    });

    it("lets a person invited to one session into it alone", () => {
        const { policy } = world();

        assert.equal(policy.maySee(invited, "30"), true);
        assert.equal(policy.maySee(invited, "10"), false);
    });

    it("lets a viewer see what is shared with them, and refuses them steering", () => {
        const sessions: SessionFacts[] = [
            { id: "50", computer: THIS_SERVER, createdBy: owner.id, sharedWith: [viewer.id] },
        ];
        const { policy } = world(undefined, sessions);

        assert.equal(policy.maySee(viewer, "50"), true);
        assert.equal(policy.maySteer(viewer, "50"), false);
        assert.throws(() => policy.requireSteer(viewer, "50"), { status: 403 });
    });

    it("refuses a session that does not exist, and a person who does not", () => {
        const { policy } = world();

        assert.equal(policy.maySee(owner, "99"), false);
        assert.equal(policy.maySee({ id: "removed" }, "10"), false);
        assert.throws(() => policy.requireSee(stranger, "10"), { status: 404 });
    });
});

describe("may this person see every session in a folder", () => {
    // The guest was given /given, and sees every session in it on this server and on the runner.
    const seeing = (patch: Partial<Computer> = {}) =>
        world(
            [
                computer(THIS_SERVER, {
                    sees: (person) => (person === guest.id ? ["/given"] : []),
                    ...patch,
                }),
                computer("runner", { sees: (person) => (person === guest.id ? ["/given"] : []) }),
            ],
            [
                { id: "50", computer: THIS_SERVER, createdBy: stranger.id, folder: "/given" },
                { id: "51", computer: THIS_SERVER, createdBy: owner.id, folder: "/given/app/src" },
                { id: "52", computer: THIS_SERVER, createdBy: stranger.id, folder: "/given-too" },
                { id: "53", computer: THIS_SERVER, createdBy: stranger.id, folder: "/" },
                { id: "54", computer: THIS_SERVER, createdBy: stranger.id },
                { id: "55", computer: THIS_SERVER, pip: stranger.id, folder: "/given" },
                { id: "56", computer: "runner", createdBy: linker.id, folder: "/given/work" },
                { id: "57", computer: "runner", createdBy: linker.id, folder: "/elsewhere" },
                {
                    id: "58",
                    computer: THIS_SERVER,
                    createdBy: stranger.id,
                    sharedWith: [guest.id],
                    folder: "/given",
                },
                { id: "59", computer: THIS_SERVER, createdBy: guest.id, folder: "/given" },
            ],
        );

    it("lets them see and steer a session someone else started in it, in a folder inside it, and on a runner", () => {
        const { policy } = seeing();

        for (const id of ["50", "51", "56"]) {
            assert.equal(policy.maySee(guest, id), true, id);
            assert.equal(policy.maySteer(guest, id), true, id);
        }

        assert.equal(policy.seesFolder(guest, THIS_SERVER, "/given/app"), true);
    });

    it("refuses a session beside the folder, above it, in no folder, on the runner outside it, and a PiP in it", () => {
        const { policy } = seeing();

        for (const id of ["52", "53", "54", "55", "57"]) {
            assert.equal(policy.maySee(guest, id), false, id);
        }

        assert.equal(policy.seesFolder(guest, THIS_SERVER, "/given-too"), false);
        assert.equal(policy.seesFolder(guest, THIS_SERVER, "/"), false);
    });

    it("refuses everyone it was not turned on for: a stranger, a viewer, and the same guest with it off", () => {
        const { policy } = seeing();

        assert.equal(policy.maySee(stranger, "51"), false);
        assert.equal(policy.maySee(viewer, "50"), false);
        assert.equal(world().policy.maySee(guest, "12"), false);
        assert.equal(seeing({ sees: () => [] }).policy.maySee(guest, "50"), false);
    });

    it("ends at once when the folder is taken back, they are no longer chosen, or they are made a viewer", () => {
        // The folder is no longer given, though the switch's record is still there.
        assert.equal(seeing({ given: () => [] }).policy.maySee(guest, "50"), false);
        // Given a folder inside it only: the record names a folder that is not theirs.
        assert.equal(seeing({ given: () => ["/given/app"] }).policy.maySee(guest, "51"), false);
        assert.equal(seeing({ chosen: [viewer.id] }).policy.maySee(guest, "50"), false);

        const { policy, people } = seeing();

        people.set(guest.id, { ...guest, role: "viewer" });
        assert.equal(policy.maySee(guest, "50"), false);
        // What is shared with them one at a time stays, to read.
        assert.equal(policy.maySee(guest, "58"), true);
    });

    it("gives a viewer and a person invited to one session nothing by a folder, whatever the record says", () => {
        const everyone = seeing({
            given: () => ["/given"],
            sees: () => ["/given"],
            chosen: [guest.id, viewer.id, invited.id],
        }).policy;

        assert.equal(everyone.maySee(viewer, "50"), false);
        assert.equal(everyone.maySee(invited, "50"), false);
        assert.equal(everyone.seesFolder(viewer, THIS_SERVER, "/given"), false);
    });

    it("lets them send while the session's approval is live, and neither share it nor renew it", () => {
        const { policy, approved } = seeing();

        assert.equal(policy.steer(guest, "50"), "locked");
        approved.add("50");
        assert.equal(policy.steer(guest, "50"), "allow");
        assert.equal(policy.mayShare(guest, "50"), false);
        assert.equal(policy.mayRenewWithCode(guest, "50"), false);
        assert.equal(policy.mayRenewFree(guest, "50"), false);
    });

    it("tells a session they have by its folder alone from one that is theirs in another way", () => {
        const { policy } = seeing();

        assert.equal(policy.seesOnlyByFolder(guest, "50"), true);
        assert.equal(policy.seesOnlyByFolder(guest, "58"), false, "shared with them");
        assert.equal(policy.seesOnlyByFolder(guest, "59"), false, "they started it");
        assert.equal(policy.seesOnlyByFolder(guest, "52"), false, "not theirs at all");
        assert.equal(policy.seesOnlyByFolder(owner, "50"), false, "in charge");
    });
});

describe("may this person send to a session now", () => {
    it("lets who is in charge send at once, approved or not", () => {
        const { policy } = world();

        assert.equal(policy.steer(owner, "10"), "allow");
        assert.equal(policy.steer(linker, "20"), "allow");
    });

    it("lets anyone who steers it send while its approval is live, and locks it once it ended", () => {
        const { policy, approved } = world();

        assert.equal(policy.steer(guest, "10"), "locked");
        assert.equal(policy.steer(guest, "11"), "locked");
        approved.add("10");
        approved.add("11");
        assert.equal(policy.steer(guest, "10"), "allow");
        assert.equal(policy.steer(guest, "101"), "allow");
        assert.equal(policy.steer(guest, "11"), "allow");
        approved.delete("10");
        assert.equal(policy.steer(guest, "10"), "locked");
    });

    it("never locks a PiP", () => {
        const { policy } = world();

        assert.equal(policy.steer(guest, "40"), "allow");
    });

    it("locks a person invited to one session with everyone else, and lets them in while it is approved", () => {
        const { policy, approved } = world();

        assert.equal(policy.steer(invited, "30"), "locked");
        approved.add("30");
        assert.equal(policy.steer(invited, "30"), "allow");
        approved.delete("30");
        assert.equal(policy.steer(invited, "30"), "locked");
    });

    it("locks a viewer and someone the session is not shared with, approved or not", () => {
        const { policy, approved } = world();

        approved.add("10");
        assert.equal(policy.steer(viewer, "10"), "locked");
        assert.equal(policy.steer(stranger, "10"), "locked");
    });

    it("lets the starter renew with their code, and who is in charge without one", () => {
        const { policy } = world();

        assert.equal(policy.mayRenewWithCode(guest, "10"), true);
        assert.equal(policy.mayRenewFree(owner, "10"), true);
        assert.equal(policy.mayRenewFree(linker, "20"), true);
    });

    it("refuses a renewal from someone it is shared with, a viewer, and the owner of someone else's runner", () => {
        const { policy } = world();

        assert.equal(policy.mayRenewWithCode(guest, "11"), false);
        assert.equal(policy.mayRenewFree(guest, "11"), false);
        assert.equal(policy.mayRenewWithCode(viewer, "10"), false);
        assert.equal(policy.mayRenewFree(owner, "20"), false);
    });
});

describe("who may give a folder", () => {
    /**
     * On this server the lead has /proj (all sessions in it) and /docs; the guest has /proj from the lead, the plain
     * user from whoever is in charge. On the runner the lead has /r.
     */
    const folders = (
        patch: Partial<Computer> = {},
        people: Person[] = [owner, guest, viewer, lead, plain, linker],
    ) =>
        world(
            [
                computer(THIS_SERVER, {
                    chosen: [guest.id, lead.id, plain.id],
                    given: (person) =>
                        person === lead.id
                            ? ["/proj", "/docs"]
                            : person === guest.id || person === plain.id
                              ? ["/proj"]
                              : [],
                    givenBy: (person): Record<string, string> =>
                        person === guest.id ? { "/proj": lead.id } : {},
                    sees: (person) => (person === lead.id ? ["/proj"] : []),
                    ...patch,
                }),
                computer("runner", {
                    chosen: [lead.id],
                    given: (person) => (person === lead.id ? ["/r"] : []),
                }),
            ],
            [],
            people,
        );
    const without = [owner, guest, viewer, { ...lead, rights: [] }, plain, linker];

    it("lets who is in charge give any folder, and someone who shares what they were given exactly their own", () => {
        const { policy } = folders();

        assert.equal(policy.mayGiveFolder(owner, THIS_SERVER, "/anywhere"), true);
        assert.equal(policy.mayGiveFolder(linker, "runner", "/anywhere"), true);
        assert.equal(policy.mayGiveFolder(lead, THIS_SERVER, "/proj"), true);
        assert.equal(policy.mayGiveFolder(lead, THIS_SERVER, "/docs"), true);
        assert.equal(policy.mayGiveFolder(lead, "runner", "/r"), true);
    });

    it("refuses a folder they do not have, one inside or above theirs, and anyone without the right", () => {
        const { policy } = folders();

        assert.equal(policy.mayGiveFolder(lead, THIS_SERVER, "/proj/app"), false);
        assert.equal(policy.mayGiveFolder(lead, THIS_SERVER, "/"), false);
        assert.equal(policy.mayGiveFolder(lead, THIS_SERVER, "/other"), false);
        assert.equal(policy.mayGiveFolder(lead, "runner", "/proj"), false, "theirs elsewhere");
        assert.equal(policy.mayGiveFolder(plain, THIS_SERVER, "/proj"), false);
        assert.equal(policy.mayGiveFolder(owner, "runner", "/r"), false);
        assert.equal(folders({}, without).policy.mayGiveFolder(lead, THIS_SERVER, "/proj"), false);

        // A viewer gives nothing, and nothing is given on a blocked computer.
        const asViewer = folders({}, [owner, guest, { ...lead, role: "viewer" }, plain, linker]);
        const blocked = folders({}, [owner, guest, lead, plain, { ...linker, role: "viewer" }]);

        assert.equal(asViewer.policy.mayGiveFolder(lead, THIS_SERVER, "/proj"), false);
        assert.equal(blocked.policy.blocked("runner"), true);
        assert.equal(blocked.policy.mayGiveFolder(lead, "runner", "/r"), false);
    });

    it("lets a folder be taken back by who is in charge and whoever gave it, with or without the right", () => {
        const { policy } = folders();

        assert.equal(policy.mayTakeFolder(owner, THIS_SERVER, guest.id, "/proj"), true);
        assert.equal(policy.mayTakeFolder(owner, THIS_SERVER, plain.id, "/proj"), true);
        assert.equal(policy.mayTakeFolder(lead, THIS_SERVER, guest.id, "/proj"), true);
        assert.equal(
            folders({}, without).policy.mayTakeFolder(lead, THIS_SERVER, guest.id, "/proj"),
            true,
        );
    });

    it("refuses to take back a folder someone else gave, and one they gave on a computer they left", () => {
        const { policy } = folders();

        assert.equal(policy.mayTakeFolder(lead, THIS_SERVER, plain.id, "/proj"), false);
        assert.equal(policy.mayTakeFolder(plain, THIS_SERVER, guest.id, "/proj"), false);
        assert.equal(policy.mayTakeFolder(guest, THIS_SERVER, guest.id, "/proj"), false);
        assert.equal(
            folders({ chosen: [guest.id, plain.id] }).policy.mayTakeFolder(
                lead,
                THIS_SERVER,
                guest.id,
                "/proj",
            ),
            false,
        );
    });

    it("lets all sessions in a folder be turned on by who gave it only while they access them all themselves", () => {
        const { policy } = folders();

        assert.equal(policy.maySetSees(owner, THIS_SERVER, guest.id, "/proj", true), true);
        assert.equal(policy.maySetSees(lead, THIS_SERVER, guest.id, "/proj", true), true);
        assert.equal(policy.maySetSees(lead, THIS_SERVER, guest.id, "/proj", false), true);

        // Not for a folder someone else gave, nor by someone who gave nothing.
        assert.equal(policy.maySetSees(lead, THIS_SERVER, plain.id, "/proj", true), false);
        assert.equal(policy.maySetSees(lead, THIS_SERVER, plain.id, "/proj", false), false);
        assert.equal(policy.maySetSees(plain, THIS_SERVER, guest.id, "/proj", false), false);

        // Without all sessions in it themselves, or without the right: only off.
        for (const { policy: limited } of [folders({ sees: () => [] }), folders({}, without)]) {
            assert.equal(limited.maySetSees(lead, THIS_SERVER, guest.id, "/proj", true), false);
            assert.equal(limited.maySetSees(lead, THIS_SERVER, guest.id, "/proj", false), true);
        }
    });
});

describe("who may share a session", () => {
    it("lets who is in charge and the starter share it", () => {
        const { policy } = world();

        assert.equal(policy.mayShare(owner, "10"), true);
        assert.equal(policy.mayShare(guest, "10"), true);
        assert.equal(policy.mayShare(linker, "20"), true);
    });

    it("refuses someone it is shared with, a stranger, the owner on someone else's runner, and any PiP", () => {
        const { policy } = world();

        assert.equal(policy.mayShare(guest, "11"), false);
        assert.equal(policy.mayShare(stranger, "10"), false);
        assert.equal(policy.mayShare(owner, "20"), false);
        assert.equal(policy.mayShare(guest, "40"), false);
    });

    /** Session 60 is the stranger's, shared with the guest, a lead, and a plain user; 61 is the owner's alone. */
    const passedOn = (
        patch: Partial<SessionFacts> = {},
        people: Person[] = [owner, guest, viewer, stranger, lead, plain],
    ) =>
        world(
            [
                computer(THIS_SERVER, {
                    chosen: [guest.id, viewer.id, stranger.id, lead.id, plain.id],
                }),
            ],
            [
                {
                    id: "60",
                    computer: THIS_SERVER,
                    createdBy: stranger.id,
                    sharedWith: [guest.id, lead.id, plain.id],
                    ...patch,
                },
                { id: "61", computer: THIS_SERVER, createdBy: owner.id },
                { id: "62", computer: THIS_SERVER, pip: lead.id },
            ],
            people,
        );

    it("lets someone share a session that is shared with them once they share what they were given", () => {
        const { policy } = passedOn();

        assert.equal(policy.mayShare(lead, "60"), true);
        assert.equal(policy.mayShare(stranger, "60"), true, "its starter needs no right");

        // Also one that is theirs by its folder alone.
        const folder = (person: string) =>
            person === lead.id || person === plain.id ? ["/proj"] : [];
        const byFolder = world(
            [computer(THIS_SERVER, { chosen: [lead.id, plain.id], given: folder, sees: folder })],
            [{ id: "70", computer: THIS_SERVER, createdBy: owner.id, folder: "/proj/app" }],
            [owner, lead, plain],
        );

        assert.equal(byFolder.policy.maySteer(plain, "70"), true);
        assert.equal(byFolder.policy.mayShare(lead, "70"), true);
        assert.equal(byFolder.policy.mayShare(plain, "70"), false);
    });

    it("refuses that without the right, as a viewer, and for a session they do not have", () => {
        const { policy } = passedOn();

        assert.equal(policy.mayShare(plain, "60"), false);
        assert.equal(policy.mayShare(lead, "61"), false, "nobody shares what they do not have");
        assert.equal(policy.mayShare(lead, "62"), false, "never a PiP");

        // A viewer holds no right, whatever their record says.
        const asViewer = passedOn({}, [
            owner,
            guest,
            viewer,
            stranger,
            { ...lead, role: "viewer" },
            plain,
        ]);

        assert.equal(asViewer.policy.maySee(lead, "60"), true);
        assert.equal(asViewer.policy.mayShare(lead, "60"), false);
    });

    it("lets a share be ended by who is in charge, the session's starter, and whoever made it", () => {
        // The lead shared it with the guest, its starter with the plain user; who shared it with the lead is not known.
        const { policy } = passedOn({ sharedBy: { [guest.id]: lead.id, [plain.id]: stranger.id } });

        assert.equal(policy.mayUnshare(owner, "60", guest.id), true);
        assert.equal(policy.mayUnshare(stranger, "60", guest.id), true);
        assert.equal(policy.mayUnshare(lead, "60", guest.id), true);

        // It takes no right: what someone gave stays theirs to take back.
        const without = passedOn({ sharedBy: { [guest.id]: lead.id } }, [
            owner,
            guest,
            viewer,
            stranger,
            { ...lead, rights: [] },
            plain,
        ]);

        assert.equal(without.policy.mayShare(lead, "60"), false);
        assert.equal(without.policy.mayUnshare(lead, "60", guest.id), true);
    });

    it("refuses to end a share someone else made, one whose maker is not known, and one of a session they lost", () => {
        const { policy } = passedOn({ sharedBy: { [guest.id]: lead.id, [plain.id]: stranger.id } });

        assert.equal(policy.mayUnshare(lead, "60", plain.id), false);
        assert.equal(policy.mayUnshare(plain, "60", guest.id), false);
        assert.equal(policy.mayUnshare(lead, "60", lead.id), false, "not known who shared it");
        assert.equal(policy.mayUnshare(owner, "62", lead.id), false, "never a PiP");

        const unknown = passedOn();

        assert.equal(unknown.policy.mayUnshare(lead, "60", guest.id), false);
        assert.equal(unknown.policy.mayUnshare(stranger, "60", guest.id), true);

        // The session is no longer shared with the lead: the share they made is its starter's to end.
        const lost = passedOn({
            sharedWith: [guest.id, plain.id],
            sharedBy: { [guest.id]: lead.id },
        });

        assert.equal(lost.policy.mayUnshare(lead, "60", guest.id), false);
        assert.equal(lost.policy.mayUnshare(stranger, "60", guest.id), true);
    });

    it("keeps who shared a session only while it is shared, and forgets a removed person", () => {
        const meta: {
            sharedWith?: string[];
            sharedBy?: Record<string, string>;
            usedBy?: Record<string, number>;
        } = { sharedWith: ["a", "b"], sharedBy: { a: "x", gone: "y" } };

        noteShares(meta, ["b", "not shared"], "z");
        assert.deepEqual(meta.sharedBy, { a: "x", b: "z" });

        // Shared again by someone else after it ended: the first giver is not kept.
        meta.sharedWith = ["b"];
        noteShares(meta);
        meta.sharedWith = ["b", "a"];
        noteShares(meta, ["a"]);
        assert.deepEqual(meta.sharedBy, { b: "z" }, "a share with no giver named has none");

        delete meta.sharedWith;
        noteShares(meta);
        assert.equal(meta.sharedBy, undefined);

        const left = {
            sharedWith: ["a", "b"],
            sharedBy: { a: "x", b: "y" } as Record<string, string>,
            usedBy: { x: 1, y: 2 } as Record<string, number>,
        };

        forgetPerson(left, "x");
        assert.deepEqual(left.sharedWith, ["a", "b"], "the shares they made stay");
        assert.deepEqual(left.sharedBy, { b: "y" });
        assert.deepEqual(left.usedBy, { y: 2 });
    });

    it("shares new sessions with no one unless the computer shares them with its people", () => {
        assert.deepEqual(world().policy.initialShares(THIS_SERVER, guest.id), []);
        assert.deepEqual(
            world([computer(THIS_SERVER, { shareNew: true })]).policy.initialShares(
                THIS_SERVER,
                guest.id,
            ),
            [viewer.id],
        );
    });

    it("lets a task's maker and who is in charge of its session manage it, and refuses the owner on someone else's runner", () => {
        const { policy } = world();

        // Its maker, wherever it is.
        assert.equal(policy.mayManageTask(guest, guest.id, "20"), true);
        // Who is in charge of the session's computer: the owner here, the linker on their runner.
        assert.equal(policy.mayManageTask(owner, guest.id, "10"), true);
        assert.equal(policy.mayManageTask(linker, guest.id, "20"), true);
        // Not the owner on a runner someone else linked, nor anyone else.
        assert.equal(policy.mayManageTask(owner, guest.id, "20"), false);
        assert.equal(policy.mayManageTask(stranger, guest.id, "10"), false);
        assert.equal(policy.mayManageTask(viewer, guest.id, "11"), false);
        // A PiP is its person's alone.
        assert.equal(policy.mayManageTask(owner, guest.id, "40"), false);
    });

    it("lets who is in charge of a computer override take turns and allow their own calls there, and a chosen user only once given it there", () => {
        const { policy } = world();

        // In charge: the owner here, the linker on their runner. Nobody else until it is given.
        for (const may of [policy.overridesTurns.bind(policy), policy.allowsOwn.bind(policy)]) {
            assert.equal(may(owner, THIS_SERVER), true);
            assert.equal(may(linker, "runner"), true);
            assert.equal(
                may(owner, "runner"),
                false,
                "the owner is not in charge of a guest's runner",
            );
            assert.equal(may(linker, THIS_SERVER), false);

            for (const each of [guest, viewer, invited, stranger]) {
                assert.equal(may(each, THIS_SERVER), false);
                assert.equal(may(each, "runner"), false);
            }

            assert.equal(may(guest, "nowhere"), false, "no such computer");
        }

        // Given on this server, to everyone the list can name: only a chosen person who prompts holds it, and only here.
        const everyone = [guest.id, viewer.id, stranger.id, invited.id];
        const given = world([
            computer(THIS_SERVER, held("wheel", everyone)),
            computer("runner", held("allows", [guest.id])),
        ]).policy;

        assert.equal(given.overridesTurns(guest, THIS_SERVER), true);
        assert.equal(given.overridesTurns(viewer, THIS_SERVER), false, "a viewer prompts nowhere");
        assert.equal(given.overridesTurns(stranger, THIS_SERVER), false, "not chosen here");
        assert.equal(given.overridesTurns(invited, THIS_SERVER), false, "held to one session");
        assert.equal(given.overridesTurns(guest, "runner"), false, "a right here is not one there");

        // One right is not the other.
        assert.equal(given.allowsOwn(guest, THIS_SERVER), false);
        assert.equal(given.allowsOwn(guest, "runner"), true);
        assert.equal(given.overridesTurns(guest, "runner"), false);

        // The owner, chosen on a guest's runner as anyone is, holds it there once its linker gives it.
        const chosen = world([
            computer(THIS_SERVER),
            computer("runner", { chosen: [owner.id], ...held("wheel", [owner.id]) }),
        ]).policy;

        assert.equal(chosen.overridesTurns(owner, "runner"), true);
        assert.equal(chosen.allowsOwn(owner, "runner"), false);
    });

    it("lets the owner keep sessions warm, and a user only once the owner lets them; never a viewer", () => {
        const { policy } = world();

        assert.equal(policy.keepsWarm(owner), true);

        // Off for everyone else until the owner turns it on.
        for (const each of [guest, viewer, invited, stranger, linker]) {
            assert.equal(policy.keepsWarm(each), false);
        }

        const let_ = (person: Person): Person => ({ ...person, rights: ["keepsWarm"] });
        const allowed = world(undefined, undefined, [
            owner,
            let_(guest),
            let_(viewer),
            stranger,
            linker,
            invited,
        ]).policy;

        assert.equal(allowed.keepsWarm(guest), true);
        // The switch alone is not enough for a viewer, and it is each person's own.
        assert.equal(allowed.keepsWarm(viewer), false);
        assert.equal(allowed.keepsWarm(stranger), false);
        assert.equal(allowed.keepsWarm(linker), false);
    });

    it("lets the owner invite, and nobody else until the owner lets them", () => {
        const { policy } = world();

        assert.equal(policy.invites(owner), true);
        assert.equal(policy.mayInvite(owner), true);
        assert.equal(policy.mayInvite(owner, "10"), true);

        // Off for everyone else: not to every session, and not to a session of their own.
        for (const each of [guest, viewer, invited, stranger, linker]) {
            assert.equal(policy.invites(each), false);
            assert.equal(policy.mayInvite(each), false);
        }

        assert.equal(policy.mayInvite(guest, "10"), false);
    });

    it("lets a user the owner lets invite: to their sessions when they start sessions somewhere, to a session they may share; never a viewer", () => {
        const let_ = (person: Person): Person => ({ ...person, rights: ["invites"] });
        const { policy } = world(undefined, undefined, [
            owner,
            let_(guest),
            let_(viewer),
            let_(stranger),
            let_(linker),
            let_(invited),
        ]);

        // Not on this server alone: a runner's linker, whom the owner did not choose for this server, invites to
        // what they have on their runner.
        assert.equal(policy.mayUse(linker, THIS_SERVER), false);
        assert.equal(policy.mayInvite(linker), true);
        assert.equal(policy.mayInvite(linker, "21"), true);

        assert.equal(policy.invites(guest), true);
        assert.equal(policy.mayInvite(guest), true);
        // To one session: their own, not one only shared with them.
        assert.equal(policy.mayInvite(guest, "10"), true);
        assert.equal(policy.mayInvite(guest, "11"), false);
        // The switch alone is not enough: a viewer never, someone invited to one session or not chosen here not to all.
        assert.equal(policy.invites(viewer), false);
        assert.equal(policy.mayInvite(viewer), false);
        assert.equal(policy.mayInvite(invited), false);
        assert.equal(policy.mayInvite(stranger), false);
    });

    it("lets nobody invite from a computer where they start nothing: a blocked runner, one they are not chosen for", () => {
        const let_ = (person: Person): Person => ({ ...person, rights: ["invites"] });
        // The linker was made a viewer, so the runner is blocked; the guest is chosen for it alone.
        const { policy } = world(
            [computer(THIS_SERVER, { chosen: [] }), computer("runner")],
            undefined,
            [owner, let_(guest), let_(stranger), { ...linker, role: "viewer" }],
        );

        assert.equal(policy.blocked("runner"), true);
        assert.equal(policy.mayUse(guest, "runner"), true);
        assert.equal(policy.mayInvite(guest), false);
        assert.equal(policy.mayInvite(stranger), false);

        // The same guest, once its linker prompts again.
        const open = world([computer(THIS_SERVER, { chosen: [] }), computer("runner")], undefined, [
            owner,
            let_(guest),
            let_(stranger),
            linker,
        ]).policy;

        assert.equal(open.mayInvite(guest), true);
        assert.equal(open.mayInvite(stranger), false);
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

    it("lets who is in charge allow a request from the app, and refuses anyone else", async () => {
        const methods = new ApprovalMethods(authenticators().auth);

        assert.equal(await methods.verify(owner, guest, { method: "owner" }, true), "owner");
        assert.equal(await methods.verify(linker, guest, { method: "owner" }, true), "owner");
        await assert.rejects(methods.verify(guest, guest, { method: "owner" }), { status: 403 });
        await assert.rejects(methods.verify(owner, guest, { method: "owner" }, false), {
            status: 403,
        });
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

describe("a person leaving a computer", () => {
    it("has no share there, while their share on another computer still counts", () => {
        const { policy } = world(
            [
                computer(THIS_SERVER, { chosen: [viewer.id], leaving: [guest.id] }),
                computer("runner"),
            ],
            [
                { id: "60", computer: THIS_SERVER, createdBy: owner.id, sharedWith: [guest.id] },
                { id: "61", computer: "runner", createdBy: linker.id, sharedWith: [guest.id] },
            ],
        );

        assert.equal(policy.maySee(guest, "60"), false);
        assert.equal(policy.maySteer(guest, "60"), false);
        assert.equal(policy.maySee(guest, "61"), true);
    });

    it("leaves a share with someone who was never chosen there", () => {
        const { policy } = world(
            [computer(THIS_SERVER, { chosen: [] })],
            [{ id: "60", computer: THIS_SERVER, createdBy: owner.id, sharedWith: [guest.id] }],
        );

        assert.equal(policy.maySee(guest, "60"), true);
    });
});
