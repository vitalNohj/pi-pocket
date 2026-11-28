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
import { type ConversationId, UserEntry } from "@earendil-works/pi-durable";
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
    // Installed before the app's first render on every document. Disable idle read-ahead so the device-only switch
    // really is device-only, not accidentally warmed into tab memory while the test waits.
    const probe = `
        const idle = requestIdleCallback;

        globalThis.requestIdleCallback = (callback, options) => options?.timeout === 1000 ? 0 : idle(callback, options);
        // Poll without importing modules while the browser is still loading a new document's import map.
        globalThis.openProbe = { boot: false, rows: false, state: () => store.state };
        new MutationObserver(() => {
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

        if (failModule && path === "/text-hash.js") {
            response.writeHead(403).end();

            return;
        }

        if (path === "/app.js") {
            response.writeHead(200, {
                "content-type": "text/javascript",
                "cache-control": "no-store",
            });
            response.end(probe + source);

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
    "Find searches rows missing from the first view and history before a reset",
    real,
    async () => {
        const id = await newSession(app);

        const add = async (messages: string[]) => {
            await app.harness.commit(async (tx) => {
                for (const value of messages) {
                    await tx.appendEntry(UserEntry, id, {
                        model: [
                            {
                                role: "user",
                                content: [{ type: "text", text: value }],
                                timestamp: 1000,
                            },
                        ],
                    });
                }
            }, context);
        };

        await add(["needle in earlier history"]);
        await app.commands.reset(id, owner(app), "A fresh context");
        await add([
            "needle in the omitted rows",
            ...Array.from({ length: 96 }, (_, i) => "Find fixture " + i),
        ]);
        await openOn(id, "Find fixture 95");
        assert.equal((await shown("needle in the omitted rows")).rows, false);
        await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "find" });
        return "null";
    `);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(!!document.querySelector(".find-search input"));`,
                ),
            "the Find sheet",
        );
        await inPage(`
        const input = document.querySelector(".find-search input");

        input.value = "needle";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
        await until(
            () =>
                inPage<boolean>(`
        const found = [...document.querySelectorAll(".find-result")].map((row) => row.textContent);

        return JSON.stringify(found.some((row) => row.includes("needle in the omitted rows")) &&
            found.some((row) => row.includes("needle in earlier history")));
    `),
            "Find results from both the active context and history",
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
