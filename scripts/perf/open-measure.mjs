/** Measure session opens on 8892071f in a separate, instrumented copy. No real sessions or config. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hrtime } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), "../..");
const revision = "8892071f8033aed5a79c1f799a4a098adc883382";
const sizes = [200, 2000, 10000];
const ms = () => Number(hrtime.bigint()) / 1e6;
const load = () => readFileSync("/proc/loadavg", "utf8").trim();
const mod = (root, name) => import(pathToFileURL(join(root, name)).href);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const record = (file, row) => appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });

const insist = (file, before, after) => {
    const source = readFileSync(file, "utf8");
    const i = source.indexOf(before);

    assert.ok(
        i >= 0 && source.indexOf(before, i + before.length) < 0,
        `Wrong revision: ${file}, ${before.slice(0, 85)}`,
    );
    writeFileSync(file, source.slice(0, i) + after + source.slice(i + before.length));
};

function instrument(code) {
    const root = join(code, "src", "server");
    const trace = join(root, "open-measure-trace.ts");

    writeFileSync(
        trace,
        `import { AsyncLocalStorage } from "node:async_hooks";
import { hrtime } from "node:process";
export type Probe = { at: number; req: number; path: string; room?: number; parts: Record<string, number>; warm?: boolean; push?: Push };
export type Push = { full: boolean; at: number; id: number; through: Record<string, number>; counts: Record<string, number> };
export type Wire = { probe: Probe; event: string; at: number; encode: number; plain: number; push?: Push; bytes?: number; firstWrite?: number; writeMs?: number };
export const active = new AsyncLocalStorage<Probe>();
export const clock = () => Number(hrtime.bigint()) / 1e6;
export const reported = (type: string, values: object) => process.send?.({ type, ...values });
export const stamp = (name: string, at: number) => {
    const p = active.getStore();
    if (p) p.parts[name] = clock() - at;
};
`,
    );
    const app = join(root, "app.ts");
    const room = join(root, "room.ts");
    const events = join(root, "http", "events.ts");

    for (const [file, base] of [
        [app, "./"],
        [room, "./"],
        [events, "../"],
    ]) {
        writeFileSync(
            file,
            `import { active as measuring, clock as tick, stamp, reported, type Push, type Wire } from "${base}open-measure-trace.ts";\n${readFileSync(file, "utf8")}`,
        );
    }

    const a = (from, to) => insist(app, from, to);
    const r = (from, to) => insist(room, from, to);
    const e = (from, to) => insist(events, from, to);

    a(
        "    async attach(client: Client): Promise<void> {\n",
        "    async attach(client: Client): Promise<void> {\n        const beginAttach = tick();\n",
    );
    a(
        "        await this.#enter(client);\n    }\n\n    /**",
        "        stamp('attachBeforeEnter', beginAttach);\n        await this.#enter(client);\n    }\n\n    /**",
    );
    a(
        "        const visit = (client.visit = (client.visit ?? 0) + 1);\n        const id = client.conversationId;",
        "        const visit = (client.visit = (client.visit ?? 0) + 1);\n        const id = client.conversationId;\n        const measure = measuring.getStore();\n        if (measure && id !== undefined) measure.room = Number(id);",
    );
    a(
        "            const room = await this.room(id);\n\n            if (!this.#clients",
        "            const roomStart = tick();\n            const room = await this.room(id);\n            stamp('roomLookup', roomStart);\n\n            if (!this.#clients",
    );
    a(
        "        let pending = this.#rooms.get(id);\n\n        if (pending === undefined)",
        "        let pending = this.#rooms.get(id);\n        const measure = measuring.getStore();\n        if (measure) measure.warm = pending !== undefined;\n\n        if (pending === undefined)",
    );
    a(
        "                const conversation = await this.harness.conversation(id, context);\n\n                if (conversation === undefined)",
        "                const lookupAt = tick();\n                const conversation = await this.harness.conversation(id, context);\n                stamp('harness', lookupAt);\n\n                if (conversation === undefined)",
    );
    r(
        "        const watch = await conversation.watch(context);\n\n        this.#watch",
        "        const watchAt = tick();\n        const watch = await conversation.watch(context);\n        stamp('watch', watchAt);\n\n        this.#watch",
    );
    r(
        "        this.#view = {\n            conversation: watch.value.conversation,",
        "        const contextAt = tick();\n        this.#view = {\n            conversation: watch.value.conversation,",
    );
    r(
        "        watch.start(async (call) => {",
        "        stamp('context', contextAt);\n        watch.start(async (call) => {",
    );
    r(
        "        const harness = this.#app.harness;\n\n        this.authors",
        "        const harness = this.#app.harness;\n        const docsAt = tick();\n\n        this.authors",
    );
    r(
        "        // Every update reads the branch;",
        "        stamp('docs', docsAt);\n        // Every update reads the branch;",
    );
    r(
        "    push(client: Client, full: boolean): void {\n        const view = this.#view;",
        "    push(client: Client, full: boolean): void {\n        const view = this.#view;\n        const probe = measuring.getStore();\n        const mark: Push | undefined = probe?.room === Number(this.id) ? { id: Number(this.id), full, at: tick(), through: {}, counts: {} } : undefined;",
    );
    r(
        "        const projected = this.#projectedEntries(view.entries);\n        const order = projected.map((entry) => entry.id);",
        "        let phaseAt = tick();\n        const before = this.#projected.size;\n        const projected = this.#projectedEntries(view.entries);\n        if (mark) {\n            mark.through.project = tick() - phaseAt;\n            mark.counts.scanned = view.entries.length;\n            mark.counts.projected = projected.length;\n            mark.counts.misses = this.#projected.size - before;\n        }\n        phaseAt = tick();\n        const order = projected.map((entry) => entry.id);\n        if (mark) mark.through.orderMap = tick() - phaseAt;",
    );
    r(
        "        const kept = full ? this.#kept(client, order) : 0;\n        const from",
        "        phaseAt = tick();\n        const kept = full ? this.#kept(client, order) : 0;\n        if (mark) mark.through.have = tick() - phaseAt;\n        phaseAt = tick();\n        const from",
    );
    r(
        "        const light = full &&",
        "        if (mark) mark.through.firstEntries = tick() - phaseAt;\n        const light = full &&",
    );
    r(
        "        projected.forEach((entry, index) => {",
        "        phaseAt = tick();\n        let lightMs = 0;\n        let lightCalls = 0;\n        let partials = 0;\n        projected.forEach((entry, index) => {",
    );
    r(
        "            const lighter = light ? lightEntry(entry) : null;",
        "            const lightAt = light && mark ? tick() : 0;\n            const lighter = light ? lightEntry(entry) : null;\n            if (lightAt) {\n                lightMs += tick() - lightAt;\n                lightCalls++;\n                if (lighter !== null) partials++;\n            }",
    );
    r(
        '        const orderKey = order.join(",");',
        '        if (mark) {\n            mark.through.entryLoop = tick() - phaseAt;\n            mark.through.lightEntry = lightMs;\n            Object.assign(mark.counts, { lightCalls, partials, from, kept, sent: entries.length });\n        }\n        phaseAt = tick();\n        const orderKey = order.join(",");',
    );
    r(
        '        const agentState = (view.docs["pi.agent"] ?? {}) as AgentState;',
        '        if (mark) mark.through.orderKey = tick() - phaseAt;\n        phaseAt = tick();\n        const agentState = (view.docs["pi.agent"] ?? {}) as AgentState;',
    );
    r(
        '        client.send("view", {',
        "        if (mark) mark.through.fields = tick() - phaseAt;\n        const payloadAt = tick();\n        const payload = {",
    );
    r(
        '            stats: projectStats(view.docs["pi.usage"] as UsageState | undefined, view.entries),',
        '            stats: (() => {\n                const statsAt = tick();\n                const stats = projectStats(view.docs["pi.usage"] as UsageState | undefined, view.entries);\n                if (mark) mark.through.stats = tick() - statsAt;\n                return stats;\n            })(),',
    );
    r(
        "            ...fields,\n        });\n    }\n\n    /**",
        '            ...fields,\n        };\n        if (mark && probe) {\n            mark.through.payload = tick() - payloadAt;\n            mark.through.beforeEncode = tick() - mark.at;\n            probe.push = mark;\n        }\n        client.send("view", payload);\n        if (probe) probe.push = undefined;\n    }\n\n    /**',
    );
    r(
        "                this.close();\n                onClose();",
        "                this.close();\n                reported('roomClosed', { id: Number(this.id), at: tick() });\n                onClose();",
    );
    e(
        "        const write = (text: string) => {",
        "        const pending: (Wire | undefined)[] = [];\n        const socketWrite = (chunk: string | Buffer, frame?: Wire) => {\n            const begin = frame ? tick() : 0;\n            response.write(chunk);\n            if (frame) {\n                frame.firstWrite ??= begin;\n                frame.writeMs = (frame.writeMs ?? 0) + (tick() - begin);\n                frame.bytes = (frame.bytes ?? 0) + (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));\n            }\n        };\n        const finish = (frame?: Wire) => {\n            if (frame) reported('wire', { ...frame, done: tick(), encoding: encoding ?? 'identity' });\n        };\n        const write = (text: string, frame?: Wire) => {",
    );
    e(
        "                response.write(text);\n            } else {\n                compressor.stream.write(text);\n                compressor.stream.flush(compressor.flush);",
        "                socketWrite(text, frame);\n                finish(frame);\n            } else {\n                pending.push(frame);\n                compressor.stream.write(text);\n                compressor.stream.flush(compressor.flush, () => finish(pending.shift()));",
    );
    e(
        "                    response.write(chunk);",
        "                    socketWrite(chunk, pending[0]);",
    );
    e(
        "                write(`event: ${event}\\ndata: ${JSON.stringify(data)}\\n\\n`);",
        '                const probe = measuring.getStore();\n                const track = probe && (event === "view" || event === "switched");\n                const at = track ? tick() : 0;\n                const body = `event: ${event}\\ndata: ${JSON.stringify(data)}\\n\\n`;\n                const frame = track ? { probe: { ...probe, push: undefined, parts: { ...probe.parts } }, event, at, encode: tick() - at, plain: Buffer.byteLength(body), push: probe.push } : undefined;\n                write(body, frame);',
    );
    e(
        "        write(`retry: 1500\\n\\n${pingEvent}`);",
        "        const initial = measuring.getStore();\n        const first = `retry: 1500\\n\\n${pingEvent}`;\n        write(first, initial ? { probe: { ...initial, parts: {} }, event: 'ping', at: tick(), encode: 0, plain: Buffer.byteLength(first) } : undefined);",
    );
}

function makeCopy(work) {
    const dir = join(work, "code");
    const archive = join(work, "source.tar");

    mkdirSync(dir);
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, revision], {
        cwd: repo,
    });
    execFileSync("tar", ["-xf", archive, "-C", dir]);
    rmSync(archive);
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
    instrument(dir);

    return dir;
}

function content(seed, bytes, type) {
    const lines = [];
    let state = (seed + 1) * 7607;
    let have = 0;

    for (let i = 0; have < bytes; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const key = state.toString(16).padStart(8, "0");
        const s =
            type === "bash"
                ? `PASS packages/api/__tests__/transport-${i % 49}.test.ts (run ${key}; ${1 + (state % 143)} ms)\n`
                : `export const route_${i} = {key: '${key}', peer: 'loopback', timeoutMs: ${150 + (state % 1000)}};\n`;

        lines.push(s);
        have += s.length;
    }

    return lines.join("").slice(0, bytes);
}

const marker = (n) => `Benchmark fixture ${n}: the last review is complete.`;

async function seed(app, tools, code, folder) {
    const { context, newSession, owner } = tools;
    const { UserEntry, AssistantEntry, ToolResultEntry } = await mod(
        code,
        "node_modules/@earendil-works/pi-durable/dist/index.js",
    );
    const { AuthorsDoc } = await mod(code, "src/server/docs.ts");
    const fixtures = [];
    const usage = {
        input: 12114,
        output: 104,
        cacheRead: 80,
        cacheWrite: 0,
        totalTokens: 12298,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const text = (s) => ({ type: "text", text: s });

    for (const size of sizes) {
        const id = await newSession(app, folder);
        const total = size / 5;
        let rawBytes = 0;
        let bashLarge = 0;
        let readLarge = 0;
        const author = owner(app).id;

        for (let batch = 0; batch < total; batch += 25) {
            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(AuthorsDoc, id);

                for (let i = batch; i < Math.min(total, batch + 25); i++) {
                    const at = 1764000000000 + i * 40000;
                    const file = `src/routes/fixture-${i % 49}.ts`;
                    const readId = `read-${i}`;
                    const bashId = `test-${i}`;
                    const turn = (blocks, stopReason, timestamp) => ({
                        role: "assistant",
                        provider: "faux",
                        api: "faux",
                        model: "faux-1",
                        content: blocks,
                        usage,
                        stopReason,
                        timestamp,
                        durationMs: 1800,
                    });
                    const read = i % 17 === 16 ? 50 * 1024 : 512 + ((i * 179) % 4096);
                    const bash = i % 23 === 22 ? 112 * 1024 : 512 + ((i * 127) % 7680);

                    const place = async (token, message, data) => {
                        const payload = { model: [message], ...(data ? { data } : {}) };

                        rawBytes += Buffer.byteLength(JSON.stringify(payload));

                        return tx.appendEntry(token, id, payload);
                    };

                    const entry = await place(UserEntry, {
                        role: "user",
                        content: [
                            text(
                                `Review transport route ${i}, read ${file}, and check the test output before you summarize. Note any mismatched timeout or unavailable peer.`,
                            ),
                        ],
                        timestamp: at,
                    });

                    doc.entries[String(entry.id)] = author;
                    await place(
                        AssistantEntry,
                        turn(
                            [
                                {
                                    type: "thinking",
                                    thinking:
                                        "Read the route and compare its configured timeout with the examples. Then check that the test covers the reconnection path and reports expected timings.",
                                },
                                text("I will check the source and run its transport tests."),
                                {
                                    type: "toolCall",
                                    id: readId,
                                    name: "read",
                                    arguments: { path: file },
                                },
                                {
                                    type: "toolCall",
                                    id: bashId,
                                    name: "bash",
                                    arguments: { command: `npm test -- transport-${i % 49}` },
                                },
                            ],
                            "toolUse",
                            at + 200,
                        ),
                    );
                    await place(
                        ToolResultEntry,
                        {
                            role: "toolResult",
                            toolCallId: readId,
                            toolName: "read",
                            content: [text(content(i, read, "read"))],
                            isError: false,
                            timestamp: at + 300,
                        },
                        { diagnostics: [] },
                    );
                    await place(
                        ToolResultEntry,
                        {
                            role: "toolResult",
                            toolCallId: bashId,
                            toolName: "bash",
                            content: [text(content(i, bash, "bash"))],
                            isError: false,
                            timestamp: at + 2200,
                        },
                        { diagnostics: [] },
                    );
                    await place(
                        AssistantEntry,
                        turn(
                            [
                                text(
                                    i + 1 === total
                                        ? marker(size)
                                        : `The transport route in \`${file}\` matches the fixture. The targeted tests passed. No source files changed.`,
                                ),
                            ],
                            "stop",
                            at + 2400,
                        ),
                    );
                    readLarge += Number(read === 50 * 1024);
                    bashLarge += Number(bash === 112 * 1024);
                }
            }, context);
        }

        const conversation = await app.conversation(id);
        const transcript = await conversation.context(context);

        assert.equal(transcript.entries.length, size, `Unexpected active context size for ${size}`);
        fixtures.push({ id: Number(id), size, rawBytes, bashLarge, readLarge });
    }

    return fixtures;
}

async function serve(code, work, mode) {
    const trace = await mod(code, "src/server/open-measure-trace.ts");
    const tools = await mod(code, "test/helpers.ts");
    const { createHandler } = await mod(code, "src/server/http.ts");
    const data = join(work, "data");

    process.env.PI_POCKET_DIR = data;
    const startup = ms();
    const app = await tools.openApp(tools.scriptedModel(), data);
    const bootMs = ms() - startup;

    if (mode === "seed") {
        const folder = join(work, "fixture");

        mkdirSync(folder);

        try {
            process.send?.({ type: "seed", fixtures: await seed(app, tools, code, folder) });
        } finally {
            await app.close();
            tools.cleanUp();
            process.disconnect?.();
        }

        return;
    }

    const host = "127.0.0.2";
    const handler = createHandler({ app, listen: { host, port: 0 }, restart: () => {} });
    let seq = 0;
    const server = createServer((req, res) => {
        const route = new URL(req.url, `http://${host}`);
        const path = route.pathname;

        if (path === "/api/switch" || (path === "/api/events" && route.searchParams.has("c"))) {
            return trace.active.run({ at: ms(), req: ++seq, path, parts: {} }, () =>
                handler(req, res),
            );
        }

        return handler(req, res);
    });

    await new Promise((ok) => server.listen(0, host, ok));
    process.send?.({
        type: "ready",
        base: `http://${host}:${server.address().port}`,
        token: app.config.ownerToken,
        bootMs,
    });
    let stopped = false;

    const stop = async () => {
        if (stopped) {
            return;
        }

        stopped = true;
        server.closeAllConnections();
        server.close();
        await app.close();
        tools.cleanUp();
        process.disconnect?.();
    };

    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.once(signal, () => void stop());
    }

    process.once("disconnect", () => void stop());
}

function launched(code, work, mode) {
    const trace = [];
    const started = ms();
    const child = spawn(
        process.execPath,
        ["--experimental-strip-types", script, "--server", code, work, mode],
        {
            env: { ...process.env, TMPDIR: join(work, "tmp"), UV_THREADPOOL_SIZE: "2" },
            stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
    );
    const done = new Promise((ok) =>
        child.once("exit", (status, signal) => ok({ status, signal })),
    );
    const connected = new Promise((ok, bad) => {
        child.once("error", bad);
        child.on("message", (event) => {
            if (event.type === "ready" || event.type === "seed") {
                ok({ ...event, processMs: ms() - started });
            } else {
                trace.push(event);
            }
        });
        void done.then((exit) =>
            bad(new Error(`Server exited before ready: ${JSON.stringify(exit)}`)),
        );
    });

    return {
        child,
        trace,
        done,
        connected,
        async close() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
            }

            const killer = setTimeout(() => child.kill("SIGKILL"), 6000).unref();
            const exit = await done;

            clearTimeout(killer);
            assert.equal(exit.status, 0, `Server did not stop cleanly: ${JSON.stringify(exit)}`);
        },
    };
}

async function until(check, label, msLimit = 20000, interval = 12) {
    const end = ms() + msLimit;

    do {
        const result = await check();

        if (result) {
            return result;
        }

        await sleep(interval);
    } while (ms() < end);

    throw new Error(`Timeout: ${label}`);
}

// This function is injected by CDP before the app loads. It observes the real transcript, not a new rendering path.
function inBrowser() {
    let state;
    let transcript;

    const check = () => {
        if (!state || state.dom !== undefined) {
            return;
        }

        transcript = document.querySelector('[data-part="transcript"]');

        if (!transcript?.textContent.includes(state.marker)) {
            return;
        }

        const current = state;

        current.dom = performance.timeOrigin + performance.now();
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                if (state === current) {
                    current.paint = performance.timeOrigin + performance.now();
                }
            }),
        );
    };

    window.openMeasure = {
        start(size) {
            state = {
                marker: `Benchmark fixture ${size}: the last review is complete.`,
                action: performance.timeOrigin + performance.now(),
            };
            check();
        },
        sample: () => state,
    };
    new MutationObserver(check).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
    });
    const size = sessionStorage.getItem("open-measure-size");

    if (size !== null && /^\/s\/\d+$/.test(location.pathname)) {
        window.openMeasure.start(Number(size));
    }
}

class Tab {
    constructor(c, ids) {
        this.c = c;
        Object.assign(this, ids);
        this.requests = new Map();
        this.streamingError = undefined;
        c.listen(this.sessionId, (method, p) => this.events(method, p));
    }
    send(method, p = {}) {
        return this.c.send(method, p, this.sessionId);
    }
    async evaluate(expression) {
        const out = await this.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });

        if (out.exceptionDetails) {
            throw new Error(
                out.exceptionDetails.exception?.description ?? out.exceptionDetails.text,
            );
        }

        return out.result.value;
    }
    events(method, p) {
        if (method === "Network.requestWillBeSent") {
            const url = new URL(p.request.url);

            if (url.pathname === "/api/events" || url.pathname === "/api/switch") {
                this.requests.set(p.requestId, {
                    url,
                    at: p.wallTime * 1000,
                    mono: p.timestamp,
                    body: p.request.postData ? JSON.parse(p.request.postData) : undefined,
                    chunks: [],
                    events: [],
                    size: 0,
                });
            }

            return;
        }

        const req = this.requests.get(p.requestId);

        if (!req) {
            return;
        }

        if (method === "Network.responseReceived" && req.url.pathname === "/api/events") {
            this.send("Network.streamResourceContent", { requestId: p.requestId }).then(
                (result) => {
                    req.buffered = Buffer.from(result.bufferedData, "base64");
                },
                (error) => {
                    this.streamingError = error;
                },
            );
        } else if (
            method === "Network.dataReceived" &&
            req.url.pathname === "/api/events" &&
            p.dataLength > 0
        ) {
            const end = req.size + p.dataLength;
            const at = req.at + (p.timestamp - req.mono) * 1000;

            req.chunks.push({
                start: req.size,
                end,
                at,
                bytes: p.data ? Buffer.from(p.data, "base64") : undefined,
            });
            req.size = end;
        } else if (method === "Network.eventSourceMessageReceived") {
            req.events.push({
                name: p.eventName,
                at: req.at + (p.timestamp - req.mono) * 1000,
                prefix: p.data?.slice(0, 160),
            });
        }
    }
    // Byte offsets are decoded SSE bytes. CDP supplies any bytes received before streaming was enabled separately.
    frames(req) {
        if (this.streamingError) {
            throw this.streamingError;
        }

        if (!req.buffered) {
            return [];
        }

        const parts = [req.buffered, ...req.chunks.flatMap((x) => (x.bytes ? [x.bytes] : []))];
        const bytes = Buffer.concat(parts);

        if (bytes.length !== req.size) {
            return [];
        }

        const complete = [];
        let start = 0;

        for (;;) {
            const end = bytes.indexOf("\n\n", start);

            if (end === -1) {
                break;
            }

            const head = bytes.subarray(start, Math.min(start + 160, end)).toString();
            const name = /(?:^|\n)event: (\S+)/.exec(head)?.[1];

            if (name) {
                const chunk = req.chunks.find((x) => x.end > start);

                if (chunk) {
                    complete.push({ name, at: chunk.at, head, plain: end - start + 2 });
                }
            }

            start = end + 2;
        }

        return complete;
    }
    async close() {
        this.c.unlisten(this.sessionId);
        await this.c.send("Target.disposeBrowserContext", {
            browserContextId: this.browserContextId,
        });
    }
}

async function auth(base, token) {
    const res = await fetch(`${base}/login?token=${encodeURIComponent(token)}`, {
        redirect: "manual",
    });

    assert.equal(res.status, 303);
    const raw = res.headers.getSetCookie()[0].split(";", 1)[0];
    const first = raw.indexOf("=");

    return { name: raw.slice(0, first), value: raw.slice(first + 1), url: base };
}

async function newTab(chrome, base, cookie, fixture) {
    const c = chrome.connection;
    const context = await c.send("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await c.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context.browserContextId,
    });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(c, { targetId, sessionId, browserContextId: context.browserContextId });

    await c.send("Target.activateTarget", { targetId });
    await tab.send("Network.enable", {
        maxTotalBufferSize: 4 * 1024 * 1024,
        maxResourceBufferSize: 1024 * 1024,
    });
    await tab.send("Network.setCookie", cookie);
    await tab.send("Page.enable");
    await tab.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 960,
        deviceScaleFactor: 1,
        mobile: false,
    });
    // The startup probe attaches before the page scripts (including EventSource) run.
    await tab.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `if (/^\\/s\\/\\d+$/.test(location.pathname)) sessionStorage.setItem('open-measure-size', '${fixture.size}'); (${inBrowser.toString()})();`,
    });
    const route = await tab.send("Page.navigate", { url: `${base}/s/${fixture.id}` });

    assert.equal(route.errorText, undefined);

    return tab;
}

function onWire(req, first, cursor) {
    const i = req.events.findIndex(
        (e, at) => at >= cursor && e.name === "view" && e.prefix?.startsWith('{"full":true,'),
    );

    if (i === -1) {
        return undefined;
    }

    const whole =
        first.push.counts.partials > 0
            ? req.events.find(
                  (e, at) => at > i && e.name === "view" && e.prefix?.startsWith('{"full":false,'),
              )
            : undefined;

    if (first.push.counts.partials > 0 && !whole) {
        return undefined;
    }

    return { firstEvent: req.events[i], whole };
}

async function sample(server, tab, fixture, kind, repeat, cursor = 0, leave = undefined) {
    const switched = kind === "have";
    const trace = await until(
        () =>
            server.trace.find(
                (f, i) =>
                    i >= cursor &&
                    f.type === "wire" &&
                    f.event === "view" &&
                    f.push?.full &&
                    f.push.id === fixture.id,
            ),
        `${kind} ${fixture.size} first server view`,
    );
    const req = await until(
        () =>
            [...tab.requests.values()].findLast((r) =>
                switched
                    ? r.body?.c === fixture.id
                    : r.url.pathname === "/api/events" &&
                      Number(r.url.searchParams.get("c")) === fixture.id,
            ),
        `${kind} request`,
    );
    const stream = switched
        ? [...tab.requests.values()].findLast((r) => r.url.pathname === "/api/events")
        : req;
    const started = req.at;
    const frames = await until(() => {
        const all = tab.frames(stream);
        const ack = switched
            ? all.findIndex(
                  (f) =>
                      f.name === "switched" &&
                      JSON.parse(f.head.split("data: ")[1]).seq === req.body.seq,
              )
            : 0;

        if (ack < 0) {
            return undefined;
        }

        const first = all
            .slice(ack)
            .find((f) => f.name === "view" && f.head.includes('{"full":true,'));

        if (!first) {
            return undefined;
        }

        return { first, any: switched ? all[ack] : all.find((f) => f.name === "ping") };
    }, `${kind} CDP first SSE bytes`);
    const delivered = await until(() => {
        const boundary = switched
            ? stream.events.findIndex(
                  (e) => e.name === "switched" && JSON.parse(e.prefix).seq === req.body.seq,
              )
            : 0;

        // The decoded-byte event can arrive before CDP dispatches the EventSource event.
        return boundary < 0 ? undefined : onWire(stream, trace, boundary);
    }, `${kind} first/whole EventSource event`);

    assert.ok(delivered.firstEvent.at >= started, "EventSource notification for the wrong visit");
    const paint = await until(
        () =>
            tab
                .evaluate("window.openMeasure?.sample()")
                .then((p) => (p?.paint ? p : undefined))
                .catch(() => undefined),
        `${kind} painted rows`,
    );

    await until(
        () =>
            tab.evaluate(
                `(async () => { const s=await import('/store.js'); return s.viewSynced(${fixture.id}) && ![...s.store.state.view.entries.values()].some(e => e.partial); })()`,
            ),
        `${kind} intact browser view`,
    );
    const c = trace.push.counts;

    assert.equal(c.scanned, fixture.size);
    assert.equal(trace.probe.warm, kind === "warm" || kind === "have");
    assert.equal(c.misses, trace.probe.warm ? 0 : fixture.size);
    assert.equal(c.kept, switched ? fixture.size : 0);

    if (switched) {
        assert.ok(
            req.body.have && c.sent === 0,
            "The browser must send have and receive no entries",
        );
    }

    assert.equal(
        trace.plain,
        frames.first.plain,
        "Server and CDP disagree about the first view byte range",
    );
    assert.ok(
        trace.firstWrite !== undefined && frames.any?.at !== undefined,
        "No socket write or first event bytes",
    );
    const first = trace.firstWrite - trace.probe.at;
    const control = await until(
        () =>
            server.trace.find(
                (f) =>
                    f.type === "wire" &&
                    f.event === (switched ? "switched" : "ping") &&
                    f.probe.req === trace.probe.req,
            ),
        `${kind} server control event`,
    );
    const follow = server.trace.find(
        (f) =>
            f.type === "wire" &&
            f.event === "view" &&
            f.push?.full === false &&
            f.probe.req === trace.probe.req,
    );

    assert.equal(Boolean(follow), c.partials > 0);

    if (kind === "closed") {
        assert.ok(leave !== undefined && trace.probe.at - leave >= 31000);
        assert.ok(
            server.trace.some(
                (f) =>
                    f.type === "roomClosed" &&
                    f.id === fixture.id &&
                    f.at >= leave &&
                    f.at < trace.probe.at,
            ),
        );
    }

    if (kind === "warm") {
        assert.ok(leave !== undefined && trace.probe.at - leave < 30000);
    }

    return {
        type: "sample",
        size: fixture.size,
        kind,
        repeat,
        readyMs: server.startup,
        load: load(),
        firstAny: frames.any.at - started,
        firstView: frames.first.at - started,
        firstEvent: delivered.firstEvent.at - started,
        whole: delivered.whole === undefined ? undefined : delivered.whole.at - started,
        dom: paint.dom - started,
        paint: paint.paint - started,
        switchPaint: switched ? paint.paint - paint.action : undefined,
        serverAny: control.firstWrite - trace.probe.at,
        serverFirst: first,
        socketWrite: trace.writeMs,
        compressionToWrite: trace.firstWrite - trace.at - trace.encode,
        encode: trace.encode,
        plain: trace.plain,
        wire: trace.bytes,
        wholePlain: follow?.plain,
        wholeWire: follow?.bytes,
        wholePreparedBeforeFirstSocket: follow
            ? Math.max(
                  0,
                  Math.min(trace.firstWrite, follow.at + follow.encode) -
                      Math.max(trace.at + trace.encode, follow.push.at),
              )
            : undefined,
        encoding: trace.encoding,
        parts: trace.probe.parts,
        push: trace.push.through,
        counts: c,
        perEntryNs: (trace.push.through.project * 1e6) / c.scanned,
        elapsedSinceLeave: leave === undefined ? undefined : trace.probe.at - leave,
    };
}

function cpuPair() {
    const spec = /Cpus_allowed_list:\s*(\S+)/.exec(readFileSync("/proc/self/status", "utf8"))[1];

    return spec
        .split(",")
        .flatMap((s) => {
            const [a, b = a] = s.split("-").map(Number);

            return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
        })
        .slice(0, 2)
        .join(",");
}

async function run() {
    const options = process.argv.slice(2);
    const help = options.length === 1 && options[0] === "--help";

    if (help) {
        console.log(
            "Usage: node scripts/perf/open-measure.mjs [--runs=N] (default 10). Use the 200% systemd scope; install this checkout's dependencies first. Raw JSONL output stays in its printed temporary folder.",
        );

        return;
    }

    if (options.length > 1 || options.some((s) => !/^--runs=(?:[1-9]|[1-9][0-9])$/.test(s))) {
        throw new Error("Only --runs=N (1–99) is supported; see --help");
    }

    const runs = Number(options[0]?.split("=")[1] ?? 10);

    assert.equal(git(repo, "rev-parse", `${revision}^{commit}`), revision);
    const work = mkdtempSync(join(tmpdir(), "pocket-open-"));
    const file = join(work, "open.jsonl");

    mkdirSync(join(work, "tmp"));
    const code = makeCopy(work);
    const { Chromium } = await mod(code, "src/server/browser/cdp.ts");
    const { findBrowser } = await mod(code, "src/server/browser/discovery.ts");
    const chromeBin = findBrowser();

    assert.ok(chromeBin, "Install a sandboxed Chromium or set PI_POCKET_BROWSER");
    const shim = join(work, "chrome-cpu");

    writeFileSync(
        shim,
        `#!/bin/sh\nexec taskset -c ${cpuPair()} '${chromeBin.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o700 },
    );
    console.error(`Workspace: ${work}`);
    const init = launched(code, work, "seed");
    const fixtures = (await init.connected).fixtures;

    assert.equal((await init.done).status, 0);
    record(file, {
        type: "fixtures",
        fixtures,
        node: process.version,
        revision,
        at: new Date().toISOString(),
        load: load(),
    });
    const chrome = await Chromium.launch(shim, join(work, "browser"), [
        "--renderer-process-limit=1",
    ]);

    record(file, { type: "browser", version: chrome.version, cpus: cpuPair() });
    console.error(`Chromium ${chrome.version}; ${runs} runs per case`);
    const store = (row) => record(file, row);
    let server;

    async function start() {
        server = launched(code, work, "bench");
        const ready = await server.connected;

        server.startup = ready.bootMs;
        server.base = ready.base;
        server.cookie = await auth(ready.base, ready.token);
        store({ type: "boot", load: load(), bootMs: ready.bootMs, processMs: ready.processMs });
    }

    async function open(fixture, kind, repeat, leave) {
        const before = load();
        const cursor = server.trace.length;
        const tab = await newTab(chrome, server.base, server.cookie, fixture);

        try {
            const row = await sample(server, tab, fixture, kind, repeat, cursor, leave);

            store({ ...row, before });

            if (kind === "cold") {
                // Wait for the actual in-tab retained snapshot before issuing a real switch back.
                await tab.evaluate("(async()=>{ (await import('/store.js')).navigate(null); })()");
                await until(() => {
                    const events =
                        [...tab.requests.values()].find((r) => r.url.pathname === "/api/events")
                            ?.events ?? [];
                    const req = [...tab.requests.values()].findLast((r) => r.body?.c === null);

                    return (
                        req &&
                        events.some(
                            (e) =>
                                e.name === "switched" && JSON.parse(e.prefix).seq === req.body.seq,
                        )
                    );
                }, "server acknowledged leaving the fixture");
                await until(
                    () =>
                        tab.evaluate(
                            `!document.querySelector('[data-part="transcript"]')?.textContent.includes(${JSON.stringify(marker(fixture.size))})`,
                        ),
                    "previous rows removed",
                );
                const i = server.trace.length;
                const switchBefore = load();

                await tab.evaluate(
                    `(async()=>{ const s=await import('/store.js'); window.openMeasure.start(${fixture.size}); s.navigate(${fixture.id}); })()`,
                );
                store({
                    ...(await sample(server, tab, fixture, "have", repeat, i)),
                    before: switchBefore,
                });
            }
        } finally {
            await tab.close();
        }

        return ms();
    }

    const ordered = (i) => [
        ...fixtures.slice(i % fixtures.length),
        ...fixtures.slice(0, i % fixtures.length),
    ];

    try {
        store({
            type: "set-start",
            group: "restart, have, warm",
            at: new Date().toISOString(),
            load: load(),
        });

        for (let trial = 0; trial < runs; trial++) {
            for (const f of ordered(trial)) {
                await sleep(1000);
                await until(
                    () => parseFloat(load()) <= 5.5,
                    "opti2 load at most 5.50 before a restart",
                    5 * 60 * 1000,
                    3000,
                );
                await start();
                const left = await open(f, "cold", trial);

                await open(f, "warm", trial, left);
                await server.close();
                server = undefined;
                console.error(`restart/warm/have ${trial + 1}/${runs}, ${f.size}`);
            }
        }

        store({
            type: "set-end",
            group: "restart, have, warm",
            at: new Date().toISOString(),
            load: load(),
        });
        await start();
        store({
            type: "set-start",
            group: "expired room",
            at: new Date().toISOString(),
            load: load(),
        });
        const left = new Map();

        for (const f of fixtures) {
            const tab = await newTab(chrome, server.base, server.cookie, f);

            try {
                await until(
                    () =>
                        tab.evaluate(
                            `(async()=> (await import('/store.js')).viewSynced(${f.id}))()`,
                        ),
                    "prime expiry",
                );
            } finally {
                await tab.close();
            }

            left.set(f.id, ms());
        }

        for (let trial = 0; trial < runs; trial++) {
            await sleep(Math.max(0, Math.max(...left.values()) + 31100 - ms()));

            for (const f of ordered(trial)) {
                await until(
                    () => parseFloat(load()) <= 5.5,
                    "opti2 load at most 5.50 before an expired-room open",
                    5 * 60 * 1000,
                    3000,
                );
                const time = await open(f, "closed", trial, left.get(f.id));

                left.set(f.id, time);
                console.error(`expired room ${trial + 1}/${runs}, ${f.size}`);
            }
        }

        store({
            type: "set-end",
            group: "expired room",
            at: new Date().toISOString(),
            load: load(),
        });
    } finally {
        try {
            await server?.close();
        } finally {
            await chrome.connection.send("Browser.close").catch(() => chrome.kill());
            await chrome.exited;
        }
    }

    console.log(file);
}

if (process.argv[2] === "--server") {
    await serve(...process.argv.slice(3));
} else {
    await run();
}
