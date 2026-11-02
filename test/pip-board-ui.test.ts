// Appearance → PiP: Floating (the corner, or a phone's sheet) or Board (the conversation's place, as Running now), in
// an isolated real browser. These tests never select a real provider or use the running server's data or browser.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let pip: ConversationId;
let background: ConversationId;
const project = join(work, "project-board");

/** Where PiP shows, as the store and the page say. */
type Seen = {
    pipOpen: boolean;
    board: string | false;
    stored: string | null;
    docked: number;
    floating: number;
    inPane: boolean;
    scrim: number;
    resize: number;
    rail: boolean | null;
    conversationId: number | null;
};

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`), what, 20_000);
const settle = () =>
    page.evaluate(`
    await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    for (let frame = 0; frame < 3; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
`);

const seen = () =>
    inPage<Seen>(`
        const { store } = await import('/store.js');
        const rail = document.querySelector('.rail-pip');

        return JSON.stringify({
            pipOpen: store.state.pipOpen,
            board: store.state.board,
            stored: sessionStorage.getItem('pocket.pip'),
            docked: document.querySelectorAll('.pip-panel.docked').length,
            floating: document.querySelectorAll('.pip-panel:not(.docked):not(.leaving)').length,
            inPane: document.querySelector('.pane > .pip-panel.docked') !== null,
            scrim: document.querySelectorAll('.pip-scrim:not(.leaving)').length,
            resize: document.querySelectorAll('.pip-panel.docked .pip-resize, .pip-panel.docked .grip').length,
            rail: rail ? rail.classList.contains('open') : null,
            conversationId: store.state.conversationId,
        });
    `);

/** PiP as a board: open, in the pane only, and fed by the server's view of its conversation. */
async function boarded(what: string): Promise<void> {
    await see(
        `(async () => {
            const { store } = await import('/store.js');
            return store.state.pipOpen && store.state.board === 'pip' &&
                document.querySelector('.pane > .pip-panel.docked') !== null &&
                document.querySelector('.pip-panel:not(.docked):not(.leaving)') === null &&
                store.state.pipView.conversation?.id === ${Number(pip)};
        })()`,
        what,
    );
    await settle();
}

/** PiP floating: open, over the app, and nothing of it in the pane. */
async function floating(what: string): Promise<void> {
    await see(
        `(async () => {
            const { store } = await import('/store.js');
            return store.state.pipOpen && store.state.board !== 'pip' &&
                document.querySelector('.pip-panel.docked') === null &&
                document.querySelector('.layout > .pip-panel:not(.docked):not(.leaving)') !== null &&
                store.state.pipView.conversation?.id === ${Number(pip)};
        })()`,
        what,
    );
    await settle();
}

/** PiP closed: in neither place, and not open in the store or the tab. */
async function shut(what: string): Promise<void> {
    await see(
        `(async () => {
            const { store } = await import('/store.js');
            return !store.state.pipOpen && store.state.board !== 'pip' &&
                sessionStorage.getItem('pocket.pip') === null &&
                document.querySelector('.pip-panel') === null;
        })()`,
        what,
    );
    await settle();
}

const place = (value: "floating" | "board") =>
    page.evaluate(`(await import('/theme.js')).setPrefs({ pip: ${JSON.stringify(value)} })`);

/** A fresh tab on the background session, PiP closed, in `mode`. */
async function fresh(mode: "floating" | "board", viewport: Viewport = VIEWPORTS.desktop) {
    await page.evaluate(`
        (await import('/store.js')).closeSheet();
        (await import('/pip.js')).closePip();
        (await import('/theme.js')).setPrefs({ pip: ${JSON.stringify(mode)} });
    `);
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${background}`);
    await see(`document.querySelector('.composer textarea') !== null`, "the background session");
    await see(`(await import('/store.js')).store.state.server?.pip === true`, "PiP available");
    await settle();
    await shut("PiP closed at the start");
}

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(project);
    app = await openApp(
        scriptedModel(async (request) =>
            fauxAssistantMessage([
                fauxText(`PiP heard: ${lastText(request as never).text.slice(-40)}`),
            ]),
        ),
    );

    app.watches.gh = async () => {
        throw new Error("No GitHub in PiP UI tests");
    };

    background = await newSession(app, project);
    pip = await app.pip.ensure(owner(app));
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pip-board-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`(await import('/store.js')).store.state.me?.role === 'owner'`, "owner signed in");
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
    } finally {
        server?.closeAllConnections();
        server?.close();

        try {
            await app?.close();
        } finally {
            cleanUp();
        }
    }
});

test("Floating is the default: the corner window, as before", real, async () => {
    assert.equal(
        await inPage<string>(`return JSON.stringify((await import('/theme.js')).prefs().pip)`),
        "floating",
    );
    await fresh("floating");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await floating("the floating panel");
    const now = await seen();

    assert.equal(now.board, false, "the conversation keeps its place");
    assert.equal(now.stored, "1");
    assert.equal(now.rail, true);
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelectorAll('.pip-panel .pip-resize').length === 3)`,
        ),
        true,
        "the floating window keeps its resize handles",
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("Floating closed");
});

test("Board: PiP in the conversation's place, answers there, and Back returns", real, async () => {
    await fresh("board");
    await page.click({ selector: ".rail-pip" });
    await boarded("PiP as a board from the rail button");
    const now = await seen();

    assert.equal(now.stored, "1", "the tab keeps it open across a reload");
    assert.equal(now.inPane, true);
    assert.equal(now.scrim, 0, "no scrim");
    assert.equal(now.resize, 0, "no resize handles or grip");
    assert.equal(now.rail, true, "the rail button shows it open");
    assert.equal(now.conversationId, Number(background), "the session stays under it");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.sidebar .rail') !== null && document.querySelector('.topbar') === null)`,
        ),
        true,
        "the sidebar stays; the session's own bar gives its place",
    );

    // Sent and answered in the board.
    await page.evaluate(`
        const box = document.querySelector('.pip-panel.docked .pip-composer textarea');
        box.value = 'hello from the board';
        box.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await page.click({ selector: ".pip-panel.docked .pip-send" });
    await see(
        `[...document.querySelectorAll('.pip-panel.docked .pip-reply')].some((each) => each.textContent.includes('PiP heard:'))`,
        "PiP's answer in the board",
    );

    // Back: to the session it took the place of.
    await page.evaluate(`history.back()`);
    await shut("Back closed the board");
    assert.equal((await seen()).conversationId, Number(background));
    await see(`document.querySelector('.composer textarea') !== null`, "the session again");
});

test(
    "Board: another board, a session, or an extension's page takes the place and closes PiP",
    real,
    async () => {
        await fresh("board");
        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await boarded("PiP as a board");

        await page.click({ selector: ".rail-running" });
        await see(
            `(await import('/store.js')).store.state.board === 'running' && document.querySelector('.running-board') !== null`,
            "Running now",
        );
        await shut("Running now closed PiP");

        // The rail button opens PiP again over Running now, and Running now's opens it back.
        await page.click({ selector: ".rail-pip" });
        await boarded("PiP back from Running now");
        assert.equal((await seen()).rail, true);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.rail-running').classList.contains('open'))`,
            ),
            false,
        );

        await page.evaluate(`(await import('/sessions.js')).toggleBoard('subagents')`);
        await see(
            `(await import('/store.js')).store.state.board === 'subagents'`,
            "the subagents board",
        );
        await shut("the subagents board closed PiP");

        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await boarded("PiP again");
        await page.evaluate(`(await import('/store.js')).navigate(${Number(background)})`);
        await shut("picking a session closed PiP");

        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await boarded("PiP again");
        await page.evaluate(
            `(await import('/store.js')).store.set({ board: false, page: { module: 'x', id: 'y' } })`,
        );
        await shut("an extension's page closed PiP");
        await page.evaluate(`(await import('/store.js')).store.set({ page: null })`);
    },
);

test("Board: every way in opens the board", real, async () => {
    await fresh("board");

    // Alt+A, and again to close.
    await page.press("Alt+a");
    await boarded("Alt+A");
    await page.press("Alt+a");
    await shut("Alt+A again");

    // /pip, and /pip with a message.
    await page.evaluate(`
        const { parseCommand } = await import('/commands.js');
        const { command, arg } = parseCommand('/pip');
        command.run(arg);
    `);
    await boarded("/pip");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
    await page.evaluate(`
        const { parseCommand } = await import('/commands.js');
        const { command, arg } = parseCommand('/pip asked from the slash command');
        await command.run(arg);
    `);
    await boarded("/pip with a message");
    await see(
        `[...document.querySelectorAll('.pip-panel.docked .pip-reply')].some((each) => each.textContent.includes('slash command'))`,
        "the answer to /pip's message",
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");

    // An extension's pocket.pip.ask, which puts the text in the box.
    await page.evaluate(
        `await (await import('/pip.js')).askPipFrom({ module: 'demo' }, 'from a module', false)`,
    );
    await boarded("pocket.pip.ask");
    await see(
        `document.querySelector('.pip-panel.docked .pip-composer textarea')?.value.includes('from a module')`,
        "the module's text in the box",
    );
    await page.evaluate(`
        const box = document.querySelector('.pip-panel.docked .pip-composer textarea');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        (await import('/pip.js')).closePip();
    `);
    await shut("closed");

    // The launcher's Ask PiP.
    await page.press("Control+K");
    await see(`document.querySelector('.launcher input') !== null`, "the launcher");
    await page.evaluate(`
        const input = document.querySelector('.launcher input');
        input.value = 'Ask PiP';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await see(
        `document.querySelector('.launcher-item.on')?.textContent.includes('Ask PiP')`,
        "Ask PiP chosen",
    );
    await page.press("Enter");
    await boarded("the launcher's Ask PiP");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify((await import('/store.js')).store.state.launcher)`,
        ),
        false,
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");

    // A notification's link.
    await page.navigate(`${base}/?pip=1`);
    await boarded("?pip=1");
    assert.equal(await inPage<string>(`return JSON.stringify(location.search)`), "");

    // Kept open across a reload, still as a board.
    await page.navigate(`${base}/s/${background}`);
    await boarded("PiP as a board after a reload");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
});

test("Changing the setting while PiP is open moves it, never into both places", real, async () => {
    await fresh("floating");
    await page.evaluate(`
        window.pipBoth = 0;
        window.pipNeither = 0;
        const { store } = await import('/store.js');
        new MutationObserver(() => {
            const docked = document.querySelector('.pip-panel.docked') !== null;
            const floating = document.querySelector('.pip-panel:not(.docked):not(.leaving)') !== null;
            window.pipBoth += docked && floating ? 1 : 0;
            window.pipNeither += store.state.pipOpen && !docked && !floating ? 1 : 0;
        }).observe(document.body, { childList: true, subtree: true });
    `);
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await floating("floating to start");

    await place("board");
    await boarded("moved to the board");
    await place("floating");
    await floating("moved back to the corner");
    assert.equal((await seen()).conversationId, Number(background), "the session under it again");

    // From Appearance, over the board: the sheet stays, and PiP moves under it.
    await place("board");
    await boarded("on the board");
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'appearance' })`);
    await see(`document.querySelector('.sheet') !== null`, "Appearance");
    await page.evaluate(`
        [...document.querySelectorAll('.sheet .segmented button')]
            .find((button) => button.textContent.trim() === 'Floating').click();
    `);
    await floating("Floating chosen in Appearance");
    await page.evaluate(`
        [...document.querySelectorAll('.sheet .segmented button')]
            .find((button) => button.textContent.trim() === 'Board').click();
    `);
    await boarded("Board chosen in Appearance");
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(document.querySelector('.sheet') !== null)`),
        true,
        "the sheet that changed it stays",
    );
    await page.evaluate(`(await import('/store.js')).closeSheet()`);

    assert.equal(await inPage<number>(`return JSON.stringify(window.pipBoth)`), 0, "never both");
    assert.equal(
        await inPage<number>(`return JSON.stringify(window.pipNeither)`),
        0,
        "never neither",
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
    await place("floating");
});

test("Phones: Board fills the screen; Floating keeps the sheet", real, async () => {
    await fresh("board", VIEWPORTS.mobile);
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP as a board on a phone");
    const box = await inPage<{
        width: number;
        height: number;
        scrim: number;
        modal: string | null;
    }>(`
        const panel = document.querySelector('.pip-panel.docked');
        const rect = panel.getBoundingClientRect();

        return JSON.stringify({
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            scrim: document.querySelectorAll('.pip-scrim').length,
            modal: panel.getAttribute('aria-modal'),
        });
    `);

    assert.deepEqual(box, { width: 390, height: 844, scrim: 0, modal: null });
    await page.evaluate(`history.back()`);
    await shut("Back on a phone");
    await see(`document.querySelector('.composer textarea') !== null`, "the session again");

    await place("floating");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await floating("the phone's sheet");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.pip-scrim') !== null && document.querySelector('.pip-panel').getAttribute('aria-modal') === 'true')`,
        ),
        true,
        "the sheet keeps its scrim",
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
});
