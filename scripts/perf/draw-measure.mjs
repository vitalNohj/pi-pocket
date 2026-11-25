/** Profile transcript opens in an isolated copy of d10ab891. Only this script is installed. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

const own = fileURLToPath(import.meta.url);
const repo = resolve(dirname(own), "../..");
const rev = "d10ab8914256c3102a0d0740dad29aede0201d5d";
const sizes = [200, 2000, 10000];
const load = () => readFileSync("/proc/loadavg", "utf8").trim();
const mod = (dir, name) => import(pathToFileURL(join(dir, name)).href);

// Appended only to the private test/serve.ts after its scripted demo session is created.
export async function seed(app, { context, newSession, owner, work }, port) {
    const { UserEntry, AssistantEntry, ToolResultEntry } = await mod(
        process.cwd(),
        "node_modules/@earendil-works/pi-durable/dist/index.js",
    );
    const { AuthorsDoc } = await mod(process.cwd(), "src/server/docs.ts");
    const fixtures = [];

    writeFileSync(join(work, "chart.png"), chart());
    const usage = {
        input: 78,
        output: 305,
        cacheRead: 20,
        cacheWrite: 0,
        totalTokens: 403,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const text = (s) => ({ type: "text", text: s });
    const author = owner(app).id;

    for (const size of sizes) {
        const id = await newSession(app, work);
        const total = size / 5;
        let last;
        let bytes = 0;
        let images = 0;
        let lastImage;

        for (let start = 0; start < total; start += 25) {
            await app.harness.commit(async (tx) => {
                const authors = await tx.doc(AuthorsDoc, id);

                for (let i = start; i < Math.min(total, start + 25); i++) {
                    const stamp = 1764000000000 + i * 90_000;
                    const file = `src/data/partition-${i % 37}.ts`;
                    const read = `read-${i}`;
                    const bash = `bash-${i}`;
                    const turn = (content, stopReason, timestamp) => ({
                        role: "assistant",
                        content,
                        stopReason,
                        timestamp,
                        api: "faux",
                        provider: "faux",
                        model: "faux-1",
                        usage,
                        durationMs: 1800,
                    });

                    const add = async (token, message) => {
                        const payload = { model: [message] };

                        bytes += Buffer.byteLength(JSON.stringify(payload));

                        return tx.appendEntry(token, id, payload);
                    };

                    const u = await add(UserEntry, {
                        role: "user",
                        timestamp: stamp,
                        content: `Show how you validated cache partition ${i}. Read ${file}, run its checks, and provide the relevant snippet.`,
                    });

                    authors.entries[String(u.id)] = author;
                    await add(
                        AssistantEntry,
                        turn(
                            [
                                {
                                    type: "thinking",
                                    thinking:
                                        `Check the read path first. For partition ${i}, compare retry bounds, then verify the process log. `.repeat(
                                            10,
                                        ),
                                },
                                {
                                    type: "toolCall",
                                    id: read,
                                    name: "read",
                                    arguments: { path: file },
                                },
                                {
                                    type: "toolCall",
                                    id: bash,
                                    name: "bash",
                                    arguments: { command: `npm test -- partition-${i % 37}` },
                                },
                            ],
                            "toolUse",
                            stamp + 200,
                        ),
                    );
                    await add(ToolResultEntry, {
                        role: "toolResult",
                        toolCallId: read,
                        toolName: "read",
                        content: [text(toolText(i, i % 17 === 16 ? 51200 : 2048, false))],
                        isError: false,
                        timestamp: stamp + 420,
                    });
                    await add(ToolResultEntry, {
                        role: "toolResult",
                        toolCallId: bash,
                        toolName: "bash",
                        content: [text(toolText(i, i % 23 === 22 ? 114688 : 3584, true))],
                        isError: false,
                        timestamp: stamp + 1670,
                    });
                    const image = i % 8 === total % 8 || i === total - 1;
                    const answer = await add(
                        AssistantEntry,
                        turn(
                            [text(markdown(i, file, id, size, image, i === total - 1))],
                            "stop",
                            stamp + 2260,
                        ),
                    );

                    last = Number(answer.id);

                    if (image) {
                        images++;
                        lastImage = last;
                    }
                }
            }, context);
        }

        const convo = await app.conversation(id);

        assert.equal((await convo.context(context)).entries.length, size);
        fixtures.push({ id: Number(id), size, last, lastImage, bytes, images });
    }

    // Keep each room warm before the first round. The real detach timer takes over after its first visit.
    for (const fixture of fixtures) {
        await app.room(fixture.id);
    }

    process.send?.({ type: "ready", port, token: app.config.ownerToken, fixtures });
}

function toolText(seed, limit, shell) {
    let state = seed + 81;
    let bytes = 0;
    const out = [];

    while (bytes < limit) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const hash = state.toString(16).padStart(8, "0");
        const n = out.length;
        const line = shell
            ? `PASS cache/check-${n % 62}.spec.ts  case=${n}  digest=${hash} dt=${state % 149}ms\n`
            : `export const group_${n} = { digest: '${hash}', retry: ${state % 7}, timeout_ms: ${300 + (state % 2048)} };\n`;

        out.push(line);
        bytes += line.length;
    }

    return out.join("").slice(0, limit);
}

function markdown(i, path, id, size, image, final) {
    const lang = ["typescript", "python", "rust", "bash"][i % 4];
    const blocks = {
        typescript: (j) =>
            `export const segment_${j} = await cache.getOrSet('partition:${i}/${j}', () => readBatch(${i + j}));`,
        python: (j) =>
            `segment_${j} = [f'record:{key}' for key in store.read_batch(${i + j}) if key not in stale]`,
        rust: (j) =>
            `let segment_${j}: Vec<_> = partitions[${(i + j) % 37}].iter().filter(|x| x.is_ready()).collect();`,
        bash: (j) =>
            `printf 'slot=%s checksum=%s\\n' '${i}.${j}' "$(sha256sum fixture-${j}.txt | cut -c 1-12)"`,
    };
    const fence = "```";
    const title = final
        ? `Draw fixture ${size}: final review`
        : `Cache partition ${i}: validation report`;

    return [
        `### ${title}`,
        `I read \`${path}\` and compared the eviction trace with the expected behavior. The test fixture selects partition **${i}**, uses a bounded retry, then rejects a stale result before the next read. The samples are synthetic, but partition boundaries and retry counts follow the example configuration.`,
        `The run completed without changing a source file. It exercised the read path, a slow retry, and a cache hit on the next pass. In a production review, compare the slowest group with its queue depth before changing the limit. Keep the exact result with the current run so the next check has a baseline.`,
        `${fence}${lang}\n${Array.from({ length: 15 + (i % 8) }, (_, j) => blocks[lang](j)).join("\n")}\n${fence}`,
        i % 3 === 0
            ? "| Stage | Result | Check |\n| --- | --- | --- |\n| Read | OK | checksum |\n| Retry | OK | deadline |\n| Commit | none | tree clean |"
            : "- Keep structured output for the next comparison.\n- Do not raise the retry limit until the slow group is understood.",
        i % 5 === 0 || final
            ? "For this bound, $T = t_q + \\sum_{i=1}^{n} t_i$. The tail is more important than a single average."
            : "The result is ready for review. No global configuration changed.",
        image ? `![Synthetic partition timing chart](/api/c/${id}/file?path=chart.png)` : "",
        final ? `End of draw fixture ${size}.` : "",
    ].join("\n\n");
}

function chart() {
    const w = 600,
        h = 304;
    const pixels = Buffer.alloc(h * (w * 3 + 1));

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * (w * 3 + 1) + 1 + 3 * x;
            const line = Math.abs(y - (160 + 48 * Math.sin(x / 35) + 25 * Math.cos(x / 12))) < 3;
            const grid = x % 47 === 0 || y % 38 === 0;

            pixels[p] = line ? 38 : grid ? 174 : 232 + ((x + y) % 8);
            pixels[p + 1] = line ? 147 : grid ? 174 : 232 + (y % 8);
            pixels[p + 2] = line ? 211 : grid ? 192 : 240 + (x % 8);
        }
    }

    const ihdr = Buffer.alloc(13);

    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;

    const chunk = (name, bytes) => {
        const body = Buffer.concat([Buffer.from(name), bytes]);
        let crc = 0xffffffff;

        for (const x of body) {
            crc ^= x;

            for (let i = 0; i < 8; i++) {
                crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
            }
        }

        const out = Buffer.alloc(body.length + 8);

        out.writeUInt32BE(bytes.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);

        return out;
    };

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

// Injected at the start of each browser document. DOM observation only; no forced image decode or layout read.
function inPage(fixture, kind, auto) {
    let active = auto,
        source,
        firstEvent,
        dom;
    const mark = (name, detail) =>
        active ? performance.mark(`dp.${name}`, { detail }) : undefined;
    const start = () => (active ? performance.now() : undefined);

    const done = (name, at, detail) => {
        if (at !== undefined) {
            performance.measure(`dp.${name}`, { start: at, end: performance.now(), detail });
        }
    };

    const time = (name, fn, detail) => {
        const at = start();

        try {
            return fn();
        } finally {
            done(name, at, detail);
        }
    };

    const inspect = () => {
        if (!active || dom !== undefined || source === undefined) {
            return;
        }

        const tail = document.getElementById(`entry-${fixture.last}`);
        const transcript = tail?.closest('[data-part="transcript"]');

        if (!transcript || tail.closest("[hidden]")) {
            return;
        }

        dom = mark("dom", { rows: transcript.children.length }).startTime;
        requestAnimationFrame(() => {
            mark("raf1");
            requestAnimationFrame(() => mark("proxy"));
        });
    };

    const fromObserver = new MutationObserver(inspect);

    if (auto) {
        fromObserver.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["hidden"],
        });
    }

    const dp = {
        mark,
        start,
        done,
        time,
        target: fixture.id,
        arm() {
            active = true;
            fromObserver.observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["hidden"],
            });
            mark("switch");
        },
        event(name, event, parse) {
            const at = start();

            if (at === undefined || (name !== "view" && name !== "cached-view")) {
                return parse();
            }

            const data = parse();
            const end = performance.now();

            if (data.conversation?.id === fixture.id) {
                performance.measure("dp.json", {
                    start: at,
                    end,
                    detail: {
                        full: data.full,
                        bytes: event.data.length,
                        entries: data.entries?.length,
                    },
                });
                performance.mark(
                    data.full ? "dp.event" : data.entries?.length ? "dp.whole" : "dp.delta",
                    {
                        startTime: at,
                        detail: {
                            entries: data.entries?.length,
                            orderFrom: data.orderFrom ?? null,
                        },
                    },
                );

                if (data.full) {
                    firstEvent ??= at;
                }
            }

            return data;
        },
        content(change) {
            if (
                !active ||
                source !== undefined ||
                change.view?.conversation?.id !== fixture.id ||
                change.view.entries.size === 0
            ) {
                return;
            }

            source =
                kind === "first"
                    ? "sse"
                    : kind === "device" && firstEvent === undefined
                      ? "device"
                      : kind === "switch" && firstEvent === undefined
                        ? "memory"
                        : "sse";
            mark("ready", { source, entries: change.view.entries.size });
        },
        renderStart(vnode) {
            if (active && vnode.type?.name === "Transcript") {
                vnode.__drawMeasure = start();
            }
        },
        renderEnd(vnode) {
            if (vnode.__drawMeasure !== undefined) {
                done("transcript", vnode.__drawMeasure);
            }
        },
        stage() {
            return {
                source,
                dom,
                proxy: performance.getEntriesByName("dp.proxy").length,
                math: document.querySelectorAll('[data-part="transcript"] .katex').length,
                img: [...document.querySelectorAll('[data-part="transcript"] img')].filter(
                    (e) => e.naturalWidth > 0,
                ).length,
            };
        },
        result() {
            return [
                ...performance.getEntriesByType("mark"),
                ...performance.getEntriesByType("measure"),
            ]
                .filter((e) => e.name.startsWith("dp."))
                .map((e) => [e.name.slice(3), e.startTime, e.duration, e.detail]);
        },
    };

    document.addEventListener(
        "load",
        (e) => {
            if (
                active &&
                e.target?.tagName === "IMG" &&
                e.target.closest('[data-part="transcript"]')
            ) {
                mark("imageLoad");
            }
        },
        true,
    );
    globalThis.__draw = dp;

    if (auto) {
        mark("boot");
    }
}

function instrument(code) {
    const file = (name, edit) => {
        const path = join(code, name);

        writeFileSync(path, edit(readFileSync(path, "utf8")));
    };

    const replace = (s, a, b) => {
        const at = s.indexOf(a);

        assert.ok(
            at >= 0 && s.indexOf(a, at + a.length) < 0,
            `Wrong revision for ${a.slice(0, 120)}`,
        );

        return s.slice(0, at) + b + s.slice(at + a.length);
    };

    const span = (s, start, stop, name) => {
        const a = s.indexOf(start),
            b = s.indexOf(stop, a + start.length);

        assert.ok(a >= 0 && b >= 0, name);

        return (
            s.slice(0, a + start.length) +
            `\n        const dp = globalThis.__draw;\n        const dpAt = dp?.start();\n        try {` +
            s.slice(a + start.length, b) +
            `\n        } finally { dp?.done('${name}', dpAt); }\n` +
            s.slice(b)
        );
    };

    file("test/serve.ts", (s) =>
        replace(
            s,
            'await say(app, session, "Hello from the copy");',
            `await say(app, session, "Hello from the copy");\nawait (await import(${JSON.stringify(pathToFileURL(own).href)})).seed(app, await import('./helpers.ts'), (server.address() as { port: number }).port);`,
        ),
    );
    file("web/app.js", (s) => {
        s = replace(
            s,
            'import { render } from "preact";',
            'import { render as preactRender, options as preactOptions } from "preact";',
        );

        return replace(
            s,
            'const root = document.getElementById("app");',
            `const dp = globalThis.__draw;\nif (dp) {\n const before = preactOptions.__b, after = preactOptions.diffed;\n preactOptions.__b = (node) => { before?.(node); dp.renderStart(node); };\n preactOptions.diffed = (node) => { dp.renderEnd(node); after?.(node); };\n}\nconst render = (...args) => dp ? dp.time("preact", () => preactRender(...args)) : preactRender(...args);\nconst root = document.getElementById("app");`,
        );
    });
    file("web/store.js", (s) => {
        s = replace(
            s,
            "        this.state = { ...this.state, ...change };",
            `        globalThis.__draw?.content(change);\n        this.state = { ...this.state, ...change };`,
        );
        s = span(s, "    set(patch) {", "    },\n    /**", "store.set");
        s = span(
            s,
            "function mergeView(current, data, repairLive = true) {",
            "\n}\n",
            "store.merge",
        );
        s = span(s, "function applyView(data) {", "\n}\n", "store.apply");

        return replace(
            s,
            `            const data = JSON.parse(event.data);\n\n            if (settles.includes`,
            `            const draw = globalThis.__draw;\n            const data = draw ? draw.event(name, event, () => JSON.parse(event.data)) : JSON.parse(event.data);\n\n            if (settles.includes`,
        );
    });
    file("web/session-cache.js", (s) =>
        span(s, "export async function read(id, touch = true) {", "\n}\n", "device.read"),
    );
    file("web/ui.js", (s) => {
        s = span(
            s,
            'export function Markdown({\n    text,\n    class: className = "",\n    cache = true,\n    base = null,\n    breaks = true,\n    conversationId = currentConversation(),\n}) {',
            "\n}\n",
            "markdown.component",
        );
        s = span(
            s,
            "function renderParts(text, conversationId, base, breaks, fold) {",
            "\n}\n",
            "markdown.build",
        );
        s = span(s, "function partsOf(holder) {", "\n}\n", "markdown.parts");

        return replace(
            s,
            "        return partsOf(sanitize(marked.parse(text, { async: false, breaks }), fold));",
            `        const meter = globalThis.__draw;\n        const html = meter ? meter.time('markdown.parse', () => marked.parse(text,{async:false,breaks})) : marked.parse(text,{async:false,breaks});\n        return partsOf(meter ? meter.time('markdown.sanitize', () => sanitize(html, fold)) : sanitize(html, fold));`,
        );
    });
    file("web/highlight.js", (s) =>
        span(s, "export function highlight(code, lang) {", "\n}\n", "highlight"),
    );
    file("web/markdown-ext.js", (s) =>
        replace(
            s,
            "    revision++;",
            "    revision++;\n    globalThis.__draw?.mark('markdown.revision', { revision });",
        ),
    );
    file("src/server/extensions/diagrams/index.js", (s) =>
        span(s, "function renderMath(katex, source, display) {", "\n}\n", "math"),
    );
    file("web/transcript.js", (s) => {
        s = span(s, "    const toEnd = (element) => {", "\n    };", "scroll.toEnd");
        s = span(s, "    function place(element) {", "\n    }", "scroll.place");
        s = span(s, "    function restorePlace(element) {", "\n    }", "scroll.restorePlace");
        s = span(s, "    function catchUp(element) {", "\n    }", "scroll.catchUp");

        return span(s, "function anchorOf(scroller, column, bottom) {", "\n}\n", "scroll.anchor");
    });
}

const mobile = { name: "phone", width: 390, height: 844, rate: 4, mobile: true };
const desktop = { name: "desktop", width: 1440, height: 960, rate: 1, mobile: false };
const kinds = ["first", "device", "switch"];
const categories = [
    "blink.user_timing",
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "v8",
];

async function until(fn, title, timeout = 30000) {
    const stop = Date.now() + timeout;

    do {
        const result = await fn();

        if (result) {
            return result;
        }

        await sleep(60);
    } while (Date.now() < stop);

    throw new Error(`Timed out: ${title}`);
}

class Page {
    constructor(connection, sessionId, targetId) {
        this.conn = connection;
        this.id = sessionId;
        this.targetId = targetId;
        this.requests = [];
        this.errors = [];
        connection.listen(sessionId, (method, p) => {
            if (method === "Runtime.exceptionThrown") {
                this.errors.push(
                    p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
                );
            }

            if (
                method === "Network.requestWillBeSent" &&
                /\/api\/(events\?|switch$)/.test(p.request.url)
            ) {
                this.requests.push({
                    path: new URL(p.request.url).pathname,
                    query: new URL(p.request.url).search,
                    post: p.request.postData,
                });
            }
        });
    }
    send(m, p = {}) {
        return this.conn.send(m, p, this.id);
    }
    async eval(expression) {
        const r = await this.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });

        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        }

        return r.result.value;
    }
    async close() {
        this.conn.unlisten(this.id);
        await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    }
}

async function tab(c, context, screen, fixture, kind, automatic, cookie) {
    const { targetId } = await c.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context,
    });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    const p = new Page(c, sessionId, targetId);

    await c.send("Target.activateTarget", { targetId });
    await Promise.all([
        p.send("Page.enable"),
        p.send("Network.enable"),
        p.send("Runtime.enable"),
        p.send("Performance.enable"),
    ]);
    await p.send("Emulation.setDeviceMetricsOverride", {
        width: screen.width,
        height: screen.height,
        mobile: screen.mobile,
        deviceScaleFactor: screen.mobile ? 2 : 1,
    });

    if (screen.mobile) {
        await p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }

    await p.send("Emulation.setCPUThrottlingRate", { rate: screen.rate });
    await p.send("Network.setCookie", cookie);
    await p.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${inPage.toString()})(${JSON.stringify(fixture)},${JSON.stringify(kind)},${automatic});`,
    });

    return p;
}

async function streamTrace(c, file) {
    let finish;
    const ended = new Promise((resolve) => (finish = resolve));

    c.onEvent = (method, p) => {
        if (method === "Tracing.tracingComplete") {
            finish(p);
        }
    };

    await c.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: { recordMode: "recordUntilFull", includedCategories: categories },
    });

    return async () => {
        await c.send("Tracing.end");
        const timer = new AbortController();
        const got = await Promise.race([ended, sleep(20000, null, { signal: timer.signal })]);

        timer.abort();
        assert.ok(got?.stream && !got.dataLossOccurred, "Incomplete DevTools trace");
        const parts = [];

        try {
            for (;;) {
                const result = await c.send("IO.read", { handle: got.stream, size: 524288 });

                parts.push(Buffer.from(result.data, result.base64Encoded ? "base64" : "utf8"));

                if (result.eof) {
                    break;
                }
            }
        } finally {
            await c.send("IO.close", { handle: got.stream });
            c.onEvent = undefined;
        }

        const raw = Buffer.concat(parts);

        if (file) {
            writeFileSync(file, gzipSync(raw), { mode: 0o600 });
        }

        return JSON.parse(raw.toString()).traceEvents;
    };
}

const number = (x) => (x === undefined ? undefined : +x.toFixed(3));

function measure(events, marks, stage, metrics, fixture) {
    const marksOf = (m) => marks.filter((x) => x[0] === m);
    const at = (m) => marksOf(m)[0]?.[1];
    const hit = events.find((x) => x.name === "dp.dom" && /blink.user_timing/.test(x.cat));

    assert.ok(hit, "Trace lacks dp.dom synchronization mark");
    const offset = hit.ts / 1000 - at("dom");
    const rel = (e) => e.ts / 1000 - offset;
    const main = events.filter((e) => e.pid === hit.pid && e.tid === hit.tid);
    const browserFrame = main
        .filter((e) => e.name === "Paint" && e.ph === "X" && rel(e) >= at("dom") - 0.03)
        .sort((a, b) => a.ts - b.ts)[0];
    const drawFrame = events
        .filter((e) => e.name === "DrawFrame" && e.pid === hit.pid && rel(e) >= at("dom") - 0.03)
        .sort((a, b) => a.ts - b.ts)[0];

    assert.ok(browserFrame || drawFrame, `No frame after inserting entry ${fixture.last}`);
    // A composited frame can reuse old tiles without a main-thread Paint. Keep the selected boundary explicit.
    const frame = browserFrame ?? drawFrame;
    const paint = rel(frame) + (frame.dur ?? 0) / 1000;
    const ready = at("ready");
    const event = at("event");
    const earliest = event !== undefined ? Math.min(event, ready) : ready;

    const work = (names, from = earliest, through = paint, entries = main) => {
        const intervals = entries
            .filter((e) => e.ph === "X" && e.dur >= 0 && names.test(e.name))
            .map((e) => [Math.max(from, rel(e)), Math.min(through, rel(e) + e.dur / 1000)])
            .filter(([a, b]) => b > a);

        return union(intervals);
    };

    const sum = (filter, from = earliest, to = paint) =>
        union(
            marks
                .filter((x) => filter.test(x[0]) && x[2] > 0)
                .map((x) => [Math.max(from, x[1]), Math.min(to, x[1] + x[2])])
                .filter(([a, b]) => b > a),
        );
    const allRenderer = events.filter((e) => e.pid === hit.pid);
    const style = /^(UpdateLayoutTree|RecalculateStyles|Layout|PrePaint)$/;
    const paintNames = /^(Paint|PaintImage|Layerize)$/;
    const scrolls = marks.filter((x) => x[0].startsWith("scroll."));
    let syncLayout = 0;

    for (const s of scrolls) {
        syncLayout += work(style, s[1], Math.min(paint, s[1] + s[2]));
    }

    const decode = /^(Decode Image|ImageDecodeTask|ImageDecode|Draw LazyPixelRef)$/;
    const layoutPastDom = work(style, at("dom"), paint);
    const viewport = metrics.metrics.find((x) => x.name === "LayoutCount")?.value;
    const lead = event !== undefined ? event - earliest : undefined;
    const markSums = Object.fromEntries(
        [...new Set(marks.filter((x) => x[2] > 0 && x[0] !== "device.read").map((x) => x[0]))].map(
            (k) => [k, number(sum(new RegExp(`^${k.replaceAll(".", "\\.")}$`)))],
        ),
    );
    const crop = (intervals) =>
        intervals
            .map(([a, b]) => [Math.max(earliest, a), Math.min(paint, b)])
            .filter(([a, b]) => b > a);
    const named = (re) =>
        crop(marks.filter((x) => re.test(x[0]) && x[2] > 0).map((x) => [x[1], x[1] + x[2]]));
    const native = (re) =>
        crop(
            main
                .filter((e) => e.ph === "X" && e.dur >= 0 && re.test(e.name))
                .map((e) => [rel(e), rel(e) + e.dur / 1000]),
        );
    let assigned = [];
    const exclusive = Object.fromEntries(
        [
            ["styleLayout", native(style)],
            ["paint", native(paintNames)],
            ["scroll", named(/^scroll\./)],
            ["markdown", named(/^markdown\.build$/)],
            ["math", named(/^math$/)],
            ["preact", named(/^preact$/)],
            ["jsonStore", named(/^(json|store\.set|store\.apply)$/)],
            ["otherMain", native(/^RunTask$/)],
        ].map(([key, ranges]) => {
            const value = union([...assigned, ...ranges]) - union(assigned);

            assigned = [...assigned, ...ranges];

            return [key, number(value)];
        }),
    );

    exclusive.unassigned = number(Math.max(0, paint - earliest - union(assigned)));

    return {
        source: stage.source,
        ready: number(ready),
        event: number(event),
        dom: number(at("dom")),
        paint: number(paint),
        proxy: number(at("proxy")),
        ui: number(paint - ready),
        afterEvent: number(event === undefined ? undefined : paint - event),
        firstEventInWindow: event !== undefined && event < paint,
        lead: number(lead),
        actionPaint: number(paint - (at("switch") ?? 0)),
        domAfterReady: number(at("dom") - ready),
        domToPaint: number(paint - at("dom")),
        proxyLag: number(at("proxy") - paint),
        frame: frame.name,
        frameCount: main.filter((e) => e.name === "Paint" && rel(e) >= at("dom") && rel(e) <= paint)
            .length,
        scroll: number(sum(/^scroll\./)),
        syncLayout: number(syncLayout),
        styleLayout: number(work(style)),
        layoutAfterDom: number(layoutPastDom),
        paintWork: number(work(paintNames)),
        gc: number(work(/^(MajorGC|MinorGC|V8.GCScavenger|V8.GCCompactor|V8.GCFinalizeMC)$/)),
        tasks: number(work(/^RunTask$/)),
        jsonFirst: number(marksOf("json").find((x) => x[3]?.full)?.[2]),
        firstEntries: marksOf("event")[0]?.[3]?.entries,
        wholeBeforePaint: at("whole") !== undefined && at("whole") < paint,
        renders: marksOf("preact").filter((x) => x[1] >= earliest && x[1] < paint).length,
        markdownMisses: marksOf("markdown.build").filter((x) => x[1] >= earliest && x[1] < paint)
            .length,
        markdownCalls: marksOf("markdown.component").filter((x) => x[1] >= earliest && x[1] < paint)
            .length,
        markdownRevisions: marksOf("markdown.revision").filter(
            (x) => x[1] >= earliest && x[1] < paint,
        ).length,
        // Exclusive wall buckets: subtract nested work before assigning a span. Gaps include frame/task scheduling.
        cpuKnown: number(
            union(
                [
                    ...marks
                        .filter((x) =>
                            /^(store\.apply|store\.set|json|preact|scroll\.|math)/.test(x[0]),
                        )
                        .map((x) => [Math.max(earliest, x[1]), Math.min(paint, x[1] + x[2])]),
                    ...main
                        .filter(
                            (e) => e.ph === "X" && (style.test(e.name) || paintNames.test(e.name)),
                        )
                        .map((e) => [
                            Math.max(earliest, rel(e)),
                            Math.min(paint, rel(e) + e.dur / 1000),
                        ]),
                ].filter(([a, b]) => b > a),
            ),
        ),
        mathAfter: number(sum(/^math$/, paint, paint + 350)),
        mathObserved: stage.math,
        imgObserved: stage.img,
        imagesLoaded: marksOf("imageLoad").length,
        firstImageFromPaint: number(
            at("imageLoad") === undefined ? undefined : at("imageLoad") - paint,
        ),
        decodeByPaint: number(work(decode, earliest, paint, allRenderer)),
        decodeNext: number(work(decode, paint, paint + 350, allRenderer)),
        decodeNames: [
            ...new Set(
                allRenderer
                    .filter(
                        (e) => decode.test(e.name) && rel(e) >= earliest && rel(e) < paint + 350,
                    )
                    .map((e) => e.name),
            ),
        ],
        disk: number(marksOf("device.read")[0]?.[2]),
        rows: marksOf("dom")[0]?.[3]?.rows,
        layoutCount: viewport,
        traceSamples: events.length,
        exclusive,
        measures: markSums,
    };
}

function union(parts) {
    let total = 0,
        end = -Infinity;

    for (const [a, b] of parts.sort((x, y) => x[0] - y[0])) {
        if (b > end) {
            total += b - Math.max(end, a);
            end = b;
        }
    }

    return total;
}

const loginCookie = async (base, token) => {
    const r = await fetch(`${base}/login?token=${encodeURIComponent(token)}`, {
        redirect: "manual",
    });

    assert.equal(r.status, 303);
    const [raw] = r.headers.getSetCookie();
    const s = raw.split(";", 1)[0],
        eq = s.indexOf("=");

    return { name: s.slice(0, eq), value: s.slice(eq + 1), url: base };
};

const navigate = (p, id) => p.eval(`(async()=>{ (await import('/store.js')).navigate(${id}); })()`);
const settled = (p, id) =>
    until(
        () =>
            p.eval(
                `(async()=>{const s=await import('/store.js');return s.viewSynced(${id}) && ![...s.store.state.view.entries.values()].some(e=>e.partial);})()`,
            ),
        `priming whole session ${id}`,
    );

async function prime(c, context, screen, f, kind, cookie, base) {
    const p = await tab(c, context, screen, f, kind, false, cookie);

    await p.send("Page.navigate", { url: `${base}/s/${f.id}` });
    await until(
        () =>
            p
                .eval(
                    `location.pathname === '/s/${f.id}' && document.querySelector('[data-part="transcript"]') !== null`,
                )
                .catch(() => false),
        "loaded transcript",
    );
    await settled(p, f.id);

    // Keep normal bottom behavior on half the returns. Move only 150 CSS pixels on the other half.
    if (f.restore) {
        await p.eval(
            `(async()=>{const box=document.querySelector('main.scroller'); box.scrollTop-=150; box.dispatchEvent(new WheelEvent('wheel',{deltaY:-150}));})()`,
        );
        await until(
            () =>
                p.eval(
                    `(async()=> (await import('/store.js')).store.state.transcriptPlace?.keep != null)()`,
                ),
            "non-bottom reading position",
            4000,
        );
    }

    await navigate(p, null);
    await until(
        () => p.eval(`!document.getElementById('entry-${f.last}')`),
        "away from the session",
    );

    if (kind === "device") {
        await until(
            () =>
                p.eval(
                    `(async()=>!!(await (await import('/session-cache.js')).read(${f.id},false)))()`,
                ),
            "IndexedDB saved",
        );
        await p.close();

        return undefined;
    }

    // Same renderer keeps its markdown cache and its transcript snapshot.
    return p;
}

async function trial(c, screen, work, kind, fixture, repeat, cookie, base, keep, tracing = true) {
    const f = { ...fixture, restore: kind !== "first" && repeat % 2 === 1 };
    const { browserContextId: ctx } = await c.send("Target.createBrowserContext", {
        disposeOnDetach: true,
    });
    let end;

    try {
        const candidate =
            kind !== "first" ? await prime(c, ctx, screen, f, kind, cookie, base) : undefined;
        const p = candidate ?? (await tab(c, ctx, screen, f, kind, true, cookie));
        const cursor = p.requests.length;
        const before = load();

        if (tracing) {
            end = await streamTrace(
                c,
                keep ? join(work, `${screen.name}-${kind}-${f.size}.trace.json.gz`) : undefined,
            );
        }

        if (kind === "switch") {
            await p.eval(
                `(async()=>{const s=await import('/store.js'); window.__draw.arm(); s.navigate(${f.id});})()`,
            );
        } else {
            await p.send("Page.navigate", { url: `${base}/s/${f.id}` });
        }

        await until(
            () => p.eval(`window.__draw?.stage().proxy>0`).catch(() => false),
            `${screen.name}/${kind}/${f.size} row paint`,
        );
        await settled(p, f.id);
        await sleep(360);
        const stage = await p.eval("window.__draw.stage()");
        const marks = await p.eval("window.__draw.result()");

        assert.equal(stage.source, { first: "sse", device: "device", switch: "memory" }[kind]);
        const have = p.requests
            .slice(cursor)
            .some((r) =>
                r.path === "/api/events"
                    ? !!new URLSearchParams(r.query).get("have")
                    : !!JSON.parse(r.post ?? "{}").have,
            );

        assert.equal(
            have,
            kind !== "first",
            `Unexpected have value in ${screen.name}/${kind}/${f.size}`,
        );
        assert.ok(
            marks.some((x) => x[0] === "event"),
            "Missing server first view",
        );
        assert.ok(p.errors.length === 0, JSON.stringify(p.errors));
        const common = {
            size: f.size,
            kind,
            viewport: screen.name,
            repeat,
            restore: f.restore,
            before,
            load: load(),
        };
        const marker = (name) => marks.find(([key]) => key === name)?.[1];

        if (!tracing) {
            return {
                type: "sample",
                ...common,
                ready: marker("ready"),
                dom: marker("dom"),
                proxy: marker("proxy"),
            };
        }

        const metrics = await p.send("Performance.getMetrics");
        const finish = end;

        end = undefined;
        const trace = await finish();
        const m = measure(trace, marks, stage, metrics, f);

        assert.ok(
            m.ui >= 0 && m.measures.preact > 0 && m.measures.transcript >= 0,
            `Broken paint or render window ${JSON.stringify(m)}`,
        );

        return { type: "sample", ...common, ...m };
    } finally {
        if (end) {
            await end().catch(() => {});
        }

        await c.send("Target.disposeBrowserContext", { browserContextId: ctx });
    }
}

function launch(code, work) {
    const spawnEnv = {
        ...process.env,
        TMPDIR: join(work, "tmp"),
        PI_OFFLINE: "1",
        UV_THREADPOOL_SIZE: "2",
    };
    const logfile = join(work, "server.log");
    const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "test/serve.ts", "0", "127.0.0.2"],
        { cwd: code, env: spawnEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );

    for (const pipe of [child.stdout, child.stderr]) {
        pipe.on("data", (chunk) => {
            // The copy normally prints login tokens. The fixture descriptors travel over private IPC instead.
            const line = chunk.toString().replace(/token=[^\s]*/g, "token=[redacted]");

            appendFileSync(logfile, line, { mode: 0o600 });
        });
    }

    const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const ready = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.on("message", (m) => {
            if (m.type === "ready") {
                resolve(m);
            }
        });
        void exited.then((e) =>
            reject(new Error(`Test copy exited: ${JSON.stringify(e)} (see ${logfile})`)),
        );
    });

    return {
        ready,
        async stop() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
            }

            const timer = setTimeout(() => child.kill("SIGKILL"), 6000).unref();
            const status = await exited;

            clearTimeout(timer);
            assert.equal(status.code, 0, JSON.stringify(status));
        },
    };
}

function cores() {
    const spec = /Cpus_allowed_list:\s*(\S+)/.exec(readFileSync("/proc/self/status", "utf8"))[1];

    return spec
        .split(",")
        .flatMap((s) => {
            const [a, b] = s.split("-").map(Number);

            return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
        })
        .slice(0, 2)
        .join(",");
}

const usage =
    "node scripts/perf/draw-measure.mjs [--runs=10] [--only=desktop|phone] [--trace=first|all] [--control]";
const help =
    "Use a 200% systemd scope with this checkout's dependencies and sandboxed Chromium. --control alternates tracing on and off on a 2,000-entry desktop switch. Results stay in the printed temporary folder.";
const usageHint = () =>
    console.log(`usage: ${JSON.stringify(usage)}\nhelp: ${JSON.stringify(help)}`);

async function main() {
    const opts = process.argv.slice(2);

    if (opts.includes("--help")) {
        usageHint();

        return;
    }

    const bad = opts.find(
        (x) =>
            !/^--(runs=[1-9][0-9]?|only=desktop|only=phone|trace=all|trace=first|control)$/.test(x),
    );
    const duplicate = new Set(opts.map((x) => x.split("=")[0])).size !== opts.length;

    if (
        bad ||
        duplicate ||
        (opts.includes("--control") && opts.some((x) => /^--(only|trace)=/.test(x)))
    ) {
        console.log(
            `error: ${JSON.stringify(bad ? `Invalid argument ${bad}` : duplicate ? "Duplicate argument" : "--control takes only --runs")}`,
        );
        usageHint();
        process.exitCode = 2;

        return;
    }

    const opt = (k) => opts.find((x) => x.startsWith(`--${k}=`))?.split("=")[1];
    const runs = +(opt("runs") ?? 10),
        only = opt("only"),
        keep = opt("trace") ?? "first";
    const control = opts.includes("--control");
    const work = mkdtempSync(join(tmpdir(), "pocket-draw-"));

    console.error(`Workspace: ${work}`);
    const code = join(work, "code"),
        archive = join(work, "code.tar"),
        tmp = join(work, "tmp");

    mkdirSync(code);
    mkdirSync(tmp);
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, rev], { cwd: repo });
    execFileSync("tar", ["-xf", archive, "-C", code]);
    rmSync(archive);
    symlinkSync(join(repo, "node_modules"), join(code, "node_modules"), "dir");
    instrument(code);

    for (const file of [
        "app.js",
        "store.js",
        "transcript.js",
        "ui.js",
        "highlight.js",
        "session-cache.js",
    ]) {
        execFileSync(process.execPath, ["--check", join(code, "web", file)]);
    }

    const { Chromium } = await mod(code, "src/server/browser/cdp.ts");
    const { findBrowser } = await mod(code, "src/server/browser/discovery.ts");
    const bin = findBrowser();

    assert.ok(bin, "Install sandboxed Chromium or set PI_POCKET_BROWSER");
    const shim = join(work, "chrome-cpu");

    writeFileSync(
        shim,
        `#!/bin/sh\nexec taskset -c ${cores()} '${bin.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o700 },
    );
    const file = join(work, "draw.jsonl");
    const record = (row) => appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    const server = launch(code, work);
    let chrome;
    let samples = 0;

    try {
        const { port, token, fixtures } = await server.ready;
        const base = `http://127.0.0.2:${port}`;
        const cookie = await loginCookie(base, token);

        chrome = await Chromium.launch(shim, join(work, "browser"), ["--renderer-process-limit=1"]);
        record({
            type: "start",
            when: new Date().toISOString(),
            load: load(),
            node: process.version,
            rev,
            browser: chrome.version,
            cpu: cores(),
            fixtures,
        });
        console.error(`Chromium ${chrome.version}; ${runs} runs per case`);

        if (control) {
            const f = fixtures.find(({ size }) => size === 2000);

            record({
                type: "set-start",
                viewport: "desktop",
                when: new Date().toISOString(),
                load: load(),
            });

            for (let i = 0; i < runs; i++) {
                for (const tracing of i % 2 ? [false, true] : [true, false]) {
                    const result = await trial(
                        chrome.connection,
                        desktop,
                        work,
                        "switch",
                        f,
                        i,
                        cookie,
                        base,
                        false,
                        tracing,
                    );

                    record({ ...result, type: "control", tracing });
                    samples++;
                    console.error(
                        `Control pair ${i + 1}/${runs}, tracing ${tracing}: ${number(result.proxy - result.ready)} ms to two rAFs`,
                    );
                }
            }

            record({
                type: "set-end",
                viewport: "desktop",
                when: new Date().toISOString(),
                load: load(),
            });
        }

        for (const screen of (control ? [] : [desktop, mobile]).filter(
            (s) => !only || s.name === only,
        )) {
            record({
                type: "set-start",
                viewport: screen.name,
                when: new Date().toISOString(),
                load: load(),
            });

            for (let repeat = 0; repeat < runs; repeat++) {
                // Serial trials are intentional: two simultaneous tabs would disturb each other's rendering and caches.
                for (const [i, f] of [
                    ...fixtures.slice(repeat % 3),
                    ...fixtures.slice(0, repeat % 3),
                ].entries()) {
                    const start = (repeat + i) % 3;

                    for (const kind of [...kinds.slice(start), ...kinds.slice(0, start)]) {
                        const result = await trial(
                            chrome.connection,
                            screen,
                            work,
                            kind,
                            f,
                            repeat,
                            cookie,
                            base,
                            keep === "all" || repeat === 0,
                        );

                        record(result);
                        samples++;
                        console.error(
                            `${screen.name} ${repeat + 1}/${runs} ${f.size} ${kind}: ${result.ui} ms, ${result.frame}, ${result.rows} children`,
                        );
                    }
                }
            }

            record({
                type: "set-end",
                viewport: screen.name,
                when: new Date().toISOString(),
                load: load(),
            });
        }
    } finally {
        try {
            if (chrome) {
                await chrome.connection.send("Browser.close").catch(() => chrome.kill());
                await chrome.exited;
            }
        } finally {
            await server.stop();
        }
    }

    console.log(`result:\n  samples: ${samples}\n  jsonl: ${JSON.stringify(file)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === own) {
    try {
        await main();
    } catch (error) {
        console.error(error);
        console.log(
            `error: ${JSON.stringify(error instanceof Error ? error.message : String(error))}\nhelp: ${JSON.stringify("Check stderr and the server.log in the printed temporary folder.")}`,
        );
        process.exitCode = 1;
    }
}
