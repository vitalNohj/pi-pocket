// What Pi Pocket does with the app bridge an embedder gives it (`web/host.js`): notifications, badge, pinned sessions,
// links, and the embedder's menu group. docs/embedders.md describes it.
import { callHost, host, hostCan, onHost } from "./host.js";
import { openPip } from "./pip.js";
import { sessionMark } from "./sessions.js";
import {
    actions,
    attempt,
    canSteer,
    embedderAccount,
    embedderAccountReady,
    navigate,
    notify,
    onEmbedderNotify,
    openSheet,
    scoped,
    store,
} from "./store.js";

/** The longest list of pinned sessions the embedder gets: a tray menu shows a few. */
const MAX_PINNED = 20;

export async function openAddress(address) {
    let url;

    try {
        url = new URL(String(address ?? "/"), location.origin);
    } catch {
        return;
    }

    if (url.origin !== location.origin || url.username || url.password) {
        return;
    }

    const match = /^\/s\/(\d+)$/.exec(url.pathname);
    const id = match ? Number(match[1]) : null;
    const pip = url.pathname === "/" && url.search === "?pip=1";

    if (hostCan("sessionFeed")) {
        if (
            address !== "/" &&
            address !== "/?pip=1" &&
            !(
                typeof address === "string" &&
                /^\/s\/[1-9]\d*$/.test(address) &&
                Number.isSafeInteger(id)
            )
        ) {
            return;
        }

        if (!(await embedderAccount(id))) {
            notify("error", "This session link is no longer available. Open it from Pi Pocket.");

            return;
        }
    }

    if (pip || (!hostCan("sessionFeed") && url.searchParams.has("pip"))) {
        openPip();

        return;
    }

    navigate(id);
}

/**
 * New session, as Alt+N starts one: the folder sheet, for someone signed in who may start sessions. The app asks for
 * it from its menu, dock, tray, or a `pi-pocket://new` link, and shows its window first.
 */
export function openNewSession() {
    // A page the app just opened may not know yet who is signed in: wait for that.
    if (store.state.me === undefined) {
        const stop = store.subscribe((state) => {
            if (state.me !== undefined) {
                stop();
                openNewSession();
            }
        });

        return;
    }

    if (!store.state.me || !canSteer() || scoped()) {
        return;
    }

    openSheet({ type: "cwd", mode: "new" });
}

if (host !== null) {
    if (hostCan("newSession")) {
        onHost("newSession", () => {
            if (!hostCan("sessionFeed")) {
                openNewSession();
            } else {
                void embedderAccount().then((ready) => {
                    if (ready) {
                        openNewSession();
                    }
                });
            }
        });
    }

    if (hostCan("notify")) {
        onEmbedderNotify((message) => callHost("notify", message));
        onHost("open", (event) => openAddress(event.url));
        onHost("approve", (event) =>
            attempt(async () => {
                if (hostCan("sessionFeed") && !(await embedderAccount())) {
                    notify(
                        "error",
                        "This notification is no longer current. Review the approval in Pi Pocket.",
                    );

                    return;
                }

                await actions.approve(String(event.id), event.allow === true);
            }).then(() => undefined),
        );
    } else if (hostCan("open")) {
        onHost("open", (event) => openAddress(event.url));
    }

    if (hostCan("pinned")) {
        let from = null;
        let pinnedSent = "";

        addEventListener("pocket:bridge-reset", () => {
            from = null;
            pinnedSent = "";
        });
        store.subscribe((state) => {
            if (
                !embedderAccountReady() ||
                (from?.me === state.me &&
                    from.sessions === state.sessions &&
                    from.pinned === state.pinned &&
                    from.unread === state.unread &&
                    from.peekSeen === state.peekSeen)
            ) {
                return;
            }

            from = {
                me: state.me,
                sessions: state.sessions,
                pinned: state.pinned,
                unread: state.unread,
                peekSeen: state.peekSeen,
            };

            const byId = new Map(state.sessions.map((session) => [session.id, session]));
            const pinned = state.pinned
                .map((id) => byId.get(id))
                .filter((session) => session !== undefined && !session.archived)
                .slice(0, MAX_PINNED)
                .map((session) => {
                    const mark = sessionMark(session);

                    return {
                        id: session.id,
                        title: session.title,
                        // The square's shape (`fresh`/`seen`), not the row's theme state (`done`/`idle`).
                        state: mark.shape.split(" ")[0],
                        label: mark.label,
                        url: `/s/${session.id}`,
                    };
                });
            const json = JSON.stringify(pinned);

            if (json !== pinnedSent) {
                pinnedSent = json;
                callHost("setPinned", pinned);
            }
        });
    }
}

/** The longest title the embedder's menu group shows. */
const MAX_MENU_TITLE = 40;

/**
 * The embedder's group for the app menu: its title (`menuTitle()`, such as the app's name), or none, and its items
 * (`menuItems()`), such as its own settings.
 */
export function hostMenu() {
    if (!hostCan("menu")) {
        return { title: "", items: [] };
    }

    const title = callHost("menuTitle");
    const items = callHost("menuItems");

    return {
        // Cut by characters, not UTF-16 units: an emoji stays whole.
        title: typeof title === "string" ? [...title.trim()].slice(0, MAX_MENU_TITLE).join("") : "",
        items: (Array.isArray(items) ? items : [])
            .filter((each) => typeof each?.id === "string" && typeof each?.label === "string")
            .map((each) => ({
                key: `host:${each.id}`,
                label: each.label,
                hint: typeof each.hint === "string" ? each.hint : "",
                run: () => {
                    const done = callHost("invoke", each.id);

                    if (done === false) {
                        notify("error", "The host around Pi Pocket could not do that.");
                    }
                },
            })),
    };
}
