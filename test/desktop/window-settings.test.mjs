import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { initialState } from "../../packaging/desktop/protocol/state.mjs";

const source = readFileSync(
    new URL("../../packaging/desktop/settings/settings.js", import.meta.url),
    "utf8",
);

async function recorder(platform) {
    const elements = [];

    const makeElement = () => {
        const element = {
            dataset: {},
            add() {},
            append() {},
            replaceChildren() {},
            setAttribute() {},
            removeAttribute() {},
            querySelectorAll: () => [],
        };

        elements.push(element);

        return element;
    };

    const section = makeElement();

    section.dataset.section = "window";
    const state = initialState(platform, "1.0.0", false);
    const fields = new Map();
    const patches = [];
    let receive;

    runInNewContext(source, {
        document: {
            documentElement: makeElement(),
            createElement: makeElement,
            querySelectorAll: () => [section],
            querySelector(selector) {
                if (!fields.has(selector)) {
                    fields.set(selector, makeElement());
                }

                return fields.get(selector);
            },
            addEventListener() {},
        },
        Option: class {},
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        setTimeout,
        clearTimeout,
        window: {
            chrome: {
                webview: {
                    addEventListener(_type, callback) {
                        receive = (data) => callback({ data: { v: 1, ...data } });
                    },
                    postMessage(packet) {
                        if (packet.command === "getState") {
                            receive({ type: "section", section: "window" });
                        } else {
                            patches.push(packet);
                        }

                        receive({ type: "result", id: packet.id, ok: true, value: state });
                    },
                },
            },
        },
    });
    await Promise.resolve();
    const button = elements.find((element) => /^Change shortcut/.test(element.textContent));

    assert.ok(button, "Desktop Settings rendered the shortcut recorder");

    return {
        start: () => button.onclick(),
        press(key) {
            const before = patches.length;

            button.onkeydown({ ctrlKey: true, preventDefault() {}, stopPropagation() {}, ...key });

            return patches[before]?.value.window.shortcut;
        },
    };
}

test("Windows records the logical letter on an AZERTY keyboard", async () => {
    const shortcut = await recorder("windows");

    shortcut.start();
    assert.equal(shortcut.press({ key: "a", code: "KeyQ", keyCode: 0x41 }), "Ctrl+A");
});

test("Windows uses the number row's virtual keys even when Shift produces punctuation", async () => {
    const shortcut = await recorder("windows");

    shortcut.start();
    assert.equal(shortcut.press({ key: "1", code: "Numpad1", keyCode: 0x61 }), undefined);
    assert.equal(
        shortcut.press({ key: "!", code: "Digit7", keyCode: 0x31, shiftKey: true }),
        "Ctrl+Shift+1",
    );
});

test("macOS still records the physical position used by its native hotkey", async () => {
    const shortcut = await recorder("macos");

    shortcut.start();
    assert.equal(shortcut.press({ key: "a", code: "KeyQ", keyCode: 0x41 }), "Ctrl+Q");
});
