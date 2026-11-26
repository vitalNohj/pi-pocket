// Chat with one person in a real browser (`web/sheets/direct.js`): the Chat tab on a person's page in People, its
// counts on the row, the tab, and the rail, the notice of a new message, the link a push opens, a phone's screen, and
// the session chat, whose log still follows its newest message (`chat.js` `useFollowLog`).
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";

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
let guestToken = "";
let viewer: User;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** A fresh page at `path`, signed in as the owner, once the app is drawn. */
async function load(path = "/", viewport = DESKTOP): Promise<void> {
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
}

/** Open People on a fresh page. */
async function openPeople(viewport = DESKTOP): Promise<void> {
    await load("/", viewport);
    await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "access", view: "person" });

        return JSON.stringify(true);
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".pages-sheet .pages-item") !== null)`,
            ),
        "the People sheet",
    );
}

/** Tap the row that names `name`, and wait for their page. */
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

/** The tabs of the page shown, as they read; the one shown says so. */
const tabs = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail [role=tab]")].map(
                (each) => each.textContent.replace(/\\s+/g, " ").trim() + (each.getAttribute("aria-selected") === "true" ? " (shown)" : ""),
            ),
        );
    `);

/** Tap the Chat tab, and wait for the chat's box. */
async function openChat(): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
                const tab = [...document.querySelectorAll(".pages-detail [role=tab]")]
                    .find((each) => each.textContent.trim().startsWith("Chat"));

                if (tab !== undefined && tab.getAttribute("aria-selected") !== "true") {
                    tab.click();
                }

                return JSON.stringify(document.querySelector('[data-part="person-chat"] .chat-compose textarea') !== null);
            `),
        "the chat",
    );
}

/** The messages of the chat shown: their text, and whether each is one's own. */
const messages = () =>
    inPage<[string, boolean][]>(`
        return JSON.stringify(
            [...document.querySelectorAll('[data-part="person-chat"] .chat-msg')].map((each) => [
                each.querySelector(".chat-text").textContent.trim(),
                each.classList.contains("mine"),
            ]),
        );
    `);

/** The count on the rail's Access button: its text, or null for none. */
const railCount = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector('.rail-button[aria-label="Access"] .rail-count')?.textContent.trim() ?? null)`,
    );

/** The count on `name`'s row in People: its text, or null for none. */
const rowBadge = (name: string) =>
    inPage<string | null>(`
        const row = [...document.querySelectorAll(".pages-item")]
            .find((each) => each.querySelector(".pages-item-title")?.textContent.startsWith(${JSON.stringify(name)}));

        return JSON.stringify(row?.querySelector(".pages-badge")?.textContent.trim() ?? null);
    `);

/** Tap the Chat tab of the page shown, whatever its chat then shows. */
const tapChat = () =>
    until(
        async () =>
            await inPage<boolean>(`
                const tab = [...document.querySelectorAll(".pages-detail [role=tab]")]
                    .find((each) => each.textContent.trim().startsWith("Chat"));

                tab?.click();

                return JSON.stringify(tab !== undefined);
            `),
        "the Chat tab",
    );

/**
 * In the page: a gate on the answer to the GET of the chat with `id`. "fail" answers 500 and asks the server nothing;
 * "hold" asks, and keeps the whole answer back until `releaseGate`. It counts the answers it held, and the reads the
 * page sent.
 */
async function gateChat(id: string, mode: "fail" | "hold"): Promise<void> {
    await inPage(`
        const gate = (window.directGate ??= { held: 0, reads: 0, release: null });
        const path = "/api/users/" + ${JSON.stringify(id)} + "/chat";

        gate.mode = ${JSON.stringify(mode)};

        if (gate.real === undefined) {
            gate.real = window.fetch;
            window.fetch = async (input, init) => {
                const url = typeof input === "string" ? input : input.url;

                if (url.endsWith(path + "/read")) {
                    gate.reads++;
                }

                if ((init?.method ?? "GET") !== "GET" || !url.endsWith(path) || gate.mode === "pass") {
                    return gate.real.call(window, input, init);
                }

                if (gate.mode === "fail") {
                    return new Response(JSON.stringify({ error: "the test refused it" }), { status: 500 });
                }

                const response = await gate.real.call(window, input, init);
                const text = await response.text();

                gate.held++;
                await new Promise((resolve) => (gate.release = resolve));

                return new Response(text, { status: response.status });
            };
        }

        return JSON.stringify(true);
    `);
}

/** Let the answer the gate holds through, and every later one. */
const releaseGate = () =>
    inPage(`
        window.directGate.mode = "pass";
        window.directGate.release?.();

        return JSON.stringify(true);
    `);

/** What the gate counted: the answers it held, and the reads the page sent. */
const gateCounts = () =>
    inPage<{ held: number; reads: number }>(
        `return JSON.stringify({ held: window.directGate.held, reads: window.directGate.reads })`,
    );

/** Whether the chat shown says that it did not load. */
const saysFailed = () =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector('[data-part="direct-failed"]') !== null)`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const gina = app.config.addUser("Gina", "guest");

    guest = gina.user;
    guestToken = gina.token;
    viewer = app.config.addUser("Vera", "viewer").user;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "direct-chat-ui-")),
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

test("a user's page has a Chat tab; a viewer's page and one's own have none", real, async () => {
    await openPeople();
    await show("Gina");
    await until(async () => (await tabs()).length > 0, "Gina's tabs");
    assert.deepEqual(await tabs(), ["Computers (shown)", "Permissions", "Chat"]);

    await show("Vera");
    assert.equal(
        (await tabs()).some((each) => each.startsWith("Chat")),
        false,
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('[data-part="person-chat"]') !== null)`,
        ),
        false,
    );
    assert.equal(viewer.role, "viewer");

    await show("Owner");
    assert.deepEqual(await tabs(), []);
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('[data-part="person-chat"]') !== null)`,
        ),
        false,
    );
});

test("the owner writes and sends: it shows as their own, and the server has it", real, async () => {
    await openPeople();
    await show("Gina");
    await openChat();
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector('[data-part="person-chat"] .chat-label').textContent.trim())`,
        ),
        /^Only you and Gina see this chat\. Pi does not\.$/,
    );

    await inPage(`
        const box = document.querySelector('[data-part="person-chat"] textarea');

        box.focus();
        document.execCommand("insertText", false, "Hello Gina");

        return JSON.stringify(true);
    `);
    await inPage(`
        document.querySelector('[data-part="person-chat"] .chat-compose .send').click();

        return JSON.stringify(true);
    `);
    await until(
        async () => (await messages()).some(([text]) => text === "Hello Gina"),
        "the message in the log",
    );
    assert.deepEqual((await messages()).at(-1), ["Hello Gina", true]);
    assert.equal(
        (await app.direct.thread(guest, owner(app).id)).messages.at(-1)?.text,
        "Hello Gina",
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector('[data-part="person-chat"] textarea').value)`,
        ),
        "",
    );
});

test(
    "a message while People is closed: a notice, the counts, and opening the chat clears them all",
    real,
    async () => {
        await load("/");
        await until(async () => (await railCount()) === null, "no count yet");
        await app.direct.post(guest, owner(app).id, { text: "Lunch at noon?", requestId: "ui-1" });

        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll('[data-part="notice"]')].some((each) => each.textContent.includes("Gina: Lunch at noon?")))`,
                ),
            "the notice naming Gina",
        );
        await until(async () => (await railCount()) === "1", "1 on the rail's People button");

        await inPage(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "access", view: "person" });

        return JSON.stringify(true);
    `);
        await until(async () => (await rowBadge("Gina")) === "1", "1 on Gina's row");
        await show("Gina");
        await until(
            async () => (await tabs()).some((each) => each === "Chat 1"),
            "1 on the Chat tab",
        );

        await openChat();
        await until(
            async () => (await messages()).some(([text]) => text === "Lunch at noon?"),
            "the message in the chat",
        );
        assert.deepEqual((await messages()).at(-1), ["Lunch at noon?", false]);
        await until(
            async () => (await tabs()).includes("Chat (shown)"),
            "no count on the Chat tab",
        );
        await until(async () => (await rowBadge("Gina")) === null, "no count on Gina's row");
        await until(async () => (await railCount()) === null, "no count on the rail");
        assert.deepEqual(app.direct.unread(owner(app)), {});
    },
);

test("/?direct=<id> opens People on that person's Chat tab", real, async () => {
    await load(`/?direct=${guest.id}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('[data-part="person-chat"] .chat-compose') !== null)`,
            ),
        "the chat with Gina",
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".sheet-page-title").textContent.trim())`,
        ),
        /^Gina/,
    );
    assert.ok((await tabs()).includes("Chat (shown)"));
    assert.equal(await inPage<string>(`return JSON.stringify(location.search)`), "");
});

test("a chat that does not load says so, and Try again loads it", real, async () => {
    await openPeople();
    await show("Gina");
    await gateChat(guest.id, "fail");
    await tapChat();
    await until(saysFailed, "the chat says it did not load");
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector('[data-part="direct-failed"] span').textContent.trim())`,
        ),
        "This chat did not load.",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('[data-part="person-chat"] textarea') !== null)`,
        ),
        false,
        "no box to write in before the chat is known",
    );

    await releaseGate();
    await inPage(`
        document.querySelector('[data-part="direct-failed"] button').click();

        return JSON.stringify(true);
    `);
    await openChat();
    assert.equal(await saysFailed(), false);
});

test(
    "a message that comes while the chat loads is kept, though the answer is from before it",
    real,
    async () => {
        await openPeople();
        await show("Gina");
        await gateChat(guest.id, "hold");
        await tapChat();
        await until(async () => (await gateCounts()).held === 1, "the chat's answer, held back");
        await app.direct.post(guest, owner(app).id, {
            text: "While it loads",
            requestId: "ui-hold",
        });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll('[data-part="notice"]')].some((each) => each.textContent.includes("Gina: While it loads")))`,
                ),
            "the message reached the page",
        );
        assert.deepEqual(await messages(), [], "nothing of the chat shows before its answer");

        await releaseGate();
        await until(
            async () => (await messages()).some(([text]) => text === "While it loads"),
            "the message in the chat",
        );
        assert.deepEqual((await messages()).at(-1), ["While it loads", false]);
        await until(
            () => Object.keys(app.direct.unread(owner(app))).length === 0,
            "the chat is read once it shows",
        );
    },
);

test(
    "after a reconnect the chat loads again, and a message from the gap is read only once it shows",
    real,
    async () => {
        await openPeople();
        await show("Gina");
        await openChat();
        await until(
            () => Object.keys(app.direct.unread(owner(app))).length === 0,
            "nothing unread before the gap",
        );

        // The gap: this tab's connection hears nothing of the chat, as one that went half-open does.
        for (const client of app.clients) {
            if (client.user.id === owner(app).id) {
                const send = client.send.bind(client);

                (client as { send: Client["send"] }).send = (event, data, conversation) => {
                    if (event !== "direct" && event !== "direct-unread") {
                        send(event, data, conversation);
                    }
                };
            }
        }

        await app.direct.post(guest, owner(app).id, { text: "From the gap", requestId: "ui-gap" });
        assert.deepEqual(app.direct.unread(owner(app)), { [guest.id]: 1 });
        assert.equal(
            (await messages()).some(([text]) => text === "From the gap"),
            false,
        );

        await gateChat(guest.id, "hold");
        await inPage(`
            const { connect } = await import("/store.js");

            connect();

            return JSON.stringify(true);
        `);
        await until(
            async () => (await gateCounts()).held === 1,
            "the chat asked for again on the new connection",
        );
        await until(
            async () =>
                await inPage<boolean>(`
                    const { store } = await import("/store.js");

                    return JSON.stringify(store.state.directUnread[${JSON.stringify(guest.id)}] === 1);
                `),
            "the count on the new connection",
        );

        // The page has drawn with that count, and the thread it shows has not the message yet: it is not read.
        const drawn = await inPage<{ reads: number; shown: boolean }>(`
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));

            return JSON.stringify({
                reads: window.directGate.reads,
                shown: [...document.querySelectorAll('[data-part="person-chat"] .chat-text')]
                    .some((each) => each.textContent.trim() === "From the gap"),
            });
        `);

        assert.deepEqual(drawn, { reads: 0, shown: false });
        assert.deepEqual(app.direct.unread(owner(app)), { [guest.id]: 1 });

        await releaseGate();
        await until(
            async () => (await messages()).some(([text]) => text === "From the gap"),
            "the message from the gap in the chat",
        );
        await until(
            () => Object.keys(app.direct.unread(owner(app))).length === 0,
            "the chat is read once it shows",
        );
    },
);

test(
    "on a phone, with the chat open, nothing is wider than the screen and the box is in the sheet",
    real,
    async () => {
        await openPeople(VIEWPORTS.mobile);
        await show("Gina");
        await openChat();

        // Stacked, the page is under the list: the chat is brought up as a tap on a row brings its page, once the
        // sheet has slid in. Then all of it shows in the sheet at once, its box too.
        await until(
            async () =>
                await inPage<boolean>(`
                    const sheet = document.querySelector(".sheet").getBoundingClientRect();

                    document.querySelector('[data-part="person-chat"]').scrollIntoView({ block: "end" });

                    return JSON.stringify(sheet.bottom <= innerHeight + 1);
                `),
            "the sheet in place",
        );

        const phone = await inPage<{ wider: string[]; inside: boolean; fits: boolean }>(`
            const sheet = document.querySelector(".sheet").getBoundingClientRect();
            const chat = document.querySelector('[data-part="person-chat"]').getBoundingClientRect();
            const box = document.querySelector('[data-part="person-chat"] .chat-compose').getBoundingClientRect();

            return JSON.stringify({
                wider: [...document.querySelectorAll(".sheet-body *")]
                    .filter((each) => each.getBoundingClientRect().right > innerWidth + 1)
                    .map((each) => each.className),
                inside:
                    box.left >= sheet.left - 1 &&
                    box.right <= sheet.right + 1 &&
                    box.top >= sheet.top - 1 &&
                    box.bottom <= Math.min(sheet.bottom, innerHeight) + 1,
                fits: chat.height <= sheet.height,
            });
        `);

        assert.deepEqual(phone.wider, []);
        assert.equal(phone.inside, true, JSON.stringify(phone));
        assert.equal(phone.fits, true, JSON.stringify(phone));
    },
);

test("no page has a line about what its person may do, nor under the chat", real, async () => {
    // A user has nothing to give a viewer or the owner here: a viewer's page is its head and role line alone, and the
    // owner's is the chat alone, with no tabs.
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "direct-chat-gina-")),
        load: async () => undefined,
        save: () => {},
    });
    const owners = page;
    const says = (words: string) =>
        inPage<boolean>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".pages-detail p")].some((each) =>
                        each.textContent.includes(${JSON.stringify(words)}),
                    ),
                );
            `);

    try {
        page = await theirs.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(guestToken)}`);
        await openPeople();
        await show("Vera");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pages-detail .sheet-page-head + .muted.small")?.textContent.trim().startsWith("viewer") === true && document.querySelector(".pages-detail .loader") === null)`,
                ),
            "a viewer's page and its role line",
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(
            await says("They read the sessions"),
            false,
            "no line about what a viewer does",
        );

        await show("Owner");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('[data-part="person-chat"] .chat-compose textarea') !== null)`,
                ),
            "the chat on the owner's page",
        );
        assert.deepEqual(await tabs(), [], "the chat is the page's only part");
        assert.equal(
            await says("They see every session on this server"),
            false,
            "no line about sessions under the chat",
        );
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
    }
});

/** The names in the list of People, as their rows say them. */
const names = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-item .pages-item-title")].map((each) => each.textContent.trim()),
        );
    `);

/** The switches of the Permissions pane shown, in every group of it (Account, Pi Pocket, each computer), as they read. */
const rights = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".pages-detail .group [role=switch]")].map(
                (each) => each.getAttribute("aria-label") + (each.disabled ? " (disabled)" : ""),
            ),
        );
    `);

/** Tap the tab of the page shown that starts with `label`, and wait until it shows. */
const showTab = (label: string) =>
    until(
        async () =>
            await inPage<boolean>(`
                const tab = [...document.querySelectorAll(".pages-detail [role=tab]")]
                    .find((each) => each.textContent.trim().startsWith(${JSON.stringify(label)}));

                if (tab !== undefined && tab.getAttribute("aria-selected") !== "true") {
                    tab.click();
                }

                return JSON.stringify(tab?.getAttribute("aria-selected") === "true");
            `),
        `the ${label} tab`,
    );

/** Run `steps` in a browser of its own, signed in with `token`; the owner's page is `page` again after. */
async function signedIn(token: string, steps: () => Promise<void>): Promise<void> {
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "direct-chat-viewer-")),
        load: async () => undefined,
        save: () => {},
    });
    const owners = page;

    try {
        page = await theirs.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await steps();
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
    }
}

test(
    "a full viewer's page has the switch for the chat, off, and the owner turns it on; a user's and a temporary account's have none",
    real,
    async () => {
        const wren = app.config.addUser("Wren", "viewer").user;
        const tess = app.config.addUser("Tess", "viewer", undefined, true).user;

        try {
            await openPeople();
            await show("Wren");
            await showTab("Permissions");
            await until(
                async () => (await rights()).includes("Wren chats with one person: off"),
                "the switch on Wren's page",
            );
            await inPage(`
                [...document.querySelectorAll(".pages-detail [role=switch]")]
                    .find((each) => each.getAttribute("aria-label").startsWith("Wren chats with one person"))
                    .click();

                return JSON.stringify(true);
            `);
            await until(() => app.policy.chats(wren), "the server to give Wren the chat");
            assert.deepEqual(app.config.userById(wren.id)?.rights, ["chats"]);
            await until(
                async () => (await rights()).includes("Wren chats with one person: on"),
                "the switch on",
            );
            // With the chat, her page has the Chat tab.
            await until(
                async () => (await tabs()).some((each) => each.startsWith("Chat")),
                "the Chat tab on Wren's page",
            );

            for (const name of ["Gina", "Tess"]) {
                await show(name);
                await showTab("Permissions");
                await until(async () => (await rights()).length > 0, `${name}'s switches`);
                assert.equal(
                    (await rights()).some((each) => each.includes("chats with one person")),
                    false,
                    name,
                );
            }

            assert.equal(app.policy.chats(tess), false);
        } finally {
            app.config.removeUser(wren.id);
            app.config.removeUser(tess.id);
        }
    },
);

test(
    "a viewer with the chat sees the people they may chat with, and a page of one is the chat alone",
    real,
    async () => {
        const { user: wade, token } = app.config.addUser("Wade", "viewer");

        app.config.updateUser(wade.id, { rights: ["chats"] });

        try {
            // The owner looks at their chat with Wade, to see his message come.
            await openPeople();
            await show("Wade");
            await openChat();

            await signedIn(token, async () => {
                await openPeople();
                await until(
                    async () => (await names()).includes("Gina"),
                    "the people Wade may chat with",
                );
                const listed = await names();

                assert.ok(listed.includes("Wade (you)"), JSON.stringify(listed));
                assert.ok(listed.includes("Owner"), JSON.stringify(listed));
                assert.equal(listed.includes("Vera"), false, JSON.stringify(listed));
                // Of the owner, who is here in another browser, Wade is told the name alone: his row says nothing
                // of when the owner is here, and draws no mark for it. Wade's own row says both.
                assert.deepEqual(
                    await inPage<Record<string, { detail: string; mark: boolean }>>(`
                        const rows = {};

                        for (const row of document.querySelectorAll(".pages-item")) {
                            const title = row.querySelector(".pages-item-title")?.textContent.trim();

                            if (title === "Owner" || title === "Wade (you)") {
                                rows[title] = {
                                    detail: row.querySelector(".pages-item-text .muted")?.textContent.trim() ?? "",
                                    mark: row.querySelector(".online-mark") !== null,
                                };
                            }
                        }

                        return JSON.stringify(rows);
                    `),
                    {
                        Owner: { detail: "owner", mark: false },
                        "Wade (you)": { detail: "viewer · here now", mark: true },
                    },
                );

                await show("Owner");
                await until(
                    async () =>
                        await inPage<boolean>(
                            `return JSON.stringify(document.querySelector('[data-part="person-chat"] .chat-compose textarea') !== null)`,
                        ),
                    "the chat on the owner's page",
                );
                assert.deepEqual(await tabs(), [], "the chat is the page's only part");

                await inPage(`
                    const box = document.querySelector('[data-part="person-chat"] textarea');

                    box.focus();
                    document.execCommand("insertText", false, "Hello from Wade");

                    return JSON.stringify(true);
                `);
                await until(
                    async () =>
                        await inPage<boolean>(`
                            const send = document.querySelector('[data-part="person-chat"] .chat-compose .send');

                            if (send !== null && !send.disabled) {
                                send.click();
                            }

                            return JSON.stringify(send !== null && !send.disabled);
                        `),
                    "Wade's send button",
                );
                await until(
                    async () => (await messages()).some(([text]) => text === "Hello from Wade"),
                    "the message in Wade's chat",
                );
            });

            await until(
                async () => (await messages()).some(([text]) => text === "Hello from Wade"),
                "the message in the owner's chat with Wade",
            );
            assert.deepEqual((await messages()).at(-1), ["Hello from Wade", false]);
        } finally {
            app.config.removeUser(wade.id);
        }
    },
);

test("a viewer without the chat sees only their own page", real, async () => {
    const { user: will, token } = app.config.addUser("Will", "viewer");

    try {
        await signedIn(token, async () => {
            await openPeople();
            await until(async () => (await names()).includes("Will (you)"), "Will's own row");
            // The list as the server's answer leaves it.
            await new Promise((resolve) => setTimeout(resolve, 500));
            assert.deepEqual(
                (await names()).filter((each) => ["Owner", "Gina", "Vera"].includes(each)),
                [],
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('[data-part="person-chat"]') !== null)`,
                ),
                false,
            );
        });
    } finally {
        app.config.removeUser(will.id);
    }
});

test("the session chat still follows its newest message", real, async () => {
    const id = await newSession(app);

    for (let n = 1; n <= 40; n++) {
        await app.collab.postChat(id, owner(app), {
            text: `message ${String(n)}`,
            requestId: `follow-${String(n)}`,
        });
    }

    await load(`/s/${String(id)}`);
    await until(
        async () =>
            await inPage<boolean>(`
                const { store, openSheet } = await import("/store.js");

                if (store.state.chat.length === 40 && document.querySelector(".chat-log") === null) {
                    openSheet({ type: "chat" });
                }

                return JSON.stringify([...document.querySelectorAll(".chat-log .chat-text")].some((each) => each.textContent.trim() === "message 40"));
            `),
        "the chat with its 40 messages",
    );
    await until(
        async () =>
            await inPage<boolean>(`
                const log = document.querySelector(".chat-log");

                return JSON.stringify(log.scrollHeight > log.clientHeight && log.scrollHeight - log.scrollTop - log.clientHeight < 2);
            `),
        "the log scrolled to its end",
    );
});
