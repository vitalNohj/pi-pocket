// The Access sheet in a real browser: a person's Computers rows open the matching grid and People switches.
// Folder and session changes follow the same record in both views, for managers and for people who give what they have.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    type App,
    answerRequests,
    cleanUp,
    context,
    fakeTab,
    home,
    linkAuthenticator,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1280, height: 800, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let guest: User;
let viewer: User;
let scoped: User;
let runnerId: string;

/**
 * In the page: whether `element` is inside a box that scrolls sideways (the tool row's filters, the key, the grid), so
 * that what is past the screen's edge is reached by scrolling it, as it is meant to be. The box itself still has to fit.
 */
const INSIDE_SCROLLER = `((element) => {
    for (let box = element.parentElement; box && !box.classList.contains("sheet"); box = box.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(box).overflowX) && box.scrollWidth > box.clientWidth) {
            return true;
        }
    }

    return false;
})`;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/**
 * Open the Access sheet on a fresh page, signed in as the owner, at People ("people"), Computer ("computers"), or
 * Settings: over home, or over the session at `path`.
 */
async function open(
    type: "people" | "computers" | "settings",
    viewport = DESKTOP,
    path = "/",
): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}${path}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('[data-part="app"]') !== null)`,
            ),
        "the app",
        20_000,
    );
    await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "access", view: ${JSON.stringify(type === "people" ? "person" : type === "computers" ? "computer" : "settings")} });

        return JSON.stringify(true);
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".pages-sheet .pages-item") !== null)`,
            ),
        `the ${type} sheet`,
    );
}

/**
 * Tap the row of the list on the left that names `name`, and wait for its page. The row of someone just added reaches
 * the list a moment after the server has them, so the tap waits for it.
 */
async function show(name: string): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
                const row = [...document.querySelectorAll(".pages-item")]
                    .find((each) => each.querySelector(".pages-item-title")?.textContent.startsWith(${JSON.stringify(name)}));

                row?.click();

                return JSON.stringify(row !== undefined);
            `),
        `${name}'s row in the list`,
    );
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sheet-page-title")?.textContent.trim().startsWith(${JSON.stringify(name)}) === true)`,
            ),
        `${name}'s page`,
    );
}

/**
 * Show part `label` of the page shown ("Computers" or "Permissions"), and wait for it. A fresh page shows
 * Computers. A page with one part alone has no tabs: then there is nothing to tap, and the part is shown
 * once it is drawn.
 */
async function showPart(label: "Computers" | "Permissions"): Promise<void> {
    const pane = label === "Permissions" ? "person-rules" : "person-access";

    await until(
        async () =>
            await inPage<boolean>(`
                const tabs = [...document.querySelectorAll(".pages-detail [role=tab]")];
                const tab = tabs.find((each) => each.textContent.trim().startsWith(${JSON.stringify(label)}));

                if (tab !== undefined && tab.getAttribute("aria-selected") !== "true") {
                    tab.click();
                }

                return JSON.stringify(
                    tabs.length === 0
                        ? document.querySelector('.pages-detail [data-part="${pane}"]') !== null
                        : tab?.getAttribute("aria-selected") === "true",
                );
            `),
        `the ${label} part`,
    );
}

/** The parts of the page shown, by their tabs; the one shown says so. None where the page has one part alone. */
const shownParts = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail [role=tab]")].map(
                (each) => each.textContent.trim() + (each.getAttribute("aria-selected") === "true" ? " (shown)" : ""),
            ),
        );
    `);

/** Tap a button of the page shown. One that shows while its page still saves takes no click: wait for it. */
async function tap(label: string): Promise<void> {
    const found = `[...document.querySelectorAll(".pages-detail button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent.trim()) === ${JSON.stringify(label)} && !each.disabled)`;

    await until(
        () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
        `${label} taking a click`,
    );
    await inPage(`${found}.click(); return JSON.stringify(true);`);
}

/** The switches of the page shown, by what a screen reader calls them; a disabled one says so. */
const switches = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail [role=switch]")].map(
                (each) => each.getAttribute("aria-label") + (each.disabled ? " (disabled)" : ""),
            ),
        );
    `);

/** Tap the switch whose name starts with `label`. */
const flip = (label: string) =>
    inPage(`
        [...document.querySelectorAll(".pages-detail [role=switch]")]
            .find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(label)}))
            .click();

        return JSON.stringify(true);
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    // This server's check of git and GitHub answers at once, and runs no program.
    app = await openApp(scriptedModel(), undefined, undefined, undefined, async () => ({
        git: true,
        gh: true,
        github: true,
    }));

    const session = await newSession(app);

    guest = app.config.addUser("Gina", "guest").user;
    viewer = app.config.addUser("Vera", "viewer").user;
    scoped = app.config.addUser("Sam", "viewer", [String(session)]).user;
    runnerId = app.config.addRunner("Laptop", owner(app).id, newIdentity().publicKey).id;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "people-sheet-ui-")),
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

test(
    "Access is one sheet: People, Computer, Settings in its head; People lists the people beside the chosen one's page",
    real,
    async () => {
        await open("computers");

        const computers = await inPage<{
            sheet: string;
            columns: number;
            views: string[];
            on: string;
        }>(`
        return JSON.stringify({
            sheet: document.querySelector(".sheet").getAttribute("data-sheet"),
            columns: getComputedStyle(document.querySelector(".pages-split")).gridTemplateColumns.split(" ").length,
            views: [...document.querySelectorAll(".ac-views button")].map((each) => each.textContent.trim()),
            on: document.querySelector(".ac-views button.on").textContent.trim(),
        });
    `);

        await open("people");

        const people = await inPage<{
            sheet: string;
            columns: number;
            items: string[];
            title: string;
            on: string;
        }>(`
        return JSON.stringify({
            sheet: document.querySelector(".sheet").getAttribute("data-sheet"),
            columns: getComputedStyle(document.querySelector(".pages-split")).gridTemplateColumns.split(" ").length,
            items: [...document.querySelectorAll(".pages-item-title")].map((each) => each.textContent.trim()),
            title: document.querySelector(".sheet-page-title").textContent.trim(),
            on: document.querySelector(".ac-views button.on").textContent.trim(),
        });
    `);

        assert.deepEqual([people.sheet, computers.sheet], ["access", "access"], "the same sheet");
        assert.deepEqual(computers.views, ["People", "Computer", "Settings"], "its three views");
        assert.deepEqual([people.on, computers.on], ["People", "Computer"], "each opener's view");
        assert.deepEqual(
            [people.columns, computers.columns],
            [2, 2],
            "a list and a page, side by side",
        );
        assert.deepEqual(
            [...people.items].sort(),
            ["Gina", "Invite someone", "Owner (you)", "Sam", "Vera"],
            "the people and Invite someone, nothing else",
        );
        assert.ok(people.title.startsWith("Owner"), "it opens on one's own page");
    },
);

/** The computer lines on a person's page, and which ones lead to Computer. */
const computerRows = () =>
    inPage<[string, string, boolean][]>(`
    return JSON.stringify([...document.querySelectorAll(".pages-detail .person-computer")].map((row) => [
        row.querySelector("strong").textContent.trim(), row.querySelector(".person-computer-line").textContent.trim(), row.tagName === "BUTTON",
    ]));
`);

async function view(label: "People" | "Computer" | "Settings"): Promise<void> {
    await inPage(`
        [...document.querySelectorAll('.ac-views [role=tab]')].find((each) => each.textContent.trim() === ${JSON.stringify(label)}).click();
        return JSON.stringify(true);
    `);
}

/** Jump from the person shown. The computer is selected without a click on its list item. */
async function jump(name: string, computer = "This server"): Promise<void> {
    await showPart("Computers");
    await tap(`${name} on ${computer}: open in Computer`);
    await until(
        () =>
            inPage<boolean>(`
        return JSON.stringify(document.querySelector(".view-computer .sheet-page-title")?.textContent.trim() === ${JSON.stringify(computer)});
    `),
        `the page of ${computer}`,
    );
}

async function groupBy(label: "Folders" | "Sessions" | "Projects"): Promise<void> {
    await tap(label);
}

const nothingHere = () =>
    inPage<string>(`
    return JSON.stringify(document.querySelector('[data-part="only-off"]')?.textContent.trim() ?? "");
`);

/** Choose a folder's level from its menu. A question it asks is kept, and answered yes. */
const choose = async (name: string, folder: string, level: string, scope = ".pages-detail") => {
    const button = `[...document.querySelectorAll(${JSON.stringify(`${scope} .at-level`)})].find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(`Access of ${name} to ${folder} on `)}))`;

    await until(
        () => inPage<boolean>(`return JSON.stringify(${button}?.disabled === false)`),
        `the Access menu of ${folder}`,
    );
    await inPage(`
        window.asked = [];
        window.confirm = (text) => {
            window.asked.push(text);

            return true;
        };
        ${button}.click();

        return JSON.stringify(true);
    `);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector(".at-level-menu") !== null)`,
            ),
        "its items",
    );
    await inPage(`
        [...document.querySelectorAll(".at-level-menu .at-level-item")]
            .find((each) => each.querySelector(".at-level-name").textContent.trim() === ${JSON.stringify(level)})
            .click();

        return JSON.stringify(true);
    `);
};

/** Where the Access menus of the rows of All folders are, on the page shown. */
/** Where All folders has its Access menus. */
const IN_ALL = ".pages-detail .ag-browse";

const browsed = () =>
    inPage<string[]>(`
    return JSON.stringify([...document.querySelectorAll(".pages-detail .ag-browse")].map((row) => {
        const toggle = row.querySelector(".ag-toggle");
        return toggle.title + (toggle.getAttribute("aria-expanded") === "true" ? " (open)" : "") + " | " +
            row.querySelector(".at-level").getAttribute("aria-label").split(": ").at(-1);
    }));
`);

const levels = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .at-level")].map((each) => each.getAttribute("aria-label")),
        );
    `);

/** From the cells currently drawn, keep the titles in row order. */
const sessionTitles = (name: string) =>
    gridCells(name).then((rows) => rows.map(([title]) => title));

const press = async (label: string) => {
    await inPage(`
        window.asked = [];
        window.confirm = (text) => {
            window.asked.push(text);

            return true;
        };
        return JSON.stringify(true);
    `);
    await tap(label);
};

const asked = () => inPage<string[]>(`return JSON.stringify(window.asked ?? [])`);

/** Whether the page shown has something called \`label\`. */
const has = (label: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(`.pages-detail [aria-label=${JSON.stringify(label)}]`)}) !== null)`,
    );

/**
 * One's own page as it is laid out: what its head holds, in order (the face, the title, each photo button, Sign out),
 * the parts of one's account under it, in order, whether the authenticator is the last thing on the page, and how far
 * Sign out's right edge is from the head's. Also any line of the page that says what a role does (`said`, which no page
 * has: "You/They prompt and start sessions…", "You/They read the sessions shared…", "They see every session…"), and
 * what comes first after the role line and the tabs (`next`: "name" for the Name row).
 */
const ownLayout = () =>
    inPage<{
        head: string[];
        body: string[];
        last: boolean;
        gap: number | null;
        said: string[];
        next: string | null;
    }>(`
        const page = document.querySelector(".pages-detail .sheet-page");
        const head = page.querySelector(".sheet-page-head");
        const parts = [
            [".my-name:not(.my-request)", "name"],
            [".my-request", "request access"],
            ['[role="switch"][aria-label^="Keep pinned sessions synced"]', "pin sync"],
            [".device-link", "device"],
            [".my-authenticator", "authenticator"],
        ];
        const out = head.querySelector(".my-signout button");
        let next = head.nextElementSibling?.nextElementSibling ?? null;

        while (next?.matches(".sheet-tabs, .sheet-pane")) {
            next = next.nextElementSibling;
        }

        return JSON.stringify({
            head: [...head.children].flatMap((each) =>
                each.matches(".people-here")
                    ? ["face"]
                    : each.matches(".sheet-page-title")
                      ? ["title"]
                      : each.matches(".my-photo, .sheet-page-actions")
                        ? [...each.querySelectorAll("button")].map((button) => button.textContent.trim())
                        : [each.className],
            ),
            body: [...page.querySelectorAll(parts.map(([selector]) => selector).join(", "))]
                .filter((each) => !head.contains(each))
                .map((each) => parts.find(([selector]) => each.matches(selector))[1]),
            last: page.lastElementChild?.matches(".my-authenticator") === true,
            gap: out ? head.getBoundingClientRect().right - out.getBoundingClientRect().right : null,
            said: [...page.querySelectorAll("p")]
                .map((each) => each.textContent.replace(/\\s+/g, " ").trim())
                .filter((each) => /(You|They) (prompt and start sessions|read the sessions shared|see every session)/.test(each)),
            next: next === null
                ? null
                : next.querySelector(".my-name:not(.my-request)")
                  ? "name"
                  : next.className || next.tagName,
        });
    `);

/** This machine's home folder, as the server says it while no test sets another (`asHome`). */
const realHome = homedir();

/**
 * Run `work` with `folder` as this server's home folder (`os.homedir`, read at each request): All folders starts in a
 * folder of the test's own. The page must load anew within `work` to learn it.
 */
async function asHome(folder: string, work: () => Promise<void>): Promise<void> {
    process.env.HOME = folder;

    try {
        await work();
    } finally {
        process.env.HOME = realHome;
    }
}

/** A browser of its own for whoever `token` signs in, signed in already; kept in `made`, for its test to close. */
async function ownBrowser(made: Browsers[], token: string): Promise<BrowserPage> {
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "people-sheet-reach-")),
        load: async () => undefined,
        save: () => {},
    });

    made.push(theirs);

    const opened = await theirs.open(1);

    await opened.navigate(`${base}/login?token=${encodeURIComponent(token)}`);

    return opened;
}

/**
 * A session on this server, in `cwd`, that `starter` started. `used`: how many hours ago the owner last sent to Pi in
 * it (`docs.ts` `SessionMeta.usedBy`). Left out, the session has no record of who used it: it counts as used by its
 * starter at its last activity, and by nobody else (`app.ts` `usedAt`).
 */
async function startedBy(
    title: string,
    starter: string,
    cwd = work,
    used?: number,
    by = owner(app).id,
): ReturnType<typeof newSession> {
    const id = await newSession(app, cwd);

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

        meta.title = title;
        meta.createdBy = starter;

        if (used !== undefined) {
            meta.usedBy = { [by]: Date.now() - used * 3_600_000 };
        }
    }, context);

    return id;
}

test(
    "a person's Computers rows open the same record as Computer, with one column and their People switch",
    real,
    async () => {
        const given = realpathSync(root);
        const second = app.config.addUser("Also chosen", "guest").user;

        try {
            await app.choosePerson(THIS_SERVER, second.id, true);
            await open("people");
            await show("Gina");
            assert.deepEqual(await shownParts(), ["Computers (shown)", "Permissions", "Chat"]);
            assert.deepEqual(await computerRows(), [
                ["This server", "Not chosen", true],
                ["Laptop", "Not chosen", true],
            ]);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".at-tree") !== null);`,
                ),
                false,
            );
            assert.deepEqual(await switches(), []);
            await showPart("Permissions");
            assert.deepEqual(await switches(), [
                "Gina can prompt: on",
                "Gina manages users: off",
                "Gina manages Pi Pocket: off",
                "Gina invites people: off",
                "Gina runs global commands: off",
                "Gina links runners: off",
                "Gina keeps sessions warm: off",
            ]);
            await flip("Gina keeps sessions warm");
            await until(
                () => app.config.userById(guest.id)?.rights?.includes("keepsWarm") === true,
                "keep warm on",
            );
            await until(
                async () => (await switches()).includes("Gina keeps sessions warm: on"),
                "the switch on",
            );
            await flip("Gina keeps sessions warm");
            await until(
                async () => (await switches()).includes("Gina keeps sessions warm: off"),
                "the switch off",
            );
            assert.notEqual(app.config.userById(guest.id)?.rights?.includes("keepsWarm"), true);

            await jump("Gina");
            assert.equal(
                await nothingHere(),
                "Gina may not use This server yet. Turn them on under People, below.",
            );
            assert.deepEqual(await columns(), []);
            await flip("Gina may use This server");
            await until(() => app.policy.mayUse(guest, THIS_SERVER), "the server to choose Gina");
            await until(async () => (await columns()).join() === "Gina", "Gina's column alone");
            assert.equal(await nothingHere(), "");
            assert.ok(
                (await has("People: 1 of 3 people")) ||
                    (await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".ak-tools")?.textContent.includes("1 of 3 people") ?? false);`,
                    )),
            );
            await view("People");
            await until(
                async () => (await computerRows())[0]?.[1] === "0 folders · 0 sessions",
                "the same person, now chosen",
            );
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".sheet-page-title").textContent.trim());`,
                ),
                "Gina",
            );
            await jump("Gina", "Laptop");
            await flip("Gina may use Laptop");
            await until(() => app.policy.mayUse(guest, runnerId), "Gina chosen for Laptop");
            await until(async () => (await columns()).join() === "Gina", "her Laptop column");
            assert.ok((await switches()).includes("Vera may use Laptop: off"));

            // All folders can give her a folder without a session of its own.
            await asHome(given, async () => {
                await open("people");
                await show("Gina");
                await jump("Gina");
                await press("Open All folders of This server");
                await until(
                    async () => (await browsed()).includes(`${given} | No access`),
                    "the home folder in All folders",
                );
                await choose("Gina", given, "Start sessions", IN_ALL);
                await until(
                    () => app.config.givenFolders(THIS_SERVER, guest.id).includes(given),
                    "the folder given",
                );
            });
            assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);
            await view("People");
            await until(
                async () => (await computerRows())[0]?.[1] === "1 folder · 0 sessions",
                "the folder count",
            );
            await jump("Gina");
            await until(
                async () =>
                    (await levels()).includes(
                        `Access of Gina to ${given} on This server: Start sessions`,
                    ),
                "the level in her column",
            );
        } finally {
            await app.removeUser(owner(app), second.id);
        }
    },
);
/** The folders of the grid shown in Computer, each by its full path (its toggle's title). */
const gridFolders = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .ag-group .ag-toggle")].map((each) => each.title),
        );
    `);

/** Open the folder of the grid at \`path\`, and each one above it. */
const openGrid = async (path: string) => {
    for (let round = 0; round < 12; round++) {
        const opened = await inPage<boolean>(`
            const path = ${JSON.stringify(path)};
            const row = [...document.querySelectorAll(".pages-detail .ag-group .ag-toggle")].find(
                (each) => each.getAttribute("aria-expanded") !== "true" && (each.title === path || path.startsWith(each.title + "/")),
            );

            row?.click();

            return JSON.stringify(row !== undefined);
        `);

        if (!opened) {
            return;
        }
    }
};

/** Each session row of the grid shown, by title, with what the cell of \`name\`'s column says. */
const gridCells = (name: string) =>
    inPage<[string, string][]>(`
        const at = [...document.querySelectorAll(".pages-detail .ag-head .ag-who-name")].findIndex(
            (each) => each.textContent.trim() === ${JSON.stringify(name)},
        );

        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .ag-session")].map((row) => [
                row.querySelector(".ag-title").textContent.trim(),
                [...([...row.querySelectorAll(".ag-cell")][at]?.children ?? [])]
                    .filter((each) => !each.classList.contains("ag-cell-who"))
                    .map((each) => each.textContent)
                    .join(" ")
                    .replace(/\\s+/g, " ")
                    .trim(),
            ]),
        );
    `);

/** The people columns of the grid shown in Computer: each one's name. */
const columns = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .ag-who-name")].map((each) => each.textContent.trim()),
        );
    `);

test(
    "a person's sessions sit under the folders given to them; each row is taken back alone, and a session opens from its row",
    real,
    async () => {
        const given = realpathSync(root);
        // Gina has this server and a folder there (the test before). She starts two sessions in it. The owner shares
        // two with her: one in that folder, and one outside every folder of hers.
        const stop = answerRequests(app, () => true);
        let first: number;
        let second: number;

        try {
            first = Number(
                (await app.commands.createSession(guest, { cwd: work, title: "Her first" })).id,
            );
            second = Number(
                (await app.commands.createSession(guest, { cwd: work, title: "Her second" })).id,
            );
        } finally {
            stop();
        }

        const share = async (cwd: string, title: string) => {
            const { id } = await app.commands.createSession(owner(app), { cwd, title });

            await app.commands.shareSession(id, owner(app), [guest.id]);

            return Number(id);
        };

        const shared = await share(work, "The owner's");
        const outside = await share(home, "Elsewhere");
        const listed = () => app.sessions(guest).map((each) => each.id);
        // In her folder, and the owner's alone: not hers until she sees every session there. The session Sam was
        // invited to (`before`) is the owner's and in that folder too.
        const unshared = Number(
            (await app.commands.createSession(owner(app), { cwd: work, title: "Not hers" })).id,
        );

        // Computer, the grid has a row for each folder there, and in Gina's column what she has of each session:
        // Revoke for one shared with her, "Started by them" for her own, Invite for one that is not hers.
        await open("computers");
        await show("This server");
        await until(async () => (await gridFolders()).includes(given), "her folder's row");
        await openGrid(given);
        await openGrid(realpathSync(work));
        await until(async () => (await gridCells("Gina")).length >= 5, "the sessions' rows");
        assert.deepEqual(
            Object.fromEntries(
                (await gridCells("Gina")).filter(([title]) =>
                    ["Her first", "Her second", "The owner's", "Not hers"].includes(title),
                ),
            ),
            {
                "Her first": "Started by them",
                "Her second": "Started by them",
                "The owner's": "Revoke",
                "Not hers": "Invite",
            },
        );

        // The folder's Access menu in her column: at All sessions she sees every session in it, whoever started it,
        // and the cell of one that becomes hers says so. Back at Start sessions, those leave her again, and only those.
        assert.ok(!listed().includes(unshared));
        assert.ok(
            (await levels()).includes(`Access of Gina to ${given} on This server: Start sessions`),
        );
        await choose("Gina", given, "All sessions");
        await until(() => listed().includes(unshared), "the server to let her see the folder");
        await until(
            async () =>
                (await gridCells("Gina")).some(
                    ([title, cell]) => title === "Not hers" && cell === "Through folder",
                ),
            "its cell to follow",
        );
        await choose("Gina", given, "Start sessions");
        await until(
            () => !listed().includes(unshared),
            "the server to take the folder's sessions back",
        );
        assert.deepEqual(listed().sort(), [first, second, shared, outside].sort());

        // One session is taken from her alone: the others, and her folder, stay.
        await press("Revoke The owner's from Gina");
        await until(() => !listed().includes(shared), "the server to stop sharing it");
        assert.ok(listed().includes(second) && listed().includes(first));
        assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);
        await until(
            async () =>
                (await gridCells("Gina")).some(
                    ([title, cell]) => title === "The owner's" && cell === "Invite",
                ),
            "its cell to turn to Invite",
        );

        // Select replaces the row Revoke for a session she started; it moves to the owner only after confirmation.
        await open("people");
        await show("Gina");
        await jump("Gina");
        await groupBy("Sessions");
        await until(() => has("Go to Her first"), "the session row");
        assert.equal(await has("Revoke Her first from Gina"), false);
        await tap("Select");
        await check("Select Her first");
        await inBar("Revoke (1)");
        assert.equal((await asked()).length, 1);
        assert.match((await asked())[0]!, /move.*to you/i);
        await until(() => !listed().includes(first), "the session taken from Gina");
        assert.equal(app.sessionMeta(first as ConversationId)?.createdBy, owner(app).id);
        assert.deepEqual(listed().sort(), [second, outside].sort());
        await tap("Done");
        const order = await sessionTitles("Gina");

        await press("Invite Gina to The owner's");
        await until(() => listed().includes(shared), "the share saved");
        await until(() => has("Revoke The owner's from Gina"), "the row becomes Revoke");
        assert.deepEqual(await sessionTitles("Gina"), order, "no row moved");
        assert.deepEqual(await asked(), []);
        await press("Revoke The owner's from Gina");
        await until(() => !listed().includes(shared), "the share taken back");
        await until(() => has("Invite Gina to The owner's"), "the row becomes Invite");
        assert.deepEqual(await sessionTitles("Gina"), order, "no row moved on revoke");

        // A session's row opens it, and the sheet closes.
        await press("Go to Her second");
        await until(
            async () =>
                await inPage<boolean>(`
                    const { store } = await import("/store.js");

                    return JSON.stringify(store.state.sheet === null && store.state.conversationId === ${second});
                `),
            "the session to open, and the sheet to close",
        );

        // One folder is taken from her alone: she stays chosen. The session she started in it goes with it, to who is
        // in charge (`app.ts` `handOver`), which its Remove says first; the one shared with her elsewhere stays.
        await open("people");
        await show("Gina");
        await jump("Gina");
        await groupBy("Folders");
        await choose("Gina", given, "No access");
        assert.equal((await asked()).length, 1);
        assert.match((await asked())[0]!, /The session they started in it moves to you/);
        assert.match((await asked())[0]!, /Sessions shared with them stay/);
        await until(
            () => app.config.givenFolders(THIS_SERVER, guest.id).length === 0,
            "the folder to be taken back",
        );
        assert.equal(app.policy.mayUse(guest, THIS_SERVER), true, "she is still chosen");
        await until(() => !listed().includes(second), "her session in that folder to move");
        assert.deepEqual(listed(), [outside]);
        await until(
            async () => !(await gridFolders()).includes(given),
            "no row for the folder with no session",
        );
        assert.deepEqual(
            (await levels()).filter((each) => !each.endsWith(": No access")),
            [],
            "nothing given",
        );
    },
);
test(
    "a computer's use record follows live, and links with no switch or column show everybody",
    real,
    async () => {
        await app.choosePeople(runnerId, []);
        await open("people");
        await show("Gina");
        assert.deepEqual(
            (await computerRows()).find(([name]) => name === "Laptop"),
            ["Laptop", "Not chosen", true],
        );
        await until(
            () =>
                inPage<boolean>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.connection === "open");`,
                ),
            "the tab receives events",
        );
        await app.choosePeople(runnerId, [guest.id]);
        await until(
            async () =>
                (await computerRows()).find(([name]) => name === "Laptop")?.[1] ===
                "0 folders · 0 sessions",
            "the row follows",
        );
        await jump("Gina", "Laptop");
        assert.ok((await switches()).includes("Gina may use Laptop: on"));
        await inPage(`
        const { openSheet } = await import("/store.js");
        openSheet({ type: "access", view: "computer", computer: ${JSON.stringify(runnerId)}, only: ${JSON.stringify(scoped.id)} });
        return JSON.stringify(true);
    `);
        await until(
            async () => (await columns()).join() === "Gina",
            "all columns for a link with no column or switch",
        );
        assert.equal(await nothingHere(), "");
    },
);

test(
    "a viewer without an authenticator cannot be let steer, and someone invited to one session is chosen nowhere",
    real,
    async () => {
        await open("people");
        await show("Vera");
        assert.deepEqual(await computerRows(), [
            ["This server", "Not chosen", true],
            ["Laptop", "Not chosen", true],
        ]);
        await showPart("Permissions");
        assert.deepEqual(await switches(), [
            "Vera can prompt: off (disabled)",
            "Vera may become a user and prompt: on (disabled)",
            "Vera chats with one person: off",
        ]);
        await jump("Vera");
        await flip("Vera may use This server");
        await until(() => app.policy.mayUse(viewer, THIS_SERVER), "the server to choose Vera");
        await groupBy("Folders");
        await until(
            async () => (await gridFolders()).includes(realpathSync(work)),
            "the folder in her grid",
        );
        assert.equal((await gridFolders())[0], homedir(), "Home is the top row");
        assert.equal(await says("All folders"), true);

        // Her menu has no Start sessions: each item says what she gets.
        const menu = () =>
            inPage<string[]>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".at-level-menu .at-level-item")].map((each) =>
                        each.querySelector(".at-level-name").textContent.trim() + ": " +
                        each.querySelector(".at-level-says").textContent.trim(),
                    ),
                );
            `);

        await inPage(`
            [...document.querySelectorAll(".pages-detail .at-level")]
                .find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(`Access of Vera to ${realpathSync(work)} `)}))
                .click();

            return JSON.stringify(true);
        `);
        await until(async () => (await menu()).length > 0, "her Access menu");
        assert.deepEqual(
            (await menu()).map((each) => each.split(":")[0]),
            ["No access", "Current sessions", "New sessions", "All sessions"],
        );
        assert.ok(
            (await menu()).every((each) => (each.split(": ")[1] ?? "").length > 0),
            "a line under each",
        );

        // All sessions: she reads every session in it, and starts nothing there.
        await inPage(`
            [...document.querySelectorAll(".at-level-menu .at-level-item")]
                .find((each) => each.textContent.includes("All sessions"))
                .click();

            return JSON.stringify(true);
        `);
        await until(
            () => app.config.seenFolders(THIS_SERVER, viewer.id).includes(realpathSync(work)),
            "the folder to be seen",
        );
        assert.equal(app.policy.mayStart(viewer, THIS_SERVER), false);
        await until(
            async () =>
                (await levels()).includes(
                    `Access of Vera to ${realpathSync(work)} on This server: All sessions`,
                ),
            "the row to say All",
        );
        await openGrid(work);
        await until(
            async () => (await gridCells("Vera")).some(([, cell]) => cell === "Through folder"),
            "she has the folder's sessions",
        );

        // No access takes it back, at once.
        await inPage(`
            window.confirm = () => true;
            [...document.querySelectorAll(".pages-detail .at-level")]
                .find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(`Access of Vera to ${realpathSync(work)} `)}))
                .click();

            return JSON.stringify(true);
        `);
        await until(async () => (await menu()).length > 0, "her Access menu again");
        await inPage(`
            [...document.querySelectorAll(".at-level-menu .at-level-item")]
                .find((each) => each.textContent.includes("No access"))
                .click();

            return JSON.stringify(true);
        `);
        await until(
            () => app.config.seenFolders(THIS_SERVER, viewer.id).length === 0,
            "the folder to be taken back",
        );
        assert.equal(app.config.givenFolders(THIS_SERVER, viewer.id).length, 0);

        // Someone limited to one session has no switch. Their other computer row cannot jump.
        await open("people");
        await show("Sam");
        assert.deepEqual(await computerRows(), [
            ["This server", "Invited to one session only · 1 session", true],
            ["Laptop", "Invited to one session only: nothing here.", false],
        ]);
        await showPart("Permissions");
        assert.deepEqual(await switches(), [
            "Sam can prompt: off (disabled)",
            "Sam may become a user and prompt: on (disabled)",
        ]);
        assert.equal(app.policy.mayUse(scoped, THIS_SERVER), false);
    },
);
test("an invite on a laptop jumps to its one column and Revoke takes it back", real, async () => {
    const boss = owner(app);
    const manager = app.config.addUser("Laptop manager", "guest");
    const laptop = app.config.addRunner("Invite laptop", boss.id, newIdentity().publicKey).id;
    const session = await startedBy("One laptop session", boss.id);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(session)]!.runner = laptop;
    }, context);

    const invited = app.config.addUser("One laptop invite", "viewer", [String(session)]).user;
    const made: Browsers[] = [];
    const owners = page;

    try {
        await app.choosePerson(laptop, manager.user.id, true);
        app.setRight(boss, {
            computer: laptop,
            person: manager.user.id,
            right: "manages",
            on: true,
        });
        await open("people");
        await show(invited.name);
        const rows = await computerRows();

        assert.deepEqual(
            rows.filter(([name]) => name !== "Laptop"),
            [
                ["This server", "Invited to one session only: nothing here.", false],
                ["Invite laptop", "Invited to one session only · 1 session", true],
            ],
        );
        await jump(invited.name, "Invite laptop");
        await groupBy("Sessions");
        assert.deepEqual(await columns(), [invited.name]);
        assert.equal(app.canSee(invited, session), true);
        await press(`Revoke One laptop session from ${invited.name}`);
        assert.deepEqual(await asked(), [
            `Take “One laptop session” from ${invited.name}? They were invited to it alone.`,
        ]);
        await until(() => !app.canSee(invited, session), "the invite revoked");
        await until(
            async () => !(await columns()).includes(invited.name),
            "the invited person's column goes away",
        );
        assert.equal(await nothingHere(), "");
        await view("People");
        await until(
            async () =>
                (await computerRows()).some(
                    ([name, line, jumps]) =>
                        name === "Invite laptop" &&
                        line === "Invited to one session only: nothing here." &&
                        !jumps,
                ),
            "the row without a jump",
        );

        page = await ownBrowser(made, manager.token);
        await open("people");
        await show(boss.name);
        await until(
            async () => (await computerRows()).length > 0,
            "the linker on a manager's page",
        );
        assert.deepEqual(
            (await computerRows()).find(([name]) => name === "Invite laptop"),
            ["Invite laptop", "In charge here: every session there is theirs.", false],
        );
    } finally {
        page = owners;
        await Promise.all(made.map((each) => each.closeAll({ final: true })));
        await app.harness.commit(async (tx) => {
            delete (await tx.doc(SessionsDoc)).items[String(session)];
        }, context);
        await app.unlinkRunner(laptop);
        await app.removeUser(boss, invited.id);
        await app.removeUser(boss, manager.user.id);
    }
});

test(
    "a runner someone else linked is the owner's to read, not to change, and no choice in People",
    real,
    async () => {
        // Gina may link her own, and did; she chose Vera for it.
        const ginas = app.config.addRunner("Gina's desktop", guest.id, newIdentity().publicKey).id;

        app.config.setUsers(ginas, [viewer.id]);

        try {
            await open("computers");
            await show("Gina's desktop");

            const shown = await inPage<{
                row: string;
                tabs: string[];
                note: string;
                actions: string[];
                switches: number;
                text: string;
            }>(`
                const row = [...document.querySelectorAll(".pages-item")].find((each) =>
                    each.querySelector(".pages-item-title").textContent.startsWith("Gina's desktop"),
                );

                return JSON.stringify({
                    row: row.textContent.replace(/\\s+/g, " ").trim(),
                    tabs: [...document.querySelectorAll(".pages-detail .sheet-tabs [role=tab]")].map((each) => each.textContent.trim()),
                    note: document.querySelector('.pages-detail [data-part="read-only"]')?.textContent.replace(/\\s+/g, " ").trim() ?? "",
                    actions: [...document.querySelectorAll(".pages-detail .sheet-page-actions button")].map((each) => each.textContent.trim()),
                    switches: document.querySelectorAll(".pages-detail [role=switch], .pages-detail input").length,
                    text: document.querySelector(".pages-detail").textContent,
                });
            `);

            assert.match(shown.row, /Gina$/, "the list says whose it is");
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pages-detail .ag-scroll, .pages-detail .ak-tools") !== null)`,
                ),
                false,
                "no grid and no tools: who has what there is not the owner's to know",
            );
            assert.deepEqual(shown.tabs, [], "one part to read: no People or Settings");
            assert.equal(
                shown.note,
                "Linked by Gina, who is in charge of it. You do not use it, and see nothing on it. You can unlink it.",
            );
            assert.deepEqual(shown.actions, ["Unlink"]);
            assert.equal(shown.switches, 0, "nothing to switch or type");
            assert.doesNotMatch(shown.text, /Vera/, "its people are not the owner's to know");
            assert.doesNotMatch(
                shown.text,
                /Tools on this computer|Start its runner|At a glance/,
                "no heading with nothing under it, and no step that is its linker's to take",
            );

            // In People, a computer the owner cannot use has no row.
            await open("people");
            await show("Vera");
            assert.deepEqual(
                (await computerRows()).map(([name]) => name),
                ["This server", "Laptop"],
            );
            assert.doesNotMatch(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pages-detail").textContent)`,
                ),
                /Gina's desktop/,
            );

            // Back in Computer: Gina chooses the owner there, and lets them share what they were given. The note
            // says that they give the folders given to them, and where.
            await open("computers");
            await show("Gina's desktop");
            app.config.setUsers(ginas, [viewer.id, owner(app).id]);
            app.setRight(guest, {
                computer: ginas,
                person: owner(app).id,
                right: "reshares",
                on: true,
            });
            await until(
                async () =>
                    (await inPage<string>(
                        `return JSON.stringify(document.querySelector('.pages-detail [data-part="read-only"]')?.textContent.replace(/\\s+/g, " ").trim() ?? "")`,
                    )) ===
                    "Linked by Gina, who is in charge of it: only they choose its people and change its settings. You share your sessions here, and give the folders given to you. You can unlink it.",
                "the note for who shares what they were given",
            );
        } finally {
            await app.unlinkRunner(ginas);
        }
    },
);

test(
    "a computer whose linker was made a viewer says it is blocked, and why, until they are a user again",
    real,
    async () => {
        const ginas = app.config.addRunner("Gina's desktop", guest.id, newIdentity().publicKey).id;
        const read = () =>
            inPage<{
                row: string;
                status: string;
                note: string;
                role: string;
                readOnly: string;
                tabs: string[];
                actions: string[];
            }>(`
                const row = [...document.querySelectorAll(".pages-item")].find((each) =>
                    each.querySelector(".pages-item-title").textContent.startsWith("Gina's desktop"),
                );
                const words = (element) => element?.textContent.replace(/\\s+/g, " ").trim() ?? "";
                const note = document.querySelector('.pages-detail [data-part="blocked"]');

                return JSON.stringify({
                    row: words(row),
                    status: words(document.querySelector(".pages-detail .ac-head .muted")),
                    note: words(note),
                    role: note?.getAttribute("role") ?? "",
                    readOnly: words(document.querySelector('.pages-detail [data-part="read-only"]')),
                    tabs: [...document.querySelectorAll(".pages-detail .sheet-tabs [role=tab]")].map((each) => each.textContent.trim()),
                    actions: [...document.querySelectorAll(".pages-detail .sheet-page-actions button")].map((each) => each.textContent.trim()),
                });
            `);

        try {
            // The owner makes Gina, who linked it, a viewer (`access.ts` `blocked`).
            app.setAccess(owner(app), guest.id, { role: "viewer" });
            assert.equal(app.policy.blocked(ginas), true);
            await open("computers");
            await show("Gina's desktop");

            const blocked = await read();

            assert.match(blocked.row, /Blocked/, "the list says so");
            assert.match(blocked.row, /Gina$/, "and whose it is");
            assert.match(blocked.status, /^Blocked/);
            assert.equal(
                blocked.note,
                "Gina's desktop is blocked: Gina, who linked it, is a viewer now. Nothing starts or runs there until they are made a user. You can make them a user in People, or unlink it.",
            );
            assert.equal(blocked.role, "alert");
            assert.equal(
                blocked.readOnly,
                "",
                "nobody is in charge of it: no line that says Gina is",
            );
            assert.deepEqual(blocked.tabs, [], "no People or Settings");
            assert.deepEqual(blocked.actions, ["Unlink"], "no New session");

            // A user again: it is hers as before, and nothing says blocked.
            app.config.giveRole(guest.id, "guest");
            app.accessChanged();
            assert.equal(app.policy.blocked(ginas), false);
            await open("computers");
            await show("Gina's desktop");

            const back = await read();

            assert.equal(back.note, "");
            assert.doesNotMatch(back.row, /Blocked/);
            assert.doesNotMatch(back.status, /Blocked/);
            assert.match(back.readOnly, /Linked by Gina, who is in charge of it/);
        } finally {
            app.config.giveRole(guest.id, "guest");
            app.accessChanged();
            await app.unlinkRunner(ginas);
        }
    },
);

test(
    "the owner's Settings page keeps what holds for everyone, and no page lists approvals",
    real,
    async () => {
        await open("settings");
        await show("Settings");
        assert.deepEqual(await switches(), ["Tasks expire with the session: off", "Project chat"]);
        await flip("Tasks expire with the session");
        await until(() => app.config.server.tasksExpire === true, "the server to keep the choice");
        await until(
            async () => (await switches()).includes("Tasks expire with the session: on"),
            "the switch to show it",
        );
        await flip("Tasks expire with the session");
        await until(() => app.config.server.tasksExpire !== true, "the choice to be taken back");

        // An approval kept on the server is listed nowhere: not here, not on a person, not under a computer.
        await inPage(`
            const { store } = await import("/store.js");

            store.set({
                folderApprovals: [{
                    session: "901", title: "Some session", folder: "/home/someone/project", computer: "this-server",
                    lastUser: store.state.me.id, name: "Owner", method: "owner", usedAt: Date.now(), expiresAt: null,
                    ended: false,
                }],
            });
            await new Promise((resolve) => setTimeout(resolve, 200));

            return JSON.stringify(true);
        `);

        for (const [sheet, item] of [
            ["settings", "Settings"],
            ["settings", "This server"],
            ["people", "Owner"],
            ["computers", "This server"],
        ] as const) {
            await open(sheet);
            await show(item);
            assert.doesNotMatch(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".sheet").textContent)`,
                ),
                /Session approvals|Approvals\s*\d|allowed in the app|Some session/,
                `${sheet}: ${item}`,
            );
        }

        // A computer's page in Settings: how long each person's approvals last, and the computer's own settings: here
        // its downloads folder, and its tools once the server answers.
        await open("settings");
        await show("This server");

        const titles = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .group-title")].map((each) => each.textContent.trim()))`,
            );

        await until(async () => (await titles()).length === 2, "its tools");
        assert.deepEqual(
            await titles(),
            ["Approvals last", "Tools on this computer"],
            "a computer's settings",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .sheet-pane .setting")].map((each) => [...each.querySelectorAll(".small, button")].map((part) => part.textContent.trim())))`,
            ),
            [
                [
                    "Downloads",
                    "Temporary folder, which can be cleared when the computer restarts",
                    "Change",
                ],
            ],
        );
    },
);

test(
    "one's own page signs in another device, and a new link ends the one before; the owner's page for someone else signs in a device of theirs",
    real,
    async () => {
        const part = (what: string) =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector('.pages-detail [data-part="device-link"] ${what}')?.${what.startsWith("input") ? "value" : "textContent"}.trim() ?? null)`,
            );
        const press = (label: string) =>
            inPage(`
                [...document.querySelectorAll('.pages-detail [data-part="device-link"] button')]
                    .find((each) => each.textContent.trim() === ${JSON.stringify(label)})
                    .click();

                return JSON.stringify(true);
            `);
        const live = () =>
            (
                JSON.parse(readFileSync(app.config.file, "utf8")) as {
                    invites?: { device?: true }[];
                }
            ).invites?.filter((each) => each.device === true).length ?? 0;

        // Someone else's page, for the owner: a link that signs a device in as them, for a lost device.
        await open("people");
        await show("Vera");
        await showPart("Permissions");
        assert.equal(await part(".small"), "Sign in a device of theirs", "also on a viewer's page");
        // The part shown stays from one person to the next.
        await show("Gina");
        assert.equal(await part(".small"), "Sign in a device of theirs");
        assert.equal(live(), 0, "nothing is made until asked");
        await press("Make a link");
        await until(async () => (await part("input.mono")) !== null, "Gina's link");
        assert.match(
            (await part(".muted"))!,
            /^Give this only to Gina: it signs a device in as them\./,
        );

        const hers = await fetch((await part("input.mono"))!, {
            method: "POST",
            redirect: "manual",
            body: "",
            headers: { "content-type": "application/x-www-form-urlencoded" },
        });

        assert.equal(
            app.config.userByToken(
                decodeURIComponent(
                    /pocket_auth=([^;]+)/.exec(hers.headers.get("set-cookie") ?? "")![1]!,
                ),
            )?.id,
            guest.id,
            "the device is Gina, not the owner who made the link",
        );
        await press("Done");
        await until(async () => (await part("input.mono")) === null, "Gina's link to go");
        assert.equal(live(), 0, "used, so nothing is left");

        // The invite sheet no longer signs the owner's device in.
        assert.ok(
            !(await inPage<boolean>(
                `const { openSheet } = await import("/store.js"); openSheet({ type: "invite" }); await new Promise((resolve) => setTimeout(resolve, 400)); return JSON.stringify(document.querySelector(".sheet").textContent.includes("Sign in as me"))`,
            )),
        );

        await open("people");
        await show("Owner");
        assert.equal(await part(".small"), "Sign in another device");
        assert.equal(live(), 0, "nothing is made until asked");

        await press("Make a link");
        await until(async () => (await part("input.mono")) !== null, "the link");

        const first = (await part("input.mono"))!;

        assert.match(first, /\/join\/[a-z0-9]{10}$/);
        assert.equal(live(), 1);
        assert.match((await part(".invite-code-head span"))!, /^Sign-in code$/);
        assert.match((await part(".muted"))!, /It signs in as you, so keep it to yourself\./);

        // It signs a device in as the owner, with a token of its own.
        const signed = await fetch(first, {
            method: "POST",
            redirect: "manual",
            body: "",
            headers: { "content-type": "application/x-www-form-urlencoded" },
        });
        const cookie = decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(signed.headers.get("set-cookie") ?? "")![1]!,
        );

        assert.equal(app.config.userByToken(cookie)?.id, owner(app).id);
        assert.notEqual(cookie, app.config.ownerToken);

        // A new link ends the one shown; Done ends that one too, and the page is as it was.
        await press("New link");
        await until(async () => {
            const now = await part("input.mono");

            return now !== null && now !== first;
        }, "another link");
        assert.equal(live(), 1, "the one before ended, used or not");
        await press("Done");
        await until(async () => (await part("input.mono")) === null, "the link to go");
        await until(() => live() === 0, "the server to end it");

        // On a phone it fits the screen.
        await open("people", VIEWPORTS.mobile);
        await show("Owner");
        await press("Make a link");
        await until(async () => (await part("input.mono")) !== null, "the link on a phone");
        assert.deepEqual(
            await inPage<string[]>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".sheet-body *")]
                        .filter((each) => each.getBoundingClientRect().right > innerWidth + 1)
                        .map((each) => each.className),
                );
            `),
            [],
        );
        await press("Done");
        await until(() => live() === 0, "the server to end the phone's");
    },
);

test(
    "on a phone the jump brings the computer into sight, and the rows and grid controls fit",
    real,
    async () => {
        // The sheet zooms in on open. Measure the final targets, not the animated size.
        const still = () =>
            inPage(`
            const sheet = document.querySelector(".access-sheet");
            const motions = sheet.getAnimations({ subtree: true }).filter((each) => each.effect.getTiming().iterations !== Infinity);
            await Promise.all(motions.map((each) => each.finished.catch(() => undefined)));
            return JSON.stringify(true);
        `);

        await open("people", VIEWPORTS.mobile);
        await show("Gina");
        await still();
        const targets = await inPage<number[]>(
            `return JSON.stringify([...document.querySelectorAll("button.person-computer")].map((row) => row.getBoundingClientRect().height));`,
        );

        assert.ok(
            targets.length > 0 && targets.every((height) => height >= 44),
            JSON.stringify(targets),
        );
        await jump("Gina");
        await groupBy("Folders");
        await openGrid(work);
        await until(() => has("Go to Her second"), "the sessions drawn");
        await still();
        const phone = await inPage<{
            columns: number;
            wider: string[];
            small: string[];
            visible: boolean;
        }>(`
        const head = document.querySelector(".ac-computer .sheet-page-head").getBoundingClientRect();
        return JSON.stringify({
            columns: getComputedStyle(document.querySelector(".pages-split")).gridTemplateColumns.split(" ").length,
            wider: [...document.querySelectorAll(".sheet-body *")]
                .filter((each) => each.getBoundingClientRect().right > innerWidth + 1 && !${INSIDE_SCROLLER}(each))
                .map((each) => each.className),
            small: [...document.querySelectorAll(".ag-table button")].filter((each) => each.getBoundingClientRect().height < 40).map((each) => each.className),
            visible: head.bottom > 0 && head.top < innerHeight,
        });
    `);

        assert.deepEqual(phone, { columns: 1, wider: [], small: [], visible: true });
    },
);

test(
    "a group's title on a page starts where the page's rows start, People and Computer",
    real,
    async () => {
        /** Each group title's left edge, relative to its card's rows or to the page. */
        const titles = () =>
            inPage<[string, number][]>(`
                const detail = document.querySelector(".pages-detail .sheet-page");
                const start = (each) => {
                    const range = document.createRange();

                    range.selectNodeContents(each);

                    return range.getBoundingClientRect().left;
                };

                // A title inside the grid's box (its People, under the rows) starts where that box's rows start.
                return JSON.stringify(
                    [...detail.querySelectorAll(".group-title")].filter((each) => !each.closest(".ag-scroll")).map((each) => {
                        const row = each.closest('[data-part="computer"]')?.querySelector(":scope > .setting > .grow");

                        return [each.textContent.trim(), Math.round(start(each) - (row ?? detail).getBoundingClientRect().left)];
                    }),
                );
            `);

        for (const viewport of [DESKTOP, VIEWPORTS.mobile]) {
            // One's own page: the Authenticator group.
            await open("people", viewport);
            await until(
                async () => (await titles()).some(([title]) => title === "Authenticator"),
                "the Authenticator group",
            );
            assert.deepEqual(await titles(), [["Authenticator", 0]]);

            // Someone else's, as the owner sees it: every group of theirs, in each part of their page.
            await show("Gina");
            await until(
                async () => (await titles()).some(([title]) => title === "New sessions"),
                "Gina's New sessions group",
            );

            const places = await titles();

            await showPart("Permissions");
            await until(
                async () => (await titles()).some(([title]) => title === "Sign-in"),
                "Gina's permissions",
            );

            const rules = await titles();

            assert.deepEqual(
                places.map(([title]) => title),
                ["Computers", "New sessions"],
            );
            assert.deepEqual(
                rules.map(([title]) => title),
                ["Account", "Pi Pocket", "This server", "Laptop", "Sign-in"],
            );

            for (const [title, from] of [...places, ...rules]) {
                assert.equal(from, 0, `"${title}" on Gina's page`);
            }

            // A computer's page in Settings is laid out the same way.
            await open("settings", viewport);
            await show("This server");
            await until(async () => (await titles()).length > 0, "the computer's groups");

            for (const [title, from] of await titles()) {
                assert.equal(from, 0, `"${title}" in Settings`);
            }
        }
    },
);

test(
    "an invite shares the open session first, then its folder, then my sessions, then the ones chosen; with no session open, my sessions",
    real,
    async () => {
        const id = await newSession(app);
        const options = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".sheet .invite-share .segmented button")].map((each) => each.textContent.trim() + (each.classList.contains("on") ? " (on)" : "")))`,
            );
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".sheet .invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const joinPage = async (invite: string | null) =>
            await (await fetch(`${base}/join/${invite}`)).text();

        const invite = async (path: string, ready: string) => {
            await page.setViewport(DESKTOP);
            await page.navigate(`${base}${path}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        `const { store } = await import("/store.js"); return JSON.stringify(document.querySelector('[data-part="app"]') !== null && (${ready}))`,
                    ),
                `the app at ${path}`,
                20_000,
            );
            await inPage(
                `const { openSheet } = await import("/store.js"); openSheet({ type: "invite" }); return JSON.stringify(true);`,
            );
            await until(async () => (await code()) !== null, "an invite");
        };

        // A session is open, and the owner may share it: the invite is to it alone until another is chosen.
        await invite(
            `/s/${String(id)}`,
            `store.state.view.conversation?.kind === "session" && store.state.sessions.some((each) => String(each.id) === ${JSON.stringify(String(id))} && each.mayShare === true)`,
        );
        assert.deepEqual(await options(), [
            "Only this session (on)",
            "This folder",
            "My sessions",
            "Custom",
        ]);
        // What the choice is of shows beside the choices: the session's name, then the folder.
        const beside = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".sheet .invite-what")?.getAttribute("title") ?? null)`,
            );

        assert.equal(
            await beside(),
            await inPage<string>(
                `const { store } = await import("/store.js"); return JSON.stringify(store.state.sessions.find((each) => String(each.id) === ${JSON.stringify(String(id))}).title || "New session")`,
            ),
            "the session's name",
        );

        const first = await code();

        assert.match(await joinPage(first), /the session “/);

        // This folder: the invite shown ends, and the new one is to the session's folder.
        await inPage(
            `[...document.querySelectorAll(".sheet .invite-share .segmented button")].find((each) => each.textContent.trim() === "This folder").click(); return JSON.stringify(true);`,
        );
        await until(async () => ![null, first].includes(await code()), "the folder's invite");
        assert.deepEqual(await options(), [
            "Only this session",
            "This folder (on)",
            "My sessions",
            "Custom",
        ]);

        const second = await code();

        assert.equal(await beside(), app.cwdOf(id), "the folder of This folder");

        assert.ok(
            (await joinPage(second)).includes("the sessions shared with you in the folder "),
            "an invite to the folder",
        );
        assert.equal((await fetch(`${base}/join/${first}`)).status, 410, "the one before ended");

        // No session open: My sessions, or Custom, and the invite is to the owner's sessions.
        await invite("/", `store.state.view.conversation == null`);
        assert.deepEqual(await options(), ["My sessions (on)", "Custom"]);
        assert.equal(await beside(), null);
        assert.ok(
            (await joinPage(await code())).includes("the sessions shared with you on this server"),
        );
        await inPage(
            `const { closeSheet } = await import("/store.js"); closeSheet(); return JSON.stringify(true);`,
        );
    },
);

test(
    "Custom gives the sessions checked: a folder's box checks its sessions, Make invite makes the invite, a change hides it, and whoever joins sees only those",
    real,
    async () => {
        const folders = [join(root, "custom-a"), join(root, "custom-b")];
        const made: Record<string, Awaited<ReturnType<typeof newSession>>> = {};

        for (const [folder, names] of [
            [folders[0]!, ["Custom A1", "Custom A2"]],
            [folders[1]!, ["Custom B1", "Custom B2"]],
        ] as const) {
            mkdirSync(folder, { recursive: true });

            for (const title of names) {
                const id = await newSession(app, folder);

                await app.harness.commit(async (tx) => {
                    (await tx.doc(SessionsDoc)).items[String(id)]!.title = title;
                }, context);
                made[title] = id;
            }
        }

        const options = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".sheet .invite-share .segmented button")].map((each) => each.textContent.trim() + (each.classList.contains("on") ? " (on)" : "")))`,
            );
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".sheet .invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const box = (label: string) =>
            `document.querySelector('.sheet [data-part="invite-chooser"] input[aria-label=${JSON.stringify(label).replace(/'/g, "\\'")}]')`;
        const state = (label: string) =>
            inPage<string | null>(
                `const box = ${box(label)}; return JSON.stringify(box === null ? null : box.indeterminate ? "mixed" : box.checked ? "on" : "off")`,
            );
        const check = (label: string) =>
            inPage(`${box(label)}.click(); return JSON.stringify(true);`);
        const makeButton = `[...document.querySelectorAll(".sheet button")].find((each) => each.textContent.trim() === "Make invite")`;
        const live = () =>
            (
                JSON.parse(readFileSync(app.config.file, "utf8")) as {
                    invites?: { device?: true }[];
                }
            ).invites?.filter((each) => each.device !== true).length ?? 0;

        await page.setViewport(DESKTOP);
        await page.navigate(`${base}/`);
        await until(
            async () =>
                await inPage<boolean>(
                    `const { store } = await import("/store.js"); return JSON.stringify(document.querySelector('[data-part="app"]') !== null && store.state.view.conversation == null && ${JSON.stringify(Object.values(made).map(String))}.every((id) => store.state.sessions.some((each) => String(each.id) === id && each.title.startsWith("Custom ") && each.mayShare === true)))`,
                ),
            "the app with the sessions to give",
            20_000,
        );
        await inPage(
            `const { openSheet } = await import("/store.js"); openSheet({ type: "invite" }); return JSON.stringify(true);`,
        );
        await until(async () => (await code()) !== null, "the invite to my sessions");

        // No session open: My sessions and Custom alone.
        assert.deepEqual(await options(), ["My sessions (on)", "Custom"]);

        const mine = await code();

        await inPage(
            `[...document.querySelectorAll(".sheet .invite-share .segmented button")].find((each) => each.textContent.trim() === "Custom").click(); return JSON.stringify(true);`,
        );
        await until(async () => (await state("Give Custom A1")) === "off", "the chooser");
        assert.equal(await code(), null, "Custom shows no invite before Make invite");
        await until(
            async () => (await fetch(`${base}/join/${mine}`)).status === 410,
            "the invite to my sessions to end",
        );
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(${makeButton}.disabled)`),
            true,
            "nothing to make at 0 chosen",
        );

        // A folder's box checks every session in it; one session of the other folder leaves its box mixed.
        const before = live();

        await check(`Give every session in ${folders[0]!}`);
        await check("Give Custom B1");
        await until(async () => (await state("Give Custom B1")) === "on", "B1 to be checked");
        assert.deepEqual(
            await Promise.all(
                [
                    `Give every session in ${folders[0]!}`,
                    "Give Custom A1",
                    "Give Custom A2",
                    `Give every session in ${folders[1]!}`,
                    "Give Custom B2",
                ].map(state),
            ),
            ["on", "on", "on", "mixed", "off"],
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.sheet [data-part="invite-chooser"] .invite-count').textContent.trim())`,
            ),
            /^3 of \d+$/,
        );
        assert.equal(await code(), null, "no invite while the boxes change");
        assert.equal(live(), before, "and none was made");

        await inPage(`${makeButton}.click(); return JSON.stringify(true);`);
        await until(async () => (await code()) !== null, "the custom invite");
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".sheet").textContent)`,
            ),
            /Whoever joins sees the 3 sessions you chose\./,
        );

        const link = await inPage<string>(
            `return JSON.stringify(document.querySelector(".sheet .invite input.mono").value)`,
        );
        const first = await code();

        // Whoever joins with the link, in a browser of their own, sees the 3 sessions checked and no other.
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-custom-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const joiner = await theirs.open(1);

            await joiner.navigate(link);
            await joiner.evaluate(
                `document.querySelector("input[name=name]").value = "Custom Joe"; document.querySelector("form").submit(); return null;`,
            );

            const seen = async () =>
                JSON.parse(
                    await joiner.evaluate(
                        `if (document.querySelector('[data-part="app"]') === null) { return JSON.stringify(null); } const { store } = await import("/store.js"); return JSON.stringify(store.state.sessions.map((each) => each.title).sort());`,
                    ),
                ) as string[] | null;

            await until(async () => (await seen())?.length === 3, "Joe's 3 sessions", 20_000);
            assert.deepEqual(await seen(), ["Custom A1", "Custom A2", "Custom B1"]);
        } finally {
            await theirs.closeAll({ final: true });
        }

        // A change of the boxes hides the invite until Make invite is pressed again.
        await check("Give Custom B2");
        await until(async () => (await code()) === null, "the invite to hide");
        assert.equal(await state(`Give every session in ${folders[1]!}`), "on");
        await inPage(`${makeButton}.click(); return JSON.stringify(true);`);
        await until(
            async () => ![null, first].includes(await code()),
            "the invite for the 4 sessions",
        );
        assert.match(
            await (await fetch(`${base}/join/${await code()}`)).text(),
            /the 4 sessions chosen for you/,
        );
        await inPage(
            `const { closeSheet } = await import("/store.js"); closeSheet(); return JSON.stringify(true);`,
        );
    },
);

test(
    "after an invite a computer's switch says what the person has there: on where its maker is in charge, off with only the shared sessions where not",
    real,
    async () => {
        const hints = async () => (await computerRows()).map(([name, line]) => `${name}: ${line}`);

        const shown = async (name: string, first: string) => {
            await open("people");
            await show(name);
            // The sessions shared with them reach the page after it shows: the hint follows them.
            await until(
                async () => (await hints())[0] === first,
                `the hint of This server for ${name}`,
            );

            return await hints();
        };

        const laptop = "Laptop: Not chosen";

        // Hal joined with the owner's invite to their sessions. The owner is in charge of this server, so Hal is chosen
        // for it; nothing on the laptop became his.
        const hal = app.config.addUser("Hal", "viewer").user;
        const on = `This server: 0 folders · ${app.sessions(owner(app)).filter((row) => !row.runner && !row.archived && row.createdBy === owner(app).id).length} sessions`;

        await app.welcome(hal.id, owner(app).id);
        assert.ok(app.sessions(hal).length > 0, "the owner's sessions are shared with Hal");
        assert.deepEqual(await shown("Hal", on), [on, laptop]);

        // Its switch takes them back.
        const nothing = "This server: Not chosen";

        await app.choosePerson(THIS_SERVER, hal.id, false);
        assert.equal(app.sessions(hal).length, 0, "off: nothing of it is his");
        assert.deepEqual(await shown("Hal", nothing), [nothing, laptop]);

        // Greta is chosen here and in charge of nothing. Hank joined with her invite: her session is shared with him,
        // and choosing him stays the owner's.
        const greta = app.config.addUser("Greta", "guest").user;
        const hank = app.config.addUser("Hank", "viewer").user;
        const { id } = await app.commands.createSession(owner(app), {
            cwd: work,
            title: "Greta's",
        });
        const only = "This server: Not chosen · 1 session shared";

        await app.choosePerson(THIS_SERVER, greta.id, true);
        await app.harness.commit(async (tx) => {
            (await tx.doc(SessionsDoc)).items[String(id)]!.createdBy = greta.id;
        }, context);
        await app.welcome(hank.id, greta.id);
        assert.equal(app.sessions(hank).length, 1, "Greta's session is shared with Hank");
        assert.deepEqual(await shown("Hank", only), [only, laptop]);
    },
);

test(
    "People opens on one's own page for a viewer too, not on the owner's: their account is there, and only there",
    real,
    async () => {
        const { user, token } = app.config.addUser("Nora", "viewer");

        /** The rows of one's own account on the page shown, in order; Sign out, in the head, last. */
        const rows = async () => {
            const { head, body } = await ownLayout();

            return [...body, ...(head.includes("Sign out") ? ["sign out"] : [])];
        };

        const title = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".sheet-page-title").textContent.replace(/\\s+/g, " ").trim())`,
            );
        const listed = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-item-title")].map((each) => each.textContent.trim()))`,
            );
        // A browser of their own: a login link in one signed in as someone else asks before it switches.
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-viewer-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;

        try {
            page = await theirs.open(1);
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await open("people");
            assert.equal(
                await inPage<string>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.me.id)`,
                ),
                user.id,
                "signed in as the viewer",
            );
            assert.ok(
                (
                    await inPage<string>(
                        `return JSON.stringify(document.querySelector(".sheet-page-title").textContent.trim())`,
                    )
                ).startsWith("Nora"),
                "their own page",
            );
            await until(async () => (await rows()).includes("authenticator"), "the authenticator");
            // No photo button in the head: Sign out alone, at its right. Then Name, Request access, Authenticator.
            const layout = await ownLayout();

            assert.deepEqual(layout.head, ["face", "title", "Sign out"]);
            assert.deepEqual(layout.body, ["name", "request access", "authenticator"]);
            assert.equal(layout.last, true, "the authenticator is last");
            assert.deepEqual(layout.said, [], "no line of what a viewer does");
            assert.equal(layout.next, "name", "Name first under the role line");
            assert.ok(
                layout.gap !== null && Math.abs(layout.gap) <= 2,
                `Sign out at the right: ${layout.gap}`,
            );

            // A viewer has no list of the people here: their own row alone.
            assert.deepEqual(
                await inPage<string[]>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-item")].filter((each) => each.querySelector(".people-here")).map((each) => each.querySelector(".pages-item-title").textContent.trim()))`,
                ),
                ["Nora (you)"],
            );

            // A new name: Save is offered only for a change, and the list and the page head show it.
            const field = (value: string) =>
                inPage(`
                const input = document.querySelector(".pages-detail .my-name input");

                input.value = ${JSON.stringify(value)};
                input.dispatchEvent(new Event("input", { bubbles: true }));

                return JSON.stringify(true);
            `);
            const saveOff = () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pages-detail .my-name button").disabled)`,
                );

            assert.equal(await saveOff(), true, "the same name");
            await field("   ");
            assert.equal(await saveOff(), true, "no name");
            await field(" Nora B ");
            assert.equal(await saveOff(), false);
            await inPage(
                `document.querySelector(".pages-detail .my-name button").click(); return JSON.stringify(true);`,
            );
            await until(
                async () => (await title()).startsWith("Nora B (you)"),
                "the new name on the page",
            );
            await until(
                async () => (await listed()).includes("Nora B (you)"),
                "the new name in the list",
            );
            assert.equal(app.config.userById(user.id)?.name, "Nora B");
            assert.equal(await saveOff(), true, "saved: nothing more to save");

            // The round button at the bottom of the rail opens People on their own page.
            await inPage(
                `const { closeSheet } = await import("/store.js"); closeSheet(); return JSON.stringify(true);`,
            );
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".sheet") === null)`,
                    ),
                "People to close",
            );
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".rail-me").getAttribute("aria-label"))`,
                ),
                "Your account",
            );
            await inPage(
                `document.querySelector(".rail-me").click(); return JSON.stringify(true);`,
            );
            await until(
                async () => (await rows()).includes("sign out"),
                "their own page from the rail",
            );
            assert.ok((await title()).startsWith("Nora B"));

            // Sign out signs this device out.
            await inPage(
                `document.querySelector(".pages-detail .my-signout button").click(); return JSON.stringify(true);`,
            );
            await until(
                async () =>
                    inPage<boolean>(`return JSON.stringify(document.readyState === "complete" &&
                    (await import("/store.js")).store.state.me === null &&
                    (await fetch("/api/me")).status === 401)`).catch(() => false),
                "signed out",
            );
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            await theirs.closeAll({ final: true });
        }
    },
);

test(
    "a user's own page: the photo buttons and Sign out in its head, then Name, pin sync, another device, and the authenticator last, also on a phone",
    real,
    async () => {
        const { user, token } = app.config.addUser("Lee", "guest");
        const made: Browsers[] = [];
        const owners = page;
        const photo = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64",
        );

        /** Their own page, opened anew at `viewport`, once its authenticator group is drawn. */
        const ownPage = async (viewport = DESKTOP) => {
            await open("people", viewport);
            await until(
                async () => (await ownLayout()).body.includes("authenticator"),
                "Lee's own page",
            );
        };

        /**
         * The lines of the head: how far the vertical middles of Sign out and of the photo buttons are from the title's,
         * the top of the photo buttons and of Sign out less the bottom of the title, and how far Sign out's right edge is
         * from the head's. Null for a part that is not there.
         */
        const lines = () =>
            inPage<{
                outMiddle: number;
                photoMiddle: number | null;
                photoTop: number | null;
                outTop: number;
                outRight: number;
            }>(`
                await Promise.all(document.getAnimations().map((each) => each.finished.catch(() => {})));
                const head = document.querySelector(".pages-detail .sheet-page-head");
                const title = head.querySelector(".sheet-page-title").getBoundingClientRect();
                const out = head.querySelector(".my-signout button").getBoundingClientRect();
                const photo = head.querySelector(".my-photo")?.getBoundingClientRect() ?? null;
                const middle = (box) => box.top + box.height / 2;

                return JSON.stringify({
                    outMiddle: middle(out) - middle(title),
                    photoMiddle: photo && middle(photo) - middle(title),
                    photoTop: photo && photo.top - title.bottom,
                    outTop: out.top - title.bottom,
                    outRight: head.getBoundingClientRect().right - out.right,
                });
            `);

        /**
         * On a phone: what in the head runs past the screen's edge, and whether a click at the middle of Sign out, once
         * it is in view, hits it.
         */
        const phone = () =>
            inPage<{ wider: string[]; hit: boolean }>(`
                await Promise.all(document.getAnimations().map((each) => each.finished.catch(() => {})));
                const head = document.querySelector(".pages-detail .sheet-page-head");
                const out = head.querySelector(".my-signout button");

                // On a phone the page stands under the list: brought into view, as a finger scrolls to it.
                out.scrollIntoView({ block: "center" });
                await new Promise((resolve) => requestAnimationFrame(resolve));
                const box = out.getBoundingClientRect();

                return JSON.stringify({
                    wider: [head, ...head.querySelectorAll("*")]
                        .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                        .map((each) => each.className || each.tagName),
                    hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("button") === out,
                });
            `);

        try {
            page = await ownBrowser(made, token);

            // Without a photo: Add photo alone, then Sign out at the head's right.
            await ownPage();

            const bare = await ownLayout();

            assert.deepEqual(bare.head, ["face", "title", "Add photo", "Sign out"]);
            assert.ok(
                bare.gap !== null && Math.abs(bare.gap) <= 2,
                `Sign out at the right: ${bare.gap}`,
            );
            assert.deepEqual(bare.body, ["name", "pin sync", "device", "authenticator"]);
            assert.equal(bare.last, true, "nothing after the authenticator");
            assert.deepEqual(bare.said, [], "no line of what a user does");
            assert.equal(bare.next, "name", "Name first under the role line");

            // Nor has another person's page, a user's, a viewer's, or the owner's: their title and role line, and no
            // line of what they do. Not under a chat either: Lee has none here, so no page is the chat alone.
            app.setRight(owner(app), { person: user.id, right: "chats", on: false });
            await ownPage();

            for (const [name, role] of [
                ["Gina", "user"],
                ["Vera", "viewer"],
                ["Owner", "owner"],
            ] as const) {
                await show(name);
                await until(
                    () =>
                        inPage<boolean>(`
                            const page = document.querySelector(".pages-detail .sheet-page");
                            const line = page?.querySelector(".sheet-page-head + .muted.small")?.textContent.trim() ?? "";

                            return JSON.stringify(
                                page.querySelector(".sheet-page-title").textContent.trim() === ${JSON.stringify(name)} &&
                                    line.startsWith(${JSON.stringify(role)}) &&
                                    page.querySelector(".loader") === null,
                            );
                        `),
                    `${name}'s page, loaded`,
                );
                // Its parts are drawn: what the page has to say, it says now.
                await new Promise((resolve) => setTimeout(resolve, 300));
                assert.deepEqual((await ownLayout()).said, [], `no line of what ${name} does`);
            }

            await ownPage();
            assert.equal(
                await inPage<string | null>(
                    `return JSON.stringify(document.querySelector(".pages-detail .my-photo button").title)`,
                ),
                "Shown in place of your initials, to everyone who can see you.",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-detail .setting .small")].some((each) => each.textContent.trim() === "Photo"))`,
                ),
                false,
                "no Photo row",
            );

            // With a photo: Change photo and Remove photo.
            app.setAvatar(user, photo);
            await ownPage();
            assert.deepEqual((await ownLayout()).head, [
                "face",
                "title",
                "Change photo",
                "Remove photo",
                "Sign out",
            ]);

            // On a wide screen the head is one line: the photo buttons and Sign out beside the title.
            const wide = await lines();

            assert.ok(
                Math.abs(wide.outMiddle) <= 2,
                `Sign out beside the title: ${JSON.stringify(wide)}`,
            );
            assert.ok(
                Math.abs(wide.photoMiddle ?? 99) <= 2,
                `the photo buttons beside the title: ${JSON.stringify(wide)}`,
            );

            // On a phone the head takes two lines: the name with Sign out at its right, then the photo buttons. Nothing
            // runs past the edge, and Sign out takes a click.
            for (const avatar of [photo, undefined]) {
                const said = `with${avatar ? "" : "out"} a photo`;

                app.setAvatar(user, avatar);
                await ownPage(VIEWPORTS.mobile);
                assert.deepEqual(await phone(), { wider: [], hit: true }, said);
                assert.ok(Math.abs((await ownLayout()).gap ?? 99) <= 2, "Sign out at the right");

                const two = await lines();

                assert.ok(
                    Math.abs(two.outMiddle) <= 2,
                    `${said}: Sign out on line 1: ${JSON.stringify(two)}`,
                );
                assert.ok(
                    (two.photoTop ?? -99) >= 0,
                    `${said}: the photo buttons on line 2: ${JSON.stringify(two)}`,
                );
            }

            // A long name wraps in its own place: Sign out stays on line 1, at the right, and nothing runs past the edge.
            app.config.updateUser(user.id, { name: "Bartholomew Featherstonehaugh-Montgomery" });
            app.setAvatar(user, photo);
            await ownPage(VIEWPORTS.mobile);
            assert.deepEqual(await phone(), { wider: [], hit: true }, "a long name");

            const long = await lines();

            assert.ok(long.outTop < 0, `a long name: Sign out on line 1: ${JSON.stringify(long)}`);
            assert.ok(
                Math.abs(long.outRight) <= 2,
                `a long name: Sign out at the right: ${JSON.stringify(long)}`,
            );
            assert.ok(
                (long.photoTop ?? -99) >= 0,
                `a long name: the photo buttons below: ${JSON.stringify(long)}`,
            );
        } finally {
            page = owners;
            await Promise.all(made.map((each) => each.closeAll({ final: true })));
            await app.removeUser(owner(app), user.id);
        }

        // Someone else's page has no Sign out and no photo buttons, and its line comes under its parts.
        await open("people");
        await show("Vera");

        const theirs = await ownLayout();

        assert.equal(theirs.head.includes("Sign out"), false);
        assert.equal(
            theirs.head.some((each) => each.endsWith("photo")),
            false,
        );
        assert.deepEqual(
            theirs.body.filter((each) => each !== "device"),
            [],
        );
        assert.equal(theirs.last, false);
    },
);

test("a viewer's own page shows only their account essentials on a phone", real, async () => {
    const full = app.config.addUser("Rae", "guest");
    const temporary = app.config.addUser("Tess", "viewer", undefined, true);
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "people-sheet-viewer-")),
        load: async () => undefined,
        save: () => {},
    });
    const owners = page;

    // A photo set while they were a user stays in the page head.
    app.setAvatar(
        full.user,
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64",
        ),
    );
    app.setAccess(owner(app), full.user.id, { role: "viewer" });

    try {
        page = await theirs.open(1);

        for (const { user, token } of [full, temporary]) {
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);

            if (!user.temporary) {
                // This browser had sync on while the viewer was a user.
                await inPage(`
                    localStorage.setItem("pocket.pinned.synced", ${JSON.stringify(user.id)});
                    return JSON.stringify(true);
                `);
            }

            await open("people", VIEWPORTS.mobile);
            await until(
                () =>
                    inPage<boolean>(`
                        return JSON.stringify(document.querySelector('.pages-detail input[aria-label="Name"]')?.value === ${JSON.stringify(user.name)});
                    `),
                `${user.name}'s own page`,
            );

            if (user.temporary) {
                // Give the sheet's authenticator request time to finish before checking that it showed nothing.
                await inPage(`
                    const { api } = await import("/store.js");
                    await api("me/authenticator");
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    return JSON.stringify(true);
                `);
            } else {
                await until(
                    () =>
                        inPage<boolean>(`
                            return JSON.stringify(document.querySelector(".pages-detail .my-authenticator") !== null &&
                                document.querySelector(".pages-detail .sheet-page-head .avatar-img")?.naturalWidth > 0);
                        `),
                    "the authenticator group and the saved photo in the page head",
                );
            }

            const detail = await inPage<{
                width: number;
                height: number;
                buttons: string[];
                deviceLink: boolean;
                pinSync: boolean;
                authenticator: string | null;
                wider: string[];
            }>(`
                const detail = document.querySelector(".pages-detail .sheet-page");

                return JSON.stringify({
                    width: innerWidth,
                    height: innerHeight,
                    buttons: [...detail.querySelectorAll("button")].map((each) => each.textContent.trim()),
                    deviceLink: detail.querySelector('[data-part="device-link"]') !== null,
                    pinSync: detail.querySelector('[role="switch"][aria-label^="Keep pinned sessions synced"]') !== null,
                    authenticator: detail.querySelector(".my-authenticator .group-title")?.textContent.trim() ?? null,
                    wider: [detail, ...detail.querySelectorAll("*")]
                        .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                        .map((each) => each.className || each.tagName),
                });
            `);

            assert.ok(detail.buttons.includes("Request access"), "Request access is on the page");
            assert.ok(detail.buttons.includes("Sign out"), "Sign out is on the page");
            assert.deepEqual(
                detail.buttons.filter((label) => /^(Add|Change|Remove) photo$/.test(label)),
                [],
                "no photo buttons",
            );
            assert.equal(detail.deviceLink, false, "no Sign in another device");
            assert.equal(detail.pinSync, false, "no pin sync switch");
            assert.equal(
                await inPage<boolean>(`
                    const { pinsSynced } = await import("/theme.js");
                    return JSON.stringify(pinsSynced());
                `),
                false,
                "viewers keep pins local, even with a saved sync preference",
            );
            assert.equal(detail.authenticator, user.temporary ? null : "Authenticator");
            assert.deepEqual([detail.width, detail.height], [390, 844]);
            assert.deepEqual(detail.wider, [], "nothing on the page is wider than the phone");

            await tap("Sign out");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify((await fetch("/api/me")).status === 401)`,
                    ).catch(() => false),
                `${user.name} signed out`,
            );
        }
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
        await app.removeUser(owner(app), full.user.id);
        await app.removeUser(owner(app), temporary.user.id);
    }
});

test(
    "removing a user's authenticator shows paused until Keep as viewer is pressed",
    real,
    async () => {
        const { user } = app.config.addUser("Remy", "guest");

        linkAuthenticator(app, user);
        const role = () =>
            inPage<string>(`
            const row = [...document.querySelectorAll(".pages-item")]
                .find((each) => each.querySelector(".pages-item-title").textContent.trim() === "Remy");

            return JSON.stringify(row?.querySelector(".pages-item-text .small").textContent.trim().split(" · ")[0]);
        `);
        const text = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
            );
        const paused =
            "Paused: their authenticator was removed. They are a user again when they link one.";

        /** Tap a button of the page shown. One that shows while its page still saves takes no click: wait for it. */
        const tap = async (label: string) => {
            const found = `[...document.querySelectorAll(".pages-detail button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent.trim()) === ${JSON.stringify(label)} && !each.disabled)`;

            await until(
                () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
                `${label} taking a click`,
            );
            await inPage(`${found}.click(); return JSON.stringify(true);`);
        };

        try {
            await open("people");
            await show("Remy");
            assert.equal(await role(), "user");
            await inPage(`window.confirm = () => true; return JSON.stringify(true);`);
            // Their authenticator is with what they may do.
            await showPart("Permissions");
            await tap("Remove authenticator");
            await until(async () => (await role()) === "paused", "paused on Remy's row");
            assert.ok((await text()).includes(paused));

            await page.setViewport({ width: 390, height: 844, scale: 2, mobile: true });
            await until(
                () => inPage<boolean>(`return JSON.stringify(innerWidth === 390)`),
                "the phone viewport",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                const button = [...document.querySelectorAll(".pages-detail button")]
                    .find((each) => each.textContent.trim() === "Keep as viewer");
                const setting = button.closest(".setting");

                return JSON.stringify([setting, ...setting.querySelectorAll("*"), ...document.querySelectorAll(".pages-item")]
                    .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                    .map((each) => each.className || each.tagName));
            `),
                [],
                "the paused row and setting fit the phone",
            );

            await tap("Keep as viewer");
            await until(async () => (await role()) === "viewer", "viewer on Remy's row");
            const detail = await text();

            assert.ok(!detail.includes(paused));
            assert.ok(!detail.includes("Keep as viewer"));
            assert.equal(app.config.userById(user.id)?.paused, undefined);
        } finally {
            await app.removeUser(owner(app), user.id);
        }
    },
);

test(
    "a person whose authenticator was removed reads so in red on their own page, signs in another device from it, and has what they had back once they link one again",
    real,
    async () => {
        const { user, token } = app.config.addUser("Paz", "guest");
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-relink-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;
        /** Their own row in the list: what it says they are, and its badge, marked when in the color of what waits. */
        const row = () =>
            inPage<{ role: string; badge: string | null } | null>(`
                const row = [...document.querySelectorAll(".pages-item")]
                    .find((each) => each.querySelector(".pages-item-title")?.textContent.trim() === "Paz (you)");
                const badge = row?.querySelector(".pages-badge");

                return JSON.stringify(row === undefined ? null : {
                    role: row.querySelector(".pages-item-text .small").textContent.trim().split(" · ")[0],
                    badge: badge ? badge.textContent.trim() + (badge.classList.contains("alert") ? " (alert)" : "") : null,
                });
            `);
        /** The notice on the page shown: its words, and whether it is in the color of an error, not the muted one. */
        const notice = () =>
            inPage<{ says: string; red: boolean } | null>(`
                const notice = document.querySelector('.pages-detail [data-part="relink-notice"]');

                if (notice === null) {
                    return JSON.stringify(null);
                }

                const probe = document.createElement("span");

                probe.style.color = "var(--err)";
                document.body.append(probe);

                const red = getComputedStyle(probe).color;

                probe.remove();

                return JSON.stringify({
                    says: notice.textContent.replace(/\\s+/g, " ").trim(),
                    red: getComputedStyle(notice).color === red &&
                        red !== getComputedStyle(document.querySelector(".pages-detail .muted")).color,
                });
            `);
        const buttons = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail button")].map((each) => each.textContent.trim()))`,
            );

        /** Tap the button of `group` that says `label`, once it is there and takes a click. */
        const press = async (group: string, label: string) => {
            const found = `[...document.querySelectorAll('.pages-detail ${group} button')].find((each) => each.textContent.trim() === ${JSON.stringify(label)} && !each.disabled)`;

            await until(
                () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
                `${label} taking a click`,
            );
            await inPage(`${found}.click(); return JSON.stringify(true);`);
        };

        const shown = (selector: string) =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector('.pages-detail ${selector}') !== null)`,
            );

        linkAuthenticator(app, user);
        app.removeAuthenticator(user.id, owner(app));
        assert.ok(app.config.userById(user.id)?.paused !== undefined, "paused");

        try {
            page = await theirs.open(1);
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await open("people");
            await until(async () => (await notice()) !== null, "the notice on their own page");
            assert.deepEqual(await notice(), {
                says: "Your authenticator was removed. Link one again below to get back what you had.",
                red: true,
            });
            assert.deepEqual(await row(), { role: "paused", badge: "Relink (alert)" });
            assert.equal(
                (await buttons()).includes("Request access"),
                false,
                "they ask for nothing: linking one gives it back",
            );

            // They still sign in another device from here, which a viewer does not.
            await press('[data-part="device-link"]', "Make a link");
            await until(() => shown('[data-part="device-link"] input.mono'), "their sign-in link");

            const signed = await fetch(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector('.pages-detail [data-part="device-link"] input.mono').value)`,
                ),
                {
                    method: "POST",
                    redirect: "manual",
                    body: "",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                },
            );

            assert.equal(
                app.config.userByToken(
                    decodeURIComponent(
                        /pocket_auth=([^;]+)/.exec(signed.headers.get("set-cookie") ?? "")![1]!,
                    ),
                )?.id,
                user.id,
                "the device is them",
            );
            assert.equal(app.config.userById(user.id)?.role, "viewer", "and they still only view");

            // Linking one again, on this page, gives back what they had: the notice and the badge go.
            await press(".my-authenticator", "Link");
            await until(() => shown(".authenticator-secret"), "the key to link");

            const secret = await inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail .authenticator-secret").textContent.trim())`,
            );

            await inPage(`
                const field = document.querySelector('.pages-detail .my-authenticator input[autocomplete="one-time-code"]');

                field.value = ${JSON.stringify(totp(secret, Math.floor(Date.now() / STEP_MS)))};
                field.dispatchEvent(new Event("input", { bubbles: true }));

                return JSON.stringify(true);
            `);
            await press(".my-authenticator", "Link");
            await until(() => app.config.userById(user.id)?.role === "guest", "a user again");
            assert.equal(app.config.userById(user.id)?.paused, undefined);
            await until(async () => (await notice()) === null, "the notice to go");
            await until(async () => (await row())?.role === "user", "user on their row");
            assert.deepEqual(await row(), { role: "user", badge: null });
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            await theirs.closeAll({ final: true });
            await app.removeUser(owner(app), user.id);
        }
    },
);

test(
    "a viewer asks for access on their own page; who manages people sees Request on their row, reads it, and clears it",
    real,
    async () => {
        const { user, token } = app.config.addUser("Rita", "viewer");
        const kept = () => app.config.userById(user.id)?.accessRequest;
        /** The rows of people in the list on the left: each name, with its badge after " | " when it has one. */
        const rows = () =>
            inPage<string[]>(`
            return JSON.stringify(
                [...document.querySelectorAll(".pages-item")]
                    .filter((each) => each.querySelector(".people-here"))
                    .map((each) => {
                        const badge = each.querySelector(".pages-badge");

                        return each.querySelector(".pages-item-title").textContent.trim() +
                            (badge ? " | " + badge.textContent.trim() + (badge.classList.contains("alert") ? " (alert)" : "") : "");
                    }),
            );
        `);
        /** The buttons of the page shown, by what they say. */
        const buttons = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail button")].map((each) => each.getAttribute("aria-label") ?? each.textContent.trim()))`,
            );

        const text = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
            );
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-request-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;
        const chosen = app.config.server.users ?? [];
        const session = await newSession(app);
        let ritas: BrowserPage | undefined;

        try {
            // She is shown one session of the owner's, so she is told the owner's name, for the messages there.
            app.config.setUsers(THIS_SERVER, [...new Set([...chosen, user.id])]);
            await app.commands.shareSession(session, owner(app), [user.id]);
            ritas = await theirs.open(1);
            page = ritas;
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await open("people");
            assert.deepEqual(
                await inPage<string[]>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.users.map((each) => each.name).sort())`,
                ),
                [owner(app).name, "Rita"].sort(),
                "the people she meets, and nobody else",
            );
            // Her own row alone all the same, and on her page a field and a button to ask with.
            assert.deepEqual(await rows(), ["Rita (you)"]);
            await until(
                async () => (await buttons()).includes("Request access"),
                "Request access on her page",
            );
            await inPage(`
                const input = document.querySelector('.pages-detail input[aria-label="What you need"]');

                input.value = "  The docs folder, please ";
                input.dispatchEvent(new Event("input", { bubbles: true }));

                return JSON.stringify(true);
            `);
            await tap("Request access");
            await until(() => kept() !== undefined, "her request");
            assert.equal(kept()?.note, "The docs folder, please");
            await until(
                async () => (await buttons()).includes("Take back"),
                "her page saying that she asked",
            );
            assert.match(await text(), /Asked just now: “The docs folder, please”/);
            assert.equal((await buttons()).includes("Request access"), false);

            // The owner sees Request on her row, in the color of what waits, and on nobody else's.
            page = owners;
            await open("people");
            await until(
                async () => (await rows()).includes("Rita | Request (alert)"),
                "Request on her row",
            );
            assert.deepEqual(
                (await rows()).filter((each) => each.includes("|")),
                ["Rita | Request (alert)"],
            );
            await show("Rita");
            assert.deepEqual(
                await inPage<string[]>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-detail .access-asked .grow > div")].map((each) => each.textContent.replace(/\\s+/g, " ").trim()))`,
                ),
                [
                    "Asked for access just now",
                    "“The docs folder, please”",
                    "Give them what they need below, then clear this.",
                ],
            );
            // Her own things are not on the page the owner has of her.
            assert.equal((await buttons()).includes("Take back"), false);

            // On a phone the request fits the screen.
            await page.setViewport({ width: 390, height: 844, scale: 2, mobile: true });
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".pages-detail .access-asked") !== null && innerWidth <= 390)`,
                    ),
                "the page at a phone's size",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                    return JSON.stringify(
                        [...document.querySelectorAll(".pages-sheet .access-asked, .pages-sheet .access-asked *, .pages-sheet .pages-item, .pages-sheet .pages-badge")]
                            .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                            .map((each) => each.className || each.tagName),
                    );
                `),
                [],
                "nothing of the request is wider than the phone",
            );
            await page.setViewport(DESKTOP);

            // Clear takes it from her row and her page, and from her own page too, which offers to ask again.
            await tap("Clear Rita's request");
            await until(() => kept() === undefined, "the request cleared");
            await until(
                async () => !(await rows()).some((each) => each.includes("|")),
                "the badge gone",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pages-detail .access-asked") === null)`,
                ),
                true,
            );
            page = ritas;
            await until(
                async () => (await buttons()).includes("Request access"),
                "her page offering to ask again, without a reload",
            );

            // With no words, and taken back by herself.
            await tap("Request access");
            await until(() => kept() !== undefined, "her second request");
            assert.equal(kept()?.note, undefined);
            await until(async () => (await buttons()).includes("Take back"), "Take back");
            assert.match(await text(), /Asked just now\. Whoever manages people here sees it\./);
            await tap("Take back");
            await until(() => kept() === undefined, "her request taken back");
            await until(
                async () => (await buttons()).includes("Request access"),
                "her page offering to ask once more",
            );
        } finally {
            // The tests share one page: the owner's again, at its usual size, whatever happened.
            page = owners;
            await page.setViewport(DESKTOP);
            await theirs.closeAll({ final: true });
            await app.commands.shareSession(session, owner(app), []).catch(() => {});

            if (app.config.userById(user.id) !== undefined) {
                app.config.removeUser(user.id);
            }

            app.config.setUsers(THIS_SERVER, chosen);
            app.accessChanged();
        }
    },
);

test(
    "an invite makes a temporary account unless it allows more: no authenticator and no Can prompt for it, until the owner allows it",
    real,
    async () => {
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".sheet .invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const sheetText = () =>
            inPage<string>(
                `return JSON.stringify([...document.querySelectorAll(".sheet p, .sheet .setting")].map((each) => each.textContent.replace(/\\s+/g, " ").trim()).join(" | "))`,
            );
        const ready = () =>
            until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector('[data-part="app"]') !== null)`,
                    ),
                "the app",
                20_000,
            );

        await page.setViewport(DESKTOP);
        await page.navigate(`${base}/`);
        await ready();
        await inPage(
            `const { openSheet } = await import("/store.js"); openSheet({ type: "invite" }); return JSON.stringify(true);`,
        );
        await until(async () => (await code()) !== null, "an invite");

        // Off until asked: the invite makes a temporary account, and the sheet says so.
        const first = await code();
        const allowSwitch = (state: "on" | "off") =>
            inPage(
                `[...document.querySelectorAll(".sheet [role=switch]")].find((each) => each.getAttribute("aria-label") === "Allow viewer to become a user and prompt: ${state}").click(); return JSON.stringify(true);`,
            );

        const joinAs = async (invite: string | null, name: string) => {
            const answer = await fetch(`${base}/join/${invite}`, {
                method: "POST",
                redirect: "manual",
                body: new URLSearchParams({ name }).toString(),
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-site": "same-origin",
                },
            });

            return app.config.userByToken(
                decodeURIComponent(
                    /pocket_auth=([^;]+)/.exec(answer.headers.get("set-cookie") ?? "")?.[1] ?? "",
                ),
            );
        };

        assert.match(
            await sheetText(),
            /They join as a viewer, with a temporary account that expires 1 week after they join\./,
        );
        assert.match(
            await sheetText(),
            /Allow viewer to become a user and prompt\s*Off: a temporary account\. They view what is shared with them, and cannot link an authenticator or become a user\./,
        );

        // On: the invite shown ends, and whoever joins with the new one can become a user.
        await allowSwitch("off");
        await until(async () => ![null, first].includes(await code()), "the invite that allows it");
        assert.match(
            await sheetText(),
            /To prompt, they link an authenticator and are made a user/,
        );
        assert.match(
            await sheetText(),
            /On: they can link an authenticator, and then be made a user in People\./,
        );
        assert.equal((await fetch(`${base}/join/${first}`)).status, 410, "the one before ended");

        const allowed = await code();
        const fay = await joinAs(allowed, "Fay");

        assert.equal(fay?.role, "viewer");
        assert.equal(fay?.temporary, undefined, "allowed: not a temporary account");

        // Off again: a temporary account once more.
        await allowSwitch("on");
        await until(
            async () => ![null, first, allowed].includes(await code()),
            "the temporary invite",
        );
        assert.match(
            await sheetText(),
            /They join as a viewer, with a temporary account that expires 1 week after they join\./,
        );

        const joined = await fetch(`${base}/join/${await code()}`, {
            method: "POST",
            redirect: "manual",
            body: new URLSearchParams({ name: "Tia" }).toString(),
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "sec-fetch-site": "same-origin",
            },
        });
        const token = decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(joined.headers.get("set-cookie") ?? "")?.[1] ?? "",
        );
        const tia = app.config.userByToken(token);

        assert.equal(tia?.temporary, true, "whoever joins has a temporary account");
        await inPage(
            `const { closeSheet } = await import("/store.js"); closeSheet(); return JSON.stringify(true);`,
        );

        // A browser of their own: a login link in one signed in as someone else asks before it switches.
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-temporary-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;

        try {
            const tias = await theirs.open(1);

            /** Their own page in People: what it says of an authenticator, or null when it offers none. */
            const authenticator = async () => {
                await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
                await ready();
                await inPage(
                    `const { openSheet } = await import("/store.js"); openSheet({ type: "access", view: "person" }); return JSON.stringify(true);`,
                );
                await until(
                    async () =>
                        await inPage<boolean>(
                            `return JSON.stringify(document.querySelector(".pages-detail .my-name") !== null)`,
                        ),
                    "their own page in People",
                );

                // Once the server has answered what the sheet itself asked.
                return await inPage<string | null>(
                    `const { api } = await import("/store.js"); await api("me/authenticator"); await new Promise((resolve) => setTimeout(resolve, 300)); return JSON.stringify(document.querySelector(".my-authenticator")?.textContent.replace(/\\s+/g, " ").trim() ?? null)`,
                );
            };

            page = tias;
            assert.equal(
                await authenticator(),
                null,
                "a temporary account is offered no authenticator",
            );
            assert.match(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pages-detail").textContent)`,
                ),
                /Your account expires in \d+ days?\./,
            );

            // The owner's page for them: it says so, Can prompt is not theirs to get, and one switch ends it.
            page = owners;
            await open("people");
            await show("Tia");
            assert.match(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
                ),
                /viewer · temporary account/,
            );
            // What they may do is the other part of their page.
            await showPart("Permissions");
            assert.match(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
                ),
                /Off: a viewer\. Turn on Allow viewer to become a user and prompt first\./,
            );

            const before = await switches();

            assert.ok(before.includes("Tia can prompt: off (disabled)"), before.join(", "));
            assert.ok(before.includes("Tia may become a user and prompt: off"), before.join(", "));

            await press("Tia may become a user and prompt: off");
            await until(
                async () =>
                    (await switches()).includes("Tia may become a user and prompt: on (disabled)"),
                "the switch to be on, for good",
            );
            assert.deepEqual(await asked(), [
                "Allow Tia to become a user and prompt? Their account cannot be made temporary again. You can still turn off Can prompt, revoke their sessions, or remove them.",
            ]);
            assert.equal(app.config.userById(tia!.id)?.temporary, undefined);
            assert.match(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
                ),
                /Off: a viewer\. Tia must link an authenticator first\./,
            );

            // Now their own sheet offers one, and says what it is for.
            page = tias;
            assert.match(
                (await authenticator()) ?? "",
                /Not linked\s*Link an authenticator app to be made a user, who can prompt\./,
            );
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            await theirs.closeAll({ final: true });
        }
    },
);

test(
    "the Invite sheet sets the lifetime of a temporary account, and People clears it",
    real,
    async () => {
        const phone = VIEWPORTS.mobile;
        const account = '.sheet [aria-label="Account expires in"]';
        const end = '.sheet [aria-label="Account expires"]';
        const allow = "Allow viewer to become a user and prompt: off";
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".sheet .invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );

        /** Tap a button of the sheet. Wait until it takes a click. */
        const tap = async (label: string, where = ".sheet") => {
            const found = `[...document.querySelectorAll(${JSON.stringify(where + " button")})].find((each) => (each.getAttribute("aria-label") ?? each.textContent.trim()) === ${JSON.stringify(label)} && !each.disabled)`;

            await until(
                () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
                `${label} taking a click`,
            );
            await inPage(`${found}.click(); return JSON.stringify(true);`);
        };

        const selected = (where: string) =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(where + ' [aria-pressed="true"]')})?.textContent.trim() ?? null)`,
            );
        const sheetText = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".sheet").textContent.replace(/\\s+/g, " "))`,
            );

        const fitsPhone = async () => {
            assert.deepEqual(
                await inPage<string[]>(`
                    return JSON.stringify(
                        [...document.querySelectorAll(".sheet, .sheet *")]
                            .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                            .map((each) => each.getAttribute("class") || each.tagName),
                    );
                `),
                [],
                "nothing in the sheet extends past the phone's edges",
            );
        };

        let viewer: User | undefined;

        try {
            await open("people", phone);
            await tap("Invite someone");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(innerWidth === 390 && document.querySelector('[aria-label="${allow}"]') !== null)`,
                    ),
                "the Invite sheet on a 390px phone, with the switch off",
            );
            assert.equal(await selected(account), "1 week", "the account row defaults to a week");
            await until(
                async () =>
                    (await code()) !== null || (await sheetText()).includes("No invite yet."),
                "the 1 week invite request to finish",
            );
            const week = await code();

            assert.ok(week, "the server must grant the requested 1 week account lifetime");
            assert.match(
                await sheetText(),
                /Starts when they join\. After that their account is removed\./,
            );
            await fitsPhone();
            await tap("1 day", account);
            await until(
                async () => ![null, week].includes(await code()),
                "a new invite with a 1 day account",
            );
            const day = await code();

            assert.equal(await selected(account), "1 day");
            assert.match(
                await sheetText(),
                /They join as a viewer, with a temporary account that expires 1 day after they join\./,
            );
            assert.equal(
                (await fetch(`${base}/join/${week}`)).status,
                410,
                "the old invite is cancelled",
            );

            const beforeJoin = Date.now();
            const joined = await fetch(`${base}/join/${day}`, {
                method: "POST",
                redirect: "manual",
                body: new URLSearchParams({ name: "Day viewer" }).toString(),
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-site": "same-origin",
                },
            });
            const token = decodeURIComponent(
                /pocket_auth=([^;]+)/.exec(joined.headers.get("set-cookie") ?? "")?.[1] ?? "",
            );

            viewer = app.config.userByToken(token);
            assert.equal(viewer?.temporary, true);
            assert.ok(viewer.expiresAt !== undefined);
            assert.ok(viewer.expiresAt - 86_400_000 >= beforeJoin);
            assert.ok(viewer.expiresAt - 86_400_000 <= Date.now());

            await tap(allow);
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.querySelector(${JSON.stringify(account)}) === null)`,
                    ),
                "the account row hidden when the switch is on",
            );
            await until(
                async () => ![null, day].includes(await code()),
                "an invite for a full account",
            );

            await open("people", phone);
            await show(viewer.name);
            // When their account ends is with what they may do.
            await showPart("Permissions");
            assert.match(await sheetText(), /Account expires\s*in \d+ (?:hours?|days?)/);
            await fitsPhone();
            await tap("Never", end);
            await until(
                () => app.config.userById(viewer!.id)?.expiresAt === undefined,
                "the account's end cleared",
            );
            await until(
                async () => (await selected(end)) === "Never",
                "Never on the person's page",
            );
        } finally {
            await page.setViewport(DESKTOP);

            if (viewer !== undefined) {
                await app.removeUser(owner(app), viewer.id);
            }
        }
    },
);

test(
    "Invite people is off for a user until the owner turns it on: only then are they offered Invite someone",
    real,
    async () => {
        const chosen = app.config.server.users ?? [];
        // A device of Gina's own, in a browser of its own: a login link in one signed in as someone else asks first.
        const token = app.config.addDevice(guest.id);
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-invites-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;
        const offered = () =>
            inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".pages-item .pages-item-title")].some((each) => each.textContent.trim() === "Invite someone"))`,
            );
        const hint = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
            );

        assert.ok(token !== undefined);
        // Chosen for this server, so that starting sessions here is not what keeps her from inviting.
        app.config.setUsers(THIS_SERVER, [...new Set([...chosen, guest.id])]);
        app.setRight(owner(app), { person: guest.id, right: "invites", on: false });
        app.accessChanged();

        try {
            const ginas = await theirs.open(1);

            page = ginas;
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await open("people");
            assert.equal(
                await inPage<string>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.me.id)`,
                ),
                guest.id,
                "signed in as Gina",
            );
            assert.equal(await offered(), false, "off: she is offered no invite");

            // The owner's page for her: off, and it says who invites then.
            page = owners;
            await open("people");
            await show("Gina");
            await showPart("Permissions");
            assert.ok((await switches()).includes("Gina invites people: off"));
            assert.match(await hint(), /Off: they do not invite people\./);
            assert.equal(await offered(), true, "the owner always invites");

            await flip("Gina invites people");
            await until(
                async () => (await switches()).includes("Gina invites people: on"),
                "the switch to be on",
            );
            assert.equal(app.config.userById(guest.id)?.rights?.includes("invites"), true);
            assert.match(await hint(), /On: they invite people, who join as viewers/);

            // Her own page offers it now, without a reload.
            page = ginas;
            await until(async () => await offered(), "Gina to be offered Invite someone");

            // Off again: it goes.
            page = owners;
            await flip("Gina invites people");
            await until(
                async () => (await switches()).includes("Gina invites people: off"),
                "the switch to be off",
            );
            page = ginas;
            await until(async () => !(await offered()), "the offer to go");
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            await theirs.closeAll({ final: true });
            app.setRight(owner(app), { person: guest.id, right: "invites", on: false });
            app.config.setUsers(THIS_SERVER, chosen);
            app.accessChanged();
        }
    },
);

test(
    "Keep sessions warm is off for a user until the owner turns it on: only then does a session's card let them turn it on or pick a time",
    real,
    async () => {
        const chosen = app.config.server.users ?? [];
        // A device of Gina's own, in a browser of its own: a login link in one signed in as someone else asks first.
        const token = app.config.addDevice(guest.id);
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-warm-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;
        // The session's card in its menu: whether the flame (on or off) and each time can be tapped.
        const card = () =>
            inPage<{ flame: boolean; times: string[] } | null>(
                `const card = document.querySelector(".keep-warm-card"); return JSON.stringify(card === null ? null : { flame: card.querySelector(".keep-warm-flame").disabled !== true, times: [...card.querySelectorAll(".keep-warm-bar button")].filter((each) => !each.disabled).map((each) => each.textContent.trim()) })`,
            );
        const tap = (selector: string, label?: string) =>
            inPage(
                `[...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => ${label === undefined ? "true" : `each.textContent.trim() === ${JSON.stringify(label)}`}).click(); return JSON.stringify(true);`,
            );
        const every = ["30 min", "1 h", "2 h", "4 h", "8 h", "Break-even"];

        assert.ok(token !== undefined);
        // A session of the owner's, shared with her: she prompts in it, and so may change it.
        app.config.setUsers(THIS_SERVER, [...new Set([...chosen, guest.id])]);
        app.setRight(owner(app), { person: guest.id, right: "keepsWarm", on: false });
        app.accessChanged();

        const id = await newSession(app);

        await app.commands.shareSession(id, owner(app), [guest.id]);

        try {
            const ginas = await theirs.open(1);

            page = ginas;
            await page.setViewport(DESKTOP);
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await page.navigate(`${base}/s/${String(id)}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector('[data-part="app"]') !== null)`,
                    ),
                "the app",
                20_000,
            );
            await inPage(
                `const { openSheet } = await import("/store.js"); openSheet({ type: "menu" }); return JSON.stringify(true);`,
            );
            await until(async () => (await card()) !== null, "the session's keep warm card");
            assert.equal(
                await inPage<string>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.me.id)`,
                ),
                guest.id,
                "signed in as Gina",
            );
            assert.deepEqual(
                await card(),
                { flame: false, times: [] },
                "off: she can neither turn it on nor pick a time",
            );

            // The owner turns it on for her: her card offers every time, without a reload.
            app.setRight(owner(app), { person: guest.id, right: "keepsWarm", on: true });
            await until(
                async () => (await card())?.times.length === every.length,
                "her card to offer the times",
            );
            assert.deepEqual(await card(), { flame: true, times: every });
            await tap(".keep-warm-card .keep-warm-bar button", "1 h");
            await until(() => app.sessionMeta(id)?.keepWarm === 1, "the session to be kept warm");

            // Taken back: the session keeps its time, and she can only turn it off.
            app.setRight(owner(app), { person: guest.id, right: "keepsWarm", on: false });
            await until(
                async () => (await card())?.times.length === 0,
                "her card to offer no time",
            );
            assert.deepEqual(await card(), { flame: true, times: [] });
            assert.equal(app.sessionMeta(id)?.keepWarm, 1);
            await tap(".keep-warm-card .keep-warm-flame");
            // Off is the owner's default here, so the session follows the default again: no time of its own.
            await until(() => app.sessionMeta(id)?.keepWarm === undefined, "the session to be off");
            assert.equal(app.keepWarm.policy(id), undefined, "nothing keeps it warm");
            await until(
                async () => (await card())?.flame === false,
                "her card to offer nothing, now that it is off",
            );
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            await theirs.closeAll({ final: true });
            app.setRight(owner(app), { person: guest.id, right: "keepsWarm", on: false });
            app.config.setUsers(THIS_SERVER, chosen);
            app.accessChanged();
        }
    },
);

test(
    "an invite to all my sessions warns what it shares, and what follows when it allows them to become a user",
    real,
    async () => {
        const id = await newSession(app);
        const warning = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector('.sheet [data-part="invite-warning"]')?.textContent.replace(/\\s+/g, " ").trim() ?? null)`,
            );
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".sheet .invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const choose = (label: string) =>
            inPage(
                `[...document.querySelectorAll(".sheet .invite-share .segmented button")].find((each) => each.textContent.trim() === ${JSON.stringify(label)}).click(); return JSON.stringify(true);`,
            );

        const invite = async (path: string, ready: string) => {
            await page.setViewport(DESKTOP);
            await page.navigate(`${base}${path}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        `const { store } = await import("/store.js"); return JSON.stringify(document.querySelector('[data-part="app"]') !== null && (${ready}))`,
                    ),
                `the app at ${path}`,
                20_000,
            );
            await inPage(
                `const { openSheet } = await import("/store.js"); openSheet({ type: "invite" }); return JSON.stringify(true);`,
            );
            await until(async () => (await code()) !== null, "an invite");
        };

        const everything = "This invite shares every session you started so far.";
        const full = `${everything} It allows them to become a user: they can link an authenticator, and once they are made a user, they can prompt in all of those sessions.`;

        // One session, then its folder: neither is everything, so nothing warns.
        await invite(
            `/s/${String(id)}`,
            `store.state.view.conversation?.kind === "session" && store.state.sessions.some((each) => String(each.id) === ${JSON.stringify(String(id))} && each.mayShare === true)`,
        );
        assert.equal(await warning(), null, "only this session");
        await choose("This folder");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".sheet .invite-share .segmented button")].some((each) => each.textContent.trim() === "This folder" && each.classList.contains("on")))`,
                ),
            "This folder to be chosen",
        );
        assert.equal(await warning(), null, "this folder");

        // My sessions: it says what it shares. A temporary account, as it is until asked, never prompts.
        await choose("My sessions");
        await until(async () => (await warning()) !== null, "the warning");
        assert.equal(await warning(), everything);

        // Allowed to become a user: it says what that can come to.
        await inPage(
            `[...document.querySelectorAll(".sheet [role=switch]")].find((each) => each.getAttribute("aria-label") === "Allow viewer to become a user and prompt: off").click(); return JSON.stringify(true);`,
        );
        await until(async () => (await warning()) === full, "the full warning");

        // Back to one session: the warning goes, whatever the account.
        await choose("Only this session");
        await until(async () => (await warning()) === null, "the warning to go");

        // With no session open the invite is to my sessions, so it warns from the start.
        await invite("/", `store.state.view.conversation == null`);
        assert.equal(await warning(), everything);
        await inPage(
            `const { closeSheet } = await import("/store.js"); closeSheet(); return JSON.stringify(true);`,
        );
    },
);

test("a long folder's sessions scroll in the grid, without moving its tools", real, async () => {
    const ines = app.config.addUser("Ines", "guest").user;
    const tall = realpathSync(mkdtempSync(join(work, "tall-")));

    const more = async (count: number) => {
        for (let index = 0; index < count; index++) {
            const id = await startedBy("One of many", owner(app).id, tall);

            await app.commands.shareSession(id, owner(app), [ines.id]);
        }
    };

    const box = async (count: number) => {
        await search("One of many");
        await until(
            async () => (await gridCells("Ines")).length === count,
            `${count} session rows`,
        );

        return inPage<{ shown: number; whole: number; last: boolean; toolsStay: boolean }>(`
            const grid = document.querySelector(".ag-scroll");
            const tools = document.querySelector(".ak-tools");
            const top = tools.getBoundingClientRect().top;
            grid.scrollTop = grid.scrollHeight;
            const rows = grid.querySelectorAll(".ag-session");
            return JSON.stringify({ shown: grid.clientHeight, whole: grid.querySelector(".ag-table").clientHeight,
                last: rows[rows.length - 1].getBoundingClientRect().bottom <= grid.getBoundingClientRect().bottom + 1,
                toolsStay: tools.getBoundingClientRect().top === top });
        `);
    };

    try {
        await app.choosePerson(THIS_SERVER, ines.id, true);
        await app.giveFolders(owner(app), THIS_SERVER, ines.id, [tall]);
        await more(2);
        await open("people");
        await show("Ines");
        await jump("Ines");
        await groupBy("Sessions");
        const fits = await box(2);

        assert.ok(fits.whole <= fits.shown, "two rows need no scroll");
        await more(18);
        const scrolls = await box(20);

        assert.ok(scrolls.whole > scrolls.shown);
        assert.ok(scrolls.last, "the last row is reachable");
        assert.ok(scrolls.toolsStay, "only the grid scrolled");
    } finally {
        await app.removeUser(owner(app), ines.id);
    }
});

const RULES = '.pages-detail [data-part="person-rules"]';
const HERE = RULES + ' [data-part="computer"][data-computer="this-server"]';
const managerSwitch = '[data-right="manages"] [role="switch"]';

async function managerCase(name: string): Promise<ReturnType<App["config"]["addUser"]>> {
    const added = app.config.addUser(name, "guest");

    await app.choosePerson(THIS_SERVER, added.user.id, true);

    return added;
}

function grantManagement(person: User): void {
    app.setRight(owner(app), {
        person: person.id,
        right: "manages",
        on: true,
        computer: THIS_SERVER,
    });
}

const ruleCards = () =>
    inPage<string[]>(`
    return JSON.stringify([...document.querySelectorAll(${JSON.stringify(RULES + " > *")})]
        .map((group) => group.querySelector(":scope > .group-title")?.textContent.trim()));
`);

test(
    "14: Permissions shows Account, Pi Pocket, the computers, and Sign-in in order",
    real,
    async () => {
        const { user } = await managerCase("Permissions user");

        try {
            await open("people");
            await show(user.name);
            await showPart("Permissions");
            assert.deepEqual(await ruleCards(), [
                "Account",
                "Pi Pocket",
                "This server",
                "Laptop",
                "Sign-in",
            ]);
            const parts = await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(${JSON.stringify(RULES + " > [data-part]")})]
                .map((group) => group.dataset.part));
        `);

            assert.deepEqual(parts.slice(0, 4), ["account", "pi-pocket", "computer", "computer"]);
            // A computer's rights are a card of their own (`style.css` `.access-row`): a border, and room inside it.
            const card = await inPage<{ border: string; padding: string; display: string }>(`
            const style = getComputedStyle(document.querySelector(${JSON.stringify(HERE)}));

            return JSON.stringify({ border: style.borderTopWidth, padding: style.paddingLeft, display: style.display });
        `);

            assert.deepEqual(card, { border: "1px", padding: "12px", display: "flex" });
            const labels = await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll('[data-part="pi-pocket"] .setting > .grow > .small:first-child')]
                .map((row) => row.textContent.trim()));
        `);

            assert.deepEqual(labels, [
                "Manage users",
                "Manage Pi Pocket",
                "Invite people",
                "Run global commands",
                "Link runners",
                "Keep sessions warm",
            ]);
        } finally {
            await app.removeUser(owner(app), user.id);
        }
    },
);

test(
    "15: turning on management asks first, then includes the other computer rights",
    real,
    async () => {
        const { user } = await managerCase("Morgan");
        const rights = () =>
            inPage<{ key: string; on: boolean; disabled: boolean; hint: string }[]>(`
        return JSON.stringify([...document.querySelectorAll(${JSON.stringify(HERE + " [data-right]")})].map((row) => {
            const control = row.querySelector('[role="switch"]');

            return { key: row.dataset.right, on: control.getAttribute("aria-checked") === "true", disabled: control.disabled, hint: row.querySelector(".muted").textContent.trim() };
        }));
    `);
        const switchOn = (answer: boolean) =>
            inPage<string | null>(`
        const original = window.confirm;
        let question = null;

        window.confirm = (text) => {
            question = text;
            return ${String(answer)};
        };
        try {
            document.querySelector(${JSON.stringify(HERE + " " + managerSwitch)}).click();
            return JSON.stringify(question);
        } finally {
            window.confirm = original;
        }
    `);
        const question =
            "Let Morgan manage This server? They see and prompt every session there, in any folder, choose who else may use it, change its settings, and set project trust.";

        try {
            await open("people");
            await show(user.name);
            await showPart("Permissions");
            const off = await rights();

            assert.deepEqual(
                off.map((row) => row.key),
                ["manages", "reshares", "wheel", "allows"],
            );
            assert.ok(off.every((row) => !row.on && !row.disabled));
            assert.equal(await switchOn(false), question);
            assert.deepEqual(await rights(), off);
            assert.equal(app.config.rightHolders(THIS_SERVER, "manages").includes(user.id), false);
            assert.equal(await switchOn(true), question);
            await until(async () => (await rights()).every((row) => row.on), "management on");
            const on = await rights();

            assert.equal(on[0]?.disabled, false);
            assert.ok(
                on
                    .slice(1)
                    .every(
                        (row) =>
                            row.on &&
                            row.disabled &&
                            row.hint === "Included in Manage this computer.",
                    ),
            );
            assert.equal(app.config.rightHolders(THIS_SERVER, "manages").includes(user.id), true);
        } finally {
            await app.removeUser(owner(app), user.id);
        }
    },
);

test("16: Choose replaces the not-chosen line with the switches", real, async () => {
    const { user } = app.config.addUser("Not chosen", "guest");

    try {
        await open("people");
        await show(user.name);
        await showPart("Permissions");
        const card = JSON.stringify(HERE);
        const before = await inPage<{ text: string; button: string; switches: number }>(`
            const card = document.querySelector(${card});

            return JSON.stringify({text: card.querySelector(".setting .grow").textContent.trim(), button: card.querySelector("button.button.small").textContent.trim(), switches: card.querySelectorAll('[role="switch"]').length});
        `);

        assert.deepEqual(before, {
            text: "Not chosen for This server.",
            button: "Choose",
            switches: 0,
        });
        await inPage(
            `document.querySelector(${card}).querySelector("button").click(); return JSON.stringify(true);`,
        );
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector(${card}).querySelectorAll('[role="switch"]').length === 4);
        `),
            "the chosen person's switches",
        );
        assert.equal(app.config.server.users?.includes(user.id), true);
    } finally {
        await app.removeUser(owner(app), user.id);
    }
});

test("17: a manager sees the card but not its management switch", real, async () => {
    const manager = await managerCase("Server manager");
    const target = await managerCase("Chosen person");
    const made: Browsers[] = [];
    const owners = page;

    grantManagement(manager.user);

    try {
        page = await ownBrowser(made, manager.token);
        await open("people");
        await show(target.user.name);
        await showPart("Permissions");
        const rights = await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(${JSON.stringify(HERE + " [data-right]")} )].map((row) => row.dataset.right));
        `);

        assert.deepEqual(rights, ["reshares", "wheel", "allows"]);
    } finally {
        page = owners;
        await Promise.all(made.map((browser) => browser.closeAll({ final: true })));
        await app.removeUser(owner(app), manager.user.id);
        await app.removeUser(owner(app), target.user.id);
    }
});

test("18: a viewer has no computer card even if chosen there", real, async () => {
    const { user } = app.config.addUser("Chosen viewer", "viewer");

    await app.choosePerson(THIS_SERVER, user.id, true);

    try {
        await open("people");
        await show(user.name);
        await showPart("Permissions");
        assert.deepEqual(await ruleCards(), ["Account", "Pi Pocket", "Sign-in"]);
    } finally {
        await app.removeUser(owner(app), user.id);
    }
});

test("19: the computer cards fit a 390 px viewport", real, async () => {
    const { user } = await managerCase("Phone permissions");

    grantManagement(user);

    try {
        await open("people", { width: 390, height: 844, scale: 1, mobile: true });
        await show(user.name);
        await showPart("Permissions");
        const edges = await inPage<{ width: number; cards: number; overflow: string[] }>(`
            const cards = [...document.querySelectorAll(${JSON.stringify(RULES + " > [data-part=computer]")} )];
            const width = document.documentElement.clientWidth;
            const overflow = cards.flatMap((card) => [card, ...card.querySelectorAll("*")])
                .filter((element) => element.getBoundingClientRect().right > width)
                .map((element) => element.outerHTML.slice(0, 100));

            return JSON.stringify({ width, cards: cards.length, overflow });
        `);

        assert.deepEqual(edges, { width: 390, cards: 2, overflow: [] });
    } finally {
        await page.setViewport(DESKTOP);
        await app.removeUser(owner(app), user.id);
    }
});

test(
    "23: only the owner has the computer switch of a manager, and turns it off",
    real,
    async () => {
        const manager = await managerCase("Reader manager");
        const target = await managerCase("Chosen manager");
        const made: Browsers[] = [];
        const owners = page;
        const label = "Chosen manager may use This server";
        const control = `[...document.querySelectorAll('.pages-detail [role="switch"]')].find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(label)}))`;

        grantManagement(manager.user);
        grantManagement(target.user);

        const present = () => inPage<boolean>(`return JSON.stringify(Boolean(${control}));`);

        /** Open This server in Computer, and wait for the switches under its grid. */
        const computer = async () => {
            await open("computers");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".pages-detail .ag-people [role=switch]") !== null)`,
                    ),
                "the switches under the grid",
            );
        };

        try {
            // Refused: a manager cannot take another manager off the computer, so that switch is not drawn for them.
            page = await ownBrowser(made, manager.token);
            await computer();
            assert.equal(await present(), false, "no switch a manager cannot flip");
            // A manager's row on a person's page does not jump: they have no column.
            await open("people");
            await show(target.user.name);
            await showPart("Computers");
            assert.deepEqual(
                (await computerRows()).find(([name]) => name === "This server"),
                ["This server", "In charge here: every session there is theirs.", false],
            );
            // Allowed: the owner has the switch, and it takes a click.
            page = owners;
            await computer();
            await until(present, "the owner's switch for a manager");
            assert.equal(
                await inPage<boolean>(`return JSON.stringify(${control}.disabled)`),
                false,
            );
            await inPage(`window.confirm = () => true; return JSON.stringify(true);`);
            await flip(label);
            await until(
                () => !app.config.rightHolders(THIS_SERVER, "manages").includes(target.user.id),
                "the owner to un-choose the manager",
            );
        } finally {
            page = owners;
            await Promise.all(made.map((browser) => browser.closeAll({ final: true })));
            await app.removeUser(owner(app), manager.user.id);
            await app.removeUser(owner(app), target.user.id);
        }
    },
);

test(
    "a person's rights on a computer are two switches of their Permissions, for those who prompt there: flipped, their open session offers the wheel and their own calls at once",
    real,
    async () => {
        const chosen = app.config.server.users ?? [];
        const there = app.config.runnerById(runnerId)?.users ?? [];
        // A device of Gina's own, in a browser of its own: a login link in one signed in as someone else asks first.
        const token = app.config.addDevice(guest.id);
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-rights-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;
        let ginas: BrowserPage | undefined;
        // What her session offers: the buttons of the driver bar, and whether her own calls are hers to allow here.
        const hers = async () =>
            JSON.parse(
                await ginas!.evaluate(
                    `const { allowsOwn, overridesTurns, store } = await import("/store.js"); return JSON.stringify({ bar: [...document.querySelectorAll(".driver-bar button")].map((each) => each.textContent.trim()), wheel: overridesTurns(store.state.view.conversation), own: allowsOwn(store.state.view.conversation) })`,
                ),
            ) as { bar: string[]; wheel: boolean; own: boolean };
        // The switches shown for each computer where she can be chosen.
        const rights = () =>
            inPage<Record<string, string[]>>(`
                return JSON.stringify(
                    Object.fromEntries(
                        [...document.querySelectorAll('.pages-detail [data-part="person-rules"] [data-part="computer"]')]
                            .map((group) => [
                                group.querySelector(".group-title").textContent.trim(),
                                [...group.querySelectorAll("[role=switch]")].map((each) => each.getAttribute("aria-label")),
                            ]),
                    ),
                );
            `);

        assert.ok(token !== undefined);
        // Chosen for this server, both; for the Laptop, neither.
        app.config.setUsers(THIS_SERVER, [...new Set([...chosen, guest.id, viewer.id])]);
        app.config.setUsers(runnerId, []);
        app.accessChanged();

        // A session of the owner's, shared with her, in which the owner is here and drives.
        const id = await newSession(app);

        await app.commands.shareSession(id, owner(app), [guest.id]);

        const ownerTab = fakeTab(id, owner(app));

        try {
            await app.attach(ownerTab.client);
            await app.collab.turns(id, owner(app), { action: "on" });

            ginas = await theirs.open(1);
            await ginas.setViewport(DESKTOP);
            await ginas.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await ginas.navigate(`${base}/s/${String(id)}`);
            await until(
                async () => (await hers().catch(() => undefined))?.bar.length === 1,
                "her driver bar",
                20_000,
            );
            assert.deepEqual(
                await hers(),
                { bar: ["Ask to drive"], wheel: false, own: false },
                "off: she asks, and waits",
            );

            // The owner's People, under Permissions: the two switches of This server for her, who prompts there; none
            // for a viewer, none for a computer she is not chosen for. Under each computer in Computers
            // there is none: one place for each.
            await open("people");
            await show("Vera");
            await showPart("Permissions");
            assert.deepEqual(await rights(), {});
            await show("Gina");
            assert.deepEqual(await rights(), {
                Laptop: [],
                "This server": [
                    "Gina manages This server: off",
                    "Gina shares what they were given on This server: off",
                    "Gina overrides take turns on This server: off",
                    "Gina allows their own calls on This server: off",
                ],
            });
            await showPart("Computers");
            assert.deepEqual(
                (await switches()).filter((each) => !each.startsWith("Share my new sessions")),
                [],
            );
            await showPart("Permissions");

            // On: her open session offers the wheel without a reload, and she takes it from the owner.
            await flip("Gina overrides take turns on This server");
            await until(async () => (await hers()).wheel, "her session to offer the wheel");
            assert.deepEqual(await hers(), {
                bar: ["Ask to drive", "Take the wheel"],
                wheel: true,
                own: false,
            });
            assert.deepEqual(app.config.server.rights?.wheel, [guest.id]);
            assert.ok(
                (await switches()).includes("Gina overrides take turns on This server: on"),
                "the switch shows it",
            );
            await ginas.evaluate(
                `[...document.querySelectorAll(".driver-bar button")].find((each) => each.textContent.trim() === "Take the wheel").click(); return JSON.stringify(true);`,
            );
            await until(
                () =>
                    (ownerTab.field("turns") as { driver?: string } | undefined)?.driver ===
                    guest.id,
                "Gina to drive",
            );

            // The other right is its own switch.
            await flip("Gina allows their own calls on This server");
            await until(async () => (await hers()).own, "her own calls to be hers to allow");
            assert.deepEqual(app.config.server.rights?.allows, [guest.id]);

            // Taken back, both: as before, without a reload. She keeps the wheel she took.
            await flip("Gina overrides take turns on This server");
            await flip("Gina allows their own calls on This server");
            await until(async () => {
                const now = await hers();

                return !now.wheel && !now.own;
            }, "her session to offer neither");
            assert.equal(app.config.server.rights?.wheel, undefined);
            assert.equal(app.config.server.rights?.allows, undefined);
            assert.equal(
                (ownerTab.field("turns") as { driver?: string } | undefined)?.driver,
                guest.id,
            );
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            app.detach(ownerTab.client);
            await theirs.closeAll({ final: true });
            app.config.setUsers(THIS_SERVER, chosen);
            app.config.setUsers(runnerId, there);
            app.accessChanged();
        }
    },
);

test(
    "Manage users is the owner's to give: a user who has it gets the owner's view of the people they may change, and gives only what they have",
    real,
    async () => {
        // A device of Gina's own, in a browser of its own, as in the tests above.
        const token = app.config.addDevice(guest.id);
        const theirs = new Browsers({
            dataDir: mkdtempSync(join(root, "people-sheet-manages-")),
            load: async () => undefined,
            save: () => {},
        });
        const owners = page;
        const uma = app.config.addUser("Uma", "guest").user;
        const tom = app.config.addUser("Tom", "viewer").user;
        const text = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail").textContent.replace(/\\s+/g, " "))`,
            );
        const yes = () =>
            inPage(`
                window.asked = [];
                window.confirm = (text) => {
                    window.asked.push(text);

                    return true;
                };

                return JSON.stringify(true);
            `);
        const removable = () =>
            inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .sheet-page-actions button")].some((each) => each.textContent.trim() === "Remove"))`,
            );
        const times = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .approval-time option")].map((each) => each.textContent.trim()))`,
            );
        const wider = () =>
            inPage<string[]>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".sheet-body *")]
                        .filter((each) => each.getBoundingClientRect().right > innerWidth + 1)
                        .map((each) => each.className),
                );
            `);

        assert.ok(token !== undefined);
        // Gina has none of what a person can be given, and the usual approval time.
        app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: false });
        app.setRight(owner(app), { person: guest.id, right: "linksRunners", on: false });
        app.setRight(owner(app), { person: guest.id, right: "invites", on: false });
        app.setRight(owner(app), { person: guest.id, right: "keepsWarm", on: false });
        app.setApprovalDays(owner(app), guest.id, null);

        try {
            // The owner's page for her: off, and it says who manages users then. Every approval time is the owner's to give.
            await open("people");
            await show("Gina");
            // What a person may do is the Permissions part of their page; it stays shown from one person to the next.
            await showPart("Permissions");
            assert.ok((await switches()).includes("Gina manages users: off"));
            assert.match(await text(), /Off: they do not manage users\./);
            await show("Uma");
            assert.deepEqual(await times(), [
                "1 day",
                "7 days",
                "14 days",
                "30 days",
                "never ends",
            ]);

            // Her own browser: she may share her new sessions, but may not change the other person's permissions.
            const ginas = await theirs.open(1);

            page = ginas;
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await open("people");
            await show("Vera");
            await showPart("Computers");
            assert.deepEqual(await switches(), [
                "Share my new sessions on This server with Vera: off",
            ]);
            assert.equal(await removable(), false);

            // The owner turns it on, after a question.
            page = owners;
            await show("Gina");
            await yes();
            await flip("Gina manages users");
            await until(
                async () => (await switches()).includes("Gina manages users: on"),
                "the switch to be on",
            );
            assert.match((await asked())[0] ?? "", /^Let Gina manage users\?/);
            assert.equal(app.config.userById(guest.id)?.rights?.includes("managesUsers"), true);
            // Her page's line says the word, not the right.
            await until(
                async () =>
                    (
                        await inPage<string>(
                            `return JSON.stringify(document.querySelector(".pages-detail .sheet-page-head + .muted.small").textContent.trim())`,
                        )
                    ).startsWith("admin"),
                "Gina an admin",
            );
            assert.match(
                await text(),
                /On: they invite people, change what others may do, and remove them\. They cannot change you, themselves, or others who manage users\./,
            );
            // Invite people comes with it: on, and not a switch of its own while she manages users.
            assert.ok((await switches()).includes("Gina invites people: on (disabled)"));
            assert.match(await text(), /On with Manage users: they invite people/);

            // Her page for Vera gets the part the owner's has, without a reload, with the link that signs in as a viewer.
            page = ginas;
            await showPart("Permissions");
            await until(
                async () =>
                    JSON.stringify(await switches()) ===
                    JSON.stringify([
                        "Vera can prompt: off (disabled)",
                        "Vera may become a user and prompt: on (disabled)",
                        "Vera chats with one person: off",
                    ]),
                "Vera's switches, for Gina",
            );
            assert.equal(await removable(), true);

            const signsIn = () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.pages-detail [data-part="device-link"]') !== null)`,
                );

            assert.equal(await signsIn(), true);
            assert.match(await text(), /Sign in a device of theirs/);

            // She has neither of these two herself, so they are not hers to turn on; and whether Uma manages users is
            // the owner's. Inviting people she has with managing users. No link signs a device in as a user.
            await show("Uma");
            await showPart("Permissions");
            assert.deepEqual(await switches(), [
                "Uma can prompt: on",
                "Uma invites people: off",
                "Uma links runners: off (disabled)",
                "Uma keeps sessions warm: off (disabled)",
            ]);
            assert.equal(
                (await text()).split("Off: you can only give what you have yourself.").length - 1,
                2,
            );
            assert.equal(await signsIn(), false);
            // No approval time longer than her own.
            assert.deepEqual(await times(), ["1 day", "7 days"]);

            // She invites people herself, so she lets Uma.
            assert.match(await text(), /Off: they do not invite people\./);
            await flip("Uma invites people");
            await until(
                () => app.config.userById(uma.id)?.rights?.includes("invites") === true,
                "Uma to invite people",
            );

            // Her own page has no such switches: nobody changes themselves.
            await show("Gina");
            assert.deepEqual(
                (await switches()).filter((each) => each.startsWith("Gina ")),
                [],
            );
            assert.equal(await removable(), false);

            // She removes someone.
            await show("Tom");
            await yes();
            await inPage(`
                [...document.querySelectorAll(".pages-detail .sheet-page-actions button")]
                    .find((each) => each.textContent.trim() === "Remove")
                    .click();

                return JSON.stringify(true);
            `);
            await until(() => app.config.userById(tom.id) === undefined, "Tom to be removed");
            assert.match((await asked())[0] ?? "", /^Remove Tom\?/);

            // Another who manages users is the owner's alone to change.
            app.setRight(owner(app), { person: uma.id, right: "managesUsers", on: true });
            await show("Uma");
            await until(async () => (await switches()).length === 0, "Uma's switches to go");
            assert.equal(await removable(), false);
            // Her page's line says she is an admin.
            assert.match(await text(), /Umaadmin · /);

            // On a phone, her page for Vera and the owner's for her fit the screen.
            await open("people", VIEWPORTS.mobile);
            await show("Vera");
            await showPart("Permissions");
            assert.equal((await switches()).length, 3);
            assert.deepEqual(await wider(), []);
            page = owners;
            await open("people", VIEWPORTS.mobile);
            await show("Gina");
            await showPart("Permissions");
            assert.ok((await switches()).includes("Gina manages users: on"));
            assert.deepEqual(await wider(), []);

            // Taken back: she shares her own new sessions, but can no longer change Vera's permissions.
            page = ginas;
            app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: false });
            await until(
                async () =>
                    (await switches()).join() ===
                    "Share my new sessions on This server with Vera: off",
                "only the new sessions switch remains",
            );
            assert.equal(await removable(), false);

            // Settings, what holds for everyone, is for who manages Pi Pocket: not hers until the owner lets her.
            const listed = () =>
                inPage<string[]>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-item-title")].map((each) => each.textContent.trim()))`,
                );

            await open("settings");
            assert.equal((await listed()).includes("Settings"), false);
            app.setRight(owner(app), { person: guest.id, right: "managesServer", on: true });
            await until(async () => (await listed()).includes("Settings"), "Settings to be hers");
            await show("Settings");
            assert.deepEqual(await switches(), [
                "Tasks expire with the session: off",
                "Project chat",
            ]);
            await flip("Tasks expire with the session");
            await until(() => app.config.server.tasksExpire === true, "the server to keep it");
            // The server has it before the page does: a second tap on a switch that still reads off turns it on again.
            await until(
                async () => (await switches()).includes("Tasks expire with the session: on"),
                "her switch to show it",
            );
            await flip("Tasks expire with the session");
            await until(() => app.config.server.tasksExpire !== true, "it to be taken back");
            app.setRight(owner(app), { person: guest.id, right: "managesServer", on: false });
            await until(async () => !(await listed()).includes("Settings"), "Settings to go");
        } finally {
            // The tests share one page: the owner's again, whatever happened.
            page = owners;
            await theirs.closeAll({ final: true });

            for (const each of [uma, tom]) {
                if (app.config.userById(each.id) !== undefined) {
                    app.config.removeUser(each.id);
                }
            }

            app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: false });
            app.setRight(owner(app), { person: guest.id, right: "invites", on: false });
            app.accessChanged();
        }
    },
);

test(
    "a separate row Invite survives a folder grant; Revoke and the runner's People switch still work",
    real,
    async () => {
        const dee = app.config.addUser("Dee", "guest");
        const eli = app.config.addUser("Eli", "guest");
        const lin = app.config.addUser("Lin", "guest");
        const laptop = app.config.addRunner(
            "Lin's laptop",
            lin.user.id,
            newIdentity().publicKey,
        ).id;
        const owners = page;
        const made: Browsers[] = [];
        const folder = realpathSync(mkdtempSync(join(work, "reach-")));
        const shared = (id: ConversationId) => app.sessionMeta(id)?.sharedWith ?? [];

        try {
            await app.choosePerson(THIS_SERVER, dee.user.id, true);
            await app.choosePerson(THIS_SERVER, eli.user.id, true);
            const first = await startedBy("reach: first", dee.user.id, folder);
            const second = await startedBy("reach: second", dee.user.id, folder);
            const owned = await startedBy("reach: the owner's", owner(app).id, folder, 1);

            await app.commands.shareSession(owned, owner(app), [dee.user.id]);

            page = await ownBrowser(made, dee.token);
            await open("people", DESKTOP, `/s/${String(first)}`);
            await show("Eli");
            await until(
                async () => (await computerRows())[0]?.[1] === "0 of 2 of your sessions",
                "her count",
            );
            assert.equal(await says("Invite to your runner"), false);
            await jump("Eli");
            await groupBy("Sessions");
            await until(
                async () => (await sessionTitles("Eli")).length === 2,
                "her sessions, not the owner's",
            );
            const order = await sessionTitles("Eli");

            assert.deepEqual([...order].sort(), ["reach: first", "reach: second"]);
            await press("Invite Eli to reach: first");
            await until(() => shared(first).includes(eli.user.id), "the one share");
            assert.deepEqual(shared(second), []);
            assert.deepEqual(await asked(), []);
            await until(() => has("Revoke reach: first from Eli"), "the button follows the share");
            assert.deepEqual(await sessionTitles("Eli"), order);
            await press("Revoke reach: first from Eli");
            await until(() => !shared(first).includes(eli.user.id), "her share taken back");
            assert.deepEqual(await asked(), ["Stop sharing “reach: first” with Eli?"]);
            await until(() => has("Invite Eli to reach: first"), "the button follows the revoke");
            await press("Go to reach: second");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(location.pathname.endsWith(${JSON.stringify(`/s/${String(second)}`)}) && !document.querySelector(".pages-sheet"));`,
                    ),
                "the session opens and closes Access",
            );
            await open("people");
            await show("Lin");
            await until(
                async () => (await computerRows()).some(([name]) => name === "This server"),
                "the blocked line",
            );
            assert.deepEqual(await computerRows(), [
                [
                    "This server",
                    "Lin cannot use This server. Whoever is in charge of it chooses who uses it.",
                    false,
                ],
            ]);

            page = await ownBrowser(made, lin.token);
            await open("people");
            await show("Eli");
            await jump("Eli", "Lin's laptop");
            assert.match(await nothingHere(), /Eli may not use Lin's laptop/);
            await flip("Eli may use Lin's laptop");
            await until(
                () => app.policy.mayUse(eli.user, laptop),
                "Eli uses the runner after the jump",
            );

            // A folder changes no direct share. The compact Invite makes one independently, and Revoke warns when the
            // viewer still has the session through the folder.
            page = owners;
            await open("people");
            await show("Eli");
            await jump("Eli");
            await groupBy("Sessions");
            await search("reach:");
            await until(() => has("Invite Eli to reach: the owner's"), "the owner's row");
            await press("Invite Eli to reach: the owner's");
            await until(() => shared(owned).includes(eli.user.id), "the owner's share");
            assert.deepEqual([...shared(owned)].sort(), [dee.user.id, eli.user.id].sort());
            await app.setFolderLevel(owner(app), THIS_SERVER, eli.user.id, folder, "all");
            await until(
                async () =>
                    (await gridCells("Eli")).some(
                        ([title, cell]) => title === "reach: first" && cell === "Through folder",
                    ),
                "the folder grant",
            );
            await until(
                () => has("Invite Eli to reach: first"),
                "the compact Invite remains on the row",
            );
            await until(
                () => has("Revoke reach: the owner's from Eli"),
                "the direct share keeps Revoke",
            );
            assert.deepEqual(shared(first), [], "the folder does not create a direct share");
            await press("Revoke reach: the owner's from Eli");
            assert.deepEqual(await asked(), [
                `Stop sharing “reach: the owner's” with Eli? They still have it after that: they see the sessions in ${folder}.`,
            ]);
            await until(() => !shared(owned).includes(eli.user.id), "the share removed");
            assert.equal(app.canSee(eli.user, owned), true);
            await press("Invite Eli to reach: first");
            await until(() => shared(first).includes(eli.user.id), "the separate share saved");
            await app.setFolderLevel(owner(app), THIS_SERVER, eli.user.id, folder, "start");
            await until(
                () => has("Invite Eli to reach: the owner's"),
                "the folder no longer gives the owner's session",
            );
            assert.equal(app.canSee(eli.user, owned), false);
            assert.equal(app.canSee(eli.user, first), true);
            assert.equal(await has("Revoke reach: first from Eli"), true);
            assert.equal(await has("Invite Eli to reach: first"), false);
        } finally {
            page = owners;
            await Promise.all(made.map((each) => each.closeAll({ final: true })));
            await app.unlinkRunner(laptop);

            for (const each of [dee, eli, lin]) {
                await app.removeUser(owner(app), each.user.id);
            }
        }
    },
);

test(
    "a person's folders and sessions are searched and filtered: by a session's name or its folder, by whether they have it, by when whoever reads last used it, and by who started it; an archived session is never listed",
    real,
    async () => {
        const ann = app.config.addUser("Ann", "guest");
        const ben = app.config.addUser("Ben", "guest");
        const quartz = join(root, "find-quartz");
        const topaz = join(root, "find-topaz");
        const owners = page;
        const made: Browsers[] = [];
        const field = '.pages-detail input[aria-label="Search folders and sessions"]';
        const sessionRows = () =>
            gridCells("Ben").then((rows) => rows.map(([title, cell]) => `${title} | ${cell}`));
        const under = async (path: string) =>
            inPage<string[]>(`
            const rows = [...document.querySelectorAll(".ag-table > .ag-row")];
            const at = rows.findIndex((row) => row.querySelector(".ag-group .ag-toggle")?.title === ${JSON.stringify(path)});
            const next = rows.slice(at + 1).findIndex((row) => !row.classList.contains("ag-session"));
            return JSON.stringify(rows.slice(at + 1, next < 0 ? undefined : at + 1 + next).map((row) => row.querySelector(".ag-title").textContent.trim()));
        `);

        /** Type `text` in the search, in place of what it holds. */
        const type = (text: string) =>
            inPage(`
                const input = document.querySelector(${JSON.stringify(field)});

                input.value = ${JSON.stringify(text)};
                input.dispatchEvent(new Event("input", { bubbles: true }));

                return JSON.stringify(true);
            `);

        /** Choose `value` in the filter called `name`. */
        const pick = (name: string, value: string) =>
            inPage(`
                const select = document.querySelector(${JSON.stringify(`.pages-detail select[aria-label=${JSON.stringify(name)}]`)});

                select.value = ${JSON.stringify(value)};
                select.dispatchEvent(new Event("change", { bubbles: true }));

                return JSON.stringify(true);
            `);

        /** What each filter's button says: its name, or what it keeps while it is set. */
        const picks = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .access-pick:not(.ak-people) > span")].map((each) => each.textContent.trim()))`,
            );

        /** What the search says it found, as "2 of 9"; nothing while nothing is searched for or filtered. */
        const found = () =>
            inPage<string>(
                `return JSON.stringify((document.querySelector(".pages-detail .access-found")?.textContent ?? "").replace(/\\s+/g, " ").trim())`,
            );

        /** How many sessions that is; -1 while it says nothing. */
        const count = async () => {
            const text = await found();

            return text === "" ? -1 : Number(text.split(" of ")[0]);
        };

        const nothing = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".ag-empty .access-clear")?.parentElement.textContent.replace(/\\s+/g, " ").trim() ?? "");`,
            );

        /** The marked parts of what `selector` finds on the page shown. */
        const marks = (selector: string) =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(`.pages-detail ${selector} mark`)})].map((each) => each.textContent))`,
            );

        /** What the end of each listed session's row says of when I last used it; nothing for one I never used. */
        const used = () =>
            inPage<Record<string, string>>(`
                return JSON.stringify(Object.fromEntries(
                    [...document.querySelectorAll(".pages-detail .ag-session")].map((each) => [
                        each.querySelector(".ag-title").textContent.trim(),
                        each.querySelector(".ag-used")?.textContent.trim() ?? "",
                    ]),
                ));
            `);

        /** Wait until the sessions listed are these, by name and in any order. */
        const lists = async (titles: string[], what: string) => {
            const wanted = JSON.stringify([...titles].sort());
            let got: string[] = [];

            try {
                await until(async () => {
                    got = (await sessionRows()).map((each) => each.split(" | ")[0]!).sort();

                    return JSON.stringify(got) === wanted;
                }, what);
            } catch (error) {
                throw new Error(`${what}: the page lists ${JSON.stringify(got)}`, { cause: error });
            }
        };

        /** Press the button called `label`, once it is there and takes a press. */
        const tap = async (label: string) => {
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.querySelector(${JSON.stringify(`.pages-detail button[aria-label=${JSON.stringify(label)}]:not(:disabled)`)}) !== null)`,
                    ),
                `${label} taking a press`,
            );
            await press(label);
        };

        const shared = (id: Awaited<ReturnType<typeof startedBy>>) =>
            app.sessionMeta(id)?.sharedWith ?? [];

        try {
            mkdirSync(quartz);
            mkdirSync(topaz);
            await app.choosePerson(THIS_SERVER, ann.user.id, true);
            await app.choosePerson(THIS_SERVER, ben.user.id, true);
            await app.giveFolders(owner(app), THIS_SERVER, ben.user.id, [quartz, topaz]);

            // Three that the owner started, and last sent to Pi in two hours, three days, and forty days ago. Two that
            // someone else started, which the owner never sent in. One of Ben's that is archived.
            await startedBy("find: zeta one", owner(app).id, quartz, 2);
            await startedBy("find: zeta two", ann.user.id);

            const omega = await startedBy("find: omega", owner(app).id, work, 72);

            await startedBy("find: old", owner(app).id, work, 960);
            await startedBy("find: his", ben.user.id, quartz);
            await app.commands.updateSession(
                await startedBy("find: archived", ben.user.id, quartz),
                owner(app),
                { archived: true },
            );

            await open("people");
            await show("Ben");
            await jump("Ben");
            await groupBy("Folders");
            await until(async () => (await gridFolders()).includes(topaz), "his folders");
            const folderCount = (path: string) =>
                inPage<string>(`
                const row = [...document.querySelectorAll(".ag-group .ag-toggle")].find((each) => each.title === ${JSON.stringify(path)});
                return JSON.stringify(row.querySelector(".ag-sub").textContent.trim());
            `);

            assert.equal(await folderCount(quartz), "1 of 2 sessions");
            assert.equal(await folderCount(topaz), "0 sessions");
            assert.deepEqual(await sessionRows(), [], "closed until opened or searched");
            assert.deepEqual(await picks(), ["Access", "Last used by you", "Started by"]);
            assert.equal(await found(), "");

            // A word of a session's name. The rows that hold one are open, the folder with none is left out, the word
            // is marked, and the search says how many it found.
            await type("zeta");
            await lists(["find: zeta one", "find: zeta two"], "the two called zeta");
            assert.equal(await count(), 2);
            assert.ok((await gridFolders()).includes(quartz));
            assert.ok(!(await gridFolders()).includes(topaz));
            assert.deepEqual(await marks(".ag-title"), ["zeta", "zeta"]);

            // Each word typed, in any case and any order.
            await type("  TWO   Zeta ");
            await lists(["find: zeta two"], "each word, in any case and order");
            assert.equal(await count(), 1);

            // A word of a folder: the sessions that work in it, his and the others, and the folder's own row marked.
            await type("quartz");
            await lists(["find: his", "find: zeta one"], "the sessions in that folder");
            assert.ok((await gridFolders()).includes(quartz));
            assert.ok((await sessionRows()).includes("find: his | Started by them"));
            assert.deepEqual(await marks(".ag-name"), ["quartz"]);

            // A folder with no session in it is found by its own path.
            await type("topaz");
            await until(
                async () => (await gridFolders()).includes(topaz),
                "a folder without sessions is still found",
            );
            assert.ok(!(await gridFolders()).includes(quartz));
            assert.deepEqual(await sessionRows(), []);
            assert.equal(await count(), 0);
            assert.equal(await nothing(), "", "a folder is found: that is not nothing");

            // Nothing by that name: the page says so, with nothing listed. The archived session is not found either.
            await type("nomatchxyz");
            await until(async () => (await nothing()) !== "", "nothing by that name");
            assert.equal(await nothing(), "No session matches “nomatchxyz”. Clear");
            assert.deepEqual(await gridFolders(), []);
            await type("archived");
            await until(
                async () => (await nothing()) === "No session matches “archived”. Clear",
                "the archived session not to be found",
            );
            assert.deepEqual(await sessionRows(), []);

            // Escape clears what is typed, and leaves the sheet open. Every row is closed again.
            await type("zeta");
            await lists(["find: zeta one", "find: zeta two"], "the search again");
            await inPage(`
                document
                    .querySelector(${JSON.stringify(field)})
                    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

                return JSON.stringify(true);
            `);
            await until(async () => (await found()) === "", "Escape to clear what is typed");
            assert.deepEqual(
                await inPage<[string, boolean]>(
                    `return JSON.stringify([document.querySelector(${JSON.stringify(field)}).value, document.querySelector(".pages-sheet") !== null])`,
                ),
                ["", true],
            );
            assert.deepEqual(await sessionRows(), []);

            // In an open row the session whoever reads used last is first, and the ones they never used are last. A
            // row's end says when that was.
            await type("find:");
            await lists(
                ["find: his", "find: old", "find: omega", "find: zeta one", "find: zeta two"],
                "the five of this test",
            );
            assert.deepEqual(await under(quartz), ["find: zeta one", "find: his"]);
            assert.deepEqual(await under(work), ["find: omega", "find: old", "find: zeta two"]);
            assert.deepEqual(await used(), {
                "find: zeta one": "2h",
                "find: his": "",
                "find: omega": "3d",
                "find: old": "5w",
                "find: zeta two": "",
            });

            // An open row keeps the order it was opened in. A session that comes since is at its end, though whoever
            // reads used it last of them all. Archived, it is listed no more.
            const late = await startedBy("find: late", owner(app).id, work, 1);

            await lists(
                [
                    "find: his",
                    "find: late",
                    "find: old",
                    "find: omega",
                    "find: zeta one",
                    "find: zeta two",
                ],
                "the one that came since",
            );
            assert.deepEqual(await under(work), [
                "find: omega",
                "find: old",
                "find: zeta two",
                "find: late",
            ]);
            await app.commands.updateSession(late, owner(app), { archived: true });
            await lists(
                ["find: his", "find: old", "find: omega", "find: zeta one", "find: zeta two"],
                "the five again",
            );

            // Access: the ones he has, or the ones he does not. The button says what it keeps.
            await pick("Access", "has");
            await lists(["find: his"], "the one he has");
            assert.deepEqual(await picks(), ["Has access", "Last used by you", "Started by"]);
            await pick("Access", "none");
            await lists(
                ["find: old", "find: omega", "find: zeta one", "find: zeta two"],
                "the four he does not have",
            );
            assert.equal((await picks())[0], "No access");

            // One given to him under No access stays listed, to be taken back where it stands.
            await tap("Invite Ben to find: omega");
            await until(() => shared(omega).includes(ben.user.id), "the server to share it");
            await until(() => has("Revoke find: omega from Ben"), "its button to turn");
            assert.ok((await sessionRows()).includes("find: omega | Revoke"));
            assert.equal((await sessionRows()).length, 4, "it is still listed");
            assert.equal(await count(), 4);

            // A change of what is typed lets go of it: he has it now, so it is not among the ones he does not have.
            await type("zeta");
            await lists(["find: zeta one", "find: zeta two"], "the search to let go of it");
            await type("find:");
            await lists(
                ["find: old", "find: zeta one", "find: zeta two"],
                "the three he does not have now",
            );

            // A change of a filter lets go of one too: it is listed as what it is now. Taken back there, it stays in
            // turn.
            await pick("Access", "has");
            await lists(["find: his", "find: omega"], "the two he has now");
            await tap("Revoke find: omega from Ben");
            await until(() => !shared(omega).includes(ben.user.id), "the share taken back");
            assert.deepEqual(await asked(), ["Stop sharing “find: omega” with Ben?"]);
            await until(() => has("Invite Ben to find: omega"), "its button to turn back");
            assert.ok((await sessionRows()).includes("find: omega | Invite"));
            assert.equal((await sessionRows()).length, 2, "it is still listed");
            await pick("Access", "");
            await lists(
                ["find: his", "find: old", "find: omega", "find: zeta one", "find: zeta two"],
                "all five again",
            );

            // Last used by you: within a time, longer ago than 30 days, or never.
            await pick("Last used by you", "24");
            await lists(["find: zeta one"], "the one used in the last day");
            assert.equal((await picks())[1], "Used by you: last 24 hours");
            await pick("Last used by you", "168");
            await lists(["find: omega", "find: zeta one"], "the ones used in the last week");
            await pick("Last used by you", "old");
            await lists(["find: old"], "the one used longer ago than 30 days");
            assert.equal((await picks())[1], "Used by you: older than 30 days");
            await pick("Last used by you", "never");
            await lists(["find: his", "find: zeta two"], "the ones the owner never used");
            assert.equal((await picks())[1], "Never used by you");
            await pick("Last used by you", "");
            await lists(
                ["find: his", "find: old", "find: omega", "find: zeta one", "find: zeta two"],
                "all five once more",
            );

            // Started by: one person's.
            await pick("Started by", ann.user.id);
            await lists(["find: zeta two"], "the one Ann started");
            assert.equal((await picks())[2], "Started by Ann");

            // Nothing under the filters: the page says which it is, the search with them or the filters alone.
            await pick("Access", "has");
            await until(async () => (await nothing()) !== "", "nothing of Ann's that he has");
            assert.equal(await nothing(), "No session matches “find:” with these filters. Clear");
            await type("");
            await until(
                async () => (await nothing()) === "No session matches these filters. Clear",
                "nothing under the filters alone",
            );
            await type("find:");
            await until(
                async () =>
                    (await nothing()) === "No session matches “find:” with these filters. Clear",
                "nothing under both again",
            );

            // Clear ends the search and every filter: the page is as it was, with nothing typed and every row closed.
            await tap("Clear the search and the filters");
            await until(async () => (await found()) === "", "everything cleared");
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(field)}).value)`,
                ),
                "",
                "nothing is typed",
            );
            assert.deepEqual(await picks(), ["Access", "Last used by you", "Started by"]);
            assert.equal(await nothing(), "");
            assert.deepEqual(await sessionRows(), []);
            assert.ok((await gridFolders()).includes(quartz));

            // Ann is in charge of nothing: her sessions on this server are a card of it. She starts a second one, since
            // one session alone is nothing to search. The same search and filters are over the card; with one starter
            // there is no Started by. A computer with nothing to list is left out.
            await startedBy("find: her other", ann.user.id, work, 5, ann.user.id);
            page = await ownBrowser(made, ann.token);
            await open("people");
            await show("Ben");
            await until(
                async () => (await computerRows())[0]?.[1] === "0 of 2 of your sessions",
                "her card for him",
            );
            assert.deepEqual(
                (await computerRows()).map(([name]) => name),
                ["This server"],
            );
            await jump("Ben");
            await until(() => has("Search folders and sessions"), "her search");
            assert.deepEqual(await picks(), ["Access", "Last used by you"]);
            await type("ZETA");
            await lists(["find: zeta two"], "her search");
            assert.equal(await found(), "1 of 2");
            assert.deepEqual(await marks(".ag-title"), ["zeta"], "the word is marked here too");
            // A row's end says when she last used it herself, as on a computer of one's own: five hours ago.
            await type("other");
            await lists(["find: her other"], "the one she used");
            assert.deepEqual(await used(), { "find: her other": "5h" });
            await type("omega");
            await until(async () => (await nothing()) !== "", "nothing of hers by that name");
            assert.equal(await nothing(), "No session matches “omega”. Clear");
            assert.deepEqual(await sessionRows(), []);
            await type("");
            await pick("Access", "has");
            await until(
                async () => (await nothing()) === "No session matches these filters. Clear",
                "nothing of hers that he has",
            );
            await tap("Clear the search and the filters");
            await until(async () => (await found()) === "", "her search and filters clear");
            assert.equal(await nothing(), "");
        } finally {
            // The tests share one page: the owner's again, at its usual size, whatever happened.
            page = owners;
            await page.setViewport(DESKTOP);

            for (const each of made) {
                await each.closeAll({ final: true });
            }

            for (const each of [ann, ben]) {
                if (app.config.userById(each.user.id) !== undefined) {
                    app.config.removeUser(each.user.id);
                }
            }

            app.accessChanged();
        }
    },
);

test(
    "a giver takes back their own folder and share, but not someone else's; a read-only invite names only its session",
    real,
    async () => {
        const kay = app.config.addUser("Kay", "guest");
        const lou = app.config.addUser("Lou", "guest");
        const vee = app.config.addUser("Vee", "viewer");
        const amber = realpathSync(mkdtempSync(join(root, "give-amber-")));
        const beryl = realpathSync(mkdtempSync(join(root, "give-beryl-")));
        const made: Browsers[] = [];
        const owners = page;
        let moe: User | undefined;
        const access = (path: string) =>
            inPage<{ label: string; disabled: boolean; title: string } | null>(`
        const cell = [...document.querySelectorAll(".ag-group .at-level")].find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(`Access of Lou to ${path} on `)}));
        return JSON.stringify(cell ? {label: cell.getAttribute("aria-label"), disabled: cell.disabled, title: cell.title} : null);
    `);

        try {
            for (const each of [kay, lou, vee]) {
                await app.choosePerson(THIS_SERVER, each.user.id, true);
            }

            await app.giveFolders(owner(app), THIS_SERVER, kay.user.id, [amber, beryl]);
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: kay.user.id,
                right: "reshares",
                on: true,
            });
            const hers = await startedBy("give: her own", kay.user.id, amber);
            const theirs = await startedBy("give: shared with her", owner(app).id, work);

            await app.commands.shareSession(theirs, owner(app), [kay.user.id, lou.user.id]);
            moe = app.config.addUser("Moe", "viewer", [String(theirs)]).user;
            const kays = await ownBrowser(made, kay.token);

            page = kays;
            await open("people");
            await show("Moe");
            await until(async () => (await computerRows()).length === 1, "Moe's read-only row");
            assert.deepEqual(await computerRows(), [
                [
                    "This server",
                    "Moe is invited to one session only: “give: shared with her”.",
                    false,
                ],
            ]);
            await show("Vee");
            await until(async () => (await computerRows()).length === 1, "Vee's row");
            assert.deepEqual(
                await computerRows(),
                [["This server", "0 of 2 of your sessions", true]],
                "no folders that cannot be given to Vee",
            );

            await show("Lou");
            await until(
                async () =>
                    (await computerRows())[0]?.[1] ===
                    "1 of 2 of your sessions · 0 of 2 of your folders",
                "her offered work",
            );
            await jump("Lou");
            await until(
                async () => (await gridFolders()).includes(amber),
                "the answer and its folders",
            );
            assert.deepEqual(await columns(), ["Lou"]);
            assert.equal(await has("Search folders and sessions"), true);
            assert.equal(await has("All folders"), false);
            await choose("Lou", amber, "Start sessions");
            assert.deepEqual(await asked(), []);
            await until(
                () => app.config.givenFolders(THIS_SERVER, lou.user.id).includes(amber),
                "the folder given",
            );
            assert.equal(app.config.givenBy(THIS_SERVER, lou.user.id)[amber], kay.user.id);
            await openGrid(amber);
            await openGrid(work);
            // The session the owner shared with Lou is not hers to take back: the grid does not list it for him.
            await until(async () => (await sessionTitles("Lou")).length === 1, "her one session");
            assert.deepEqual(await sessionTitles("Lou"), ["give: her own"]);
            assert.equal(await has("Revoke give: shared with her from Lou"), false);
            assert.equal(await has("Invite Lou to give: shared with her"), false);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector(${JSON.stringify(`.ag-cell [title="Shared by ${owner(app).name}"]`)})));`,
                ),
                false,
                "a share someone else made is not shown",
            );
            await press("Invite Lou to give: her own");
            await until(() => has("Revoke give: her own from Lou"), "her share refreshes");
            assert.deepEqual(app.sessionMeta(hers)?.sharedWith, [lou.user.id]);

            page = owners;
            await open("people");
            await show("Lou");
            await jump("Lou");
            await groupBy("Sessions");
            await until(
                () => has("Revoke give: her own from Lou"),
                "the owner can take back that share too",
            );
            page = kays;
            assert.equal((await access(beryl))?.disabled, false, "hers to give while he has none");
            await app.giveFolder(owner(app), THIS_SERVER, lou.user.id, beryl, true);
            // A folder he has from someone else is not hers to change: no menu for it, not a disabled one.
            await until(
                async () => (await access(beryl)) === null,
                "a folder given by someone else has no menu",
            );
            assert.equal((await access(amber))?.disabled, false);
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: kay.user.id,
                right: "reshares",
                on: false,
            });
            await until(
                async () =>
                    (await gridFolders()).includes(amber) && !(await gridFolders()).includes(beryl),
                "her answer after the right goes off",
            );
            assert.equal(
                await has("Search folders and sessions"),
                false,
                "one session and one folder, no search",
            );
            assert.deepEqual(await sessionTitles("Lou"), ["give: her own"]);
            await choose("Lou", amber, "No access");
            await until(
                () => app.config.givenFolders(THIS_SERVER, lou.user.id).length === 1,
                "Kay's folder taken back",
            );
            assert.match((await asked())[0] ?? "", /^Take .+ from Lou?/);
            assert.deepEqual(app.config.givenFolders(THIS_SERVER, lou.user.id), [beryl]);
            assert.deepEqual(app.sessionMeta(hers)?.sharedWith, [lou.user.id]);
        } finally {
            page = owners;
            await Promise.all(made.map((each) => each.closeAll({ final: true })));

            for (const each of [kay.user, lou.user, vee.user, moe]) {
                if (each !== undefined) {
                    await app.removeUser(owner(app), each.id);
                }
            }
        }
    },
);

test(
    "a person's New sessions switch shares the next session, also for a giver not in charge",
    real,
    async () => {
        const boss = owner(app);
        const giver = app.config.addUser("Future giver", "guest");
        const receiver = app.config.addUser("Future receiver", "viewer").user;
        const previous = page;
        const made: Browsers[] = [];
        const row = `[data-part="share-new"][data-computer="${THIS_SERVER}"]`;
        const readRow = () =>
            inPage<{ label: string; on: string; text: string; group: string } | null>(`
            const row = document.querySelector(${JSON.stringify(row)});
            const button = row?.querySelector('[role="switch"]');

            return JSON.stringify(button ? {
                label: button.getAttribute("aria-label"),
                on: button.getAttribute("aria-checked"),
                text: row.textContent,
                group: row.parentElement.querySelector(".group-title").textContent,
            } : null);
        `);
        const label = "Share my new sessions on This server with Future receiver";

        try {
            await app.choosePerson(THIS_SERVER, giver.user.id, true);
            await app.choosePerson(THIS_SERVER, receiver.id, true);
            await app.giveFolders(boss, THIS_SERVER, giver.user.id, [work]);
            await open("people");
            await show(receiver.name);
            await showPart("Computers");
            await until(async () => (await readRow())?.label === `${label}: off`, "owner's switch");

            page = await ownBrowser(made, giver.token);
            await open("people");
            await show(receiver.name);
            await showPart("Computers");
            await until(
                async () => (await readRow())?.label === `${label}: off`,
                "chosen user's switch",
            );
            const off = (await readRow())!;

            assert.equal(off.group, "New sessions");
            assert.equal(off.on, "false");
            assert.match(off.text, /Share my new sessions on This server/);
            assert.match(off.text, /Your new sessions there start private\./);
            await inPage(`
                const fetch = window.fetch.bind(window);
                window.sharingCalls = [];
                window.fetch = (url, options) => {
                    if (typeof url === "string" && url.startsWith(${JSON.stringify(`/api/users/${receiver.id}/`)})) {
                        window.sharingCalls.push(options.method + " " + url.split("/").pop());
                    }

                    return fetch(url, options);
                };

                return JSON.stringify(true);
            `);
            await tap(`${label}: off`);
            await until(async () => (await readRow())?.label === `${label}: on`, "switch turns on");
            assert.deepEqual(await inPage<string[]>("return JSON.stringify(window.sharingCalls)"), [
                "POST share-new",
            ]);
            const on = (await readRow())!;

            assert.equal(on.on, "true");
            assert.match(
                on.text,
                /Each session you start there from now on is shared with Future receiver\./,
            );
            const stop = answerRequests(app, () => true);

            try {
                const id = await inPage<ConversationId>(`
                const { actions } = await import("/store.js");
                return JSON.stringify((await actions.createSession(${JSON.stringify(work)})).id);
            `);
                const meta = app.sessionMeta(id);

                assert.equal(meta?.createdBy, giver.user.id);
                assert.deepEqual(meta?.sharedWith, [receiver.id]);
            } finally {
                stop();
            }
        } finally {
            page = previous;

            for (const browser of made) {
                await browser.closeAll({ final: true });
            }

            await app.choosePerson(THIS_SERVER, giver.user.id, false);
            await app.choosePerson(THIS_SERVER, receiver.id, false);
            await app.removeUser(boss, giver.user.id);
            await app.removeUser(boss, receiver.id);
        }
    },
);

/** The checkboxes of the selection on the page shown, by their names: "on", "off", or "mixed"; a disabled one says so. */
const checks = () =>
    inPage<Record<string, string>>(`
        return JSON.stringify(Object.fromEntries(
            [...document.querySelectorAll(".pages-detail .sel-check > input[aria-label]")].map((each) => [
                each.getAttribute("aria-label"),
                (each.indeterminate ? "mixed" : each.checked ? "on" : "off") + (each.disabled ? " (disabled)" : ""),
            ]),
        ));
    `);

/** Click the checkbox called `label` (or Select all, for "Select all"), once it takes a click. */
async function check(label: string): Promise<void> {
    const found =
        label === "Select all"
            ? `document.querySelector('.pages-detail [data-part="select-bar"] .sel-all input')`
            : `document.querySelector(${JSON.stringify(`.pages-detail input[type=checkbox][aria-label=${JSON.stringify(label)}]`)})`;

    await until(
        () => inPage<boolean>(`return JSON.stringify(${found}?.disabled === false)`),
        `${label} taking a click`,
    );
    await inPage(`${found}.click(); return JSON.stringify(true);`);
}

/** What the bar of the selection says, and each of its buttons, a disabled one marked; "" while it is not there. */
const bar = () =>
    inPage<string>(`
        const bar = document.querySelector('.pages-detail [data-part="select-bar"]');

        return JSON.stringify(bar === null ? "" : [
            bar.querySelector(".sel-count").textContent.trim(),
            ...[...bar.querySelectorAll("button")].map((each) => each.textContent.replace(/\\s+/g, " ").trim() + (each.disabled ? " (disabled)" : "")),
        ].join(" | "));
    `);

/** Press the button of the selection's bar that says `text`, once it takes a click; a question it asks is kept, and answered yes. */
async function inBar(text: string): Promise<void> {
    const found = `[...document.querySelectorAll('.pages-detail [data-part="select-bar"] button')].find((each) => each.textContent.replace(/\\s+/g, " ").trim() === ${JSON.stringify(text)} && !each.disabled)`;

    await until(
        () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
        `${text} taking a click`,
    );
    await inPage(`
        window.asked = [];
        window.confirm = (text) => {
            window.asked.push(text);

            return true;
        };
        ${found}.click();

        return JSON.stringify(true);
    `);
}

/** Whether the page shown has a button that says `text`. */
const says = (text: string) =>
    inPage<boolean>(
        `return JSON.stringify([...document.querySelectorAll(".pages-detail button")].some((each) => each.textContent.trim() === ${JSON.stringify(text)}))`,
    );

/** What the notices on the page say. */
const notices = () =>
    inPage<string[]>(`
        const { store } = await import("/store.js");

        return JSON.stringify(store.state.notices.map((each) => each.message));
    `);

/** Type `text` in the search of the page shown, in place of what it holds. */
const search = (text: string) =>
    inPage(`
        const input = document.querySelector('.pages-detail input[aria-label="Search folders and sessions"]');

        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event("input", { bubbles: true }));

        return JSON.stringify(true);
    `);

test(
    "who is in charge selects several of a person's sessions in the grid, by their checkboxes, a folder's, or Select all under a search, and shares or takes them back with one press: Revoke asks once",
    real,
    async () => {
        const pia = app.config.addUser("Pia", "guest").user;
        const other = app.config.addUser("Bulk other", "guest").user;

        mkdirSync(join(root, "bulk-a", "inner"), { recursive: true });

        const bulk = realpathSync(join(root, "bulk-a"));
        const inner = join(bulk, "inner");

        const shared = (id: Awaited<ReturnType<typeof startedBy>>) =>
            app.sessionMeta(id)?.sharedWith ?? [];
        const sees = (id: Awaited<ReturnType<typeof startedBy>>) =>
            app.canSee(app.config.userById(pia.id)!, id);

        try {
            await app.choosePerson(THIS_SERVER, pia.id, true);
            await app.choosePerson(THIS_SERVER, other.id, true);

            const one = await startedBy("bulk one", owner(app).id, bulk);
            const two = await startedBy("bulk two zircon", owner(app).id, bulk);
            const three = await startedBy("bulk three zircon", owner(app).id, bulk);
            const four = await startedBy("bulk four", owner(app).id, inner);
            const hers = await startedBy("bulk hers", pia.id, bulk);

            await open("people");
            await show("Pia");
            await jump("Pia");
            await groupBy("Folders");
            await until(async () => (await gridFolders()).includes(bulk), "her folder");
            await openGrid(bulk);
            await openGrid(inner);
            await until(
                async () =>
                    (await sessionTitles("Pia")).filter((title) => title.startsWith("bulk "))
                        .length === 5,
                "the five sessions",
            );

            // Select turns the selection on: a checkbox on each session and folder row, and the bar over the list. A
            // row's own Invite and Revoke go meanwhile; Go to session stays.
            assert.equal(await has("Invite Pia to bulk one"), true);
            assert.equal(await bar(), "");
            await tap("Select");
            await until(async () => (await bar()) !== "", "the bar");
            assert.equal(await bar(), "0 selected | Share (0) (disabled) | Revoke (0) (disabled)");
            assert.deepEqual(
                [
                    await has("Invite Pia to bulk one"),
                    await has("Revoke bulk hers from Pia"),
                    await has("Go to bulk one"),
                    await has("Select bulk one"),
                ],
                [false, false, true, true],
            );
            assert.ok(await says("Done"), "Select reads Done");

            // A folder's checkbox checks every session listed under it, in the folder in it too; with some of them
            // checked, it is mixed. Pressed then, it checks them all, and again, none.
            const folderBox = `Select the sessions in ${bulk} on This server`;
            const innerBox = `Select the sessions in ${inner} on This server`;

            await check(folderBox);
            await until(async () => (await bar()).startsWith("5 selected"), "the five checked");
            assert.equal((await checks())[innerBox], "on");
            await check("Select bulk one");
            await until(async () => (await bar()).startsWith("4 selected"), "one unchecked");
            assert.deepEqual(
                [
                    (await checks())[folderBox],
                    (await checks())[innerBox],
                    (await checks())["Select bulk one"],
                ],
                ["mixed", "on", "off"],
            );
            await check(folderBox);
            await until(async () => (await bar()).startsWith("5 selected"), "all of them again");
            await check(folderBox);
            await until(async () => (await bar()).startsWith("0 selected"), "none");
            assert.equal((await checks())[folderBox], "off");

            // Three checked are shared with her by one press, which asks nothing; a fourth is not. The selection is
            // cleared, and stays on.
            await check("Select bulk one");
            await check("Select bulk two zircon");
            await check("Select bulk four");
            await until(
                async () => (await bar()) === "3 selected | Share (3) | Revoke (0) (disabled)",
                "the three to share",
            );
            await inBar("Share (3)");
            await until(
                () => [one, two, four].every((id) => shared(id).includes(pia.id)),
                "the three shared",
            );
            assert.deepEqual(shared(three), [], "not the fourth");
            assert.deepEqual(await asked(), [], "Share asks nothing");
            await until(
                async () => (await bar()).startsWith("0 selected"),
                "the selection cleared",
            );
            assert.ok(await says("Done"), "and still on");

            // Select all checks what the search lists, and only that. A session the search no longer lists leaves the
            // selection.
            await search("zircon");
            await until(
                async () =>
                    (await sessionTitles("Pia")).sort().join() ===
                    "bulk three zircon,bulk two zircon",
                "the two found",
            );
            await check("Select all");
            await until(
                async () => (await bar()) === "2 selected | Share (1) | Revoke (1)",
                "the two found selected, one to share and one to take back",
            );
            assert.deepEqual(
                [
                    (await checks())["Select bulk two zircon"],
                    (await checks())["Select bulk three zircon"],
                ],
                ["on", "on"],
            );
            await search("three");
            await until(async () => (await bar()).startsWith("1 selected"), "the one still listed");
            await search("");
            await openGrid(bulk);
            await openGrid(inner);
            assert.equal((await bar()).split(" | ")[0], "1 selected");
            await check("Select bulk three zircon");

            // On a phone each checkbox takes a finger's press.
            await page.setViewport({ width: 390, height: 844, scale: 2, mobile: true });
            await until(
                async () => await inPage<boolean>(`return JSON.stringify(innerWidth <= 390)`),
                "the page at a phone's size",
            );

            const boxes = await inPage<number[][]>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".pages-detail .sel-check")].map((each) => {
                        const box = each.getBoundingClientRect();

                        return [Math.round(box.width), Math.round(box.height)];
                    }),
                );
            `);

            assert.ok(boxes.length >= 7, String(boxes.length));
            assert.ok(
                boxes.every(([width, height]) => width! >= 44 && height! >= 44),
                JSON.stringify(boxes),
            );
            await page.setViewport(DESKTOP);

            // Two shared with her and one she started, taken back with one question, which says where hers goes.
            await check("Select bulk one");
            await check("Select bulk two zircon");
            await check("Select bulk hers");
            await until(
                async () => (await bar()) === "3 selected | Share (0) (disabled) | Revoke (3)",
                "the three to take back",
            );
            await inBar("Revoke (3)");
            assert.deepEqual(await asked(), [
                "Revoke 3 sessions from Pia? 1 they started move to you, with the tasks they set up in them.",
            ]);
            await until(() => [one, two, hers].every((id) => !sees(id)), "none of the three hers");
            assert.equal(sees(four), true, "the one not selected stays hers");

            await until(async () => (await bar()).startsWith("0 selected"), "no sessions checked");
            await check("Select bulk three zircon");
            await inBar("Share (1)");
            await until(
                () => shared(three).includes(pia.id),
                "one shared before the folder-level change",
            );

            // One a folder still gives her after that: the question says so, and she keeps it.
            await app.setFolderLevel(owner(app), THIS_SERVER, pia.id, bulk, "start");
            await app.setFolderLevel(owner(app), THIS_SERVER, pia.id, bulk, "all");
            await until(
                async () => (await bar()).startsWith("0 selected"),
                "the selection cleared",
            );
            await until(
                async () => (await checks())["Select bulk three zircon"] === "off",
                "its checkbox, with the folder hers",
            );
            await check("Select bulk three zircon");
            await until(async () => (await bar()).includes("Revoke (1)"), "the one to take back");
            await inBar("Revoke (1)");
            assert.deepEqual(await asked(), [
                "Revoke 1 session from Pia? They still have 1 of them through a folder.",
            ]);
            await until(() => !shared(three).includes(pia.id), "the share taken back");
            assert.equal(sees(three), true, "hers still, by the folder");

            // More sessions than one request takes go in several, each in its order.
            assert.deepEqual(
                await inPage<number[][]>(`
                    const { chunks } = await import("/sheets/session-select.js");
                    const lists = chunks(Array.from({ length: 1201 }, (_, at) => at));

                    return JSON.stringify(lists.map((each) => [each.length, each[0], each.at(-1)]));
                `),
                [
                    [500, 0, 499],
                    [500, 500, 999],
                    [201, 1000, 1200],
                ],
            );

            // Done ends it, and so does another person.
            await tap("Done");
            await until(async () => (await bar()) === "", "the bar gone");
            await until(() => has("Invite Pia to bulk two zircon"), "a row's own button back");
            await tap("Select");
            await until(async () => (await bar()) !== "", "selection is on");
            // Show another column: even with one person checked, selection ends.
            await inPage(`
                document.querySelector("button.ak-people").click();
                return JSON.stringify(true);
            `);
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector(".ak-people-menu .ak-check")));`,
                    ),
                "the people filter's choices",
            );
            await inPage(`
                [...document.querySelectorAll(".ak-people-menu .ak-check")].find((row) => row.textContent.includes("Bulk other")).click();
                return JSON.stringify(true);
            `);
            await until(async () => (await columns()).length === 2, "two columns");
            assert.equal(await bar(), "");
            assert.equal(await says("Select"), false);
        } finally {
            await page.setViewport(DESKTOP);
            await app.removeUser(owner(app), pia.id);
            await app.removeUser(owner(app), other.id);
        }
    },
);

test(
    "someone not in charge selects several of their sessions in one computer grid, and shares them, then takes them back, each with one press, with a single notice for one refused",
    real,
    async () => {
        const dee = app.config.addUser("Dee", "guest");
        const eli = app.config.addUser("Eli", "guest");
        const owners = page;
        const made: Browsers[] = [];

        const shared = (id: Awaited<ReturnType<typeof startedBy>>) =>
            app.sessionMeta(id)?.sharedWith ?? [];

        try {
            await app.choosePerson(THIS_SERVER, dee.user.id, true);
            await app.choosePerson(THIS_SERVER, eli.user.id, true);

            const first = await startedBy("deal: first", dee.user.id);
            const second = await startedBy("deal: second", dee.user.id);
            const third = await startedBy("deal: third", dee.user.id);

            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: dee.user.id,
                right: "reshares",
                on: true,
            });
            const passedOn = await startedBy("deal: passed on", owner(app).id);

            await app.commands.shareSession(passedOn, owner(app), [dee.user.id]);
            page = await ownBrowser(made, dee.token);
            await open("people");
            await show("Eli");
            await jump("Eli");
            await until(
                async () => (await gridFolders()).includes(work),
                "the folder on this server",
            );
            await openGrid(work);
            await until(async () => (await sessionTitles("Eli")).length === 4, "her rows");
            const request = `/api/users/${eli.user.id}/sharing`;
            const posts = () =>
                inPage<{ share?: number[]; revoke?: number[] }[]>(
                    `return JSON.stringify(window.posts);`,
                );

            await inPage(`
                const fetch = window.fetch.bind(window);
                window.posts = [];
                window.fetch = (url, init) => {
                    if (url === ${JSON.stringify(request)} && init?.method === "POST") window.posts.push(JSON.parse(init.body));
                    return fetch(url, init);
                };
                return JSON.stringify(true);
            `);
            await tap("Select");
            await until(async () => (await bar()) !== "", "the bar");
            assert.equal(await has("Invite Eli to deal: first"), false);
            await check("Select deal: first");
            await check("Select deal: second");
            await until(
                async () => (await bar()) === "2 selected | Share (2) | Revoke (0) (disabled)",
                "the two to share",
            );
            await inBar("Share (2)");
            await until(
                () => [first, second].every((id) => shared(id).includes(eli.user.id)),
                "the two shared",
            );
            assert.deepEqual(shared(third), []);
            assert.deepEqual(await asked(), []);
            const sentToShare = await posts();

            assert.equal(sentToShare.length, 1);
            assert.deepEqual(
                new Set(sentToShare[0]!.share),
                new Set([Number(first), Number(second)]),
            );
            await until(
                async () => (await bar()).startsWith("0 selected"),
                "the selection cleared",
            );

            // Its folder's checkbox checks all four: two of them hers to take back.
            await check(`Select the sessions in ${work} on This server`);
            await until(
                async () => (await bar()) === "4 selected | Share (2) | Revoke (2)",
                "two to share, two to take back",
            );
            await inBar("Revoke (2)");
            assert.deepEqual(await asked(), ["Revoke 2 sessions from Eli?"]);
            await until(
                () => [first, second].every((id) => !shared(id).includes(eli.user.id)),
                "the two taken back",
            );
            assert.deepEqual(shared(third), []);
            await until(
                async () => (await bar()).startsWith("0 selected"),
                "the selection clears after Revoke",
            );
            // Refuse one of two on this computer. Removing the right directly leaves the tab's answer unchanged.
            await check("Select deal: third");
            await check("Select deal: passed on");
            await until(
                async () => (await bar()).includes("Share (2)"),
                "two shareable in the tab's answer",
            );
            const before = (await posts()).length;

            app.config.setComputerRight(THIS_SERVER, dee.user.id, "reshares", false);
            await inBar("Share (2)");
            await until(() => shared(third).includes(eli.user.id), "the starter's share succeeds");
            await until(
                async () =>
                    (await notices()).some((each) => each.startsWith("1 of 2 were not changed: ")),
                "one refusal notice with a reason",
            );
            const refused = (await notices()).filter((each) => each.includes("were not changed"));

            assert.deepEqual(refused, ["1 of 2 were not changed: Not a session you can share."]);
            assert.deepEqual(shared(passedOn), [dee.user.id]);
            const sent = (await posts()).slice(before);

            assert.equal(sent.length, 1);
            assert.deepEqual(
                sent[0]!.share?.sort((a, b) => a - b),
                [Number(third), Number(passedOn)],
            );
            await until(
                async () => (await bar()).startsWith("0 selected"),
                "selection cleared and still on",
            );
        } finally {
            page = owners;

            for (const each of made) {
                await each.closeAll({ final: true });
            }

            for (const each of [dee, eli]) {
                if (app.config.userById(each.user.id) !== undefined) {
                    app.config.removeUser(each.user.id);
                }
            }

            app.accessChanged();
        }
    },
);

test(
    "All folders, the last row of the grid, gives any folder there: read only when open, each folder with the Access menu of a folder above, and none while a search is typed",
    real,
    async () => {
        // A home folder of the test's own: a folder with no session, one in it, one that cannot be read, and one
        // that holds 53 folders.
        const place = realpathSync(mkdtempSync(join(root, "all-folders-")));
        const fresh = join(place, "fresh");
        const inner = join(fresh, "inner");
        const locked = join(place, "locked");
        const many = join(place, "many");

        mkdirSync(inner, { recursive: true });
        mkdirSync(locked);

        for (let index = 0; index < 53; index++) {
            mkdirSync(join(many, `f${String(index).padStart(2, "0")}`), { recursive: true });
        }

        chmodSync(locked, 0o000);

        const bea = app.config.addUser("Bea", "guest");
        const val = app.config.addUser("Val", "viewer");
        const made: Browsers[] = [];
        const owners = page;

        await app.choosePerson(THIS_SERVER, bea.user.id, true);
        await app.choosePerson(THIS_SERVER, val.user.id, true);

        /** The folders whose listing the page asked for, in order, of this test's own (`~` and in `place`). */
        const reads = () =>
            inPage<string[]>(
                `return JSON.stringify((window.fsReads ?? []).filter((each) => each === "~" || each.startsWith(${JSON.stringify(place)})))`,
            );

        try {
            await asHome(place, async () => {
                await open("people");
                await show("Bea");
                await jump("Bea");
                await groupBy("Folders");
                await until(() => has("Open All folders of This server"), "the last row");
                // Each listing the page asks for, from now on.
                await inPage(`
                    window.fsReads = [];
                    const fetched = window.fetch;

                    window.fetch = (input, init) => {
                        const url = String(input);

                        if (url.includes("/fs?")) {
                            window.fsReads.push(new URL(url, location.href).searchParams.get("path"));
                        }

                        return fetched(input, init);
                    };

                    return JSON.stringify(true);
                `);

                const rows = await inPage<string[]>(`
                    return JSON.stringify([...document.querySelectorAll(".ag-table > .ag-row .ag-toggle")].map((each) => each.getAttribute("aria-label") + " " + each.getAttribute("aria-expanded")));
                `);

                assert.equal(rows[0], "Open Home false");
                assert.ok(rows.length > 2, "other folders before it");
                assert.equal(rows.at(-1), "Open All folders of This server false");
                await new Promise((resolve) => setTimeout(resolve, 300));
                assert.deepEqual(await reads(), [], "nothing read before it opens");

                // Open, it reads home (`~`) alone, and lists it first, then `/`; a folder in it reads nothing yet.
                await press("Open All folders of This server");
                await until(async () => (await browsed()).length === 2, "its top folders");
                assert.deepEqual(await browsed(), [`${place} | No access`, "/ | No access"]);
                assert.deepEqual(await reads(), ["~"]);
                await press(`Open ${place} in All folders`);
                await until(async () => (await browsed()).length === 5, "the folders in home");
                assert.deepEqual(await browsed(), [
                    `${place} (open) | No access`,
                    `${fresh} | No access`,
                    `${locked} | No access`,
                    `${many} | No access`,
                    "/ | No access",
                ]);
                assert.deepEqual(await reads(), ["~", place], "the folder opened, alone");

                // Start sessions on a folder that holds no session: saved; the folder is a row above now, and she
                // may start a session there.
                await choose("Bea", fresh, "Start sessions", IN_ALL);
                await until(
                    () => app.config.givenFolders(THIS_SERVER, bea.user.id).includes(fresh),
                    "the folder to be given",
                );
                assert.equal(app.policy.mayUseFolder(bea.user, THIS_SERVER, fresh), true);
                assert.equal(app.policy.mayStart(bea.user, THIS_SERVER), true);
                await until(async () => {
                    await openGrid(fresh);

                    return (await gridFolders()).includes(fresh);
                }, "the newly given folder among the rows above");
                assert.ok(
                    (await browsed()).includes(`${fresh} | Start sessions`),
                    "and its new level here",
                );

                // A folder in it has its level, from it.
                await press(`Open ${fresh} in All folders`);
                await until(
                    async () =>
                        (await browsed()).includes(`${inner} | Start sessions (from ${fresh})`),
                    "the folder in it",
                );
                assert.deepEqual(
                    (await reads()).filter((each) => each === inner),
                    [],
                    "a folder closed is not read",
                );

                // A folder that cannot be read says the server's sentence.
                await press(`Open ${locked} in All folders`);
                await until(
                    async () =>
                        await inPage<boolean>(
                            `return JSON.stringify([...document.querySelectorAll(".pages-detail .ag-empty")].some((each) => each.textContent.trim() === ${JSON.stringify(`Pi Pocket cannot read ${locked}.`)}))`,
                        ),
                    "the server's sentence",
                );

                // 53 folders: 50, then a row for the other 3, which shows them.
                await press(`Open ${many} in All folders`);
                await until(
                    async () =>
                        (await browsed()).filter((each) => each.startsWith(`${many}/`)).length ===
                        50,
                    "50 of its folders",
                );

                const more = `[...document.querySelectorAll(".pages-detail .ag-more")]`;

                assert.deepEqual(
                    await inPage<string[]>(
                        `return JSON.stringify(${more}.map((each) => each.textContent.trim()))`,
                    ),
                    ["Show 3 more"],
                );
                await inPage(`${more}[0].click(); return JSON.stringify(true);`);
                await until(
                    async () =>
                        (await browsed()).filter((each) => each.startsWith(`${many}/`)).length ===
                        53,
                    "all 53",
                );
                assert.ok((await browsed()).includes(`${many}/f52 | No access`));

                // A search is for sessions: All folders goes while one is typed, also while the tree still lists a
                // folder it finds, and comes back as it was.
                await search("fresh");
                await until(async () => !(await says("All folders")), "All folders to go");
                assert.ok((await gridFolders()).includes(fresh), "the folder is still listed");
                await search("");
                await until(async () => await says("All folders"), "All folders to come back");

                // A viewer is given folders to read: her menu has no Start sessions.
                await view("People");
                await show("Val");
                await jump("Val");
                await press("Open All folders of This server");
                await until(
                    async () => (await browsed()).includes(`${place} | No access`),
                    "her All folders",
                );
                await inPage(`
                    document.querySelector(${JSON.stringify(`${IN_ALL} .at-level`)}).click();

                    return JSON.stringify(true);
                `);
                await until(
                    () =>
                        inPage<boolean>(
                            `return JSON.stringify(document.querySelector(".at-level-menu") !== null)`,
                        ),
                    "her menu",
                );
                assert.deepEqual(
                    await inPage<string[]>(
                        `return JSON.stringify([...document.querySelectorAll(".at-level-menu .at-level-name")].map((each) => each.textContent.trim()))`,
                    ),
                    ["No access", "Current sessions", "New sessions", "All sessions"],
                );

                // The owner needs no folder: their row has no jump or All folders control.
                await view("People");
                await show("Val");
                await jump("Val");

                // Someone not chosen for a computer is given no folder there: no All folders.
                await app.choosePerson(THIS_SERVER, val.user.id, false);
                await until(
                    async () => !(await says("All folders")),
                    "no All folders for who is not chosen",
                );
            });

            // Bea is in charge of nothing: her computer does not show All folders.
            page = await ownBrowser(made, bea.token);
            await open("computers");
            await show("This server");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector('[data-part="read-only"]')));`,
                    ),
                "the note for a giver",
            );
            await new Promise((resolve) => setTimeout(resolve, 500));
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".ag-all") !== null)`,
                ),
                false,
            );
        } finally {
            page = owners;
            chmodSync(locked, 0o755);

            for (const each of made) {
                await each.closeAll({ final: true });
            }

            for (const each of [bea, val]) {
                app.config.removeUser(each.user.id);
            }

            app.accessChanged();
        }
    },
);

test(
    "on a phone All folders is no wider than the screen, a long name ends in an ellipsis, and each of its controls is 44 px high",
    real,
    async () => {
        const place = realpathSync(mkdtempSync(join(root, "all-folders-phone-")));
        const long = join(
            place,
            "a-folder-with-a-very-long-name-that-does-not-fit-on-a-phone-screen",
        );

        mkdirSync(join(long, "inside"), { recursive: true });

        for (let index = 0; index < 52; index++) {
            mkdirSync(join(place, `f${String(index).padStart(2, "0")}`));
        }

        const pia = app.config.addUser("Pia", "guest");

        await app.choosePerson(THIS_SERVER, pia.user.id, true);

        try {
            await asHome(place, async () => {
                await open("people", VIEWPORTS.mobile);
                await show("Pia");
                await jump("Pia");
                await press("Open All folders of This server");
                await until(async () => (await browsed()).length === 2, "its top folders");
                await press(`Open ${place} in All folders`);
                await until(
                    async () => (await browsed()).includes(`${long} | No access`),
                    "home's folders",
                );
                await press(`Open ${long} in All folders`);
                await until(
                    async () =>
                        (await browsed()).some((each) => each.startsWith(`${long}/inside |`)),
                    "2 levels open",
                );

                const phone = await inPage<{
                    wider: string[];
                    short: string[];
                    cut: { overflow: string; ellipsis: string; cut: boolean };
                }>(`
                 const all = document.querySelector(".ag-table");
                 const name = [...all.querySelectorAll(".ag-browse .ag-toggle")].find((each) => each.title === ${JSON.stringify(long)}).querySelector(".ag-name");

                return JSON.stringify({
                    wider: [...document.querySelectorAll(".sheet-body *")]
                        .filter((each) => each.getBoundingClientRect().right > innerWidth + 1 && !${INSIDE_SCROLLER}(each))
                        .map((each) => each.className),
                    // 44 px, measured on a phone's fractional pixels: up to half a pixel under it.
                    short: [...all.querySelectorAll(".ag-all button, .ag-browse button, .ag-more")]
                        .filter((each) => each.getBoundingClientRect().height < 43.5)
                        .map((each) => (each.getAttribute("aria-label") ?? each.textContent.trim()) + " " + each.getBoundingClientRect().height),
                    cut: {
                        overflow: getComputedStyle(name).overflow,
                        ellipsis: getComputedStyle(name).textOverflow,
                        cut: name.scrollWidth > name.clientWidth,
                    },
                });
            `);

                assert.deepEqual(phone.wider, []);
                assert.deepEqual(phone.short, [], "each control 44 px high at least");
                assert.deepEqual(phone.cut, {
                    overflow: "hidden",
                    ellipsis: "ellipsis",
                    cut: true,
                });
            });
        } finally {
            app.config.removeUser(pia.user.id);
            app.accessChanged();
        }
    },
);

test(
    "a person's row says one word, and their page names the computers they are in charge of",
    real,
    async () => {
        const ada = app.config.addUser("Ada", "guest").user;
        const mia = app.config.addUser("Mia", "guest").user;
        /** The words under each name in the list, by name. */
        const rows = () =>
            inPage<Record<string, string>>(`
                return JSON.stringify(Object.fromEntries(
                    [...document.querySelectorAll(".pages-sheet .pages-item")].map((each) => [
                        each.querySelector(".pages-item-title").textContent.trim(),
                        each.querySelector(".muted.small")?.textContent.trim() ?? "",
                    ]),
                ));
            `);
        /** The line under the head of the page shown. */
        const line = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail .sheet-page-head + .muted.small")?.textContent.trim() ?? "")`,
            );
        const word = async (name: string) => (await rows())[name]?.split(" · ")[0];

        app.setRight(owner(app), { person: ada.id, right: "managesUsers", on: true });
        await app.choosePerson(THIS_SERVER, mia.id, true);
        grantManagement(mia);

        try {
            await open("people");
            await until(async () => (await word("Ada")) === "admin", "Ada's row");
            // Manage users makes an admin; managing a computer does not.
            assert.equal(await word("Mia"), "user");
            assert.equal(await word("Gina"), "user");
            assert.equal(await word("Vera"), "viewer");
            assert.equal(await word("Owner (you)"), "owner");

            // The owner's page: the word, then the computers they are in charge of, by name.
            await show("Owner");
            await until(async () => (await line()).startsWith("owner"), "the owner's line");
            assert.match(await line(), /^owner · .* · in charge of This server and Laptop$/);
            assert.doesNotMatch(await line(), /in charge of this server/);
            // An admin's page says the word alone: no right in the line, and no computer.
            await show("Ada");
            await until(async () => (await line()).startsWith("admin"), "Ada's line");
            assert.doesNotMatch(await line(), /manages users|in charge of/);
            // Mia is a user in charge of this server only.
            await show("Mia");
            await until(async () => (await line()).startsWith("user"), "Mia's line");
            assert.match(await line(), /· in charge of This server$/);

            // Manage users given and taken back reaches the open tab, with no reload.
            app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: true });
            await until(async () => (await word("Gina")) === "admin", "Gina an admin");
            app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: false });
            await until(async () => (await word("Gina")) === "user", "Gina a user again");
        } finally {
            app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: false });
            app.setRight(owner(app), { person: guest.id, right: "invites", on: false });

            for (const each of [ada, mia]) {
                app.config.removeUser(each.id);
            }

            app.accessChanged();
        }
    },
);
