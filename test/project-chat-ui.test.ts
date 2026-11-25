// Two browsers in different sessions of one folder: who sees the Project toggle, its badge, and the server switch.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const desktop = { width: 1280, height: 800, scale: 1, mobile: false };
const toggle = '[role="group"][aria-label="Which chat"] button';
let app: App;
let server: Server;
let base: string;
let ownerPage: BrowserPage;
let guestPage: BrowserPage;
let guest: User;
let first: ConversationId;
let second: ConversationId;
const browsers: Browsers[] = [];

async function inPage<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function open(id: ConversationId, token: string, profile: string): Promise<BrowserPage> {
    const browser = new Browsers({
        dataDir: join(root, profile),
        load: async () => undefined,
        save: () => {},
    });

    browsers.push(browser);
    const page = await browser.open(1);

    await page.setViewport(desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            inPage<boolean>(
                page,
                `
        const { store, openSheet } = await import("/store.js");
        const ready = store.state.view.conversation?.id === ${Number(id)};

        if (ready && !store.state.sheet && !document.querySelector(".chat-compose")) {
            openSheet({ type: "chat" });
        }

        return JSON.stringify(ready && document.querySelector(".chat-compose textarea") !== null);
    `,
            ),
        "the session chat",
        20_000,
    );

    return page;
}

const buttons = (page: BrowserPage) =>
    inPage<string[]>(
        page,
        `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(toggle)})].map((button) => button.textContent.trim()));`,
    );

async function click(page: BrowserPage, css: string): Promise<void> {
    assert.equal(
        await inPage(
            page,
            `
        const button = document.querySelector(${JSON.stringify(css)});

        button?.click();

        return JSON.stringify(!!button);
    `,
        ),
        true,
        css,
    );
}

async function type(page: BrowserPage, text: string): Promise<void> {
    await inPage(
        page,
        `
        const box = document.querySelector(".chat-compose textarea");

        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));

        return JSON.stringify(true);
    `,
    );
}

const textIn = (page: BrowserPage, css: string) =>
    inPage<string | null>(
        page,
        `return JSON.stringify(document.querySelector(${JSON.stringify(css)})?.textContent.trim() ?? null);`,
    );

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    first = await newSession(app);
    second = await newSession(app);
    const added = app.config.addUser("Guest", "guest");

    guest = added.user;
    app.config.setUsers(THIS_SERVER, [guest.id]);
    await app.commands.shareSession(second, owner(app), [guest.id]);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    [ownerPage, guestPage] = await Promise.all([
        open(first, app.config.ownerToken, "project-owner"),
        open(second, added.token, "project-guest"),
    ]);
});

after(async () => {
    await Promise.all(browsers.map((browser) => browser.closeAll({ final: true })));
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the Project toggle follows the folder; a cross-session message adds a badge, off hides it and keeps it, and Delete history empties it",
    real,
    async () => {
        await until(
            async () => (await buttons(ownerPage)).includes("Project"),
            "the owner's Project toggle",
        );
        assert.deepEqual(await buttons(ownerPage), ["Session", "Project"]);
        assert.deepEqual(await buttons(guestPage), []);
        await app.giveFolders(owner(app), THIS_SERVER, guest.id, [work]);
        await until(
            async () => (await buttons(guestPage)).includes("Project"),
            "the guest's Project toggle",
        );

        // Session and Project keep separate drafts; only the project draft is sent.
        await type(ownerPage, "A separate session draft");
        await click(ownerPage, `${toggle}:last-child`);
        await until(
            async () =>
                (await textIn(ownerPage, ".chat-label"))?.includes("Pi does not get it.") === true,
            "the project label",
        );
        await type(ownerPage, "Hello from another session");
        await click(ownerPage, ".chat-compose .send");
        await until(
            async () => (await buttons(guestPage)).includes("Project 1"),
            "one unread project message",
        );
        assert.ok(!(await textIn(guestPage, ".chat-log"))?.includes("Hello from another session"));
        await click(guestPage, `${toggle}:last-child`);
        await until(
            async () =>
                (await textIn(guestPage, ".chat-log"))?.includes("Hello from another session") ===
                true,
            "the message",
        );
        await until(
            async () => (await buttons(guestPage)).includes("Project"),
            "the Project badge clears on reading",
        );
        await click(ownerPage, `${toggle}:first-child`);
        assert.equal(
            await inPage(
                ownerPage,
                `return JSON.stringify(document.querySelector(".chat-compose textarea").value);`,
            ),
            "A separate session draft",
        );

        // Taking the folder back may leave the shared session visible. Its project text must still go away.
        await app.giveFolders(owner(app), THIS_SERVER, guest.id, []);
        await until(
            async () => (await buttons(guestPage)).length === 0,
            "no Project toggle after revocation",
        );
        assert.ok(!(await textIn(guestPage, ".chat-log"))?.includes("Hello from another session"));
        await app.giveFolders(owner(app), THIS_SERVER, guest.id, [work]);
        await until(
            async () => (await buttons(guestPage)).includes("Project"),
            "the toggle after restoring the folder",
        );

        await inPage(
            ownerPage,
            `
        const { closePeople, openSheet } = await import("/store.js");

        closePeople();
        openSheet({ type: "access", view: "settings" });
        window.projectQuestions = [];
        window.confirm = (question) => {
            window.projectQuestions.push(question);

            return true;
        };

        return JSON.stringify(true);
    `,
        );
        const setting = '[data-part="project-chat-setting"]';
        const questions = () =>
            inPage<string[]>(ownerPage, "return JSON.stringify(window.projectQuestions);");
        const message = "Hello from another session";
        const guestSees = async () =>
            (await textIn(guestPage, ".chat-log"))?.includes(message) === true;

        await until(
            async () =>
                (await textIn(ownerPage, setting))?.includes("Each folder has a chat") === true,
            "the project setting",
        );
        await click(ownerPage, `${setting} [role="switch"][aria-checked="true"]`);
        await until(
            async () =>
                (await textIn(ownerPage, setting))?.includes("Off. Its history is kept.") === true,
            "the setting off",
        );
        assert.deepEqual(await questions(), [], "no question when the switch goes off");
        await until(
            async () => (await buttons(guestPage)).length === 0,
            "the other browser loses the Project toggle",
        );
        assert.notEqual(await textIn(guestPage, ".chat-compose"), null, "session chat remains");
        assert.ok(!(await guestSees()));

        // On again: the earlier message is still there.
        await click(ownerPage, `${setting} [role="switch"][aria-checked="false"]`);
        await until(
            async () => (await buttons(guestPage)).includes("Project"),
            "the Project toggle after turning it on again",
        );
        await click(guestPage, `${toggle}:last-child`);
        await until(guestSees, "the kept message after turning it on again");

        await click(ownerPage, `${setting} [data-part="project-chat-delete"]`);
        await until(
            async () =>
                (await textIn(ownerPage, setting))?.includes("Deleted the chat of 1 folder.") ===
                true,
            "the count of deleted chats",
        );
        assert.deepEqual(await questions(), [
            "Delete the project chat of every folder? This cannot be undone.",
        ]);
        await until(async () => !(await guestSees()), "an empty project chat in the other browser");
        assert.ok((await buttons(guestPage)).includes("Project"), "project chat stays on");
        assert.notEqual(await textIn(guestPage, ".chat-compose"), null, "session chat remains");
    },
);
