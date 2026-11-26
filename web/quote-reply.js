import { useEffect, useRef, useState } from "preact/hooks";
import { mentionText } from "./files.js";
import { setFilesOpen } from "./files-panel.js";
import { pipAvailable, quotePip } from "./pip.js";
import { rangeText } from "./quote-text.js";
import { closeSheet, panelsBeside, quoteReply, showsPip, store } from "./store.js";
import { prefs } from "./theme.js";
import { html, Icon } from "./ui.js";

/** Which of the pill's buttons show: each has its own switch in Appearance, and PiP's orb needs PiP on. */
const buttons = () => ({
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
const FILE_TEXT = ".file-viewer > :is(.md, .file-view)";

const visible = (from) => from.isConnected && !from.closest("[inert], [hidden]");

/** The artifact viewer passes only selections checked by its bridge. The app owns the pill and its actions. */
export function reportFrameSelection(frame, { text, rect }, source) {
    dispatchEvent(
        new CustomEvent("pocket:quote-selection", { detail: { frame, text, rect, source } }),
    );
}

function selected() {
    const selection = getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);

    const within = (node) => {
        const el = node.nodeType === 1 ? node : node.parentElement;

        return el?.closest(".file-view .ln") ? null : el?.closest(`.reply, ${FILE_TEXT}`);
    };

    // A triple-click can end the range at the start of the next block: that end does not count.
    const end =
        range.endOffset === 0 && range.endContainer !== range.startContainer
            ? range.commonAncestorContainer
            : range.endContainer;
    const from = within(range.startContainer);
    const to = within(end) ?? (within(range.commonAncestorContainer) ? from : null);

    if (!from || from !== to || !visible(from)) {
        return null;
    }

    const file = from.matches(FILE_TEXT);
    const text = rangeText(range, { omitLineNumbers: file }).trim();

    if (text === "") {
        return null;
    }

    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);

    if (rects.length === 0) {
        return null;
    }

    const scroll = from.closest(".scroller, .sheet-body, .ft-view");
    let view = scroll?.getBoundingClientRect();

    // In the tile the file can scroll under its own sticky header.
    if (file && scroll?.matches(".ft-view")) {
        view = {
            left: view.left,
            right: view.right,
            top: Math.max(view.top, scroll.firstElementChild.getBoundingClientRect().bottom),
            bottom: view.bottom,
        };
    }

    const path = file ? from.parentElement.dataset.quoteFile : undefined;
    const source = path && {
        label: path.split("/").at(-1),
        line: `From ${mentionText(path.replaceAll("\r", "\\r").replaceAll("\n", "\\n"))}:`,
    };

    return { from, file, text, source, first: rects[0], last: rects.at(-1), view };
}

/** A frame's rectangle is relative to its own viewport, not the app's. */
function framed({ frame, text, rect, source }) {
    if (!visible(frame)) {
        return null;
    }

    const view = frame.getBoundingClientRect();
    const first = { left: view.left + rect.x, top: view.top + rect.y };
    const last = { right: first.left + rect.width, bottom: first.top + rect.height };

    return { from: frame, frame, text, source, first, last, view };
}

function place(passage, shown, session) {
    if (!passage) {
        return null;
    }

    const { first, last, view, file, frame } = passage;
    const topEdge = Math.max(0, view?.top ?? 0);
    const bottomEdge = Math.min(view?.bottom ?? innerHeight, visualViewport?.height ?? innerHeight);
    // The button stays inside the scroll box, not over its top bar or the message box.
    const above = first.top - HEIGHT - 8;
    // On a touch screen the system's selection handle hangs under the last line: sit below it.
    const under = last.bottom + (coarse ? 26 : 8);
    let below = coarse || above < topEdge;
    let top = below ? under : above;

    if (below && top + HEIGHT > bottomEdge) {
        below = false;
        top = above;
    }

    if (
        top < topEdge ||
        top + HEIGHT > bottomEdge ||
        last.bottom < topEdge ||
        first.top > bottomEdge
    ) {
        return null;
    }

    const anchor = below ? last.right : first.left;
    const width = (shown.reply ? REPLY_WIDTH : 0) + (shown.pip ? PIP_WIDTH : 0);
    const leftEdge = Math.max(0, file || frame ? (view?.left ?? 0) : 0) + 8;
    const rightEdge =
        Math.min(innerWidth, file || frame ? (view?.right ?? innerWidth) : innerWidth) - 8;
    const left = Math.max(leftEdge, Math.min(anchor - (below ? width : 0), rightEdge - width));

    return { ...passage, top, left, shown, session };
}

export function QuoteReplyButton() {
    const [at, setAt] = useState(null);
    const page = useRef(null);

    useEffect(() => {
        let timer = 0;
        let { conversationId, sheet } = store.state;

        const measure = () => {
            const shown = buttons();

            if (!shown.reply && !shown.pip) {
                setAt(null);

                return;
            }

            const passage = page.current ? framed(page.current) : selected();

            setAt(place(passage, shown, store.state.conversationId));
        };

        const look = () => {
            clearTimeout(timer);
            // Dragging a handle changes the selection all the time: show the button once it holds still.
            timer = setTimeout(measure, 160);
        };

        const fromFrame = ({ detail }) => {
            page.current = detail.rect ? detail : null;
            clearTimeout(timer);
            measure();
        };

        // Appearance's switches and PiP turned on or off change which buttons show: measured again, at once.
        let was = buttons();
        const unsubscribe = store.subscribe((state) => {
            if (state.conversationId !== conversationId || state.sheet !== sheet) {
                const leaving = page.current || state.conversationId !== conversationId;

                conversationId = state.conversationId;
                sheet = state.sheet;
                page.current = null;

                if (leaving) {
                    clearTimeout(timer);
                    setAt(null);
                }
            }

            const now = buttons();

            if (now.reply !== was.reply || now.pip !== was.pip) {
                was = now;
                measure();
            }
        });

        document.addEventListener("selectionchange", look);
        addEventListener("pocket:quote-selection", fromFrame);
        addEventListener("scroll", look, true);
        addEventListener("resize", look);

        return () => {
            clearTimeout(timer);
            unsubscribe();
            document.removeEventListener("selectionchange", look);
            removeEventListener("pocket:quote-selection", fromFrame);
            removeEventListener("scroll", look, true);
            removeEventListener("resize", look);
        };
    }, []);

    const stillHere = () => at && at.session === store.state.conversationId && visible(at.from);

    if (!stillHere()) {
        return null;
    }

    const done = () => {
        page.current = null;
        getSelection()?.removeAllRanges();
        setAt(null);
    };

    // A sheet covers both boxes. The Files tile covers the session's box only on a narrow screen.
    const uncover = (replying) => {
        if (at.frame || (at.file && at.from.closest(".sheet-host"))) {
            closeSheet();
        } else if (replying && at.file && !panelsBeside() && at.from.closest(".files-tile")) {
            setFilesOpen(false);
        }
    };

    const reply = () => {
        if (!stillHere() || !buttons().reply) {
            return done();
        }

        quoteReply(at.text, at.source);
        done();
        uncover(true);

        if (!coarse || (at.file && at.from.closest(".files-tile") && panelsBeside())) {
            requestAnimationFrame(() =>
                document.querySelector('[data-part="composer"] textarea')?.focus(),
            );
        }
    };

    // The passage goes over PiP's box as a quote instead, with the session it came from (unless that is PiP's own).
    const askPip = () => {
        if (!stillHere() || !buttons().pip) {
            return done();
        }

        const { text, source } = at;
        const { conversationId, sessions } = store.state;
        // Only a session of the list (never a subagent's conversation, nor PiP's own) is named: PiP can read it.
        const session = sessions.some((each) => each.id === conversationId)
            ? conversationId
            : undefined;

        done();
        uncover(false);
        quotePip(text, session, source);
    };

    // Pressing a button must not take the selection away before the click reads it.
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
            html`<button type="button" class="quote-reply-action" onClick=${reply}>
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
                onClick=${askPip}
            >
                <${Icon} name="pip" size=${16} />
            </button>`
        }
    </div>`;
}
