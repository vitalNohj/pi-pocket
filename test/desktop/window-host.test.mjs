import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const code = readFileSync(
    new URL("../../packaging/desktop/window/host.js", import.meta.url),
    "utf8",
);
const origin = "http://127.0.0.1:1234";

function documentStart({ frame = false, effectiveOrigin = origin } = {}) {
    const attrs = new Map();
    const style = new Map();
    const html = {
        toggleAttribute(name, on) {
            attrs.set(name, on);
        },
        style: {
            setProperty(name, value) {
                style.set(name, value);
            },
            removeProperty(name) {
                style.delete(name);
            },
        },
    };
    const messages = [];
    const handlers = new Map();
    const window = { origin: effectiveOrigin };

    window.top = frame ? {} : window;
    const navigator = {};
    const scope = {
        window,
        navigator,
        location: { origin },
        document: { documentElement: html, addEventListener() {} },
        EventTarget,
        Event,
        Element: class {
            closest() {
                return this;
            }
            hasAttribute() {
                return true;
            }
        },
        DOMRect: class {
            constructor(x = 0, y = 0, width = 0, height = 0) {
                Object.assign(this, { x, y, width, height });
            }
        },
        MutationObserver: class {
            observe() {}
        },
        matchMedia: () => ({ addEventListener() {} }),
        requestAnimationFrame: () => 1,
        addEventListener: (kind, handler) => handlers.set(kind, handler),
        URL,
        innerWidth: 900,
    };

    vm.runInNewContext(code, scope)(
        origin,
        "test-window",
        { side: "left", width: 76, height: 32, tint: null },
        (message) => messages.push(message),
    );

    return { ...scope, attrs, style, messages, handlers };
}

test("the document-start overlay stays out of a frame or an opaque document", () => {
    assert.equal(documentStart({ frame: true }).navigator.windowControlsOverlay, undefined);
    assert.equal(documentStart({ effectiveOrigin: "null" }).window.__piPocketWindow, undefined);
});

test("layout reads native button bounds at startup and after geometry changes", () => {
    const env = documentStart();
    const overlay = env.navigator.windowControlsOverlay;
    const events = [];

    overlay.addEventListener("geometrychange", (event) => events.push(event));

    assert.equal(overlay.visible, true);
    assert.equal(overlay.getTitlebarAreaRect().x, 76);
    env.window.__piPocketWindow.update({ side: "right", width: 140, height: 34, tint: 82 });
    assert.equal(events.length, 1);
    assert.equal(events[0].titlebarAreaRect.width, 760);
    assert.equal(env.attrs.get("data-pocket-window-material"), false);
    env.window.__piPocketWindow.ready(() => false);
    assert.equal(env.style.get("--pocket-window-opacity"), "82%");
    env.window.__piPocketWindow.update({ side: "none", width: 0, height: 0, tint: null });
    assert.equal(overlay.visible, false);
    assert.equal(env.style.has("--pocket-window-opacity"), false);
});

test("only a user activation on an exact server route supplies direct-download provenance", () => {
    const env = documentStart();

    env.window.__piPocketWindow.ready(() => false);
    const click = env.handlers.get("click");
    const target = new env.Element();
    const valid = `${origin}/api/c/17/download?path=Folder%2Fnotes.txt`;

    for (const href of [
        "/api/c/17/download/extra?path=test",
        "/api/c/17/download?path=",
        "/api/c/17/download?path=a&path=b",
        "/api/c/temp/download?path=file",
        "/api/c/17/download?path=file#view",
        "https://example.test/api/c/17/download?path=file",
    ]) {
        target.href = new URL(href, origin).href;
        click({ target, isTrusted: true });
    }

    target.href = valid;
    click({ target, isTrusted: false });
    click({ target, isTrusted: true });
    assert.deepEqual(
        env.messages.map(({ type }) => type),
        ["ready", "download-link"],
    );
    assert.equal(env.messages[1].url, valid);
});
