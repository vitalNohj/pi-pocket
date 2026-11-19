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
const ids = (list: Session[]) => list.map((each) => each.id);

test("a given folder holds itself and what is in it, as the server judges it", () => {
    const cases: [string, string][] = [
        ["/home/a/app", "/home/a/app"],
        ["/home/a/app/src", "/home/a/app"],
        ["/home/a/app/src", "/home/a/app/"],
        ["/home/a/application", "/home/a/app"],
        ["/home/a", "/home/a/app"],
        ["/anything", "/"],
        ["C:\\Users\\a\\app\\src", "C:\\Users\\a\\app"],
        ["C:\\Users\\a\\apple", "C:\\Users\\a\\app"],
        ["D:\\work", "D:\\"],
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
