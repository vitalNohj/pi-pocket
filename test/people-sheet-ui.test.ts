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
    home,
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
            ["Gina", "Invite someone", "Notifications", "Owner (you)", "Sam", "Settings", "Vera"],
            "everyone, then what else the sheet holds",
        );
        assert.notEqual(people.title, "Owner (you)", "it opens on someone whose access is to set");
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
        "Gina steers Pi: on",
        "Gina links runners: off",
        "Gina may use This server: off",
        "Gina may use Laptop: off",
    ]);
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
    assert.deepEqual(await switches(), ["Gina may use Laptop: on", "Vera may use Laptop: off"]);
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
            "Vera steers Pi: off (disabled)",
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
