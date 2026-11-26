// Project trust for more than one person, in a real browser (`web/trust.js`, `web/folder-requests.js`): who is in charge
// of a session's computer is asked whether to trust its project. Anyone else who prompts there sees that it waits, and
// for whom; who is in charge then sees a card wherever they are, reviews it in that session, or puts it away.
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
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1280, height: 800, scale: 1, mobile: false };

let app: App;
let server: Server;
let owners: Browsers;
let gales: Browsers;
let ownerPage: BrowserPage;
let galePage: BrowserPage;
let base = "";

const inPage = async <T>(page: BrowserPage, script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

/** The text of the first element `selector` names, its spaces as one; null when there is none. */
const textOf = (page: BrowserPage, selector: string) =>
    inPage<string | null>(
        page,
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, " ").trim() ?? null)`,
    );

/** Tap the button named `label` inside the first element `selector` names. */
const tap = (page: BrowserPage, selector: string, label: string) =>
    inPage(
        page,
        `
        [...document.querySelector(${JSON.stringify(selector)}).querySelectorAll("button")]
            .find((each) => each.textContent.trim() === ${JSON.stringify(label)})
            .click();

        return JSON.stringify(true);
    `,
    );

/** Go to `path` and wait for the app. */
async function go(page: BrowserPage, path: string): Promise<void> {
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}${path}`);
    await until(
        async () =>
            await inPage<boolean>(
                page,
                `return JSON.stringify(document.querySelector('[data-part="app"]') !== null)`,
            ),
        "the app",
        20_000,
    );
}

/** A project with a skill of its own in `.agents/skills`, which waits for a trust decision. */
function project(prefix: string): string {
    const folder = realpathSync(mkdtempSync(join(root, prefix)));

    mkdirSync(join(folder, ".git"));
    mkdirSync(join(folder, ".agents", "skills", "deploy"), { recursive: true });
    writeFileSync(
        join(folder, ".agents", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: The deploy skill.\n---\nThe steps of deploy.\n",
    );

    return folder;
}

/** A browser of its own, with a profile under the test's folder. */
const browser = (name: string) =>
    new Browsers({
        dataDir: mkdtempSync(join(root, name)),
        load: async () => undefined,
        save: () => {},
    });

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // A browser each: a login link in one signed in as someone else asks before it switches.
    owners = browser("trust-ui-owner-");
    gales = browser("trust-ui-gale-");
    ownerPage = await owners.open(1);
    galePage = await gales.open(1);
});

after(async () => {
    await owners?.closeAll({ final: true });
    await gales?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "someone who prompts in a session whose project waits sees for whom; who is in charge sees a card, reviews it there, or puts it away",
    real,
    async () => {
        // Gale is chosen for this server, and new sessions here are shared with her (`addPerson`).
        const gale = await addPerson(app, "Gale", "guest");
        const folders = [project("trust-ui-first-"), project("trust-ui-second-")];
        const sessions: ConversationId[] = [];

        for (const folder of folders) {
            sessions.push(await newSession(app, folder));
        }

        const [first, second] = sessions as [ConversationId, ConversationId];

        await ownerPage.navigate(
            `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
        );
        await galePage.navigate(`${base}/login?token=${encodeURIComponent(gale.token)}`);
        // The owner is somewhere else: on the home screen.
        await go(ownerPage, "/");
        assert.equal(await textOf(ownerPage, '[data-part="trust-request"]'), null);

        // Gale opens the session: she is told it waits, and for whom, and is offered no answer.
        await go(galePage, `/s/${first}`);
        await until(
            async () => (await textOf(galePage, '[data-part="trust-wait"]')) !== null,
            "the line that says it waits",
        );
        assert.equal(
            await textOf(galePage, '[data-part="trust-wait"] .grow'),
            "Waiting for Owner to trust this project. Until then, its own skills and model defaults stay off.",
        );
        assert.equal(
            await inPage<string[]>(
                galePage,
                `return JSON.stringify([...document.querySelectorAll(".trust-bar button")].map((each) => each.getAttribute("aria-label") ?? each.textContent.trim()))`,
            ).then((labels) => labels.join(", ")),
            "Hide",
            "no Review and no Don't trust: the answer is not hers",
        );

        // The owner hears of it where they are, once, with what it is about.
        await until(
            async () => (await textOf(ownerPage, '[data-part="trust-request"]')) !== null,
            "the owner's card",
        );
        assert.equal(
            await textOf(ownerPage, '[data-part="trust-request"] .small'),
            `Gale's session ${app.sessionMeta(first)?.title ?? "New session"} waits for you to trust its project, ${folders[0]} on this server.`,
        );
        assert.equal(app.trustRequests.list(owner(app)).length, 1);
        assert.deepEqual(app.trustRequests.list(gale.user), []);

        // Review goes to that session with the project's trust open; in its own session the bar asks, so the card goes.
        await tap(ownerPage, '[data-part="trust-request"]', "Review");
        await until(
            async () =>
                (await textOf(ownerPage, '.sheet [data-part="sheet-head"]'))?.includes(
                    "Project trust",
                ) === true,
            "the trust sheet",
        );
        assert.equal(
            await inPage<number>(
                ownerPage,
                `const { store } = await import("/store.js"); return JSON.stringify(store.state.conversationId)`,
            ),
            Number(first),
        );
        assert.equal(await textOf(ownerPage, '[data-part="trust-request"]'), null);
        assert.equal(
            await textOf(ownerPage, ".sheet p.mono"),
            folders[0],
            "the project it is about",
        );

        // The owner answers there: Gale's line goes without a reload.
        await inPage(
            ownerPage,
            `
            [...document.querySelectorAll(".sheet .trust-choice")]
                .find((each) => each.textContent.includes("Trust this folder"))
                .click();

            return JSON.stringify(true);
        `,
        );
        await until(
            async () => (await textOf(galePage, '[data-part="trust-wait"]')) === null,
            "Gale's line to go",
        );
        assert.deepEqual(app.trustRequests.list(owner(app)), []);
        assert.equal(app.projectTrust(first, owner(app)).trusted, true);

        // A second project: the owner puts its card away without deciding. It still waits, and Gale still sees that.
        await go(ownerPage, "/");
        await go(galePage, `/s/${second}`);
        await until(
            async () => (await textOf(ownerPage, '[data-part="trust-request"]')) !== null,
            "the second card",
        );
        await tap(ownerPage, '[data-part="trust-request"]', "Not now");
        await until(
            async () => (await textOf(ownerPage, '[data-part="trust-request"]')) === null,
            "the card to go",
        );
        assert.equal(app.projectTrust(second, owner(app)).ask, true, "nothing was decided");
        assert.notEqual(await textOf(galePage, '[data-part="trust-wait"]'), null);
        // Asked about once: opening it again does not bring the card back.
        await go(galePage, `/s/${second}`);
        await until(
            async () => (await textOf(galePage, '[data-part="trust-wait"]')) !== null,
            "the line again",
        );
        assert.deepEqual(app.trustRequests.list(owner(app)), []);
        assert.equal(await textOf(ownerPage, '[data-part="trust-request"]'), null);
    },
);

test("a user who manages this server gets the trust question and can answer", real, async () => {
    const mona = await addPerson(app, "Mona", "guest");
    const folder = project("trust-ui-manager-");
    const session = await newSession(app, folder);
    const monas = browser("trust-ui-mona-");
    const labels = (page: BrowserPage) =>
        inPage<string[]>(
            page,
            `return JSON.stringify([...document.querySelectorAll(".trust-bar button")].map((each) => each.getAttribute("aria-label") ?? each.textContent.trim()))`,
        );
    const inCharge = (page: BrowserPage) =>
        inPage<string[]>(
            page,
            `const { store } = await import("/store.js"); return JSON.stringify(store.state.me?.inCharge ?? null)`,
        );

    try {
        const page = await monas.open(1);

        await page.navigate(`${base}/login?token=${encodeURIComponent(mona.token)}`);
        await go(page, `/s/${session}`);

        // A user like any other: it waits for the owner, and the answer is not hers.
        await until(
            async () => (await textOf(page, '[data-part="trust-wait"]')) !== null,
            "the line that says it waits",
        );
        assert.deepEqual(await inCharge(page), []);
        assert.deepEqual(await labels(page), ["Hide"]);
        assert.throws(
            () => app.projectTrust(session, mona.user),
            /decides which projects Pi trusts/,
        );

        // Her open tab gets the question without a reload.
        const given = await fetch(`${base}/api/runners/${THIS_SERVER}/rights`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "X-Pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ person: mona.user.id, right: "manages", on: true }),
        });

        assert.equal(given.status, 200);
        await until(
            async () => (await labels(page)).includes("Review"),
            "the question, for who is in charge now",
        );
        assert.deepEqual(await inCharge(page), ["this-server"]);
        assert.deepEqual(await labels(page), ["Don't trust", "Review", "Not now"]);
        assert.equal(await textOf(page, '[data-part="trust-wait"]'), null);

        // She answers, and the server takes it.
        await tap(page, ".trust-bar", "Review");
        await until(
            async () =>
                (await textOf(page, '.sheet [data-part="sheet-head"]'))?.includes(
                    "Project trust",
                ) === true,
            "the trust sheet",
        );
        await inPage(
            page,
            `
                [...document.querySelectorAll(".sheet .trust-choice")]
                    .find((each) => each.textContent.includes("Trust this folder"))
                    .click();

                return JSON.stringify(true);
            `,
        );
        await until(
            () => app.projectTrust(session, owner(app)).trusted,
            "the project to be trusted",
        );
        await until(async () => (await labels(page)).length === 0, "the bar to go");

        // Another project, in a session she starts herself, so it stays hers. She is asked about it. Then the
        // owner takes the permission back: nobody asked on her behalf while the answer was hers, so no request
        // changes. Her tab reads the project again as someone who waits, and tells the owner.
        const other = (
            await app.commands.createSession(app.config.userById(mona.user.id)!, {
                cwd: project("trust-ui-manager-other-"),
            })
        ).id;

        await go(page, `/s/${other}`);
        await until(async () => (await labels(page)).includes("Review"), "the second question");
        assert.deepEqual(app.trustRequests.list(owner(app)), []);

        const taken = await fetch(`${base}/api/runners/${THIS_SERVER}/rights`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "X-Pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ person: mona.user.id, right: "manages", on: false }),
        });

        assert.equal(taken.status, 200);
        await until(
            async () => (await textOf(page, '[data-part="trust-wait"]')) !== null,
            "the line that says it waits, once the answer is no longer hers",
        );
        assert.deepEqual(await inCharge(page), []);
        assert.deepEqual(await labels(page), ["Hide"]);
        await until(
            () => app.trustRequests.list(owner(app)).length === 1,
            "the owner to hear of it",
        );
    } finally {
        await monas.closeAll({ final: true });
    }
});
