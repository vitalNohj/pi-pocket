// Opening a session shows what the tab already has, before the server answers (`start` and `keptView` in web/store.js):
// a reload paints a session the device kept before `/api/me`, and a switch to one the tab has not shown paints the
// device's copy at once, or a quiet loader in the transcript when nothing is kept anywhere.
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
    skip: findBrowser() === undefined ? "no Chromium-based browser on the machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (findBrowser() === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "open-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.me !== undefined && store.state.sessionsLoaded);
            `)) === true,
        "signed in",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** Open `id` and wait until its transcript shows `text`. */
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
}

/** Wait until the device has saved `id`. */
async function saved(id: ConversationId): Promise<void> {
    await until(
        async () =>
            (await inPage<boolean>(`
                const { list } = await import("/session-cache.js");

                return JSON.stringify((await list()).some((each) => each.id === ${Number(id)}));
            `)) === true,
        "saved on the device",
        15_000,
    );
}

/** What the page shows: the boot screen, the quiet loader, and whether the transcript carries `text`. */
function shown(text: string): Promise<{ boot: boolean; loader: boolean; rows: boolean }> {
    return inPage(`
        const boot = document.querySelector(".boot");
        const transcript = document.querySelector('[data-part="transcript"]');

        return JSON.stringify({
            boot: boot !== null && !boot.classList.contains("inline"),
            loader: transcript?.querySelector(".loader") != null,
            rows: (transcript?.textContent ?? "").includes(${JSON.stringify(text)}),
        });
    `);
}

test("a reload with a cached session paints its rows before /api/me, never the boot screen", real, async () => {
    const id = await newSession(app);

    await say(app, id, "kept across the reload");
    await openOn(id, "kept across the reload");
    await saved(id);
    // `/api/me` waits, so the rows can only be the device's.
    await page.evaluate(`
        const fetched = fetch;

        globalThis.fetch = (url, options) =>
            String(url).endsWith("/api/me")
                ? new Promise((resolve) => setTimeout(() => resolve(fetched(url, options)), 4000))
                : fetched(url, options);

        return "null";
    `);
    await page.reload();
    await until(async () => (await shown("kept across the reload")).rows, "the cached rows", 20_000);

    const early = await shown("kept across the reload");

    assert.equal(early.rows, true, "the cached rows show before /api/me");
    assert.equal(early.boot, false, "the boot screen never shows");
    await until(
        async () =>
            (await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.me !== undefined);
            `)) === true,
        "/api/me answered",
        20_000,
    );
});

test("a reload with nothing cached shows the boot screen, then the transcript", real, async () => {
    const id = await newSession(app);
    // A page of its own, so nothing this tab showed before is in its memory, and nothing is on the device.
    const fresh = await browsers.open(1);
    const inFresh = async <T>(script: string) => JSON.parse(await fresh.evaluate(script)) as T;

    await fresh.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inFresh<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.me !== undefined);
            `)) === true,
        "the fresh page signed in",
        20_000,
    );
    await fresh.evaluate(`
        const cache = await import("/session-cache.js");

        await cache.clear();

        return "null";
    `);
    await fresh.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await inFresh<boolean>(`return JSON.stringify(document.querySelector(".boot") !== null)`)) ===
            true,
        "the boot screen",
        20_000,
    );
    await until(
        async () =>
            (await inFresh<boolean>(`
                return JSON.stringify((document.querySelector('[data-part="transcript"]')?.textContent ?? "").includes("nothing kept for this one"));
            `)) === true,
        "the transcript",
        20_000,
    );

    const late = await inFresh<{ boot: boolean; rows: boolean }>(`
        return JSON.stringify({
            boot: document.querySelector(".boot") !== null,
            rows: (document.querySelector('[data-part="transcript"]')?.textContent ?? "").includes("nothing kept for this one"),
        });
    `);

    assert.equal(late.boot, false, "the boot screen goes once the transcript shows");
    assert.equal(late.rows, true);
    await fresh.close();
});

test("a switch to a session cached only on the device shows its rows at once", real, async () => {
    const [first, second] = [await newSession(app), await newSession(app)];

    await say(app, first, "in memory");
    await say(app, second, "only on the device");
    await openOn(second, "only on the device");
    await saved(second);
    // Leave it: the tab drops it from memory and keeps the device's copy, which the switch reads.
    await openOn(first, "in memory");
    await page.evaluate(`
        const fetched = fetch;

        globalThis.fetch = (url, options) =>
            String(url).includes("/api/")
                ? new Promise((resolve) => setTimeout(() => resolve(fetched(url, options)), 4000))
                : fetched(url, options);

        return "null";
    `);
    await inPage(`
        const { navigate } = await import("/store.js");

        navigate(${Number(second)});

        return "null";
    `);
    await until(async () => (await shown("only on the device")).rows, "the device's rows", 20_000);

    const early = await shown("only on the device");

    assert.equal(early.rows, true, "the device's rows show before the server answers");
    assert.equal(early.boot, false, "no boot screen");
});

test("a switch to a session cached nowhere shows a quiet loader, never the boot screen", real, async () => {
    const [first, second] = [await newSession(app), await newSession(app)];

    await say(app, first, "the one on screen");
    await say(app, second, "not kept anywhere");
    await openOn(first, "the one on screen");
    await page.evaluate(`
        const cache = await import("/session-cache.js");

        await cache.drop((info) => info.id === ${Number(second)});

        return "null";
    `);
    await inPage(`
        const { store, navigate } = await import("/store.js");

        store.set({ sessions: [...store.state.sessions, { id: ${Number(second)}, title: "The uncached one" }] });
        navigate(${Number(second)});

        return "null";
    `);

    const waiting = await shown("not kept anywhere");

    console.log("WAITING", JSON.stringify(waiting), await page.evaluate(`return document.body.innerText.slice(0, 400)`));
    assert.equal(waiting.boot, false, "no full-page boot screen");
    assert.equal(waiting.loader, true, "a quiet loader in the transcript");
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(document.body.textContent.includes("The uncached one"))`),
        true,
        "the session's title shows",
    );
    await until(async () => (await shown("not kept anywhere")).rows, "the server's rows", 20_000);

    const late = await shown("not kept anywhere");

    assert.equal(late.rows, true, "the rows show once the server answers");
    assert.equal(late.loader, false, "the loader goes");
    assert.equal(late.boot, false);
});

test("a device cache from another person is not shown before /api/me", real, async () => {
    const id = await newSession(app);

    await say(app, id, "someone else's words");
    await openOn(id, "someone else's words");
    await saved(id);
    // The device's copy says another person kept it: the check refuses it, so the boot screen stands.
    console.log(
        "SAVE",
        await page.evaluate(`
        const cache = await import("/session-cache.js");
        const found = (await cache.list()).find((each) => each.id === ${Number(id)});
        const read = await cache.read(${Number(id)});

        await cache.save(
            ${Number(id)},
            read.record,
            { owner: "someone-else", build: found.build, size: found.size },
            100_000_000,
        );

        return JSON.stringify({ found, after: (await cache.list()).find((each) => each.id === ${Number(id)}) });
    `),
    );
    // `/api/me` waits, so rows before it could only be the other person's, which must not show.
    await page.evaluate(`
        const fetched = fetch;

        globalThis.fetch = (url, options) =>
            String(url).endsWith("/api/me")
                ? new Promise((resolve) => setTimeout(() => resolve(fetched(url, options)), 1500))
                : fetched(url, options);

        return "null";
    `);
    await page.reload();
    await new Promise((resolve) => setTimeout(resolve, 700));

    const early = await shown("someone else's words");

    console.log(
        "EARLY",
        JSON.stringify(early),
        await page.evaluate(`return JSON.stringify({
            known: document.getElementById("pocket-known")?.textContent?.slice(0, 200) ?? null,
            me: (await import("/store.js")).store.state.me?.id ?? null,
            build: (await import("/store.js")).store.state.server?.build ?? null,
            viewBuild: (await import("/store.js")).store.state.view.build ?? null,
            owner: (await (await import("/session-cache.js")).list()).find((e) => e.id === ${Number(id)})?.owner ?? null,
        })`),
    );
    assert.equal(early.rows, false, "another person's rows are not shown before /api/me");
    await until(
        async () =>
            (await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.me !== undefined);
            `)) === true,
        "/api/me answered",
        20_000,
    );

    const seen = await shown("someone else's words");

    assert.equal(seen.rows, true, "the server's own view shows, once it answers");
});
