import assert from "node:assert/strict";
import test from "node:test";
import {
    MAX_PACKET_BYTES,
    menuModel,
    parseRequest,
    SECTIONS,
    SETTINGS_COMMANDS,
} from "../../packaging/desktop/protocol/index.mjs";
import { initialState } from "../../packaging/desktop/protocol/state.mjs";

test("the desktop protocol rejects unknown, unbounded and malformed wire messages", () => {
    const request = {
        v: 1,
        id: 1,
        command: "action",
        value: { id: "settings.open", data: { section: "runner" } },
    };

    assert.deepEqual(parseRequest(JSON.stringify(request)), request);
    assert.equal(parseRequest(JSON.stringify({ ...request, v: 2 })), null);
    assert.equal(parseRequest(JSON.stringify({ ...request, id: -1 })), null);
    assert.equal(parseRequest(JSON.stringify({ ...request, command: "eval" })), null);
    assert.equal(parseRequest('{"v":1,"id":1,"command":"action","value":{"__proto__":{}}}'), null);
    assert.equal(parseRequest("not JSON"), null);
    assert.equal(
        parseRequest(JSON.stringify({ ...request, value: "a".repeat(MAX_PACKET_BYTES) })),
        null,
    );
    assert.deepEqual(SETTINGS_COMMANDS, ["getState", "subscribe", "patchPreferences", "action"]);
});

test("only current local sessions can restart; tray keeps Settings and Quit with no page", () => {
    const state = initialState("windows", "0.30.1", false);
    const entries = () => new Map(menuModel(state).tray.map((item) => [item.id, item]));

    assert.deepEqual(SECTIONS, [
        "home",
        "runner",
        "updates",
        "dictation",
        "window",
        "appearance",
        "notifications",
        "server",
    ]);
    assert.equal(state.preferences.home.mode, null);
    assert.equal(state.preferences.window.titleBar, "seamless");
    assert.equal(initialState("macos", "0.30.1", true).preferences.home.mode, "local");
    assert.equal(initialState("windows", "0.30.1", true).preferences.window.titleBar, "system");
    assert.equal(entries().get("window.newSession").enabled, false);
    assert.equal(entries().get("window.open").enabled, true);
    assert.equal(entries().get("settings.open").enabled, true);
    assert.equal(entries().get("app.quit").enabled, true);
    assert.equal(entries().has("home.local.restart"), false);
    state.home.active = { mode: "remote", kind: "pocket" };
    state.home.local.verified = true;
    assert.equal(entries().has("home.local.restart"), false);
    state.home.active.mode = "local";
    assert.equal(entries().get("home.local.restart").enabled, true);
});
