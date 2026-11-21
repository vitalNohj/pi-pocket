// The People sheet in a real browser (`web/sheets/people.js`): laid out as the Runners sheet is, and where a person may
// work is the same record as each computer's People in Runners (`web/sheets/access.js`), in both directions: whether
// they may use it, and under it one tree of that computer alone, with the rows of the Files panel's: the folders given
// to them there, closed until opened, and in each the sessions they have in it. Each row is taken back alone. A runner
// someone else linked is the owner's to read in Runners, and no choice in People.
import { newIdentity } from "../src/runner/secure-link.ts";
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
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
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
        `return JSON.stringify(document.querySelector('.pages-detail [aria-label=${JSON.stringify(label)}]') !== null)`,
    );

test("what a person may use is set in People, and shows in Runners", real, async () => {
    const given = realpathSync(root);

    await open("people");
    await show("Gina");
    assert.deepEqual(await switches(), [
        "Gina can prompt: on",
        "Gina links runners: off",
        "Gina invites people: off",
        "Gina manages users: off",
        "Gina manages runners: off",
        "Gina manages the server: off",
        "Gina keeps sessions warm: off",
        "Gina may use This server: off",
        "Gina may use Laptop: off",
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
    await until(async () => await has("Give Gina a folder on Laptop"), "her trees");
    assert.equal(await has("Give Gina a folder on This server"), true);
    assert.deepEqual(await folds(), [], "no folder given, and no session, so nothing to open");
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
        () => app.config.givenFolders(undefined, guest.id).includes(given),
        "the folder to be given",
    );
    assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);
    await until(
        async () => (await folds()).includes(`Folder ${given} of Gina on This server: 0`),
        "the folder's row",
    );
    assert.deepEqual(await folds(), [`Folder ${given} of Gina on This server: 0`]);
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
        await until(async () => (await folds()).includes(`${folder}: 3`), "her folder's count");
        assert.deepEqual(
            (await folds()).filter((each) => each.includes("Gina")),
            [`${folder}: 3`, "Other sessions of Gina on This server: 1"],
        );
        assert.deepEqual(await sessionRows(), [], "closed: no session shows");

        // Opened, the folder holds the sessions she has in it, and only those.
        await fold(folder);
        await until(async () => (await sessionRows()).length === 3, "her sessions in the folder");
        assert.deepEqual((await sessionRows()).sort(), [
            "Her first | started it",
            "Her second | started it",
            "The owner's | shared with them",
        ]);
        await fold("Other sessions of Gina on This server");
        await until(async () => (await sessionRows()).length === 4, "the one outside her folders");
        assert.deepEqual(await under("Other sessions of Gina on This server"), ["Elsewhere"]);
        assert.deepEqual((await under(folder)).sort(), ["Her first", "Her second", "The owner's"]);

        // The folder's own switch: she sees every session in it, whoever started it. It says how many become hers; the
        // one that does shows how she has it, and is not taken back alone. Off, it leaves her again, and only it.
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
        assert.equal(await has("Go to Not hers"), true);
        assert.equal(await has("Revoke Not hers from Gina"), false);
        assert.equal(await has("Revoke Her second from Gina"), true, "one of her own still is");
        await flip(seesAll);
        await until(
            () => !listed().includes(unshared),
            "the server to take the folder's sessions back",
        );
        assert.deepEqual(listed().sort(), [first, second, shared, outside].sort());
        await until(async () => (await folds()).includes(`${folder}: 3 (open)`), "its row to go");
        assert.ok((await switches()).includes(`${seesAll}: off`));

        // One session is taken from her alone: the others, and her folder, stay.
        await press("Revoke Her first from Gina");
        await until(() => !listed().includes(first), "the server to take it from her");
        assert.ok(listed().includes(second) && listed().includes(shared));
        assert.equal(app.policy.mayStart(guest, THIS_SERVER), true);
        await until(async () => (await folds()).includes(`${folder}: 2 (open)`), "the row to go");

        await press("Revoke The owner's from Gina");
        await until(() => !listed().includes(shared), "the server to stop sharing it");
        assert.deepEqual(listed().sort(), [second, outside].sort());

        // The same tree on her page in People, and a session's row opens it.
        await open("people");
        await show("Gina");
        await until(async () => (await folds()).includes(`${folder}: 1`), "her tree in People");
        assert.ok((await folds()).includes("Other sessions of Gina on This server: 1"));
        await fold(folder);
        await until(async () => (await sessionRows()).length === 1, "her session in People");
        assert.deepEqual(await sessionRows(), ["Her second | started it"]);
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
            () => app.config.givenFolders(undefined, guest.id).length === 0,
            "the folder to be taken back",
        );
        assert.equal(app.policy.mayUse(guest, THIS_SERVER), true, "she is still chosen");
        await until(() => !listed().includes(second), "her session in that folder to move");
        assert.deepEqual(listed(), [outside]);
        // With no folder of hers left, her sessions are one group.
        await until(
            async () => (await folds()).includes("Sessions of Gina on This server: 1"),
            "the tree to follow",
        );
        assert.deepEqual(
            (await folds()).filter((each) => each.includes("This server")),
            ["Sessions of Gina on This server: 1"],
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
            "Vera may become a user and prompt: on (disabled)",
            "Vera can prompt: off (disabled)",
            "Vera may use This server: off",
            "Vera may use Laptop: off",
        ]);
        // A viewer is chosen as anyone is, and given no folders: they start nothing.
        await flip("Vera may use This server");
        await until(() => app.policy.mayUse(viewer, THIS_SERVER), "the server to choose Vera");
        await until(
            async () => (await folds()).includes("Sessions of Vera on This server: 0"),
            "her sessions' row",
        );
        assert.equal(await has("Give Vera a folder on This server"), false);

        await show("Sam");
        assert.deepEqual(await switches(), [
            "Sam may become a user and prompt: on (disabled)",
            "Sam can prompt: off (disabled)",
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
        assert.equal(await part(".small"), "Sign in a device of theirs", "also on a viewer's page");
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
        // With the tree open: its session's row and buttons fit too.
        await fold("Sessions of Gina on This server");
        await until(async () => (await sessionRows()).length === 1, "her session's row");

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

            // Someone else's, as the owner sees it: every group of theirs.
            await show("Gina");
            await until(async () => (await titles()).length === 3, "Gina's groups");
            assert.deepEqual(await titles(), [
                ["What they may do", 0],
                ["Where they may work", 0],
                ["Sign-in", 0],
            ]);

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
            app.config.setServerUsers([...new Set([...chosen, user.id])]);
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

            app.config.setServerUsers(chosen);
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
        app.config.setServerUsers([...new Set([...chosen, guest.id])]);
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
            app.config.setServerUsers(chosen);
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
        app.config.setServerUsers([...new Set([...chosen, guest.id])]);
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
            app.config.setServerUsers(chosen);
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
    "an opened row shows 18 sessions at their full height; with more, that list scrolls alone",
    real,
    async () => {
        // Ines joined with the owner's invite to their sessions: every session the owner started is shared with her.
        const ines = app.config.addUser("Ines", "viewer").user;
        const hers = () => app.sessions(ines).length;

        const more = async (count: number) => {
            for (let index = 0; index < count; index++) {
                await app.commands.createSession(owner(app), { cwd: work, title: "One of many" });
            }

            await app.welcome(ines.id, owner(app).id);
        };

        const box = async (count: number) => {
            await open("people");
            await show("Ines");
            // Her sessions reach the page after it shows, and their row with them.
            await until(
                async () =>
                    (await folds()).some((each) =>
                        each.startsWith("Sessions of Ines on This server"),
                    ),
                "the row of her sessions",
            );
            await fold("Sessions of Ines on This server");
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

        await app.welcome(ines.id, owner(app).id);
        assert.ok(hers() <= 18, "room to make it 18");
        await more(18 - hers());
        assert.equal(hers(), 18);

        const fits = await box(18);

        assert.equal(fits.whole, fits.shown, "18 sessions: nothing to scroll");

        await more(1);

        const scrolls = await box(19);

        assert.equal(scrolls.shown, fits.shown, "19 sessions: the list is as high as 18");
        assert.ok(scrolls.whole > scrolls.shown, "and it scrolls");
        assert.ok(scrolls.last, "to its last session");
    },
);

test(
    "a person's rights on a computer are two switches under it, for those who prompt there: flipped, their open session offers the wheel and their own calls at once",
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
        const rights = () =>
            inPage<Record<string, string[]>>(
                `return JSON.stringify(Object.fromEntries([...document.querySelectorAll(".pages-detail .access-row")].map((row) => [row.querySelector("strong").textContent.trim(), [...row.querySelectorAll("[data-right] [role=switch]")].map((each) => each.getAttribute("aria-label"))])))`,
            );

        assert.ok(token !== undefined);
        // Chosen for this server, both; for the Laptop, neither.
        app.config.setServerUsers([...new Set([...chosen, guest.id, viewer.id])]);
        app.config.setRunnerUsers(runnerId, []);
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

            // The owner's People: the two switches under This server for her, who prompts there; none for a viewer,
            // none under a computer she is not chosen for.
            await open("people");
            await show("Vera");
            assert.deepEqual(await rights(), { "This server": [], Laptop: [] });
            await show("Gina");
            assert.deepEqual(await rights(), {
                "This server": [
                    "Gina overrides take turns on This server: off",
                    "Gina allows their own calls on This server: off",
                ],
                Laptop: [],
            });

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
            app.config.setServerUsers(chosen);
            app.config.setRunnerUsers(runnerId, there);
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
                /On: they invite people, change what other people may do, remove them, and make a sign-in link for a viewer\./,
            );
            // Invite people comes with it: on, and not a switch of its own while she manages users.
            assert.ok((await switches()).includes("Gina invites people: on (disabled)"));
            assert.match(await text(), /On with Manage users: they invite people/);

            // Her page for Vera shows what the owner's does, without a reload, with the link that signs in as a viewer.
            page = ginas;
            await until(
                async () =>
                    JSON.stringify(await switches()) ===
                    JSON.stringify([
                        "Vera may become a user and prompt: on (disabled)",
                        "Vera can prompt: off (disabled)",
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

            // She has neither of these herself, so they are not hers to turn on; and whether Uma manages users is the
            // owner's. Inviting people she has with managing users. No link signs a device in as a user.
            await show("Uma");
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
            assert.equal((await switches()).length, 2);
            assert.deepEqual(await wider(), []);
            page = owners;
            await open("people", VIEWPORTS.mobile);
            await show("Gina");
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
    "on another person's page a user invites them to the session open behind People, and to their runner; no session is listed, and a button with nothing behind it is greyed out",
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
        const browserOf = async (token: string): Promise<BrowserPage> => {
            const theirs = new Browsers({
                dataDir: mkdtempSync(join(root, "people-sheet-reach-")),
                load: async () => undefined,
                save: () => {},
            });

            made.push(theirs);

            const opened = await theirs.open(1);

            await opened.navigate(`${base}/login?token=${encodeURIComponent(token)}`);

            return opened;
        };

        /** A session here that `starter` started. */
        const session = async (title: string, starter: string) => {
            const id = await newSession(app);

            await app.harness.commit(async (tx) => {
                const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

                meta.title = title;
                meta.createdBy = starter;
            }, context);

            return id;
        };

        /** The buttons of the page shown, by what they say; a greyed one says so. */
        const buttons = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".pages-detail button:not([role=switch])")].map((each) => each.textContent.trim() + (each.disabled ? " (disabled)" : "") + (each.getAttribute("aria-expanded") === "true" ? " (open)" : "")))`,
            );

        /** Tap a button of the page shown, once it takes a click; what it asks is kept, and answered with yes. */
        const tap = async (label: string) => {
            const found = `[...document.querySelectorAll(".pages-detail button:not([role=switch])")].find((each) => each.textContent.trim() === ${JSON.stringify(label)} && !each.disabled)`;

            await until(
                () => inPage<boolean>(`return JSON.stringify(${found} !== undefined)`),
                `${label} taking a click`,
            );
            await inPage(`
                window.asked = null;
                window.confirm = (text) => {
                    window.asked = text;

                    return true;
                };
                ${found}.click();

                return JSON.stringify(true);
            `);
        };

        const text = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".pages-detail .reach").textContent.replace(/\\s+/g, " "))`,
            );

        /** Eli's page in People, opened over `path`: home, or a session. */
        const eliOver = async (path: string) => {
            await open("people", DESKTOP, path);
            await show("Eli");
        };

        const shared = (id: Awaited<ReturnType<typeof session>>) =>
            app.sessionMeta(id)?.sharedWith ?? [];

        try {
            await app.choosePerson(THIS_SERVER, dee.user.id, true);
            await app.choosePerson(THIS_SERVER, eli.user.id, true);

            const first = await session("reach: first", dee.user.id);
            const second = await session("reach: second", dee.user.id);
            const elis = await session("reach: Eli's own", eli.user.id);
            const owned = await session("reach: the owner's", owner(app).id);

            await app.commands.shareSession(owned, owner(app), [dee.user.id]);

            // Dee is on no session, and has no runner: both buttons are greyed out, and a line says why.
            page = await browserOf(dee.token);
            await eliOver("/");
            await until(async () => /Open a session/.test(await text()), "the line for no session");
            assert.deepEqual(await buttons(), [
                "Invite to your session (disabled)",
                "Invite to your runner (disabled)",
            ]);
            assert.match(
                await text(),
                /Open a session to invite them to it\. You have no runner of your own\./,
            );

            // On one of her sessions: the button is for that session, by name. No session is listed, to check or not.
            await eliOver(`/s/${String(first)}`);
            await until(
                async () => /Shares “reach: first” with Eli\./.test(await text()),
                "the line naming the open session",
            );
            assert.deepEqual(await buttons(), [
                "Invite to your session",
                "Invite to your runner (disabled)",
            ]);
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(".pages-detail .reach input, .pages-detail .session-picker, .pages-detail .sp-row").length)`,
                ),
                0,
                "no list of sessions",
            );
            assert.doesNotMatch(await text(), /reach: second/);

            // One click shares it, and only it; the button then takes it back.
            await tap("Invite to your session");
            await until(() => shared(first).includes(eli.user.id), "the open session shared");
            await until(
                async () => (await buttons())[0] === "Remove from your session",
                "the button to take it back",
            );
            assert.match(await text(), /Eli has “reach: first” from you\./);
            assert.deepEqual(shared(second), []);
            assert.equal(app.canSee(app.config.userById(eli.user.id)!, first), true);
            assert.equal(app.canSee(app.config.userById(eli.user.id)!, second), false);

            // On a phone nothing of it is wider than the screen.
            await page.setViewport({ width: 390, height: 844, scale: 2, mobile: true });
            await until(
                async () => await inPage<boolean>(`return JSON.stringify(innerWidth <= 390)`),
                "the page at a phone's size",
            );
            assert.deepEqual(
                await inPage<string[]>(`
                    return JSON.stringify(
                        [...document.querySelectorAll(".pages-sheet .reach, .pages-sheet .reach *")]
                            .filter((each) => each.getBoundingClientRect().right > innerWidth + 0.5 || each.getBoundingClientRect().left < -0.5)
                            .map((each) => each.className || each.tagName),
                    );
                `),
                [],
                "nothing of the buttons and their line is wider than the phone",
            );
            await page.setViewport(DESKTOP);

            // Taken back with the same button, after it asks.
            await tap("Remove from your session");
            await until(() => shared(first).length === 0, "the share taken back");
            assert.equal(
                await inPage<string>(`return JSON.stringify(window.asked)`),
                "Stop sharing “reach: first” with Eli?",
            );
            await until(
                async () => (await buttons())[0] === "Invite to your session",
                "the button to share it again",
            );
            assert.equal(app.canSee(app.config.userById(eli.user.id)!, first), false);

            // A session shared with her is not hers to share: greyed out, and said.
            await eliOver(`/s/${String(owned)}`);
            await until(
                async () => /The open session is not yours to share\./.test(await text()),
                "the line for a session of someone else",
            );
            assert.equal((await buttons())[0], "Invite to your session (disabled)");

            // Lin linked a runner and is on no session: the first button is greyed out, and the second turns her
            // runner on for him, with the switch Runners has.
            page = await browserOf(lin.token);
            await eliOver("/");
            await until(async () => /Open a session/.test(await text()), "the line for no session");
            assert.deepEqual(await buttons(), [
                "Invite to your session (disabled)",
                "Invite to your runner",
            ]);
            assert.doesNotMatch(await text(), /You have no runner of your own/);
            await tap("Invite to your runner");
            await until(
                async () => (await switches()).includes("Eli may use Lin's laptop: off"),
                "her runner, for him",
            );
            assert.match(await text(), /Your runners/);
            assert.equal(app.policy.mayUse({ id: eli.user.id }, laptop), false);
            await flip("Eli may use Lin's laptop");
            await until(() => app.policy.mayUse({ id: eli.user.id }, laptop), "Eli chosen for it");
            await until(
                async () => (await switches()).includes("Eli may use Lin's laptop: on"),
                "the switch on",
            );

            // The owner has Where they may work on the page already: the sessions button alone. On a session Eli
            // started, there is nothing to give him: he has it.
            page = owners;
            await eliOver(`/s/${String(elis)}`);
            await until(
                async () => /Eli started “reach: Eli's own”\./.test(await text()),
                "the line for a session he started",
            );
            assert.deepEqual(
                (await buttons()).filter((each) => /your (session|runner)/.test(each)),
                ["Invite to your session (disabled)"],
            );

            // And on one of the owner's own, the owner invites him to it.
            await eliOver(`/s/${String(owned)}`);
            await tap("Invite to your session");
            await until(() => shared(owned).includes(eli.user.id), "the owner's session shared");
            assert.deepEqual([...shared(owned)].sort(), [dee.user.id, eli.user.id].sort());
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
