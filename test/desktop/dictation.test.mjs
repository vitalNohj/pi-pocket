import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DesktopController } from "../../packaging/desktop/controller/index.mjs";
import {
    FRAME_SAMPLES,
    pcmFrame,
    registerDictation,
} from "../../packaging/desktop/controller/dictation/index.mjs";
import { Phrases } from "../../src/server/extensions/dictation/phrases.js";
import { fixture } from "./fixture.mjs";

const speech = {
    id: "small",
    name: "Small model",
    files: [{ size: 4 }],
    family: "whisper",
};
const another = { ...speech, id: "another", name: "Another model" };

async function pageBridge({ path = "/pocket", effective, secure = true, frame = false } = {}) {
    const [bootstrap, adapter] = await Promise.all(
        ["bridge/bootstrap.js", "protocol/page-dictation.js"].map((name) =>
            readFile(new URL(`../../packaging/desktop/${name}`, import.meta.url), "utf8"),
        ),
    );
    const origin = "https://speech.example.test";
    const window = { origin: effective ?? origin };
    const navigator = { userActivation: { isActive: false } };
    const document = { hidden: false, focused: true, hasFocus: () => document.focused };
    const outgoing = [];
    const listeners = new Map();
    let receive;

    window.top = frame ? {} : window;
    runInNewContext(
        bootstrap.replace(
            "/* POCKET_BRIDGE_ARGUMENTS */",
            () => `config, transport, ${adapter.trim().replace(/;$/, "")}`,
        ),
        {
            config: { origin, basePath: "/pocket", items: [] },
            transport: {
                send: (packet) => outgoing.push(structuredClone(packet)),
                listen: (next) => {
                    receive = next;
                },
            },
            window,
            location: { origin, protocol: "https:", pathname: path },
            isSecureContext: secure,
            crypto: globalThis.crypto,
            document,
            navigator,
            addEventListener: (name, handler) => listeners.set(name, handler),
        },
    );

    return { api: window.pocketDictation, receive, outgoing, navigator, document, listeners };
}

test("the native speech adapter is scoped to a bound, secure Pi Pocket page and needs a gesture", async () => {
    for (const invalid of [
        { effective: "null" },
        { path: "/pocket/login" },
        { secure: false },
        { frame: true },
    ]) {
        assert.equal((await pageBridge(invalid)).api, undefined);
    }

    const { api, outgoing, receive, navigator, document, listeners } = await pageBridge();
    const connection = api.attach((op) => {
        if (op === "hold") {
            recognition.start();
        }

        if (op === "release") {
            recognition.stop();
        }
    });
    const recognition = new connection.Recognition();
    const results = [];
    const errors = [];

    recognition.onresult = ({ results: parts }) => results.push(parts[0][0].transcript);
    recognition.onerror = ({ error }) => errors.push(error);
    assert.throws(() => recognition.start(), /press its microphone button/);
    navigator.userActivation.isActive = true;
    assert.throws(() => recognition.start(), /finish loading/);
    navigator.userActivation.isActive = false;
    assert.deepEqual(outgoing, []);

    receive({ type: "bind", key: "lease" });
    const { scope } = outgoing.shift();
    const packet = { type: "dictation", key: "lease", scope };

    assert.match(scope, /^[a-f0-9]{32}$/);
    document.focused = false;
    receive({ ...packet, op: "hold" });
    document.focused = true;
    receive({ ...packet, key: "older", op: "hold" });
    receive({ ...packet, scope: "older", op: "hold" });
    assert.deepEqual(outgoing, []);

    receive({ ...packet, op: "hold" });
    const { id, op } = outgoing.shift();

    assert.equal(op, "start");
    receive({ ...packet, op: "result", id: "older", parts: [{ text: "old", final: true }] });
    receive({ ...packet, op: "result", id, parts: [{ text: "words", final: true }] });
    assert.deepEqual(results, ["words"]);
    receive({ ...packet, op: "release" });
    assert.deepEqual(outgoing.shift(), { ...packet, op: "stop", id });
    listeners.get("pagehide")();
    assert.deepEqual(outgoing.shift(), { ...packet, op: "detach" });
    assert.deepEqual(errors, ["aborted"]);
});

async function setup(t, reuse) {
    const folder = reuse ?? (await mkdtemp(join(tmpdir(), "desktop-dictation-")));

    if (!reuse) {
        t.after(() => rm(folder, { recursive: true, force: true }));
    }

    const remote = await fixture();

    t.after(() => remote.close());
    const packets = [];
    let id = 0;
    let fails = false;
    const activity = [];
    const controller = new DesktopController({
        folder,
        platform: "windows",
        version: "1.0.0",
        write(packet) {
            packets.push(packet);

            if (packet.type === "host") {
                const value = ["local.inspect", "local.stop"].includes(packet.action)
                    ? { status: "stopped", owned: false, verified: false }
                    : null;

                void controller.receive({
                    id: ++id,
                    command: "host.result",
                    value: { id: packet.id, ok: true, value },
                });
            }
        },
    });

    t.after(() => controller.close());
    await registerDictation(controller, {
        folder,
        extension: {
            MODELS: [speech, another],
            modelById: (key) => [speech, another].find(({ id }) => id === key),
            modelSize: () => 4,
            Phrases,
            ModelCache: class {
                constructor(root) {
                    this.root = root;
                }
                async withFile(_pin, signal, read) {
                    signal.throwIfAborted();
                    await mkdir(this.root);
                    const file = join(this.root, "test-pin");

                    await writeFile(file, "test");

                    if (fails) {
                        throw new Error("damaged file");
                    }

                    await read(file);
                }
            },
        },
        engine: {
            warm(selected) {
                activity.push(selected);
            },
            decode(samples) {
                assert(samples instanceof Float32Array && samples[0] === 0.375);
                activity.push("decode");

                return "fixture words";
            },
            idle() {
                activity.push("idle");
            },
            drop() {
                activity.push("drop");
            },
        },
    });
    await controller.load();

    async function call(command, value) {
        const request = ++id;

        await controller.receive({ id: request, command, value });

        return packets.find((packet) => packet.id === request && packet.type === "result");
    }

    return {
        controller,
        folder,
        remote,
        packets,
        activity,
        call,
        action: (id, data) => call("action", { id, data }),
        report: (suffix, data) => call("host.report", { event: `dictation.${suffix}`, data }),
        setFailure: () => {
            fails = true;
        },
    };
}

test("dictation preference choices and installed models are device state; a failure keeps the old model", async (t) => {
    const desktop = await setup(t);
    const state = () => desktop.controller.snapshot();

    assert.equal(state().preferences.dictation.key, "default");
    assert.equal(state().dictation.selected, null);
    assert.equal(
        (await desktop.call("patchPreferences", { dictation: { key: "F9", keyMode: "tap" } })).ok,
        true,
    );
    assert.equal(
        (await desktop.call("patchPreferences", { dictation: { key: "Ctrl+c" } })).ok,
        false,
    );
    assert.equal((await desktop.action("dictation.download", { model: "../file" })).ok, false);
    assert.equal((await desktop.action("dictation.download", { model: speech.id })).ok, true);
    assert.equal(state().dictation.selected, speech.id);
    assert.equal((await desktop.action("dictation.download", { model: another.id })).ok, true);
    assert.equal((await desktop.action("dictation.select", { model: another.id })).ok, true);
    assert.equal((await desktop.action("dictation.remove", { model: speech.id })).ok, true);
    desktop.setFailure();
    assert.equal(
        (await desktop.action("dictation.download", { model: speech.id })).error.code,
        "dictation-model",
    );
    assert.deepEqual(await readdir(join(desktop.folder, "speech-models-v1")), [
        another.id,
        "selected",
    ]);

    const reopened = await setup(t, desktop.folder);

    assert.equal(reopened.controller.snapshot().preferences.dictation.key, "F9");
    assert.equal(reopened.controller.snapshot().dictation.selected, another.id);
});

test("native PCM is scoped, bounded, and decoded only for a live request", async (t) => {
    const desktop = await setup(t);
    const { controller, packets, activity, report, action, remote } = desktop;

    await action("dictation.download", { model: speech.id });
    const connected = await action("home.connect", { address: remote.address });

    assert.equal(connected.ok, true);
    const { generation } = controller.snapshot().home.active;
    const target = { generation, scope: "0".repeat(32) };
    const request = { ...target, id: "1".repeat(32) };
    const bytes = Buffer.alloc(FRAME_SAMPLES * 2);

    for (let i = 0; i < bytes.length; i += 2) {
        bytes.writeInt16LE(12288, i);
    }

    const frame = bytes.toString("base64");

    assert.deepEqual(pcmFrame(frame), bytes);

    for (const invalid of [
        frame + "=",
        frame.replace(/=$/, "A"),
        frame.replace(/^./, "_"),
        frame.slice(4),
    ]) {
        assert.equal(pcmFrame(invalid), null);
    }

    assert.equal((await report("start", request)).ok, false);
    assert.equal((await report("attach", { ...target, generation: generation + 1 })).ok, true);
    assert.equal((await report("start", request)).ok, false);
    await report("attach", target);
    assert.equal(controller.snapshot().dictation.canDictate, true);
    assert.equal((await action("dictation.toggle")).ok, true);
    assert.equal((await report("start", request)).ok, true);
    assert.equal(
        controller.snapshot().menus.tray.find(({ id }) => id === "dictation.toggle").label,
        "Stop Dictation",
    );
    assert.equal(
        (await action("dictation.remove", { model: speech.id })).error.code,
        "dictation-busy",
    );
    assert.equal((await report("frame", { ...request, pcm: frame + "AAAA" })).ok, false);
    await report("frame", { ...request, generation: generation + 1, pcm: frame });
    await report("frame", { ...request, id: "2".repeat(32), pcm: frame });

    for (let i = 0; i < 4; i++) {
        assert.equal((await report("frame", { ...request, pcm: frame })).ok, true);
    }

    assert.equal((await report("stop", request)).ok, true);
    assert.deepEqual(activity, [speech.id, "decode", "idle"]);
    assert(controller.snapshot().dictation.canCopy);
    assert.equal((await action("dictation.copyLast")).ok, true);
    const copy = packets.find(({ action }) => action === "dictation.copy");

    assert.equal(copy.data.text, "fixture words");
    assert(!JSON.stringify(controller.snapshot()).includes("fixture words"));

    await report("detach", target);
    assert.equal((await action("dictation.copyLast")).ok, false);
    assert.equal(controller.snapshot().dictation.canCopy, false);
    assert.equal(controller.snapshot().dictation.canDictate, false);
    assert(!remote.requests.some(({ path }) => path.includes("dictation")));
});

test("detaching cancels a capture before it can produce another result", async (t) => {
    const desktop = await setup(t);
    const { controller, packets, activity, report, action, remote } = desktop;

    await action("dictation.download", { model: speech.id });
    await action("home.connect", { address: remote.address });
    const target = {
        generation: controller.snapshot().home.active.generation,
        scope: "a".repeat(32),
    };
    const request = { ...target, id: "b".repeat(32) };

    await report("attach", target);
    await report("start", request);
    await report("detach", target);
    await report("stop", request);
    assert.deepEqual(activity, [speech.id, "drop"]);
    assert.equal(controller.snapshot().dictation.recording, false);
    assert(!packets.some(({ action }) => action === "dictation.event"));
});
