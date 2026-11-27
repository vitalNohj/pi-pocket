import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopController } from "../../packaging/desktop/controller/index.mjs";

async function profile(t) {
    const folder = await mkdtemp(join(tmpdir(), "pocket-window-settings-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    return folder;
}

async function open(t, { folder, platform = "windows", existingInstall = false, handle } = {}) {
    const requests = [];
    const results = new Map();
    const controller = new DesktopController({
        folder: folder ?? (await profile(t)),
        platform,
        version: "1.0.0",
        existingInstall,
        write(packet) {
            if (packet.type === "result") {
                results.set(packet.id, packet);
            } else if (packet.type === "host") {
                const { id, action, data } = packet;
                requests.push([action, data]);
                let value;

                try {
                    value = { id, ok: true, value: handle?.(action, data) ?? null };
                } catch (error) {
                    value = { id, ok: false, error: { code: "native", message: error.message } };
                }

                void controller.receive({ id: id + 10000, command: "host.result", value });
            }
        },
    });
    t.after(() => controller.close());
    await controller.load();
    let id = 0;
    async function call(command, value) {
        const current = ++id;
        await controller.receive({ id: current, command, value });
        const result = results.get(current);
        if (!result.ok) {
            throw Object.assign(new Error(result.error.message), result.error);
        }
        return result.value;
    }
    return {
        requests,
        call,
        state: () => call("getState"),
        patch: (value) => call("patchPreferences", value),
    };
}

test("window and appearance defaults differ only where the platform or upgrade requires it", async (t) => {
    for (const platform of ["windows", "macos"]) {
        for (const existingInstall of [false, true]) {
            const app = await open(t, { platform, existingInstall });
            const { preferences, window } = await app.state();
            assert.equal(window.loginEnabled, null);
            assert.equal(preferences.window.titleBar, existingInstall ? "system" : "seamless");
            assert.equal(preferences.window.closeToTray, true);
            assert.equal(preferences.window.links, "app");
            assert.equal(preferences.window.shortcutEnabled, false);
            assert.equal(
                preferences.window.shortcut,
                platform === "windows" ? "Ctrl+Shift+P" : "Meta+Shift+P",
            );
            assert.deepEqual(preferences.appearance, {
                transparent: false,
                opacity: 82,
                material: platform === "windows" ? "acrylic" : "window",
                trayStyle: "system",
            });
        }
    }
});

test("imports the old native options once and keeps later Desktop Settings choices", async (t) => {
    const folder = await profile(t);
    const file = join(folder, "window.json");
    await writeFile(
        join(folder, "desktop.json"),
        JSON.stringify({
            schemaVersion: 1,
            preferences: {
                home: { healthInterval: 23 },
                window: { titleBar: "seamless", showMenuBar: true },
            },
        }),
    );
    await writeFile(
        file,
        JSON.stringify({
            titleBar: "system",
            closeToTray: false,
            startHidden: true,
            externalPages: true,
            globalShortcut: true,
            seeThrough: true,
            opacity: 46,
            material: "mica",
        }),
    );
    const app = await open(t, { folder });
    const { preferences } = await app.state();
    assert.equal(preferences.window.titleBar, "system");
    assert.equal(preferences.window.closeToTray, false);
    assert.equal(preferences.window.startHidden, true);
    assert.equal(preferences.window.links, "browser");
    assert.equal(preferences.window.shortcutEnabled, true);
    assert.equal(preferences.window.showMenuBar, true);
    assert.equal(preferences.home.healthInterval, 23);
    assert.deepEqual(preferences.appearance, {
        transparent: true,
        opacity: 46,
        material: "mica",
        trayStyle: "system",
    });
    await app.patch({
        window: { titleBar: "seamless", startHidden: false },
        appearance: { opacity: 0 },
    });
    assert.deepEqual(app.requests, [["window.login.prepare", undefined]]);
    const relaunched = await open(t, { folder, existingInstall: true });
    const saved = (await relaunched.state()).preferences;
    assert.equal(saved.window.titleBar, "seamless");
    assert.equal(saved.window.startHidden, false);
    assert.equal(saved.appearance.opacity, 0);
});

test("invalid window edits never save and a shortcut collision leaves the existing binding intact", async (t) => {
    let registered;
    const folder = await profile(t);
    const app = await open(t, {
        folder,
        handle(action, data) {
            assert.equal(action, "window.shortcut");
            if (data.shortcut === "Ctrl+Shift+O") {
                throw new Error("The show/hide shortcut is already in use.");
            }
            registered = data.enabled ? data.shortcut : null;
        },
    });
    await assert.rejects(
        app.patch({ window: { closeToTray: false }, appearance: { material: "sidebar" } }),
        { code: "invalid" },
    );
    await assert.rejects(app.patch({ appearance: { opacity: 101 } }), { code: "invalid" });
    await assert.rejects(app.patch({ window: { shortcut: "Shift+P" } }), { code: "invalid" });
    assert.equal((await app.state()).preferences.window.closeToTray, true);
    assert.equal(app.requests.length, 0);
    await app.patch({ window: { shortcutEnabled: true } });
    assert.equal(registered, "Ctrl+Shift+P");
    await assert.rejects(
        app.patch({ window: { shortcut: "Ctrl+Shift+O" } }),
        /shortcut is already in use/,
    );
    assert.equal(registered, "Ctrl+Shift+P");
    assert.equal((await app.state()).preferences.window.shortcut, registered);
    const stored = JSON.parse(await readFile(join(folder, "desktop.json"), "utf8"));
    assert.equal(stored.preferences.window.shortcut, registered);
    await app.patch({ window: { shortcut: "Ctrl+Alt+S" }, appearance: { opacity: 100 } });
    assert.equal(registered, "Ctrl+Alt+S");
    await app.patch({ window: { shortcutEnabled: false } });
    assert.equal(registered, null);
});

test("launch at login reflects native registration instead of a saved preference", async (t) => {
    const folder = await profile(t);
    const app = await open(t, {
        folder,
        platform: "macos",
        handle(action, data) {
            assert.equal(action, "window.login.set");
            return data.enabled;
        },
    });
    await assert.rejects(app.patch({ window: { loginEnabled: true } }), { code: "invalid" });
    await assert.rejects(
        app.call("action", { id: "window.login.set", data: { enabled: "true" } }),
        { code: "invalid" },
    );
    await app.call("action", { id: "window.login.set", data: { enabled: true } });
    assert.equal((await app.state()).window.loginEnabled, true);
    await app.call("host.report", { event: "platform", data: { loginEnabled: false } });
    assert.equal((await app.state()).window.loginEnabled, false);
    const stored = JSON.parse(await readFile(join(folder, "desktop.json"), "utf8"));
    assert(!Object.hasOwn(stored.preferences.window, "loginEnabled"));
});
