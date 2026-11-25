// The Access sheet in a real browser (`web/sheets/access-sheet.js`, `web/sheets/access-grid.js`): one sheet, opened at
// the right view from each opener; By computer only for who may have it; its grid of 8 people, whose head and rows
// scroll sideways together, on a phone and on a desktop; the key in one row; a menu on the last row that opens upward
// inside the sheet; the "i" buttons, centred and 14 px; and Settings, which holds a computer's approvals.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    addPerson,
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

            // The key is four cells, in one row on a desktop and two rows of two on a phone: no level is cut, the key
            // does not scroll sideways, and nothing but what scrolls sideways is wider than the screen.
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
                "So far: also every session here now",
                "All: also every session that starts later",
            ]);
            assert.deepEqual(layout.keyRows, viewport === DESKTOP ? [4] : [2, 2], "the key's rows");
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

            // Their tree has the same two headings: the projects, then the folders in no project.
            assert.deepEqual(
                await inPage<string[]>(`
                const tree = document.querySelector(".pages-detail .at-tree");

                return JSON.stringify([...tree.children].map((each) => each.classList.contains("at-heading") ? each.textContent.trim() : each.classList.contains("at-node") ? "row" : "other"));
            `),
                // Three projects; Home and the folder given to them; All folders last.
                ["By project", "row", "row", "row", "By folders", "row", "row", "row"],
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
    "By computer has a column for the owner on a runner a user linked, once the owner is chosen there",
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
    "By computer has All folders last, with a cell for each person column: a choice in a cell is saved for that person alone",
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

// The last test of the file: it changes who is chosen for this server.
test(
    "By computer is as wide as the people with a column need, and Group by stands beside New session",
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

        /** By computer with `count` people chosen for this server, once the sheet has `width`. */
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

            // By person keeps the least width, whoever is chosen.
            await openAt("person");
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(Math.round(document.querySelector(".sheet").getBoundingClientRect().width) === 1040)`,
                    ),
                "By person at 1040 px",
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
