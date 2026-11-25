// Whether git and GitHub are ready on this server (`src/server/server-tools.ts`): one check at a time, its answer used
// again for a minute, and a check that failed not kept.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerTools } from "../src/server/runner-link/protocol.ts";
import { ServerTools } from "../src/server/server-tools.ts";

const READY: RunnerTools = { git: true, gh: true, github: false };

/** A check that counts its runs, and answers when `answer` is called; a clock the test moves. */
function counted() {
    let runs = 0;
    let now = 1_000;
    const waiting: { resolve: (tools: RunnerTools) => void; reject: (error: Error) => void }[] = [];
    const tools = new ServerTools(
        () => {
            runs++;

            return new Promise<RunnerTools>((resolve, reject) => waiting.push({ resolve, reject }));
        },
        () => now,
    );

    return {
        tools,
        runs: () => runs,
        later: (ms: number) => {
            now += ms;
        },
        answer: (result: RunnerTools | Error = READY) => {
            const next = waiting.shift()!;

            if (result instanceof Error) {
                next.reject(result);
            } else {
                next.resolve(result);
            }
        },
    };
}

describe("this server's tools", () => {
    it("checks once for two reads within a minute, and again after it", async () => {
        const check = counted();
        const first = check.tools.read();

        check.answer();
        assert.deepEqual(await first, READY);
        check.later(59_999);

        const kept = check.tools.read();

        assert.equal(check.runs(), 1, "the answer is used again");
        assert.deepEqual(await kept, READY);

        check.later(1);

        const again = check.tools.read();

        assert.equal(check.runs(), 2, "a minute later it checks again");
        check.answer({ git: false, gh: false, github: false });
        assert.deepEqual(await again, { git: false, gh: false, github: false });
    });

    it("shares one check between reads at once", async () => {
        const check = counted();
        const one = check.tools.read();
        const other = check.tools.read();

        assert.equal(check.runs(), 1);
        check.answer();
        assert.deepEqual(await Promise.all([one, other]), [READY, READY]);
    });

    it("does not keep a check that failed: the next read checks again", async () => {
        const check = counted();
        const failed = check.tools.read();

        check.answer(new Error("no shell"));
        await assert.rejects(failed, /no shell/);

        const next = check.tools.read();

        assert.equal(check.runs(), 2);
        check.answer();
        assert.deepEqual(await next, READY);
    });
});
