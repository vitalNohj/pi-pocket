// Synced pinned sessions in two real browsers of one person, each with its own storage (`theme.js`, `pinned-sessions.ts`):
// pins stay in each browser until "Keep pinned sessions synced on this browser" is on (People). The first browser to
// turn it on gives its pins; the next one shows them in place of its own; a pin made in one then shows in the other.
// Off again, a browser keeps what it shows, and its pins are its own once more.
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
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1280, height: 900, scale: 1, mobile: false };
const LABEL = "Keep pinned sessions synced on this browser";

let app: App;
let server: Server;
let browsers: Browsers;
/** Two browsers of the same person: separate contexts, so separate storage. */
let a: BrowserPage;
let b: BrowserPage;
let base = "";
let ids: number[] = [];

async function inPage<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** The ids in the sidebar's Pinned group, in order: what the person sees as pinned. */
const shownPins = (page: BrowserPage) =>
    inPage<number[]>(
        page,
        `
        const group = [...document.querySelectorAll(".sidebar .session-group")].find(
            (each) => each.querySelector(".group-name")?.textContent.trim() === "Pinned",
        );

        return JSON.stringify(
            group ? [...group.querySelectorAll(".session-row")].map((each) => Number(each.dataset.id)) : [],
        );
    `,
    );

async function pinsAre(page: BrowserPage, expected: number[], what: string): Promise<void> {
    let last: number[] = [];

    try {
        await until(async () => {
            last = await shownPins(page);

            return JSON.stringify(last) === JSON.stringify(expected);
        }, what);
    } catch {
        assert.fail(`${what}: ${JSON.stringify(last)}, not ${JSON.stringify(expected)}`);
    }
}

/** Pin or unpin in `page`, as a row's pin button does. */
const toggle = (page: BrowserPage, id: number) =>
    page.evaluate(`
        const { togglePin } = await import("/theme.js");

        togglePin(${id});

        return "true";
    `);

/** Load the app in `page` and wait for the session list. */
async function load(page: BrowserPage, viewport = DESKTOP): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                page,
                `return JSON.stringify(document.querySelectorAll(".sidebar .session-row, .home-list .session-row").length >= ${ids.length})`,
            ),
        "the session list",
        20_000,
    );
}

/** Open People on one's own page. */
async function people(page: BrowserPage): Promise<void> {
    await inPage(
        page,
        `
        const { openSheet } = await import("/store.js");

        openSheet({ type: "people" });

        return JSON.stringify(true);
    `,
    );
    await until(async () => (await syncSwitch(page)) !== null, "the switch on one's own page");
}

type Switch = { on: boolean; label: string; hint: string } | null;

/** The switch, whether it is on, and the hint under it. */
const syncSwitch = (page: BrowserPage) =>
    inPage<Switch>(
        page,
        `
        const button = [...document.querySelectorAll(".pages-detail [role=switch]")].find((each) =>
            each.getAttribute("aria-label").startsWith(${JSON.stringify(LABEL)}),
        );
        const setting = button?.closest(".setting");

        return JSON.stringify(
            button
                ? {
                      on: button.getAttribute("aria-checked") === "true",
                      label: setting.querySelector(".grow > .small").textContent.trim(),
                      hint: setting.querySelector(".muted").textContent.trim(),
                  }
                : null,
        );
    `,
    );

/** Tap the switch, as `people-sheet-ui.test.ts` does: in the page, so a sheet still sliding in cannot move it away. */
async function flip(page: BrowserPage, on: boolean): Promise<void> {
    await inPage(
        page,
        `
        [...document.querySelectorAll(".pages-detail [role=switch]")]
            .find((each) => each.getAttribute("aria-label").startsWith(${JSON.stringify(LABEL)}))
            .click();

        return JSON.stringify(true);
    `,
    );
    await until(async () => (await syncSwitch(page))?.on === on, `the switch ${on ? "on" : "off"}`);
}

const closeSheet = (page: BrowserPage) =>
    page.evaluate(`
        const { closeSheet } = await import("/store.js");

        closeSheet();

        return "true";
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    ids = [await newSession(app), await newSession(app), await newSession(app)].map(Number);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pinned-sessions-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    a = await browsers.open(1);
    b = await browsers.open(2);

    for (const page of [a, b]) {
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    }
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("two browsers of one person: pins sync only where the switch is on", real, async () => {
    const [first, second, third] = ids as [number, number, number];

    await load(a);
    await load(b);

    // Off by default: each browser's pins are its own, and the server keeps none.
    await toggle(a, first);
    await toggle(a, second);
    await toggle(b, third);
    await pinsAre(a, [first, second], "A's own pins");
    await pinsAre(b, [third], "B's own pins");
    await people(a);
    assert.deepEqual(await syncSwitch(a), {
        on: false,
        label: LABEL,
        hint: "Off: pins stay in this browser. On: this browser's pins become your synced pins.",
    });
    assert.equal(await app.pinnedSessions.list(owner(app)), undefined);

    // On in A: A's pins become the synced list.
    await flip(a, true);
    assert.equal(
        (await syncSwitch(a))?.hint,
        "On: pins are the same in every browser where this is on.",
    );
    await until(
        async () =>
            JSON.stringify(
                (await (
                    await fetch(`${base}/api/pinned-sessions`, {
                        headers: {
                            authorization: `Bearer ${app.config.ownerToken}`,
                            "X-Pocket": "1",
                        },
                    })
                ).json()) as unknown,
            ) === JSON.stringify({ pinned: [first, second] }),
        "A's pins on the server",
    );
    await pinsAre(b, [third], "B keeps its own while its switch is off");

    // On in B: B shows the synced list in place of its own.
    await people(b);
    assert.equal(
        (await syncSwitch(b))?.hint,
        "Off: pins stay in this browser. On: this browser shows your synced pins, in place of its own.",
    );
    await flip(b, true);
    await closeSheet(b);
    await pinsAre(b, [first, second], "B shows the synced pins");

    // A pin made in B shows in A, with no reload.
    await closeSheet(a);
    await toggle(b, third);
    await pinsAre(b, [first, second, third], "B's new pin");
    await pinsAre(a, [first, second, third], "B's pin in A");

    // Off in B: B keeps the list it shows, and a later pin in A changes only A.
    await people(b);
    await flip(b, false);
    await closeSheet(b);
    await pinsAre(b, [first, second, third], "B keeps what it showed");
    await toggle(a, first);
    await pinsAre(a, [second, third], "A unpinned one");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await pinsAre(b, [first, second, third], "B did not follow A");

    // A reload of A shows its pins at once from this browser, and they stay once the server answers.
    await load(a);
    await pinsAre(a, [second, third], "A's pins after a reload");
});

test("the switch fits on a phone and on a desktop", real, async () => {
    for (const viewport of [VIEWPORTS.mobile, DESKTOP]) {
        await load(a, viewport);
        await people(a);

        const wider = await inPage<string[]>(
            a,
            `
            const setting = [...document.querySelectorAll(".pages-detail .setting")].find((each) =>
                each.textContent.includes(${JSON.stringify(LABEL)}),
            );
            setting.scrollIntoView({ block: "center" });

            return JSON.stringify(
                [setting, ...setting.querySelectorAll("*"), ...document.querySelectorAll(".sheet-body *")]
                    .filter((each) => each.getBoundingClientRect().right > innerWidth + 1)
                    .map((each) => each.className),
            );
        `,
        );

        assert.deepEqual(wider, [], `nothing wider than ${viewport.width} px`);
        await closeSheet(a);
    }
});
