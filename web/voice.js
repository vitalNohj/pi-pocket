// Dictation into a message box. Results use the ordinary draft path, never Send. Without an offline provider or
// preference, use Web Speech where supplied (which may send the audio to the browser vendor).
import { useEffect, useRef, useState } from "preact/hooks";
import { notify, store } from "./store.js";
import { html, Icon } from "./ui.js";

let offlineProvider = null;
const providerChanges = new Set();

/** This person's device choice survives an extension reload or disable. Never silently fall back to Web Speech. */
export function offlineVoiceKey() {
    const id = store.state.me?.id;

    return id === undefined ? null : `x.dictation.offline.${encodeURIComponent(id)}`;
}

function Recognizer() {
    const key = offlineVoiceKey();

    if (offlineProvider && offlineProvider.key === key) {
        return offlineProvider.Recognition;
    }

    try {
        if (key && localStorage.getItem(key) === "on") {
            return undefined;
        }
    } catch {
        // Storage is not available in this profile.
    }

    return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
}

/** A first-party extension supplies a Web Speech-shaped local recognizer. Removal cancels its outstanding results. */
export function registerDictationProvider(Recognition) {
    const entry = { Recognition, key: offlineVoiceKey() };

    current?.stop(true);
    offlineProvider = entry;
    providerChanges.forEach((changed) => changed());

    return () => {
        if (offlineProvider === entry) {
            current?.stop(true);
            offlineProvider = null;
            providerChanges.forEach((changed) => changed());
        }
    };
}

/** HTTPS and trusted loopback are the only contexts browsers give a microphone. */
export const voiceAvailable = () =>
    globalThis.isSecureContext !== false && typeof Recognizer() === "function";

/** What each of the recognizer's errors means for the person; those not here are named as they are. */
const ERRORS = {
    "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
    "service-not-allowed": "This browser does not allow dictation here.",
    "no-speech": "No speech heard. Tap the mic and try again.",
    "audio-capture": "No microphone found.",
    network: "Dictation needs the network: the browser recognises speech on its own servers.",
    "language-not-supported": "This browser cannot recognise your language.",
};

/** The dictation that listens now: one at a time, in the whole app. */
let current = null;
/**
 * The boxes that can dictate, newest last. The shortcut (Alt+V) dictates into PiP's while it shows (its box is `top`),
 * else into the newest in the page: one gone for now (view only, someone else's turn) is passed over.
 */
const boxes = [];

/** Alt+V: start or stop dictation in PiP's box or the newest; false when no box can. */
export function toggleDictation() {
    const shown = (each) => each.box.current?.isConnected === true;
    const top = boxes.findLast((each) => each.top && shown(each));
    const box = top ?? (store.state.pipOpen ? undefined : boxes.findLast(shown));

    return voiceAvailable() && (box?.toggle() ?? false);
}

/**
 * How long the starts of `a` and `b` agree, and their ends, each on its own: an edit that repeats what is beside it
 * ("H" typed before "Hello") fits both ways, and either way it is outside what agrees.
 */
function common(a, b) {
    let head = 0;

    while (head < a.length && head < b.length && a[head] === b[head]) {
        head++;
    }

    let tail = 0;

    while (
        tail < a.length &&
        tail < b.length &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail++;
    }

    return { head, tail };
}

/** Words heard, put between what the box has before and after them, with a space where words would touch. */
function join(before, words, after) {
    if (words === "") {
        return { value: before + after, at: before.length };
    }

    const start = /\S$/.test(before) ? " " : "";
    const end = /^[^\s.,;:!?)]/.test(after) ? " " : "";
    // A sentence's first word starts with a capital, as the browser leaves some in lower case.
    const capital = before.trim() === "" || /[.!?]\s*$/.test(before);
    const said = capital ? words[0].toUpperCase() + words.slice(1) : words;
    const head = before + start + said;

    return { value: head + end + after, at: head.length };
}

/**
 * Dictation into a textarea (`box`, a ref). `onText(value, caret)` hears each change, as typing does, so the box's own
 * draft saving keeps it. Words go in at the caret while the box has the focus, and after its text when it does not.
 * Returns whether it listens, and `toggle` and `stop` (`stop(true)` drops words not yet settled: for sending, leaving).
 * `top` marks PiP's box, which takes Alt+V while it shows. `place(value, start, end)` may move where words go from the
 * selection `start`..`end`: it gives back `{ text, start, end }` (the text may change, a line added for them), or null
 * to leave them there (the session's box keeps them out of a quote).
 */
export function useDictation(box, onText, { top = false, place = null } = {}) {
    const [listening, setListening] = useState(false);
    const hear = useRef(onText);
    const where = useRef(place);
    const self = useRef(null);

    hear.current = onText;
    where.current = place;

    if (self.current === null) {
        self.current = {
            box,
            top,
            recognition: null,
            finishing: false,
            guard: null,
            clear() {
                this.guard?.disconnect();
                this.guard = null;
                this.recognition = null;
                this.finishing = false;
                setListening(false);

                if (current === this) {
                    current = null;
                }
            },
            /** Stop capture, optionally discarding any late results. A normal stop can still deliver a final result. */
            stop(drop = false) {
                const recognition = this.recognition;

                if (!recognition) {
                    return false;
                }

                if (drop) {
                    this.clear();
                    recognition.onresult = recognition.onerror = recognition.onend = null;
                    recognition.abort();
                } else if (!this.finishing) {
                    this.finishing = true;
                    setListening(false);
                    recognition.stop();
                }

                return true;
            },
            start() {
                const element = box.current;
                const Recognition = Recognizer();

                const { me, conversationId, pipOpen } = store.state;
                const canHear = () =>
                    box.current === element &&
                    element?.isConnected &&
                    !element.readOnly &&
                    !element.disabled &&
                    !document.hidden &&
                    store.state.me?.id === me?.id &&
                    store.state.conversationId === conversationId &&
                    store.state.pipOpen === pipOpen;

                if (!canHear() || typeof Recognition !== "function" || !voiceAvailable()) {
                    return false;
                }

                current?.stop(true);

                const recognition = new Recognition();

                current = this;

                recognition.lang = navigator.language || "en-US";
                recognition.continuous = true;
                recognition.interimResults = true;
                this.recognition = recognition;

                // What the box had around the words, the results already in it, and the box as dictation left it: its
                // text and its selection. `pending` is the first result not settled yet, and `span` where its words are.
                let base = null;
                let from = 0;
                let seen = 0;
                let written = "";
                let selection = [0, 0];
                let pending = 0;
                let span = [0, 0];
                // The person moved on while words were still coming: those finish where they are, then words go where
                // the person is.
                let moving = false;

                const focused = () => document.activeElement === element;
                const selected = () => [element.selectionStart, element.selectionEnd];

                const rebase = () => {
                    const at = focused() ? element.selectionStart : element.value.length;
                    const end = focused() ? element.selectionEnd : at;
                    const placed = where.current?.(element.value, at, end) ?? {
                        text: element.value,
                        start: at,
                        end,
                    };

                    base = {
                        before: placed.text.slice(0, placed.start),
                        after: placed.text.slice(placed.end),
                    };
                    from = seen;
                    moving = false;
                };

                rebase();
                written = element.value;
                selection = selected();

                /**
                 * Typed into, or the caret moved, since the words last went in. Outside the words still coming, those
                 * finish where they are, around what the person did; on them, the person's edit wins, and what is heard
                 * next goes where the caret is.
                 */
                const changed = () => {
                    const value = element.value;
                    const [s, e] = span;
                    const { head, tail } = common(written, value);
                    // Where the edit was in what dictation wrote: after the words coming (they are in the start that
                    // agrees), or before them (in the end that agrees).
                    const after = value === written || head >= e;
                    const before = !after && written.length - tail <= s;

                    if (pending >= seen || !(after || before)) {
                        rebase();

                        return;
                    }

                    const shift = before ? value.length - written.length : 0;

                    base = { before: value.slice(0, s + shift), after: value.slice(e + shift) };
                    from = pending;
                    moving = true;
                };

                recognition.onresult = (event) => {
                    if (this.recognition !== recognition) {
                        return;
                    }

                    if (!canHear()) {
                        this.stop(true);

                        return;
                    }

                    const results = event.results;

                    if (
                        element.value !== written ||
                        (focused() && selected().some((at, index) => at !== selection[index]))
                    ) {
                        changed();
                    }

                    // What is settled, then what may still change, from the first result not settled on.
                    let first = from;

                    while (first < results.length && results[first].isFinal) {
                        first++;
                    }

                    const said = (start, end) => {
                        const words = [];

                        for (let index = start; index < end; index++) {
                            words.push(results[index][0].transcript.trim());
                        }

                        return words.filter(Boolean).join(" ");
                    };

                    const settled = said(from, first);
                    const coming = said(first, results.length);
                    const all = [settled, coming].filter(Boolean).join(" ");
                    const { value, at } = join(base.before, all, base.after);
                    // Where the words still coming start: after the settled ones and a space, or where all start.
                    const start =
                        settled === ""
                            ? base.before.length + (all !== "" && /\S$/.test(base.before) ? 1 : 0)
                            : join(base.before, settled, base.after).at + (coming === "" ? 0 : 1);
                    // Where the text after the words ends up: the person's selection there moves with it.
                    const was = element.value.length - base.after.length;
                    const now = value.length - base.after.length;
                    const person = selected();

                    seen = results.length;
                    pending = first;
                    span = [start, at];
                    written = value;
                    element.value = value;

                    if (focused()) {
                        const place = (point) =>
                            point >= was ? point + now - was : Math.min(point, now);

                        if (moving) {
                            element.setSelectionRange(place(person[0]), place(person[1]));
                        } else {
                            element.setSelectionRange(at, at);
                        }
                    }

                    selection = selected();
                    hear.current(value, moving ? selection[1] : at);

                    // The words left behind are all settled: what comes next goes where the person is.
                    if (moving && first === results.length) {
                        rebase();
                    }
                };

                recognition.onerror = (event) => {
                    // Aborted is this app's own doing; no speech for a while ends a quiet dictation, said once.
                    if (event.error !== "aborted") {
                        const level = event.error === "no-speech" ? "info" : "error";

                        notify(
                            level,
                            ERRORS[event.error] ??
                                event.message ??
                                `Dictation stopped: ${event.error}.`,
                        );
                    }
                };

                recognition.onend = () => {
                    if (this.recognition === recognition) {
                        this.clear();
                    }
                };

                try {
                    if (typeof MutationObserver === "function") {
                        this.guard = new MutationObserver(() => {
                            if (!canHear()) {
                                this.stop(true);
                            }
                        });
                        this.guard.observe(element, {
                            attributes: true,
                            attributeFilter: ["readonly", "disabled"],
                        });
                    }

                    setListening(true);
                    recognition.start();

                    return true;
                } catch (error) {
                    this.stop(true);
                    notify("error", `Dictation did not start: ${error.message ?? error}`);

                    return false;
                }
            },
            toggle() {
                return this.recognition && !this.finishing ? this.stop() : this.start();
            },
        };
    }

    const dictation = self.current;

    // The newest box takes the shortcut while it shows; leaving it ends dictation, as does the tab going out of sight.
    useEffect(() => {
        const cancel = () => dictation.stop(true);
        const hidden = () => document.hidden && cancel();

        const escape = (event) => {
            if (event.key === "Escape" && !event.isComposing && dictation.recognition) {
                event.preventDefault();
                event.stopPropagation();
                cancel();
            }
        };

        let { me, conversationId, pipOpen } = store.state;
        const unsubscribe = store.subscribe((state) => {
            if (
                state.me?.id !== me?.id ||
                state.conversationId !== conversationId ||
                state.pipOpen !== pipOpen
            ) {
                ({ me, conversationId, pipOpen } = state);
                cancel();
            }
        });

        boxes.push(dictation);
        document.addEventListener("visibilitychange", hidden);
        document.defaultView?.addEventListener("pagehide", cancel);
        document.addEventListener("keydown", escape, true);

        return () => {
            boxes.splice(boxes.indexOf(dictation), 1);
            unsubscribe();
            document.removeEventListener("visibilitychange", hidden);
            document.defaultView?.removeEventListener("pagehide", cancel);
            document.removeEventListener("keydown", escape, true);
            cancel();
        };
    }, []);

    return {
        listening,
        toggle: () => dictation.toggle(),
        stop: (drop) => dictation.stop(drop),
    };
}

/** The mic: starts dictation, and while it listens, stops it. None where the browser cannot recognise speech. */
export function MicButton({ dictation, class: className = "", size = 17, part, disabled = false }) {
    const [, redraw] = useState(0);

    useEffect(() => {
        const changed = () => redraw((v) => v + 1);

        providerChanges.add(changed);
        changed();

        return () => providerChanges.delete(changed);
    }, []);

    if (!voiceAvailable()) {
        return null;
    }

    const { listening, toggle } = dictation;

    return html`<button
        type="button"
        class=${`icon-button mic-button ${listening ? "listening" : ""} ${className}`}
        data-part=${part}
        aria-label="Dictate"
        aria-pressed=${listening ? "true" : "false"}
        title=${listening ? "Listening: tap to stop (Alt+V)" : "Dictate (Alt+V)"}
        disabled=${disabled}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${toggle}
    >
        <${Icon} name="mic" size=${size} />
    </button>`;
}
