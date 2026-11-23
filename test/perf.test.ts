import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const probe = `
    import assert from 'node:assert/strict';
    import { perf } from ${JSON.stringify(new URL("../src/perf.ts", import.meta.url).href)};
    assert.equal(perf !== undefined, process.env.PI_POCKET_PERF === '1');
    await perf?.operation('test-op', {}, async () => {
        await Promise.resolve();
        perf.log('test-event', { parent: perf.current(), bytes: 8 });
    });
`;

test("perf logging is off by default and writes JSON lines when enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-perf-test-"));
    const file = join(dir, "perf.jsonl");
    const env: NodeJS.ProcessEnv = { ...process.env, PI_POCKET_PERF_FILE: file };

    delete env.PI_POCKET_PERF;

    try {
        execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { env });
        assert.equal(existsSync(file), false);

        execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
            env: { ...env, PI_POCKET_PERF: "1" },
        });
        const [event, span] = readFileSync(file, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));

        assert.equal(event.kind, "test-event");
        assert.equal(event.bytes, 8);
        assert.equal(span.kind, "operation");
        assert.equal(span.op, "test-op");
        assert.equal(span.span, event.parent);
        assert.ok(span.ms >= 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
