// The People sheet in a real browser (`web/sheets/people.js`): laid out as the Runners sheet is, and its Access part
// changes the same list as each computer's People in Runners (`web/sheets/access.js`), in both directions. A runner
// someone else linked is the owner's to read in Runners, and no choice in People.
import { newIdentity } from "../src/runner/secure-link.ts";
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
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

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

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Open sheet `type` on a fresh page, signed in as the owner. */
async function open(type: "people" | "computers", viewport = DESKTOP): Promise<void> {
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
    await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: ${JSON.stringify(type)} });

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

/** Tap the row of the list on the left that names `name`, and wait for its page. */
async function show(name: string): Promise<void> {
    await inPage(`
        [...document.querySelectorAll(".pages-item")]
            .find((each) => each.querySelector(".pages-item-title").textContent.startsWith(${JSON.stringify(name)}))
            .click();

        return JSON.stringify(true);
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sheet-page-title")?.textContent.trim().startsWith(${JSON.stringify(name)}) === true)`,
            ),
        `${name}'s page`,
    );
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

    app = await openApp(scriptedModel());

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
    "People is laid out as Runners is: everyone on the left, the chosen person's page beside it",
    real,
    async () => {
        await open("computers");

        const runners = await inPage<{ sheet: string; columns: number }>(`
        return JSON.stringify({
            sheet: document.querySelector(".sheet").className,
            columns: getComputedStyle(document.querySelector(".pages-split")).gridTemplateColumns.split(" ").length,
        });
    `);

        await open("people");

        const people = await inPage<{
            sheet: string;
            columns: number;
            items: string[];
            title: string;
        }>(`
        return JSON.stringify({
            sheet: document.querySelector(".sheet").className,
            columns: getComputedStyle(document.querySelector(".pages-split")).gridTemplateColumns.split(" ").length,
            items: [...document.querySelectorAll(".pages-item-title")].map((each) => each.textContent.trim()),
            title: document.querySelector(".sheet-page-title").textContent.trim(),
        });
    `);

        assert.equal(people.sheet, runners.sheet, "the same sheet");
        assert.deepEqual(
            [people.columns, runners.columns],
            [2, 2],
            "a list and a page, side by side",
        );
        assert.deepEqual(
            [...people.items].sort(),
            [
                "Gina",
                "Invite someone",
                "Notifications",
                "Owner (you)",
                "Sam",
                "Session approvals",
                "Vera",
            ],
            "everyone, then what else the sheet holds",
        );
        assert.notEqual(people.title, "Owner (you)", "it opens on someone whose access is to set");
    },
);

test("what a person may use is set in People, and shows in Runners", real, async () => {
    await open("people");
    await show("Gina");
    assert.deepEqual(await switches(), [
        "Gina steers Pi: on",
        "Gina links runners: off",
        "Gina may use This server: off",
        "Gina may use Laptop: off",
    ]);

    await flip("Gina may use This server");
    await until(
        () => app.policy.mayUse(guest, THIS_SERVER),
        "the server to choose Gina for this server",
    );
    await flip("Gina may use Laptop");
    await until(
        () => app.policy.mayUse(guest, runnerId),
        "the server to choose Gina for the Laptop",
    );

    // Chosen for this server, her folders there are given on the same page.
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('[aria-label="Add a folder for Gina on This server"]') !== null)`,
            ),
        "her folders on this server",
    );
    await page.type({ selector: '[aria-label="Add a folder for Gina on This server"]' }, root, {
        submit: true,
    });
    await until(
        () => app.config.givenFolders(undefined, guest.id).includes(realpathSync(root)),
        "the folder to be given",
    );
    assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);

    // The same list, by computer.
    await open("computers");
    await show("Laptop");
    await inPage(`
        [...document.querySelectorAll(".sheet-tabs [role=tab]")]
            .find((each) => each.textContent.trim().startsWith("People"))
            .click();

        return JSON.stringify(true);
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('[aria-label="Add a folder for Gina on Laptop"]') !== null)`,
            ),
        "Gina among the Laptop's people",
    );
});

test("what is chosen in Runners shows in People", real, async () => {
    await app.choosePeople(runnerId, []);
    await open("people");
    await show("Gina");
    assert.ok((await switches()).includes("Gina may use Laptop: off"));

    // Chosen by computer while the People sheet is open: its switch follows.
    await app.choosePeople(runnerId, [guest.id]);
    await until(
        async () => (await switches()).includes("Gina may use Laptop: on"),
        "the switch to follow",
    );
});

test(
    "a viewer without an authenticator cannot be let steer, and someone invited to one session is chosen nowhere",
    real,
    async () => {
        await open("people");
        await show("Vera");
        assert.deepEqual(await switches(), [
            "Vera steers Pi: off (disabled)",
            "Vera may use This server: off",
            "Vera may use Laptop: off",
        ]);
        // A viewer is chosen as anyone is, and given no folders: they start nothing.
        await flip("Vera may use This server");
        await until(() => app.policy.mayUse(viewer, THIS_SERVER), "the server to choose Vera");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('[aria-label="Add a folder for Vera on This server"]') !== null)`,
            ),
            false,
        );

        await show("Sam");
        assert.deepEqual(await switches(), [
            "Sam steers Pi: off (disabled)",
            "Sam may use This server: off (disabled)",
            "Sam may use Laptop: off (disabled)",
        ]);
        assert.equal(app.policy.mayUse(scoped, THIS_SERVER), false);
    },
);

test(
    "a runner someone else linked is the owner's to read, not to change, and no choice in People",
    real,
    async () => {
        // Gina may link her own, and did; she chose Vera for it.
        const ginas = app.config.addRunner("Gina's desktop", guest.id, newIdentity().publicKey).id;

        app.config.setRunnerUsers(ginas, [viewer.id]);

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
            assert.deepEqual(shown.tabs, [], "one part to read: no People, Approvals, or Settings");
            assert.match(shown.note, /Linked by Gina, who is in charge of it/);
            assert.match(shown.note, /you can unlink it/);
            assert.deepEqual(shown.actions, ["Unlink"]);
            assert.equal(shown.switches, 0, "nothing to switch or type");
            assert.doesNotMatch(shown.text, /Vera/, "its people are not the owner's to know");
            assert.doesNotMatch(
                shown.text,
                /Tools on this computer|Start its runner|At a glance/,
                "no heading with nothing under it, and no step that is its linker's to take",
            );

            // In People, a person's Access lists only the computers the owner is in charge of.
            await open("people");
            await show("Vera");
            assert.deepEqual(
                (await switches())
                    .filter((each) => each.includes("may use"))
                    .map((each) => each.replace(/: .*/, "")),
                ["Vera may use This server", "Vera may use Laptop"],
            );
            assert.doesNotMatch(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pages-detail").textContent)`,
                ),
                /Gina's desktop/,
            );
        } finally {
            await app.unlinkRunner(ginas);
        }
    },
);

test(
    "an approval's text and button stand clear of the list's edges, and the owner's switch under it saves",
    real,
    async () => {
        await open("people");
        await show("Session approvals");

        // Two approvals, put in the page's own state: the list as it is drawn, with nothing started for it.
        const shown = await inPage<{ left: number; right: number; lines: number }>(`
            const { store } = await import("/store.js");
            const row = (session, title) => ({
                session,
                title,
                folder: "/home/someone/project",
                computer: "this-server",
                lastUser: store.state.me.id,
                name: "Owner",
                method: "owner",
                usedAt: Date.now() - 60000,
                expiresAt: null,
                ended: false,
            });

            store.set({ folderApprovals: [row("901", "First session"), row("902", "Second session")] });
            await new Promise((resolve) => setTimeout(resolve, 200));

            const first = document.querySelector(".approval-row");
            const list = first.parentElement.getBoundingClientRect();

            return JSON.stringify({
                left: Math.round(first.querySelector(".approval-text").getBoundingClientRect().left - list.left),
                right: Math.round(list.right - first.querySelector(".button").getBoundingClientRect().right),
                lines: first.querySelectorAll(".approval-text > *").length,
            });
        `);

        assert.ok(shown.left >= 10, `the text is ${shown.left}px from the list's edge`);
        assert.ok(shown.right >= 10, `the button is ${shown.right}px from the list's edge`);
        assert.equal(shown.lines, 3, "its name, where it is, and when it ends: a line each");

        // The owner's choice under the list is a switch, as every other choice in the sheet, and it is kept.
        assert.ok((await switches()).includes("Tasks expire with the session: off"));
        await flip("Tasks expire with the session");
        await until(() => app.config.server.tasksExpire === true, "the server to keep the choice");
        await until(
            async () => (await switches()).includes("Tasks expire with the session: on"),
            "the switch to show it",
        );
        await flip("Tasks expire with the session");
        await until(() => app.config.server.tasksExpire !== true, "the choice to be taken back");
    },
);

test(
    "on a phone the list stands over the page, and nothing is wider than the screen",
    real,
    async () => {
        await open("people", VIEWPORTS.mobile);
        await show("Gina");

        const phone = await inPage<{ columns: number; wider: string[] }>(`
        return JSON.stringify({
            columns: getComputedStyle(document.querySelector(".pages-split")).gridTemplateColumns.split(" ").length,
            wider: [...document.querySelectorAll(".sheet-body *")]
                .filter((each) => each.getBoundingClientRect().right > innerWidth + 1)
                .map((each) => each.className),
        });
    `);

        assert.equal(phone.columns, 1);
        assert.deepEqual(phone.wider, []);
    },
);
