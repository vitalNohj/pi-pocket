// A theme's CSS reaches only its own folder: the page's content security policy keeps every load on this server, and
// these checks keep a theme from any other address on it (`url(/login?token=…)`, an API route), however it is written.
import { root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import { readTheme, Themes } from "../src/server/themes.ts";
import { cssReferences } from "../src/server/themes/css.ts";
import { ThemeProblem } from "../src/server/themes/format.ts";

test("a theme's CSS may load only files in its own folder", () => {
    const dir = join(root, "themes", "mine");

    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Mine" }));
    writeFileSync(join(dir, "fonts", "a.woff2"), "wOF2");

    const css = (rule: string) => {
        writeFileSync(join(dir, "theme.css"), `@font-face { src: url(fonts/a.woff2); }\n${rule}\n`);

        return () => readTheme(dir, "mine", false, "0.14.0");
    };

    assert.equal(css(":root { --x: 1px; }")().assets.size, 1);

    for (const rule of [
        "a { background: url(https://elsewhere.example/a.png); }",
        "a { background: url(/login?token=a); }",
        "a { background: \\75 rl(../../a.png); }",
        'a { background: image-set("/api/me" 1x); }',
        'a { background: image-set(var(--n, "/login?token=a") 1x); }',
        ':root { --x: "/login?token=a"; } a { background: image-set(var(--x) 1x); }',
        "a { background: attr(data-x url); }",
        "@font-face { font-family: x; src: src(var(--f)); }",
    ]) {
        assert.throws(css(rule), ThemeProblem, rule);
    }
});

test("the check reads deeply nested CSS in time: its cost does not grow with the square of the nesting", () => {
    const started = Date.now();

    // 256 KB, a theme's limit: about half a minute before the fix, a fraction of a second after.
    cssReferences(`a{b:${"var(".repeat(64_000)}`);
    assert.ok(Date.now() - started < 5_000);
});

test("every built-in theme passes its checks", () => {
    const builtIn = join(APP_ROOT, "web", "themes");

    for (const id of readdirSync(builtIn)) {
        assert.doesNotThrow(() => readTheme(join(builtIn, id), id, true, "0.14.0"), id);
    }
});

test("an owner's theme loads when the data folder is reached through a link", async () => {
    const data = join(root, "real-data");
    const linked = join(root, "linked-data");

    mkdirSync(join(data, "themes", "mine"), { recursive: true });
    writeFileSync(
        join(data, "themes", "mine", "theme.json"),
        JSON.stringify({ themeApi: 1, name: "Mine" }),
    );
    writeFileSync(join(data, "themes", "mine", "theme.css"), ":root { --r-card: 0; }\n");
    symlinkSync(data, linked);

    const themes = new Themes({
        builtIn: join(root, "no-built-in-themes"),
        dataDir: linked,
        notify: () => {},
        changed: () => {},
        log: () => {},
    });

    await themes.load();
    assert.deepEqual(
        themes.list().map((each) => [each.id, each.usable]),
        [["mine", true]],
    );
});

test("a theme that names the app's fonts gets their files preloaded, with its own", async () => {
    const data = join(root, "app-fonts-data");
    const dir = join(data, "themes", "reader");

    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Reader" }));
    writeFileSync(join(dir, "fonts", "own.woff2"), "wOF2");
    writeFileSync(
        join(dir, "theme.css"),
        [
            `@font-face { font-family: "Own"; src: url(fonts/own.woff2); }`,
            `:root { --sans: "Pocket Inter", sans-serif; --mono: "Pocket Fira Code", monospace; }`,
            // Named in a comment only: not a font it uses.
            `/* "Pocket Iosevka" */`,
        ].join("\n"),
    );

    const themes = new Themes({
        builtIn: join(root, "no-built-in-themes"),
        dataDir: data,
        notify: () => {},
        changed: () => {},
        log: () => {},
    });

    await themes.load();
    const fonts = themes.list().find((each) => each.id === "reader")?.fonts ?? [];

    assert.equal(fonts.length, 3);
    assert.match(fonts[0]!, /^\/themes\/reader\/[A-Za-z0-9_-]{12}\/fonts\/own\.woff2$/);
    assert.deepEqual(fonts.slice(1), ["/fonts/InterVariable.woff2", "/fonts/FiraCode-VF.woff2"]);
});
