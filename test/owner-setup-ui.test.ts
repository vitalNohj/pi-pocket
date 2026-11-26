// The owner's first-start prompt in a real browser (`web/sheets/owner-setup.js`): at a page load it asks an owner with no
// authenticator to link one, and Open People shows their own page, where the Authenticator group links one. Not now
// ends the prompt for good; a guest never sees it. The group fits the People page on a computer and on a phone.
import { cleanUp, type App, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1280, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Load the app afresh, as the person signed in on `page`, and wait until it knows who they are. */
async function load(viewport = DESKTOP): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(document.querySelector('[data-part="app"]') !== null && Boolean(store.state.me));
            `),
        "the app",
        20_000,
    );
}

/** The type of the sheet open, or null. */
const sheet = () =>
    inPage<string | null>(`
        const { store } = await import("/store.js");

        return JSON.stringify(store.state.sheet?.type ?? null);
    `);

/** Tap the button in the open sheet whose text is `label`. */
const press = (label: string) =>
    inPage(`
        [...document.querySelectorAll(".sheet button")]
            .find((each) => each.textContent.trim() === ${JSON.stringify(label)})
            .click();

        return JSON.stringify(true);
    `);

/** What is wider than the screen in the open sheet: their classes. */
const wider = () =>
    inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".sheet-body *")]
                .filter((each) => each.getBoundingClientRect().right > innerWidth + 1)
                .map((each) => each.className),
        );
    `);

/** The Authenticator group on the page shown in People: its text, or null. */
const group = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(".pages-detail .my-authenticator")?.innerText.replace(/\\s+/g, " ").trim() ?? null)`,
    );

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
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "owner-setup-ui-")),
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
    "an owner with no authenticator is asked at load; Open People shows their page, where they link one",
    real,
    async () => {
        // `openApp` dismissed it for the other tests: this is a new owner's account.
        app.config.updateUser(owner(app).id, { setupDismissed: undefined });
        await load();
        await until(async () => (await sheet()) === "owner-setup", "the prompt");
        assert.deepEqual(
            await inPage(`
                return JSON.stringify({
                    title: document.querySelector(".sheet h2").textContent.trim(),
                    says: document.querySelector(".sheet p.muted").textContent.replace(/\\s+/g, " ").trim(),
                    buttons: [...document.querySelectorAll(".sheet .sheet-actions button")].map((each) => [
                        each.textContent.trim(),
                        each.classList.contains("primary"),
                    ]),
                });
            `),
            {
                title: "Finish setting up your owner account",
                says: "Link an authenticator app to your account. Its codes are for approvals and 2FA sign-in.",
                buttons: [
                    ["Not now", false],
                    ["Open Access", true],
                ],
            },
        );

        // Open Access is not Not now: their own page, with the Authenticator group.
        await press("Open Access");
        await until(async () => (await group()) !== null, "the Authenticator group on their page");
        assert.equal(await sheet(), "access");
        assert.ok(
            (
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".sheet-page-title").textContent.trim())`,
                )
            ).startsWith("Owner"),
            "their own page",
        );
        assert.match((await group())!, /^Authenticator Not linked/);
        assert.deepEqual(await wider(), [], "nothing wider than a computer's window");
        assert.equal(app.config.userById(owner(app).id)?.setupDismissed, undefined);

        // The prompt comes again at the next load: nothing is linked yet.
        await load();
        await until(async () => (await sheet()) === "owner-setup", "the prompt again");
        await press("Open Access");
        await until(async () => (await group()) !== null, "the group again");

        // Link one there, with a real code.
        await inPage(`
            [...document.querySelectorAll(".pages-detail .my-authenticator button")]
                .find((each) => each.textContent.trim() === "Link")
                .click();

            return JSON.stringify(true);
        `);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pages-detail .authenticator-secret") !== null)`,
                ),
            "the key to link",
        );
        assert.deepEqual(await wider(), [], "the QR code and key fit a computer's window");

        const secret = await inPage<string>(
            `return JSON.stringify(document.querySelector(".pages-detail .authenticator-secret").textContent.trim())`,
        );

        await inPage(`
            const field = document.querySelector('.pages-detail .my-authenticator input[autocomplete="one-time-code"]');

            field.value = ${JSON.stringify(totp(secret, Math.floor(Date.now() / STEP_MS)))};
            field.dispatchEvent(new Event("input", { bubbles: true }));

            return JSON.stringify(true);
        `);
        await until(
            async () =>
                await inPage<boolean>(`
                    const button = [...document.querySelectorAll(".pages-detail .my-authenticator button")]
                        .find((each) => each.textContent.trim() === "Link");

                    return JSON.stringify(button !== undefined && !button.disabled);
                `),
            "Link to be enabled",
        );
        await inPage(`
            [...document.querySelectorAll(".pages-detail .my-authenticator button")]
                .find((each) => each.textContent.trim() === "Link")
                .click();

            return JSON.stringify(true);
        `);
        await until(
            async () =>
                (await group())?.startsWith("Authenticator Linked to your account") === true,
            "linked",
        );
        assert.equal(app.authenticators.linked(owner(app).id), true);
        // The app learns at once that the prompt is done, without a reload.
        await until(
            async () =>
                await inPage<boolean>(`
                    const { store } = await import("/store.js");

                    return JSON.stringify(store.state.me.setup === undefined);
                `),
            "me without setup",
        );

        // Linked: no prompt at the next load.
        await load();
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await sheet(), null);

        // Leave the owner without one, for the next test: their own takes a code, and the next one is not used yet.
        app.removeAuthenticator(
            owner(app).id,
            owner(app),
            totp(secret, Math.floor(Date.now() / STEP_MS) + 1),
        );
    },
);

test("on a phone, the Authenticator group fits the owner's page in People", real, async () => {
    await load(VIEWPORTS.mobile);
    await until(async () => (await sheet()) === "owner-setup", "the prompt on a phone");
    assert.deepEqual(await wider(), [], "the prompt fits");
    await press("Open Access");
    await until(async () => (await group()) !== null, "the group on a phone");
    assert.deepEqual(await wider(), [], "the page fits");
    // Every row of the account is there, Sign out in the page head, and the authenticator last.
    assert.deepEqual(
        await inPage(`
            const detail = document.querySelector(".pages-detail");
            const out = detail.querySelector(".my-signout button");

            // Once the sheet has slid up into its place: while it moves, its bottom is below the screen.
            await Promise.all(document.getAnimations().map((each) => each.finished.catch(() => {})));
            out.scrollIntoView({ block: "end" });
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const box = out.getBoundingClientRect();

            return JSON.stringify({
                rows: [".my-photo", ".my-name", ".device-link", ".my-authenticator", ".sheet-page-head .my-signout"].map(
                    (each) => detail.querySelector(each) !== null,
                ),
                last: detail.querySelector(".sheet-page").lastElementChild?.matches(".my-authenticator") === true,
                // Within a pixel: the sheet's height is a fraction of the screen's.
                reached: box.top >= 0 && box.bottom <= innerHeight + 1 && box.right <= innerWidth,
                hit: Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".my-signout")),
            });
        `),
        { rows: [true, true, true, true, true], last: true, reached: true, hit: true },
    );
    await inPage(`
        [...document.querySelectorAll(".pages-detail .my-authenticator button")]
            .find((each) => each.textContent.trim() === "Link")
            .click();

        return JSON.stringify(true);
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".pages-detail .authenticator-secret") !== null)`,
            ),
        "the key to link, on a phone",
    );
    assert.deepEqual(await wider(), [], "the QR code and key fit a phone");
    await inPage(`
        [...document.querySelectorAll(".pages-detail .my-authenticator button")]
            .find((each) => each.textContent.trim() === "Cancel")
            .click();

        return JSON.stringify(true);
    `);
});

test("Not now ends the prompt: it does not come at the next load", real, async () => {
    await load();
    await until(async () => (await sheet()) === "owner-setup", "the prompt");
    await press("Not now");
    await until(async () => (await sheet()) === null, "the prompt to close");
    await until(
        () => app.config.userById(owner(app).id)?.setupDismissed === true,
        "the server to keep it",
    );
    await load();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await sheet(), null);
});

test("a guest never sees the prompt", real, async () => {
    const { token } = app.config.addUser("Gina", "guest");
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "owner-setup-guest-")),
        load: async () => undefined,
        save: () => {},
    });
    const owners = page;

    // Even with the owner's own prompt live.
    app.config.updateUser(owner(app).id, { setupDismissed: undefined });

    try {
        page = await theirs.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await load();
        assert.equal(
            await inPage<string>(
                `const { store } = await import("/store.js"); return JSON.stringify(store.state.me.role)`,
            ),
            "guest",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await sheet(), null);
    } finally {
        page = owners;
        await theirs.closeAll({ final: true });
        app.config.updateUser(owner(app).id, { setupDismissed: true });
    }
});
