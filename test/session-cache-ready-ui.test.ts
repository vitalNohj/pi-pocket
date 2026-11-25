// A tab keeps requested first views after leaving, and reads its visible pins without joining their rooms.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { type ConversationId, UserEntry } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 60_000,
} as const;

after(cleanUp);

function latch() {
    const { promise, resolve } = Promise.withResolvers<void>();

    return { wait: promise, release: resolve };
}

async function browser(app: App) {
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const appSource = readFileSync(join(import.meta.dirname, "../web/app.js"), "utf8");
    const requests: URL[] = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://test.local");

        requests.push(url);

        if (url.pathname === "/app.js") {
            // Headless Chromium keeps its last page visible. Exercise the actual visibility listener on demand.
            response.writeHead(200, {
                "content-type": "text/javascript",
                "cache-control": "no-store",
            });
            response.end(
                `
                globalThis.cacheTest = { hidden: sessionStorage.getItem('cache-test-hidden') === '1' };
                Object.defineProperty(document, 'visibilityState', { get: () => cacheTest.hidden ? 'hidden' : 'visible' });
            ` + appSource,
            );

            return;
        }

        await handler(request, response);
    });
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "cache-ready-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browsers.open(1);
    const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;
    const ready = () =>
        until(
            () =>
                inPage<boolean>(`
        const { state } = (await import('/store.js')).store;
        return JSON.stringify(state.me != null && state.sessionsLoaded && state.streamId != null);
    `),
            "signed in with a session list",
        );
    const open = (id: ConversationId | null) =>
        inPage(`
        (await import('/store.js')).navigate(${String(id)});
        return 'null';
    `);
    const saved = (id: ConversationId) =>
        inPage<boolean>(`
        return JSON.stringify((await (await import('/session-cache.js')).list()).some((entry) => entry.id === ${Number(id)}));
    `);
    const shown = (words: string) =>
        inPage<boolean>(`
        return JSON.stringify([...document.querySelectorAll('[data-part="prompt-row"]')].some((row) => row.textContent.includes(${JSON.stringify(words)}) && row.getClientRects().length > 0));
    `);

    const shot = async (name: string) => {
        const dir = process.env.PI_POCKET_CACHE_READY_SHOTS;

        if (dir !== undefined) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, `${name}.jpg`),
                Buffer.from((await page.screenshot()).data, "base64"),
            );
        }
    };

    const close = async () => {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    };

    return { base, page, inPage, ready, requests, open, saved, shown, shot, close };
}

async function append(app: App, id: ConversationId, texts: string[]) {
    await app.harness.commit(async (tx) => {
        for (const text of texts) {
            await tx.appendEntry(UserEntry, id, {
                model: [{ role: "user", content: text, timestamp: Date.now() }],
            });
        }
    }, context);
}

for (const transport of ["stream", "poll"]) {
    test(
        `an abandoned first view is kept and only its changes come on return (${transport})`,
        real,
        async () => {
            const app = await openApp(scriptedModel());
            const tab = await browser(app);
            const first = latch();
            const leaving = latch();
            const returning = latch();
            const id = await newSession(app);
            const words = "Last row of the long session";
            const change = "A row appended after the tab left";
            const switches: Client["have"][] = [];
            const room = app.room.bind(app);
            const switchTo = app.switchTo.bind(app);
            const views: { entries: { text?: string }[]; orderFrom?: number }[] = [];
            const attach = app.attach.bind(app);
            let opens = 0;

            app.room = async (asked) => {
                const opening = room(asked);

                if (asked === id) {
                    opens++;
                    await (opens === 1 ? first.wait : returning.wait);
                }

                return opening;
            };

            app.switchTo = (...args) => {
                if (transport === "stream" && args[2] === undefined) {
                    // The tab navigated, but the server has not yet handled its switch away.
                    void leaving.wait.then(() => switchTo(...args));

                    return true;
                }

                if (args[2] === id) {
                    switches.push(args[3]);
                }

                return switchTo(...args);
            };

            app.attach = (client) => {
                const send = client.send;

                client.send = (event, data) => {
                    const view = data as (typeof views)[number] & {
                        full?: boolean;
                        conversation?: { id: number };
                    };

                    if (event === "view" && view.full && view.conversation?.id === Number(id)) {
                        views.push(view);
                    }

                    send(event, data);
                };

                return attach(client);
            };

            try {
                const host =
                    transport === "poll"
                        ? tab.base.replace("127.0.0.1", "pocket.localhost")
                        : tab.base;

                await append(app, id, [
                    ...Array.from({ length: 260 }, (_, n) => `Long session row ${n}`),
                    words,
                ]);
                await tab.page.navigate(
                    `${host}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
                );
                await tab.ready();

                if (transport === "poll") {
                    await tab.inPage(
                        `localStorage.setItem('pocket.transport', 'poll'); return 'null';`,
                    );
                    await tab.page.navigate(`${host}/?transport=poll`);
                    await tab.ready();
                    await until(
                        () => tab.requests.some((url) => url.pathname === "/api/poll"),
                        "long polling",
                    );
                }

                await tab.open(id);
                await until(() => opens === 1, "first requested view is held");
                await tab.open(null);
                const serverLeft = () =>
                    [...app.clients].every((client) => client.conversationId !== id);

                if (transport === "poll") {
                    await until(serverLeft, "the tab left on the server");
                }

                await tab.inPage(`
                globalThis.leftWasShown = false;
                new MutationObserver(() => {
                    if (location.pathname === '/' && document.querySelector('[data-part="transcript"]')?.textContent.includes(${JSON.stringify(words)})) {
                        leftWasShown = true;
                    }
                }).observe(document.body, { childList: true, subtree: true, characterData: true });
                return 'null';
            `);

                if (transport === "poll") {
                    await tab.open(id);
                    // Return even before the first view. It must wait for that request, not open another cold view.
                    assert.equal(opens, 1);
                }

                first.release();
                await until(() => tab.saved(id), "the left session is saved on the device");
                assert.equal(await tab.inPage(`return JSON.stringify(leftWasShown);`), false);
                const before = transport === "stream" ? 1 : 0;

                assert.equal(
                    views.length,
                    before,
                    "only the stream receives its old view as a regular event",
                );

                if (transport === "stream") {
                    leaving.release();
                    await until(serverLeft, "the tab left on the server");
                    assert.equal(await tab.shown(words), false);
                    await tab.shot("abandoned-off-screen");
                    await tab.open(id);
                }

                await until(() => tab.shown(words), "cached rows while the return's reply is held");
                await until(() => opens === 2, "the return uses its cached view");
                assert.deepEqual(
                    switches.map((have) => have !== undefined),
                    [false, true],
                );
                assert.equal(views.length, before, "no reply to the return yet");
                await tab.shot(`return-before-delta-${transport}`);
                await append(app, id, [change]);
                const warm = await app.openRoom(id)!;
                const owner = app.config.users.find((user) => user.role === "owner")!;

                await until(
                    () => warm.firstView(owner, switches[1])?.entries.length === 1,
                    "the warm room has the change",
                );
                returning.release();
                await until(() => tab.shown(change), "the new row follows the cached rows");
                assert.equal(views[before]?.orderFrom, switches[1]?.count);
                assert.deepEqual(
                    views[before]?.entries.map((entry) => entry.text),
                    [change],
                );
                await tab.shot(`return-after-delta-${transport}`);
            } finally {
                first.release();
                leaving.release();
                returning.release();
                await tab.close();
            }
        },
    );
}

test("synced pins are read ahead on hello and when another device changes them", real, async () => {
    const app = await openApp(scriptedModel());
    const tab = await browser(app);
    const me = owner(app);

    try {
        const [one, two] = await Promise.all([newSession(app), newSession(app)]);
        const three = await newSession(app);

        await Promise.all([
            append(app, one, ["A synced pin"]),
            append(app, two, ["Another synced pin"]),
        ]);
        await append(app, three, ["A pin from another device"]);
        await app.pinnedSessions.set(me, { pinned: [one, two] });
        await tab.page.navigate(
            `${tab.base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
        );
        await tab.ready();
        await tab.inPage(`
            localStorage.setItem('pocket.pinned.synced', ${JSON.stringify(me.id)});
            return 'null';
        `);
        await tab.page.navigate(tab.base);
        await tab.ready();
        await until(
            async () => (await Promise.all([tab.saved(one), tab.saved(two)])).every(Boolean),
            "both pins from hello saved on the device",
        );
        assert.ok(!(await tab.saved(three)));

        await app.pinnedSessions.set(me, { pinned: [one, three] });
        await until(() => tab.saved(three), "the new synced pin saved on the device");
        assert.ok([one, two, three].every((id) => app.openRoom(id) === undefined));
    } finally {
        await tab.close();
    }
});

test(
    "three visible pins read ahead two at a time, then resume with have and stop on sign-out",
    real,
    async () => {
        const app = await openApp(scriptedModel());
        const tab = await browser(app);
        const screen = latch();
        const firstView = app.firstView.bind(app);

        type Ask = ReturnType<typeof latch> & {
            id: ConversationId;
            have: Client["have"];
            result?: Awaited<ReturnType<App["firstView"]>>;
        };
        const asked: Ask[] = [];
        let active = 0;
        let most = 0;

        app.firstView = async (user, id, have) => {
            const ask: Ask = { id, have, ...latch() };

            asked.push(ask);
            most = Math.max(most, ++active);

            try {
                await ask.wait;

                return (ask.result = await firstView(user, id, have));
            } finally {
                active--;
            }
        };

        try {
            const [one, two] = await Promise.all([newSession(app), newSession(app)]);
            const [three, denied] = await Promise.all([newSession(app), newSession(app)]);
            const shown = await newSession(app);
            const pins = [one, two, three];
            const guest = app.config.addUser("Pin reader", "viewer", [shown, ...pins].map(String));
            const room = app.room.bind(app);
            let screenAsked = false;

            await Promise.all([
                append(app, shown, ["Foreground before pinned sessions"]),
                append(app, two, ["A pinned row saved on this device"]),
            ]);
            await Promise.all([append(app, one, ["First pin"]), append(app, three, ["Third pin"])]);

            app.room = async (id) => {
                if (id === shown) {
                    screenAsked = true;
                    await screen.wait;
                }

                return room(id);
            };

            await tab.page.navigate(`${tab.base}/login?token=${encodeURIComponent(guest.token)}`);
            await tab.ready();
            await tab.inPage(`
            sessionStorage.setItem('cache-test-hidden', '1');
            localStorage.setItem('pocket.pinned', ${JSON.stringify(JSON.stringify([one, denied, two, three]))});
            return 'null';
        `);
            await tab.page.navigate(`${tab.base}/s/${shown}`);
            await tab.ready();
            await until(() => screenAsked, "foreground request at the server");
            const visible = () =>
                tab.inPage(`
            cacheTest.hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            return 'null';
        `);

            await visible();
            await new Promise((resolve) => setTimeout(resolve, 180));
            assert.equal(asked.length, 0, "pins do not go first, even with the list ready");
            await tab.inPage(`
            cacheTest.hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            return 'null';
        `);
            screen.release();
            await until(() => tab.shown("Foreground before pinned sessions"), "foreground rows");
            await new Promise((resolve) => setTimeout(resolve, 180));
            assert.equal(asked.length, 0, "hidden tabs do not start pin reads");
            await visible();
            await until(() => asked.length === 2, "first two pin reads");
            assert.deepEqual(
                asked.map(({ id, have }) => [id, have]),
                [
                    [one, undefined],
                    [two, undefined],
                ],
            );
            asked[0]!.release();
            await until(() => asked.length === 3, "third pin takes a free slot");
            assert.equal(asked[2]!.id, three);
            asked[1]!.release();
            asked[2]!.release();
            await until(
                async () => (await Promise.all(pins.map(tab.saved))).every(Boolean),
                "all three pins on the device",
            );
            assert.equal(most, 2);
            assert.ok(!tab.requests.some((url) => url.pathname === `/api/c/${denied}/first-view`));
            assert.ok(
                pins.every((id) => app.openRoom(id) === undefined),
                "read ahead creates no rooms or presence",
            );
            assert.deepEqual(
                [...app.clients].map((client) => client.conversationId),
                [shown],
            );
            await tab.shot("pins-ready");

            // Reload with the same pins; the requests should each name their base instead of downloading the transcript.
            await append(app, one, ["One new pinned row"]);
            await tab.inPage(`sessionStorage.removeItem('cache-test-hidden'); return 'null';`);
            await tab.page.navigate(`${tab.base}/s/${shown}`);
            await until(() => asked.length === 5, "two pin refreshes");
            assert.deepEqual(
                asked.slice(3).map(({ id }) => id),
                [one, two],
            );
            assert.ok(asked.slice(3).every(({ have }) => have !== undefined));
            asked[3]!.release();
            await until(() => asked.length === 6, "third pin refresh");
            assert.ok(asked[5]!.have);
            const refreshed = asked[3]!.result?.view;

            assert.ok(refreshed !== undefined && "orderFrom" in refreshed);
            assert.equal(refreshed.orderFrom, asked[3]!.have?.count);
            assert.equal(refreshed.entries.length, 1);
            await until(
                () =>
                    tab.inPage<boolean>(`
            const saved = await (await import('/session-cache.js')).read(${Number(one)}, false);
            return JSON.stringify([...saved.record.view.entries.values()].some((entry) => entry.text === 'One new pinned row'));
        `),
                "the refreshed pin is written back",
            );

            // Sign out with two reads still pending. Even if their server responses finish, nothing saves again.
            await tab.inPage(`void (await import('/store.js')).signOut(); return 'null';`);
            await until(
                () =>
                    tab
                        .inPage<boolean>(
                            `
            return JSON.stringify(location.pathname === '/' && (await import('/store.js')).store.state.me === null);
        `,
                        )
                        .catch(() => false),
                "signed out",
            );
            asked[4]!.release();
            asked[5]!.release();
            await until(() => active === 0, "the outstanding server answers finished");
            assert.deepEqual(
                await tab.inPage(
                    `return JSON.stringify(await (await import('/session-cache.js')).list());`,
                ),
                [],
            );
            assert.equal(asked.length, 6);
            assert.equal(most, 2);
        } finally {
            screen.release();

            for (const ask of asked) {
                ask.release();
            }

            await tab.close();
        }
    },
);
