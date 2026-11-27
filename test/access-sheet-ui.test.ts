// The Access sheet in a real browser (`web/sheets/access-sheet.js`, `web/sheets/access-grid.js`): one sheet, opened at
// the right view from each opener; Computer only for who may have it; its grid of 8 people, whose head and rows
// scroll sideways together, on a phone and on a desktop; the key in one row; a menu on the last row that opens upward
// inside the sheet; the "i" buttons, centred and 14 px; and Settings, which holds a computer's approvals.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    addPerson,
    answerRequests,
    type App,
    cleanUp,
    home,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = VIEWPORTS.desktop;
const PHONE = VIEWPORTS.mobile;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let viewerToken = "";
let people: User[] = [];
const projects = join(root, "projects");
/** This machine's home folder, as the server says it while no test sets another. */
const realHome = homedir();
const shop = join(projects, "shop");

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        stdio: "ignore",
    });
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    // This server's check of git and GitHub answers at once, and runs no program.
    app = await openApp(scriptedModel(), undefined, undefined, undefined, async () => ({
        git: true,
        gh: true,
        github: false,
    }));

    // Three projects, one with two worktrees, each with sessions; eight people chosen for this server.
    for (const name of ["shop", "docs", "tools"]) {
        mkdirSync(join(projects, name), { recursive: true });
        git(join(projects, name), "init", "-q", "-b", "main");
        git(join(projects, name), "commit", "-q", "--allow-empty", "-m", "start");
    }

    for (const branch of ["one", "two"]) {
        git(shop, "worktree", "add", "-q", "-b", branch, join(root, "trees", `shop-${branch}`));
    }

    for (const cwd of [
        shop,
        shop,
        join(root, "trees", "shop-one"),
        join(root, "trees", "shop-two"),
        join(projects, "docs"),
        join(projects, "tools"),
    ]) {
        await newSession(app, cwd);
    }

    const roles = [
        "guest",
        "viewer",
        "guest",
        "viewer",
        "guest",
        "viewer",
        "guest",
        "viewer",
    ] as const;
    const added = await Promise.all(
        roles.map((role, index) => addPerson(app, `Person ${index + 1}`, role)),
    );

    people = added.map((each) => each.user);
    viewerToken = added[1]!.token;
    app.config.addRunner("Laptop", owner(app).id, newIdentity().publicKey);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "access-sheet-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** Load the app at `viewport`, with no sheet open. */
async function load(viewport: Viewport = DESKTOP): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('[data-part="app"]') !== null)`,
            ),
        "the app",
        20_000,
    );
}

/** The sheet open now: its type and its view, as the store and the sheet's head say. */
const shown = () =>
    inPage<{ type: string | null; view: string | null }>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            type: store.state.sheet?.type ?? null,
            view: document.querySelector(".access-sheet .ac-views button.on")?.textContent.trim() ??
                (document.querySelector(".access-sheet") ? "one view" : null),
        });
    `);

/** Open the Access sheet at `view` from the store, and wait for its list. */
async function openAt(view: "person" | "computer" | "settings", computer?: string): Promise<void> {
    await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "access", view: ${JSON.stringify(view)}${computer ? `, computer: ${JSON.stringify(computer)}` : ""} });

        return JSON.stringify(true);
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".access-sheet .pages-item") !== null)`,
            ),
        `the Access sheet at ${view}`,
    );
}

/** Wait for This server's grid with its 8 people columns, and its projects. */
async function grid(): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelectorAll(".ag-head .ag-who").length === 8 && document.querySelector(".ag-group .ag-toggle")?.textContent.includes("shop") !== undefined)`,
            ),
        "the grid with 8 people",
    );
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".ag-group .ag-name")].some((each) => each.textContent.trim() === "shop"))`,
            ),
        "the projects in the grid",
    );
    // The sheet comes in with a small zoom: sizes and places are measured once it stands still.
    await inPage(`
        await Promise.all(document.getAnimations().map((each) => each.finished.catch(() => undefined)));

        return JSON.stringify(true);
    `);
}

test("the sheet opens from each opener at the right view", real, async () => {
    const openers: [string, string, string][] = [
        // [what is pressed, how, the view it opens]
        [
            "the rail's Access button",
            `document.querySelector('[data-part="rail-button"][aria-label="Access"]').click()`,
            "People",
        ],
        [
            "the rail's account button",
            `document.querySelector('[data-part="rail-button"][aria-label="Your account"]').click()`,
            "People",
        ],
        [
            "Menu → Access",
            `(async () => {
                const { openSheet } = await import("/store.js");
                openSheet({ type: "menu" });
                for (let i = 0; i < 50 && ![...document.querySelectorAll(".list-item")].some((each) => each.textContent.startsWith("Access")); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                [...document.querySelectorAll(".list-item")].find((each) => each.textContent.startsWith("Access")).click();
            })()`,
            "People",
        ],
        [
            "the launcher's Access",
            `(async () => {
                const { store } = await import("/store.js");
                store.set({ launcher: true });
                for (let i = 0; i < 50 && !document.querySelector(".launcher input"); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                const input = document.querySelector(".launcher input");
                input.value = "Access";
                input.dispatchEvent(new Event("input", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 200));
                [...document.querySelectorAll(".launcher-item")].find((each) => each.textContent.includes("Access")).click();
            })()`,
            "People",
        ],
        [
            "the folder picker's Manage computers…",
            `(async () => {
                const { openSheet } = await import("/store.js");
                openSheet({ type: "cwd", mode: "new" });
                for (let i = 0; i < 80 && ![...document.querySelectorAll(".fp-link")].some((each) => each.textContent.trim() === "Manage computers…"); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                [...document.querySelectorAll(".fp-link")].find((each) => each.textContent.trim() === "Manage computers…").click();
            })()`,
            "Computer",
        ],
    ];

    for (const [name, press, view] of openers) {
        await load();
        await page.evaluate(`await ${press}; return null;`);
        await until(async () => (await shown()).view === view, `${name} to open ${view}`);
        assert.equal((await shown()).type, "access", name);
    }
});

test("a viewer has People and Settings, and no Computer", real, async () => {
    const laptop = app.config.runners.find((each) => each.name === "Laptop")!.id;
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "access-sheet-viewer-")),
        load: async () => undefined,
        save: () => {},
    });
    const owners = page;

    try {
        // Chosen for the Laptop, so they are told of it: a viewer still asks nothing of what can be shared there
        // (`GET /api/runners/:id/sharing` refuses a viewer).
        await app.choosePerson(laptop, people[1]!.id, true);
        page = await theirs.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(viewerToken)}`);
        await load();
        await inPage(`
            const fetch = window.fetch.bind(window);
            window.sharingReads = [];
            window.fetch = (url, init) => {
                if (/^\\/api\\/runners\\/[^/]+\\/sharing$/.test(String(url))) window.sharingReads.push(String(url));
                return fetch(url, init);
            };
            return JSON.stringify(true);
        `);
        await openAt("computer");
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".access-sheet .ac-views button")].map((each) => each.textContent.trim()))`,
            ),
            ["People", "Settings"],
        );
        assert.equal((await shown()).view, "People", "Computer asked for: People shown");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".ag-scroll") !== null)`,
            ),
            false,
        );
        assert.equal(
            await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.runners.some((each) => each.name === "Laptop"));
            `),
            true,
            "the viewer is told of the Laptop",
        );
        // The refresh after the list of computers is in runs at once, and again a second after a change.
        await new Promise((done) => setTimeout(done, 1500));
        assert.deepEqual(
            await inPage<string[]>(`return JSON.stringify(window.sharingReads)`),
            [],
            "no sharing read by a viewer",
        );
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
        await app.choosePerson(laptop, people[1]!.id, false);
    }
});

/** The titles of the Settings list, and the title of the page shown beside it. */
const settingsShown = () =>
    inPage<{ list: string[]; page: string | null }>(`
        return JSON.stringify({
            list: [...document.querySelectorAll(".access-sheet .pages-item-title")].map((each) => each.textContent.trim()),
            page: document.querySelector(".access-sheet .pages-detail .sheet-page-title")?.textContent.trim() ?? null,
        });
    `);

/** Open the Access sheet at Settings, asking for `page`, and wait for a page beside the list. */
async function openSettings(page_?: string): Promise<void> {
    await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "access", view: "settings"${page_ ? `, page: ${JSON.stringify(page_)}` : ""} });

        return JSON.stringify(true);
    `);
    await until(
        async () => (await settingsShown()).page !== null,
        `Settings at ${page_ ?? "its first page"}`,
    );
}

test(
    "Settings lists Settings for everyone only for who manages Pi Pocket, Notifications for everyone, and a page asked for only when it is theirs",
    real,
    async () => {
        // The owner: both, and Settings first; a page asked for opens, also while the sheet is open.
        await load();
        await openSettings();
        assert.deepEqual((await settingsShown()).list.slice(0, 2), ["Settings", "Notifications"]);
        assert.equal((await settingsShown()).page, "Settings");
        assert.ok(!(await settingsShown()).list.includes("Your settings"));
        await openSettings("notifications");
        await until(
            async () => (await settingsShown()).page === "Notifications",
            "Notifications, asked while open",
        );
        await openSettings("settings");
        await until(
            async () => (await settingsShown()).page === "Settings",
            "Settings, asked while open",
        );

        // A viewer: Notifications, no Settings; Settings asked for falls back to Notifications.
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "access-sheet-settings-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;

        try {
            page = await theirs.open(1);
            await page.navigate(`${base}/login?token=${encodeURIComponent(viewerToken)}`);
            await load();
            await openSettings("settings");

            const shown_ = await settingsShown();

            assert.ok(shown_.list.includes("Notifications"), JSON.stringify(shown_.list));
            assert.ok(!shown_.list.includes("Settings"), JSON.stringify(shown_.list));
            assert.ok(!shown_.list.includes("Your settings"), JSON.stringify(shown_.list));
            assert.equal(shown_.page, "Notifications", "Settings is not theirs");
        } finally {
            page = owners;
            await theirs.closeAll({ final: true });
        }
    },
);

test(
    "Notifications is no row of the menu; the launcher's opens it in Access → Settings",
    real,
    async () => {
        await load();
        await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "menu" });

        return JSON.stringify(true);
    `);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".list-item")].some((each) => each.textContent.startsWith("Access")))`,
                ),
            "the menu",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".list-item")].map((each) => each.textContent.trim()).filter((each) => each.startsWith("Notifications")))`,
            ),
            [],
        );

        await load();
        await page.evaluate(`
        const { store } = await import("/store.js");
        store.set({ launcher: true });
        for (let i = 0; i < 50 && !document.querySelector(".launcher input"); i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const input = document.querySelector(".launcher input");
        input.value = "Notifications";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        [...document.querySelectorAll(".launcher-item")].find((each) => each.textContent.includes("Notifications")).click();
        return null;
    `);
        await until(async () => (await shown()).view === "Settings", "Access at Settings");
        await until(
            async () => (await settingsShown()).page === "Notifications",
            "the Notifications page",
        );
        assert.equal((await shown()).type, "access");
    },
);

/**
 * Scrolled sideways by `by` pixels, each person column's left edge in the head and in each row: the same in every
 * row, so a row never shows other people than the head.
 */
const columnsAt = (by: number) =>
    inPage<{ head: number[]; rows: number[][]; scrolled: number; more: boolean }>(`
        const scroller = document.querySelector(".ag-scroll");

        scroller.scrollLeft = ${by};
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const lefts = (row) => [...row.querySelectorAll(":scope > .ag-cell")].map((each) => Math.round(each.getBoundingClientRect().left));

        return JSON.stringify({
            head: lefts(document.querySelector(".ag-head")),
            rows: [...document.querySelectorAll(".ag-row.ag-group")].map(lefts),
            scrolled: scroller.scrollLeft,
            more: document.querySelector(".ag-wrap").classList.contains("more"),
        });
    `);

for (const [name, viewport] of [
    ["1280 px", DESKTOP],
    ["390 px", PHONE],
] as const) {
    test(
        `the grid of 8 people keeps its head and its rows together while scrolled sideways, at ${name}`,
        real,
        async () => {
            await load(viewport);
            await openAt("computer", THIS_SERVER);
            await grid();

            const start = await columnsAt(0);
            const moved = await columnsAt(240);

            assert.ok(start.more, "the fade says there is more");
            assert.ok(moved.scrolled > 0, "it scrolls sideways");
            assert.equal(start.head.length, 8);

            // The list on the left and the People filter count the same people: those with a column.
            assert.deepEqual(
                await inPage<[string, string]>(`
                const item = [...document.querySelectorAll(".pages-list .pages-item")].find(
                    (each) => each.querySelector(".pages-item-title")?.textContent.trim() === "This server",
                );

                return JSON.stringify([
                    item.querySelector(".pages-item-text .muted").textContent.trim(),
                    document.querySelector(".ak-people").textContent.trim(),
                ]);
            `),
                ["Online · 8 people", "8 people"],
            );

            for (const row of [...start.rows, ...moved.rows]) {
                assert.equal(row.length, 8);
            }

            for (const each of start.rows) {
                assert.deepEqual(each, start.head, "every row under the head");
            }

            for (const each of moved.rows) {
                assert.deepEqual(each, moved.head, "every row under the head, scrolled");
            }

            assert.ok(moved.head[0]! < start.head[0]!, "the people moved");

            // The first column stays where it was.
            const first = await inPage<number[]>(`
            const scroller = document.querySelector(".ag-scroll");
            const at = () => Math.round(document.querySelector(".ag-head .ag-first").getBoundingClientRect().left);
            const before = at();

            scroller.scrollLeft = 200;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            return JSON.stringify([before, at()]);
        `);

            assert.equal(first[0], first[1], "the first column is sticky");

            // Project trust is a column like a person's: it scrolls sideways with the people, and leaves them its
            // width. On a phone it is a line of its own under the row's name, and stays there.
            const trust = await inPage<[number, number, number]>(`
            const scroller = document.querySelector(".ag-scroll");
            const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const at = () => Math.round(document.querySelector(".ag-group .ag-trust-cell").getBoundingClientRect().left);

            scroller.scrollLeft = 0;
            await frame();

            const before = at();

            scroller.scrollLeft = 200;
            await frame();

            return JSON.stringify([before, at(), Math.round(scroller.scrollLeft)]);
        `);

            assert.equal(trust[2], 200);
            assert.equal(
                trust[0] - trust[1],
                viewport === DESKTOP ? 200 : 0,
                "Project trust scrolls with the people on a desktop, and stays on a phone",
            );

            // The key is five cells, in one row on a desktop and rows of two on a phone, the last alone: no level is
            // cut, the key does not scroll sideways, and nothing but what scrolls sideways is wider than the screen.
            const layout = await inPage<{
                key: string[];
                keyRows: number[];
                keyCut: string[];
                wider: string[];
            }>(`
            const key = document.querySelector(".ak-key");
            const cells = [...key.querySelectorAll(".ak-item")];
            const box = key.getBoundingClientRect();
            const tops = [...new Set(cells.map((each) => Math.round(each.getBoundingClientRect().top)))];
            const scrolls = (element) => {
                for (let box = element.parentElement; box && !box.classList.contains("sheet"); box = box.parentElement) {
                    if (["auto", "scroll"].includes(getComputedStyle(box).overflowX) && box.scrollWidth > box.clientWidth) {
                        return true;
                    }
                }

                return false;
            };

            return JSON.stringify({
                key: cells.map((each) => each.querySelector("dt").textContent + ": " + each.querySelector("dd").textContent),
                keyRows: tops.map((top) => cells.filter((each) => Math.round(each.getBoundingClientRect().top) === top).length),
                keyCut: [key, ...cells, ...key.querySelectorAll("dt, dd")]
                    .filter((each) => {
                        const at = each.getBoundingClientRect();

                        return each.scrollWidth > each.clientWidth || at.right > box.right + 0.5 || at.bottom > box.bottom + 0.5;
                    })
                    .map((each) => each.className || each.tagName),
                wider: [...document.querySelectorAll(".sheet *")]
                    .filter((each) => each.offsetParent !== null && !scrolls(each))
                    .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5)
                    .map((each) => each.className || each.tagName),
            });
        `);

            assert.deepEqual(layout.key, [
                "None: only sessions shared one by one",
                "Start: starts sessions, sees their own",
                "Current: also every session here now",
                "New: also every session started from now on",
                "All: also every session, now and later",
            ]);
            assert.deepEqual(
                layout.keyRows,
                viewport === DESKTOP ? [5] : [2, 2, 1],
                "the key's rows",
            );
            assert.deepEqual(layout.keyCut, [], "no level of the key is cut");
            assert.deepEqual(layout.wider, []);

            // At 1280 px, the grid is the one thing that scrolls up and down: no second scrollbar beside the sheet's.
            if (viewport === DESKTOP) {
                const scrolls = await inPage<string[]>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".access-sheet, .access-sheet *")]
                        .filter((each) => ["auto", "scroll"].includes(getComputedStyle(each).overflowY) && each.scrollHeight > each.clientHeight + 1)
                        .map((each) => each.className),
                );
            `);

                assert.deepEqual(
                    scrolls.filter((each) => !each.includes("pages-list")),
                    ["ag-scroll with-trust"],
                );
            }
        },
    );
}

test("the menu on the last row opens upward and stays inside the sheet", real, async () => {
    await load(DESKTOP);
    await openAt("computer", THIS_SERVER);
    await grid();

    const placed = await inPage<{
        up: boolean;
        inside: boolean;
        sheet: [number, number];
        menu: [number, number];
    }>(`
        // The last row of folders, at the grid's bottom edge, and its first Access menu that can be changed.
        const rows = [...document.querySelectorAll(".ag-row.ag-group")];

        rows.at(-1).scrollIntoView({ block: "end" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const last = rows.at(-1).querySelector(".ag-cell .at-level:not([disabled])");

        last.click();
        await new Promise((resolve) => setTimeout(resolve, 150));

        const menu = document.querySelector(".at-level-menu").getBoundingClientRect();
        const button = last.getBoundingClientRect();
        const sheet = document.querySelector(".sheet").getBoundingClientRect();

        return JSON.stringify({
            up: menu.bottom <= button.top + 1,
            inside: menu.top >= sheet.top && menu.bottom <= sheet.bottom && menu.left >= sheet.left && menu.right <= sheet.right,
            sheet: [sheet.top, sheet.bottom],
            menu: [menu.top, menu.bottom],
        });
    `);

    assert.ok(placed.up, `it opens upward: ${JSON.stringify(placed)}`);
    assert.ok(placed.inside, `inside the sheet: ${JSON.stringify(placed)}`);
    await page.press("Escape");
});

for (const [name, viewport] of [
    ["1280 px", DESKTOP],
    ["390 px", PHONE],
] as const) {
    test(
        `each "i" is a 14 px SVG centred in its button, and no person's column head has one, at ${name}`,
        real,
        async () => {
            await load(viewport);
            await openAt("computer", THIS_SERVER);
            await grid();

            const tips = await inPage<
                { about: string; size: [number, number]; off: [number, number]; inHead: boolean }[]
            >(`
            return JSON.stringify(
                [...document.querySelectorAll(".pages-detail .info-tip")].map((each) => {
                    const button = each.getBoundingClientRect();
                    const glyph = each.querySelector("svg").getBoundingClientRect();

                    return {
                        about: each.getAttribute("aria-label"),
                        size: [glyph.width, glyph.height],
                        off: [
                            Math.abs(glyph.left + glyph.width / 2 - (button.left + button.width / 2)),
                            Math.abs(glyph.top + glyph.height / 2 - (button.top + button.height / 2)),
                        ],
                        inHead: each.closest(".ag-who") !== null,
                    };
                }),
            );
        `);

            assert.deepEqual(
                tips.map((each) => each.about).sort(),
                ["About Project trust", "About projects", "About the people columns"],
                "3 at any number of people",
            );

            for (const tip of tips) {
                assert.ok(
                    Math.abs(tip.size[0] - 14) <= 0.01 && Math.abs(tip.size[1] - 14) <= 0.01,
                    `${tip.about}: ${JSON.stringify(tip.size)}`,
                );
                assert.ok(
                    tip.off[0] <= 0.5 && tip.off[1] <= 0.5,
                    `${tip.about}: ${JSON.stringify(tip.off)}`,
                );
                assert.equal(tip.inHead, false, tip.about);
            }

            // A person's head: the face, the name, the role.
            assert.deepEqual(
                await inPage<string[]>(`
                const head = document.querySelector(".ag-head .ag-who");

                return JSON.stringify([head.querySelector(".ag-who-name").textContent.trim(), head.querySelector(".ag-who-role").textContent.trim()]);
            `),
                [people[0]!.name, "User"],
            );

            // Grouped by projects, the first column is headed "By project", and the folders in no project follow
            // under "By folders".
            assert.deepEqual(
                await inPage<{
                    head: string;
                    headings: string[];
                    before: string[];
                    after: string[];
                }>(`
                const rows = [...document.querySelectorAll(".ag-table > .ag-row:not(.ag-head)")];
                const at = rows.findIndex((each) => each.classList.contains("ag-heading"));
                const names = (list) => list.filter((each) => each.classList.contains("ag-group")).map((each) => each.querySelector(".ag-name").textContent.trim());

                return JSON.stringify({
                    head: document.querySelector(".ag-first-head > span").textContent.trim(),
                    headings: rows.filter((each) => each.classList.contains("ag-heading")).map((each) => each.textContent.trim()),
                    before: names(rows.slice(0, at)),
                    after: names(rows.slice(at)),
                });
            `),
                {
                    head: "By project",
                    headings: ["By folders"],
                    before: ["docs", "shop", "tools"],
                    // Home, and the test folder every person here is given (`addPerson`).
                    after: ["Home", root],
                },
            );

            // The person's Computers tab has no key or tree. The same project groupings and tips are one jump away.
            await openAt("person");
            // The list of the view before may still show for a moment: wait for the person's row.
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify([...document.querySelectorAll(".pages-item-title")].some((each) => each.textContent.trim() === ${JSON.stringify(people[0]!.name)}))`,
                    ),
                "their row",
            );
            await inPage(`
            [...document.querySelectorAll(".pages-item")]
                .find((each) => each.querySelector(".pages-item-title")?.textContent.trim() === ${JSON.stringify(people[0]!.name)})
                .click();

            return JSON.stringify(true);
        `);
            await until(
                () =>
                    inPage<boolean>(`
                return JSON.stringify(Boolean(document.querySelector(
                    '.pages-detail [data-part="person-computer"][data-computer="this-server"]',
                )));
            `),
                "their This server row",
            );
            assert.equal(
                await inPage<boolean>(`
                return JSON.stringify(Boolean(document.querySelector(".pages-detail .at-tree, .pages-detail .ak-key")));
            `),
                false,
            );
            await inPage(`
                document.querySelector('.pages-detail [data-part="person-computer"][data-computer="this-server"]').click();
                return JSON.stringify(true);
            `);
            await until(
                async () => (await gridNames()).join() === people[0]!.name,
                "just their column",
            );
            await until(
                () =>
                    inPage<boolean>(`
                return JSON.stringify(document.querySelector(".ag-first-head > span")?.textContent.trim() === "By project");
            `),
                "their projects known",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                const children = [...document.querySelectorAll(".ag-table > .ag-row:not(.ag-head)")];
                return JSON.stringify([document.querySelector(".ag-first-head > span").textContent.trim(),
                    ...children.map((row) => row.classList.contains("ag-heading") ? row.textContent.trim() : "row")]);
            `),
                ["By project", "row", "row", "row", "By folders", "row", "row", "row"],
            );
            assert.deepEqual(
                await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".pages-detail .info-tip")].map((tip) => tip.getAttribute("aria-label")).sort());
            `),
                ["About Project trust", "About projects", "About the people columns"],
            );
        },
    );
}

test(
    "the trust explanation opens on hover at a wide screen, and Escape closes it",
    real,
    async () => {
        await load(DESKTOP);
        await openAt("computer", THIS_SERVER);
        await grid();
        await page.hover({ selector: '.ag-head [aria-label="About Project trust"]' });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".info-note")?.textContent.includes("A trusted folder loads its own skills") === true)`,
                ),
            "the explanation",
        );
        await page.press("Escape");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".info-note") === null)`,
                ),
            "Escape to close it",
        );
    },
);

test(
    "a column head says the person's word: Admin for who manages users, User again once not",
    real,
    async () => {
        const heads = () =>
            inPage<Record<string, string>>(`
            return JSON.stringify(Object.fromEntries(
                [...document.querySelectorAll(".ag-head .ag-who")].map((each) => [
                    each.querySelector(".ag-who-name").textContent.trim(),
                    each.querySelector(".ag-who-role").textContent.trim(),
                ]),
            ));
        `);
        const gil = people[2]!;

        await load(DESKTOP);
        await openAt("computer", THIS_SERVER);
        await grid();
        assert.equal((await heads())[gil.name], "User");
        assert.equal((await heads())[people[1]!.name], "Viewer");

        try {
            app.setRight(owner(app), { person: gil.id, right: "managesUsers", on: true });
            await until(async () => (await heads())[gil.name] === "Admin", "Admin in the open tab");
        } finally {
            app.setRight(owner(app), { person: gil.id, right: "managesUsers", on: false });
            app.setRight(owner(app), { person: gil.id, right: "invites", on: false });
        }

        await until(async () => (await heads())[gil.name] === "User", "User again");
    },
);

for (const [name, viewport] of [
    ["1280 px", DESKTOP],
    ["390 px", PHONE],
] as const) {
    test(
        `the Project trust menu is drawn over the rows under it: each choice is what a click at its place hits, at ${name}`,
        real,
        async () => {
            await load(viewport);
            await openAt("computer", THIS_SERVER);
            await grid();
            // A real click: a click by script would open the menu whatever is drawn over it.
            await page.click({ selector: ".ag-group .ag-trust-button" });
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelectorAll(".ag-trust-cell .at-level-menu [role=menuitemradio]").length === 3 && document.querySelector(".ag-trust-cell .at-level-menu").getAnimations().every((each) => each.playState === "finished"))`,
                    ),
                "the trust menu, open and still",
            );

            const hits = await inPage<[string, boolean][]>(`
                return JSON.stringify([...document.querySelectorAll(".ag-trust-cell .at-level-menu [role=menuitemradio]")].map((each) => {
                    const box = each.getBoundingClientRect();
                    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

                    return [each.querySelector(".at-level-name").textContent.trim(), each.contains(top)];
                }));
            `);

            assert.deepEqual(
                hits.map(([, onTop]) => onTop),
                [true, true, true],
                `every choice is on top: ${JSON.stringify(hits)}`,
            );
            await page.press("Escape");
        },
    );
}

for (const [name, viewport] of [
    ["1280 px", DESKTOP],
    ["390 px", PHONE],
] as const) {
    test(
        `the People filter's list is drawn over the grid under it: each person is what a click at their place hits, at ${name}`,
        real,
        async () => {
            await load(viewport);
            await openAt("computer", THIS_SERVER);
            await grid();
            // A real click: a click by script would open the list whatever is drawn over it.
            await page.click({ selector: ".ak-people" });
            await until(
                async () =>
                    await inPage<boolean>(`
                        const menu = document.querySelector(".ak-people-menu");

                        return JSON.stringify(
                            menu !== null &&
                                menu.querySelectorAll("[role=menuitemcheckbox]").length === 8 &&
                                getComputedStyle(menu).visibility === "visible" &&
                                menu.getAnimations().every((each) => each.playState === "finished"),
                        );
                    `),
                "the people list, open and still",
            );

            const hits = await inPage<[string, boolean, string][]>(`
                return JSON.stringify([...document.querySelectorAll(".ak-people-menu [role=menuitemcheckbox]")].map((each) => {
                    const box = each.getBoundingClientRect();
                    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

                    return [each.querySelector(".grow").textContent.trim(), each.contains(top), top?.className ?? "nothing"];
                }));
            `);

            assert.equal(hits.length, 8);
            assert.deepEqual(
                hits.filter(([, onTop]) => !onTop),
                [],
                `every person is on top: ${JSON.stringify(hits)}`,
            );
            await page.press("Escape");
        },
    );
}

test(
    "Settings on This server holds each person's approval time, not their sharing",
    real,
    async () => {
        await load(DESKTOP);
        await openAt("settings", THIS_SERVER);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-detail .group-title")].some((each) => each.textContent.trim() === "Tools on this computer"))`,
                ),
            "This server's settings, with its tools",
        );

        const page_ = await inPage<{
            list: string[];
            details: Record<string, string>;
            titles: string[];
            people: string[];
            notes: string[];
            rows: string[];
        }>(`
        return JSON.stringify({
            list: [...document.querySelectorAll(".pages-list .pages-item-title")].map((each) => each.textContent.trim()),
            details: Object.fromEntries([...document.querySelectorAll(".pages-list .pages-item")].map((each) => [
                each.querySelector(".pages-item-title")?.textContent.trim(),
                each.querySelector(".pages-item-text .muted")?.textContent.trim() ?? "",
            ])),
            notes: [...document.querySelectorAll(".pages-detail .approvals-note")].map((each) => each.textContent.trim()),
            rows: [...document.querySelectorAll(".pages-detail .setting")].filter((each) => each.querySelector("strong")).flatMap((each) => [...each.querySelectorAll(".muted.small")].map((line) => line.textContent.trim())),
            titles: [...document.querySelectorAll(".pages-detail .group-title")].map((each) => each.textContent.trim()),
            people: [...document.querySelectorAll(".pages-detail .setting strong")].map((each) => each.textContent.trim()),
        });
    `);

        assert.deepEqual(page_.list.slice(0, 2), ["Settings", "Notifications"]);
        assert.ok(
            page_.list.includes("This server") && page_.list.includes("Laptop"),
            "a page per computer",
        );
        assert.deepEqual(page_.titles, ["Approvals last", "Tools on this computer"]);
        // This server's row says what it is, not its name again; Linking limits says what it is for.
        assert.equal(page_.details["This server"], "Pi Pocket itself");
        assert.equal(page_.details["Linking limits"], "For runners");
        // What a time means, once under the heading; a person's row has only a viewer's line.
        assert.deepEqual(page_.notes, [
            "A session of theirs locks this long after they last used it. The same on every computer.",
        ]);
        assert.ok(
            page_.rows.every((each) => each === "A viewer reads only: nothing to approve."),
            JSON.stringify(page_.rows),
        );
        assert.deepEqual(
            page_.people,
            people.map((each) => each.name),
            "each person chosen here",
        );
        // A viewer's row says there is nothing to approve; a user's has the time.
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".pages-detail .setting select").length)`,
            ),
            4,
        );
    },
);

test(
    "Settings on This server has its downloads folder, changed in place, and its tools; no network switch or key",
    real,
    async () => {
        const folder = join(root, "server-downloads");

        /** A picture of the page once the sheet stands still, with its Downloads row and tools in sight. */
        const picture = async (file: string) => {
            await inPage(`
                await Promise.all(document.getAnimations().map((each) => each.finished.catch(() => undefined)));
                document.querySelector(".pages-detail .sheet-pane").scrollIntoView({ block: "center" });

                return JSON.stringify(true);
            `);
            writeFileSync(file, Buffer.from((await page.screenshot()).data, "base64"));
        };

        const row = () =>
            inPage<{ downloads: string; tools: string; switches: string[]; text: string }>(`
                const detail = document.querySelector(".pages-detail");
                const row = [...detail.querySelectorAll(".setting")].find((each) => each.querySelector(".grow > .small")?.textContent.trim() === "Downloads");
                const title = [...detail.querySelectorAll(".group-title")].find((each) => each.textContent.trim() === "Tools on this computer");

                return JSON.stringify({
                    downloads: row?.querySelector(".muted")?.textContent.trim() ?? "",
                    tools: title?.nextElementSibling?.textContent.replace(/\\s+/g, " ").trim() ?? "",
                    switches: [...detail.querySelectorAll("[role=switch]")].map((each) => each.getAttribute("aria-label")),
                    text: detail.textContent,
                });
            `);

        try {
            await load(DESKTOP);
            await openAt("settings", THIS_SERVER);
            await until(
                async () => (await row()).tools !== "",
                "This server's downloads and tools",
            );

            const before = await row();

            assert.equal(
                before.downloads,
                "Temporary folder, which can be cleared when the computer restarts",
            );
            assert.equal(before.tools, "git ✓ · GitHub: sign in with gh auth login");
            assert.match(before.text, /Browsers of its sessions use this server's own network\./);
            assert.deepEqual(before.switches, [], "no network switch");
            assert.doesNotMatch(before.text, /Plain HTTP|Key:|Unlink|Link again/);
            await picture("/tmp/server-settings-1280.png");

            // Change it through the page: the prompt is answered, and the new folder shows with no reload.
            await inPage(`
                window.asked = [];
                window.prompt = (text, value) => {
                    window.asked.push([text, value]);

                    return ${JSON.stringify(` ${folder} `)};
                };
                [...document.querySelectorAll(".pages-detail .setting")]
                    .find((each) => each.querySelector(".grow > .small")?.textContent.trim() === "Downloads")
                    .querySelector("button")
                    .click();

                return JSON.stringify(true);
            `);
            await until(async () => (await row()).downloads === folder, "the new folder, shown");
            assert.deepEqual(await inPage<string[][]>(`return JSON.stringify(window.asked)`), [
                ["Downloads folder on this server, absolute; empty for its temporary folder", ""],
            ]);
            assert.equal(app.config.serverDownloads, folder);

            await load(PHONE);
            await openAt("settings", THIS_SERVER);
            await until(async () => (await row()).tools !== "", "This server's page on a phone");
            await picture("/tmp/server-settings-390.png");
        } finally {
            app.config.setComputerSettings(THIS_SERVER, { downloads: null });
        }
    },
);

/** Use another person's own signed-in browser, then go back to the owner's. */
async function asPerson(token: string, run: () => Promise<void>) {
    const owners = page;
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "access-sheet-person-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        page = await theirs.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await load();
        await run();
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
    }
}

const viewNames = () =>
    inPage<string[]>(`
    return JSON.stringify([...document.querySelectorAll(".access-sheet .ac-views button")].map((each) => each.textContent.trim()));
`);

const gridNames = () =>
    inPage<string[]>(`
    return JSON.stringify([...document.querySelectorAll(".ag-head .ag-who-name")].map((each) => each.textContent.trim()));
`);

const partText = (part: string) =>
    inPage<string | null>(`
    return JSON.stringify(document.querySelector(${JSON.stringify(`[data-part="${part}"]`)})?.textContent.replace(/\\s+/g, " ").trim() ?? null);
`);

const pressSharingCell = (label: string) =>
    inPage(`
    document.querySelector(${JSON.stringify(`.ag-table button[aria-label=${JSON.stringify(label)}]`)}).click();
    return JSON.stringify(true);
`);

const hasGrid = () =>
    inPage<boolean>(`return JSON.stringify(Boolean(document.querySelector(".ag-table")));`);

test("a user who cannot link has Computer exactly when they have a computer", real, async () => {
    const person = app.config.addUser("Starter", "guest");

    try {
        await asPerson(person.token, async () => {
            await openAt("person");
            assert.deepEqual(await viewNames(), ["People", "Settings"]);
            await app.choosePerson(THIS_SERVER, person.user.id, true);
            await until(async () => (await viewNames()).length === 3, "the Computer view");
            assert.deepEqual(await viewNames(), ["People", "Computer", "Settings"]);
            await openAt("computer", THIS_SERVER);
            await until(
                async () => (await partText("nothing-to-share")) !== null,
                "the empty answer from This server",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".access-sheet .pages-item-title")].map((each) => each.textContent.trim()));
            `),
                ["This server"],
            );
            assert.equal(
                await partText("nothing-to-share"),
                "Nothing of yours to share on This server yet. A session you start here can be shared with the people who use it.",
            );
            assert.equal(await hasGrid(), false);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector(".ak-tools, .ak-key")));`,
                ),
                false,
            );
            await app.choosePerson(THIS_SERVER, person.user.id, false);
            await until(
                async () => (await viewNames()).length === 2,
                "the Computer view goes away again",
            );
            assert.deepEqual(await viewNames(), ["People", "Settings"]);
        });
    } finally {
        await app.removeUser(owner(app), person.user.id);
    }
});

test(
    "a runner the owner can only unlink does not ask for sharing or show its empty state",
    real,
    async () => {
        const linker = app.config.addUser("Nobody else's linker", "guest").user;
        const runner = app.config.addRunner(
            "Private computer",
            linker.id,
            newIdentity().publicKey,
        ).id;

        try {
            await load();
            await inPage(`
            const fetch = window.fetch.bind(window);
            window.sharingReads = [];
            window.fetch = (url, init) => {
                if (String(url) === ${JSON.stringify(`/api/runners/${runner}/sharing`)}) window.sharingReads.push(url);
                return fetch(url, init);
            };
            return JSON.stringify(true);
        `);
            await openAt("computer", runner);
            await until(
                async () => (await partText("read-only"))?.includes("You do not use it") === true,
                "the unlink-only page",
            );
            // Wait for the opening reads and also ask for this computer directly.
            const reads = await inPage<string[]>(`
            const access = await import("/sheets/access.js");
            await access.loadSharings();
            await access.loadSharing(access.computers().find((each) => each.id === ${JSON.stringify(runner)}));
            return JSON.stringify(window.sharingReads);
        `);

            assert.deepEqual(reads, []);
            assert.deepEqual(
                await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".pages-detail .sheet-page-actions button")].map((each) => each.textContent.trim()));
        `),
                ["Unlink"],
            );
            assert.equal(await hasGrid(), false);
            assert.equal(await partText("nothing-to-share"), null);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector(".pages-detail .ak-group, .pages-detail .ak-key, .pages-detail .ak-tools")));`,
                ),
                false,
            );
        } finally {
            await app.unlinkRunner(runner);
            await app.removeUser(owner(app), linker.id);
        }
    },
);

test(
    "someone not in charge gets only their sharing grid and can share, revoke, and give a folder",
    real,
    async () => {
        const giver = app.config.addUser("Giver", "guest");
        const recipient = app.config.addUser("Folder recipient", "guest").user;
        const passer = app.config.addUser("Other recipient", "guest").user;
        const outsider = app.config.addUser("Not chosen", "guest").user;
        const folder = realpathSync(mkdtempSync(join(root, "offer-")));
        const stop = answerRequests(app, () => true);

        try {
            for (const person of [giver.user, recipient, passer]) {
                await app.choosePerson(THIS_SERVER, person.id, true);
            }

            await app.giveFolders(owner(app), THIS_SERVER, giver.user.id, [folder]);
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: giver.user.id,
                right: "reshares",
                on: true,
            });
            const first = (
                await app.commands.createSession(giver.user, {
                    cwd: folder,
                    title: "Offer a first session",
                })
            ).id;

            await app.commands.createSession(giver.user, {
                cwd: folder,
                title: "Offer a second session",
            });
            await app.commands.createSession(owner(app), {
                cwd: folder,
                title: "The owner's private session",
            });
            const answer = app.commands.sharingOn(giver.user, THIS_SERVER);

            await asPerson(giver.token, async () => {
                await openAt("computer", THIS_SERVER);
                await until(
                    async () => (await gridNames()).length === answer.people.length,
                    "the sharing columns",
                );
                assert.deepEqual(
                    new Set(await gridNames()),
                    new Set(answer.people.map(({ id }) => app.config.userById(id)!.name)),
                );
                assert.ok((await gridNames()).includes(recipient.name));
                assert.ok(!(await gridNames()).includes(outsider.name));
                assert.match(
                    (await partText("read-only"))!,
                    /You share your sessions here, and give the folders given to you\./,
                );
                assert.deepEqual(
                    await inPage<{
                        trust: boolean;
                        folders: boolean;
                        switches: boolean;
                        by: boolean;
                    }>(`
                return JSON.stringify({ trust: Boolean(document.querySelector(".ag-trust-head")),
                    folders: Boolean(document.querySelector(".ag-all")), switches: Boolean(document.querySelector(".ag-people")),
                    by: Boolean(document.querySelector("select[aria-label='Started by']")) });
            `),
                    { trust: false, folders: false, switches: false, by: false },
                );
                await pressSharingCell(`Open ${folder}`);
                const titles = await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".ag-session .ag-title")].map((each) => each.textContent.trim()));
            `);

                assert.deepEqual(titles.sort(), [
                    "Offer a first session",
                    "Offer a second session",
                ]);
                await pressSharingCell("Invite Folder recipient to Offer a first session");
                await until(
                    () => app.sessionMeta(first)?.sharedWith?.includes(recipient.id) === true,
                    "the direct share",
                );
                await until(
                    () =>
                        inPage<boolean>(
                            `return JSON.stringify(document.querySelector('button[aria-label="Revoke Offer a first session from Folder recipient"]')?.disabled === false);`,
                        ),
                    "Revoke taking a click",
                );
                await inPage(`window.confirm = () => true; return JSON.stringify(true);`);
                await pressSharingCell("Revoke Offer a first session from Folder recipient");
                await until(
                    () => !app.sessionMeta(first)?.sharedWith?.includes(recipient.id),
                    "the share taken back",
                );
                const label = `Access of Folder recipient to ${folder} on This server: No access`;

                await until(
                    () =>
                        inPage<boolean>(
                            `return JSON.stringify(document.querySelector(${JSON.stringify(`button[aria-label=${JSON.stringify(label)}]`)})?.disabled === false);`,
                        ),
                    "the folder's menu taking a click",
                );
                await pressSharingCell(label);
                await until(
                    () =>
                        inPage<boolean>(
                            `return JSON.stringify(Boolean(document.querySelector(".at-level-menu")));`,
                        ),
                    "the folder's levels",
                );
                await inPage(`
                [...document.querySelectorAll(".at-level-menu .at-level-item")].find((each) => each.querySelector(".at-level-name").textContent.trim() === "Start sessions").click();
                return JSON.stringify(true);
            `);
                await until(
                    () => app.config.givenFolders(THIS_SERVER, recipient.id).includes(folder),
                    "the folder given",
                );
                assert.equal(
                    app.config.givenFolders(THIS_SERVER, passer.id).includes(folder),
                    false,
                );
            });
        } finally {
            stop();

            for (const person of [giver.user, recipient, passer, outsider]) {
                await app.removeUser(owner(app), person.id);
            }
        }
    },
);

test(
    "the grid draws a control only where the reader can use it: nothing is disabled at rest, in charge or not",
    real,
    async () => {
        const manager = app.config.addUser("Grid manager", "guest");
        const giver = app.config.addUser("Grid giver", "guest");
        const other = app.config.addUser("Grid other", "guest").user;
        const folder = realpathSync(mkdtempSync(join(root, "control-")));
        const second = realpathSync(mkdtempSync(join(root, "control-two-")));
        const stop = answerRequests(app, () => true);
        let invited: User | undefined;
        /** The controls drawn disabled in the grid and under it, each by its name. */
        const disabled = () =>
            inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".ag-scroll :disabled")].map((each) => each.getAttribute("aria-label") ?? each.textContent.trim()));
        `);
        /** How many Access menus the grid has in the column of `name`. */
        const menusOf = (name: string) =>
            inPage<number>(
                `return JSON.stringify(document.querySelectorAll(${JSON.stringify(`.ag-table .at-level[aria-label^=${JSON.stringify(`Access of ${name} to `)}]`)}).length)`,
            );
        /** Who has a switch under the grid. */
        const switchNames = () =>
            inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".ag-people [role=switch]")].map((each) => each.getAttribute("aria-label").split(" may use ")[0]));
        `);

        try {
            for (const each of [manager.user, giver.user, other]) {
                await app.choosePerson(THIS_SERVER, each.id, true);
            }

            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: manager.user.id,
                right: "manages",
                on: true,
            });
            await app.giveFolders(owner(app), THIS_SERVER, giver.user.id, [folder, second]);
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: giver.user.id,
                right: "reshares",
                on: true,
            });
            // The owner gave the second folder to the other person: not the giver's to change.
            await app.giveFolders(owner(app), THIS_SERVER, other.id, [second]);
            await app.commands.createSession(giver.user, { cwd: folder, title: "Control: hers" });
            const owners = (
                await app.commands.createSession(owner(app), {
                    cwd: folder,
                    title: "Control: the owner's",
                })
            ).id;

            // The owner shared a session with both: the giver passes it on, and cannot take it from the other person.
            await app.commands.shareSession(owners, owner(app), [giver.user.id, other.id]);
            invited = app.config.addUser("Grid invited", "viewer", [String(owners)]).user;
            app.accessChanged();

            // In charge. A manager has no column: nothing of theirs can be changed. Someone invited to one session
            // has one, for that session, and no Access menu in it. Nothing is drawn disabled.
            await load();
            await openAt("computer", THIS_SERVER);
            await until(async () => {
                const names = await gridNames();

                return ["Grid giver", "Grid other", "Grid invited"].every((name) =>
                    names.includes(name),
                );
            }, "the owner's grid");
            assert.equal((await gridNames()).includes("Grid manager"), false, "no manager column");
            assert.ok((await gridNames()).includes("Grid other"));
            await openGridTo(folder);
            await until(
                async () => "Control: the owner's" in (await sessionCells("Grid invited")),
                "the sessions of the folder",
            );
            assert.equal((await sessionCells("Grid invited"))["Control: the owner's"], "Revoke");
            assert.equal(await menusOf("Grid invited"), 0, "no menu that cannot be used");
            assert.ok((await menusOf("Grid other")) > 0, "a menu for someone chosen");
            assert.deepEqual(await disabled(), []);

            // Under the grid, only the switches the owner can flip: a manager's too, and not the invited person's.
            const flips = await switchNames();

            assert.ok(flips.includes("Grid manager"), JSON.stringify(flips));
            assert.ok(flips.includes("Grid other"));
            assert.equal(flips.includes("Grid invited"), false, "chosen for no computer");

            // Not in charge. The giver is told only what is hers to change.
            await asPerson(giver.token, async () => {
                await openAt("computer", THIS_SERVER);
                await until(async () => (await gridNames()).includes("Grid other"), "her grid");

                const names = await gridNames();

                assert.equal(names.includes("Grid manager"), false, "in charge: nothing to give");
                assert.equal(names.includes("Grid invited"), false, "invited to one session only");
                await openGridTo(folder);
                await until(
                    async () => "Control: hers" in (await sessionCells("Grid other")),
                    "her sessions",
                );

                const cells = await sessionCells("Grid other");

                // Hers to share with them: Invite. The one the owner shared with them: nothing to do, a dash.
                assert.match(cells["Control: hers"]!, /Invite/);
                assert.equal(cells["Control: the owner's"], "—");
                // The folder she can give has its menu. The one they have from the owner has none.
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(${cellOf("Grid other", folder)}?.disabled === false)`,
                    ),
                    true,
                );
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(${cellOf("Grid other", second)} === null)`,
                    ),
                    true,
                    "a folder given by someone else has no menu",
                );
                assert.deepEqual(await disabled(), []);
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".ag-people") === null)`,
                    ),
                    true,
                );
            });
        } finally {
            stop();

            for (const person of [manager.user, giver.user, other, invited]) {
                if (person !== undefined) {
                    await app.removeUser(owner(app), person.id);
                }
            }
        }
    },
);

test(
    "a refused sharing read ends loading and the next read can bring back the grid",
    real,
    async () => {
        const giver = app.config.addUser("Refused read", "guest");
        const stop = answerRequests(app, () => true);
        const folder = realpathSync(mkdtempSync(join(root, "refused-")));

        try {
            await app.choosePerson(THIS_SERVER, giver.user.id, true);
            await app.giveFolders(owner(app), THIS_SERVER, giver.user.id, [folder]);
            await app.commands.createSession(giver.user, {
                cwd: folder,
                title: "Visible after a good read",
            });
            await asPerson(giver.token, async () => {
                await inPage(`
                window.realFetch = window.fetch;
                window.fetch = (url, init) => url === "/api/runners/this-server/sharing" ? Promise.resolve(new Response("", { status: 403 })) : window.realFetch(url, init);
                return JSON.stringify(true);
            `);
                await openAt("computer", THIS_SERVER);
                await until(
                    () =>
                        inPage<boolean>(
                            `const { store } = await import("/store.js"); return JSON.stringify(store.state.accessSharing?.["this-server"]?.failed === true);`,
                        ),
                    "the refused read",
                );
                assert.equal(await hasGrid(), false);
                assert.equal(await partText("nothing-to-share"), null);
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector(".ac-computer .loader")));`,
                    ),
                    false,
                );
                await inPage(`
                window.fetch = window.realFetch;
                const access = await import("/sheets/access.js");
                await access.loadSharings();
                return JSON.stringify(true);
            `);
                await until(hasGrid, "the grid after a good read");
            });
        } finally {
            stop();
            await app.removeUser(owner(app), giver.user.id);
        }
    },
);

test("a sharing answer that left before a share does not undo the newer answer", real, async () => {
    const giver = app.config.addUser("Recent giver", "guest");
    const to = people[0]!;
    const stop = answerRequests(app, () => true);
    const folder = realpathSync(mkdtempSync(join(root, "recent-")));

    try {
        await app.choosePerson(THIS_SERVER, giver.user.id, true);
        await app.giveFolders(owner(app), THIS_SERVER, giver.user.id, [folder]);
        const { id } = await app.commands.createSession(giver.user, {
            cwd: folder,
            title: "A recent session",
        });

        await asPerson(giver.token, async () => {
            await openAt("computer", THIS_SERVER);
            await until(hasGrid, "the sharing grid");
            const result = await inPage<{ before: string; saved: string; after: string }>(`
                const access = await import("/sheets/access.js");
                const { api } = await import("/store.js");
                const computer = access.computers().find((each) => each.id === "this-server");
                const cell = () => access.sharingOf(computer).people.find((each) => each.id === ${JSON.stringify(to.id)}).sessions[${JSON.stringify(id)}].state;
                const fetching = window.fetch;
                let release;
                const gate = new Promise((resolve) => release = resolve);
                let answered;
                const waiting = new Promise((resolve) => answered = resolve);
                let intercepted = false;

                window.fetch = async (url, init) => {
                    if (url !== "/api/runners/this-server/sharing" || intercepted) return fetching(url, init);
                    intercepted = true;
                    const response = await fetching(url, init);
                    const body = await response.text();
                    answered();
                    await gate;
                    return new Response(body, { status: response.status, headers: response.headers });
                };

                try {
                    const before = cell();
                    const older = access.loadSharing(computer);
                    await waiting;
                    await api(${JSON.stringify(`users/${to.id}/sharing`)}, { share: [${Number(id)}] });
                    await access.loadSharing(computer);
                    const saved = cell();
                    release();
                    await older;
                    return JSON.stringify({ before, saved, after: cell() });
                } finally {
                    window.fetch = fetching;
                    release();
                }
            `);

            assert.deepEqual(result, { before: "none", saved: "shared", after: "shared" });
            assert.equal(app.sessionMeta(id)?.sharedWith?.includes(to.id), true);
        });
    } finally {
        stop();
        await app.removeUser(owner(app), giver.user.id);
    }
});

test(
    "a projects answer that left before a trust change does not undo it when it comes in late",
    real,
    async () => {
        await load(DESKTOP);
        await openAt("computer", THIS_SERVER);
        await grid();

        const result = await inPage<{ before: unknown; after: unknown }>(`
        const access = await import("/sheets/access.js");
        const computer = access.computers().find((each) => each.id === ${JSON.stringify(THIS_SERVER)});
        const shop = () => access.projectsOf(computer).projects.find((each) => each.name === "shop");
        const root = shop().root;
        const fetching = window.fetch;
        let release = () => {};
        const gate = new Promise((resolve) => (release = resolve));
        let read = () => {};
        const answered = new Promise((resolve) => (read = resolve));

        // The projects answer is read on the server before the trust change, and reaches the page after it.
        window.fetch = async (url, init) => {
            if (String(url).endsWith("/projects") && (init?.method ?? "GET") === "GET") {
                const response = await fetching(url, init);
                const body = await response.text();

                read();
                await gate;

                return new Response(body, { status: response.status, headers: response.headers });
            }

            return fetching(url, init);
        };

        try {
            const loading = access.loadProjects();

            await answered;
            await access.setTrust(computer, [root], "distrust");
            const before = shop().trust[0].saved;

            release();
            await loading;

            return JSON.stringify({ before, after: shop().trust[0].saved });
        } finally {
            window.fetch = fetching;
            release();
        }
    `);

        assert.equal(
            (result.before as { trusted?: boolean } | null)?.trusted,
            false,
            "the save shows",
        );
        assert.deepEqual(result.after, result.before, "the late, older answer replaced the save");
    },
);

test(
    "Computer has a column for the owner on a runner a user linked, once the owner is chosen there",
    real,
    async () => {
        const { user: linker, token } = app.config.addUser("Linker", "guest");
        const desk = app.config.addRunner("Desk", linker.id, newIdentity().publicKey).id;

        app.config.setUsers(desk, [owner(app).id, people[0]!.id]);
        app.accessChanged();

        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "access-sheet-linker-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;

        try {
            page = await theirs.open(1);
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await load();
            await openAt("computer", desk);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelectorAll(".ag-head .ag-who").length > 0)`,
                    ),
                "Desk's grid",
            );

            const heads = await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".ag-head .ag-who-name")].map((each) => each.textContent.trim()))`,
            );

            assert.deepEqual(
                [...heads].sort(),
                [owner(app).name, people[0]!.name].sort(),
                "a column for each person chosen for Desk",
            );
        } finally {
            page = owners;
            await theirs.closeAll({ final: true });
            app.config.removeRunner(desk);
            app.accessChanged();
        }
    },
);

/** Each row of All folders in the grid shown: its folder (its toggle's title), and what each person's cell says. */
const browsedGrid = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".ag-browse")].map((row) =>
                [row.querySelector(".ag-toggle").title, ...[...row.querySelectorAll(":scope > .ag-cell .at-level")].map((each) => each.textContent.trim())].join(" | "),
            ),
        );
    `);

/** Press the button of the grid called `label`. */
const pressGrid = (label: string) =>
    inPage(`
        document.querySelector(${JSON.stringify(`.pages-detail button[aria-label=${JSON.stringify(label)}]`)}).click();

        return JSON.stringify(true);
    `);

test(
    "Computer has All folders last, with a cell for each person column: a choice in a cell is saved for that person alone",
    real,
    async () => {
        // Outside the folder every person here is given (`addPerson`): a folder nobody has.
        const place = realpathSync(mkdtempSync(join(home, "grid-all-")));
        const fresh = join(place, "fresh");

        mkdirSync(fresh);
        // This server's home is a folder of the test's own while the page loads and reads it.
        process.env.HOME = place;

        try {
            await load(DESKTOP);
            await openAt("computer", THIS_SERVER);
            await grid();

            // The last row of the grid, closed, with no cells: only its folders have them.
            const last = await inPage<{ label: string; cells: number }>(`
                const rows = [...document.querySelectorAll(".ag-table > .ag-row:not(.ag-head)")];

                return JSON.stringify({
                    label: rows.at(-1).querySelector(".ag-toggle").getAttribute("aria-label"),
                    cells: rows.at(-1).querySelectorAll(".ag-cell").length,
                });
            `);

            assert.deepEqual(last, { label: "Open All folders of This server", cells: 0 });
            await pressGrid("Open All folders of This server");
            await until(async () => (await browsedGrid()).length === 2, "its top folders");
            await pressGrid(`Open ${place} in All folders`);
            await until(
                async () => (await browsedGrid()).some((each) => each.startsWith(`${fresh} |`)),
                "the folders in home",
            );
        } finally {
            process.env.HOME = realHome;
        }

        const row = (await browsedGrid()).find((each) => each.startsWith(`${fresh} |`))!;

        assert.equal(row.split(" | ").length, 1 + 8, "a cell for each of the 8 people");
        assert.ok(
            row
                .split(" | ")
                .slice(1)
                .every((each) => each === "None"),
        );

        // Person 1's cell: Start sessions, for them alone.
        const [first, second] = [people[0]!, people[1]!];

        await inPage(`
            document.querySelector(${JSON.stringify(`.ag-browse .at-level[aria-label^=${JSON.stringify(`Access of ${first.name} to ${fresh} on `)}]`)}).click();

            return JSON.stringify(true);
        `);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".at-level-menu") !== null)`,
                ),
            "the menu",
        );
        await inPage(`
            [...document.querySelectorAll(".at-level-menu .at-level-item")]
                .find((each) => each.querySelector(".at-level-name").textContent.trim() === "Start sessions")
                .click();

            return JSON.stringify(true);
        `);

        try {
            await until(
                () => app.config.givenFolders(THIS_SERVER, first.id).includes(fresh),
                "the folder given to them",
            );
            assert.equal(app.config.givenFolders(THIS_SERVER, second.id).includes(fresh), false);
            assert.deepEqual(
                people
                    .slice(1)
                    .filter((each) => app.config.givenFolders(THIS_SERVER, each.id).includes(fresh))
                    .map((each) => each.name),
                [],
                "nobody else",
            );
            await until(
                async () =>
                    (await browsedGrid())
                        .find((each) => each.startsWith(`${fresh} |`))
                        ?.split(" | ")[1] === "Start",
                "its cell to say so",
            );
        } finally {
            await app.setFolderLevel(owner(app), THIS_SERVER, first.id, fresh, "none");
        }
    },
);

test(
    "on an offline runner All folders says it shows the folders once it is online, and reads nothing",
    real,
    async () => {
        const laptop = app.config.runners.find((each) => each.name === "Laptop")!.id;

        app.config.setUsers(laptop, [people[0]!.id]);
        app.accessChanged();

        try {
            await load(DESKTOP);
            await inPage(`
                window.fsReads = [];
                const fetched = window.fetch;

                window.fetch = (input, init) => {
                    if (String(input).includes("/fs?")) {
                        window.fsReads.push(String(input));
                    }

                    return fetched(input, init);
                };

                return JSON.stringify(true);
            `);
            await openAt("computer", laptop);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector('.pages-detail button[aria-label="Open All folders of Laptop"]') !== null)`,
                    ),
                "its All folders",
            );
            await pressGrid("Open All folders of Laptop");
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify([...document.querySelectorAll(".ag-empty")].some((each) => each.textContent.trim() === "Folders show when Laptop is online."))`,
                    ),
                "the line",
            );
            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.deepEqual(
                (await inPage<string[]>(`return JSON.stringify(window.fsReads)`)).filter((each) =>
                    each.includes(`runners/${laptop}/`),
                ),
                [],
                "nothing read from it",
            );
        } finally {
            app.config.setUsers(laptop, []);
            app.accessChanged();
        }
    },
);

/** Open the folder rows of the grid that lead to `path`, and its own. */
async function openGridTo(path: string): Promise<void> {
    for (let round = 0; round < 12; round++) {
        const opened = await inPage<boolean>(`
            const path = ${JSON.stringify(path)};
            const row = [...document.querySelectorAll(".ag-group .ag-toggle")].find(
                (each) => each.getAttribute("aria-expanded") !== "true" && (each.title === path || path.startsWith(each.title + "/")),
            );

            row?.click();

            return JSON.stringify(row !== undefined);
        `);

        if (!opened) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** The Access button of `name`'s cell on the grid's row of `folder`, as a script finds it. */
const cellOf = (name: string, folder: string) =>
    `document.querySelector(${JSON.stringify(`.ag-group .at-level[aria-label^=${JSON.stringify(`Access of ${name} to ${folder} on `)}]`)})`;

/** The items of the open Access menu: each name, whether it is checked, and the lines under it. */
const menuItems = () =>
    inPage<{ name: string; checked: boolean; says: string[] }[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".at-level-menu .at-level-item")].map((each) => ({
                name: each.querySelector(".at-level-name").textContent.trim(),
                checked: each.getAttribute("aria-checked") === "true",
                says: [...each.querySelectorAll(".at-level-says")].map((line) => line.textContent.trim()),
            })),
        );
    `);

/** Open the Access menu of `name`'s cell on the row of `folder`, and wait for its items. */
async function openCell(name: string, folder: string): Promise<void> {
    // A menu open before closes first, by its own button: its items are not this one's.
    await inPage(
        `document.querySelector('.at-level[aria-expanded="true"]')?.click(); return JSON.stringify(true);`,
    );
    await until(async () => (await menuItems()).length === 0, "no menu open");
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(${cellOf(name, folder)}?.disabled === false)`,
            ),
        `the Access menu of ${name} on ${folder}`,
    );
    await inPage(`${cellOf(name, folder)}.click(); return JSON.stringify(true);`);
    await until(async () => (await menuItems()).length > 0, "its items");
    await inPage(`
        await Promise.all(document.getAnimations().map((each) => each.finished.catch(() => undefined)));

        return JSON.stringify(true);
    `);
}

/** Pick `level` (its name) in the open Access menu. */
const pickItem = (level: string) =>
    inPage(`
        [...document.querySelectorAll(".at-level-menu .at-level-item")]
            .find((each) => each.querySelector(".at-level-name").textContent.trim() === ${JSON.stringify(level)})
            .click();

        return JSON.stringify(true);
    `);

/** What the cell of `name`'s column says on each session row of the grid, by the session's title. */
const sessionCells = (name: string) =>
    inPage<Record<string, string>>(`
        const at = [...document.querySelectorAll(".ag-head .ag-who-name")].findIndex(
            (each) => each.textContent.trim() === ${JSON.stringify(name)},
        );

        return JSON.stringify(
            Object.fromEntries(
                [...document.querySelectorAll(".ag-session")].map((row) => [
                    row.querySelector(".ag-title").textContent.trim(),
                    [...row.querySelectorAll(".ag-cell")][at]?.textContent.replace(${JSON.stringify(name)}, "").replace(/\\s+/g, " ").trim() ?? "",
                ]),
            ),
        );
    `);

test(
    "the Access menu offers Current, New, and All sessions; New shows only what starts later, and each says its time",
    real,
    async () => {
        const folder = join(root, "levels-ui");

        mkdirSync(folder, { recursive: true });

        const real_ = realpathSync(folder);
        const [user, viewer] = [people[0]!, people[1]!];

        /** A session the owner starts in the folder, shared with nobody one at a time. */
        const make = async (title: string) => {
            const { id } = await app.commands.createSession(owner(app), { cwd: real_, title });

            await app.commands.shareSession(id, owner(app), []);

            return id;
        };

        await make("Made before");
        await new Promise((resolve) => setTimeout(resolve, 5));

        try {
            await load(DESKTOP);
            await openAt("computer", THIS_SERVER);
            await grid();
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify([...document.querySelectorAll(".ag-group .ag-toggle")].some((each) => each.title === ${JSON.stringify(real_)} || ${JSON.stringify(real_)}.startsWith(each.title + "/")))`,
                    ),
                "the folder's row",
            );
            await openGridTo(real_);
            await until(
                async () => (await sessionCells(viewer.name))["Made before"] !== undefined,
                "the session made before",
            );
            assert.equal((await sessionCells(viewer.name))["Made before"], "Invite");

            // A user's menu: Start sessions after No access, then the three that show sessions.
            await openCell(user.name, real_);
            assert.deepEqual(
                (await menuItems()).map((each) => each.name),
                ["No access", "Start sessions", "Current sessions", "New sessions", "All sessions"],
            );
            writeFileSync(
                "/tmp/levels-menu-user.png",
                Buffer.from((await page.screenshot()).data, "base64"),
            );

            // A viewer's: no Start sessions.
            await openCell(viewer.name, real_);
            assert.deepEqual(
                (await menuItems()).map((each) => each.name),
                ["No access", "Current sessions", "New sessions", "All sessions"],
            );
            await pickItem("New sessions");
            await until(
                () => app.config.folderLevel(THIS_SERVER, viewer.id, real_) === "new",
                "New sessions to be saved",
            );
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(${cellOf(viewer.name, real_)}?.textContent.trim() === "New")`,
                    ),
                "the button to say New",
            );

            // One started from now on is theirs through the folder; the one made before stays out.
            await new Promise((resolve) => setTimeout(resolve, 5));
            await make("Made after");
            await until(
                async () => (await sessionCells(viewer.name))["Made after"] === "Through folder",
                "the later session in their column",
            );
            assert.equal((await sessionCells(viewer.name))["Made before"], "Invite");

            // Its checked item says from when.
            await openCell(viewer.name, real_);

            const atNew = await menuItems();
            const from = app.config.seenFrom(THIS_SERVER, viewer.id)[real_]!;

            assert.deepEqual(
                atNew.filter((each) => each.checked).map((each) => each.name),
                ["New sessions"],
            );
            assert.equal(atNew.find((each) => each.checked)!.says.length, 2);
            assert.match(atNew.find((each) => each.checked)!.says[1]!, /^From /);
            assert.equal(
                atNew.find((each) => each.checked)!.says[1],
                `From ${await inPage<string>(`return JSON.stringify(new Date(${from}).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))`)}.`,
            );
            assert.deepEqual(
                atNew.filter((each) => !each.checked).map((each) => each.says.length),
                [1, 1, 1],
                "no time on the others",
            );
            writeFileSync(
                "/tmp/levels-menu-viewer.png",
                Buffer.from((await page.screenshot()).data, "base64"),
            );

            // Current sessions: its checked item says up to when; the later session leaves their column.
            await pickItem("Current sessions");
            await until(
                () => app.config.folderLevel(THIS_SERVER, viewer.id, real_) === "past",
                "Current sessions to be saved",
            );
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(${cellOf(viewer.name, real_)}?.textContent.trim() === "Current")`,
                    ),
                "the button to say Current",
            );
            await openCell(viewer.name, real_);

            const atPast = (await menuItems()).find((each) => each.checked)!;

            assert.equal(atPast.name, "Current sessions");
            assert.equal(atPast.says.length, 2);
            assert.match(atPast.says[1]!, /^Up to /);

            // All sessions: no time.
            await pickItem("All sessions");
            await until(
                () => app.config.folderLevel(THIS_SERVER, viewer.id, real_) === "all",
                "All sessions to be saved",
            );
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(${cellOf(viewer.name, real_)}?.textContent.trim() === "All")`,
                    ),
                "the button to say All",
            );
            await openCell(viewer.name, real_);
            assert.deepEqual(
                (await menuItems()).map((each) => each.says.length),
                [1, 1, 1, 1],
                "no time on any item",
            );
            await inPage(
                `document.querySelector('.at-level[aria-expanded="true"]')?.click(); return JSON.stringify(true);`,
            );

            // The key, as pictures: one row at 1280 px, rows of two at 390 px.
            await inPage(
                `document.querySelector(".ak-key").scrollIntoView({ block: "start" }); return JSON.stringify(true);`,
            );
            writeFileSync(
                "/tmp/levels-key-1280.png",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            await load(PHONE);
            await openAt("computer", THIS_SERVER);
            await grid();
            await inPage(
                `document.querySelector(".ak-key").scrollIntoView({ block: "start" }); return JSON.stringify(true);`,
            );
            writeFileSync(
                "/tmp/levels-key-390.png",
                Buffer.from((await page.screenshot()).data, "base64"),
            );
        } finally {
            await app.setFolderLevel(owner(app), THIS_SERVER, viewer.id, real_, "none");
        }
    },
);

// The last test of the file: it changes who is chosen for this server.
test(
    "Computer is as wide as the people with a column need, and Group by stands beside New session",
    real,
    async () => {
        const all = people.map((each) => each.id);
        const WIDE: Viewport = { width: 1440, height: 900, scale: 1, mobile: false };
        const NARROW: Viewport = { width: 900, height: 800, scale: 1, mobile: false };

        type Look = {
            sheet: number;
            group: [number, number] | null;
            start: [number, number];
            inTools: boolean;
            grid: [number, number];
        };
        const look = () =>
            inPage<Look>(`
                const middle = (selector) => {
                    const at = document.querySelector(selector)?.getBoundingClientRect();

                    return at ? [Math.round(at.left), Math.round(at.top + at.height / 2)] : null;
                };
                const scroller = document.querySelector(".ag-scroll");

                return JSON.stringify({
                    sheet: Math.round(document.querySelector(".sheet").getBoundingClientRect().width),
                    group: middle(".ac-head > .ak-group"),
                    start: middle(".ac-head .sheet-page-actions"),
                    inTools: document.querySelector(".ak-tools .ak-group") !== null,
                    grid: [scroller.clientWidth, scroller.scrollWidth],
                });
            `);

        /** Computer with `count` people chosen for this server, once the sheet has `width`. */
        const at = async (count: number, viewport: Viewport, width: number): Promise<Look> => {
            app.config.setUsers(THIS_SERVER, all.slice(0, count));
            app.accessChanged();
            await load(viewport);
            await openAt("computer", THIS_SERVER);
            await until(
                async () =>
                    await inPage<boolean>(`
                        return JSON.stringify(
                            document.querySelectorAll(".ag-head .ag-who").length === ${count} &&
                                Math.round(document.querySelector(".sheet").getBoundingClientRect().width) === ${width},
                        );
                    `),
                `${count} people in a sheet of ${width} px at ${viewport.width} px`,
            );

            return await look();
        };

        try {
            // One person: the least width, with Group by and New session in one row, and nothing to scroll.
            const one = await at(1, WIDE, 1040);

            assert.equal(one.inTools, false, "Group by is not among the filters");
            assert.ok(one.group, "Group by is in the head row");
            assert.ok(Math.abs(one.group[1] - one.start[1]) < 4, JSON.stringify(one));
            assert.ok(one.group[0] < one.start[0], "Group by is before New session");
            assert.equal(one.grid[1], one.grid[0], "one person: no sideways scroll");

            // Five people: 3 columns more than the least width holds, and still nothing to scroll.
            const five = await at(5, WIDE, 1319);

            assert.equal(five.grid[1], five.grid[0], "5 people fit");

            // Eight people: the most width, and the people who do not fit scroll sideways.
            const eight = await at(8, WIDE, 1400);

            assert.ok(eight.grid[1] > eight.grid[0], "8 people scroll sideways");

            // People keeps the least width, whoever is chosen.
            await openAt("person");
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(Math.round(document.querySelector(".sheet").getBoundingClientRect().width) === 1040)`,
                    ),
                "People at 1040 px",
            );

            // A narrow window: Group by is under the computer's name, New session stays beside the name.
            const narrow = await at(1, NARROW, 868);

            assert.ok(
                narrow.group && narrow.group[1] > narrow.start[1] + 20,
                JSON.stringify(narrow),
            );
        } finally {
            app.config.setUsers(THIS_SERVER, all);
            app.accessChanged();
        }
    },
);
