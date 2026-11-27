import assert from "node:assert/strict";
import { test } from "node:test";
import { RunnerController } from "../../packaging/desktop/controller/runner/index.mjs";
import {
    boundedLines,
    MAX_LINE,
    runnerActivity,
} from "../../packaging/desktop/controller/runner/output.mjs";

const server = "http://127.0.0.1:19654/subpath";
const code = "ABCD-EFGH-JKLM"; // Synthetic fixture, not a server-issued code.
const activity = 'PI-POCKET-ACTIVITY {"working":true,"folders":["/private/project"]}';
const turn = () => Promise.resolve();

function fixture({ policy = { enabled: false, ended: false }, linked = true } = {}) {
    const starts = [];
    const commands = [];
    const timers = new Map();
    const states = [];
    let linkResult = 0;
    let unlinkResult = 0;
    let saved = policy;
    let pendingStop = false;
    let id = 0;
    const controller = new RunnerController({
        policy,
        savePolicy: (next) => {
            saved = next;
        },
        publish: (state) => states.push(state),
        schedule: (callback, delay) => {
            timers.set(++id, { callback, delay });

            return id;
        },
        cancel: (timer) => timers.delete(timer),
        start(request, emit) {
            const { action } = request;

            commands.push(action);

            if (action === "start") {
                const { promise: done, resolve: exit } = Promise.withResolvers();
                const child = { emit, exit, stops: 0 };

                starts.push(child);

                return {
                    done,
                    stop: () => {
                        child.stops++;

                        if (!pendingStop) {
                            exit(1);
                        }

                        return done;
                    },
                };
            }

            if (action === "status") {
                if (linked) {
                    emit("Computer: Desktop test runner", true);
                    emit(`Server: ${server}`, true);
                    emit("This computer's key: PRIVATE-FINGERPRINT", true);
                } else {
                    emit("This computer is not linked.", true);
                }
            }

            if (action === "link") {
                emit(`Link attempt: ${request.code}`, false);
                linked ||= linkResult === 0;
            }

            if (action === "unlink" && unlinkResult === 0) {
                linked = false;
            }

            return {
                done: Promise.resolve(
                    action === "link" ? linkResult : action === "unlink" ? unlinkResult : 0,
                ),
                stop: async () => {},
            };
        },
    });

    return {
        controller,
        starts,
        commands,
        states,
        timers,
        get saved() {
            return saved;
        },
        failLink() {
            linkResult = 1;
        },
        failUnlink() {
            unlinkResult = 1;
        },
        deferStop() {
            pendingStop = true;
        },
        retry() {
            const [next, timer] = timers.entries().next().value;

            timers.delete(next);
            timer.callback();

            return timer.delay;
        },
    };
}

const link = { server, code, trusted: true };

test("link, enable, reconnect, disable and unlink control one child without exposing secrets", async () => {
    const f = fixture({ linked: false });
    const { controller, starts, states } = f;

    await controller.boot();
    assert.equal(controller.state.status, "unlinked");
    await assert.rejects(controller.link({ ...link, trusted: false }), { code: "runner.trust" });
    await assert.rejects(controller.link({ ...link, server: "https://user:secret@example.com/" }), {
        code: "runner.input",
    });
    await controller.link(link);
    assert.equal(controller.state.server, server);
    assert.equal(controller.state.status, "disabled");
    assert.equal(starts.length, 0);
    await controller.setEnabled(true);
    await controller.setEnabled(true);
    assert.equal(starts.length, 1);
    assert.equal(controller.state.status, "connecting");
    starts[0].emit("[07:43:11] A line that sounds connected", true);
    assert.equal(controller.state.status, "connecting");
    starts[0].emit(`[07:43:11] Connected to ${server} as "Desktop test runner".`, true);
    assert.equal(controller.state.status, "connected");
    starts[0].emit(
        "[07:43:11] Disconnected (secret=private-token). Reconnecting automatically. Commands keep running; their sessions continue when the link is back.",
        true,
    );
    assert.equal(controller.state.status, "offline");
    assert.equal(f.timers.size, 0);
    starts[0].emit(activity, false);
    assert.equal(controller.state.working, false);
    starts[0].emit(activity, true);
    assert.equal(controller.state.working, true);
    assert.equal(controller.state.label, "Working now");
    await assert.rejects(controller.reconnect(false), /working now.*background tasks/);
    await controller.reconnect(true);
    assert.equal(starts[0].stops, 1);
    assert.equal(starts.length, 2);
    assert.equal(controller.state.working, false);
    starts[0].emit(activity, true);
    assert.equal(controller.state.working, false);
    await assert.rejects(
        controller.setEnabled(false),
        /background tasks stop even when the runner is idle/,
    );
    await controller.setEnabled(false, true);
    assert.equal(controller.state.linked, true);
    assert.equal(controller.state.status, "disabled");
    assert.equal(f.saved.enabled, false);
    await assert.rejects(controller.unlink(false), { code: "runner.confirm" });
    await controller.unlink(true);
    assert.equal(controller.state.status, "unlinked");
    assert.doesNotMatch(
        JSON.stringify(states),
        /ABCD-EFGH-JKLM|PRIVATE-FINGERPRINT|private\/project|private-token/,
    );
    await controller.close();
});

test("failed link preserves the old running child and failed unlink restores it", async () => {
    const f = fixture({ policy: { enabled: true, ended: false } });
    const { controller, starts } = f;

    await controller.boot();
    f.failLink();
    await assert.rejects(controller.link({ ...link, confirmed: true }), { code: "runner.link" });
    assert.equal(starts[0].stops, 0);
    assert.equal(controller.state.linked, true);
    f.failUnlink();
    await assert.rejects(controller.unlink(true), { code: "runner.unlink" });
    assert.equal(starts[0].stops, 1);
    assert.equal(starts.length, 2);
    assert.equal(controller.state.linked, true);
    await controller.close();
    assert.equal(starts[1].stops, 1);
});

test("unexpected process exit backs off; exit 3 stays ended across app restarts", async () => {
    const f = fixture({ policy: { enabled: true, ended: false } });
    const { controller, starts } = f;

    await controller.boot();

    for (const delay of [1, 2, 4, 8, 16, 32, 60, 60]) {
        starts.at(-1).exit(1);
        await turn();
        assert.equal(controller.state.status, "retrying");
        assert.equal(f.retry(), delay * 1000);
    }

    starts.at(-1).exit(3);
    await turn();
    assert.equal(controller.state.status, "ended");
    assert.equal(f.timers.size, 0);
    assert.equal(f.saved.ended, true);
    await assert.rejects(controller.reconnect(true), /Link again/);
    await controller.close();
    const reopened = fixture({ policy: f.saved });

    await reopened.controller.boot();
    assert.equal(reopened.controller.state.status, "ended");
    assert.equal(reopened.starts.length, 0);
    await reopened.controller.link(link);
    assert.equal(reopened.saved.ended, false);
    assert.equal(reopened.starts.length, 1);
    await reopened.controller.close();
});

test("reconnect waits for the old generation and concurrent actions do not start another child", async () => {
    const f = fixture({ policy: { enabled: true, ended: false } });
    const { controller, starts } = f;

    await controller.boot();
    f.deferStop();
    const reconnect = controller.reconnect(true);

    assert.equal(starts.length, 1);
    await assert.rejects(controller.reconnect(true), { code: "runner.busy" });
    starts[0].exit(0);
    await reconnect;
    assert.equal(starts.length, 2);
    const closing = controller.close();

    starts[1].exit(0);
    await closing;
    assert.equal(f.timers.size, 0);
});

test("activity decoder is bounded and never treats a truncated line as a packet", () => {
    const lines = [];
    const feed = boundedLines((line) => lines.push(line));

    feed(Buffer.alloc(MAX_LINE + 1, "x"));
    feed(Buffer.from(`${activity}\r\n${activity.slice(0, 20)}`));
    feed(Buffer.from(`${activity.slice(20)}\r\n`));
    assert.deepEqual(lines, [activity]);
    assert.deepEqual(runnerActivity(lines[0]), { working: true, workingFolders: 1 });

    for (const bad of [
        "PI-POCKET-ACTIVITY invalid",
        "PI-POCKET-ACTIVITY null",
        'PI-POCKET-ACTIVITY {"working":1,"folders":[]}',
        'PI-POCKET-ACTIVITY {"working":true,"folders":[{}]}',
        `PI-POCKET-ACTIVITY ${JSON.stringify({ working: true, folders: Array(129).fill("/work") })}`,
        `PI-POCKET-ACTIVITY ${JSON.stringify({ working: true, folders: ["x".repeat(MAX_LINE)] })}`,
    ]) {
        assert.equal(runnerActivity(bad), undefined);
    }

    assert.deepEqual(runnerActivity('PI-POCKET-ACTIVITY {"working":false,"folders":[]}'), {
        working: false,
        workingFolders: 0,
    });
});
