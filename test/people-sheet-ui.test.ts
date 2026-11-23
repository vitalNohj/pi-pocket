// The People sheet in a real browser (`web/sheets/people.js`): laid out as the Runners sheet is, and where a person may
// work is the same record as each computer's People in Runners (`web/sheets/access.js`), in both directions: whether
// they may use it, and under it one tree of that computer alone, with the rows of the Files panel's: the folders given
// to them there, closed until opened, and in each the sessions they have in it. Each row is taken back alone. A runner
// someone else linked is the owner's to read in Runners, and no choice in People.
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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
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

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Open sheet `type` on a fresh page, signed in as the owner: over home, or over the session at `path`. */
async function open(type: "people" | "computers", viewport = DESKTOP, path = "/"): Promise<void> {
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
 * Show part `label` of the page shown ("Folders and sessions" or "Permissions"), and wait for it. A fresh page shows
 * Folders and sessions. A page with one part alone has no tabs: then there is nothing to tap, and the part is shown
 * once it is drawn.
 */
async function showPart(label: "Folders and sessions" | "Permissions"): Promise<void> {
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
            ["Gina", "Invite someone", "Notifications", "Owner (you)", "Sam", "Settings", "Vera"],
            "everyone, then what else the sheet holds",
        );
        assert.ok(people.title.startsWith("Owner"), "it opens on one's own page");
    },
);

/**
 * The rows of the trees on the page shown that open: each folder given, and the group of sessions in no folder. What
 * each is called (its count at the end), and whether it is open.
 */
const folds = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .at-folder, .pages-detail .at-rest")].map(
                (each) => each.getAttribute("aria-label") + (each.getAttribute("aria-expanded") === "true" ? " (open)" : ""),
            ),
        );
    `);

/** Open, or close, the row of a tree called \`name\`. */
const fold = (name: string) =>
    inPage(`
        [...document.querySelectorAll(".pages-detail .at-folder, .pages-detail .at-rest")]
            .find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(name)}))
            .click();

        return JSON.stringify(true);
    `);

/** The sessions the opened rows show, as "title | how they have it". */
const sessionRows = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .at-session")].map(
                (each) =>
                    each.querySelector(".at-session-name").textContent.trim() +
                    " | " +
                    each.querySelector(".at-how").textContent.replace(/\\s+/g, " ").trim(),
            ),
        );
    `);

/** The sessions under the open folder called \`name\`, by title. */
const under = (name: string) =>
    inPage<string[]>(`
        const row = [...document.querySelectorAll(".pages-detail .at-folder, .pages-detail .at-rest")]
            .find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(name)}));

        return JSON.stringify(
            [...row.closest(".at-node").querySelectorAll(".at-session-name")].map((each) => each.textContent.trim()),
        );
    `);

/** Press the button called \`label\` on the page shown; a question it asks is kept, and answered yes. */
const press = (label: string) =>
    inPage(`
        window.asked = [];
        window.confirm = (text) => {
            window.asked.push(text);

            return true;
        };
        [...document.querySelectorAll(".pages-detail button")]
            .find((each) => each.getAttribute("aria-label") === ${JSON.stringify(label)})
            .click();

        return JSON.stringify(true);
    `);

const asked = () => inPage<string[]>(`return JSON.stringify(window.asked ?? [])`);

/** Whether the page shown has something called \`label\`. */
const has = (label: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(`.pages-detail [aria-label=${JSON.stringify(label)}]`)}) !== null)`,
    );

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

test("what a person may use is set in People, and shows in Runners", real, async () => {
    const given = realpathSync(root);

    await open("people");
    await show("Gina");
    // Her page has three parts. Where she may work shows first; what she may do is beside it, then the chat with her.
    assert.deepEqual(await shownParts(), ["Folders and sessions (shown)", "Permissions", "Chat"]);
    assert.deepEqual(await switches(), [
        "Gina may use This server: off",
        "Gina may use Laptop: off",
    ]);
    await showPart("Permissions");
    assert.deepEqual(await switches(), [
        "Gina can prompt: on",
        "Gina links runners: off",
        "Gina invites people: off",
        "Gina manages users: off",
        "Gina manages runners: off",
        "Gina manages the server: off",
        "Gina runs global commands: off",
        "Gina keeps sessions warm: off",
    ]);

    // Keep sessions warm: off until the owner turns it on, and off again.
    await flip("Gina keeps sessions warm");
    await until(
        () => app.config.userById(guest.id)?.rights?.includes("keepsWarm") === true,
        "the server to let Gina keep sessions warm",
    );
    await until(
        async () => (await switches()).includes("Gina keeps sessions warm: on"),
        "the switch to be on",
    );
    await flip("Gina keeps sessions warm");
    await until(
        async () => (await switches()).includes("Gina keeps sessions warm: off"),
        "the switch to be off",
    );
    assert.notEqual(app.config.userById(guest.id)?.rights?.includes("keepsWarm"), true);
    await showPart("Folders and sessions");
    assert.deepEqual(await folds(), [], "nothing to list where she is not chosen");
    assert.equal(await has("Give Gina a folder on This server"), false);

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

    // Chosen, she has a tree under each computer, of that computer alone: no folders yet, and the row that adds one.
    // She has no session; the one there is on this server is the owner's to give her, so its group is there, closed.
    await until(async () => await has("Give Gina a folder on Laptop"), "her trees");
    assert.equal(await has("Give Gina a folder on This server"), true);
    assert.deepEqual(
        await folds(),
        ["Sessions of Gina on This server: 0 of 1"],
        "no folder given; none of this server's one session is hers",
    );
    assert.equal(
        await has("Add a folder for Gina on This server"),
        false,
        "no field until asked for",
    );

    // The row that adds a folder turns into the field; the folder given is then a row of the tree, closed.
    await press("Give Gina a folder on This server");
    await until(async () => await has("Add a folder for Gina on This server"), "the field");
    await page.type({ selector: '[aria-label="Add a folder for Gina on This server"]' }, root, {
        submit: true,
    });
    await until(
        () => app.config.givenFolders(THIS_SERVER, guest.id).includes(given),
        "the folder to be given",
    );
    assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);
    // The session there is in that folder: it is under it now, still not hers.
    await until(
        async () => (await folds()).includes(`Folder ${given} of Gina on This server: 0 of 1`),
        "the folder's row",
    );
    assert.deepEqual(await folds(), [`Folder ${given} of Gina on This server: 0 of 1`]);
    assert.equal(await has("Add a folder for Gina on This server"), false, "the field closed");

    // The tree's rows are the Files panel's: the same row, set in by its depth.
    assert.deepEqual(
        await inPage<{ row: boolean; mono: boolean }>(`
            const row = document.querySelector(".pages-detail .at-folder");

            return JSON.stringify({
                row: row.classList.contains("ft-row") && row.classList.contains("dir"),
                mono: getComputedStyle(row).fontFamily === getComputedStyle(document.querySelector(".pages-detail .at-add")).fontFamily,
            });
        `),
        { row: true, mono: true },
    );

    // The same record, by computer: a row for each person, with the tree of that computer alone.
    await open("computers");
    await show("Laptop");
    await inPage(`
        [...document.querySelectorAll(".sheet-tabs [role=tab]")]
            .find((each) => each.textContent.trim().startsWith("People"))
            .click();

        return JSON.stringify(true);
    `);
    await until(
        async () => (await switches()).includes("Gina may use Laptop: on"),
        "Gina among the Laptop's people",
    );
    // Under her switch, the rights of someone who prompts there, off until given (`access.js` `RightSwitch`).
    assert.deepEqual(await switches(), [
        "Gina may use Laptop: on",
        "Gina overrides take turns on Laptop: off",
        "Gina allows their own calls on Laptop: off",
        "Gina shares what they were given on Laptop: off",
        "Vera may use Laptop: off",
    ]);
    assert.deepEqual(await folds(), [], "this server's folder is not the Laptop's");
    assert.equal(await has("Give Gina a folder on Laptop"), true);
    assert.doesNotMatch(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".pages-detail").textContent)`,
        ),
        /Choose people|Sam/,
        "no list to tick, and no one who has nothing here",
    );
});

test(
    "a person's sessions sit under the folders given to them; each row is taken back alone, and a session opens from its row",
    real,
    async () => {
        const given = realpathSync(root);
        const folder = `Folder ${given} of Gina on This server`;
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
        const seesAll = `Gina accesses all sessions in ${given} on This server`;

        await open("computers");
        await show("This server");
        await inPage(`
            [...document.querySelectorAll(".sheet-tabs [role=tab]")]
                .find((each) => each.textContent.trim().startsWith("People"))
                .click();

            return JSON.stringify(true);
        `);
        // In Runners the tree lists what she has: three of the folder's sessions, and the one outside her folders.
        await until(async () => (await folds()).includes(`${folder}: 3`), "her folder's count");
        assert.deepEqual(
            (await folds()).filter((each) => each.includes("Gina")),
            [`${folder}: 3`, "Other sessions of Gina on This server: 1"],
        );
        assert.deepEqual(await sessionRows(), [], "closed: no session shows");

        // Opened, the folder holds her sessions in it, each with how she has it. Each ends in Revoke. A session that
        // is not hers is not listed here, and none is given from here: that is done on her page in People.
        await fold(folder);
        await until(async () => (await sessionRows()).length === 3, "her sessions in the folder");
        assert.deepEqual((await sessionRows()).sort(), [
            "Her first | started it",
            "Her second | started it",
            "The owner's | shared with them",
        ]);
        assert.deepEqual(
            [
                await has("Revoke Her first from Gina"),
                await has("Invite Gina to Her first"),
                await has("Go to Not hers"),
                await has("Invite Gina to Not hers"),
            ],
            [true, false, false, false],
        );
        await fold("Other sessions of Gina on This server");
        await until(async () => (await sessionRows()).length === 4, "the one outside her folders");
        assert.deepEqual(await under("Other sessions of Gina on This server"), ["Elsewhere"]);
        assert.deepEqual((await under(folder)).sort(), ["Her first", "Her second", "The owner's"]);

        // The folder's own switch: she sees every session in it, whoever started it. It says how many become hers; one
        // that does is listed with how she has it, and has no Revoke: nothing of it is hers but through the folder.
        // Off, those leave her again, and only those.
        assert.ok((await switches()).includes(`${seesAll}: off`));
        assert.ok(!listed().includes(unshared));
        await inPage(`
            window.asked = [];
            window.confirm = (text) => {
                window.asked.push(text);

                return true;
            };

            return JSON.stringify(true);
        `);
        await flip(seesAll);
        await until(() => listed().includes(unshared), "the server to let her see the folder");
        assert.match(
            (await asked())[0]!,
            /2 sessions of other people's are theirs to open and prompt now/,
        );
        await until(
            async () => (await folds()).includes(`${folder}: 5 (open)`),
            "its rows to come",
        );
        assert.ok((await switches()).includes(`${seesAll}: on`));
        assert.ok((await sessionRows()).includes("Not hers | accesses all sessions here"));
        assert.deepEqual(
            [
                await has("Go to Not hers"),
                await has("Revoke Not hers from Gina"),
                await has("Invite Gina to Not hers"),
                await has("Revoke Her second from Gina"),
            ],
            [true, false, false, true],
            "the folder's session opens from its row; only one of her own is taken back",
        );
        await flip(seesAll);
        await until(
            () => !listed().includes(unshared),
            "the server to take the folder's sessions back",
        );
        assert.deepEqual(listed().sort(), [first, second, shared, outside].sort());
        await until(
            async () => (await folds()).includes(`${folder}: 3 (open)`),
            "the count to follow",
        );
        assert.equal(await has("Go to Not hers"), false, "its row went with the switch");
        assert.ok((await switches()).includes(`${seesAll}: off`));

        // One session is taken from her alone: the others, and her folder, stay. Its row goes: it is the owner's now.
        await press("Revoke Her first from Gina");
        await until(() => !listed().includes(first), "the server to take it from her");
        assert.ok(listed().includes(second) && listed().includes(shared));
        assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);
        await until(
            async () => (await folds()).includes(`${folder}: 2 (open)`),
            "the count to follow",
        );
        assert.equal(await has("Go to Her first"), false);

        await press("Revoke The owner's from Gina");
        await until(() => !listed().includes(shared), "the server to stop sharing it");
        assert.deepEqual(listed().sort(), [second, outside].sort());
        await until(
            async () => (await folds()).includes(`${folder}: 1 (open)`),
            "the count to follow again",
        );

        // Her page in People has the same tree, and lists the folder's other sessions too, each to be given from its
        // row: one of the five there is hers.
        await open("people");
        await show("Gina");
        await until(
            async () => (await folds()).includes(`${folder}: 1 of 5`),
            "her tree in People",
        );
        assert.ok((await folds()).includes("Other sessions of Gina on This server: 1"));
        await fold(folder);
        await until(
            async () => (await sessionRows()).length === 5,
            "the folder's sessions in People",
        );
        assert.ok((await sessionRows()).includes("Her second | started it"));
        assert.deepEqual(
            (await sessionRows())
                .filter((each) => !each.startsWith("Her second | "))
                .map((each) => each.split(" | ")[1]),
            [
                "not shared with them",
                "not shared with them",
                "not shared with them",
                "not shared with them",
            ],
        );
        // One button ends each row: Revoke for one of hers, Invite for one that is not.
        assert.deepEqual(
            [
                await has("Revoke Her second from Gina"),
                await has("Invite Gina to Her second"),
                await has("Revoke The owner's from Gina"),
                await has("Invite Gina to The owner's"),
            ],
            [true, false, false, true],
        );

        // Invite, in Revoke's place, gives one; the row keeps its place, and its button turns. Revoke turns it back.
        const order = (await sessionRows()).map((each) => each.split(" | ")[0]);

        await press("Invite Gina to The owner's");
        await until(() => listed().includes(shared), "the server to share it again");
        await until(async () => await has("Revoke The owner's from Gina"), "its button to turn");
        assert.deepEqual(
            (await sessionRows()).map((each) => each.split(" | ")[0]),
            order,
            "no row moved",
        );
        assert.ok((await sessionRows()).includes("The owner's | shared with them"));
        assert.deepEqual(await asked(), [], "Invite asks nothing");
        await until(
            async () => (await folds()).includes(`${folder}: 2 of 5 (open)`),
            "the count to follow in People",
        );
        await press("Revoke The owner's from Gina");
        await until(() => !listed().includes(shared), "the server to stop sharing it again");
        await until(async () => await has("Invite Gina to The owner's"), "its button to turn back");
        assert.deepEqual(
            (await sessionRows()).map((each) => each.split(" | ")[0]),
            order,
            "nor when it is taken back",
        );

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
        await press(`Remove ${given} from Gina on This server`);
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
        // With no folder of hers left, the sessions are one group: the one she has, of the six on this server.
        await until(
            async () => (await folds()).includes("Sessions of Gina on This server: 1 of 6"),
            "the tree to follow",
        );
        assert.deepEqual(
            (await folds()).filter((each) => each.includes("This server")),
            ["Sessions of Gina on This server: 1 of 6"],
        );
    },
);

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
            "Vera may use This server: off",
            "Vera may use Laptop: off",
        ]);
        await showPart("Permissions");
        assert.deepEqual(await switches(), [
            "Vera may become a user and prompt: on (disabled)",
            "Vera can prompt: off (disabled)",
            "Vera chats with one person: off",
        ]);
        // A viewer is chosen as anyone is, and given no folders: they start nothing.
        await showPart("Folders and sessions");
        await flip("Vera may use This server");
        await until(() => app.policy.mayUse(viewer, THIS_SERVER), "the server to choose Vera");
        // She has none of the sessions there; each is the owner's to give her, to read.
        await until(
            async () =>
                (await folds()).some((each) =>
                    each.startsWith("Sessions of Vera on This server: 0 of "),
                ),
            "her sessions' row",
        );
        assert.equal(await has("Give Vera a folder on This server"), false);

        // The part shown stays from one person to the next.
        await show("Sam");
        assert.deepEqual(await switches(), [
            "Sam may use This server: off (disabled)",
            "Sam may use Laptop: off (disabled)",
        ]);
        await showPart("Permissions");
        assert.deepEqual(await switches(), [
            "Sam may become a user and prompt: on (disabled)",
            "Sam can prompt: off (disabled)",
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
            assert.deepEqual(shown.tabs, [], "one part to read: no People or Settings");
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
                    status: words(document.querySelector(".pages-detail .sheet-page-head + .muted")),
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
                "Gina's desktop is blocked: Gina, who linked it, is a viewer now. Nothing starts or runs there until they are made a user. As the owner, you can make them a user in People, or unlink it.",
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
            app.config.updateUser(guest.id, { role: "guest" });
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
            app.config.updateUser(guest.id, { role: "guest" });
            app.accessChanged();
            await app.unlinkRunner(ginas);
        }
    },
);

test(
    "the owner's Settings page keeps what holds for everyone, and no page lists approvals",
    real,
    async () => {
        await open("people");
        await show("Settings");
        assert.deepEqual(await switches(), ["Tasks expire with the session: off"]);
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
            ["people", "Settings"],
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

        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .sheet-tabs [role=tab]")].map((each) => each.textContent.trim()))`,
            ),
            ["Overview", "People", "Settings"],
            "a computer's parts",
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
    "on a phone the list stands over the page, and nothing is wider than the screen",
    real,
    async () => {
        await open("people", VIEWPORTS.mobile);
        await show("Gina");
        // With the tree open: the rows of its sessions and their buttons fit too, hers and the ones to give her.
        await fold("Sessions of Gina on This server");
        await until(async () => (await sessionRows()).length > 0, "the sessions' rows");

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

test(
    "a group's title on a page starts where the page's rows start, in People and in Runners",
    real,
    async () => {
        /** Each group title on the page shown: how far its words start from the page's left edge, in pixels. */
        const titles = () =>
            inPage<[string, number][]>(`
                const detail = document.querySelector(".pages-detail .sheet-page");
                const start = (each) => {
                    const range = document.createRange();

                    range.selectNodeContents(each);

                    return range.getBoundingClientRect().left;
                };

                return JSON.stringify(
                    [...detail.querySelectorAll(".group-title")].map((each) => [
                        each.textContent.trim(),
                        Math.round(start(each) - detail.getBoundingClientRect().left),
                    ]),
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
                async () => (await titles()).some(([title]) => title === "Where they may work"),
                "Gina's groups",
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
                ["Where they may work"],
            );
            assert.deepEqual(
                rules.map(([title]) => title).filter((title) => !title.startsWith("On ")),
                ["What they may do", "Sign-in"],
            );

            for (const [title, from] of [...places, ...rules]) {
                assert.equal(from, 0, `"${title}" on Gina's page`);
            }

            // A computer's page in Runners is laid out the same way.
            await open("computers", viewport);
            await show("This server");
            await until(async () => (await titles()).length > 0, "the computer's groups");

            for (const [title, from] of await titles()) {
                assert.equal(from, 0, `"${title}" in Runners`);
            }
        }
    },
);

test(
    "an invite shares the open session first, then its folder, then my sessions; with no session open, my sessions",
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
        assert.deepEqual(await options(), ["Only this session (on)", "This folder", "My sessions"]);
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
        assert.deepEqual(await options(), ["Only this session", "This folder (on)", "My sessions"]);

        const second = await code();

        assert.equal(await beside(), app.cwdOf(id), "the folder of This folder");

        assert.ok(
            (await joinPage(second)).includes("the sessions shared with you in the folder "),
            "an invite to the folder",
        );
        assert.equal((await fetch(`${base}/join/${first}`)).status, 410, "the one before ended");

        // No session open: nothing to choose, and the invite is to the owner's sessions.
        await invite("/", `store.state.view.conversation == null`);
        assert.deepEqual(await options(), []);
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
    "after an invite a computer's switch says what the person has there: on where its maker is in charge, off with only the shared sessions where not",
    real,
    async () => {
        const hints = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .access-row")].map((each) => each.querySelector("strong").textContent.trim() + ": " + each.querySelector(".muted.small").textContent.trim()))`,
            );

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

        const laptop = "Laptop: Off: they see nothing of it.";

        // Hal joined with the owner's invite to their sessions. The owner is in charge of this server, so Hal is chosen
        // for it; nothing on the laptop became his.
        const hal = app.config.addUser("Hal", "viewer").user;
        const on = "This server: On: they see the sessions shared with them here. View only.";

        await app.welcome(hal.id, owner(app).id);
        assert.ok(app.sessions(hal).length > 0, "the owner's sessions are shared with Hal");
        assert.deepEqual(await shown("Hal", on), [on, laptop]);

        // Its switch takes them back.
        const nothing = "This server: Off: they see nothing of it.";

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
        const only = "This server: Off: they see only the sessions shared with them here.";

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
        /** The rows of one's own account on the page shown: their labels, in order. */
        const rows = () =>
            inPage<string[]>(`
            const detail = document.querySelector(".pages-detail");

            return JSON.stringify([
                detail.querySelector(".my-photo") && "photo",
                detail.querySelector('.my-name input[aria-label="Name"]') && "name",
                detail.querySelector(".my-request") && "request access",
                detail.querySelector(".device-link") && "device",
                detail.querySelector('[role="switch"][aria-label^="Keep pinned sessions synced"]') && "pin sync",
                detail.querySelector(".my-authenticator") && "authenticator",
                detail.querySelector(".my-signout") && "sign out",
            ].filter(Boolean));
        `);
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
            assert.deepEqual(await rows(), ["name", "request access", "authenticator", "sign out"]);

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
                    `const { openSheet } = await import("/store.js"); openSheet({ type: "people" }); return JSON.stringify(true);`,
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

test(
    "an opened row is as high as 18 one-line sessions at most; a longer list scrolls alone, to its last session",
    real,
    async () => {
        // The height of 18 sessions of one line each, 4px apart, with the room around them (`style.css` `.at-group`).
        // A session whose place does not fit beside its name takes two lines, so fewer of those show at once.
        const cap = 18 * 28 + 17 * 4 + 4;
        const chosen = app.config.server.users ?? [];
        const ines = app.config.addUser("Ines", "guest").user;
        const hers = () => app.sessions(ines).length;
        // A folder of this test's own, given to her: its row lists the sessions in it and no other, so their count is
        // what this test makes.
        const tall = realpathSync(mkdtempSync(join(work, "tall-")));
        const row = `Folder ${tall} of Ines on This server`;

        // The owner's sessions in that folder, shared with her, show in its row.
        const more = async (count: number) => {
            for (let index = 0; index < count; index++) {
                const { id } = await app.commands.createSession(owner(app), {
                    cwd: tall,
                    title: "One of many",
                });

                await app.commands.shareSession(id, owner(app), [ines.id]);
            }
        };

        const box = async (count: number) => {
            await open("people");
            await show("Ines");
            // Her sessions reach the page after it shows, and their row with them.
            await until(
                async () => (await folds()).includes(`${row}: ${String(count)}`),
                "the row of her folder, with its sessions",
            );
            await fold(row);
            await until(async () => (await sessionRows()).length === count, `${count} sessions`);

            return await inPage<{ shown: number; whole: number; last: boolean }>(`
                const group = document.querySelector(".pages-detail .at-group");

                group.scrollTop = group.scrollHeight;

                const rows = group.querySelectorAll(".at-session");

                return JSON.stringify({
                    shown: group.clientHeight,
                    whole: group.scrollHeight,
                    last: rows[rows.length - 1].getBoundingClientRect().bottom <= group.getBoundingClientRect().bottom + 1,
                });
            `);
        };

        try {
            app.config.setUsers(THIS_SERVER, [...new Set([...chosen, ines.id])]);
            app.accessChanged();
            await app.giveFolders(owner(app), THIS_SERVER, ines.id, [tall]);
            assert.equal(hers(), 0, "nothing of the owner's is hers yet");

            // A few: the list is as high as they are, and nothing scrolls.
            await more(2);

            const fits = await box(2);

            assert.equal(fits.whole, fits.shown, "2 sessions: nothing to scroll");
            assert.ok(fits.shown < cap, "and lower than the most it gets");

            // More than fit, whether each takes one line or two: as high as 18 of one line, and the rest scrolls.
            await more(18);

            const scrolls = await box(20);

            assert.equal(scrolls.shown, cap, "20 sessions: the list is as high as 18 of one line");
            assert.ok(scrolls.whole > scrolls.shown, "and it scrolls");
            assert.ok(scrolls.last, "to its last session");
        } finally {
            await app.removeUser(owner(app), ines.id);
            app.config.setUsers(THIS_SERVER, chosen);
            app.accessChanged();
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
        // The rights given her on each computer: the groups "On <computer>" of the Permissions part, each with its
        // switches. A computer with none to give her has no group.
        const rights = () =>
            inPage<Record<string, string[]>>(`
                return JSON.stringify(
                    Object.fromEntries(
                        [...document.querySelectorAll('.pages-detail [data-part="person-rules"] .group')]
                            .filter((group) => group.querySelector(".group-title")?.textContent.trim().startsWith("On "))
                            .map((group) => [
                                group.querySelector(".group-title").textContent.trim().slice(3),
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
            // for a viewer, none for a computer she is not chosen for. Under each computer in Folders and sessions
            // there is none: one place for each.
            await open("people");
            await show("Vera");
            await showPart("Permissions");
            assert.deepEqual(await rights(), {});
            await show("Gina");
            assert.deepEqual(await rights(), {
                "This server": [
                    "Gina overrides take turns on This server: off",
                    "Gina allows their own calls on This server: off",
                    "Gina shares what they were given on This server: off",
                ],
            });
            await showPart("Folders and sessions");
            assert.deepEqual(
                await switches(),
                ["Gina may use This server: on", "Gina may use Laptop: off"],
                "no right is repeated under a computer",
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

            // Her own browser: someone else's page says who they are, and no more.
            const ginas = await theirs.open(1);

            page = ginas;
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
            await open("people");
            await show("Vera");
            assert.deepEqual(await switches(), []);
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
            assert.match(await text(), /manages users/);
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
                        "Vera may become a user and prompt: on (disabled)",
                        "Vera can prompt: off (disabled)",
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
                "Uma links runners: off (disabled)",
                "Uma invites people: off",
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
            assert.match(await text(), /manages users/);

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

            // Taken back: her view of Vera is anyone's again, at once.
            page = ginas;
            app.setRight(owner(app), { person: guest.id, right: "managesUsers", on: false });
            await until(async () => (await switches()).length === 0, "Vera's switches to go");
            assert.equal(await removable(), false);

            // Settings, what holds for everyone, is for who manages the server: not hers until the owner lets her.
            const listed = () =>
                inPage<string[]>(
                    `return JSON.stringify([...document.querySelectorAll(".pages-item-title")].map((each) => each.textContent.trim()))`,
                );

            await open("people");
            assert.equal((await listed()).includes("Settings"), false);
            app.setRight(owner(app), { person: guest.id, right: "managesServer", on: true });
            await until(async () => (await listed()).includes("Settings"), "Settings to be hers");
            await show("Settings");
            assert.deepEqual(await switches(), ["Tasks expire with the session: off"]);
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
    "on another person's page each session is given and taken back on its own row: Invite where Revoke is, in the list of one's sessions and in a computer's tree; a folder they access all sessions in changes no row's button",
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

        /** A browser of `token`'s own, signed in. */
        const browserOf = (token: string) => ownBrowser(made, token);

        /** A session here that `starter` started. */
        const session = (title: string, starter: string) => startedBy(title, starter);

        /** Invite to your runner, where the page has it, by what it says; greyed out, it says so. */
        const buttons = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .reach-buttons button")].map((each) => each.textContent.trim() + (each.disabled ? " (disabled)" : "")))`,
            );

        /**
         * Tap a button of the page shown, by its name for a screen reader or else by what it says, once it takes a
         * click; what it asks is kept (`asked`), and answered with yes.
         */
        const tap = async (label: string) => {
            const found = `[...document.querySelectorAll(".pages-detail button:not([role=switch])")].find((each) => (each.getAttribute("aria-label") ?? each.textContent.trim()) === ${JSON.stringify(label)} && !each.disabled)`;

            await until(
                () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
                `${label} taking a click`,
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
        };

        /** That button, and what is under it. */
        const text = () =>
            inPage<string>(
                `return JSON.stringify((document.querySelector(".pages-detail .reach")?.textContent ?? "").replace(/\\s+/g, " "))`,
            );

        /** All of the part of the page that says where they work and what they have; nothing until it is drawn. */
        const pane = () =>
            inPage<string>(
                `return JSON.stringify((document.querySelector('.pages-detail [data-part="person-access"]')?.textContent ?? "").replace(/\\s+/g, " "))`,
            );

        /** What an opened list says when it has nothing to list. */
        const note = () =>
            inPage<string>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .at-note")].map((each) => each.textContent.replace(/\\s+/g, " ").trim()).join(" | "))`,
            );

        /** The place of the first session listed, and each part of a listed session that is cut short. */
        const lines = () =>
            inPage<{ where: string; cut: string[] }>(`
                const parts = [...document.querySelectorAll(".pages-detail .at-session :is(.at-session-name, .at-how, .at-where)")];

                return JSON.stringify({
                    where: document.querySelector(".pages-detail .at-session .at-where")?.textContent.trim() ?? "",
                    cut: parts.filter((each) => each.scrollWidth > each.clientWidth + 1).map((each) => each.className),
                });
            `);

        /** Whether a row that opens on the page shown says this, from its start. */
        const listed = async (label: string) =>
            (await folds()).some((each) => each.startsWith(label));

        /** `name`'s page in People, opened over `path`: home, or a session. */
        const over = async (name: string, path: string) => {
            await open("people", DESKTOP, path);
            await show(name);
        };

        const shared = (id: Awaited<ReturnType<typeof session>>) =>
            app.sessionMeta(id)?.sharedWith ?? [];
        const sees = (who: { user: User }, id: Awaited<ReturnType<typeof session>>) =>
            app.canSee(app.config.userById(who.user.id)!, id);

        try {
            await app.choosePerson(THIS_SERVER, dee.user.id, true);
            await app.choosePerson(THIS_SERVER, eli.user.id, true);

            const first = await session("reach: first", dee.user.id);
            const second = await session("reach: second", dee.user.id);
            const owned = await session("reach: the owner's", owner(app).id);
            // Her sessions on a computer someone else is in charge of are a card of that computer.
            const mine = "Your sessions on This server";

            await session("reach: Eli's own", eli.user.id);
            await app.commands.shareSession(owned, owner(app), [dee.user.id]);

            // Dee is in charge of no computer. Her page for Eli has what she gives him and the chat with him, and no
            // button for the session open behind People: a session is given on its own row. Her one button is greyed
            // out, and a line says why.
            const dees = await browserOf(dee.token);

            page = dees;
            await over("Eli", `/s/${String(first)}`);
            await until(async () => (await buttons()).length === 1, "her one button");
            assert.deepEqual(await shownParts(), ["Folders and sessions (shown)", "Chat"]);
            assert.deepEqual(await buttons(), ["Invite to your runner (disabled)"]);
            assert.match(await text(), /You have no runner of your own\./);
            assert.doesNotMatch(await pane(), /Invite to your session|Open a session/);

            // Under it, her sessions that are hers to share: the two she started, and not the one shared with her.
            // Eli has neither yet; each row ends in Invite, where Revoke would be.
            await until(() => listed(`${mine}: 0 of 2`), "the list, with none of the two his");
            assert.deepEqual(await folds(), [`${mine}: 0 of 2`]);
            await fold(mine);
            await until(async () => (await sessionRows()).length === 2, "her two sessions");

            const titles = async () => (await sessionRows()).map((each) => each.split(" | ")[0]!);
            const order = await titles();

            assert.deepEqual([...order].sort(), ["reach: first", "reach: second"]);
            assert.ok(
                (await sessionRows()).every((each) => each.endsWith("| not shared with them")),
                (await sessionRows()).join(", "),
            );

            // The lower one of the two: given, it would be first in a list made anew, and it stays where it is.
            const picked = order[1]!;
            const pickedId = picked === "reach: first" ? first : second;
            const otherId = picked === "reach: first" ? second : first;

            assert.deepEqual(
                [await has(`Invite Eli to ${picked}`), await has(`Revoke ${picked} from Eli`)],
                [true, false],
            );

            // One click shares it, and only it, and asks nothing; its button then takes it back.
            await tap(`Invite Eli to ${picked}`);
            await until(() => shared(pickedId).includes(eli.user.id), "that session shared");
            await until(() => has(`Revoke ${picked} from Eli`), "its button to turn");
            assert.deepEqual(await asked(), [], "Invite asks nothing");
            assert.equal(await has(`Invite Eli to ${picked}`), false, "one button, not two");
            assert.deepEqual(shared(otherId), []);
            assert.equal(sees(eli, pickedId), true);
            assert.equal(sees(eli, otherId), false);
            await until(() => listed(`${mine}: 1 of 2 (open)`), "the count to follow");
            assert.deepEqual(await titles(), order, "no row moved under the pointer");
            // The share is hers to end, and its row says whose it is.
            assert.ok((await sessionRows()).includes(`${picked} | shared by you`));

            // Its row says where it works, whole: the end of a place tells two folders apart. The card names the
            // computer, so the row does not.
            const wide = await lines();

            assert.doesNotMatch(wide.where, /This server/);
            assert.ok(wide.where.endsWith(work.split("/").pop()!), wide.where);
            assert.deepEqual(wide.cut, [], "nothing of a session's row is cut short");

            // On a phone nothing of it is wider than the screen, or cut short.
            await page.setViewport({ width: 390, height: 844, scale: 2, mobile: true });
            await until(
                async () => await inPage<boolean>(`return JSON.stringify(innerWidth <= 390)`),
                "the page at a phone's size",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                    return JSON.stringify(
                        [...document.querySelectorAll('.pages-sheet [data-part="person-access"], .pages-sheet [data-part="person-access"] *')]
                            .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                            .map((each) => each.className || each.tagName),
                    );
                `),
                [],
                "nothing of the button, its line, and the list is wider than the phone",
            );
            assert.deepEqual((await lines()).cut, [], "nor cut short there");
            await page.setViewport(DESKTOP);

            // Taken back from the same place, after it asks: the row stays, and ends in Invite again.
            await tap(`Revoke ${picked} from Eli`);
            await until(() => shared(pickedId).length === 0, "the share taken back");
            assert.deepEqual(await asked(), [`Stop sharing “${picked}” with Eli?`]);
            await until(() => has(`Invite Eli to ${picked}`), "its button to turn back");
            await until(() => listed(`${mine}: 0 of 2 (open)`), "the count, with none again");
            assert.deepEqual(await titles(), order);
            assert.equal(sees(eli, pickedId), false);

            // A session opens from its row, and People closes.
            await tap("Go to reach: second");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(location.pathname.endsWith(${JSON.stringify(`/s/${String(second)}`)}) && document.querySelector(".pages-sheet") === null)`,
                    ),
                "the session to open, and People to close",
            );

            // Lin cannot use this server, and it is not Dee's to turn on for her: none of her sessions can be Lin's, so
            // none is listed. The card says why once, in place of a row for each, and there is nothing to search.
            await over("Lin", "/");
            await until(
                async () => /Lin cannot use This server/.test(await pane()),
                "what the card says for Lin",
            );
            assert.match(
                await pane(),
                /Lin cannot use This server, so your 2 sessions here cannot be shared with them\. Whoever is in charge of it chooses who uses it\./,
            );
            assert.deepEqual(await folds(), [], "no list of sessions that cannot be given");
            assert.equal(await note(), "");
            assert.deepEqual(
                [
                    await has("Invite Lin to reach: first"),
                    await has("Go to reach: first"),
                    await has("Search sessions and folders"),
                ],
                [false, false, false],
            );
            assert.deepEqual(shared(first), []);

            // Lin linked a runner: her button opens it, with the switch Runners has. She has no session to share, so
            // the page lists none, and offers no search over nothing.
            page = await browserOf(lin.token);
            await over("Eli", "/");
            await until(async () => (await buttons()).length === 1, "her one button");
            assert.deepEqual(await buttons(), ["Invite to your runner"]);
            assert.doesNotMatch(await text(), /You have no runner of your own/);
            assert.deepEqual(await folds(), []);
            assert.deepEqual(
                await switches(),
                [],
                "her runner is closed until the button opens it",
            );
            assert.equal(await has("Search sessions and folders"), false);
            await tap("Invite to your runner");
            await until(
                async () => (await switches()).includes("Eli may use Lin's laptop: off"),
                "her runner, for him",
            );
            assert.match(await pane(), /Lin's laptop/);
            assert.equal(app.policy.mayUse({ id: eli.user.id }, laptop), false);
            await flip("Eli may use Lin's laptop");
            await until(() => app.policy.mayUse({ id: eli.user.id }, laptop), "Eli chosen for it");
            await until(
                async () => (await switches()).includes("Eli may use Lin's laptop: on"),
                "the switch on",
            );

            // The owner has Where they may work on the page: no button over it. This server's tree lists every session
            // there that is Eli's, or the owner's to give him, Dee's among them.
            const group = "Sessions of Eli on This server";

            page = owners;
            await over("Eli", `/s/${String(owned)}`);
            await until(
                async () => (await folds()).some((each) => each.startsWith(`${group}: 1 of `)),
                "his sessions on this server",
            );
            assert.deepEqual(await shownParts(), [
                "Folders and sessions (shown)",
                "Permissions",
                "Chat",
            ]);
            assert.deepEqual(await buttons(), [], "no button over the trees");
            assert.doesNotMatch(await pane(), /Invite to your session|Open a session/);
            await fold(group);
            await until(
                async () => (await sessionRows()).includes("reach: Eli's own | started it"),
                "his own session",
            );
            // In an open row the session whoever reads used last is first: the owner's own, before one of Eli's that
            // the owner never used.
            const placeOf = async (title: string) =>
                (await sessionRows()).findIndex((each) => each.startsWith(`${title} | `));

            assert.ok(
                (await placeOf("reach: the owner's")) < (await placeOf("reach: Eli's own")),
                (await sessionRows()).join(", "),
            );
            assert.ok((await sessionRows()).includes("reach: the owner's | not shared with them"));
            assert.ok((await sessionRows()).includes("reach: first | not shared with them"));
            assert.deepEqual(
                [
                    await has("Revoke reach: Eli's own from Eli"),
                    await has("Invite Eli to reach: Eli's own"),
                    await has("Invite Eli to reach: the owner's"),
                ],
                [true, false, true],
            );

            // Invite shares it with him, and leaves whom else it is shared with.
            await tap("Invite Eli to reach: the owner's");
            await until(() => shared(owned).includes(eli.user.id), "the owner's session shared");
            assert.deepEqual([...shared(owned)].sort(), [dee.user.id, eli.user.id].sort());
            assert.deepEqual(await asked(), []);
            await until(
                async () => (await sessionRows()).includes("reach: the owner's | shared with them"),
                "its row to say so",
            );

            // A folder he accesses all sessions in gives him its sessions, and changes no row's button: one of them he
            // has by the folder alone still ends in Invite; the one shared with him still ends in Revoke.
            const folder = `Folder ${work} of Eli on This server`;

            await app.giveFolders(owner(app), THIS_SERVER, eli.user.id, [work]);
            await until(
                async () => (await folds()).some((each) => each.startsWith(`${folder}: 2 of `)),
                "his folder, with the two he has in it",
            );
            await fold(folder);
            await app.seeFolder(owner(app), THIS_SERVER, eli.user.id, work, true);
            await until(
                async () =>
                    (await sessionRows()).includes("reach: first | accesses all sessions here"),
                "the folder's sessions to be his",
            );
            assert.equal(sees(eli, first), true);
            assert.deepEqual(shared(first), [], "the folder shares nothing itself");
            assert.deepEqual(
                [
                    await has("Invite Eli to reach: first"),
                    await has("Revoke reach: first from Eli"),
                    await has("Revoke reach: the owner's from Eli"),
                ],
                [true, false, true],
            );

            // The share taken back while the folder is on: Revoke says he still has it, and he does.
            await tap("Revoke reach: the owner's from Eli");
            await until(() => !shared(owned).includes(eli.user.id), "the share taken back");
            assert.deepEqual(await asked(), [
                `Stop sharing “reach: the owner's” with Eli? They still have it after that: they access all sessions in ${work}.`,
            ]);
            await until(
                async () =>
                    (await sessionRows()).includes(
                        "reach: the owner's | accesses all sessions here",
                    ),
                "its row to say how he has it now",
            );
            assert.equal(sees(eli, owned), true);

            // Invited to one while the folder is on, he keeps it when the folder's switch goes off; the rest is as it
            // was: not his, and to be given.
            await tap("Invite Eli to reach: first");
            await until(() => shared(first).includes(eli.user.id), "Dee's session shared with him");
            await app.seeFolder(owner(app), THIS_SERVER, eli.user.id, work, false);
            await until(
                async () =>
                    (await sessionRows()).includes("reach: the owner's | not shared with them"),
                "the folder's sessions to leave him",
            );
            // The session list comes a moment after the computer's switch does (`app.ts` `#scheduleSessions`).
            await until(
                async () => (await sessionRows()).includes("reach: first | shared with them"),
                "the one he was invited to, still his",
            );
            assert.deepEqual([sees(eli, first), sees(eli, owned)], [true, false]);
            assert.deepEqual(
                [
                    await has("Revoke reach: first from Eli"),
                    await has("Invite Eli to reach: the owner's"),
                ],
                [true, true],
            );

            // Lin cannot use this server yet: nothing there is listed for her until its switch is on. Then its sessions
            // are, each to be given.
            const lins = "Sessions of Lin on This server";

            await over("Lin", "/");
            await until(
                async () => (await switches()).includes("Lin may use This server: off"),
                "her switch for this server",
            );
            assert.deepEqual(
                (await folds()).filter((each) => each.includes("This server")),
                [],
                "no row to give from while she cannot use it",
            );
            await flip("Lin may use This server");
            await until(
                () => app.policy.mayUse({ id: lin.user.id }, THIS_SERVER),
                "Lin chosen for this server",
            );
            await until(
                async () => (await folds()).some((each) => each.startsWith(`${lins}: 0 of `)),
                "this server's sessions, for her",
            );
            await fold(lins);
            await tap("Invite Lin to reach: the owner's");
            await until(() => shared(owned).includes(lin.user.id), "the session shared with Lin");
            await until(() => has("Revoke reach: the owner's from Lin"), "its button to turn");

            // Someone in charge of a computer has every session there. Lin manages runners now, so she is in charge of
            // this server: Dee has nothing to give her, a line says so, and no list counts 0 over it.
            app.setRight(owner(app), { person: lin.user.id, right: "managesRunners", on: true });
            page = dees;
            await over("Lin", `/s/${String(first)}`);
            await until(
                async () =>
                    /Lin is in charge of This server: every session there is theirs\./.test(
                        await pane(),
                    ),
                "the line in place of the list",
            );
            assert.deepEqual(await buttons(), ["Invite to your runner (disabled)"]);
            assert.deepEqual(await folds(), [], "no list that counts 0");
        } finally {
            // The tests share one page: the owner's again, at its usual size, whatever happened.
            page = owners;
            await page.setViewport(DESKTOP);

            for (const each of made) {
                await each.closeAll({ final: true });
            }

            app.config.removeRunner(laptop);

            for (const each of [dee, eli, lin]) {
                if (app.config.userById(each.user.id) !== undefined) {
                    app.config.removeUser(each.user.id);
                }
            }

            app.accessChanged();
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
        const inQuartz = `Folder ${quartz} of Ben on This server`;
        const inTopaz = `Folder ${topaz} of Ben on This server`;
        const others = "Other sessions of Ben on This server";
        const field = `.pages-detail input[aria-label="Search sessions and folders"]`;

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
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .access-pick > span")].map((each) => each.textContent.trim()))`,
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

        /** What the page says where nothing is found; nothing where something is. */
        const nothing = () =>
            inPage<string>(
                `return JSON.stringify((document.querySelector(".pages-detail .access-none")?.textContent ?? "").replace(/\\s+/g, " ").trim())`,
            );

        /** The computers the page shown has a card for, by id. */
        const cards = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .access-row[data-computer]")].map((each) => each.dataset.computer))`,
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
                    [...document.querySelectorAll(".pages-detail .at-session")].map((each) => [
                        each.querySelector(".at-session-name").textContent.trim(),
                        each.querySelector(".at-used")?.textContent.trim() ?? "",
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
            await showPart("Folders and sessions");
            // His folders, closed: one of the two sessions in the first is his. The archived one is not counted.
            await until(async () => (await folds()).includes(`${inQuartz}: 1 of 2`), "his folders");
            assert.ok((await folds()).includes(`${inTopaz}: 0`));
            assert.ok((await folds()).some((each) => each.startsWith(`${others}: 0 of `)));
            assert.deepEqual(await sessionRows(), [], "closed until opened, or searched");
            assert.deepEqual(await picks(), ["Access", "Last used by you", "Started by"]);
            assert.equal(await found(), "");

            // A word of a session's name. The rows that hold one are open, the folder with none is left out, the word
            // is marked, and the search says how many it found.
            await type("zeta");
            await lists(["find: zeta one", "find: zeta two"], "the two called zeta");
            assert.equal(await count(), 2);
            assert.equal((await folds()).length, 2);
            assert.equal((await folds())[0], `${inQuartz}: 1 of 2 (open)`);
            assert.match(
                (await folds())[1]!,
                /^Other sessions of Ben on This server: 0 of \d+ \(open\)$/,
            );
            assert.deepEqual(await marks(".at-session-name"), ["zeta", "zeta"]);

            // Each word typed, in any case and any order.
            await type("  TWO   Zeta ");
            await lists(["find: zeta two"], "each word, in any case and order");
            assert.equal(await count(), 1);

            // A word of a folder: the sessions that work in it, his and the others, and the folder's own row marked.
            await type("quartz");
            await lists(["find: his", "find: zeta one"], "the sessions in that folder");
            assert.deepEqual(await folds(), [`${inQuartz}: 1 of 2 (open)`]);
            assert.ok((await sessionRows()).includes("find: his | started it"));
            assert.deepEqual(await marks(".at-folder .ft-name"), ["quartz"]);

            // A folder with no session in it is found by its own path.
            await type("topaz");
            await until(
                async () => (await folds()).includes(`${inTopaz}: 0 (open)`),
                "the folder itself",
            );
            assert.deepEqual(await folds(), [`${inTopaz}: 0 (open)`]);
            assert.deepEqual(await sessionRows(), []);
            assert.equal(await count(), 0);
            assert.equal(await nothing(), "", "a folder is found: that is not nothing");

            // Nothing by that name: the page says so, with nothing listed. The archived session is not found either.
            await type("nomatchxyz");
            await until(async () => (await nothing()) !== "", "nothing by that name");
            assert.equal(await nothing(), "No session matches “nomatchxyz”. Clear");
            assert.deepEqual(await folds(), []);
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
            assert.deepEqual(await under(inQuartz), ["find: zeta one", "find: his"]);
            assert.deepEqual(await under(others), ["find: omega", "find: old", "find: zeta two"]);
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
            assert.deepEqual(await under(others), [
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
            assert.ok((await sessionRows()).includes("find: omega | shared with them"));
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
            assert.ok((await sessionRows()).includes("find: omega | not shared with them"));
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
            assert.ok((await folds()).includes(`${inQuartz}: 1 of 2`));

            // Runners lists what he has, and searches nothing.
            await open("computers");
            await show("This server");
            await inPage(`
                [...document.querySelectorAll(".sheet-tabs [role=tab]")]
                    .find((each) => each.textContent.trim().startsWith("People"))
                    .click();

                return JSON.stringify(true);
            `);
            await until(
                async () => (await folds()).includes(`${inQuartz}: 1`),
                "his tree in Runners",
            );
            assert.equal(await has("Search sessions and folders"), false);

            // Ann is in charge of nothing: her sessions on this server are a card of it. She starts a second one, since
            // one session alone is nothing to search. The same search and filters are over the card; with one starter
            // there is no Started by. A computer with nothing to list is left out.
            await startedBy("find: her other", ann.user.id, work, 5, ann.user.id);
            page = await ownBrowser(made, ann.token);
            await open("people");
            await show("Ben");
            await until(
                async () => (await folds()).includes("Your sessions on This server: 0 of 2"),
                "her card for him",
            );
            assert.ok((await cards()).includes(THIS_SERVER), "her card of this server");
            assert.deepEqual(await picks(), ["Access", "Last used by you"]);
            await type("ZETA");
            await lists(["find: zeta two"], "her search");
            assert.equal(await found(), "1 of 2");
            assert.deepEqual(await folds(), ["Your sessions on This server: 0 of 2 (open)"]);
            assert.deepEqual(await cards(), [THIS_SERVER]);
            assert.deepEqual(
                await marks(".at-session-name"),
                ["zeta"],
                "the word is marked here too",
            );
            // A row's end says when she last used it herself, as on a computer of one's own: five hours ago.
            await type("other");
            await lists(["find: her other"], "the one she used");
            assert.deepEqual(await used(), { "find: her other": "5h" });
            await type("omega");
            await until(async () => (await nothing()) !== "", "nothing of hers by that name");
            assert.equal(await nothing(), "No session matches “omega”. Clear");
            assert.deepEqual(await folds(), [], "a computer with nothing to list is left out");
            assert.deepEqual(await cards(), [], "and so is its card");
            await type("");
            await pick("Access", "has");
            await until(
                async () => (await nothing()) === "No session matches these filters. Clear",
                "nothing of hers that he has",
            );
            await tap("Clear the search and the filters");
            await until(
                async () => (await folds()).includes("Your sessions on This server: 0 of 2"),
                "her card again, closed",
            );
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
    "someone who shares what they were given gives a folder that was given to them on a person's page, and takes back what they gave: a session someone else shared has no button, a folder with nothing to give or to list is left out, and one session alone has no search",
    real,
    async () => {
        const kay = app.config.addUser("Kay", "guest");
        const lou = app.config.addUser("Lou", "guest");
        const amber = join(root, "give-amber");
        const beryl = join(root, "give-beryl");
        const owners = page;
        const made: Browsers[] = [];
        const here = "of Lou on This server";
        const search = "Search sessions and folders";
        const give = (folder: string) => `Give Lou ${folder} on This server`;
        const remove = (folder: string) => `Remove ${folder} from Lou on This server`;
        const closed = (label: string) => label.replace(" (open)", "");
        let moe: typeof kay | undefined;
        let vee: typeof kay | undefined;

        /** What the row of `folder` ends in, after its name and count: what it says there and its buttons. */
        const ends = (folder: string) =>
            inPage<string>(`
                const line = [...document.querySelectorAll(".pages-detail .at-folder-line")].find((each) =>
                    (each.querySelector(".at-folder")?.getAttribute("aria-label") ?? "").startsWith(${JSON.stringify(`Folder ${folder} `)}),
                );

                return JSON.stringify(
                    (line?.querySelector(".at-actions")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
                );
            `);

        /** What the card of a computer says under its name. */
        const says = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail .access-row .setting .muted")].map((each) => each.textContent.replace(/\\s+/g, " ").trim()))`,
            );

        /** What the buttons of the row of the session called `title` say; none when it is not listed. */
        const buttons = (title: string) =>
            inPage<string[]>(`
                const row = [...document.querySelectorAll(".pages-detail .at-session")].find(
                    (each) => each.querySelector(".at-session-name").textContent.trim() === ${JSON.stringify(title)},
                );

                return JSON.stringify(
                    row === undefined ? [] : [...row.querySelectorAll("button")].map((each) => each.textContent.trim()),
                );
            `);

        /** Open the row of a tree called `name`, when it is closed. */
        const unfold = async (name: string) => {
            if (
                (await folds()).some((each) => each.startsWith(name) && !each.endsWith(" (open)"))
            ) {
                await fold(name);
            }
        };

        try {
            mkdirSync(amber);
            mkdirSync(beryl);
            await app.choosePerson(THIS_SERVER, kay.user.id, true);
            await app.choosePerson(THIS_SERVER, lou.user.id, true);
            await app.giveFolders(owner(app), THIS_SERVER, kay.user.id, [amber, beryl]);
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: kay.user.id,
                right: "reshares",
                on: true,
            });

            // Vee views, and is chosen for this server.
            vee = app.config.addUser("Vee", "viewer");
            await app.choosePerson(THIS_SERVER, vee.user.id, true);

            // One session that Kay started in a folder of hers.
            const hers = await startedBy("give: her own", kay.user.id, amber);

            // Kay shares what she was given. This server, which she is not in charge of, is a card on Lou's page: the
            // folders given to her, each to be given on, with her sessions under them. Two folders are something to
            // search, though they hold one session.
            const kays = await ownBrowser(made, kay.token);

            page = kays;
            await open("people");
            await show("Lou");
            await until(async () => (await folds()).length === 2, "her card for Lou");
            assert.deepEqual(await folds(), [
                `Folder ${amber} ${here}: 0 of 1`,
                `Folder ${beryl} ${here}: 0`,
            ]);
            assert.equal(await has(search), true, "two folders to search, with one session");

            // One of the owner's is shared with her and with Lou: it joins the card at once, as the rest of her
            // sessions. Moe is invited to that one alone.
            const theirs = await startedBy("give: shared with her", owner(app).id);

            await app.commands.shareSession(theirs, owner(app), [kay.user.id, lou.user.id]);
            moe = app.config.addUser("Moe", "viewer", [String(theirs)]);
            await until(
                async () => (await folds()).length === 3,
                "the session shared with her, on the card",
            );
            assert.deepEqual(await folds(), [
                `Folder ${amber} ${here}: 0 of 1`,
                `Folder ${beryl} ${here}: 0`,
                "Your other sessions on This server: 1",
            ]);
            assert.deepEqual(await says(), [
                "Someone else is in charge here. You share what you have here.",
            ]);
            assert.deepEqual(
                [await has(give(amber)), await has(give(beryl)), await has(search)],
                [true, true, true],
            );

            // She gives one: it is Lou's at once, noted as given by her, and its button now takes it back.
            await press(give(amber));
            await until(() => has(remove(amber)), "the folder she gave, to be taken back");
            assert.deepEqual(await asked(), [], "giving a folder asks nothing");
            assert.deepEqual([...app.config.givenFolders(THIS_SERVER, lou.user.id)], [amber]);
            assert.equal(app.config.givenBy(THIS_SERVER, lou.user.id)[amber], kay.user.id);
            assert.deepEqual([await has(give(amber)), await has(give(beryl))], [false, true]);

            // A session the owner shared with Lou says who shared it, and has no button after Go to session: that
            // share is not hers to end. Her own session is hers to give.
            await unfold(`Folder ${amber} ${here}`);
            await unfold("Your other sessions on This server");
            await until(async () => (await sessionRows()).length === 2, "her two rows");
            assert.deepEqual((await sessionRows()).sort(), [
                "give: her own | not shared with them",
                `give: shared with her | shared by ${owner(app).name}`,
            ]);
            assert.deepEqual(await buttons("give: shared with her"), ["Go to session"]);
            assert.deepEqual(await buttons("give: her own"), ["Go to session", "Invite"]);

            await press("Invite Lou to give: her own");
            await until(
                async () => (await sessionRows()).includes("give: her own | shared by you"),
                "the share she made",
            );
            assert.deepEqual(await buttons("give: her own"), ["Go to session", "Revoke"]);
            assert.deepEqual(app.sessionMeta(hers)?.sharedWith, [lou.user.id]);

            // Moe is invited to one session only, so nothing of hers can be his. The card says so once and lists the
            // one session he has. Her folders, which she can neither give him nor take back, are left out, and one
            // session is nothing to search.
            await open("people");
            await show("Moe");
            await until(
                async () => (await says()).some((each) => each.startsWith("Moe is invited")),
                "her card for Moe",
            );
            assert.deepEqual(await says(), [
                "Moe is invited to one session only, so your session here cannot be shared with them.",
            ]);
            assert.deepEqual((await folds()).map(closed), ["Your sessions on This server: 1"]);
            assert.deepEqual(
                [await has(search), await has(`Give Moe ${amber} on This server`)],
                [false, false],
            );

            // Vee can have both sessions, so both are listed, and the folder with one of them in it. A viewer has no
            // folders: the card says so, and that folder is not offered to her.
            await open("people");
            await show("Vee");
            await until(async () => (await folds()).length === 2, "her card for Vee");
            assert.deepEqual(await says(), ["Folders are given to users only."]);
            assert.deepEqual((await folds()).map(closed), [
                `Folder ${amber} of Vee on This server: 0 of 1`,
                "Your other sessions on This server: 0 of 1",
            ]);
            assert.deepEqual(
                [
                    await has(`Give Vee ${amber} on This server`),
                    await has(`Give Vee ${beryl} on This server`),
                    await ends(amber),
                ],
                [false, false, ""],
            );

            // Whoever is in charge has that session in the computer's tree as shared with them, whoever shared it:
            // any share there is theirs to take back.
            page = owners;
            await open("people");
            await show("Lou");
            await showPart("Folders and sessions");
            await until(
                async () =>
                    (await folds()).some((each) => each.startsWith(`Folder ${amber} ${here}`)),
                "the folder Kay gave, in the owner's tree",
            );
            await unfold(`Folder ${amber} ${here}`);
            await until(
                async () => (await sessionRows()).includes("give: her own | shared with them"),
                "that session, as the owner reads it",
            );
            assert.deepEqual(await buttons("give: her own"), ["Go to session", "Revoke"]);

            // The owner gives Lou her other folder. On her card it is Lou's now, and says who gave it: it is not hers
            // to take back, so it ends in no button. The one she gave keeps its Remove.
            await app.giveFolder(owner(app), THIS_SERVER, lou.user.id, beryl, true);
            page = kays;
            await open("people");
            await show("Lou");
            await until(
                async () => (await ends(beryl)).startsWith("given by"),
                "the folder the owner gave Lou, on her card",
            );
            assert.equal(await ends(beryl), `given by ${owner(app).name}`);
            assert.deepEqual(
                [await has(remove(amber)), await has(remove(beryl)), await has(give(beryl))],
                [true, false, false],
            );

            // With the permission off again she gives nothing more, and still takes back what she gave: the folder,
            // and the share she made. The session the owner shared is no longer hers to share, so it is not listed,
            // and neither is the folder the owner gave. Her card follows at once.
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: kay.user.id,
                right: "reshares",
                on: false,
            });
            await until(
                async () => (await folds()).length === 1,
                "her card for Lou, with the permission off",
            );
            assert.equal(await has(remove(amber)), true);
            assert.deepEqual((await folds()).map(closed), [`Folder ${amber} ${here}: 1`]);
            assert.deepEqual([await has(give(beryl)), await has(search)], [false, false]);
            await unfold(`Folder ${amber} ${here}`);
            await until(async () => (await sessionRows()).length > 0, "her one row");
            assert.deepEqual(await sessionRows(), ["give: her own | shared by you"]);
            assert.deepEqual(await buttons("give: her own"), ["Go to session", "Revoke"]);

            await press(remove(amber));
            await until(async () => !(await has(remove(amber))), "the folder, taken back");
            assert.match((await asked())[0] ?? "", /^Remove .+ from Lou\?/);
            assert.deepEqual(
                [...app.config.givenFolders(THIS_SERVER, lou.user.id)],
                [beryl],
                "hers is taken back, the owner's stays",
            );
            assert.deepEqual(
                app.sessionMeta(hers)?.sharedWith,
                [lou.user.id],
                "the share she made stays",
            );
        } finally {
            // The tests share one page: the owner's again, at its usual size, whatever happened.
            page = owners;
            await page.setViewport(DESKTOP);

            for (const each of made) {
                await each.closeAll({ final: true });
            }

            for (const each of [kay, lou, moe, vee]) {
                if (each !== undefined && app.config.userById(each.user.id) !== undefined) {
                    app.config.removeUser(each.user.id);
                }
            }

            app.accessChanged();
        }
    },
);
