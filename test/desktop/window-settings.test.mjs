import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { initialState } from "../../packaging/desktop/protocol/state.mjs";

const source = readFileSync(
    new URL("../../packaging/desktop/settings/settings.js", import.meta.url),
    "utf8",
);

async function mountSettings(platform, currentSection) {
    const elements = [];

    const makeElement = (tag) => {
        const element = {
            tag,
            children: [],
            dataset: {},
            add() {},
            append(...items) {
                this.children.push(...items.filter((item) => item?.children));
            },
            replaceChildren(...items) {
                this.children.length = 0;
                this.append(...items);
            },
            setAttribute() {},
            removeAttribute() {},
            classList: { toggle() {} },
            querySelector(selector) {
                return this.children.find((child) => child.tag === selector);
            },
            querySelectorAll() {
                return this.children.flatMap((child) =>
                    child.name && (child.tag === "input" || child.tag === "select")
                        ? [child]
                        : child.querySelectorAll(),
                );
            },
        };

        elements.push(element);

        return element;
    };

    const section = makeElement();

    section.dataset.section = currentSection;
    const state = initialState(platform, "1.0.0", false);
    const fields = new Map();
    const patches = [];
    let receive;
    const document = {
        activeElement: null,
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
    };

    runInNewContext(source, {
        document,
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
                            receive({ type: "section", section: currentSection });
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

    return { document, elements, patches, receive, state };
}

async function recorder(platform) {
    const { elements, patches } = await mountSettings(platform, "window");
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

test("a native effect update does not replace opacity while the user edits it", async () => {
    const { document, elements, patches, receive, state } = await mountSettings(
        "macos",
        "appearance",
    );
    const opacity = elements.find((element) => element.name === "opacity");
    const next = { ...state, revision: 1, window: { ...state.window, effect: "available" } };

    assert.equal(opacity.value, 82);
    document.activeElement = opacity;
    opacity.value = "2";
    receive({ type: "state", state: next });
    assert.equal(opacity.value, "2");

    opacity.value = "28";
    opacity.valueAsNumber = 28;
    document.activeElement = null;
    await opacity.onchange();
    assert.equal(patches.at(-1).value.appearance.opacity, 28);
});

test("a window theme update keeps the Updates picker control available", async () => {
    const { document, elements, patches, receive, state } = await mountSettings("macos", "updates");
    const button = elements.find((element) => element.textContent === "Select installer…");
    const updates = { ...state.updates, status: "downloading" };
    const theme = { dark: true };

    assert.ok(button.hidden);
    receive({
        type: "state",
        state: { ...state, revision: 1, updates, window: { ...state.window, theme } },
    });
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.ok(!button.hidden && !button.disabled);
    await button.onclick();
    assert.equal(patches.at(-1).value.id, "updates.selectInstaller");
});
