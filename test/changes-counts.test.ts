// Adapted from Lucas Neuhaus's issue #57 regression cases.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { changesIn } from "../src/server/changes.ts";
import { type FolderAccess, localAccess } from "../src/server/folder-access.ts";
import type { ClientEntry } from "../src/server/projection.ts";

function fixture(firstCommit = true) {
    const root = mkdtempSync(join(tmpdir(), "pocket-counts-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");

    if (firstCommit) {
        writeFileSync(join(root, "tracked.txt"), "old\n");
        git("add", "tracked.txt");
        git("commit", "-qm", "baseline");
    }

    return { root, git };
}

const counts = (files: Awaited<ReturnType<typeof changesIn>>["files"]) =>
    files
        .map(({ path, added, removed }) => ({ path, added, removed }))
        .sort((a, b) => a.path.localeCompare(b.path));

test("new text and binary counts stay correct after staging, even with a large diff and tabbed path", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "tracked.txt"), "new\n");
    // Patch output exceeds the Git runner's buffer; summary counts must still work.
    writeFileSync(join(root, "large\tfile.txt"), `${"x".repeat(79)}\n`.repeat(16384));
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 10]));
    const expected = [
        { path: "binary.bin", added: undefined, removed: undefined },
        { path: "large\tfile.txt", added: 16384, removed: 0 },
        { path: "tracked.txt", added: 1, removed: 1 },
    ];

    assert.deepEqual(counts((await changesIn(root, [])).files), expected);
    git("add", "-A");
    assert.deepEqual(counts((await changesIn(root, [])).files), expected);
});

test("counts a file before the other stats finish, and preserves order and failures", async () => {
    const cwd = "/test";
    const paths = [
        "slow.txt",
        "missing.txt",
        "lost-count.txt",
        "fast.txt",
        ...Array.from({ length: 8 }, (_, i) => `extra-${i}.txt`),
    ];
    const release = Promise.withResolvers<void>();
    const counted: string[] = [];
    let active = 0;
    let peak = 0;
    const access: FolderAccess = {
        ...localAccess,
        id: "runner:test",
        async git(_cwd, args) {
            if (args.includes("--show-toplevel")) {
                return cwd + "\n";
            }

            if (args.includes("--abbrev-ref")) {
                return "main\n";
            }

            if (args[0] === "rev-parse") {
                return "head\n";
            }

            if (args[0] === "status") {
                return paths.map((path) => `?? ${path}\0`).join("");
            }

            if (!args.includes("--no-index")) {
                return "";
            }

            const path = args.at(-1)!;

            counted.push(path);

            if (path === "lost-count.txt") {
                throw new Error("the file became unreadable");
            }

            return `1\t0\t\0/dev/null\0${path}\0`;
        },
        async info(file) {
            peak = Math.max(peak, ++active);

            try {
                // Even a fast stat gives another stat a chance to start.
                await Promise.resolve();

                if (file.endsWith("/slow.txt")) {
                    await release.promise;
                }

                if (file.endsWith("/missing.txt")) {
                    throw new Error("no longer there");
                }

                return { kind: "file", size: 2, mtimeMs: 1 };
            } finally {
                active--;
            }
        },
    };
    const pending = changesIn(cwd, [], false, access);

    try {
        await setImmediate();
        assert.ok(counted.includes("fast.txt"));
        assert.ok(!counted.includes("slow.txt"));
        assert.ok(!counted.includes("missing.txt"));
    } finally {
        release.resolve();
    }

    const { files } = await pending;

    assert.equal(peak, 8);
    assert.deepEqual(
        files.map(({ path }) => path),
        paths,
    );
    assert.deepEqual(
        files.slice(0, 4).map(({ added, version }) => [added, version]),
        [
            [1, "2:1"],
            [undefined, undefined],
            [undefined, "2:1"],
            [1, "2:1"],
        ],
    );
});

test("bounds linked edit lookups and keeps the newest entry for a real path", async () => {
    const cwd = "/test";
    const paths = ["original", "alias", ...Array.from({ length: 8 }, (_, i) => `other-${i}`)];
    const release = Promise.withResolvers<void>();
    let peak = 0;
    let active = 0;
    const access: FolderAccess = {
        ...localAccess,
        id: "runner:test",
        async git(_cwd, args) {
            return args.includes("--show-toplevel") ? cwd + "\n" : "";
        },
        async realpath(path) {
            peak = Math.max(peak, ++active);

            try {
                await release.promise;

                return path.endsWith("/alias") ? join(cwd, "original") : path;
            } finally {
                active--;
            }
        },
    };
    const entries: ClientEntry[] = paths.map((path, id) => ({
        kind: "assistant",
        id: id + 1,
        blocks: [{ type: "toolCall", name: "write", id: path, args: { path } }],
    }));
    const pending = changesIn(cwd, entries, false, access);

    try {
        await setImmediate();
        assert.equal(active, 8);
    } finally {
        release.resolve();
    }

    const { piOnly } = await pending;

    assert.equal(peak, 8);
    assert.deepEqual(piOnly, [
        { path: "original", entryId: 2 },
        ...paths.slice(2).map((path, index) => ({ path, entryId: index + 3 })),
    ]);
});

test("before the first commit, staged and untracked files both have counts", async (t) => {
    const { root, git } = fixture(false);

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "staged.txt"), "one\ntwo\n");
    git("add", "staged.txt");
    writeFileSync(join(root, "fresh.txt"), "three");
    const changes = await changesIn(root, []);

    assert.deepEqual(counts(changes.files), [
        { path: "fresh.txt", added: 1, removed: 0 },
        { path: "staged.txt", added: 2, removed: 0 },
    ]);
});
