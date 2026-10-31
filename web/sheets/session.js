// A session's actions from its row in the session list: a sheet for a finger held on the row (touch screens cannot hover
// to show them), and a small menu at the pointer for a right-click.
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { sessionActions } from "../extension-ui.js";
import { deselectInList, selectedInList, selectFromList, setArchived } from "../sessions.js";
import {
    actions,
    attempt,
    canSteer,
    closeSheet,
    collab,
    isUnread,
    navigate,
    notify,
    scoped,
    setUnread,
    store,
} from "../store.js";
import { isPinned, movePin, togglePin } from "../theme.js";
import { copyText, html, item, scrimPress, Sheet } from "../ui.js";

/** The session's own address in the app. */
const linkOf = (id) => `${location.origin}/s/${id}`;

/** Copy `text`, and say so (or why not). */
const copy = (text, what) =>
    copyText(text).then(
        () => notify("info", `Copied the ${what}.`),
        () => notify("error", `Could not copy the ${what}.`),
    );

/** A fork on its way: a second click waits for it. */
let forking = false;

/** A new session with this one's whole history, opened once made. */
function fork(id) {
    if (forking) {
        return;
    }

    forking = true;
    attempt(async () => {
        const created = await actions.forkSession(id);

        navigate(created.id);
        notify("info", "Opened the fork. The original is unchanged.");
    }).finally(() => {
        forking = false;
    });
}

/** A new session in this one's folder, opened once made. */
const newIn = (cwd) =>
    attempt(async () => {
        const created = await actions.createSession(cwd);

        navigate(created.id);
    });

/**
 * What a session's row offers, in groups, the same in the sheet and the menu: `{ label, run, hint, opens }`. `run`
 * closes the sheet first unless it opens another (`opens`).
 */
function sessionItems(session) {
    const { id } = session;
    const steer = canSteer();
    // People invited to one session start none, and invite nobody.
    const starts = steer && !scoped();
    const pinned = !session.archived && isPinned(id);
    const pins = store.state.pinned.filter((each) =>
        store.state.sessions.some((one) => one.id === each && !one.archived),
    );

    return [
        [
            { label: "Open in new tab", run: () => window.open(linkOf(id), "_blank", "noopener") },
            { label: "Copy link", run: () => copy(linkOf(id), "link") },
            { label: "Copy folder path", run: () => copy(session.cwd, "folder path") },
        ],
        [
            steer && {
                label: "Rename",
                opens: true,
                run: () => store.set({ sheet: { type: "rename", id } }),
            },
            starts && { label: "Fork", hint: "up to the last reply", run: () => fork(id) },
            starts && { label: "New session in this folder", run: () => newIn(session.cwd) },
            starts &&
                collab() && {
                    label: "Share",
                    hint: "invite someone",
                    opens: true,
                    run: () => store.set({ sheet: { type: "invite", session: id } }),
                },
        ],
        [
            !session.archived && {
                label: pinned ? "Unpin from the top" : "Pin to the top",
                hint: "this browser",
                run: () => togglePin(id),
            },
            pinned &&
                pins[0] !== id && {
                    label: "Move to top",
                    hint: "of the pinned",
                    run: () => movePin(id, false),
                },
            pinned &&
                pins.at(-1) !== id && {
                    label: "Move to bottom",
                    hint: "of the pinned",
                    run: () => movePin(id, true),
                },
            !session.archived && {
                label: isUnread(id) ? "Mark read" : "Mark unread",
                hint: "this browser",
                run: () => setUnread(id, !isUnread(id)),
            },
        ],
        sessionActions().map((action) => ({
            label: action.label,
            hint: action.module,
            run: () => action.run([id]),
        })),
        [
            selectedInList() > 0
                ? {
                      label: "Deselect all",
                      hint: `${selectedInList()} selected`,
                      run: deselectInList,
                  }
                : { label: "Select", hint: "then add others", run: () => selectFromList(id) },
            steer && {
                label: session.archived ? "Unarchive" : "Archive",
                run: () => setArchived([id], !session.archived),
            },
        ],
    ]
        .map((group) => group.filter(Boolean))
        .filter((group) => group.length > 0);
}

/** Run an item: close the sheet, unless the item opens another in its place. */
const runItem = (each) => () => {
    if (!each.opens) {
        closeSheet();
    }

    each.run();
};

/**
 * What a finger held on a row (or a right-click on it, at `at`) offers: open, copy, rename, fork, start a session in its
 * folder, share, pin and order the pins, mark it unread (or read), extensions' actions (`pocket.sessionAction`), select
 * it to act on more at once, and archive it or bring it back.
 */
export function SessionSheet({ id, at = null }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const groups = sessionItems(session);

    if (at) {
        return html`<${SessionMenu} title=${session.title ?? "New session"} groups=${groups} at=${at} />`;
    }

    return html`<${Sheet} title=${session.title ?? "New session"} onClose=${closeSheet}>
        <div class="sheet-list">
            ${groups.flat().map((each) => item(each.label, runItem(each), each.hint))}
        </div>
    <//>`;
}

/**
 * The actions as a small menu at the pointer (`at`, `{ x, y }`), kept inside the window: to the left of the pointer when
 * there is no room right of it, and above when none below. Arrows, Home, and End move through it; Esc, a click
 * outside, or another right-click closes it.
 */
function SessionMenu({ title, groups, at }) {
    const box = useRef(null);

    useLayoutEffect(() => {
        const menu = box.current;
        const { width, height } = menu.getBoundingClientRect();
        const left = at.x + width + 8 > innerWidth ? Math.max(8, at.x - width) : at.x;
        const top = at.y + height + 8 > innerHeight ? Math.max(8, at.y - height) : at.y;

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.focus({ preventScroll: true });
    }, [at.x, at.y]);

    useEffect(() => {
        const onKey = (event) =>
            event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && closeSheet();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    const onKeyDown = (event) => {
        // Here as well as on the window: the menu has the focus from its first frame, before effects run.
        if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            closeSheet();

            return;
        }

        const items = [...box.current.querySelectorAll("button")];
        const index = items.indexOf(document.activeElement);
        let target;

        if (event.key === "ArrowDown") {
            target = items[(index + 1) % items.length];
        } else if (event.key === "ArrowUp") {
            target = items[(index - 1 + items.length) % items.length];
        } else if (event.key === "Home") {
            target = items[0];
        } else if (event.key === "End") {
            target = items.at(-1);
        } else if (event.key === "Tab") {
            target = items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    // A right-click outside closes the menu, and the browser's own menu stays shut for it: one at a time.
    const onScrimMenu = (event) => {
        if (event.target === event.currentTarget) {
            event.preventDefault();
            closeSheet();
        }
    };

    return html`<div
        class="overlay pop-overlay"
        onMouseDown=${scrimPress(closeSheet)}
        onContextMenu=${onScrimMenu}
    >
        <section
            class="pop-menu session-menu"
            data-part="session-menu"
            ref=${box}
            role="menu"
            aria-label=${title}
            tabindex="-1"
            onKeyDown=${onKeyDown}
            onContextMenu=${(event) => event.preventDefault()}
        >
            ${groups.map(
                (group) => html`<div class="session-menu-group" role="group">
                    ${group.map(
                        (each) => html`<button
                            class="session-menu-item"
                            role="menuitem"
                            onClick=${runItem(each)}
                        >
                            <span>${each.label}</span>
                            ${each.hint && html`<span class="session-menu-hint">${each.hint}</span>`}
                        </button>`,
                    )}
                </div>`,
            )}
        </section>
    </div>`;
}
