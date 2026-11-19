// Runner-side request checks (`src/runner/request-gate.ts`), using real frames and folders. The runner trusts its
// server on who may use which session; it still keeps each request inside the folder its session names.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import {
    FRAME,
    frame,
    readFrame,
    SESSION_FIELD,
    type SessionScope,
} from "../src/runner/protocol.ts";
import { RequestGate } from "../src/runner/request-gate.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-request-gate-"));

after(() => rmSync(root, { recursive: true, force: true }));

type Outcome = ReturnType<typeof readFrame> & { route: "send" | "reply" };

async function fixture(t: TestContext) {
    const dir = realpathSync(mkdtempSync(join(root, "gate-")));
    const folder = join(dir, "project");
    const outside = join(dir, "outside");
    const shared = join(dir, "shared");
    const temporary = join(dir, "tmp");

    for (const path of [folder, outside, shared, temporary]) {
        mkdirSync(path);
    }

    writeFileSync(join(folder, "file.txt"), "inside");
    writeFileSync(join(outside, "file.txt"), "outside");
    const a: SessionScope = { id: "10fc1ade-5001-4e35-8107-d1800dc80a9b", folder };
    const b: SessionScope = { id: "82c9e98d-d891-4e29-8978-76b8dc9304b9", folder };

    const sent: Buffer[] = [];
    const replies: Buffer[] = [];
    const pending = new Map<number, (outcome: Outcome) => void>();

    const collect = (route: Outcome["route"], frames: Buffer[]) => (whole: Buffer) => {
        frames.push(whole);
        const parsed = readFrame(whole);
        const resolve = pending.get(parsed.id);

        pending.delete(parsed.id);
        resolve?.({ ...parsed, route });
    };

    const gate = new RequestGate({
        send: collect("send", sent),
        reply: collect("reply", replies),
        shared: async () => [shared],
        tmpdir: async () => temporary,
        name: () => "Test computer",
    });
    let nextId = 1;

    t.after(() => gate.stop());

    function request(
        json: Record<string, unknown>,
        scope: SessionScope | null = a,
        payload?: Uint8Array,
    ): Promise<Outcome> {
        const id = nextId++;
        const outcome = Promise.withResolvers<Outcome>();

        pending.set(id, outcome.resolve);
        gate.input(
            frame(
                FRAME.request,
                id,
                { ...json, ...(scope === null ? {} : { [SESSION_FIELD]: scope }) },
                payload,
            ),
        );

        return outcome.promise;
    }

    return { gate, request, a, b, folder, outside, shared, sent, replies };
}

function refused(outcome: Outcome, message: RegExp): void {
    assert.equal(outcome.route, "reply");
    assert.equal(outcome.type, FRAME.error);
    assert.equal(outcome.json.code, "EACCES");
    assert.match(String(outcome.json.message), message);
}

describe("runner RequestGate", () => {
    it("refuses a request without its session field", async (t) => {
        const { request, folder, sent } = await fixture(t);
        const outcome = await request({ op: "open", path: join(folder, "file.txt") }, null);

        refused(outcome, /A session on Test computer is required/);
        assert.deepEqual(sent, []);
    });

    for (const op of ["hello", "lstat", "realpath", "opendir"]) {
        it(`allows the listing operation ${op} without a session`, async (t) => {
            const { request, outside, replies } = await fixture(t);
            const json = op === "hello" ? { op } : { op, path: outside };
            const outcome = await request(json, null);

            assert.equal(outcome.route, "send");
            assert.equal(outcome.type, FRAME.request);
            assert.deepEqual(outcome.json, json);
            assert.deepEqual(replies, []);
        });
    }

    it("lets an unscoped folder listing use and close its directory handle", async (t) => {
        const { gate, request, outside } = await fixture(t);
        const opened = await request({ op: "opendir", path: outside }, null);

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        assert.equal((await request({ op: "readdir", handle: 41 }, null)).route, "send");
        assert.equal((await request({ op: "close", handle: 41 }, null)).route, "send");
    });

    it("forwards an approved request and payload after removing only the session field", async (t) => {
        const { request, folder, replies } = await fixture(t);
        const json = { op: "open", path: join(folder, "file.txt"), flags: "r" };
        const payload = Uint8Array.of(0, 255, 1);
        const outcome = await request(json, undefined, payload);

        assert.equal(outcome.route, "send");
        assert.equal(outcome.type, FRAME.request);
        assert.deepEqual(outcome.json, json);
        assert.equal(Object.hasOwn(outcome.json, SESSION_FIELD), false);
        assert.deepEqual(outcome.payload, payload);
        assert.deepEqual(replies, []);
    });

    it("refuses a path outside the approved folder", async (t) => {
        const { request, outside, sent } = await fixture(t);
        const outcome = await request({ op: "open", path: join(outside, "file.txt") });

        refused(outcome, /outside the session's folder/);
        assert.deepEqual(sent, []);
    });

    it("does not confuse a sibling with the same path prefix for an approved child", async (t) => {
        const { request, folder, sent } = await fixture(t);
        const sibling = `${folder}-other`;

        mkdirSync(sibling);
        refused(await request({ op: "open", path: join(sibling, "new.txt") }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("refuses a rename destination outside the approved folder", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const outcome = await request({
            op: "rename",
            path: join(folder, "file.txt"),
            to: join(outside, "renamed.txt"),
        });

        refused(outcome, /outside the session's folder/);
        assert.deepEqual(sent, []);
    });

    it("checks every target instead of only the request's main path", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const outcome = await request({
            op: "watch",
            path: folder,
            targets: [{ path: join(folder, "file.txt") }, { path: join(outside, "file.txt") }],
        });

        refused(outcome, /outside the session's folder/);
        assert.deepEqual(sent, []);
    });

    it("allows a missing child when its existing ancestors are inside the folder", async (t) => {
        const { request, folder } = await fixture(t);
        const outcome = await request({ op: "mkdir", path: join(folder, "new", "child") });

        assert.equal(outcome.route, "send");
    });

    it("refuses an existing symlink in the folder that resolves outside it", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const link = join(folder, "escape");

        symlinkSync(outside, link, "dir");
        refused(await request({ op: "open", path: join(link, "file.txt") }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("refuses a missing child below a symlink to an outside folder", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const link = join(folder, "escape");

        symlinkSync(outside, link, "dir");
        refused(await request({ op: "mkdir", path: join(link, "missing", "child") }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("refuses a file handle opened by another session even in the same folder", async (t) => {
        const { gate, request, folder, b, sent } = await fixture(t);
        const opened = await request({ op: "open", path: join(folder, "file.txt") });

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        const outcome = await request({ op: "pread", handle: 41, length: 10 }, b);

        refused(outcome, /The handle belongs to another session/);
        assert.equal(sent.length, 1);
    });

    it("allows an opened file handle to be used by its own session", async (t) => {
        const { gate, request, folder } = await fixture(t);
        const opened = await request({ op: "open", path: join(folder, "file.txt") });

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        const outcome = await request({ op: "pread", handle: 41, length: 10 });

        assert.equal(outcome.route, "send");
        assert.deepEqual(outcome.json, { op: "pread", handle: 41, length: 10 });
    });

    it("refuses a target request owned by another session", async (t) => {
        const { request, b, sent } = await fixture(t);
        const running = await request({ op: "exec", command: "printf ok" });
        const outcome = await request(
            { op: "ptyResize", target: running.id, cols: 80, rows: 24 },
            b,
        );

        refused(outcome, /The request belongs to another session/);
        assert.equal(sent.length, 1);
    });

    it("allows a target request owned by the same session", async (t) => {
        const { request } = await fixture(t);
        const running = await request({ op: "exec", command: "printf ok" });
        const outcome = await request({ op: "ptyResize", target: running.id, cols: 80, rows: 24 });

        assert.equal(outcome.route, "send");
        assert.equal(outcome.json.target, running.id);
    });

    it("refuses a request pi-env does not send", async (t) => {
        const { request, sent } = await fixture(t);
        const outcome = await request({ op: "chmod", path: "/etc/passwd" });

        refused(outcome, /does not know the request "chmod"/);
        assert.equal(sent.length, 0);
    });

    it("refuses pi-env 1.5.2's program requests, which Pi Pocket does not use", async (t) => {
        const { request, sent, folder } = await fixture(t);

        // A program with plain pipes runs anywhere its `argv` says: no field here is checked against the folder.
        for (const json of [
            { op: "process", argv: ["cat", "/etc/passwd"], cwd: folder, env: {}, inheritEnv: true },
            { op: "processWrite", target: 1 },
            { op: "processCloseStdin", target: 1 },
        ]) {
            refused(await request(json), new RegExp(`does not know the request "${json.op}"`));
        }

        assert.equal(sent.length, 0);
    });

    it("lets only the request's own session cancel it", async (t) => {
        const { gate, request, a, b, sent } = await fixture(t);
        const running = await request({ op: "exec", command: "printf ok" });
        const before = sent.length;

        gate.input(frame(FRAME.cancel, running.id, { [SESSION_FIELD]: b }));
        assert.equal(sent.length, before, "another session's cancel does not reach the daemon");

        gate.input(frame(FRAME.cancel, running.id, {}));
        assert.equal(sent.length, before, "a cancel with no session neither");

        gate.input(frame(FRAME.cancel, running.id, { [SESSION_FIELD]: a }));
        assert.equal(sent.length, before + 1, "its own session's cancel does");
        assert.equal(readFrame(sent.at(-1)!).type, FRAME.cancel);
        assert.equal(readFrame(sent.at(-1)!).json[SESSION_FIELD], undefined, "without the field");
    });

    it("fills a command's missing cwd with the session's approved folder", async (t) => {
        const { request, folder } = await fixture(t);
        const outcome = await request({ op: "exec", command: "printf ok" });

        assert.equal(outcome.route, "send");
        assert.deepEqual(outcome.json, { op: "exec", command: "printf ok", cwd: folder });
    });

    it("refuses an explicit command cwd outside the approved folder", async (t) => {
        const { request, outside, sent } = await fixture(t);

        refused(await request({ op: "exec", command: "printf ok", cwd: outside }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("allows the runner's shared folder without granting other outside paths", async (t) => {
        const { request, shared, outside } = await fixture(t);

        assert.equal(
            (await request({ op: "open", path: join(shared, "attachment") })).route,
            "send",
        );
        refused(await request({ op: "open", path: join(outside, "file.txt") }), /outside/);
    });
});
