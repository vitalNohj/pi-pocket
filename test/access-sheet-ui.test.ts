// The Access sheet in a real browser (`web/sheets/access-sheet.js`, `web/sheets/access-grid.js`): one sheet, opened at
// the right view from each opener; By computer only for who may have it; its grid of 8 people, whose head and rows
// scroll sideways together, on a phone and on a desktop; the key in one row; a menu on the last row that opens upward
// inside the sheet; the "i" buttons, centred and 14 px; and Settings, which holds a computer's approvals.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    addPerson,
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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
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

    app = await openApp(scriptedModel());

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
            "the rail's People button",
            `document.querySelector('[data-part="rail-button"][aria-label="People"]').click()`,
            "By person",
        ],
        [
            "the rail's account button",
            `document.querySelector('[data-part="rail-button"][aria-label="Your account"]').click()`,
            "By person",
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
            "By person",
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
            "By person",
        ],
        [
            "the folder picker's Manage runners…",
            `(async () => {
                const { openSheet } = await import("/store.js");
                openSheet({ type: "cwd", mode: "new" });
                for (let i = 0; i < 80 && ![...document.querySelectorAll(".fp-link")].some((each) => each.textContent.trim() === "Manage runners…"); i++) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                [...document.querySelectorAll(".fp-link")].find((each) => each.textContent.trim() === "Manage runners…").click();
            })()`,
            "By computer",
        ],
    ];

    for (const [name, press, view] of openers) {
        await load();
        await page.evaluate(`await ${press}; return null;`);
        await until(async () => (await shown()).view === view, `${name} to open ${view}`);
        assert.equal((await shown()).type, "access", name);
    }
});

test("a viewer has By person and Settings, and no By computer", real, async () => {
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "access-sheet-viewer-")),
        load: async () => undefined,
        save: () => {},
    });
    const owners = page;

    try {
        page = await theirs.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(viewerToken)}`);
        await load();
        await openAt("computer");
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".access-sheet .ac-views button")].map((each) => each.textContent.trim()))`,
            ),
            ["By person", "Settings"],
        );
        assert.equal((await shown()).view, "By person", "By computer asked for: By person shown");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".ag-scroll") !== null)`,
            ),
            false,
        );
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
    }
});

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

            // The key is one row, and nothing but what scrolls sideways is wider than the screen.
            const layout = await inPage<{ keyLines: number; wider: string[] }>(`
            const key = document.querySelector(".ak-key");
            const scrolls = (element) => {
                for (let box = element.parentElement; box && !box.classList.contains("sheet"); box = box.parentElement) {
                    if (["auto", "scroll"].includes(getComputedStyle(box).overflowX) && box.scrollWidth > box.clientWidth) {
                        return true;
                    }
                }

                return false;
            };

            return JSON.stringify({
                keyLines: Math.round(key.getBoundingClientRect().height / parseFloat(getComputedStyle(key).lineHeight)),
                wider: [...document.querySelectorAll(".sheet *")]
                    .filter((each) => each.offsetParent !== null && !scrolls(each))
                    .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5)
                    .map((each) => each.className || each.tagName),
            });
        `);

            assert.equal(layout.keyLines, 1, "the key is one row");
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
                ["About Project or folder", "About Project trust", "About the people columns"],
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

            // By person has 1: in the key row.
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
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".pages-detail .ak-key") !== null)`,
                    ),
                "the key on their page",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".pages-detail .info-tip")].map((each) => each.getAttribute("aria-label") + (each.closest(".ak-key") ? " (key)" : "")));
            `),
                ["About the people columns (key)"],
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
    "Settings holds a computer's approvals: each person's time, and its sharing",
    real,
    async () => {
        await load(DESKTOP);
        await openAt("settings", THIS_SERVER);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-detail .group-title")].some((each) => each.textContent.trim() === "Approvals last"))`,
                ),
            "This server's settings",
        );

        const page_ = await inPage<{ list: string[]; titles: string[]; people: string[] }>(`
        return JSON.stringify({
            list: [...document.querySelectorAll(".pages-list .pages-item-title")].map((each) => each.textContent.trim()),
            titles: [...document.querySelectorAll(".pages-detail .group-title")].map((each) => each.textContent.trim()),
            people: [...document.querySelectorAll(".pages-detail .setting strong")].map((each) => each.textContent.trim()),
        });
    `);

        assert.deepEqual(page_.list.slice(0, 2), ["Settings", "Notifications"]);
        assert.ok(
            page_.list.includes("This server") && page_.list.includes("Laptop"),
            "a page per computer",
        );
        assert.deepEqual(page_.titles, ["Approvals last", "Sharing"]);
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
