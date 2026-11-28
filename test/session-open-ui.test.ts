// Session opens share the checked device cache, before `/api/me` on reload and before a switch's server view.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AssistantEntry,
    type ConversationId,
    ToolResultEntry,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { ClientEntry } from "../src/server/projection.ts";
import type { Client } from "../src/server/room.ts";
import { createHandler } from "../src/server/http.ts";
import { json } from "../src/server/http/io.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 45_000,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let meUser: Parameters<App["hello"]>[0] | undefined;
let failModule = false;
let retryMe: { requests: number; user: Parameters<App["hello"]>[0] } | undefined;
const gates = new Map<string, { wait: Promise<void>; release: () => void; entered: boolean }>();

/** Hold a real request at the server, including across a page reload. */
function hold(path: string) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const gate = {
        wait: promise,
        entered: false,
        release: () => {
            gates.delete(path);
            resolve();
        },
    };

    gates.set(path, gate);

    return gate;
}

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (findBrowser() === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const source = readFileSync(join(import.meta.dirname, "../web/app.js"), "utf8");
    const ui = readFileSync(join(import.meta.dirname, "../web/ui.js"), "utf8").replace(
        /function renderParts\([^\n]+\) \{/,
        "$& globalThis.openProbe?.builds.push(text);",
    );
    // Installed before the app's first render on every document. Disable idle read-ahead so the device-only switch
    // really is device-only, not accidentally warmed into tab memory while the test waits.
    const probe = `
        const idle = requestIdleCallback;

        globalThis.requestIdleCallback = (callback, options) => options?.timeout === 1000 ? 0 : idle(callback, options);
        // Poll without importing modules while the browser is still loading a new document's import map.
        globalThis.openProbe = { boot: false, rows: false, state: () => store.state, builds: [], first: null };
        const watched = new WeakSet();
        new MutationObserver(() => {
            const transcript = document.querySelector('[data-part="transcript"]');
            const box = transcript?.parentElement;

            if (box && !watched.has(box)) {
                watched.add(box);
                // Observe after the app attaches its own layout observer; both callbacks run before paint.
                const observer = new ResizeObserver(([change]) => {
                    if (change.contentRect.height > 0 && transcript.querySelector('[id^="entry-"]')) {
                        observer.disconnect();
                        const top = box.scrollTop;
                        const height = box.scrollHeight;
                        const client = box.clientHeight;
                        openProbe.first = { top, height, client, gap: height - client - top };
                    }
                });
                observer.observe(box);
                observer.observe(transcript);
            }

            if ([...document.querySelectorAll('[data-part="prompt-row"]')].some((node) => node.getClientRects().length > 0)) {
                openProbe.rows = true;
            }

            if ([...document.querySelectorAll('.boot:not(.inline)')].some((node) => node.getClientRects().length > 0)) {
                openProbe.boot = true;
            }
        }).observe(document, { subtree: true, childList: true, attributes: true });
    `;

    server = createServer(async (request, response) => {
        const path = new URL(request.url ?? "/", "http://test.local").pathname;
        const gate = gates.get(path);

        if (gate !== undefined) {
            gate.entered = true;
            await gate.wait;

            // A held request can have lost its page. Do not open a stream for a socket already closed.
            if (response.destroyed) {
                return;
            }
        }

        if (path.startsWith("/api/c/") && request.url?.endsWith("/file?path=near-rows-late.svg")) {
            response.writeHead(200, {
                "content-type": "image/svg+xml",
                "cache-control": "no-store",
            });
            response.end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="300"><rect width="220" height="300" fill="navy"/></svg>',
            );

            return;
        }

        if (failModule && path === "/text-hash.js") {
            response.writeHead(403).end();

            return;
        }

        if (path === "/app.js" || path === "/ui.js") {
            response.writeHead(200, {
                "content-type": "text/javascript",
                "cache-control": "no-store",
            });
            response.end(path === "/app.js" ? probe + source : ui);

            return;
        }

        if (path === "/api/me" && retryMe !== undefined) {
            const attempt = retryMe;

            attempt.requests++;

            if (attempt.requests === 1) {
                // Give IndexedDB time to paint the early snapshot, then exercise the actual startup retry.
                await new Promise((resolve) => setTimeout(resolve, 1500));
                json(response, 503, { error: "temporarily unavailable" });
            } else {
                json(response, 200, await app.hello(attempt.user));
            }

            return;
        }

        if (path === "/api/me" && meUser !== undefined) {
            json(response, 200, await app.hello(meUser));

            return;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "open-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await ready();
});

after(async () => {
    for (const gate of gates.values()) {
        gate.release();
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function ready(): Promise<void> {
    const owner = app.config.users[0]!.id;

    await until(
        async () =>
            await inPage<boolean>(`(() => {
                const state = globalThis.openProbe?.state();

                return JSON.stringify(state?.me?.id === ${JSON.stringify(owner)} && state.sessionsLoaded && state.connection === "open");
            })()`),
        "the owner signed in and connected",
        20_000,
    );
}

/** Open a new document, losing all tab memory. */
async function openOn(id: ConversationId, text: string): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await shown(text)).rows, text, 20_000);
    await ready();
}

async function saved(id: ConversationId): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
            return JSON.stringify((await (await import("/session-cache.js")).list()).some((each) => each.id === ${Number(id)}));
        `),
        "saved on the device",
        15_000,
    );
}

function shown(
    text: string,
): Promise<{ boot: boolean; loader: boolean; rows: boolean; me: boolean }> {
    return inPage(`
        const { store } = await import("/store.js");
        const transcript = document.querySelector('[data-part="transcript"]');

        return JSON.stringify({
            boot: globalThis.openProbe?.boot ?? false,
            loader: transcript?.querySelector('.loader') != null,
            rows: [...(transcript?.querySelectorAll('[data-part="prompt-row"]') ?? [])].some((row) => row.textContent.includes(${JSON.stringify(text)})),
            me: store.state.me !== undefined,
        });
    `);
}

/** Leave the transcript before changing the device record, so pagehide cannot overwrite the test's record. */
async function leave(): Promise<void> {
    await page.navigate(`${base}/`);
    await ready();
}

test(
    "a cached reload paints rows before /api/me, without ever showing the boot screen",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "kept across the reload");
        await openOn(id, "kept across the reload");
        await inPage(`
            const box = document.querySelector('[data-part="composer"] textarea');

            box.value = 'A draft kept across the reload.';
            box.dispatchEvent(new Event('input', { bubbles: true }));

            return 'null';
        `);
        await saved(id);
        const me = hold("/api/me");

        try {
            await page.reload();
            await until(
                async () => (await shown("kept across the reload")).rows,
                "cached rows",
                15_000,
            );
            const early = await shown("kept across the reload");

            assert.equal(me.entered, true);
            assert.equal(early.me, false, "/api/me is still held");
            assert.equal(early.boot, false, "no static or app boot-screen flash");
            assert.equal(early.rows, true);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.title-open').disabled)`,
                ),
                true,
                "the session menu waits for /api/me",
            );
        } finally {
            me.release();
        }

        await ready();
        assert.equal((await shown("kept across the reload")).boot, false);
        assert.equal(
            await inPage<boolean>(`
                return JSON.stringify(document.querySelector('[data-part="composer"] textarea')?.value === 'A draft kept across the reload.');
            `),
            true,
            "the composer reads the draft after the person is known",
        );
    },
);

test(
    "a reload with no device copy keeps the boot screen until /api/me, then shows rows",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "nothing kept for this one");
        await openOn(id, "nothing kept for this one");
        await leave();
        await inPage(`await (await import('/session-cache.js')).clear(); return 'null';`);
        const me = hold("/api/me");

        try {
            await inPage(`history.replaceState(history.state, '', '/s/${id}'); return 'null';`);
            await page.reload();
            await until(
                async () => (await shown("nothing kept for this one")).boot,
                "the boot screen",
            );
            const early = await shown("nothing kept for this one");

            assert.equal(early.me, false);
            assert.equal(early.rows, false);
        } finally {
            me.release();
        }

        await until(
            async () => (await shown("nothing kept for this one")).rows,
            "the server's rows",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(![...document.querySelectorAll('.boot:not(.inline)')].some((node) => node.getClientRects().length > 0))`,
            ),
            true,
        );
    },
);

test(
    "a device reopen builds unchanged Markdown once, before and after sign-in checks",
    real,
    async () => {
        const id = await newSession(app);
        const prompt = "device draw count: **keep this formatting**";
        const reply = `echo: ${prompt}`;
        const builds = () =>
            inPage<number>(`
        return JSON.stringify(openProbe.builds.filter((text) => text === ${JSON.stringify(reply)}).length);
    `);

        await say(app, id, prompt);
        await openOn(id, "device draw count");
        await saved(id);
        const me = hold("/api/me");

        try {
            await page.reload();
            await until(
                () =>
                    inPage<boolean>(`
            return JSON.stringify([...document.querySelectorAll('.md strong')].some(
                (node) => node.textContent === 'keep this formatting' && !node.closest('[hidden]')));
        `),
                "formatted device reply",
            );
            assert.ok(me.entered);
            assert.equal(await builds(), 1);
        } finally {
            me.release();
        }

        await ready();
        await inPage(
            `await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); return 'null';`,
        );
        assert.equal(
            await builds(),
            1,
            "listing browser extensions does not rebuild the same reply",
        );
    },
);

test(
    "Markdown cached for the transcript is invalidated by theme and access changes",
    real,
    async () => {
        const id = await newSession(app);
        const prompt = "Markdown scope: **a kept reply**";
        const builds = () =>
            inPage<number>(
                `return JSON.stringify(openProbe.builds.filter((text) => text === ${JSON.stringify(`echo: ${prompt}`)}).length);`,
            );

        await say(app, id, prompt);
        await openOn(id, "Markdown scope:");
        await synced(id);
        const before = await builds();

        assert.ok(before > 0);

        const change = (code: string) => inPage(`${code}; return 'null';`);

        await change(`const { setPrefs, prefs } = await import('/theme.js');
        window.oldColor = prefs().theme;
        setPrefs({ theme: prefs().theme === 'gruvbox' ? 'tokyo-night' : 'gruvbox' })`);

        try {
            await until(
                async () => (await builds()) === before + 1,
                "new colors invalidate cached HTML",
            );
            await change(`const { store } = await import('/store.js');
            window.oldReader = store.state.me;
            store.set({ me: { ...window.oldReader, sessions: [${Number(id)}] } })`);
            await until(
                async () => (await builds()) === before + 2,
                "changed access invalidates cached HTML",
            );
            await change(`(await import('/store.js')).store.set({ me: window.oldReader })`);
            await until(
                async () => (await builds()) === before + 3,
                "old access does not reuse retained HTML",
            );
            assert.equal(
                await inPage(
                    `return JSON.stringify(document.querySelector('.reply strong')?.textContent);`,
                ),
                "a kept reply",
            );
        } finally {
            await change(`if (window.oldReader) (await import('/store.js')).store.set({ me: window.oldReader });
            (await import('/theme.js')).setPrefs({ theme: window.oldColor })`);
        }
    },
);

test(
    "the first layout preserves bottom placement and the reading position on switch, reload and device return",
    real,
    async () => {
        const id = await newSession(app);
        const other = await newSession(app);
        const phrase = "Placement fixture row";

        type Position = { top: number; gap: number; height: number; client: number };

        const position = () =>
            inPage<Position>(`
            const box = document.querySelector('.pane > .scroller');
            const top = box.scrollTop;
            const height = box.scrollHeight;
            const client = box.clientHeight;
            return JSON.stringify({ top, height, client, gap: height - client - top });
        `);

        const first = async () => {
            await until(
                () => inPage<boolean>(`return JSON.stringify(openProbe.first !== null);`),
                "first layout",
            );

            return inPage<Position>(`return JSON.stringify(openProbe.first);`);
        };

        const closeTo = (actual: number, expected: number, why: string) =>
            assert.ok(Math.abs(actual - expected) <= 2, `${why}: ${actual}, expected ${expected}`);

        const to = async (conversation: ConversationId) => {
            await inPage(
                `openProbe.first = null; (await import('/store.js')).navigate(${Number(conversation)}); return 'null';`,
            );
        };

        await app.harness.commit(async (tx) => {
            for (let n = 0; n < 48; n++) {
                await tx.appendEntry(UserEntry, id, {
                    model: [
                        {
                            role: "user",
                            content: `${phrase} ${n} ${"line of text ".repeat((n % 5) * 13)}`,
                            timestamp: Date.now(),
                        },
                    ],
                });
            }
        }, context);
        await say(app, other, "The other placement fixture");
        await inPage(`(await import('/theme.js')).setPrefs({ motion: 'reduced' }); return 'null';`);
        await openOn(id, `${phrase} 47`);
        closeTo((await first()).gap, 0, "bottom in the first layout");
        await to(other);
        await until(
            async () => (await shown("The other placement fixture")).rows,
            "the other session",
        );
        await to(id);
        await until(async () => (await shown(`${phrase} 47`)).rows, "warm return");
        closeTo((await first()).gap, 0, "bottom on the warm return");

        await inPage(`
        const box = document.querySelector('.pane > .scroller');
        box.scrollTop -= 680;
        box.dispatchEvent(new Event('scroll'));
        return 'null';
    `);
        const reading = await position();

        assert.ok(reading.top > 0 && reading.gap >= 650, "clearly neither end");
        await to(other);
        await until(
            async () => (await shown("The other placement fixture")).rows,
            "the other session again",
        );
        await to(id);
        await until(
            async () => (await shown(`${phrase} 47`)).rows,
            "warm return to the reading position",
        );

        const checkRestore = (box: Position, why: string) => {
            // The previous placement clamps scrollHeight - keep; composer and loader height can vary by frame.
            const keep = reading.height - reading.top;

            closeTo(
                box.top,
                Math.max(0, Math.min(box.height - box.client, box.height - keep)),
                why,
            );
        };

        checkRestore(await first(), "warm return's first layout");
        checkRestore(await position(), "warm return's settled layout");
        await until(
            () =>
                inPage<boolean>(`
                const { viewSynced, store } = await import('/store.js');
                return JSON.stringify(viewSynced(${Number(id)}) && ![...store.state.view.entries.values()].some((entry) => entry.partial));
            `),
            "the whole view after the warm return",
        );
        await to(other);
        await until(
            () =>
                inPage<boolean>(`
        const saved = await (await import('/session-cache.js')).read(${Number(id)});
        return JSON.stringify(saved?.record.place?.keep > 650);
    `),
            "the persisted reading position",
        );

        for (const reload of [false, true]) {
            const me = hold("/api/me");

            try {
                if (reload) {
                    await page.reload();
                } else {
                    await page.navigate(`${base}/s/${id}`);
                }

                await until(
                    async () => (await shown(`${phrase} 47`)).rows,
                    "device rows before sign-in checks",
                );
                assert.ok(me.entered);
                checkRestore(await first(), "reading position in the first device layout");
            } finally {
                me.release();
            }

            await ready();
            checkRestore(await position(), "settled device reading position");
        }
    },
);

test(
    "a tool builds its body on open; closed output is absent from browser and session Find",
    real,
    async () => {
        const id = await newSession(app);
        const command = "printf searchable-tool-command";
        const output = "unique closed tool body output";

        await app.harness.commit(async (tx) => {
            await tx.appendEntry(UserEntry, id, {
                model: [{ role: "user", content: "Tool details fixture", timestamp: Date.now() }],
            });
            await tx.appendEntry(AssistantEntry, id, {
                model: [
                    fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "draw-tool" })], {
                        stopReason: "toolUse",
                    }),
                ],
            });
            await tx.appendEntry(ToolResultEntry, id, {
                model: [
                    {
                        role: "toolResult",
                        toolName: "bash",
                        toolCallId: "draw-tool",
                        content: [fauxText(output)],
                        isError: false,
                        timestamp: Date.now(),
                    },
                ],
                data: { diagnostics: [] },
            });
        }, context);
        await openOn(id, "Tool details fixture");
        await until(
            () =>
                inPage<boolean>(`
        return JSON.stringify(document.querySelector('[data-part="tool-call"] button[aria-expanded="false"]') !== null);
    `),
            "closed tool card",
        );
        const state = await inPage<{ closed: boolean; notFound: boolean; inFrame: boolean }>(`
        const tool = document.querySelector('[data-part="tool-call"]');
        const output = ${JSON.stringify(output)};
        const closed = !tool.querySelector('.step-body');
        const notFound = !window.find(output);
        tool.querySelector('button[aria-expanded="false"]').click();
        // Microtasks, not a timer or idle turn; the next frame can draw the output.
        await Promise.resolve();
        const inFrame = tool.querySelector('.step-body')?.textContent.includes(output) ?? false;
        return JSON.stringify({ closed, notFound, inFrame });
    `);

        assert.deepEqual(state, { closed: true, notFound: true, inFrame: true });
        await until(
            () =>
                inPage<boolean>(`
            return JSON.stringify(window.find(${JSON.stringify(output)}, false, false, true));
        `),
            "browser Find sees the expanded output",
        );
        await inPage(
            `document.querySelector('[data-part="tool-call"] button[aria-expanded="true"]').click(); return 'null';`,
        );

        const find = (query: string) =>
            inPage(`
        const { openSheet } = await import('/store.js');
        openSheet({ type: 'find', query: ${JSON.stringify(query)} });
        return 'null';
    `);
        const sheetSays = (text: string) =>
            inPage<boolean>(`
        return JSON.stringify(document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(text)}) ?? false);
    `);

        await find(output);
        await until(() => sheetSays("Nothing here says"), "no session Find result for tool output");
        await inPage(`(await import('/store.js')).closeSheet(); return 'null';`);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(!document.querySelector('[data-sheet="find"]'));`,
                ),
            "closed Find sheet",
        );
        await find(command);
        await until(
            () =>
                inPage<boolean>(`
                return JSON.stringify([...document.querySelectorAll('.find-result')].some(
                    (node) => node.textContent.includes('searchable-tool-command')));
            `),
            "session Find still searches the tool command",
        );
    },
);

test("a switch reads rows kept only on the device before the server answers", real, async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await say(app, first, "in memory");
    await say(app, second, "only on the device");
    await openOn(second, "only on the device");
    await saved(second);
    // A new document has never shown second and cannot read it ahead (the probe disables idle read-ahead).
    await openOn(first, "in memory");
    const switched = hold("/api/switch");

    try {
        await inPage(
            `openProbe.boot = false; (await import('/store.js')).navigate(${Number(second)}); return 'null';`,
        );
        await until(async () => (await shown("only on the device")).rows, "the device's rows");
        await until(() => switched.entered, "the held switch request");
        assert.equal((await shown("only on the device")).boot, false);
    } finally {
        switched.release();
    }
});

test(
    "an uncached switch keeps its header and the loading screen in its pane, then fills the same pane",
    real,
    async () => {
        const first = await newSession(app);
        const second = await newSession(app);

        await say(app, first, "the one on screen");
        await say(app, second, "not kept anywhere");
        await openOn(first, "the one on screen");
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify((await import('/store.js')).store.state.sessions.some((each) => each.id === ${Number(second)}));
    `),
            "the session list",
        );
        const switched = hold("/api/switch");

        try {
            await inPage(`
            const { store, navigate } = await import('/store.js');

            globalThis.expectedTitle = store.state.sessions.find((each) => each.id === ${Number(second)}).title;
            openProbe.boot = false;
            navigate(${Number(second)});

            return 'null';
        `);
            await until(() => switched.entered, "the held switch request");
            const waiting = await shown("not kept anywhere");

            assert.equal(waiting.boot, false, "not the full-page starting screen");
            assert.equal(waiting.rows, false);
            assert.equal(waiting.loader, false, "no loader of another kind");
            assert.equal(
                await inPage<boolean>(`
            const boot = document.querySelector('.pane .boot.inline');

            return JSON.stringify(
                boot !== null &&
                    boot.getClientRects().length > 0 &&
                    boot.querySelector('.boot-caption').textContent === 'loading session' &&
                    boot.querySelector('.boot-detail').textContent === expectedTitle,
            );
        `),
                true,
                "the usual loading screen, in the session's pane, names the session",
            );
            assert.equal(
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector('[data-part="topbar-title"]').textContent === expectedTitle);
        `),
                true,
                "the session's own header shows",
            );
            await inPage(
                `globalThis.waitingPane = document.querySelector('.pane'); return 'null';`,
            );
        } finally {
            switched.release();
        }

        await until(async () => (await shown("not kept anywhere")).rows, "the server's rows");
        const late = await shown("not kept anywhere");

        assert.equal(late.boot, false);
        assert.equal(late.loader, false);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.pane') === waitingPane)`,
            ),
            true,
        );
    },
);

test(
    "Wait for updates still holds a changed tab-memory view until the server answers",
    real,
    async () => {
        const first = await newSession(app);
        const second = await newSession(app);

        await say(app, first, "waited-for rows");
        await say(app, second, "the other session");
        await openOn(first, "waited-for rows");
        await inPage(`(await import('/store.js')).navigate(${Number(second)}); return 'null';`);
        await until(async () => (await shown("the other session")).rows, "the other session");
        const switched = hold("/api/switch");

        try {
            await inPage(`
            const { store, navigate } = await import('/store.js');
            const { setPrefs } = await import('/theme.js');

            setPrefs({ waitForUpdates: true });
            store.set({ sessions: store.state.sessions.map((each) => each.id === ${Number(first)} ? { ...each, busy: true } : each) });
            navigate(${Number(first)});

            return 'null';
        `);
            await until(() => switched.entered, "the held switch");
            assert.equal((await shown("waited-for rows")).rows, false);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.pane .boot.inline') !== null)`,
                ),
                true,
            );
        } finally {
            switched.release();
            await inPage(
                `(await import('/theme.js')).setPrefs({ waitForUpdates: false }); return 'null';`,
            );
        }

        await until(async () => (await shown("waited-for rows")).rows, "the complete view");
    },
);

test("another person's device copy is refused before /api/me and dropped", real, async () => {
    const id = await newSession(app);

    await say(app, id, "someone else's words");
    await openOn(id, "someone else's words");
    await saved(id);
    await leave();
    await inPage(`
        const cache = await import('/session-cache.js');
        const found = await cache.read(${Number(id)});

        await cache.save(${Number(id)}, found.record, { ...found.info, owner: 'someone-else' }, 100_000_000);
        await cache.save(999_999, found.record, { ...found.info, id: 999_999, owner: 'someone-else' }, 100_000_000);

        return 'null';
    `);
    const me = hold("/api/me");

    try {
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () => (await shown("someone else's words")).boot,
            "the refused cache's boot screen",
        );
        const early = await shown("someone else's words");

        assert.equal(early.me, false);
        assert.equal(early.rows, false, "another person's rows are never painted");
    } finally {
        me.release();
    }

    await until(
        async () => (await shown("someone else's words")).rows,
        "the authorized server view",
    );
    await until(
        () =>
            inPage<boolean>(`
            return JSON.stringify(!(await (await import('/session-cache.js')).list()).some((each) => each.owner === 'someone-else'));
        `),
        "unopened copies for another owner dropped too",
    );
});

/** Change only the test copy's build stamp, as a code update would. */
function changeBuild() {
    const was = app.build;
    const build = was === "a000000000000000" ? "b000000000000000" : "a000000000000000";

    Object.defineProperty(app, "build", { configurable: true, value: build });

    return { build, restore: () => Reflect.deleteProperty(app, "build") };
}

const nearLabel = "Draw only rows near the screen (experimental)";

function experimental(on: boolean) {
    return inPage(
        `(await import('/theme.js')).setPrefs({ nearRows: ${on}, motion: 'reduced' }); return 'null';`,
    );
}

async function nearFixture(withLateContent = false, conversation?: ConversationId) {
    const id = conversation ?? (await newSession(app));
    const ids: number[] = [];
    const word = (n: number) => `Near rows specimen ${String(n).padStart(2, "0")}.`;
    const lesson = withLateContent
        ? await app.memory.add(
              id,
              undefined,
              { userId: owner(app).id, byPi: true, name: "Pi" },
              { text: "Keep an example lesson with the near rows fixture.", scope: "session" },
          )
        : null;

    await app.harness.commit(async (tx) => {
        for (let n = 0; n < 55; n++) {
            const row = await tx.appendEntry(UserEntry, id, {
                model: [
                    {
                        role: "user",
                        content: `${word(n)} ${"words here ".repeat(15 + (n % 5) * 8)}`,
                        timestamp: Date.now(),
                    },
                ],
            });

            ids.push(Number(row.id));

            if (n === 48 && lesson) {
                await tx.appendEntry(AssistantEntry, id, {
                    model: [
                        fauxAssistantMessage([
                            fauxText(
                                `![Late image](/api/c/${id}/file?path=near-rows-late.svg)\n\n` +
                                    String.raw`A late expression: $\dfrac{1}{\dfrac{1}{x} + \dfrac{1}{y}}$.`,
                            ),
                        ]),
                    ],
                });
            }

            if (n === 53 && lesson) {
                await tx.appendEntry(AssistantEntry, id, {
                    model: [
                        fauxAssistantMessage(
                            [
                                fauxToolCall(
                                    "memory",
                                    { action: "add", text: lesson.text },
                                    { id: "near-lesson" },
                                ),
                            ],
                            { stopReason: "toolUse" },
                        ),
                    ],
                });
                await tx.appendEntry(ToolResultEntry, id, {
                    model: [
                        {
                            role: "toolResult",
                            toolName: "memory",
                            toolCallId: "near-lesson",
                            content: [fauxText("Saved")],
                            details: { lesson: lesson.id },
                            isError: false,
                            timestamp: Date.now(),
                        },
                    ],
                    data: { diagnostics: [] },
                });
            }
        }
    }, context);

    return { id, ids, word, last: word(ids.length - 1), lesson };
}

const scrollerState = () =>
    inPage<{ gap: number; count: number; spacer: boolean; row: string; offset: number }>(`
    const box = document.querySelector('.pane > .scroller');
    const rows = [...box.querySelectorAll('.transcript > [id^="entry-"]')];
    const top = box.getBoundingClientRect().top;
    const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 2);
    return JSON.stringify({
        gap: box.scrollHeight - box.clientHeight - box.scrollTop,
        count: rows.length, spacer: !!box.querySelector('.near-gap[aria-hidden="true"]'),
        row: first?.id ?? '', offset: first?.getBoundingClientRect().top - top
    });
`);

const twoFrames = () =>
    inPage(`
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return 'null';
`);

async function synced(id: ConversationId) {
    await until(
        () =>
            inPage<boolean>(`
        const { store, viewSynced } = await import('/store.js');
        return JSON.stringify(viewSynced(${Number(id)}) && ![...store.state.view.entries.values()].some((entry) => entry.partial));
    `),
        "the whole session view",
    );
}

const go = (id: ConversationId) =>
    inPage(
        `openProbe.first = null; (await import('/store.js')).navigate(${Number(id)}); return 'null';`,
    );

const readAboveBottom = () =>
    inPage(`
    const box = document.querySelector('.pane > .scroller');
    box.scrollTop -= 210;
    box.dispatchEvent(new Event('scroll'));
    return 'null';
`);

test(
    "near rows opens at the same place as the full transcript, also on switch and device reopen",
    real,
    async () => {
        const { id, ids, last } = await nearFixture();
        const other = await newSession(app);
        const label = JSON.stringify(nearLabel);
        const shape = () =>
            inPage<string[][]>(`
                const box = document.querySelector('.pane > .scroller');
                return JSON.stringify([[...box.getAttributeNames()].sort(),
                    ...[...box.querySelector('.transcript').children].map((row) =>
                        [row.localName, row.id, row.dataset.part ?? ''])]);
            `);
        const toggle = () =>
            inPage(`
        [...document.querySelectorAll('[role="switch"]')].find((node) => node.getAttribute('aria-label') === ${label}).click();
        (await import('/store.js')).closeSheet();
        return 'null';
    `);

        const assertReading = async (want: Awaited<ReturnType<typeof scrollerState>>) => {
            const actual = await scrollerState();

            assert.equal(actual.row, want.row);
            assert.ok(
                Math.abs(actual.offset - want.offset) <= 2,
                `${actual.offset} vs ${want.offset}`,
            );
        };

        const back = async () => {
            await go(other);
            await until(
                async () => (await shown("The other near rows session")).rows,
                "other session",
            );
            await go(id);
            await until(async () => (await shown(last)).rows, "kept session");
            await twoFrames();
        };

        await say(app, other, "The other near rows session");
        await experimental(false);
        await openOn(id, last);
        await synced(id);
        await twoFrames();

        try {
            const full = await scrollerState();
            const fullShape = await shape();

            assert.equal(full.count, ids.length);
            assert.equal(full.spacer, false);
            assert.ok(Math.abs(full.gap) < 2);
            await readAboveBottom();
            const reading = await scrollerState();

            assert.ok(reading.gap >= 200);
            await inPage(
                `(await import('/store.js')).openSheet({ type: 'appearance' }); return 'null';`,
            );
            await until(
                () =>
                    inPage<boolean>(`
            return JSON.stringify([...document.querySelectorAll('[role="switch"]')].some(
                (node) => node.getAttribute('aria-label') === ${label} && node.getAttribute('aria-checked') === 'false'));
        `),
                "the experimental switch, off",
            );
            await toggle();
            assert.equal(
                (await scrollerState()).count,
                full.count,
                "enabling it does not tear down rows already drawn",
            );
            await back();
            await assertReading(reading);
            const mounted = await scrollerState();

            assert.ok(mounted.spacer && mounted.count < full.count);
            await synced(id);
            await go(other);
            await until(
                () =>
                    inPage<boolean>(`
            const cached = await (await import('/session-cache.js')).read(${Number(id)});
            return JSON.stringify(cached?.record.place?.keep > 200);
        `),
                "the reading position, saved on the device",
            );

            for (const reload of [false, true]) {
                const me = hold("/api/me");

                try {
                    if (reload) {
                        await page.reload();
                    } else {
                        await page.navigate(`${base}/s/${id}`);
                    }

                    await until(async () => (await shown(last)).rows, "the verified device copy");
                    assert.ok(me.entered);
                    await twoFrames();
                    assert.ok((await scrollerState()).spacer);
                    await assertReading(reading);
                } finally {
                    me.release();
                }

                await ready();
                await synced(id);
                await assertReading(reading);
            }

            // Reopen the fixture at the bottom using precisely the same options, once with and once without the switch.
            await inPage(`
            const box = document.querySelector('.pane > .scroller');
            box.scrollTop = box.scrollHeight;
            box.dispatchEvent(new Event('scroll'));
            return 'null';
        `);
            await back();
            const atEnd = await scrollerState();

            assert.ok(atEnd.spacer && Math.abs(atEnd.gap) < 2);
            assert.equal(atEnd.row, full.row);
            await experimental(false);
            await twoFrames();
            assert.deepEqual(await scrollerState(), full);
            await back();
            assert.deepEqual(
                await shape(),
                fullShape,
                "reopening with the switch off uses the original DOM",
            );
        } finally {
            await experimental(false);
        }
    },
);

test(
    "near rows fills for reading earlier, Find, entry links and selection without replacing drawn rows",
    real,
    async () => {
        const { id, ids, word, last } = await nearFixture();
        const first = ids[0];
        const end = ids.at(-1);

        const open = async () => {
            await openOn(id, last);
            await synced(id);
            await until(async () => (await scrollerState()).spacer, "estimated older rows");
        };

        const target = (entry: number | undefined) =>
            inPage<boolean>(`
        const target = document.querySelector('#entry-${entry}.flash');
        const b = document.querySelector('.pane > .scroller').getBoundingClientRect();
        return JSON.stringify(!!target && target.getBoundingClientRect().top >= b.top - 2 &&
            target.getBoundingClientRect().top < b.bottom);
    `);

        await experimental(true);

        try {
            await open();
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(window.find(${JSON.stringify(word(0))}));`,
                ),
                false,
            );
            await inPage(`
            (await import('/store.js')).openSheet({ type: 'find', query: ${JSON.stringify(word(0))} });
            return 'null';
        `);
            await until(
                () =>
                    inPage<boolean>(`
            return JSON.stringify([...document.querySelectorAll('.find-result')].some((node) =>
                node.textContent.includes(${JSON.stringify(word(0))})));
        `),
                "app Find sees the unmounted message",
            );
            await inPage(`document.querySelector('.find-result').click(); return 'null';`);
            await until(() => target(first), "Find lands on and highlights the row");
            assert.equal((await scrollerState()).count, ids.length);

            // The jump API used by pins, entry links and extensions mounts before it asks for the element in rAF.
            await inPage(`const box = document.querySelector('.pane > .scroller'); box.scrollTop = box.scrollHeight;
            box.dispatchEvent(new Event('scroll')); return 'null';`);
            await open();
            assert.ok(
                await inPage<boolean>(`
            return JSON.stringify(await (await import('/chat.js')).jumpToEntry(${first}));
        `),
            );
            await until(() => target(first), "entry jump lands on the previously unmounted row");

            // Use a fresh bottom open. Move near, but not into, the estimated part. Its replacement must not move the row.
            await inPage(`const box = document.querySelector('.pane > .scroller'); box.scrollTop = box.scrollHeight;
            box.dispatchEvent(new Event('scroll')); return 'null';`);
            await open();
            await inPage(`
            const box = document.querySelector('.pane > .scroller');
            const gap = box.querySelector('.near-gap');
            box.scrollTop += gap.getBoundingClientRect().bottom - box.getBoundingClientRect().top + box.clientHeight / 4;
            window.nearOld = document.getElementById('entry-${end}');
            window.nearAt = window.nearOld.getBoundingClientRect().top;
            window.nearBefore = { top: box.scrollTop, height: box.scrollHeight, client: box.clientHeight, offset: window.nearAt };
            box.dispatchEvent(new Event('scroll'));
            return 'null';
        `);
            await twoFrames();
            const after = await inPage<{
                spacer: boolean;
                same: boolean;
                delta: number;
                before: unknown;
                top: number;
                height: number;
            }>(`
                const box = document.querySelector('.pane > .scroller');
                return JSON.stringify({ spacer: !!box.querySelector('.near-gap'), same: window.nearOld === document.getElementById('entry-${end}'),
                    delta: window.nearOld.getBoundingClientRect().top - window.nearAt, before: window.nearBefore,
                    top: box.scrollTop, height: box.scrollHeight });
            `);

            assert.ok(
                !after.spacer && after.same && Math.abs(after.delta) <= 2,
                JSON.stringify(after),
            );

            await inPage(`const box = document.querySelector('.pane > .scroller'); box.scrollTop = box.scrollHeight;
            box.dispatchEvent(new Event('scroll')); return 'null';`);
            await open();
            // Keyboard selection includes material from both ends. Inspect what the browser passes to Copy.
            await inPage(`
            document.activeElement.blur();
            document.addEventListener('copy', (e) => { window.copiedNear = String(getSelection()); e.preventDefault(); }, { once: true });
            return 'null';
        `);
            await page.press("Control+a");
            await page.press("Control+c");
            const copied = await inPage<string>(`return JSON.stringify(window.copiedNear ?? '');`);

            assert.ok(
                copied.includes(word(0)) && copied.includes(last),
                "Copy contains the whole selection, including older rows",
            );
        } finally {
            await experimental(false);
        }
    },
);

test("near rows preserves unread opening and entry jumps on the PiP board", real, async () => {
    const pip = await app.pip.ensure(owner(app));
    const { ids, last } = await nearFixture(false, pip);
    const background = await newSession(app);

    await say(app, background, "The session behind PiP");
    await experimental(true);
    await openOn(background, "The session behind PiP");

    try {
        await inPage(`
            (await import('/theme.js')).setPrefs({ pip: 'board' });
            (await import('/store.js')).setUnread(${Number(pip)}, true);
            (await import('/pip.js')).openPip();
            return 'null';
        `);
        await until(async () => (await shown(last)).rows, "PiP transcript");
        await synced(pip);
        await twoFrames();
        const bottom = await scrollerState();

        assert.ok(bottom.spacer && Math.abs(bottom.gap) < 2);
        assert.equal(
            await inPage(
                `return JSON.stringify((await import('/store.js')).store.state.unread.includes(${Number(pip)}));`,
            ),
            false,
        );
        assert.equal(
            await inPage(
                `return JSON.stringify(await (await import('/chat.js')).jumpToEntry(${ids[0]}));`,
            ),
            true,
        );
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(!!document.querySelector('#entry-${ids[0]}.flash'));`,
                ),
            "jump to a PiP entry",
        );
        assert.equal((await scrollerState()).spacer, false);
    } finally {
        await inPage(
            `(await import('/pip.js')).closePip(); (await import('/theme.js')).setPrefs({ pip: 'floating' }); return 'null';`,
        );
        await experimental(false);
    }
});

test(
    "near rows keeps a reading anchor through a late image and KaTeX, then follows streaming",
    real,
    async () => {
        const { id, ids, last, lesson } = await nearFixture(true);

        assert.ok(lesson);
        const math = hold("/vendor/katex.mjs");
        const image = hold(`/api/c/${id}/file`);

        await experimental(true);

        try {
            await openOn(id, last);
            await synced(id);
            assert.ok((await scrollerState()).spacer);
            await inPage(`
            const box = document.querySelector('.pane > .scroller');
            const row = document.getElementById('entry-${ids[50]}');
            box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;
            box.dispatchEvent(new Event('scroll'));
            return 'null';
        `);
            await until(() => math.entered, "KaTeX requested");
            await inPage(
                `document.querySelector('img[alt="Late image"]').loading = 'eager'; return 'null';`,
            );
            await until(() => image.entered, "image requested");
            await twoFrames();
            const reading = await scrollerState();

            assert.equal(reading.row, `entry-${ids[50]}`);
            assert.ok(reading.spacer && reading.gap >= 60);

            const assertPlace = async () => {
                const after = await scrollerState();

                assert.equal(after.row, reading.row);
                assert.ok(
                    Math.abs(after.offset - reading.offset) <= 2,
                    `${after.offset} vs ${reading.offset}`,
                );
            };

            image.release();
            await until(
                () =>
                    inPage<boolean>(`
            return JSON.stringify(document.querySelector('img[alt="Late image"]')?.naturalHeight === 300);
        `),
                "the previously unsized image",
            );
            await twoFrames();
            await assertPlace();
            math.release();
            await until(
                () =>
                    inPage<boolean>(`
            return JSON.stringify(!!document.querySelector('.transcript .katex'));
        `),
                "KaTeX has rendered",
            );
            await twoFrames();
            await assertPlace();

            await inPage(`
            const box = document.querySelector('.pane > .scroller');
            box.querySelector('.activity-head[aria-expanded="false"]')?.click();
            const { store } = await import('/store.js');
            store.set(({ view, me }) => ({ view: { ...view,
                inbox: [{ id: 'near-queue', by: me.id, mode: 'followUp', text: 'queued with near rows' }],
            } }));
            return 'null';
        `);
            await until(
                () =>
                    inPage<boolean>(`
            const lesson = document.querySelector('.lesson-call');
            const queue = [...document.querySelectorAll('.queued-text')];
            return JSON.stringify(lesson?.textContent.includes(${JSON.stringify(lesson.pending ? lesson.text : "In memory:")}) &&
                queue.some((item) => item.textContent.includes('queued with near rows')) || false);
        `),
                "the lesson card and queue still draw",
            );
            await inPage(`
            const box = document.querySelector('.pane > .scroller');
            box.scrollTop = box.scrollHeight;
            box.dispatchEvent(new Event('scroll'));
            return 'null';
        `);
            await until(async () => Math.abs((await scrollerState()).gap) < 2, "at the bottom");
            // A small clamp before a larger resize can deliver a scroll event before the layout observer.
            await inPage(`
                const box = document.querySelector('.pane > .scroller');
                const row = document.getElementById('entry-${ids[51]}');
                box.scrollTop -= 3;
                row.style.minHeight = '440px';
                box.dispatchEvent(new Event('scroll'));
                return 'null';
            `);
            await twoFrames();
            assert.ok(
                Math.abs((await scrollerState()).gap) < 2,
                "a resize is not a reader scrolling away",
            );

            for (const n of [40, 100, 240]) {
                await inPage(`
                const { store } = await import('/store.js');
                const text = 'Streaming near rows. '.repeat(${n});
                store.set(({ view }) => ({ view: { ...view, live: { busy: true,
                    generation: { attempt: 0, message: { blocks: [{ type: 'text', text }] } },
                } } }));
                return 'null';
            `);
                await twoFrames();
                const now = await scrollerState();

                assert.ok(now.spacer, "the prefix is still deferred");
                assert.ok(Math.abs(now.gap) < 2, `stream did not follow: ${now.gap}`);
            }
        } finally {
            image.release();
            math.release();
            await experimental(false);
        }
    },
);

for (const reshape of [false, true]) {
    test(
        reshape
            ? "a new build keeps the reading anchor when the projection reorders entries"
            : "a new build corrects a long cached transcript in place",
        real,
        async () => {
            const id = await newSession(app);
            const ids: number[] = [];

            await app.harness.commit(async (tx) => {
                for (let n = 0; n < 110; n++) {
                    const entry = await tx.appendEntry(UserEntry, id, {
                        model: [
                            {
                                role: "user",
                                content: `Review note ${n}: Check the session transcript after a server restart.`,
                                timestamp: Date.now(),
                            },
                        ],
                    });

                    ids.push(Number(entry.id));
                }
            }, context);

            const first = ids[reshape ? 56 : 5]!;
            const anchor = ids[reshape ? 46 : 31]!;
            const changed = ids[reshape ? 65 : 32]!;
            const removed = 987_654_321;
            const oldText = "This note was displayed by the previous build.";
            const newText = `Review note ${reshape ? 65 : 32}:`;
            const attach = app.attach;
            const oldBuild = app.build;
            let request: Client["have"];
            let replay: { entries: ClientEntry[]; order: number[]; orderFrom?: number } | undefined;

            // Only build A projects this row differently, and in the reshape case a row moves and an old id is used.
            app.attach = async (client) => {
                if (client.conversationId === id) {
                    const send = client.send;
                    const old = app.build === oldBuild;

                    if (!old) {
                        request = client.have;
                    }

                    client.send = (event, data) => {
                        const view = data as NonNullable<typeof replay> & { full: boolean };

                        if (event !== "view" || !view.full || view.orderFrom !== undefined) {
                            send(event, data);

                            return;
                        }

                        if (!old) {
                            replay = view;
                            send(event, view);

                            return;
                        }

                        const entries = view.entries.map((entry) =>
                            entry.id === changed ? { ...entry, text: oldText } : entry,
                        );
                        const order = [...view.order];

                        if (reshape) {
                            order.splice(order.indexOf(anchor), 1);
                            order.splice(order.indexOf(changed), 0, anchor, removed);
                            entries.push({
                                id: removed,
                                kind: "user",
                                text: "An id no longer projected.",
                                images: 0,
                            });
                        }

                        send(event, { ...view, entries, order });
                    };
                }

                await attach.call(app, client);
            };

            let update: ReturnType<typeof changeBuild> | undefined;
            let me: ReturnType<typeof hold> | undefined;
            let events: ReturnType<typeof hold> | undefined;
            const shots = process.env.PI_POCKET_BUILD_SHOTS;

            try {
                if (shots && !reshape) {
                    mkdirSync(shots, { recursive: true });
                    await page.setViewport(VIEWPORTS.mobile);
                }

                await openOn(id, "Review note 109");
                await inPage(`
                    const { loadEarlier, store } = await import('/store.js');
                    const { setPrefs } = await import('/theme.js');

                    setPrefs({ motion: 'reduced' });
                    await loadEarlier();
                    store.set({ transcriptFrom: ${first} });
                    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    const scroller = document.querySelector('.pane > .scroller');
                    const row = document.getElementById('entry-${anchor}');

                    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
                    scroller.dispatchEvent(new Event('scroll'));

                    return 'null';
                `);
                await until(
                    () =>
                        inPage<boolean>(`
                        const copy = await (await import('/session-cache.js')).read(${Number(id)});
                        return JSON.stringify(copy?.info.build === ${JSON.stringify(oldBuild)} && copy?.record.place?.from === ${first});
                    `),
                    "build A's copy and reading place on the device",
                    15_000,
                );
                await leave();
                await say(app, id, "A row added before build B reopened this session.");
                update = changeBuild();
                await leave();
                assert.equal(
                    await inPage<string>(`
                        const copy = await (await import('/session-cache.js')).read(${Number(id)});
                        return JSON.stringify(copy?.info.build ?? null);
                    `),
                    oldBuild,
                    "build B's hello does not drop an unopened copy",
                );
                me = hold("/api/me");
                events = hold("/api/events");
                await page.navigate(`${base}/s/${id}`);
                await until(async () => (await shown(oldText)).rows, "the old rows before /api/me");
                assert.equal((await shown(oldText)).boot, false, "no boot screen flash");
                assert.equal((await shown(oldText)).me, false);
                me.release();
                await until(() => events!.entered, "build B's held event stream");
                await until(
                    () =>
                        inPage<boolean>(
                            `return JSON.stringify(document.querySelector('[data-part="composer"] textarea') !== null);`,
                        ),
                    "the composer",
                );
                await inPage(`
                    const { store, viewSynced } = await import('/store.js');
                    const row = document.getElementById('entry-${anchor}');
                    const scroller = row.closest('.scroller');
                    const draft = document.querySelector('[data-part="composer"] textarea');

                    if (viewSynced(${Number(id)}) || store.state.view.build !== ${JSON.stringify(oldBuild)}) {
                        throw Error('The copy must remain stale until the view arrives');
                    }

                    draft.value = 'Keep this draft while the transcript updates.';
                    draft.dispatchEvent(new Event('input', { bubbles: true }));
                    const box = row.getBoundingClientRect();
                    const top = scroller.getBoundingClientRect().top;
                    const at = box.top - top;

                    if (box.bottom <= top || at >= scroller.clientHeight / 2) {
                        throw Error('The cache did not reopen at the reading anchor: ' + at);
                    }

                    globalThis.reading = {
                        row, draft, scroller, at,
                        entry: store.state.view.entries.get(${anchor}),
                    };

                    return 'null';
                `);

                if (shots && !reshape) {
                    writeFileSync(
                        join(shots, "before-refresh.jpg"),
                        Buffer.from((await page.screenshot()).data, "base64"),
                    );
                }

                events.release();
                await until(async () => (await shown(newText)).rows, "the corrected row");
                await ready();

                assert.equal(request?.build, oldBuild, "have never claims to be from build B");
                assert.equal(
                    replay?.orderFrom,
                    undefined,
                    "the replay did not count any old entries as sent",
                );
                assert.ok(
                    replay?.entries.some((entry) => entry.id === anchor),
                    "the server sent even the earlier anchor again",
                );
                assert.ok(
                    replay?.entries.every((entry) => !("partial" in entry) || !entry.partial),
                    "the refresh came in one whole view",
                );
                const after = await inPage<{
                    sameNode: boolean;
                    sameEntry: boolean;
                    sameDraft: boolean;
                    offset: number;
                    authoritative: boolean;
                    removed: boolean;
                    added: boolean;
                }>(`
                    const { store, viewSynced } = await import('/store.js');
                    const row = document.getElementById('entry-${anchor}');
                    const at = row?.getBoundingClientRect().top - reading.scroller.getBoundingClientRect().top;

                    return JSON.stringify({
                        sameNode: row === reading.row,
                        sameEntry: store.state.view.entries.get(${anchor}) === reading.entry,
                        sameDraft: document.querySelector('[data-part="composer"] textarea') === reading.draft && reading.draft.value === 'Keep this draft while the transcript updates.',
                        offset: Math.abs(at - reading.at),
                        authoritative: viewSynced(${Number(id)}) && store.state.view.build === ${JSON.stringify(update.build)},
                        removed: !store.state.view.entries.has(${removed}) && !document.getElementById('entry-${removed}'),
                        added: [...store.state.view.entries.values()].some((item) => item.text === 'A row added before build B reopened this session.'),
                    });
                `);

                if (!reshape) {
                    assert.equal(after.sameNode, true, "the unchanged anchor is the same DOM node");
                }

                assert.equal(
                    after.sameEntry,
                    true,
                    "unchanged content preserves the entry object used by row memos",
                );
                assert.equal(after.sameDraft, true, "the same composer keeps its draft");
                assert.ok(after.offset <= 2, `the anchor moved ${after.offset}px`);
                assert.equal(after.authoritative, true);
                assert.equal(after.removed, true);
                assert.equal(after.added, true);
                assert.equal((await shown(oldText)).rows, false);

                if (shots && !reshape) {
                    writeFileSync(
                        join(shots, "after-refresh.jpg"),
                        Buffer.from((await page.screenshot()).data, "base64"),
                    );
                }
            } finally {
                me?.release();
                events?.release();
                update?.restore();
                app.attach = attach;
            }
        },
    );
}

test(
    "a new build cannot paint a device copy whose session is no longer allowed",
    real,
    async () => {
        const id = await newSession(app);
        const text = "kept before this server stopped allowing the session";

        await say(app, id, text);
        await openOn(id, text);
        await saved(id);
        await leave();
        const changed = changeBuild();
        const canSee = app.canSee;
        const me = hold("/api/me");

        try {
            // The person and their rights stamp are unchanged; the server's per-session decision now differs.
            app.canSee = (user, target) => target !== id && canSee.call(app, user, target);
            await page.navigate(`${base}/s/${id}`);
            await until(async () => (await shown(text)).boot, "boot, not the denied copy");
            assert.equal((await shown(text)).rows, false);
            me.release();
            await until(
                () =>
                    inPage<boolean>(`
                const { store } = await import('/store.js');
                return JSON.stringify(store.state.missing !== null && !openProbe.rows && !(await (await import('/session-cache.js')).read(${Number(id)})));
            `),
                "the denied copy was never shown and was dropped",
            );
        } finally {
            me.release();
            changed.restore();
            app.canSee = canSee;
        }
    },
);

test(
    "the page's cache identity is authenticated, escaped, and absent when caching is off",
    real,
    async () => {
        const user = app.config.users[0]!;
        const original = user.name;
        const cachePolicy = process.env.PI_POCKET_SESSION_CACHE;
        const headers = { authorization: `Bearer ${app.config.ownerToken}` };

        try {
            user.name = "</script><script>not a script</script>";
            const response = await fetch(`${base}/s/1`, { headers });
            const html = await response.text();
            const facts = JSON.parse(html.match(/id="pocket-known">([^<]+)<\/script>/)![1]!);

            assert.equal(facts.user.id, user.id);
            assert.equal(facts.user.name, user.name);
            assert.equal(facts.build, app.build);
            assert.ok(html.includes('<div id="app" hidden>'));
            assert.ok(!html.includes(user.name), "a name cannot close the JSON script tag");
            assert.ok(response.headers.get("content-security-policy")?.includes("'sha256-"));
            assert.ok(!JSON.stringify(facts).includes(app.config.ownerToken));
            assert.ok(
                !(await (await fetch(base)).text()).includes('id="pocket-known"'),
                "signed out has no early identity",
            );
            process.env.PI_POCKET_SESSION_CACHE = "off";
            const disabled = await (await fetch(base, { headers })).text();

            assert.ok(!disabled.includes('id="pocket-known"'));
            assert.ok(!disabled.includes('<div id="app" hidden>'));
        } finally {
            user.name = original;

            if (cachePolicy === undefined) {
                delete process.env.PI_POCKET_SESSION_CACHE;
            } else {
                process.env.PI_POCKET_SESSION_CACHE = cachePolicy;
            }
        }
    },
);

test(
    "/api/me changing the person removes the early view and cannot keep it for a switch",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "the previous person's rows");
        await openOn(id, "the previous person's rows");
        await saved(id);
        const me = hold("/api/me");
        const events = hold("/api/events");
        const poll = hold("/api/poll");

        try {
            await page.reload();
            await until(
                async () => (await shown("the previous person's rows")).rows,
                "the early view",
            );
            meUser = { ...app.config.users[0]!, id: "another-person" };
            me.release();
            await until(
                async () =>
                    await inPage<boolean>(`
            return JSON.stringify((await import('/store.js')).store.state.me?.id === 'another-person');
        `),
                "the changed identity",
            );
            assert.equal((await shown("the previous person's rows")).rows, false);
            assert.equal(
                await inPage<boolean>(`
            return JSON.stringify(!(await (await import('/session-cache.js')).list()).some((each) => each.id === ${Number(id)}));
        `),
                true,
                "the old view was forgotten on the device too",
            );
            // Leave the artificial account before the real stream can start an account-change reload.
            meUser = undefined;
            await page.navigate(`${base}/`);
        } finally {
            meUser = undefined;
            me.release();
            events.release();
            poll.release();
        }

        // The real stream identifies the owner and reloads the page. Do not race the next navigation against it.
        await ready();
    },
);

for (const changed of [false, true]) {
    test(
        `a startup retry ${changed ? "drops an early snapshot after the person changes" : "keeps a still-usable early snapshot"}`,
        real,
        async () => {
            const id = await newSession(app);
            const text = `rows retained through a startup failure (${changed})`;

            await say(app, id, text);
            await openOn(id, text);
            await saved(id);
            const events = hold("/api/events");
            const poll = hold("/api/poll");
            const attempt = {
                requests: 0,
                user: {
                    ...app.config.users[0]!,
                    ...(changed ? { id: "another-person" } : {}),
                },
            };

            try {
                retryMe = attempt;
                await page.reload();
                await until(
                    async () => await inPage<boolean>(`return JSON.stringify(openProbe.rows);`),
                    "the early snapshot was painted",
                );
                await until(() => attempt.requests >= 2, "the automatic startup retry", 15_000);
                await until(async () => (await shown(text)).me, "the retry's identity");
                assert.equal(
                    (await shown(text)).rows,
                    !changed,
                    "revalidation precedes any session connection response",
                );
            } finally {
                retryMe = undefined;
                events.release();
                poll.release();
            }

            if (changed) {
                await ready();
            }

            await leave();
        },
    );
}

test("a blocked module still reveals the startup error on a signed-in page", real, async () => {
    failModule = true;

    try {
        await page.reload();
        await until(
            async () =>
                await inPage<boolean>(`
            const boot = document.querySelector('#app > .boot.failed');

            return JSON.stringify(boot != null && boot.getClientRects().length > 0 && boot.textContent.includes('did not load'));
        `),
            "the visible startup error",
        );
    } finally {
        failModule = false;
    }
});
