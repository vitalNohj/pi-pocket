// A transcript's place belongs to its tab, including on a reload before the shared device cache can save it.
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 30_000,
} as const;

let app: App;
let server: Server;
let browser: Chromium;
let base: string;
let id: ConversationId;
let opening: Promise<void> | undefined;

before(async () => {
    if (executable === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    id = await newSession(app);

    for (let row = 1; row <= 10; row++) {
        await say(app, id, `Reading row ${row}\n\n${"Words to fill one line. ".repeat(12)}`);
    }

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    // Delay the server's view at reload, so a save of the new view cannot repair a wrong cached place.
    server = createServer(async (request, response) => {
        if (/^\/api\/(events|poll)\?/.test(request.url ?? "")) {
            await opening;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await Chromium.launch(executable, join(root, "scroll-browser"), []);
});

after(async () => {
    browser?.kill();
    await browser?.exited;
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** New tabs in the same context share cookies and IndexedDB, but have no opener or shared session storage. */
async function tab(context: string): Promise<BrowserPage> {
    const connection = browser.connection;
    const { targetId } = await connection.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context,
    });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });
    const page = new BrowserPage({
        conversationId: Number(id),
        connection,
        target: targetId,
        session: sessionId,
        context,
        userAgent: browser.userAgent,
        viewport: { width: 1000, height: 680, scale: 1, mobile: false },
        changed: () => {},
        saved: () => {},
    });

    await page.init();

    return page;
}

async function withTabs(
    run: (first: BrowserPage, another: () => Promise<BrowserPage>) => Promise<void>,
) {
    const { browserContextId } = await browser.connection.send("Target.createBrowserContext");
    const pages: BrowserPage[] = [];

    const another = async () => {
        const page = await tab(browserContextId);

        pages.push(page);

        return page;
    };

    try {
        const page = await another();

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await ready(page);
        await run(page, another);
    } finally {
        for (const page of pages) {
            page.close();
        }

        await browser.connection.send("Target.disposeBrowserContext", { browserContextId });
    }
}

const scroller = `document.querySelector('[data-part="transcript"]')?.parentElement`;

async function inPage<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function activate(page: BrowserPage): Promise<void> {
    await browser.connection.send("Target.activateTarget", { targetId: page.targetId });
}

async function ready(page: BrowserPage, connected = true): Promise<void> {
    await until(
        () =>
            inPage<boolean>(
                page,
                `
                const { store } = await import('/store.js');
                const element = ${scroller};

                return JSON.stringify((${!connected} || store.state.connection === 'open') &&
                    element?.clientHeight > 0 && element.scrollHeight > element.clientHeight + 800 &&
                    element.textContent.includes('Reading row 10'));
            `,
            ),
        "the transcript with a viewport",
    );
    await page.evaluate(
        `
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        return 'null';
    `,
        { timeoutMs: 5000 },
    );
}

async function scroll(page: BrowserPage, row: number, leave = false): Promise<number> {
    const keep = await inPage<number | null>(
        page,
        `
        const { store, navigate } = await import('/store.js');
        const element = ${scroller};
        const prompt = [...element.querySelectorAll('[data-part="prompt-row"]')]
            .find((prompt) => prompt.textContent.includes('Reading row ${row}'));
        const box = prompt.getBoundingClientRect();
        const top = element.getBoundingClientRect().top;

        element.scrollTop += box.top - top + box.height / 2 - element.clientHeight / 2;
        element.dispatchEvent(new Event('scroll'));
        const keep = store.state.transcriptPlace?.keep ?? null;

        if (${leave}) {
            navigate(null);
        }

        return JSON.stringify(keep);
    `,
    );

    assert.ok(keep !== null && keep > 0, "scrolled away from the bottom");

    return keep;
}

async function expectPlace(page: BrowserPage, row: number): Promise<void> {
    const visible = await inPage<string[]>(
        page,
        `
        const element = ${scroller};
        const viewport = element.getBoundingClientRect();

        return JSON.stringify([...element.querySelectorAll('[data-part="prompt-row"]')]
            .filter((prompt) => {
                const box = prompt.getBoundingClientRect();
                return box.top < viewport.bottom && box.bottom > viewport.top;
            })
            .map((prompt) => prompt.textContent.match(/Reading row \\d+/)?.[0]));
    `,
    );

    assert.ok(
        visible.includes(`Reading row ${row}`),
        `expected row ${row} in view, saw ${visible}`,
    );
}

/** Wait for the exit save so a new tab has a real fallback on the device. */
async function leaveAt(page: BrowserPage, row: number): Promise<void> {
    const keep = await scroll(page, row, true);

    await until(
        () =>
            inPage<boolean>(
                page,
                `
                const cached = await (await import('/session-cache.js')).read(${id}, false);

                return JSON.stringify(cached?.record.place?.keep === ${keep});
            `,
            ),
        "the exit place in IndexedDB",
    );
}

/** An outgoing document may be killed before its asynchronous device save reaches IndexedDB. */
async function freezeDevicePlace(page: BrowserPage): Promise<void> {
    await page.evaluate(`
        const put = IDBObjectStore.prototype.put;

        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === 'views' && this.transaction.db.name === 'pocket-sessions') {
                throw new Error('The outgoing page did not finish saving its view');
            }

            return put.apply(this, args);
        };

        return 'null';
    `);
}

async function reopen(page: BrowserPage): Promise<void> {
    await page.evaluate(`(await import('/store.js')).navigate(${id}); return 'null';`);
    await ready(page);
}

async function withoutServerView(run: () => Promise<void>): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();

    opening = promise;

    try {
        await run();
    } finally {
        opening = undefined;
        resolve();
    }
}

test("reload takes the place last scrolled to, not the last exit place", real, async () => {
    await withTabs(async (page) => {
        await leaveAt(page, 3);
        await reopen(page);
        await expectPlace(page, 3);
        await freezeDevicePlace(page);
        await scroll(page, 7);

        await withoutServerView(async () => {
            await page.reload();
            await ready(page, false);
            await expectPlace(page, 7);
        });
    });
});

test("a new tab keeps the shared place through the hidden startup layout", real, async () => {
    await withTabs(async (page, another) => {
        await leaveAt(page, 5);

        await withoutServerView(async () => {
            const next = await another();

            await activate(next);
            await next.navigate(`${base}/s/${id}`);
            await ready(next, false);
            await expectPlace(next, 5);
        });
    });
});

test("a jump to the bottom takes effect before a reload can interrupt a save", real, async () => {
    await withTabs(async (page) => {
        await leaveAt(page, 5);
        await reopen(page);
        await expectPlace(page, 5);
        await freezeDevicePlace(page);
        await withoutServerView(async () => {
            await page.evaluate(`
                document.querySelector('[aria-label="To the bottom"]').click();
                setTimeout(() => location.reload(), 0);

                return 'null';
            `);
            await until(
                () =>
                    inPage<boolean>(
                        page,
                        `return JSON.stringify(performance.getEntriesByType('navigation')[0]?.type === 'reload');`,
                    ).catch(() => false),
                "a new document after the jump",
            );
            await ready(page, false);
            const gap = await inPage<number>(
                page,
                `
                const element = ${scroller};

                return JSON.stringify(element.scrollHeight - element.scrollTop - element.clientHeight);
            `,
            );

            assert.ok(gap <= 2, `expected the bottom, got a gap of ${gap}`);
        });
    });
});

test("two tabs in one browser reload at their own places", real, async () => {
    await withTabs(async (first, another) => {
        await leaveAt(first, 4);
        await reopen(first);
        const second = await another();

        await activate(second);
        await second.navigate(`${base}/s/${id}`);
        await ready(second);
        await leaveAt(second, 8);
        await reopen(second);
        await expectPlace(second, 8);
        await freezeDevicePlace(second);
        await activate(first);
        await expectPlace(first, 4);
        await freezeDevicePlace(first);
        await withoutServerView(async () => {
            await first.reload();
            await ready(first, false);
            await expectPlace(first, 4);
            await activate(second);
            await second.reload();
            await ready(second, false);
            await expectPlace(second, 8);
        });
    });
});
