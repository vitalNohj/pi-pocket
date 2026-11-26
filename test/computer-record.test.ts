// One record for a computer (`config.ts` `ComputerAccess`): this server's and a runner's are read through
// `ConfigStore.computer` and written through one path, by the same methods with the computer's id. Each test runs on
// both, on a store of its own with no app around it, and reads `config.json` itself where the saved shape matters.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { ConfigStore } from "../src/server/config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-computer-record-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

type Kind = "this server" | "a runner";

/**
 * A new store with two people to choose (Ana, Bo), one held to a session, and the computer of `kind`. On a runner,
 * Lin, a guest, linked it and is in charge of it; on this server, the owner is.
 */
function setUp(kind: Kind) {
    const directory = mkdtempSync(join(root, "data-"));
    const config = new ConfigStore(directory);
    const owner = config.users.find((each) => each.role === "owner")!.id;
    const ana = config.addUser("Ana", "guest").user.id;
    const bo = config.addUser("Bo", "guest").user.id;
    const held = config.addUser("Held", "guest", ["a-session"]).user.id;
    const lin = config.addUser("Lin", "guest").user.id;
    const id = kind === "this server" ? THIS_SERVER : config.addRunner("Laptop", lin, "key").id;

    return {
        directory,
        config,
        id,
        ana,
        bo,
        held,
        inCharge: kind === "this server" ? owner : lin,
    };
}

/** `config.json` as saved. */
function saved(config: ConfigStore): {
    server?: Record<string, unknown>;
    runners?: Record<string, unknown>[];
} {
    return JSON.parse(readFileSync(config.file, "utf8")) as never;
}

/** The computer's record as saved: `server`, or the runner's entry. */
function savedRecord(config: ConfigStore, id: string): Record<string, unknown> | undefined {
    const file = saved(config);

    return id === THIS_SERVER ? file.server : file.runners?.find((each) => each.id === id);
}

const kinds: Kind[] = ["this server", "a runner"];

describe("choosing the people of a computer", () => {
    for (const kind of kinds) {
        it(`on ${kind}: keeps the chosen, leaves out who is in charge, and marks who it drops as leaving`, () => {
            const { config, id, ana, bo, held, inCharge } = setUp(kind);

            config.setUsers(id, [ana, bo, inCharge, "no-such-person", held, ana]);
            assert.deepEqual(config.computer(id)?.users, [ana, bo]);
            assert.deepEqual(config.leaving(id), []);
            assert.equal(config.setComputerRight(id, bo, "wheel", true), true);
            assert.deepEqual(config.rightHolders(id, "wheel"), [bo]);

            config.setUsers(id, [ana]);
            assert.deepEqual(config.computer(id)?.users, [ana]);
            assert.deepEqual(config.leaving(id), [bo]);
            assert.deepEqual(config.rightHolders(id, "wheel"), [], "their rights there are gone");
            assert.deepEqual(savedRecord(config, id)?.leaving, [bo], "marked in that same save");
            assert.equal(savedRecord(config, id)?.rights, undefined);
        });
    }

    it("on this server: leaves out a second owner too", () => {
        const { config, ana } = setUp("this server");
        const second = config.addUser("Second", "owner").user.id;

        config.setUsers(THIS_SERVER, [ana, second]);
        assert.deepEqual(config.computer(THIS_SERVER)?.users, [ana]);
    });
});

describe("the folders given on a computer", () => {
    for (const kind of kinds) {
        it(`on ${kind}: are given, seen, and taken back, which owes a hand-over`, () => {
            const { config, id, ana, inCharge } = setUp(kind);

            config.setUsers(id, [ana]);
            config.setGivenFolders(id, ana, ["/a", "/b", "/a"], inCharge);
            assert.deepEqual(config.givenFolders(id, ana), ["/a", "/b"]);
            assert.deepEqual(config.givenBy(id, ana), { "/a": inCharge, "/b": inCharge });
            assert.deepEqual(config.handOvers(id), [], "giving owes nothing");

            assert.equal(config.setSeenFolder(id, ana, "/a", true), true);
            assert.deepEqual(config.seenFolders(id, ana), ["/a"]);
            assert.equal(config.setSeenFolder(id, ana, "/c", true), false, "a folder not given");
            assert.deepEqual(config.seenFolders(id, ana), ["/a"]);

            config.setGivenFolders(id, ana, ["/b"]);
            assert.deepEqual(config.givenFolders(id, ana), ["/b"]);
            assert.deepEqual(config.givenBy(id, ana), { "/b": inCharge }, "kept who gave it");
            assert.deepEqual(config.seenFolders(id, ana), [], "no longer seen: no longer given");
            assert.deepEqual(config.handOvers(id), [ana], "taking it back owes a hand-over");
            assert.deepEqual(savedRecord(config, id)?.handOver, [ana], "marked in that same save");
        });

        it(`on ${kind}: turning a folder off owes a hand-over`, () => {
            const { config, id, ana } = setUp(kind);

            config.setUsers(id, [ana]);
            config.setGivenFolders(id, ana, ["/a"]);
            config.setSeenFolder(id, ana, "/a", true);
            assert.deepEqual(config.handOvers(id), [], "turning it on owes nothing");
            assert.equal(config.setSeenFolder(id, ana, "/a", false), true);
            assert.deepEqual(config.seenFolders(id, ana), []);
            assert.deepEqual(config.handOvers(id), [ana]);
        });
    }
});

describe("a folder's level on a computer", () => {
    /** What Ana has of /a: the level, and both times. */
    const state = (config: ConfigStore, id: string, ana: string) => ({
        level: config.folderLevel(id, ana, "/a"),
        until: config.seenUntil(id, ana)["/a"],
        from: config.seenFrom(id, ana)["/a"],
    });

    /** A store where Ana uses the computer and has /a at `level`, set at time 100, with no hand-over owed. */
    const at = (kind: Kind, level: "start" | "past" | "new" | "all") => {
        const made = setUp(kind);

        made.config.setUsers(made.id, [made.ana]);
        made.config.setFolderLevel(made.id, made.ana, "/a", level, 100, made.inCharge);
        made.config.clearHandOvers(made.id, made.config.handOvers(made.id));

        return made;
    };

    for (const kind of kinds) {
        it(`on ${kind}: each move between the levels leaves the right times`, () => {
            const moves = [
                ["start", "new", { level: "new", until: undefined, from: 200 }],
                ["all", "new", { level: "new", until: undefined, from: 200 }],
                ["past", "new", { level: "new", until: undefined, from: 200 }],
                ["new", "past", { level: "past", until: 200, from: undefined }],
                ["all", "past", { level: "past", until: 200, from: undefined }],
                ["past", "all", { level: "all", until: undefined, from: undefined }],
                ["new", "all", { level: "all", until: undefined, from: undefined }],
                ["new", "start", { level: "start", until: undefined, from: undefined }],
                ["past", "start", { level: "start", until: undefined, from: undefined }],
                ["new", "none", { level: "none", until: undefined, from: undefined }],
                ["past", "none", { level: "none", until: undefined, from: undefined }],
            ] as const;

            for (const [before, after, expected] of moves) {
                const { config, id, ana } = at(kind, before);

                config.setFolderLevel(id, ana, "/a", after, 200);
                assert.deepEqual(state(config, id, ana), expected, `${before} to ${after}`);
            }

            // A new level takes the time it is set at.
            const { config, id, ana } = at(kind, "new");

            assert.deepEqual(state(config, id, ana), { level: "new", until: undefined, from: 100 });
            assert.deepEqual(
                (savedRecord(config, id)?.seesFrom as Record<string, unknown>)[ana],
                { "/a": 100 },
                "saved in the file",
            );
        });

        it(`on ${kind}: New sessions set again keeps its time; so does Current sessions`, () => {
            for (const level of ["new", "past"] as const) {
                const { config, id, ana } = at(kind, level);

                config.setFolderLevel(id, ana, "/a", level, 500);
                assert.equal(state(config, id, ana)[level === "new" ? "from" : "until"], 100);
            }
        });

        it(`on ${kind}: New sessions from All or Current sessions owes a hand-over; from Start, and All from New, not`, () => {
            for (const [before, after, owed] of [
                ["all", "new", true],
                ["past", "new", true],
                ["start", "new", false],
                ["new", "all", false],
                ["new", "past", false],
                ["new", "start", true],
            ] as const) {
                const { config, id, ana } = at(kind, before);

                config.setFolderLevel(id, ana, "/a", after, 200);
                assert.deepEqual(config.handOvers(id), owed ? [ana] : [], `${before} to ${after}`);

                if (owed) {
                    assert.deepEqual(savedRecord(config, id)?.handOver, [ana], "in that same save");
                }
            }
        });

        it(`on ${kind}: a folder no longer seen loses its time, and the switch on is every session`, () => {
            const { config, id, ana } = at(kind, "new");

            // Taken back with the list of folders: no time stays behind.
            config.setGivenFolders(id, ana, ["/b"]);
            assert.deepEqual(config.seenFrom(id, ana), {});
            assert.equal(savedRecord(config, id)?.seesFrom, undefined, "no record left");

            // The switch on: no time of either kind.
            const again = at(kind, "new");

            again.config.setSeenFolder(again.id, again.ana, "/a", true);
            assert.deepEqual(state(again.config, again.id, again.ana), {
                level: "all",
                until: undefined,
                from: undefined,
            });

            // The switch off: neither.
            const off = at(kind, "new");

            off.config.setSeenFolder(off.id, off.ana, "/a", false);
            assert.deepEqual(off.config.seenFrom(off.id, off.ana), {});
            assert.equal(off.config.folderLevel(off.id, off.ana, "/a"), "start");
        });
    }
});

describe("a right on a computer", () => {
    for (const kind of kinds) {
        it(`on ${kind}: is given to a chosen person only, and both reads agree`, () => {
            const { config, id, ana, bo } = setUp(kind);

            config.setUsers(id, [ana]);
            assert.equal(config.setComputerRight(id, ana, "allows", true), true);

            const before = readFileSync(config.file);

            assert.equal(
                config.setComputerRight(id, bo, "allows", true),
                false,
                "Bo is not chosen",
            );
            assert.deepEqual(readFileSync(config.file), before, "and nothing changed");
            assert.deepEqual(config.rightHolders(id, "allows"), [ana]);
            assert.deepEqual(config.rightsOn(id), {
                manages: [],
                wheel: [],
                allows: [ana],
                reshares: [],
            });

            assert.equal(config.setComputerRight(id, ana, "allows", false), true);
            assert.deepEqual(config.rightHolders(id, "allows"), []);
            assert.deepEqual(config.rightsOn(id), {
                manages: [],
                wheel: [],
                allows: [],
                reshares: [],
            });
        });
    }
});

describe("the marks on a computer", () => {
    for (const kind of kinds) {
        it(`on ${kind}: end when they are cleared, and an empty clear saves nothing`, () => {
            const { config, id, ana, bo } = setUp(kind);

            config.setUsers(id, [ana, bo]);
            config.setGivenFolders(id, ana, ["/a"]);
            config.setGivenFolders(id, ana, []);
            config.setUsers(id, []);
            assert.deepEqual(config.leaving(id), [ana, bo]);
            assert.deepEqual(config.handOvers(id), [ana]);

            config.clearLeaving(id, [ana]);
            assert.deepEqual(config.leaving(id), [bo]);
            config.clearLeaving(id, [bo]);
            assert.deepEqual(config.leaving(id), []);
            assert.equal(savedRecord(config, id)?.leaving, undefined);

            config.clearHandOvers(id, [ana]);
            assert.deepEqual(config.handOvers(id), []);
            assert.equal(savedRecord(config, id)?.handOver, undefined);

            const file = statSync(config.file).ino;

            config.clearLeaving(id, [ana]);
            config.clearHandOvers(id, [ana]);
            assert.equal(statSync(config.file).ino, file, "nobody to clear: not saved");
        });
    }
});

describe("a computer that does not exist", () => {
    it("reads empty, and every change does nothing to the file", () => {
        const { config, ana, inCharge } = setUp("a runner");
        const id = "no-such-runner";
        const before = readFileSync(config.file);
        const file = statSync(config.file).ino;

        assert.equal(config.computer(id), undefined);
        assert.equal(config.linkerOf(id), undefined);
        assert.deepEqual(config.leaving(id), []);
        assert.deepEqual(config.handOvers(id), []);
        assert.deepEqual(config.rightHolders(id, "wheel"), []);
        assert.deepEqual(config.rightsOn(id), { manages: [], wheel: [], allows: [], reshares: [] });
        assert.deepEqual(config.givenFolders(id, ana), []);
        assert.deepEqual(config.givenBy(id, ana), {});
        assert.deepEqual(config.seenFolders(id, ana), []);
        assert.deepEqual(config.sharesNew(id, inCharge), []);

        config.setUsers(id, [ana]);
        config.clearLeaving(id, [ana]);
        config.clearHandOvers(id, [ana]);
        assert.equal(config.setComputerRight(id, ana, "wheel", true), false);
        config.setGivenFolders(id, ana, ["/a"], inCharge);
        assert.equal(config.setSeenFolder(id, ana, "/a", true), false);
        config.setSharesNew(id, inCharge, ana, true);
        config.setComputerSettings(id, { network: false, downloads: "/d" });

        assert.equal(config.computer(id), undefined);
        assert.deepEqual(readFileSync(config.file), before, "the file is as it was");
        assert.equal(statSync(config.file).ino, file, "and was not saved");
    });
});

describe("the saved shape", () => {
    it("on this server: no people and nothing else leaves no record", () => {
        const { config, ana } = setUp("this server");

        config.setUsers(THIS_SERVER, []);
        assert.equal("server" in saved(config), false);

        config.setUsers(THIS_SERVER, [ana]);
        assert.deepEqual(saved(config).server, { users: [ana] });
        config.setUsers(THIS_SERVER, []);
        assert.deepEqual(saved(config).server, { leaving: [ana] }, "no empty list of people");
        config.clearLeaving(THIS_SERVER, [ana]);
        assert.equal("server" in saved(config), false);
    });

    it("on a runner: no people keeps an empty list", () => {
        const { config, id, ana } = setUp("a runner");

        config.setUsers(id, []);
        assert.deepEqual(savedRecord(config, id)?.users, []);

        config.setUsers(id, [ana]);
        config.setUsers(id, []);
        assert.deepEqual(savedRecord(config, id)?.users, []);
        assert.deepEqual(savedRecord(config, id)?.leaving, [ana]);
    });
});

describe("a second store on the same folder", () => {
    for (const kind of kinds) {
        it(`on ${kind}: reads back what the first wrote`, () => {
            const { directory, config, id, ana, bo, inCharge } = setUp(kind);

            config.setUsers(id, [ana, bo]);
            config.setGivenFolders(id, ana, ["/a", "/b"], inCharge);
            config.setSeenFolder(id, ana, "/b", true);
            config.setComputerRight(id, bo, "reshares", true);
            config.setSharesNew(id, inCharge, ana, true);
            config.setSharesNew(id, inCharge, ana, true);
            config.setSharesNew(id, inCharge, bo, true);
            config.setSharesNew(id, bo, ana, true);

            const next = new ConfigStore(directory);

            assert.deepEqual(next.computer(id)?.users, [ana, bo]);
            assert.deepEqual(next.givenFolders(id, ana), ["/a", "/b"]);
            assert.deepEqual(next.givenBy(id, ana), { "/a": inCharge, "/b": inCharge });
            assert.deepEqual(next.seenFolders(id, ana), ["/b"]);
            assert.deepEqual(next.rightHolders(id, "reshares"), [bo]);
            assert.deepEqual(next.sharesNew(id, inCharge), [ana, bo]);
            assert.deepEqual(next.sharesNew(id, bo), [ana]);
            assert.equal(next.linkerOf(id), inCharge);

            next.setSharesNew(id, inCharge, ana, false);
            next.setSharesNew(id, inCharge, bo, false);
            assert.deepEqual(savedRecord(next, id)?.sharesNew, { [bo]: [ana] });
            next.setSharesNew(id, bo, ana, false);
            assert.equal(savedRecord(next, id)?.sharesNew, undefined);
        });
    }
});
