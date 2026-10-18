// Appearance's font, in a real browser where this machine has Chromium: JetBrains Mono in a new browser and in one that
// saved its appearance before the setting was there, every choice drawn from its bundled file, code left monospace when
// the choice is not, and a reload that keeps the choice and fetches only the fonts it uses.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
/** A session with prose and code in it. */
let session: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string) =>
    until(
        // A script that runs as the page is replaced fails: it is not there yet.
        async () => (await inPage<boolean>(script).catch(() => false)) === true,
        what,
    );

type Look = {
    /** The choice saved in this browser, if any. */
    saved: string | undefined;
    /** The first family of each place's font: the page's, a message's prose, and code in a reply. */
    body: string;
    prose: string;
    code: string;
    /** The font files the page asked for before its style sheet, and the fonts the browser has loaded since. */
    preloads: string[];
    loaded: string[];
};

/** Wait for the session's reply and the page's fonts, and give back which fonts the page uses where. */
async function look(): Promise<Look> {
    await see(
        `return JSON.stringify(document.querySelector(".md pre code") !== null && document.fonts.status === "loaded")`,
        "the reply's code, and the fonts",
    );

    return inPage<Look>(`
        const first = (element) => getComputedStyle(element).fontFamily.split(",")[0].trim().replace(/"/g, "");

        return JSON.stringify({
            saved: JSON.parse(localStorage.getItem("pocket.appearance") || "{}").font,
            body: first(document.body),
            prose: first(document.querySelector(".user-text")),
            code: first(document.querySelector(".md pre code")),
            preloads: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) =>
                link.getAttribute("href"),
            ),
            // Once each: Iosevka is a file per weight.
            loaded: [...new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family))],
        });
    `);
}

/** Open the session afresh, as a reload would. */
let opened = 0;

async function open(): Promise<Look> {
    // A new address each time, so the browser loads a new page even when it is on the session already, and a mark on
    // the old page that tells when the new one has replaced it.
    await page.evaluate(`window.fontTestOldPage = true`);
    // A sheet just closed goes back through history a moment later (back.js), which cancels a navigation under way:
    // go again until one lands.
    await until(
        async () =>
            (await page.navigate(`${base}/s/${session}?open=${++opened}`)).error === undefined,
        "a navigation that is not cancelled",
    );
    await see(
        `return JSON.stringify(window.fontTestOldPage === undefined)`,
        "the page loaded again",
    );

    return look();
}

/** Pick a font in Appearance's menu, as a person does, and wait until the page uses it. */
async function pick(id: string, family: string): Promise<Look> {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelector("#appearance-font") !== null)`,
        "the font menu",
    );
    await page.evaluate(`
        const menu = document.querySelector("#appearance-font");

        menu.value = ${JSON.stringify(id)};
        menu.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    // A font's name is quoted in the computed family, and a generic one (system-ui) is not.
    await see(
        `return JSON.stringify(getComputedStyle(document.body).fontFamily.split(",")[0].trim().replace(/"/g, "") === ${JSON.stringify(family)})`,
        `the page in ${family}`,
    );
    await page.evaluate(`(await import("/store.js")).closeSheet()`);

    return look();
}

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
        dataDir: mkdtempSync(join(root, "font-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    // The scripted model echoes it: a reply with a code block in it.
    await say(
        app,
        session,
        "Some prose, *some of it stressed*, then code:\n\n```js\nconst answer = 42; // 0O 1lI\n```",
    );
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a new browser, and one that saved its appearance before fonts could be chosen, use JetBrains Mono",
    real,
    async () => {
        for (const [what, saved] of [
            ["a new browser", null],
            ["older saved settings", { theme: "tokyo-night", text: 14 }],
            [
                "a font this version does not have",
                { theme: "tokyo-night", text: 14, font: "comic-sans" },
            ],
        ] as const) {
            await page.evaluate(`
            localStorage.removeItem("pocket.themeCache");
            ${saved === null ? `localStorage.removeItem("pocket.appearance")` : `localStorage.setItem("pocket.appearance", ${JSON.stringify(JSON.stringify(saved))})`};
        `);

            const shown = await open();

            assert.equal(shown.body, "Pocket Mono", what);
            assert.equal(shown.code, "Pocket Mono", what);
            assert.deepEqual(
                shown.loaded,
                ["Pocket Mono"],
                `${what}: only JetBrains Mono is fetched`,
            );
        }
    },
);

test(
    "each font in Appearance is drawn from its own file, and stays after a reload",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await open();

        for (const [id, family, file] of [
            ["fira-code", "Pocket Fira Code", "/fonts/FiraCode-VF.woff2"],
            ["ibm-plex-mono", "Pocket IBM Plex Mono", "/fonts/IBMPlexMono-Variable.woff2"],
            ["iosevka", "Pocket Iosevka", "/fonts/Iosevka-Regular.woff2"],
        ] as const) {
            const picked = await pick(id, family);

            assert.equal(picked.saved, id);
            assert.equal(picked.prose, family, `${family} for prose`);
            assert.equal(picked.code, family, `${family}, a monospace font, for code too`);
            assert.ok(picked.loaded.includes(family), `${family} loaded`);

            const reloaded = await open();

            assert.equal(reloaded.body, family, `${family} after a reload`);
            assert.deepEqual(
                reloaded.preloads,
                [file],
                `${family}'s file fetched before the style sheet`,
            );
            // JetBrains Mono may come too, for a character the choice lacks (IBM Plex Mono has no ☺, which the
            // reaction button shows), but no font chosen before.
            assert.deepEqual(
                reloaded.loaded.filter((loaded) => loaded !== "Pocket Mono"),
                [family],
                `only ${family} is fetched after a reload`,
            );
        }
    },
);

/** The ligatures setting where `selector` is, as the page draws it: "none" or "normal". */
const ligatures = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontVariantLigatures)`,
    );

/** Flip Appearance's "Use ligatures" switch, as a person does, and give back whether it is on. */
async function flipLigatures(): Promise<boolean> {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelector('[role="switch"][aria-label="Use ligatures"]') !== null)`,
        "the ligatures switch",
    );
    const on = await inPage<boolean>(`
        const flip = document.querySelector('[role="switch"][aria-label="Use ligatures"]');
        const was = flip.getAttribute("aria-checked");

        flip.click();
        await new Promise((resolve) => setTimeout(resolve, 50));

        return JSON.stringify(was === "false");
    `);

    await page.evaluate(`(await import("/store.js")).closeSheet()`);

    return on;
}

test("Use ligatures turns on every font's ligatures, and stays after a reload", real, async () => {
    await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
    await open();
    assert.equal(await ligatures(".md pre code"), "none", "off by default");
    assert.equal(await flipLigatures(), true);

    // The font does not matter: a font without ligatures (IBM Plex Mono) simply draws none.
    for (const [id, family] of [
        ["jetbrains-mono", "Pocket Mono"],
        ["fira-code", "Pocket Fira Code"],
        ["iosevka", "Pocket Iosevka"],
    ] as const) {
        await pick(id, family);
        assert.equal(await ligatures(".md pre code"), "normal", `${family}'s ligatures in code`);
        assert.equal(await ligatures(".user-text"), "normal", `and in prose`);
    }

    const reloaded = await open();

    assert.equal(reloaded.saved, "iosevka");
    assert.equal(await ligatures(".md pre code"), "normal", "still on after a reload");
    assert.equal(await flipLigatures(), false);
    assert.equal(await ligatures(".md pre code"), "none", "off again");
});

/** The families whose italic file the page has loaded. */
const italics = () =>
    inPage<string[]>(`
        return JSON.stringify([...new Set([...document.fonts]
            .filter((face) => face.style === "italic" && face.status === "loaded")
            .map((face) => face.family))]);
    `);

test(
    "italic text, such as comments in code, is drawn from each font's own italic",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);

        // A code comment and stressed prose, in each font: the first is code's font, the second prose's.
        for (const [id, family, where] of [
            ["jetbrains-mono", "Pocket Mono", ".md pre code .hl-com"],
            ["ibm-plex-mono", "Pocket IBM Plex Mono", ".md pre code .hl-com"],
            ["iosevka", "Pocket Iosevka", ".md pre code .hl-com"],
            ["inter", "Pocket Inter", ".md em"],
        ] as const) {
            await pick(id, family);
            const shown = await open();

            assert.equal(shown.saved, id);
            await see(
                `return JSON.stringify(document.fonts.status === "loaded" && getComputedStyle(document.querySelector(${JSON.stringify(where)})).fontStyle === "italic")`,
                `italic text in ${family}`,
            );
            assert.ok((await italics()).includes(family), `${family}'s italic file`);
            // Upright text stays upright: the italic comes only where it is asked for.
            assert.deepEqual(
                shown.preloads.length,
                id === "inter" ? 2 : 1,
                "only upright files are preloaded",
            );
        }

        // Fira Code has no italic: the browser slants it, and no other font's italic comes in its place.
        await pick("fira-code", "Pocket Fira Code");
        await open();
        assert.deepEqual(
            (await italics()).filter((family) => family !== "Pocket Mono"),
            [],
            "no italic file for Fira Code",
        );
    },
);

test(
    "JetBrainsMono Nerd Font draws the icons prompts print, from a file that comes only for them",
    real,
    async () => {
        // The icons' file comes only when one shows: none on a page without them.
        await pick("jetbrains-mono-nerd", "Pocket Mono");

        const plain = await open();

        assert.deepEqual(plain.loaded, ["Pocket Mono"], "no icons, no icon file");
        assert.deepEqual(plain.preloads, ["/fonts/JetBrainsMono.woff2"]);

        // A prompt's icons, as a reply would show them.
        const drawn = await inPage<{ width: number; loaded: string[] }>(`
        const icon = document.createElement("code");

        icon.textContent = "\\u{F07C}\\u{E0A0}";
        document.querySelector(".md").append(icon);
        await document.fonts.load("14px " + getComputedStyle(icon).fontFamily, icon.textContent);
        const width = icon.getBoundingClientRect().width;

        icon.textContent = "ab";
        const letters = icon.getBoundingClientRect().width;
        icon.remove();

        return JSON.stringify({
            width: Math.round((width / letters) * 100) / 100,
            loaded: [...new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family))],
        });
    `);

        assert.ok(
            drawn.loaded.includes("Pocket Nerd Symbols"),
            "the icons' file loads for an icon",
        );
        assert.equal(drawn.width, 1, "each icon is one letter wide, so columns line up");

        // Other fonts do not draw them.
        await pick("fira-code", "Pocket Fira Code");
        assert.ok(
            !(
                await inPage<string>(
                    `return JSON.stringify(getComputedStyle(document.body).fontFamily)`,
                )
            ).includes("Nerd Symbols"),
        );
    },
);

test("a font that is not monospace leaves code in JetBrains Mono", real, async () => {
    const inter = await pick("inter", "Pocket Inter");

    assert.equal(inter.prose, "Pocket Inter");
    assert.equal(inter.code, "Pocket Mono");

    const reloaded = await open();

    assert.equal(reloaded.body, "Pocket Inter");
    assert.equal(reloaded.code, "Pocket Mono");
    assert.deepEqual(reloaded.preloads, [
        "/fonts/InterVariable.woff2",
        "/fonts/JetBrainsMono.woff2",
    ]);
    assert.deepEqual(reloaded.loaded.toSorted(), ["Pocket Inter", "Pocket Mono"]);

    // The system's own sans-serif fetches nothing for prose; code keeps the bundled JetBrains Mono.
    const system = await pick("system-sans", "system-ui");

    assert.equal(system.code, "Pocket Mono");

    const plain = await open();

    assert.deepEqual(plain.preloads, ["/fonts/JetBrainsMono.woff2"]);
    assert.deepEqual(plain.loaded, ["Pocket Mono"]);
});
