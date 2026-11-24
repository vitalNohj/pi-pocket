// How a person's sessions sit under the folders given to them, in the tree of the People and Runners sheets
// (`web/sheets/access-tree.js`). It follows the server's rules: which given folder holds a folder (`access.ts`
// `inFolder`), and which folder a session in a git worktree counts as working in (`app.ts` `#accessFolder`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { inFolder as serverInFolder } from "../src/server/access.ts";
// @ts-expect-error: a browser module, without types.
import * as tree from "../web/sheets/access-tree.js";

type Session = {
    id: number;
    cwd: string;
    createdBy?: string;
    worktree?: { path: string; branch: string; source: string };
};
type Placed = { folders: { folder: string; sessions: Session[] }[]; other: Session[] };

const inFolder = tree.inFolder as (folder: string, given: string) => boolean;
const accessFolder = tree.accessFolder as (session: Session, there: Session[]) => string;
const placed = tree.placed as (folders: string[], sessions: Session[], there: Session[]) => Placed;
const leaving = tree.leaving as (
    folder: string,
    folders: string[],
    started: Session[],
    there: Session[],
) => Session[];
const below = tree.below as (path: string, folder: string) => string;

/** One session as a list of them is searched, filtered, and ordered. */
type Row = {
    id: number;
    title?: string;
    places?: string[];
    has?: boolean;
    usedAt?: number;
    updatedAt?: number;
    starter?: string;
};
type Find = {
    words: string[];
    access: string;
    time: string;
    by: string;
    kept: Set<number>;
    now: number;
};

const wordsOf = tree.wordsOf as (query: string) => string[];
const matches = tree.matches as (words: string[], ...texts: (string | undefined)[]) => boolean;
const hitsOf = tree.hitsOf as (text: string, words: string[]) => number[];
const usedWithin = tree.usedWithin as (
    usedAt: number | undefined,
    time: string,
    now: number,
) => boolean;
const ago = tree.ago as (ms: number, now: number) => string;
const keeps = tree.keeps as (find: Find, row: Row) => boolean;
const keepsFolder = tree.keepsFolder as (find: Find, folder: string) => boolean;
const newest = tree.newest as (rows: Row[]) => Row[];
const orderOf = tree.orderOf as (rows: Row[]) => Map<number, number>;
const ranked = tree.ranked as (rows: Row[], order: Map<number, number>) => Row[];
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const ids = (list: Session[]) => list.map((each) => each.id);

test("a given folder holds itself and what is in it, as the server judges it", () => {
    const cases: [string, string][] = [
        ["/home/a/app", "/home/a/app"],
        ["/home/a/app/src", "/home/a/app"],
        ["/home/a/app/src", "/home/a/app/"],
        ["/home/a/application", "/home/a/app"],
        ["/home/a", "/home/a/app"],
        ["/anything", "/"],
        // The top folder holds paths alone: a remote workspace is in no folder.
        ["ssh://box/home/me", "/"],
        ["ssh://box/home/me", "//"],
        ["ssh://box/home/me", "\\"],
        ["\\\\host\\share", "\\"],
        ["/", "/"],
        ["C:\\Users\\a\\app\\src", "C:\\Users\\a\\app"],
        ["C:\\Users\\a\\apple", "C:\\Users\\a\\app"],
        ["C:\\Users\\a\\app/src", "C:\\Users\\a\\app"],
        ["D:\\work", "D:\\"],
        // Where paths start with `/`, `\` is a character of a name: a folder beside, not one inside.
        ["/home/a/app\\src", "/home/a/app"],
        ["/home/a/app/src", "/home/a/app\\"],
        ["/home/a/app\\/src", "/home/a/app\\"],
    ];

    for (const [folder, given] of cases) {
        assert.equal(
            inFolder(folder, given),
            serverInFolder(folder, given),
            `${folder} in ${given}`,
        );
    }

    assert.equal(inFolder("/home/a/app/src", "/home/a/app"), true);
    assert.equal(inFolder("/home/a/application", "/home/a/app"), false);
    assert.equal(inFolder("C:\\Users\\a\\app\\src", "C:\\Users\\a\\app"), true);
    assert.equal(inFolder("/home/a/app\\src", "/home/a/app"), false);
    assert.equal(inFolder("/home/a/app\\/src", "/home/a/app\\"), true);

    // So a session in the folder beside is not placed under the given one, and reads by its whole path.
    const beside: Session = { id: 9, cwd: "/home/a/app\\src" };
    const shape = placed(["/home/a/app"], [beside], [beside]);

    assert.deepEqual(ids(shape.folders[0]!.sessions), []);
    assert.deepEqual(ids(shape.other), [9]);
    assert.equal(below("/home/a/app\\src", "/home/a/app"), "/home/a/app\\src");
});

test("a session in a git worktree counts as in the folder the worktree came from", () => {
    const own: Session = {
        id: 1,
        cwd: "/data/worktrees/app-1",
        worktree: { path: "/data/worktrees/app-1", branch: "fix", source: "/home/a/app" },
    };
    // A copy that stayed in the first one's worktree keeps no worktree record of its own.
    const copy: Session = { id: 2, cwd: "/data/worktrees/app-1/src" };
    const plain: Session = { id: 3, cwd: "/home/a/notes" };
    const there = [own, copy, plain];

    assert.equal(accessFolder(own, there), "/home/a/app");
    assert.equal(accessFolder(copy, there), "/home/a/app");
    assert.equal(accessFolder(plain, there), "/home/a/notes");
    // The worktree of a session on another computer is not among `there`, and counts for nothing.
    assert.equal(accessFolder(copy, [copy, plain]), "/data/worktrees/app-1/src");
});

test("a session moved out of its worktree counts as in the folder it works in now", () => {
    const worktree = { path: "/data/worktrees/app-1", branch: "fix", source: "/home/a/app" };
    // The record of its worktree stays, to remove the worktree later, and places it nowhere.
    const moved: Session = { id: 1, cwd: "/home/b/other", createdBy: "gina", worktree };
    const inside: Session = { id: 2, cwd: "/data/worktrees/app-1/src", worktree };
    // One moved into another session's worktree counts as that worktree's folder.
    const other: Session = {
        id: 3,
        cwd: "/data/worktrees/web-2",
        worktree: { path: "/data/worktrees/web-2", branch: "b", source: "/home/a/web" },
    };
    const guest: Session = { id: 4, cwd: "/data/worktrees/web-2/src", worktree };
    const there = [moved, inside, other, guest];

    assert.equal(accessFolder(moved, there), "/home/b/other");
    assert.equal(accessFolder(inside, there), "/home/a/app");
    assert.equal(accessFolder(guest, there), "/home/a/web");

    // So the tree shows it under the folder it is in, and taking back the old folder does not take it.
    const shown = placed(["/home/a/app", "/home/b"], [moved, inside], there);

    assert.deepEqual(
        shown.folders.map((each) => [each.folder, ids(each.sessions)]),
        [
            ["/home/a/app", [2]],
            ["/home/b", [1]],
        ],
    );
    assert.deepEqual(ids(leaving("/home/a/app", ["/home/a/app", "/home/b"], [moved], there)), []);
    assert.deepEqual(ids(leaving("/home/b", ["/home/a/app", "/home/b"], [moved], there)), [1]);
});

test("each session shows once, under the deepest given folder that holds it; the rest are the others", () => {
    const sessions: Session[] = [
        { id: 1, cwd: "/home/a/app" },
        { id: 2, cwd: "/home/a/app/packages/web" },
        { id: 3, cwd: "/home/a/app/packages/web/src" },
        { id: 4, cwd: "/home/b/shared" },
        {
            id: 5,
            cwd: "/data/worktrees/app-5",
            worktree: { path: "/data/worktrees/app-5", branch: "x", source: "/home/a/app" },
        },
    ];
    const shape = placed(
        ["/home/a/app", "/home/a/app/packages/web", "/home/a/empty"],
        sessions,
        sessions,
    );

    assert.deepEqual(
        shape.folders.map((each) => [each.folder, ids(each.sessions)]),
        [
            ["/home/a/app", [1, 5]],
            ["/home/a/app/packages/web", [2, 3]],
            ["/home/a/empty", []],
        ],
    );
    assert.deepEqual(ids(shape.other), [4]);

    // No folders (a viewer, someone invited to one session): every session is among the others.
    assert.deepEqual(ids(placed([], sessions, sessions).other), [1, 2, 3, 4, 5]);
});

test("taking a folder back takes the sessions started in it that no other folder of theirs holds", () => {
    const started: Session[] = [
        { id: 1, cwd: "/home/a/app" },
        { id: 2, cwd: "/home/a/app/packages/web" },
        { id: 3, cwd: "/home/a/notes" },
    ];
    const folders = ["/home/a/app", "/home/a/app/packages/web", "/home/a/notes"];

    // The folder in it is still theirs, so the session there stays.
    assert.deepEqual(ids(leaving("/home/a/app", folders, started, started)), [1]);
    // The folder around it is still theirs, so nothing goes.
    assert.deepEqual(ids(leaving("/home/a/app/packages/web", folders, started, started)), []);
    assert.deepEqual(ids(leaving("/home/a/notes", folders, started, started)), [3]);
    assert.deepEqual(ids(leaving("/home/a/app", ["/home/a/app"], started, started)), [1, 2]);
});

test("a search finds a session by each word typed, in its name or in one of its folders", () => {
    assert.deepEqual(wordsOf("  Fix   the APP "), ["fix", "the", "app"]);
    assert.deepEqual(wordsOf("   "), []);

    // Every word must be found, each in any of the texts, whatever the case.
    assert.equal(matches(["fix", "app"], "Fix the runner", "/home/a/App"), true);
    assert.equal(matches(["fix", "docs"], "Fix the runner", "/home/a/app"), false);
    assert.equal(matches([], "anything"), true, "nothing typed finds everything");
    assert.equal(matches(["x"], "abc", undefined), false, "a text that is not there is no match");

    // The letters to mark: every place a word is found, and none where lower case has another length.
    assert.deepEqual(hitsOf("App in app", ["app"]), [0, 1, 2, 7, 8, 9]);
    assert.deepEqual(hitsOf("Fix it", ["it", "fix"]), [4, 5, 0, 1, 2]);
    assert.deepEqual(hitsOf("Fix it", []), []);
    assert.deepEqual(hitsOf("İstanbul app", ["app"]), [], "lower case is longer than the text");
});

test("the time filter asks when whoever reads last used a session themselves", () => {
    const at = (hours: number) => NOW - hours * HOUR;

    // Any time: every session, also one never used.
    assert.equal(usedWithin(at(900), "", NOW), true);
    assert.equal(usedWithin(undefined, "", NOW), true);

    // Within a number of hours: up to and with that hour.
    assert.equal(usedWithin(at(24), "24", NOW), true);
    assert.equal(usedWithin(at(25), "24", NOW), false);
    assert.equal(usedWithin(at(100), "168", NOW), true);
    assert.equal(usedWithin(undefined, "24", NOW), false, "one never used was not used lately");

    // Older than the longest time: used, and longer ago than that.
    assert.equal(usedWithin(at(721), "old", NOW), true);
    assert.equal(usedWithin(at(720), "old", NOW), false);
    assert.equal(usedWithin(undefined, "old", NOW), false, "never used is not old");

    // Never: only the ones with no use.
    assert.equal(usedWithin(undefined, "never", NOW), true);
    assert.equal(usedWithin(at(1), "never", NOW), false);

    // How long ago a row says it was.
    const minute = 60_000;

    assert.deepEqual(
        [
            0,
            0.5,
            1,
            59,
            60,
            1439,
            1440,
            13 * 1440,
            14 * 1440,
            364 * 1440,
            365 * 1440,
            800 * 1440,
        ].map((minutes) => ago(NOW - minutes * minute, NOW)),
        ["now", "now", "1m", "59m", "1h", "23h", "1d", "13d", "2w", "52w", "1y", "2y"],
    );
    assert.equal(ago(NOW + 5 * minute, NOW), "now", "a clock ahead is not a time ago");
});

test("a list keeps a session that passes the search and every filter, and one changed since", () => {
    const find = (patch: Partial<Find> = {}): Find => ({
        words: [],
        access: "",
        time: "",
        by: "",
        kept: new Set(),
        now: NOW,
        ...patch,
    });
    const row: Row = {
        id: 7,
        title: "Fix the runner link",
        places: ["/home/a/app/src", "/home/a/app"],
        has: true,
        usedAt: NOW - 2 * HOUR,
        starter: "gina",
    };

    assert.equal(keeps(find(), row), true);

    // The search: by its name, by the folder it works in, by the given folder over it.
    assert.equal(keeps(find({ words: ["runner"] }), row), true);
    assert.equal(keeps(find({ words: ["src"] }), row), true);
    assert.equal(keeps(find({ words: ["runner", "app"] }), row), true);
    assert.equal(keeps(find({ words: ["docs"] }), row), false);

    // Each filter alone.
    assert.equal(keeps(find({ access: "has" }), row), true);
    assert.equal(keeps(find({ access: "none" }), row), false);
    assert.equal(keeps(find({ access: "has" }), { ...row, has: false }), false);
    assert.equal(keeps(find({ access: "none" }), { ...row, has: false }), true);
    assert.equal(keeps(find({ time: "24" }), row), true);
    assert.equal(keeps(find({ time: "old" }), row), false);
    assert.equal(keeps(find({ by: "gina" }), row), true);
    assert.equal(keeps(find({ by: "mona" }), row), false);

    // Together: all of them must pass.
    assert.equal(
        keeps(find({ words: ["runner"], access: "has", time: "24", by: "gina" }), row),
        true,
    );
    assert.equal(
        keeps(find({ words: ["runner"], access: "has", time: "24", by: "mona" }), row),
        false,
    );

    // One changed since the search last changed stays, whatever it is now: it can be changed back where it stands.
    assert.equal(keeps(find({ access: "none", kept: new Set([7]) }), row), true);
    assert.equal(keeps(find({ words: ["docs"], kept: new Set([7]) }), row), true);
    assert.equal(keeps(find({ access: "none", kept: new Set([8]) }), row), false);

    // A folder with no session to list stays only where words alone are searched for, and its path has them.
    assert.equal(keepsFolder(find({ words: ["app"] }), "/home/a/app"), true);
    assert.equal(keepsFolder(find({ words: ["docs"] }), "/home/a/app"), false);
    assert.equal(keepsFolder(find(), "/home/a/app"), false, "nothing typed keeps no empty folder");
    assert.equal(keepsFolder(find({ words: ["app"], access: "has" }), "/home/a/app"), false);
    assert.equal(keepsFolder(find({ words: ["app"], time: "24" }), "/home/a/app"), false);
    assert.equal(keepsFolder(find({ words: ["app"], by: "gina" }), "/home/a/app"), false);
});

test("an open row lists the session whoever reads used last first, and keeps that order while it is open", () => {
    const rows: Row[] = [
        { id: 1, usedAt: 5, updatedAt: 9 },
        { id: 2, updatedAt: 50 },
        { id: 3, usedAt: 8, updatedAt: 1 },
        { id: 4, updatedAt: 70 },
        { id: 5 },
    ];
    const idsOf = (list: Row[]) => list.map((each) => each.id);

    // Used by the reader: the last use first. Never used: after those, the last activity first; with none, last.
    assert.deepEqual(idsOf(newest(rows)), [3, 1, 4, 2, 5]);
    assert.deepEqual(idsOf(rows), [1, 2, 3, 4, 5], "the list given is not changed");
    assert.deepEqual(
        [...orderOf(rows)],
        [
            [3, 0],
            [1, 1],
            [4, 2],
            [2, 3],
            [5, 4],
        ],
    );

    // Opened in that order: a session used since stays where it was, though it would now be first.
    const order = orderOf(rows);

    assert.deepEqual(
        idsOf(
            ranked(
                [
                    { id: 2, usedAt: 999 },
                    { id: 3, usedAt: 8 },
                    { id: 1, usedAt: 5 },
                ],
                order,
            ),
        ),
        [3, 1, 2],
    );
    // One that is gone leaves no gap; the ones that came since are last, the newest of them first.
    assert.deepEqual(
        idsOf(ranked([{ id: 9, usedAt: 1 }, { id: 4 }, { id: 8, usedAt: 2 }, { id: 3 }], order)),
        [3, 4, 8, 9],
    );
    // Opened with none: newest first.
    assert.deepEqual(
        idsOf(
            ranked(
                [
                    { id: 2, usedAt: 1 },
                    { id: 1, usedAt: 2 },
                ],
                new Map(),
            ),
        ),
        [1, 2],
    );
});

test("a session's folder reads as its place in the given folder", () => {
    assert.equal(below("/home/a/app", "/home/a/app"), "");
    assert.equal(below("/home/a/app", "/home/a/app/"), "");
    assert.equal(below("/home/a/app/packages/web", "/home/a/app"), "packages/web");
    assert.equal(below("C:\\Users\\a\\app\\src", "C:\\Users\\a\\app"), "src");
    assert.equal(below("/data/worktrees/app-1", "/home/a/app"), "/data/worktrees/app-1");
});

test("a folder they see every session in gives them the sessions in it, in what is in it, and in its worktrees", () => {
    const seenBy = tree.seenBy as (
        sees: string[],
        session: Session,
        there: Session[],
    ) => string | undefined;
    const own: Session = {
        id: 1,
        cwd: "/data/worktrees/app-1",
        worktree: { path: "/data/worktrees/app-1", branch: "fix", source: "/home/a/app" },
    };
    const copy: Session = { id: 2, cwd: "/data/worktrees/app-1/src" };
    const inside: Session = { id: 3, cwd: "/home/a/app/src" };
    const beside: Session = { id: 4, cwd: "/home/a/application" };
    const above: Session = { id: 5, cwd: "/home/a" };
    const there = [own, copy, inside, beside, above];

    for (const each of [own, copy, inside]) {
        assert.equal(seenBy(["/home/a/app"], each, there), "/home/a/app", String(each.id));
    }

    for (const each of [beside, above]) {
        assert.equal(seenBy(["/home/a/app"], each, there), undefined, String(each.id));
    }

    assert.equal(seenBy([], inside, there), undefined, "no such folder, no session");
    assert.equal(seenBy(["/other", "/home/a"], above, there), "/home/a");
});
