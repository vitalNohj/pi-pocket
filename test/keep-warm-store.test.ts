import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { idleFiles, type IdleRecord } from "../src/server/keep-warm-store.ts";

test("keep warm files: an edited or damaged record is never warmed, and leaves nothing behind", async () => {
    const folder = await mkdtemp(join(tmpdir(), "keep-warm-"));

    try {
        const store = idleFiles(
            folder,
            () => {},
            () => 2_000_000,
        );
        const record: IdleRecord = {
            version: 1,
            key: "s",
            conversationId: 3,
            provider: "anthropic",
            modelId: "m",
            messages: [],
            options: { sessionId: "s", apiKey: "planted", headers: { x: "1" } },
            promptTokens: 10,
            payloadHash: "h",
            lastTouch: 1_000_000,
            since: 1_000_000,
            warms: 0,
            spent: 0,
            failures: 0,
        };

        store.save(record, true);
        store.save({ ...record, key: "t", options: { sessionId: "t" }, warms: -5 }, true);
        await store.flush();
        await writeFile(join(folder, "orphan.context.json"), "[]");
        await writeFile(join(folder, "cut.json.tmp"), "{");

        const loaded = await store.load();

        assert.equal(loaded.length, 1, "the record with a negative count is dropped");
        assert.deepEqual(loaded[0]?.options, { sessionId: "s" }, "no key, headers, or address");
        assert.equal(
            (await readdir(folder)).length,
            2,
            "only the good record's two files are left",
        );
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});
