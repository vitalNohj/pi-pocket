// The folder picker's layout (New session: pick a folder), in a real Chromium: Runs on is pinned at the foot of the
// left column and does not scroll with the places, Manage runners… and Continue a Pi session… are in the bottom row
// after the check boxes, and the sheet is as tall as the screen allows, up to 800 px.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { Chromium, type Json } from "../src/server/browser/cdp.ts";
import { findBrowser, profileFolder } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browser: Chromium | undefined;
let base = "";

type Box = { top: number; bottom: number; left: number; right: number; height: number };

/** A page of its own, with its own cookies, signed in as the owner, at a screen of `width` x `height`. */
async function openPage(width: number, height: number, mobile = false) {
    const connection = browser!.connection;
    const context = await connection.send("Target.createBrowserContext");
    const target = await connection.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context.browserContextId,
    });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Json> =>
        connection.send(method, params, sessionId);

    const evaluate = async <T>(expression: string): Promise<T> => {
        const result = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });

        if (result.exceptionDetails !== undefined) {
            throw new Error(String(result.exceptionDetails.exception?.description));
        }

        return result.result.value as T;
    };

    const emulate = (w: number, h: number, phone = false) =>
        send("Emulation.setDeviceMetricsOverride", {
            width: w,
            height: h,
            deviceScaleFactor: phone ? 2 : 1,
            mobile: phone,
        });

    const resize = async (w: number, h: number, phone = false) => {
        await emulate(w, h, phone);
        await until(
            async () =>
                (await evaluate<number[]>("[innerWidth, innerHeight]")).join() === `${w},${h}`,
            `a ${w}x${h} screen`,
        );
    };

    await send("Page.enable");
    // Before the app loads: a phone's screen without the app's viewport (about:blank) is not 390 px wide.
    await emulate(width, height, mobile);

    const go = async (url: string) => {
        await send("Page.navigate", { url });
        await until(
            async () => (await evaluate<string>("document.readyState")) === "complete",
            url,
        );
    };

    await go(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await go(`${base}/`);
    // Signed in, the app's modules running, and the linked computer known.
    await until(
        () =>
            evaluate<boolean>(
                `import("/store.js").then(({ store }) => Boolean(store.state.me && store.state.server && store.state.runners.length > 0))`,
            ),
        "the signed-in app",
    );
    await resize(width, height, mobile);

    /** The bounding box of the first element that matches `selector`, or null. */
    const box = (selector: string) =>
        evaluate<Box | null>(`(() => {
            const found = document.querySelector(${JSON.stringify(selector)});
            if (!found) return null;
            const { top, bottom, left, right, height } = found.getBoundingClientRect();
            return { top, bottom, left, right, height };
        })()`);

    /** Opens the folder picker in `mode` and waits for it to show its places. */
    const openPicker = async (mode: "new" | "change") => {
        await evaluate(
            `import("/store.js").then(({ openSheet }) => { openSheet({ type: "cwd", mode: ${JSON.stringify(mode)} }); })`,
        );
        await until(
            () =>
                evaluate<boolean>(
                    `Boolean(document.querySelector(".sheet.folder-sheet .fp-places .fp-place"))`,
                ),
            "the folder picker",
        );
        // The sheet's opening animation (a scale) done: until then its box is not its size.
        await until(
            () =>
                evaluate<boolean>(
                    `document.querySelector(".sheet.folder-sheet").getAnimations().every((each) => each.playState !== "running")`,
                ),
            "the sheet at rest",
        );
    };

    return {
        evaluate,
        resize,
        box,
        openPicker,
        sheet: () =>
            evaluate<Json>(
                `import("/store.js").then(({ store }) => store.state.sheet && { type: store.state.sheet.type, mode: store.state.sheet.mode, view: store.state.sheet.view })`,
            ),
        close: () => connection.send("Target.disposeBrowserContext", context),
    };
}

/** The visible texts of the direct parts of `selector`, in their order. */
const partsOf = (selector: string) =>
    `[...document.querySelector(${JSON.stringify(selector)}).children].map((each) => each.textContent.trim())`;

before(async () => {
    if (executable === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.addRunner("Laptop", owner(app).id, newIdentity().publicKey);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await Chromium.launch(
        executable,
        profileFolder(executable, mkdtempSync(join(root, "folder-picker-ui-"))),
        [],
    );
});

after(async () => {
    browser?.kill();
    await browser?.exited;
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("Runs on is pinned under the places, and the links are in the bottom row", real, async () => {
    const page = await openPage(1280, 1000);

    try {
        await page.openPicker("new");

        // 1. Runs on: in the left column, not among the places, with this server and the linked computer.
        assert.equal(
            await page.evaluate<boolean>(`Boolean(document.querySelector(".fp-side > .fp-runs"))`),
            true,
            "Runs on is in the left column",
        );
        assert.equal(
            await page.evaluate<boolean>(`Boolean(document.querySelector(".fp-places .fp-runs"))`),
            false,
            "Runs on is not among the places",
        );
        assert.deepEqual(await page.evaluate<string[]>(partsOf(".fp-runs")), [
            "Runs on",
            "This server",
            "Laptop",
        ]);

        // 2. The places hold no Runs on and no link.
        assert.equal(
            await page.evaluate<boolean>(
                `document.querySelector(".fp-places").textContent.includes("Runs on")`,
            ),
            false,
            "no Runs on among the places",
        );
        assert.equal(
            await page.evaluate<number>(`document.querySelectorAll(".fp-places .fp-link").length`),
            0,
            "no link among the places",
        );

        // 3. The bottom row: the check boxes, then the links.
        assert.deepEqual(await page.evaluate<string[]>(partsOf(".fp-options")), [
            "Own git worktree",
            "Show hidden",
            "Manage runners…",
            "Continue a Pi session…",
        ]);

        // 4. As tall as the screen allows, up to 800 px; Runs on between the places and the column's foot.
        assert.ok(
            Math.abs((await page.box(".sheet.folder-sheet"))!.height - 800) <= 1,
            "800 px high on a 1000 px screen",
        );

        const places = (await page.box(".fp-places"))!;
        const runs = (await page.box(".fp-runs"))!;
        const side = (await page.box(".fp-side"))!;

        assert.ok(runs.top >= places.bottom - 0.5, "Runs on starts under the places");
        assert.ok(runs.bottom <= side.bottom + 0.5, "Runs on ends inside the left column");

        await page.resize(1280, 700);
        await until(
            async () => Math.abs((await page.box(".sheet.folder-sheet"))!.height - 602) <= 1,
            "602 px high on a 700 px screen (86dvh)",
        );

        // 6. Manage runners… opens Access, By computer.
        await page.evaluate(
            `[...document.querySelectorAll(".fp-options .fp-link")].find((each) => each.textContent.trim() === "Manage runners…").click()`,
        );
        await until(async () => {
            const sheet = (await page.sheet()) as { type?: string; view?: string } | null;

            return sheet?.type === "access" && sheet.view === "computer";
        }, "the Access sheet, By computer");
    } finally {
        await page.close();
    }
});

test("Runs on stays where it is while the places scroll", real, async () => {
    // More favorites than a low screen's left column shows.
    for (let index = 0; index < 24; index += 1) {
        await app.folderFavorites.set(owner(app), {
            path: `/tmp/folder-picker-favorite-${index}`,
            starred: true,
        });
    }

    const page = await openPage(1280, 420);

    try {
        await page.openPicker("new");
        await until(
            () =>
                page.evaluate<boolean>(
                    `(() => { const places = document.querySelector(".fp-places"); return places.scrollHeight > places.clientHeight; })()`,
                ),
            "the places overflow",
        );

        const was = (await page.box(".fp-runs"))!;

        await page.evaluate(
            `(() => { const places = document.querySelector(".fp-places"); places.scrollTop = places.scrollHeight; })()`,
        );
        await until(
            () =>
                page.evaluate<boolean>(
                    `(() => { const places = document.querySelector(".fp-places"); return places.scrollTop > 0 && places.scrollTop + places.clientHeight >= places.scrollHeight - 1; })()`,
                ),
            "the places scrolled to their end",
        );

        const now = (await page.box(".fp-runs"))!;

        assert.equal(now.top, was.top, "Runs on did not move");

        const shown = await page.evaluate<Box>(`(() => {
            const button = [...document.querySelectorAll(".fp-runs .fp-place")].find((each) => each.textContent.trim() === "This server");
            const { top, bottom, left, right, height } = button.getBoundingClientRect();
            return { top, bottom, left, right, height };
        })()`);
        const side = (await page.box(".fp-side"))!;

        assert.ok(
            shown.top >= now.top - 0.5 && shown.bottom <= side.bottom + 0.5,
            "This server is still in view",
        );
    } finally {
        await page.close();

        for (let index = 0; index < 24; index += 1) {
            await app.folderFavorites.set(owner(app), {
                path: `/tmp/folder-picker-favorite-${index}`,
                starred: false,
            });
        }
    }
});

test("moving a session: no Runs on, no links, no worktree", real, async () => {
    const id = await newSession(app);
    const page = await openPage(1280, 900);

    try {
        await page.evaluate(`import("/store.js").then(({ navigate }) => navigate(${Number(id)}))`);
        await until(
            () =>
                page.evaluate<boolean>(
                    `import("/store.js").then(({ store }) => store.state.view.conversation?.id === ${Number(id)})`,
                ),
            "the session open",
        );
        await page.openPicker("change");

        // 7.
        assert.equal(
            await page.evaluate<number>(`document.querySelectorAll(".fp-runs").length`),
            0,
        );
        assert.equal(
            await page.evaluate<number>(`document.querySelectorAll(".fp-link").length`),
            0,
        );
        assert.deepEqual(await page.evaluate<string[]>(partsOf(".fp-options")), ["Show hidden"]);
    } finally {
        await page.close();
    }
});

test(
    "on a phone, nothing is wider than the screen, and Cancel and Open have a row of their own",
    real,
    async () => {
        const page = await openPage(390, 844, true);

        try {
            await page.openPicker("new");

            // 8.
            const width = await page.evaluate<number>("innerWidth");

            assert.ok(
                (await page.evaluate<number>("document.documentElement.scrollWidth")) <= width,
                "the page does not scroll sideways",
            );

            const past = await page.evaluate<string[]>(
                `[...document.querySelectorAll(".fp-foot *")].filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5).map((each) => each.className || each.tagName)`,
            );

            assert.deepEqual(past, [], "nothing in the bottom ends past the screen");

            const options = (await page.box(".fp-options"))!;
            const buttons = (await page.box(".fp-buttons"))!;

            assert.ok(buttons.top >= options.bottom - 0.5, "Cancel and Open are under the options");
            assert.deepEqual(await page.evaluate<string[]>(partsOf(".fp-buttons")), [
                "Cancel",
                "Open",
            ]);
        } finally {
            await page.close();
        }
    },
);
