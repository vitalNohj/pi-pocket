// Runner-side request authorization (`src/runner/request-gate.ts`), using real frames and folders.
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { Approvals, type SessionScope } from "../src/runner/approvals.ts";
import { RunnerRequestTiming } from "../src/runner/perf.ts";
import { FRAME, frame, readFrame, SESSION_FIELD } from "../src/runner/protocol.ts";
import { canonical, RequestGate } from "../src/runner/request-gate.ts";
import type { RunnerSettings } from "../src/runner/runner.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-request-gate-"));

after(() => rmSync(root, { recursive: true, force: true }));

type Outcome = ReturnType<typeof readFrame> & { route: "send" | "reply" };

async function fixture(
    t: TestContext,
    options: {
        approved?: boolean;
        answer?: boolean | ((signal: AbortSignal) => Promise<boolean>);
        resolvePath?: typeof canonical;
        onSend?: (outgoing: ReturnType<typeof readFrame>) => void;
        shared?: (id: string) => Promise<void>;
    } = {},
) {
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
    let settings: RunnerSettings = {};
    const approvals = new Approvals(
        () => settings,
        (change) => {
            settings = { ...settings, ...change };
        },
    );
    const a: SessionScope = { id: "10fc1ade-5001-4e35-8107-d1800dc80a9b", folder, person: "Alice" };
    const b: SessionScope = { id: "82c9e98d-d891-4e29-8978-76b8dc9304b9", folder, person: "Bob" };

    if (options.approved !== false) {
        await approvals.approve(a, "computer");
        await approvals.approve(b, "computer");
    }

    const sent: Buffer[] = [];
    const replies: Buffer[] = [];
    const asked: { scope: SessionScope; signal: AbortSignal }[] = [];
    const pending = new Map<number, (outcome: Outcome) => void>();
    const settled: number[] = [];
    const checks: number[] = [];
    const timing = new RunnerRequestTiming();

    t.mock.method(timing, "check", (id: number) => checks.push(id));

    const collect = (route: Outcome["route"], frames: Buffer[]) => (whole: Buffer) => {
        frames.push(whole);
        const parsed = readFrame(whole);
        const resolve = pending.get(parsed.id);

        if (route === "send") {
            options.onSend?.(parsed);
        }

        settled.push(parsed.id);
        pending.delete(parsed.id);
        resolve?.({ ...parsed, route });
    };

    const gate = new RequestGate({
        approvals,
        async ask(scope, signal) {
            asked.push({ scope, signal });

            const allow =
                typeof options.answer === "function"
                    ? await options.answer(signal)
                    : options.answer === true;

            if (allow) {
                await approvals.approve(scope, "computer");
            }

            return allow;
        },
        send: collect("send", sent),
        reply: collect("reply", replies),
        ...(options.resolvePath === undefined ? {} : { resolvePath: options.resolvePath }),
        timing,
        shared: async (id) => {
            await options.shared?.(id);

            return [shared];
        },
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

    return {
        gate,
        approvals,
        request,
        a,
        b,
        folder,
        outside,
        shared,
        sent,
        replies,
        asked,
        checks,
        settled,
    };
}

function refused(outcome: Outcome, message: RegExp): void {
    assert.equal(outcome.route, "reply");
    assert.equal(outcome.type, FRAME.error);
    assert.equal(outcome.json.code, "EACCES");
    assert.match(String(outcome.json.message), message);
}

describe("runner RequestGate", () => {
    it("bounds parallel checks and sends and refuses in arrival order", async (t) => {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const { request, folder, outside, shared, checks, settled } = await fixture(t, {
            async shared() {
                started.resolve();
                await release.promise;
            },
        });

        t.after(() => release.resolve());
        const first = request({ op: "open", path: join(shared, "file.txt") });

        await started.promise;
        const second = request({ op: "open", path: join(outside, "file.txt") });
        const later = Array.from({ length: 16 }, () =>
            request({ op: "open", path: join(folder, "file.txt") }),
        );

        assert.deepEqual(
            checks,
            Array.from({ length: 16 }, (_, i) => i + 1),
        );
        assert.deepEqual(settled, [], "later requests cannot overtake the first check");
        release.resolve();
        const [allowed, denied, ...rest] = await Promise.all([first, second, ...later]);

        assert.equal(allowed!.route, "send");
        refused(denied!, /outside the session's approved folder/);
        assert.ok(rest.every((result) => result.route === "send"));
        assert.deepEqual(
            settled,
            Array.from({ length: 18 }, (_, i) => i + 1),
        );
    });

    it("resolves each path once and forwards a burst of 161 opens in order", async (t) => {
        const release = Promise.withResolvers<void>();
        const windowReady = Promise.withResolvers<void>();
        const calls: string[] = [];
        let resolvedAhead = 0;
        const { request, folder, sent, settled } = await fixture(t, {
            async resolvePath(path) {
                const call = calls.push(path);

                if (call === 1) {
                    await release.promise;
                }

                const real = await canonical(path);

                if (call !== 1 && ++resolvedAhead === 15) {
                    windowReady.resolve();
                }

                return real;
            },
        });

        t.after(() => release.resolve());
        const file = join(folder, "file.txt");
        const burst = Array.from({ length: 161 }, () => request({ op: "open", path: file }));

        assert.equal(calls.length, 16, "only one window starts while the first check waits");
        await windowReady.promise;
        assert.deepEqual(settled, [], "completed checks cannot overtake the first one");
        release.resolve();
        await Promise.all(burst);

        assert.deepEqual(
            calls,
            Array.from({ length: 161 }, () => file),
        );
        assert.deepEqual(
            sent.map((whole) => readFrame(whole).id),
            Array.from({ length: 161 }, (_, i) => i + 1),
        );
    });

    it("holds later requests behind a question but lets cancels and other sessions go on", async (t) => {
        const opened = Promise.withResolvers<AbortSignal>();
        const answer = Promise.withResolvers<boolean>();
        const { gate, approvals, request, a, b, folder, asked, checks, settled } = await fixture(
            t,
            {
                answer: (signal) => {
                    opened.resolve(signal);

                    return answer.promise;
                },
            },
        );

        t.after(() => answer.resolve(false));
        await approvals.action({ action: "revoke", session: a.id });
        const first = request({ op: "open", path: join(folder, "file.txt") });
        const signal = await opened.promise;
        const cancelled = request({ op: "open", path: join(folder, "file.txt") });
        const later = request({ op: "lstat", path: folder });
        const independent = request({ op: "open", path: join(folder, "file.txt") }, b);

        gate.input(frame(FRAME.cancel, 2, { [SESSION_FIELD]: a }));
        refused(await cancelled, /cancelled/);
        assert.equal((await independent).route, "send");
        assert.deepEqual(checks, [1, 4]);
        assert.deepEqual(settled, [2, 4]);
        assert.equal(signal.aborted, false, "other requests still wait for the answer");
        answer.resolve(true);
        const [allowed, listed] = await Promise.all([first, later]);

        assert.equal(allowed.route, "send");
        assert.equal(listed.route, "send");
        assert.equal(asked.length, 1);
        assert.deepEqual(settled, [2, 4, 1, 3]);
    });

    it("resolves paths again after an approval question", async (t) => {
        const release = Promise.withResolvers<void>();
        const checked = Promise.withResolvers<void>();
        const opened = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<boolean>();
        let delayed: string;
        let laterPath: string;
        let laterChecks = 0;
        const { request, folder, outside, sent } = await fixture(t, {
            approved: false,
            async resolvePath(path) {
                if (path === delayed) {
                    await release.promise;
                }

                const real = await canonical(path);

                if (path === laterPath && ++laterChecks === 1) {
                    checked.resolve();
                }

                return real;
            },
            answer() {
                opened.resolve();

                return answer.promise;
            },
        });

        t.after(() => {
            release.resolve();
            answer.resolve(false);
        });
        const child = join(folder, "child");

        delayed = join(folder, "file.txt");
        laterPath = join(child, "file.txt");
        mkdirSync(child);
        writeFileSync(laterPath, "inside");
        const first = request({ op: "open", path: delayed });
        const later = request({ op: "open", path: laterPath });

        await checked.promise;
        release.resolve();
        await opened.promise;
        renameSync(child, `${child}-moved`);
        symlinkSync(outside, child, "junction");
        answer.resolve(true);
        const [allowed, denied] = await Promise.all([first, later]);

        assert.equal(allowed.route, "send");
        refused(denied, /outside the session's approved folder/);
        assert.equal(laterChecks, 2);
        assert.equal(sent.length, 1);
    });

    it("does not start a later path check before a rename reaches the daemon", async (t) => {
        const release = Promise.withResolvers<void>();
        let delayed: string;
        let laterPath: string;
        let renamed = false;
        const checksAfterRename: boolean[] = [];
        const { request, folder, outside, checks, sent } = await fixture(t, {
            async resolvePath(path) {
                if (path === delayed) {
                    await release.promise;
                }

                if (path === laterPath) {
                    checksAfterRename.push(renamed);
                }

                return canonical(path);
            },
            onSend({ json }) {
                if (json.op === "rename") {
                    const path = String(json.path);

                    // Apply the rename in the fake daemon. Replace the old name before the next check.
                    renameSync(path, String(json.to));
                    symlinkSync(outside, path, "junction");
                    renamed = true;
                }
            },
        });

        t.after(() => release.resolve());
        const child = join(folder, "child");

        delayed = join(folder, "file.txt");
        laterPath = join(child, "file.txt");
        mkdirSync(child);
        writeFileSync(laterPath, "inside");
        const first = request({ op: "open", path: delayed });
        const rename = request({ op: "rename", path: child, to: `${child}-moved` });
        const later = request({ op: "open", path: laterPath });

        assert.deepEqual(checks, [1]);
        release.resolve();
        const [openedFile, moved, denied] = await Promise.all([first, rename, later]);

        assert.equal(openedFile.route, "send");
        assert.equal(moved.route, "send");
        refused(denied, /outside the session's approved folder/);
        assert.deepEqual(checksAfterRename, [true]);
        assert.equal(sent.length, 2);
    });

    it("refuses a replaced approval folder even after a path check finished", async (t) => {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const checked = Promise.withResolvers<void>();
        let resolved = 0;
        const { request, folder, outside, shared, sent } = await fixture(t, {
            async shared() {
                started.resolve();
                await release.promise;
            },
            async resolvePath(path) {
                const real = await canonical(path);

                if (++resolved === 2) {
                    checked.resolve();
                }

                return real;
            },
        });

        t.after(() => release.resolve());
        const first = request({ op: "open", path: join(shared, "file.txt") });

        await started.promise;
        const second = request({ op: "open", path: join(folder, "file.txt") });

        await checked.promise;
        renameSync(folder, folder + "-moved");
        symlinkSync(outside, folder, "junction");
        release.resolve();
        const [allowed, denied] = await Promise.all([first, second]);

        assert.equal(allowed.route, "send");
        refused(denied, /Session not approved/);
        assert.equal(sent.length, 1);
    });

    it("refuses requests after an approved folder is replaced, without a grace period", async (t) => {
        const { request, folder, outside, sent, asked } = await fixture(t);

        assert.equal((await request({ op: "open", path: join(folder, "file.txt") })).route, "send");
        renameSync(folder, `${folder}-moved`);
        symlinkSync(outside, folder, "junction");
        const [read, command] = await Promise.all([
            request({ op: "open", path: join(folder, "file.txt") }),
            request({ op: "exec", command: "printf ok" }),
        ]);

        refused(read, /Session not approved/);
        refused(command, /Session not approved/);
        assert.equal(sent.length, 1);
        assert.equal(asked.length, 2);
    });

    it("refuses a request without its session field", async (t) => {
        const { request, folder, sent, asked } = await fixture(t);
        const outcome = await request({ op: "open", path: join(folder, "file.txt") }, null);

        refused(outcome, /A session permission on Test computer is required/);
        assert.deepEqual(sent, []);
        assert.deepEqual(asked, []);
    });

    for (const op of ["hello", "lstat", "realpath", "opendir"]) {
        it(`allows the listing operation ${op} without a session or approval`, async (t) => {
            const { request, outside, replies, asked } = await fixture(t, { approved: false });
            const json = op === "hello" ? { op } : { op, path: outside };
            const outcome = await request(json, null);

            assert.equal(outcome.route, "send");
            assert.equal(outcome.type, FRAME.request);
            assert.deepEqual(outcome.json, json);
            assert.deepEqual(replies, []);
            assert.deepEqual(asked, []);
        });
    }

    it("lets an unscoped folder listing use and close its directory handle", async (t) => {
        const { gate, request, outside, asked } = await fixture(t, { approved: false });
        const opened = await request({ op: "opendir", path: outside }, null);

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        assert.equal((await request({ op: "readdir", handle: 41 }, null)).route, "send");
        assert.equal((await request({ op: "close", handle: 41 }, null)).route, "send");
        assert.deepEqual(asked, []);
    });

    it("forwards an approved request and payload after removing only the session field", async (t) => {
        const { request, folder, replies, asked } = await fixture(t);
        const json = { op: "open", path: join(folder, "file.txt"), flags: "r" };
        const payload = Uint8Array.of(0, 255, 1);
        const outcome = await request(json, undefined, payload);

        assert.equal(outcome.route, "send");
        assert.equal(outcome.type, FRAME.request);
        assert.deepEqual(outcome.json, json);
        assert.equal(Object.hasOwn(outcome.json, SESSION_FIELD), false);
        assert.deepEqual(outcome.payload, payload);
        assert.deepEqual(replies, []);
        assert.deepEqual(asked, []);
    });

    it("refuses a path outside the approved folder", async (t) => {
        const { request, outside, sent } = await fixture(t);
        const outcome = await request({ op: "open", path: join(outside, "file.txt") });

        refused(outcome, /outside the session's approved folder/);
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

        refused(outcome, /outside the session's approved folder/);
        assert.deepEqual(sent, []);
    });

    it("checks every target instead of only the request's main path", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const outcome = await request({
            op: "watch",
            path: folder,
            targets: [{ path: join(folder, "file.txt") }, { path: join(outside, "file.txt") }],
        });

        refused(outcome, /outside the session's approved folder/);
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

    it("asks again without a valid permission and refuses a negative answer", async (t) => {
        const { request, folder, a, asked, sent } = await fixture(t, { approved: false });
        const outcome = await request({ op: "open", path: join(folder, "file.txt") });

        refused(outcome, /Session not approved on Test computer/);
        assert.equal(asked.length, 1);
        assert.deepEqual(asked[0]!.scope, a);
        assert.equal(asked[0]!.signal.aborted, false);
        assert.deepEqual(sent, []);
    });

    it("rechecks the permission after a positive approval answer", async (t) => {
        const { request, folder, asked, replies } = await fixture(t, {
            approved: false,
            answer: true,
        });
        const outcome = await request({ op: "open", path: join(folder, "file.txt") });

        assert.equal(outcome.route, "send");
        assert.equal(asked.length, 1);
        assert.deepEqual(replies, []);
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
