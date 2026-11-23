// The folder picker in a real browser: a folder read before shows at once while a slow server answers, the folders
// likely opened next are read ahead, a thousand folders all show and keep the keys, and sign-out drops what was kept.
import { cleanUp, openApp, root, scriptedModel, until, work, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const tree = join(work, "picker-tree");
const big = join(tree, "big");

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) =>
    until(async () => await inPage<boolean>(script), what);

/** The paths of the rows the picker shows. */
const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".fp-row")].map((row) => row.dataset.path))`,
    );

/** Open the picker in `folder` (a session's copy-sheet pick opens where it is told). */
const openPicker = (folder: string) =>
    page.evaluate(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "cwd", mode: "pick", start: ${JSON.stringify(folder)} });
    `);

/** Wait until no folder is being read, nor waits to be read ahead. */
const idle = () =>
    see(
        `const { folderListings } = await import("/folder-listings.js");
        const { waiting, reading } = folderListings.size;

        return JSON.stringify(waiting === 0 && reading === 0);`,
        "no folder reads on their way",
    );

/** A cached listing of each of `paths`, for this server, hidden folders not shown. */
const cachedAll = (paths: string[]) =>
    inPage<boolean>(`
        const { folderListings } = await import("/folder-listings.js");

        return JSON.stringify(${JSON.stringify(paths)}.every((path) => folderListings.cached(null, path, false)));
    `);

const closePicker = async () => {
    await page.evaluate(`window.__delay = 0`);
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
    await see(
        `return JSON.stringify(document.querySelector(".folder-sheet") === null)`,
        "the picker closed",
    );
};

before(async () => {
    if (real.skip) {
        return;
    }

    for (const name of ["alpha", "beta", "gamma"]) {
        mkdirSync(join(tree, name, "inner"), { recursive: true });
    }

    for (let i = 0; i < 1000; i++) {
        mkdirSync(join(big, `dir-${String(i).padStart(4, "0")}`), { recursive: true });
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "picker-cache-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
    // Every folder listing this page asks for, and a delay the test can set for them.
    await page.evaluate(`
        const real = window.fetch;

        window.__listings = [];
        window.__delay = 0;
        window.fetch = async function (input, init) {
            const url = String(input);

            if (url.includes("/api/fs?")) {
                window.__listings.push(decodeURIComponent(url.replace(/^.*[?&]path=([^&]*).*$/, "$1")));
                await new Promise((resolve) => setTimeout(resolve, window.__delay));
            }

            return real.call(this, input, init);
        };
    `);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a folder opened before shows at once while the server is slow, and the fresh read follows",
    real,
    async () => {
        await openPicker(tree);
        await see(
            `return JSON.stringify(document.querySelectorAll(".fp-row").length === 4)`,
            "the tree's folders",
        );
        await closePicker();

        // A slow server: the picker shows what it read before, with no "Opening…" between.
        await page.evaluate(`window.__delay = 3000; window.__listings = []`);
        await openPicker(tree);

        const shown = await inPage<{ rows: number; opening: boolean }>(`
        await new Promise((resolve) => requestAnimationFrame(resolve));

        return JSON.stringify({
            rows: document.querySelectorAll(".fp-row").length,
            opening: [...document.querySelectorAll(".fp-note")].some((note) => /Opening/.test(note.textContent)),
        });
    `);

        assert.deepEqual(shown, { rows: 4, opening: false });
        assert.ok(
            (await inPage<string[]>(`return JSON.stringify(window.__listings)`)).includes(tree),
            "a fresh read of the folder went out",
        );
        await page.evaluate(`window.__delay = 0`);
        await closePicker();
    },
);

test(
    "the folders likely opened next are read ahead, and then open with no wait",
    real,
    async () => {
        // A new page: nothing kept yet, and nothing read for this folder.
        await page.evaluate(`(await import("/folder-listings.js")).folderListings.clear()`);
        await openPicker(tree);
        await see(
            `return JSON.stringify(document.querySelectorAll(".fp-row").length === 4)`,
            "the tree's folders",
        );
        // Its parent and its first folders.
        await idle();
        assert.equal(
            await cachedAll([work, join(tree, "alpha"), join(tree, "beta"), join(tree, "big")]),
            true,
            "the parent and the first folders read ahead",
        );

        // Going into one shows its folders in the same frame, while the server takes its time.
        await page.evaluate(`window.__delay = 3000`);

        const inner = await inPage<string[]>(`
        const row = document.querySelector(${JSON.stringify(`.fp-row[data-path="${join(tree, "alpha")}"]`)});

        row.click();
        row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));

        return JSON.stringify([...document.querySelectorAll(".fp-row")].map((each) => each.dataset.path));
    `);

        assert.deepEqual(inner, [join(tree, "alpha", "inner")]);
        await page.evaluate(`window.__delay = 0`);
        await closePicker();
    },
);

test(
    "a thousand folders all show, a few at a time, and the keys still walk them",
    real,
    async () => {
        await openPicker(big);
        await see(
            `return JSON.stringify(document.querySelectorAll(".fp-row").length === 1000)`,
            "all the folders",
        );

        const shown = await rows();

        assert.equal(shown[0], join(big, "dir-0000"));
        assert.equal(shown[999], join(big, "dir-0999"));

        // End selects the last; a selection change redraws two rows, not the list.
        await page.evaluate(`document.querySelector(".fp-list").focus()`);
        await page.press("End");
        await see(
            `return JSON.stringify(document.querySelector(".fp-row.on")?.dataset.path === ${JSON.stringify(join(big, "dir-0999"))})`,
            "the last folder selected",
        );
        await page.press("Home");
        await see(
            `return JSON.stringify(document.querySelectorAll(".fp-row.on").length === 1 &&
            document.querySelector(".fp-row.on").dataset.path === ${JSON.stringify(join(big, "dir-0000"))})`,
            "the first folder selected, alone",
        );
        await closePicker();
    },
);

test("sign-out drops every listing kept", real, async () => {
    const kept = await inPage<boolean>(`
        const { folderListings } = await import("/folder-listings.js");

        return JSON.stringify(folderListings.cached(null, ${JSON.stringify(tree)}, false) !== undefined);
    `);

    assert.equal(kept, true);

    const after = await inPage<number>(`
        const { folderListings } = await import("/folder-listings.js");

        dispatchEvent(new Event("pocket:signedOut"));

        return JSON.stringify(folderListings.size.kept);
    `);

    assert.equal(after, 0);
});
