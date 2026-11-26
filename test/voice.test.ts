import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

/** What voice.js imports, stood in for: hooks for one call outside a component, and no page to draw on. */
const STUBS: Record<string, string> = {
    "preact/hooks": `
        export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
        export const useRef = (current) => ({ current });
        export const useEffect = (effect) => globalThis.voiceCleanups.push(effect());
    `,
    "./store.js": `
        export const notify = () => {};
        export const store = globalThis.testVoiceStore;
    `,
    "./ui.js": `export const html = () => null; export const Icon = () => null;`,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/voice.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

type Result = { 0: { transcript: string }; isFinal: boolean };
type Recognition = {
    onresult: ((event: { results: Result[] }) => void) | null;
    started: boolean;
};
type Dictation = { listening: boolean; toggle: () => void; stop: (drop?: boolean) => void };
type Voice = {
    useDictation: (
        box: { current: Box | null },
        onText: (value: string, at: number) => void,
        options?: { top?: boolean },
    ) => Dictation;
    toggleDictation: () => boolean;
    registerDictationProvider: (provider: new () => Recognition) => () => void;
    offlineVoiceKey: () => string;
    voiceAvailable: () => boolean;
};

const recognitions: Recognition[] = [];

const state = { me: { id: "test-owner" }, conversationId: 1, pipOpen: false };
const listeners = new Set<(value: typeof state) => void>();
const preferences = new Map<string, string>();
const world = globalThis as Record<string, unknown>;

world.testVoiceStore = {
    state,
    subscribe(listener: (value: typeof state) => void) {
        listeners.add(listener);

        return () => listeners.delete(listener);
    },
};
world.localStorage = { getItem: (key: string) => preferences.get(key) ?? null };
world.voiceCleanups = [];
(globalThis as Record<string, unknown>).document = {
    activeElement: null,
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
};
(globalThis as Record<string, unknown>).SpeechRecognition = class {
    onresult = null;
    onerror = null;
    onend = null;
    started = false;

    constructor() {
        recognitions.push(this as unknown as Recognition);
    }

    start() {
        this.started = true;
    }

    stop() {
        this.started = false;
    }

    abort() {
        this.started = false;
    }
};

const voice = (await import(new URL("../web/voice.js", import.meta.url).href)) as Voice;
const page = (globalThis as unknown as { document: { activeElement: unknown } }).document;

/** A textarea as dictation sees it: setting its text puts the caret at the end, as a browser does. */
class Box {
    #value: string;
    selectionStart: number;
    selectionEnd: number;
    isConnected = true;

    constructor(value: string) {
        this.#value = value;
        this.selectionStart = this.selectionEnd = value.length;
    }

    get value() {
        return this.#value;
    }

    set value(value: string) {
        this.#value = value;
        this.selectionStart = this.selectionEnd = value.length;
    }

    setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
    }

    /** The person types `text` at the caret. */
    type(text: string) {
        const at = this.selectionStart;

        this.value = this.#value.slice(0, at) + text + this.#value.slice(this.selectionEnd);
        this.caret(at + text.length);
    }

    caret(at: number) {
        this.setSelectionRange(at, at);
    }
}

/** Results as the browser sends them: each phrase heard, and whether it is settled. */
const said = (...phrases: [string, boolean][]): { results: Result[] } => ({
    results: phrases.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })),
});

/** Dictation started in a focused box holding `value`, with the caret at its end. */
function dictate(value = "", options?: { top?: boolean }) {
    const box = new Box(value);

    page.activeElement = box;
    const dictation = voice.useDictation({ current: box }, () => {}, options);

    dictation.toggle();
    const recognition = recognitions.at(-1)!;

    return { box, dictation, hear: (event: { results: Result[] }) => recognition.onresult!(event) };
}

/** The boxes made so far leave the page, as when their component unmounts. */
function unmountAll() {
    const cleanups = (globalThis as unknown as { voiceCleanups: (() => void)[] }).voiceCleanups;

    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
}

test("words heard show as they come, and a revision replaces them", () => {
    const { box, hear } = dictate();

    hear(said(["helo wor", false]));
    assert.equal(box.value, "Helo wor");
    hear(said(["hello world", true]));
    assert.equal(box.value, "Hello world");
    hear(said(["hello world", true], ["again", false]));
    assert.equal(box.value, "Hello world again");
    unmountAll();
});

test("a phrase still being heard finishes in place around what was typed after it", () => {
    const { box, hear } = dictate();

    hear(said(["please fix the lo", false]));
    assert.equal(box.value, "Please fix the lo");
    box.type("!");
    hear(said(["please fix the login bug", true]));
    assert.equal(box.value, "Please fix the login bug!");
    assert.equal(box.selectionStart, 25, "the caret stays after what was typed");

    // The next phrase goes where the caret is.
    hear(said(["please fix the login bug", true], ["and add a test", false]));
    assert.equal(box.value, "Please fix the login bug! And add a test");
    unmountAll();
});

test("the offline provider uses the same draft path and never falls back for that account", () => {
    const stock = recognitions.length;
    const local: Recognition[] = [];
    const Stock = world.SpeechRecognition as new () => Recognition & {
        abort: () => void;
        stop: () => void;
    };
    const remove = voice.registerDictationProvider(
        class extends Stock {
            constructor() {
                super();
                local.push(recognitions.pop()!);
            }
        },
    );
    const changes: string[] = [];
    const box = new Box("Draft:");
    const dictation = voice.useDictation({ current: box }, (text) => changes.push(text));

    preferences.set(voice.offlineVoiceKey(), "on");
    dictation.toggle();
    assert.equal(recognitions.length, stock);
    assert.equal(local.length, 1);
    local[0]!.onresult!(said(["hello", false]));
    dictation.stop();
    local[0]!.onresult!(said(["hello there", true]));
    assert.deepEqual(changes, ["Draft: hello", "Draft: hello there"]);

    remove();
    assert.equal(local[0]!.onresult, null);
    assert.equal(voice.voiceAvailable(), false);
    assert.equal(voice.toggleDictation(), false);
    assert.equal(recognitions.length, stock);
    preferences.delete(voice.offlineVoiceKey());
    unmountAll();
});

test("Alt+V goes to PiP; switching the target cancels a late final result", () => {
    const composer = new Box("Composer");
    const pip = new Box("PiP:");

    voice.useDictation({ current: composer }, () => {});
    voice.useDictation({ current: pip }, () => {}, { top: true });
    state.pipOpen = true;
    listeners.forEach((listener) => listener(state));
    assert.equal(voice.toggleDictation(), true);

    const recognition = recognitions.at(-1)!;
    const late = recognition.onresult!;

    late(said(["hello", false]));
    assert.equal(pip.value, "PiP: hello");
    assert.equal(composer.value, "Composer");
    assert.equal(voice.toggleDictation(), true);
    state.pipOpen = false;
    listeners.forEach((listener) => listener(state));
    late(said(["hello there", true]));
    assert.equal(pip.value, "PiP: hello");
    assert.equal(recognition.onresult, null);
    unmountAll();
});
