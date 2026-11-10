import { useEffect, useState } from "preact/hooks";
import { pipAvailable, quotePip } from "./pip.js";
import { rangeText } from "./quote-text.js";
import { notify, quoteReply, showsPip, store } from "./store.js";
import { prefs } from "./theme.js";
import { html, Icon } from "./ui.js";

/**
 * Reply on a passage selected in one of Pi's replies, in the file viewer, or in an artifact's page (`ArtifactViewer`, from
 * inside its frame): a pill over the selection puts it in the message box as a quote. A passage from a viewer keeps where
 * it came from (`source`), which Pi gets with the message, unseen by people (`about.quotes`).
 */

/** Which of the pill's buttons show: each has its own switch in Appearance, and PiP's orb needs PiP on. */
export const buttons = () => ({
    // Whoever cannot write to Pi has no message box to put the quote in.
    reply:
        prefs().quoteReply !== false &&
        Boolean(document.querySelector('[data-part="composer"] textarea')),
    // Never in PiP's own conversation (as a board, or opened as one): Reply already goes to PiP there.
    pip: prefs().askPipQuote !== false && pipAvailable() && !showsPip(),
});

const coarse = matchMedia("(pointer: coarse)").matches;
const REPLY_WIDTH = 84;
// The orb, and the line between it and Reply.
const PIP_WIDTH = 41;
const HEIGHT = 32;

/**
 * Where the pill goes for a selection whose first line is `first` and last is `last` (boxes in the window), inside
 * `view` (`{ top, bottom }`): `{ top, left }`, or null when it would leave the view.
 */
export function placePill(first, last, view, shown) {
    const above = first.top - HEIGHT - 8;
    // On a touch screen the system's selection handle hangs under the last line: sit below it.
    const under = last.bottom + (coarse ? 26 : 8);
    let below = coarse || above < view.top;
    let top = below ? under : above;

    if (below && top + HEIGHT > view.bottom) {
        below = false;
        top = above;
    }

    if (top < view.top || top + HEIGHT > view.bottom) {
        return null;
    }

    const anchor = below ? last.right : first.left;
    const width = (shown.reply ? REPLY_WIDTH : 0) + (shown.pip ? PIP_WIDTH : 0);
    const left = Math.max(8, Math.min(anchor - (below ? width : 0), innerWidth - width - 8));

    return { top, left };
}

/** What a file viewer quotes from: the file it shows (`data-quote-file` on `FileView`). */
const QUOTABLE = ".reply, [data-quote-file]";

function selected() {
    const selection = getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const within = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(QUOTABLE);
    // A triple-click can end the range at the start of the next block: that end does not count.
    const end =
        range.endOffset === 0 && range.endContainer !== range.startContainer
            ? range.commonAncestorContainer
            : range.endContainer;
    const from = within(range.startContainer);
    const to = within(end) ?? (within(range.commonAncestorContainer) ? from : null);

    const path = from?.dataset.quoteFile;
    const source = path ? { file: path } : undefined;
    // PiP is told which session a passage came from, not which file: a file's passage is for Reply alone.
    const shown = source ? { ...buttons(), pip: false } : buttons();

    if (!from || from !== to || (!shown.reply && !shown.pip)) {
        return null;
    }

    const text = rangeText(range).trim();

    if (text === "") {
        return null;
    }

    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);

    if (rects.length === 0) {
        return null;
    }

    // The button must stay inside the scrolling area, not over the top bar or the message box.
    const view = from.closest(".scroller, .sheet-body")?.getBoundingClientRect() ?? {
        top: 0,
        bottom: visualViewport?.height ?? innerHeight,
    };
    const place = placePill(rects[0], rects[rects.length - 1], view, shown);

    return place && { text, ...place, shown, ...(source ? { source } : {}) };
}

/**
 * Put `text` in the message box as a quote from `source` (none: one of Pi's replies). From a viewer that covers the box,
 * a notice says where it went, and tapping it closes the viewer.
 */
export function replyWith(text, source, { covered = false } = {}) {
    quoteReply(text, source);

    if (covered) {
        notify("info", "Quoted in your message box. Tap to go there.", () =>
            store.set({ sheet: null }),
        );
    } else if (!coarse) {
        requestAnimationFrame(() =>
            document.querySelector('[data-part="composer"] textarea')?.focus(),
        );
    }
}

/**
 * The pill itself, at `at` (`{ top, left, shown }`): Reply, and PiP's orb. `keep` stops a press from taking the
 * selection away before the click reads it.
 */
export function QuotePill({ at, onReply, onPip }) {
    const keep = (event) => event.preventDefault();

    return html`<div
        class="quote-reply-button"
        data-part="quote-reply-button"
        style=${`top:${at.top}px;left:${at.left}px`}
        onPointerDown=${keep}
        onMouseDown=${keep}
    >
        ${
            at.shown.reply &&
            html`<button type="button" class="quote-reply-action" onClick=${onReply}>
                <${Icon} name="reply" size=${14} stroke=${2} />
                <span>Reply</span>
            </button>`
        }
        ${
            at.shown.pip &&
            html`<button
                type="button"
                class="quote-reply-action quote-reply-pip"
                aria-label="Ask PiP"
                title="Ask PiP"
                onClick=${onPip}
            >
                <${Icon} name="pip" size=${16} />
            </button>`
        }
    </div>`;
}

export function QuoteReplyButton() {
    const [at, setAt] = useState(null);

    useEffect(() => {
        let timer = 0;

        const look = () => {
            clearTimeout(timer);
            // Dragging a handle changes the selection all the time: show the button once it holds still.
            timer = setTimeout(() => setAt(selected()), 160);
        };

        // Appearance's switches and PiP turned on or off change which buttons show: measured again, at once.
        let was = buttons();
        const unsubscribe = store.subscribe(() => {
            const now = buttons();

            if (now.reply !== was.reply || now.pip !== was.pip) {
                was = now;
                setAt(selected());
            }
        });

        document.addEventListener("selectionchange", look);
        addEventListener("scroll", look, true);
        addEventListener("resize", look);

        return () => {
            clearTimeout(timer);
            unsubscribe();
            document.removeEventListener("selectionchange", look);
            removeEventListener("scroll", look, true);
            removeEventListener("resize", look);
        };
    }, []);

    if (!at) {
        return null;
    }

    const done = () => {
        getSelection()?.removeAllRanges();
        setAt(null);
    };

    const reply = () => {
        if (!buttons().reply) {
            return done();
        }

        // A file viewer in a sheet covers the box; in the Files panel, the box shows beside it.
        const covered = Boolean(at.source && store.state.sheet);

        done();
        replyWith(at.text, at.source, { covered });
    };

    // The passage goes over PiP's box as a quote instead, with the session it came from (unless that is PiP's own).
    const askPip = () => {
        if (!buttons().pip) {
            return done();
        }

        const text = at.text;
        const { conversationId, sessions } = store.state;
        // Only a session of the list (never a subagent's conversation, nor PiP's own) is named: PiP can read it.
        const session = sessions.some((each) => each.id === conversationId)
            ? conversationId
            : undefined;

        done();
        quotePip(text, session);
    };

    return html`<${QuotePill} at=${at} onReply=${reply} onPip=${askPip} />`;
}
