// The folder picker's listings for this tab (`folder-cache.js`): read from the server's API, kept for the person
// signed in. The cache empties when the person, or what they may see, changes: `store.state.me` is a new object when
// the person or their rights change; for someone given folders, a new list of computers (`runners`, `thisServer`) can
// also mean other folders given. The owner has no folders given, so their cache stays across those. A sign-out empties
// it at once, before the page reloads.
//
// Once the app knows who is signed in, and it is idle, the folder each computer's picker opens in is read ahead: New
// session then shows its folders at once, on this server and on each linked computer.
import { createFolderCache } from "./folder-cache.js";
import { api, store } from "./store.js";

/** Whether the picker shows hidden folders (`sheets/folder.js`), kept per browser. */
export const HIDDEN_KEY = "pocket.folderHidden";

/** The API path of a folder's listing: this server's (`runner` null) or a linked computer's. */
export const listingPath = (runner, path, hidden) =>
    `${runner ? `runners/${encodeURIComponent(runner)}/fs` : "fs"}?path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`;

let scope = { parts: [], said: null, token: {} };

/** What a computer's record says of who may do what there: not whether it is online now, nor when it was last seen. */
const rules = ({ online, away, lastSeen, version, ...rest }) => rest;

/** An object kept while the person and what they may see stay the same: the cache's owner. */
function personScope() {
    const { me, runners, thisServer } = store.state;
    const parts = me?.role === "owner" ? [me] : [me, runners, thisServer];

    if (parts.length !== scope.parts.length || parts.some((each, i) => each !== scope.parts[i])) {
        // A computer going on or offline is no change of what this person may see.
        const said = JSON.stringify(
            me?.role === "owner" ? [me] : [me, (runners ?? []).map(rules), thisServer],
        );

        scope = { parts, said, token: said === scope.said ? scope.token : {} };
    }

    return me ? scope.token : null;
}

export const folderListings = createFolderCache({
    read: (runner, path, hidden) => api(listingPath(runner, path, hidden)),
    person: personScope,
});

addEventListener("pocket:signedOut", () => folderListings.clear());

/**
 * Where a new session's picker opens on each computer this person may start sessions on, as [runner, path]: this
 * server's default workspace or home, and each online linked computer's home. `except`: the computer shown already.
 */
export function computerStarts(except = undefined) {
    const { me, server, runners } = store.state;

    return [
        ...(me?.mayStart === false ? [] : [[null, server?.defaultCwd ?? "~"]]),
        ...(runners ?? [])
            .filter((each) => each.online && each.mayStart !== false)
            .map((each) => [each.id, "~"]),
    ].filter(([runner]) => runner !== except);
}

/** Whether hidden folders show in the picker. */
export const showsHidden = () => {
    try {
        return localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
        return false;
    }
};

// Read ahead once per page, when the app is idle after it knows who is signed in.
let warmed = false;
const stop = store.subscribe((state) => {
    if (warmed || !state.me || !state.server) {
        return;
    }

    warmed = true;
    queueMicrotask(() => stop());

    const idle = globalThis.requestIdleCallback ?? ((run) => setTimeout(run, 2000));

    idle(() => folderListings.ahead(computerStarts(), showsHidden()), { timeout: 5000 });
});
