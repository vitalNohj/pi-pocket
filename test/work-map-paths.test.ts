import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreesInCall } from "../src/server/work-map.ts";

test("a tool call credits work to macOS temporary folders and mounted volumes", () => {
    const worktrees = [
        "/private/var/folders/q2/example/T/shop",
        "/var/folders/q2/example/T/shop-alias",
        "/private/tmp/lab",
        "/Volumes/SSD/shop-checkout",
    ];
    const command = `ls ${worktrees.map((folder) => `${folder}/cart.ts`).join(" ")}`;
    const worktreeOf = (path: string) =>
        worktrees.find((folder) => `${folder}/cart.ts` === path) ?? null;

    assert.deepEqual(
        worktreesInCall(JSON.stringify({ command }), "/Users/test", worktreeOf),
        new Set(worktrees),
    );
});
