// What tapping a message opens, in the copy sheet's layout (`copy.js`). Pi's reply: fork from it, to a computer, folder,
// and model of your choice; remember it; copy it. Your message: edit it at once and send it again in a new session,
// placed the same way; undo it when it is the last one; copy it. Each sheet offers only the action of what was tapped.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { updateDraft } from "../copy-draft.js";
import {
    actions,
    attempt,
    canStart,
    canSteer,
    closeSheet,
    insertIntoComposer,
    navigate,
    notify,
    openSheet,
    store,
} from "../store.js";
import { copyText, html, replyText, Sheet, writtenText } from "../ui.js";
import {
    choosePresentationMode,
    onPresentationMode,
    PRESENTATION_MODES,
    presentationMode,
    resendable,
} from "../entry-presentation.js";
import {
    CopyAction,
    copyReady,
    PlaceRows,
    placeOf,
    readyDraft,
    startCopy,
    useMainKey,
    usePlace,
} from "./copy.js";
import { KeepWarmCard } from "./keep-warm.js";
import { memoryAvailable } from "./memory.js";

/** What each mode is called where a person chooses it. */
const MODE_NAMES = { open: "Show", folded: "Fold", hidden: "Hide" };

/**
 * How this browser shows inputs of one kind a module presents: as messages, folded to a line, or hidden until Find.
 * It changes every row of that kind in this browser.
 */
function PresentationChoice({ presentation }) {
    const kind = presentation.entryKind;
    const [mode, setMode] = useState(() => presentationMode(kind));

    useEffect(
        () =>
            onPresentationMode((changed, next) => {
                if (changed === kind) {
                    setMode(next);
                }
            }),
        [kind],
    );

    return html`<div class="setting wrap presented-choice" data-part="presented-choice">
        <div class="grow">
            <div class="small">Show inputs like this</div>
            <div class="muted small">
                Every “${presentation.label}” in this browser. Pi still reads them in full.
            </div>
        </div>
        <div class="segmented" role="group" aria-label=${`Show “${presentation.label}” inputs`}>
            ${PRESENTATION_MODES.map(
                (value) => html`<button
                    type="button"
                    class=${mode === value ? "on" : ""}
                    aria-pressed=${mode === value ? "true" : "false"}
                    onClick=${() => attempt(async () => choosePresentationMode(kind, value))}
                >
                    ${MODE_NAMES[value]}
                </button>`,
            )}
        </div>
    </div>`;
}

/** A message as the start of a lesson: one line, cut to a lesson's length. */
function lessonFrom(text) {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** The newest prompt, even if Pi's replies or a note came after it. */
function newestPrompt(view, history) {
    // Only pi.user entries project to user rows in this view.
    return (
        view.order.findLast((id) => view.entries.get(id)?.kind === "user") ??
        history?.findLast((entry) => entry.kind === "user")?.id
    );
}

/**
 * Whether Pi's answer to the newest prompt failed: its last reply after `entryId` ended in an error (the request did
 * not go through), or the run failed. Undo then reads as Retry: the same action, named for what the person wants.
 */
function answerFailed(view, entryId) {
    const at = view.order.indexOf(entryId);

    if (at === -1) {
        return false;
    }

    const reply = view.order
        .slice(at + 1)
        .map((id) => view.entries.get(id))
        .findLast((each) => each?.kind === "assistant");

    // A run can also fail with no answer that says so (its compaction failed, say): the session's row says it, and
    // the conversation shows its "Run failed" line.
    return (
        reply?.stopReason === "error" ||
        store.state.sessions.some(
            (each) => each.id === view.conversation.id && each.failed === true,
        )
    );
}

/** An undo on its way: a second tap waits for it. */
let undoing = false;

/**
 * Open a copy of the session without its last message `entryId`, archive the session, and put the message back in the
 * box. A second tap while the first is on its way does nothing.
 */
const undo = (entryId, retry = false) => {
    if (undoing) {
        return;
    }

    undoing = true;
    attempt(async () => {
        const { id, text, attachments, attachmentsOmitted } = await actions.undo(entryId);

        navigate(id);
        insertIntoComposer(text, [], { attachments });
        notify(
            "info",
            retry
                ? "Your message is back in the box to send again. The original is archived."
                : "Undid your last message. The original is archived.",
        );

        if (attachmentsOmitted) {
            notify("warning", "Some attachments could not be restored.");
        }
    }).finally(() => {
        undoing = false;
    });
};

/** A small action under the main button: a link-like button with an optional hint. */
const Minor = ({ label, hint, run }) => html`<button
    type="button"
    class="copy-minor"
    aria-label=${label}
    title=${hint}
    onClick=${run}
>
    <span>${label}</span>
    ${hint && html`<span class="copy-minor-hint">${hint}</span>`}
</button>`;

/** Copy `text` and close the sheet. */
const copyAndClose = (text) => {
    closeSheet();
    copyText(text).then(
        () => notify("info", "Copied."),
        () => notify("error", "Could not copy."),
    );
};

/** What can be done with one message: Pi's reply (`ReplySheet`), or a message to Pi (`OwnMessageSheet`). */
export function MessageSheet({ entryId }) {
    const { view } = store.state;
    const entry =
        view.entries.get(entryId) ?? store.state.history?.find((each) => each.id === entryId);
    // A presented input the view clipped: its whole text, for Copy, Remember, and sending again.
    const [whole, setWhole] = useState(undefined);
    const clipped = entry?.kind === "user" && entry.presentation?.clipped !== undefined;

    useEffect(() => {
        if (!clipped) {
            return;
        }

        let gone = false;

        actions.fullEntry(entryId).then(
            (full) => {
                if (!gone && full?.kind === "user") {
                    setWhole(writtenText(full));
                }
            },
            () => {},
        );

        return () => {
            gone = true;
        };
    }, [entryId, clipped]);

    if (entry?.kind !== "user" && entry?.kind !== "assistant") {
        return html`<${Sheet} title="Message" onClose=${closeSheet}>
            <p class="muted">This message is not here anymore.</p>
        <//>`;
    }

    // Only sessions have copies. The place rows decide where this person may start one.
    const canBranch = view.conversation?.kind === "session";

    if (entry.kind === "assistant") {
        return html`<${ReplySheet} entry=${entry} canBranch=${canBranch} />`;
    }

    return html`<${OwnMessageSheet}
        entry=${entry}
        canBranch=${canBranch}
        text=${whole ?? writtenText(entry)}
        waiting=${clipped && whole === undefined}
    />`;
}

/** Pi's reply: a short preview, fork from here with its place rows, then Remember and Copy. */
function ReplySheet({ entry, canBranch }) {
    const { view } = store.state;
    const sessionId = view.conversation.id;
    const text = replyText(entry);
    const empty = text.trim() === "";
    const { draft, choices } = usePlace(sessionId, `reply:${sessionId}:${entry.id}`, {
        enabled: canBranch,
    });
    const [busy, setBusy] = useState(false);
    const go = useCallback(() => {
        const now = readyDraft(draft);

        if (!canBranch || busy || !now) {
            return;
        }

        setBusy(true);
        startCopy(
            (signal) => actions.fork(entry.id, { place: placeOf(now) }, signal),
            "Opened the fork. The original is unchanged.",
        ).finally(() => setBusy(false));
    }, [canBranch, busy, draft, entry.id]);

    useMainKey("message", go);

    return html`<${Sheet} title="Reply" onClose=${closeSheet} className="copy-sheet">
        <div class="copy-what copy-preview">${empty ? "(no text)" : text}</div>
        ${
            canBranch &&
            html`<${PlaceRows} sessionId=${sessionId} draft=${draft} choices=${choices} verb="Fork" />
                <${CopyAction}
                    label="Fork from here"
                    choices=${choices}
                    disabled=${busy || !copyReady(draft)}
                    onClick=${go}
                >
                    A new session with everything up to this reply. The original stays as it is.
                <//>`
        }
        <div class="copy-minors">
            ${
                memoryAvailable() &&
                canSteer() &&
                !empty &&
                html`<${Minor}
                    label="Remember…"
                    hint="Opens Memory with this reply as a draft lesson"
                    run=${() => openSheet({ type: "memory", draft: lessonFrom(text) })}
                />`
            }
            ${!empty && html`<${Minor} label="Copy text" hint="As Markdown" run=${() => copyAndClose(text)} />`}
            <${KeepWarmCard} />
        </div>
    <//>`;
}

/**
 * A message to Pi: its text, editable at once, send it again in a new session with its place rows, then Copy. An input
 * a module stored as its own kind is shown and copied, never sent again.
 */
function OwnMessageSheet({ entry, canBranch, text, waiting }) {
    const { view } = store.state;
    const sessionId = view.conversation.id;
    const again = canBranch && resendable(entry) && !waiting;
    // The last message to Pi, once Pi is idle and the queue is empty, in a session on this server.
    const canUndo =
        again &&
        canStart() &&
        view.conversation.runner === undefined &&
        !view.live.busy &&
        !view.live.compactions?.length &&
        view.inbox.length === 0 &&
        newestPrompt(view, store.state.history) === entry.id;
    const retry = canUndo && answerFailed(view, entry.id);
    // A message of files alone has no words: there is nothing to copy.
    const filesAlone = text.trim() === "";
    const { draft, choices } = usePlace(sessionId, `message:${sessionId}:${entry.id}`, {
        enabled: again,
        extra: () => ({ text: null }),
    });
    // The text as the person has it now: the original until they type (or until its whole text comes).
    const written = draft.text ?? text;
    const edited = draft.text !== null && draft.text !== text;
    const [busy, setBusy] = useState(false);
    const field = useRef(null);
    const go = useCallback(() => {
        const now = readyDraft(draft);
        const outgoing = now?.text ?? text;

        if (!again || busy || !now || outgoing.trim() === "") {
            return;
        }

        setBusy(true);
        startCopy(
            (signal) =>
                actions.resend(
                    entry.id,
                    {
                        ...(outgoing === text ? {} : { text: outgoing }),
                        place: placeOf(now),
                    },
                    signal,
                ),
            "Opened the new session. The original is unchanged.",
        ).finally(() => setBusy(false));
    }, [again, busy, draft, entry.id, text]);

    useMainKey("message", go);

    return html`<${Sheet} title="Your message" onClose=${closeSheet} className="copy-sheet">
        ${
            again && choices.length > 0
                ? html`<textarea
                      ref=${field}
                      class="copy-text"
                      rows="5"
                      aria-label="Your message"
                      placeholder=${filesAlone ? "(attachments only)" : ""}
                      value=${written}
                      onInput=${(event) => updateDraft({ text: event.currentTarget.value })}
                  ></textarea>`
                : html`<div class="copy-what copy-preview">
                      ${filesAlone ? "(attachments)" : waiting ? "…" : text}
                  </div>`
        }
        ${entry.presentation && html`<${PresentationChoice} presentation=${entry.presentation} />`}
        ${
            again &&
            html`<${PlaceRows} sessionId=${sessionId} draft=${draft} choices=${choices} verb="Send again" />
                <${CopyAction}
                    label=${edited ? "Send edited in a new session" : "Send again in a new session"}
                    choices=${choices}
                    disabled=${busy || !copyReady(draft) || written.trim() === ""}
                    onClick=${go}
                >
                    Pi gets ${edited ? "the edited" : "this"} message in a new session that forks just before the
                    original. The original stays as it is.
                <//>`
        }
        <div class="copy-minors">
            ${
                canUndo &&
                html`<${Minor}
                    label=${retry ? "Retry" : "Undo"}
                    hint=${retry ? "Unsend and try again" : "Unsend and edit"}
                    run=${() => undo(entry.id, retry)}
                />`
            }
            ${!filesAlone && !waiting && html`<${Minor} label="Copy text" hint="As written" run=${() => copyAndClose(text)} />`}
        </div>
    <//>`;
}
