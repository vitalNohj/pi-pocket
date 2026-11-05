// Instant open off: a reload and a late update behave as they did before the instant-open change, and Appearance
// remembers the choice. The default (on) is covered by session-open-ui and session-glide-ui.
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 45_000,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
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
    // Installed before the app's first render. The boot flag records a full-page boot screen, not an inline one.
    const probe = `
        globalThis.openProbe = { boot: false, rows: false };
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
        }

        if (path === "/app.js") {
            response.writeHead(200, {
                "content-type": "text/javascript",
                "cache-control": "no-store",
            });
            response.end(probe + source);

            return;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "instant-off-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await ready();
    await inPage(`
        const saved = JSON.parse(localStorage.getItem("pocket.appearance") ?? "{}");

        localStorage.setItem("pocket.appearance", JSON.stringify({ ...saved, instantOpen: false }));

        return "null";
    `);
    await page.reload();
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
    await until(
        async () =>
            await inPage<boolean>(`
            const { store } = await import("/store.js");

            return JSON.stringify(store.state.me != null && store.state.sessionsLoaded && store.state.connection === "open");
        `),
        "signed in and connected",
        20_000,
    );
}

/** Open a new document, losing all tab memory. */
async function openOn(id: ConversationId, text: string): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await inPage<boolean>(`
            return JSON.stringify((document.querySelector('[data-part="transcript"]')?.textContent ?? "").includes(${JSON.stringify(text)}));
        `)) === true,
        text,
        20_000,
    );
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

function shown(text: string): Promise<{ boot: boolean; rows: boolean; me: boolean }> {
    return inPage(`
        const { store } = await import("/store.js");
        const transcript = document.querySelector('[data-part="transcript"]');

        return JSON.stringify({
            boot: globalThis.openProbe?.boot ?? false,
            rows: [...(transcript?.querySelectorAll('[data-part="prompt-row"]') ?? [])].some((row) => row.textContent.includes(${JSON.stringify(text)})),
            me: store.state.me !== undefined,
        });
    `);
}

test(
    "with instant open off, a cached reload keeps the boot screen and shows no rows until /api/me",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "kept but not shown early");
        await openOn(id, "kept but not shown early");
        await saved(id);
        const me = hold("/api/me");

        try {
            await page.reload();
            await until(
                async () => (await shown("kept but not shown early")).boot,
                "the boot screen",
            );
            const early = await shown("kept but not shown early");

            assert.equal(me.entered, true);
            assert.equal(early.me, false, "/api/me is still held");
            assert.equal(early.boot, true, "the boot screen stays up");
            assert.equal(early.rows, false, "no transcript rows before /api/me");
            assert.equal(
                await inPage<boolean>(`return JSON.stringify(openProbe.rows === false)`),
                true,
                "no row was painted while /api/me was held",
            );
        } finally {
            me.release();
        }

        await until(
            async () => (await shown("kept but not shown early")).rows,
            "rows after /api/me",
        );
        assert.equal((await shown("kept but not shown early")).me, true);
    },
);

test(
    "with instant open off, an update well after a server-loaded session shows does not glide",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "opened from the server");
        await openOn(id, "opened from the server");
        await page.evaluate(`
            const scroller = document.querySelector(".pane > .scroller");

            scroller.scrollTop = scroller.scrollHeight;
            scroller.dispatchEvent(new Event("scroll"));

            return "null";
        `);

        // Past the old catch-up window, which a server-loaded session never opens (it stays 0).
        const seen = await inPage<{ glided: boolean }>(`
            const { store } = await import("/store.js");
            const column = document.querySelector('[data-part="transcript"]');
            const animated = column.animate.bind(column);
            let glided = false;

            column.animate = (...args) => {
                glided = true;

                return animated(...args);
            };
            await new Promise((resolve) => setTimeout(resolve, 3200));

            const view = store.state.view;
            const id = "arrived-" + Math.random().toString(36).slice(2);

            store.set({
                view: {
                    ...view,
                    order: [...view.order, id],
                    entries: new Map([...view.entries, [id, { id, kind: "user", text: "late and still" }]]),
                },
            });
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            column.animate = animated;

            return JSON.stringify({ glided });
        `);

        assert.equal(seen.glided, false, "a server-loaded session does not glide a late update");
    },
);

test("Appearance's Instant open row flips and persists the pref", real, async () => {
    await inPage(`(await import("/store.js")).openSheet({ type: "appearance" }); return "null";`);
    await until(
        async () =>
            await inPage<boolean>(`
            const row = [...document.querySelectorAll(".setting-row, .sheet-row, .row")].find((each) => each.textContent.includes("Instant open"));

            return JSON.stringify(row != null && row.querySelector("button.on")?.textContent.trim() === "Off");
        `),
        "the Instant open row, off",
    );
    await inPage(`
        const row = [...document.querySelectorAll(".setting-row, .sheet-row, .row")].find((each) => each.textContent.includes("Instant open"));

        [...row.querySelectorAll("button")].find((button) => button.textContent.trim() === "On").click();

        return "null";
    `);
    await until(
        async () =>
            await inPage<boolean>(`
            const saved = JSON.parse(localStorage.getItem("pocket.appearance") ?? "{}");
            const row = [...document.querySelectorAll(".setting-row, .sheet-row, .row")].find((each) => each.textContent.includes("Instant open"));

            return JSON.stringify(saved.instantOpen === true && row.querySelector("button.on")?.textContent.trim() === "On");
        `),
        "On, saved",
    );
    await page.reload();
    await ready();
    assert.equal(
        await inPage<boolean>(`
            return JSON.stringify(JSON.parse(localStorage.getItem("pocket.appearance")).instantOpen === true);
        `),
        true,
        "the pref survives a reload",
    );
    // Put it back: the other tests in this file load with it off.
    await inPage(`
        const saved = JSON.parse(localStorage.getItem("pocket.appearance") ?? "{}");

        localStorage.setItem("pocket.appearance", JSON.stringify({ ...saved, instantOpen: false }));

        return "null";
    `);
    await page.reload();
    await ready();
});
