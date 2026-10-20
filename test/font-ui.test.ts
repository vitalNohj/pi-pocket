// Appearance's typography, in a real browser where this machine has Chromium: the theme's fonts (Geist and JetBrains
// Mono) in a new browser and in one that saved its appearance before the setting was there; a text font and a code font
// chosen apart, each drawn from its own bundled file, kept over a reload, and the only fonts fetched; code only ever
// monospace; italics from each font's own file; the Nerd Font's icons; ligatures over the theme's; and a text size typed
// in, smaller than the buttons offer.
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

/** The app's own fonts, as the theme sets them. */
const SANS = "Pocket Sans";
const MONO = "Pocket Mono";

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
    /** The choices saved in this browser, if any. */
    textFont: string | undefined;
    codeFont: string | undefined;
    /** The first family of each place's font: a reply's prose, a person's message, and code in a reply. */
    prose: string;
    message: string;
    code: string;
    /** The reply's text size, in pixels. */
    size: number;
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
        const saved = JSON.parse(localStorage.getItem("pocket.appearance") || "{}");
        const prose = document.querySelector(".md p");

        return JSON.stringify({
            textFont: saved.textFont,
            codeFont: saved.codeFont,
            prose: first(prose),
            message: first(document.querySelector(".user-text")),
            code: first(document.querySelector(".md pre code")),
            size: parseFloat(getComputedStyle(prose).fontSize),
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

/** Open Appearance, and wait for its typography. */
async function appearance(): Promise<void> {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelector("#appearance-text-font") !== null)`,
        "Appearance's font menus",
    );
}

const closeSheet = () => page.evaluate(`(await import("/store.js")).closeSheet()`);

/** Choose in one of Appearance's menus, as a person does, and wait until `selector` is drawn in `family`. */
async function choose(
    menu: "text" | "code",
    id: string,
    family: string,
    selector = menu === "text" ? ".md p" : ".md pre code",
): Promise<Look> {
    await appearance();
    await page.evaluate(`
        const menu = document.querySelector("#appearance-${menu}-font");

        menu.value = ${JSON.stringify(id)};
        menu.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    // A font's name is quoted in the computed family, and a generic one (system-ui) is not.
    await see(
        `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontFamily.split(",")[0].trim().replace(/"/g, "") === ${JSON.stringify(family)})`,
        `${selector} in ${family}`,
    );
    await closeSheet();

    return look();
}

/** The ids each of Appearance's menus offers. */
const offered = (menu: "text" | "code") =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll("#appearance-${menu}-font option")].map((option) => option.value))`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "font-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    // The scripted model echoes it: a reply with prose and a code block in it.
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
    "a new browser, and older or unknown saved choices, keep the theme's fonts",
    real,
    async () => {
        for (const [what, saved] of [
            ["a new browser", null],
            ["older saved settings", { theme: "tokyo-night", text: 15 }],
            [
                "the font setting of the first font switcher",
                { theme: "tokyo-night", font: "fira-code" },
            ],
            ["fonts this version does not have", { textFont: "comic-sans", codeFont: "inter" }],
        ] as const) {
            await page.evaluate(`
            localStorage.removeItem("pocket.themeCache");
            ${saved === null ? `localStorage.removeItem("pocket.appearance")` : `localStorage.setItem("pocket.appearance", ${JSON.stringify(JSON.stringify(saved))})`};
        `);

            const shown = await open();

            assert.equal(shown.prose, SANS, what);
            assert.equal(shown.code, MONO, what);
            assert.deepEqual(
                shown.preloads,
                ["/fonts/Geist.woff2", "/fonts/JetBrainsMono.woff2"],
                what,
            );
            assert.deepEqual(
                shown.loaded.toSorted(),
                [MONO, SANS],
                `${what}: only the theme's fonts are fetched`,
            );
        }
    },
);

test("the code font offers only monospace fonts; the text font offers all", real, async () => {
    await appearance();

    const text = await offered("text");
    const code = await offered("code");

    await closeSheet();
    assert.equal(text[0], "theme");
    assert.equal(code[0], "theme");
    assert.ok(text.includes("inter") && text.includes("fira-code"), "words in any font");
    assert.ok(
        !code.includes("inter") && !code.includes("geist") && !code.includes("system-sans"),
        "no sans for code",
    );
    assert.ok(code.includes("iosevka") && code.includes("system-mono"));
});

test(
    "a text font and a code font chosen apart, each from its own file, and kept over a reload",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await open();

        for (const [text, textFamily, textFile, code, codeFamily, codeFile] of [
            [
                "inter",
                "Pocket Inter",
                "/fonts/InterVariable.woff2",
                "fira-code",
                "Pocket Fira Code",
                "/fonts/FiraCode-VF.woff2",
            ],
            [
                "ibm-plex-mono",
                "Pocket IBM Plex Mono",
                "/fonts/IBMPlexMono-Variable.woff2",
                "iosevka",
                "Pocket Iosevka",
                "/fonts/Iosevka-Regular.woff2",
            ],
        ] as const) {
            await choose("text", text, textFamily);

            const picked = await choose("code", code, codeFamily);

            assert.equal(picked.textFont, text);
            assert.equal(picked.codeFont, code);
            assert.equal(picked.prose, textFamily, `${textFamily} for a reply's words`);
            assert.equal(picked.message, textFamily, `and a person's`);
            assert.equal(picked.code, codeFamily, `${codeFamily} for code`);

            const reloaded = await open();

            assert.equal(reloaded.prose, textFamily, `${textFamily} after a reload`);
            assert.equal(reloaded.code, codeFamily, `${codeFamily} after a reload`);
            assert.deepEqual(
                reloaded.preloads.toSorted(),
                [codeFile, textFile].toSorted(),
                "their files preloaded",
            );
            // JetBrains Mono may come too, for a character the choice lacks (IBM Plex Mono has no ☺, which the
            // reaction button shows), but not Geist, nor a font chosen before.
            assert.deepEqual(
                reloaded.loaded.filter((loaded) => loaded !== MONO).toSorted(),
                [codeFamily, textFamily].toSorted(),
                "only the chosen fonts are fetched",
            );
        }

        // Back to the theme's: the app's own fonts, and their files.
        await choose("text", "theme", SANS);
        await choose("code", "theme", MONO);

        const theme = await open();

        assert.deepEqual(theme.preloads, ["/fonts/Geist.woff2", "/fonts/JetBrainsMono.woff2"]);
    },
);

test("a device's font preloads nothing in place of the theme's", real, async () => {
    await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
    await open();
    await choose("text", "system-sans", "system-ui");

    const shown = await open();

    assert.equal(shown.code, MONO);
    assert.deepEqual(shown.preloads, ["/fonts/JetBrainsMono.woff2"]);
    assert.deepEqual(shown.loaded, [MONO]);
});

/** The ligatures setting where `selector` is, as the page draws it: "none" or "normal". */
const ligatures = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontVariantLigatures)`,
    );

/** Choose in Appearance's Ligatures row, as a person does. */
async function setLigatures(label: "Theme's" | "On" | "Off"): Promise<void> {
    await appearance();
    await page.evaluate(`
        const row = [...document.querySelectorAll(".setting-row")].find((each) =>
            each.querySelector(".setting-text span")?.textContent === "Ligatures",
        );

        [...row.querySelectorAll("button")].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click();
    `);
    await closeSheet();
}

test(
    "Ligatures turns on every font's ligatures over the theme's, and stays after a reload",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await open();
        assert.equal(await ligatures(".md pre code"), "none", "the app's own look has none");
        await setLigatures("On");

        // The font does not matter: a font without ligatures (IBM Plex Mono) simply draws none.
        for (const [id, family] of [
            ["jetbrains-mono", MONO],
            ["fira-code", "Pocket Fira Code"],
            ["iosevka", "Pocket Iosevka"],
        ] as const) {
            await choose("code", id, family);
            assert.equal(
                await ligatures(".md pre code"),
                "normal",
                `${family}'s ligatures in code`,
            );
            assert.equal(await ligatures(".md p"), "normal", `and in words`);
        }

        await open();
        assert.equal(await ligatures(".md pre code"), "normal", "still on after a reload");
        await setLigatures("Off");
        assert.equal(await ligatures(".md pre code"), "none", "off");
        await setLigatures("Theme's");
        assert.equal(await ligatures(".md pre code"), "none", "the theme's again");
    },
);

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
        await open();

        // A code comment in each code font, and stressed words in a text font.
        for (const [menu, id, family, where] of [
            ["code", "jetbrains-mono", MONO, ".md pre code .hl-com"],
            ["code", "ibm-plex-mono", "Pocket IBM Plex Mono", ".md pre code .hl-com"],
            ["code", "iosevka", "Pocket Iosevka", ".md pre code .hl-com"],
            ["text", "inter", "Pocket Inter", ".md em"],
        ] as const) {
            await choose(menu, id, family);
            await open();
            await see(
                `return JSON.stringify(document.fonts.status === "loaded" && getComputedStyle(document.querySelector(${JSON.stringify(where)})).fontStyle === "italic")`,
                `italic text in ${family}`,
            );
            assert.ok((await italics()).includes(family), `${family}'s italic file`);
        }

        // Fira Code has no italic: the browser slants it, and no other font's italic comes in its place.
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await choose("code", "fira-code", "Pocket Fira Code");
        await open();
        assert.deepEqual(
            (await italics()).filter((family) => family === "Pocket Fira Code"),
            [],
            "no italic file for Fira Code",
        );
    },
);

test(
    "JetBrainsMono Nerd Font draws the icons prompts print, from a file that comes only for them",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await open();
        await choose("code", "jetbrains-mono-nerd", MONO);

        // The icons' file comes only when one shows: none on a page without them.
        const plain = await open();

        assert.ok(!plain.loaded.includes("Pocket Nerd Symbols"), "no icons, no icon file");
        assert.deepEqual(plain.preloads, ["/fonts/Geist.woff2", "/fonts/JetBrainsMono.woff2"]);

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
    },
);

/** Type a text size into Appearance's field, as a person does, and press Enter. */
async function typeSize(value: string): Promise<void> {
    await appearance();
    // Type over what the field holds, and press Enter, as a person does.
    // The field is far down the sheet on a phone: in view, and the sheet done rising, before a tap can reach it.
    await page.evaluate(
        `document.querySelector('input[aria-label="Text size in pixels"]').scrollIntoView({ block: "center" })`,
    );
    await see(
        `return JSON.stringify(document.getAnimations().every((each) => each.playState !== "running"))`,
        "the sheet at rest",
    );
    await page.type({ selector: 'input[aria-label="Text size in pixels"]' }, value);
    await page.press("Enter");
    await page.press("Escape");
}

test(
    "a text size typed in, smaller than the buttons offer, kept in range and over a reload",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        assert.equal((await open()).size, 15, "15 by default");

        await typeSize("10.5");
        await see(
            `return JSON.stringify(parseFloat(getComputedStyle(document.querySelector(".md p")).fontSize) === 10.5)`,
            "10.5px words",
        );
        assert.equal((await open()).size, 10.5, "after a reload");

        // Out of range, or between steps: the nearest size there is.
        for (const [typed, size] of [
            ["4", 10],
            ["99", 24],
            ["12.3", 12.5],
        ] as const) {
            await typeSize(typed);
            await see(
                `return JSON.stringify(parseFloat(getComputedStyle(document.querySelector(".md p")).fontSize) === ${size})`,
                `${typed} kept as ${size}`,
            );
        }

        // A size saved by hand outside the range draws in range.
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ text: 3 }))`,
        );
        assert.equal((await open()).size, 10);
    },
);
