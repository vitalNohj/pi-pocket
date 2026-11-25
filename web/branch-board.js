// The Work board, in the conversation's place as Running now is. On the left, a picker: by Sessions (the default),
// each repository and folder a session worked in, or by Branches, each repository's worktrees and the sessions in
// them, with this folder's own branches to switch to or make. What is ticked there is what the maps on the right show,
// as tabs, with the sessions connected to it. Everything shows what this device last had at once, and asks the server
// again behind it: a busy server takes its time with git.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { personStorage } from "./person-storage.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    navigate,
    notify,
    scoped,
    store,
    reachesMachine,
} from "./store.js";
import { html, Icon, Loader, shortPath, Spinner, timeAgo } from "./ui.js";

/** The board is for people who can steer, in a session whose folder is in a git repository. */
export const branchAvailable = () => canSteer() && Boolean(store.state.view.branch);

/** What a folder has checked out, in a few characters: its branch, or the commit it is at. */
export const headLabel = (head) => head?.branch ?? head?.detached ?? "";

/** Close the board: back to the conversation it took the place of. */
export const closeBranches = () =>
    store.set({ board: false, boardAgents: null, branchQuery: null });

/** The board is for the owner, who sees every session's work, and for anyone who can switch this folder's branch. */
export const workAvailable = () => branchAvailable() || reachesMachine();

/** A name typed for a new branch, as git takes one: spaces become dashes. */
const asBranchName = (text) => text.trim().replace(/\s+/g, "-");

/** The session's folder, as Pi has it now. */
const cwdOf = (state) => state.view.agent?.cwd ?? state.view.conversation?.cwd;

/** What a list of branches is kept under: the folder, on its computer. Sessions in one folder share it. */
function folderKey(state) {
    const cwd = cwdOf(state);

    return cwd ? `${state.view.conversation?.runner ?? ""}\n${cwd}` : null;
}

// ─── The last branches of each folder ───────────────────────────────────────────

/** Where this device keeps the last lists, for its person: `[[folder, { at, branches }], …]`, newest last. */
const LISTS_KEY = "branchLists";
/** How many folders' lists are kept. */
const KEPT_FOLDERS = 8;
/** How fresh a list a prefetch leaves alone. */
const FRESH_MS = 10_000;
/** The lists read or got in this tab, newest last. */
const lists = new Map();
/** The ask under way for each session: a second open, or a prefetch, waits on it rather than starting another. */
const pending = new Map();

/** The last list of a folder: from this tab, else from what this device kept. */
function lastList(folder) {
    if (folder === null) {
        return undefined;
    }

    if (!lists.has(folder)) {
        try {
            const kept = JSON.parse(personStorage.get(LISTS_KEY) ?? "[]");

            for (const [key, value] of Array.isArray(kept) ? kept : []) {
                if (!lists.has(key)) {
                    lists.set(key, value);
                }
            }
        } catch {
            // A list kept by another version, or cut short: git is asked anyway.
        }
    }

    return lists.get(folder);
}

/** Keep a folder's list, here and on this device, the newest `KEPT_FOLDERS` only. */
function keepList(folder, branches) {
    lists.delete(folder);
    lists.set(folder, { at: Date.now(), branches });

    for (const key of [...lists.keys()].slice(0, -KEPT_FOLDERS)) {
        lists.delete(key);
    }

    personStorage.set(LISTS_KEY, JSON.stringify([...lists]));
}

/** A switch changes which branch is current and where: the folder's list waits for git again. */
function forgetList(folder) {
    if (folder !== null && lists.delete(folder)) {
        personStorage.set(LISTS_KEY, JSON.stringify([...lists]));
    }
}

/** Ask for a session's branches, one ask at a time; the answer is kept for its folder. */
function fetchBranches(id, folder) {
    let ask = pending.get(id);

    if (!ask) {
        ask = api(`c/${id}/branches`)
            .then((each) => {
                if (folder !== null) {
                    keepList(folder, each);
                }

                return each;
            })
            .finally(() => pending.delete(id));
        pending.set(id, ask);
    }

    return ask;
}

/** Start reading the branches, and the map, before the board opens: on a hover or press of the branch, unless fresh. */
export function prefetchBranches() {
    const { conversationId: id } = store.state;
    const folder = folderKey(store.state);

    if (id !== null && branchAvailable() && Date.now() - (lastList(folder)?.at ?? 0) > FRESH_MS) {
        fetchBranches(id, folder).catch(() => {});
    }

    if (reachesMachine() && Date.now() - Date.parse(keptWork()?.generatedAt ?? 0) > FRESH_MS) {
        fetchWork().catch(() => {});
    }
}

/** Why this person cannot switch branches here now, or null when they can: the server's rules, said before a tap. */
function whyNot() {
    const { view, me } = store.state;

    if (!canSteer()) {
        return "Viewers can see the branch, not switch it.";
    }

    if (scoped()) {
        return "You were invited to one session: switching the branch changes the whole folder.";
    }

    if (view.turns?.on && view.turns.driver !== me?.id) {
        return "Take turns is on: the driver switches branches.";
    }

    if (view.live?.busy) {
        return "Pi is working: switch once it is done, or stop it.";
    }

    return null;
}

/** How far a branch is from the remote branch it follows, as ↑2 ↓1, or that the remote branch is gone. */
function Track({ upstream }) {
    if (!upstream) {
        return null;
    }

    if (upstream.gone) {
        return html`<span class="branch-track warn" title=${`${upstream.name} is gone`}>gone</span>`;
    }

    return (
        (upstream.ahead > 0 || upstream.behind > 0) &&
        html`<span class="branch-track" title=${`Against ${upstream.name}`}>
            ${upstream.ahead > 0 ? `↑${upstream.ahead}` : ""}${upstream.ahead > 0 && upstream.behind > 0 ? " " : ""}${upstream.behind > 0 ? `↓${upstream.behind}` : ""}
        </span>`
    );
}

// ─── The work map ───────────────────────────────────────────────────────────────

/** Which sessions worked in which worktrees, from the server (`work-map.ts`): kept on this device, asked again behind. */
const WORK_KEY = "workMap";
/** What was ticked, and which tab and picker showed: kept per person on this device. */
const PICKED_KEY = "workPicked";
const TAB_KEY = "workTab";
const MODE_KEY = "workMode";
const CONNECTED_KEY = "workConnected";
/** The maps, each a page of `web/work-maps/`. */
const MAPS = [
    { id: "trunk", name: "Trunk" },
    { id: "metro", name: "Metro map" },
    { id: "timeline", name: "Timeline" },
    { id: "folders", name: "Folder map" },
    { id: "orbit", name: "Orbit" },
];
let workAsk = null;
let lastWork;

function keptWork() {
    if (lastWork === undefined) {
        try {
            lastWork = JSON.parse(personStorage.get(WORK_KEY) ?? "null");
        } catch {
            lastWork = null;
        }
    }

    return lastWork;
}

/** The map from the server, one ask at a time; kept here, and on this device when it fits. */
function fetchWork() {
    workAsk ??= api("work-map")
        .then((map) => {
            lastWork = map;

            try {
                personStorage.set(WORK_KEY, JSON.stringify(map));
            } catch {
                // Too big for this device's storage: it is asked for again next time.
            }

            return map;
        })
        .finally(() => {
            workAsk = null;
        });

    return workAsk;
}

/** Only the owner sees every session and repository on this computer. */
const ownsServer = () => reachesMachine();

function keptPicked() {
    try {
        const kept = JSON.parse(personStorage.get(PICKED_KEY) ?? "null");

        return Array.isArray(kept) ? new Set(kept) : null;
    } catch {
        return null;
    }
}

/** `~/x` for a path in the server's home folder. */
const tilde = (path, home) =>
    home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/**
 * What the map holds, joined up for the picker: each session's worktrees, each worktree's sessions and repository,
 * with reads and writes. Keys are `s:<id>` for a session and `w:<path>` for a worktree.
 */
function joined(map) {
    const repoOf = new Map();
    const worktrees = new Map();

    for (const repo of map.repos) {
        for (const wt of repo.worktrees) {
            repoOf.set(wt.id, repo);
            worktrees.set(wt.id, { ...wt, repo, sessions: [] });
        }
    }

    const sessions = new Map();

    for (const session of map.sessions) {
        const entry = { ...session, wts: [], reads: 0, writes: 0 };

        for (const touch of session.touches) {
            const wt = worktrees.get(touch.wt);

            if (wt) {
                entry.wts.push({ wt, r: touch.r, w: touch.w, last: touch.h.at(-1)?.[0] ?? 0 });
                wt.sessions.push({ session: entry, r: touch.r, w: touch.w });
                entry.reads += touch.r;
                entry.writes += touch.w;
            }
        }

        sessions.set(session.id, entry);
    }

    return { repoOf, worktrees, sessions };
}

/**
 * What the maps show for what is ticked: those sessions and worktrees, and, with `connected`, the sessions that worked
 * in those worktrees and the worktrees those sessions worked in. A repository is on the map when any of its worktrees
 * is; its main copy always is, as the trunk the others branch from.
 */
function narrowed(map, data, picked, connected) {
    const sessionIds = new Set();
    const wtIds = new Set();

    for (const key of picked) {
        if (key.startsWith("s:") && data.sessions.has(Number(key.slice(2)))) {
            sessionIds.add(Number(key.slice(2)));
        } else if (key.startsWith("w:") && data.worktrees.has(key.slice(2))) {
            wtIds.add(key.slice(2));
        }
    }

    for (const id of [...sessionIds]) {
        for (const { wt } of data.sessions.get(id).wts) {
            wtIds.add(wt.id);
        }
    }

    if (connected) {
        for (const id of [...wtIds]) {
            for (const { session } of data.worktrees.get(id).sessions) {
                sessionIds.add(session.id);
            }
        }
    }

    const repos = map.repos
        .map((repo, hue) => ({ repo, hue }))
        .filter(({ repo }) => repo.worktrees.some((wt) => wtIds.has(wt.id)))
        .map(({ repo, hue }) => ({
            ...repo,
            hue,
            worktrees: repo.worktrees.filter((wt) => wt.isMain || wtIds.has(wt.id)),
        }));
    const onMap = new Set(repos.flatMap((repo) => repo.worktrees.map((wt) => wt.id)));

    return {
        ...map,
        repos,
        sessions: map.sessions
            .filter((session) => sessionIds.has(session.id))
            .map((session) => ({
                ...session,
                touches: session.touches.filter((touch) => onMap.has(touch.wt)),
            })),
        picked: [...picked],
    };
}

/** A tick box for a row: the row's own tap does something else (opens it, or switches the branch). */
function Tick({ on, label, onChange }) {
    return html`<label class="check work-tick" onClick=${(event) => event.stopPropagation()}>
        <input type="checkbox" checked=${on} aria-label=${label} onChange=${onChange} />
    </label>`;
}

/** A repository's heading in the picker: tap to fold or unfold it, tick to show all of it. */
function RepoHead({ repo, label, count, open, ticked, onToggle, onTick, home }) {
    return html`<div class="work-repo-head">
        <${Tick} on=${ticked === true} label=${`Show ${label}`} onChange=${onTick} />
        <button class="work-repo-name" aria-expanded=${open} onClick=${onToggle}>
            <${Icon} name="chevron" size=${12} class=${open ? "open" : ""} />
            <span class="work-repo-title">${label}</span>
            <span class="work-repo-path mono">${tilde(repo.main, home)}</span>
            <span class="work-count">${count}</span>
        </button>
    </div>`;
}

const sessionKind = {
    firstmate: "Firstmate",
    supervision: "Supervision",
    worker: "Worker",
    linked: "Linked",
    fork: "Fork",
    chat: "Chat",
};

/**
 * The picker by sessions: each session that worked in a repository, most recent first, under its repositories; open
 * one to see the folders it worked in. Ticking a session puts it on the map; ticking a folder, that folder.
 */
function SessionsPicker({ map, data, picked, setPicked, query, home }) {
    const [open, setOpen] = useState(() => new Set());
    const needle = query.trim().toLowerCase();
    const list = [...data.sessions.values()]
        .filter(
            (session) =>
                needle === "" ||
                session.title.toLowerCase().includes(needle) ||
                session.wts.some(({ wt }) =>
                    `${wt.branch} ${wt.id}`.toLowerCase().includes(needle),
                ),
        )
        .sort((a, b) => b.updated - a.updated);
    const toggle = (key) =>
        setPicked((was) => {
            const next = new Set(was);

            if (!next.delete(key)) {
                next.add(key);
            }

            return next;
        });
    const ago = (hour) => timeAgo(Date.parse(map.windowStart) + hour * 3_600_000);

    if (list.length === 0) {
        return html`<p class="muted pop-menu-note">${needle ? `No session matches “${query.trim()}”.` : "No session worked in a git folder in the last 14 days."}</p>`;
    }

    return list.map((session) => {
        const key = `s:${session.id}`;
        const unfolded = open.has(session.id) || needle !== "";
        const repos = [...new Set(session.wts.map(({ wt }) => wt.repo))];

        return html`<div class="work-group" key=${key}>
            <div class=${`work-row ${picked.has(key) ? "on" : ""}`}>
                <${Tick} on=${picked.has(key)} label=${`Show ${session.title}`} onChange=${() => toggle(key)} />
                <button
                    class="work-row-main"
                    aria-expanded=${unfolded}
                    onClick=${() =>
                        setOpen((was) => {
                            const next = new Set(was);

                            if (!next.delete(session.id)) {
                                next.add(session.id);
                            }

                            return next;
                        })}
                >
                    <${Icon} name="chevron" size=${12} class=${unfolded ? "open" : ""} />
                    <span class="pop-menu-row-text">
                        <span class="pop-menu-row-name">${session.title}</span>
                        <span class="pop-menu-row-sub">
                            ${sessionKind[session.kind] ?? "Chat"} · ${repos.map((repo) => repo.name).join(", ")} ·
                            ${session.writes > 0 ? ` changed files ·` : " read only ·"} ${ago(session.updated)}
                        </span>
                    </span>
                    <span class="work-count" title="Folders">${session.wts.length}</span>
                </button>
                <button
                    class="icon-button small"
                    title="Open the session"
                    aria-label=${`Open ${session.title}`}
                    onClick=${() => navigate(session.id)}
                >
                    <${Icon} name="external" size=${14} />
                </button>
            </div>
            ${
                unfolded &&
                html`<div class="work-children">
                    ${session.wts
                        .slice()
                        .sort((a, b) => b.w - a.w || b.r - a.r)
                        .map(({ wt, r, w }) => {
                            const wkey = `w:${wt.id}`;

                            return html`<div class=${`work-row child ${picked.has(wkey) ? "on" : ""}`} key=${wkey}>
                                <${Tick} on=${picked.has(wkey)} label=${`Show ${wt.branch || wt.id}`} onChange=${() => toggle(wkey)} />
                                <span class="pop-menu-row-text">
                                    <span class="pop-menu-row-name mono">${wt.branch || `at ${wt.head}`}</span>
                                    <span class="pop-menu-row-sub">
                                        ${wt.repo.name} · ${tilde(wt.id, home)} · ${w > 0 ? `changed ${w}×, ` : ""}read ${r}×
                                    </span>
                                </span>
                            </div>`;
                        })}
                </div>`
            }
        </div>`;
    });
}

/**
 * The maps beside the picker, as tabs over their pages. Each page gets the map narrowed to what is ticked, and says
 * back what to add, take off, or open. A page opened once stays loaded while the board shows, so its tab is instant.
 */
function WorkMaps({ map, picked, setPicked, connected, setConnected, data, error, asking }) {
    const [shown, setShown] = useState(() => {
        const kept = personStorage.get(TAB_KEY);

        return MAPS.some((each) => each.id === kept) ? kept : MAPS[0].id;
    });
    const [opened, setOpened] = useState(() => new Set([shown]));
    const frames = useRef(new Map());
    const narrow = useMemo(
        () => (map && data ? narrowed(map, data, picked, connected) : null),
        [map, data, picked, connected],
    );

    // Each page is sent the map when it says it is ready, and again whenever what is ticked changes.
    useEffect(() => {
        for (const frame of frames.current.values()) {
            frame?.contentWindow?.postMessage({ type: "work-map", map: narrow }, location.origin);
        }
    }, [narrow]);

    useEffect(() => {
        const listen = (event) => {
            const from = [...frames.current.values()].find(
                (frame) => frame?.contentWindow === event.source,
            );

            if (!from || event.origin !== location.origin || typeof event.data?.type !== "string") {
                return;
            }

            const { type, kind, id } = event.data;
            const key = `${kind}:${id}`;

            if (type === "work-map-ready" && narrow) {
                from.contentWindow.postMessage({ type: "work-map", map: narrow }, location.origin);
            } else if (type === "work-map-add" && (kind === "s" || kind === "w")) {
                setPicked((was) => new Set([...was, key]));
            } else if (type === "work-map-remove") {
                setPicked((was) => {
                    const next = new Set(was);

                    next.delete(key);

                    return next;
                });
            } else if (
                type === "work-map-open" &&
                kind === "s" &&
                Number.isSafeInteger(Number(id))
            ) {
                navigate(Number(id));
            }
        };

        addEventListener("message", listen);

        return () => removeEventListener("message", listen);
    }, [narrow]);

    const show = (id) => {
        setOpened((was) => new Set([...was, id]));
        setShown(id);
        personStorage.set(TAB_KEY, id);
    };

    const count = narrow ? narrow.sessions.length : 0;
    const folders = narrow ? narrow.repos.reduce((n, repo) => n + repo.worktrees.length, 0) : 0;

    return html`<div class="branch-maps">
        <div class="branch-maps-head">
            <div class="segmented branch-map-tabs" role="tablist" aria-label="Maps">
                ${MAPS.map(
                    (each) => html`<button
                        key=${each.id}
                        role="tab"
                        class=${each.id === shown ? "on" : ""}
                        aria-selected=${each.id === shown}
                        onClick=${() => show(each.id)}
                    >
                        ${each.name}
                    </button>`,
                )}
            </div>
            <a
                class="icon-button small"
                href=${`/work-maps/${shown}.html`}
                target="_blank"
                rel="noopener"
                title="Every session and folder, in a tab of its own"
                aria-label="Open the whole map in a tab"
            >
                <${Icon} name="external" size=${14} />
            </a>
        </div>
        <div class="work-map-bar small">
            <label class="check" title="Also show the other sessions that worked in the same folders">
                <input
                    type="checkbox"
                    checked=${connected}
                    onChange=${(event) => setConnected(event.currentTarget.checked)}
                />
                Connected
            </label>
            ${
                narrow &&
                html`<span class="muted">${count} ${count === 1 ? "session" : "sessions"} · ${folders} ${folders === 1 ? "folder" : "folders"}</span>`
            }
            ${picked.size > 0 && html`<button class="link small" onClick=${() => setPicked(new Set())}>Clear</button>`}
            ${asking && map && html`<span class="branch-board-asking"><${Spinner} hidden=${true} /></span>`}
        </div>
        ${error && !map && html`<p class="muted branch-maps-note">${error}</p>`}
        ${!map && !error && html`<div class="branch-maps-note"><${Loader} label="Reading every session's work" /></div>`}
        ${
            map &&
            picked.size === 0 &&
            html`<p class="muted branch-maps-note">Tick sessions, folders, or repositories on the left to see them here.</p>`
        }
        ${
            map &&
            picked.size > 0 &&
            html`<div class="branch-map-frames">
                ${MAPS.map(
                    (
                        each,
                    ) => html`<div key=${each.id} class="branch-map-slot" hidden=${each.id !== shown}>
                        ${
                            opened.has(each.id) &&
                            html`<iframe
                                class="branch-map-frame"
                                ref=${(frame) => frames.current.set(each.id, frame)}
                                src=${`/work-maps/${each.id}.html`}
                                title=${each.name}
                            ></iframe>`
                        }
                    </div>`,
                )}
            </div>`
        }
    </div>`;
}

// ─── The board ──────────────────────────────────────────────────────────────────

/**
 * This folder's branches, in the Branches picker: the current one first and checked, then the newest, the remote
 * branches it has no local branch for, and, for a name typed that is not a branch yet, a new branch made from what is
 * checked out. A row's tick puts its worktree on the map, when it has one; its Switch button switches this session's
 * folder to it. Arrows and Enter pick from the search, as in the model picker; `/branch fix` opens it searching.
 */
function BranchSwitcher({ query, setQuery, data, picked, setPicked, setAskingGit, onKeyRef }) {
    const { view, server, conversationId: id, branchQuery } = store.state;
    const folder = folderKey(store.state);
    const [branches, setBranches] = useState(() => lastList(folder)?.branches ?? null);
    const [asking, setAsking] = useState(false);
    const [error, setError] = useState(null);
    const [switching, setSwitching] = useState(false);
    const [at, setAt] = useState(0);
    const list = useRef(null);
    // Arrows scroll the list to the row they reach; the mouse does not, or the list would run away under it.
    const keyed = useRef(false);

    useEffect(() => setAt(0), [branchQuery, query]);
    useEffect(() => setAskingGit(asking && Boolean(branches)), [asking, branches]);

    // Asked when the board opens and when the branch changes while it shows. The last list stays in sight meanwhile.
    const head = JSON.stringify(view.branch);

    useEffect(() => {
        if (id === null || !branchAvailable()) {
            return;
        }

        let live = true;

        setError(null);
        setAsking(true);
        fetchBranches(id, folder)
            .then(
                (each) => live && setBranches(each),
                (failure) => live && setError(failure.message),
            )
            .finally(() => live && setAsking(false));

        return () => {
            live = false;
        };
    }, [id, folder, head]);

    const blocked = whyNot();
    const needle = query.trim().toLowerCase();
    const matches = (name) => needle === "" || name.toLowerCase().includes(needle);
    // A kept list can be older than a switch: the view says what is checked out now.
    const checkedOut = view.branch?.branch;
    const isCurrent = (branch) =>
        checkedOut === undefined ? Boolean(branch.current) : branch.name === checkedOut;
    // The current branch first, then the rest newest first: Enter on an untouched list keeps the branch.
    const local = (branches?.local ?? [])
        .filter((branch) => matches(branch.name))
        .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
    const remote = (branches?.remote ?? []).filter((branch) => matches(branch.name));
    const name = asBranchName(query);
    // A name typed that is no branch yet, here or as a remote one (which its own row switches to), can be made.
    const make =
        branches &&
        name !== "" &&
        !branches.local.some((branch) => branch.name === name) &&
        !branches.remote.some((branch) => branch.name.slice(branch.name.indexOf("/") + 1) === name)
            ? name
            : null;
    const rows = [
        ...local.map((branch) => ({ kind: "local", key: `l:${branch.name}`, branch })),
        ...remote.map((branch) => ({ kind: "remote", key: `r:${branch.name}`, branch })),
        ...(make ? [{ kind: "make", key: "make", name: make }] : []),
    ];
    // The list can change while the board shows.
    const active = Math.max(0, Math.min(at, rows.length - 1));

    useEffect(() => {
        if (!keyed.current) {
            return;
        }

        keyed.current = false;
        list.current?.querySelector(".pop-menu-row.on")?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const pick = (row) => {
        if (row.kind === "local" && isCurrent(row.branch)) {
            notify("info", `This folder is on ${row.branch.name} already.`);

            return;
        }

        if (row.kind === "local" && row.branch.worktree) {
            notify(
                "info",
                `${row.branch.name} is checked out in ${shortPath(row.branch.worktree, server?.home)}: git switches to it only there.`,
            );

            return;
        }

        if (blocked) {
            notify("error", blocked);

            return;
        }

        const target =
            row.kind === "remote"
                ? { track: row.branch.name }
                : row.kind === "make"
                  ? { name: row.name, create: true }
                  : { name: row.branch.name };

        setSwitching(true);
        attempt(async () => {
            const { branch } = await actions.switchBranch(target);

            forgetList(folder);
            notify("info", `On ${branch} now.`);
        }).then(() => setSwitching(false));
    };

    const rowBody = (each) => {
        if (each.kind === "make") {
            return html`<${Icon} name="plus" size=${14} />
                <span class="pop-menu-row-text">
                    <span class="pop-menu-row-name">Make the branch <span class="mono">${each.name}</span></span>
                    <span class="pop-menu-row-sub">from ${headLabel(view.branch) || "here"}${branches.changed > 0 ? ", with your uncommitted changes" : ""}</span>
                </span>`;
        }

        const { branch } = each;
        const current = each.kind === "local" && isCurrent(branch);
        const sub =
            each.kind === "local" && branch.worktree && !current
                ? `in another worktree: ${shortPath(branch.worktree, server?.home)}`
                : [branch.subject, branch.at ? timeAgo(branch.at) : "no commits yet"]
                      .filter(Boolean)
                      .join(" · ");

        const where = each.kind === "local" ? worktreeOf(branch) : undefined;
        const wkey = where && `w:${where.id}`;

        return html`${
            wkey
                ? html`<${Tick}
                      on=${picked.has(wkey)}
                      label=${`Show ${branch.name} on the map`}
                      onChange=${() =>
                          setPicked((was) => {
                              const next = new Set(was);

                              if (!next.delete(wkey)) {
                                  next.add(wkey);
                              }

                              return next;
                          })}
                  />`
                : html`<span class="work-tick-space"></span>`
        }
            <span class="pop-menu-row-text">
                <span class="pop-menu-row-name mono">${branch.name}</span>
                <span class="pop-menu-row-sub">${sub}${where?.sessions.length ? ` · ${where.sessions.length} ${where.sessions.length === 1 ? "session" : "sessions"}` : ""}</span>
            </span>
            ${each.kind === "local" && html`<${Track} upstream=${branch.upstream} />`}
            ${current && html`<${Icon} name="check" size=${14} />`}
            ${!current && !(each.kind === "local" && branch.worktree) && html`<span class="work-switch">Switch</span>`}`;
    };

    // The worktree a local branch is checked out in, on the map: this folder for the current one, else its own.
    const cwd = cwdOf(store.state);

    const worktreeOf = (branch) => {
        if (!data) {
            return undefined;
        }

        const path = isCurrent(branch) ? data.mainOfCwd(cwd) : branch.worktree;

        return path ? data.worktrees.get(path) : undefined;
    };

    // Arrows and Enter move through the rows from the search box; Esc there empties it first.
    const onKeyDown = (event) => {
        if (event.isComposing) {
            return;
        }

        if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            setQuery("");

            return;
        }

        if (rows.length === 0) {
            return;
        }

        // Alt+↑/↓ stays the app's: it switches sessions.
        const step = event.altKey
            ? 0
            : event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowUp"
                ? -1
                : 0;

        if (step !== 0) {
            event.preventDefault();
            keyed.current = true;
            setAt((active + step + rows.length) % rows.length);
        } else if (event.key === "Enter" && rows[active] && !switching) {
            event.preventDefault();
            pick(rows[active]);
        }
    };

    const row = (each, index, body) => html`<button
        key=${each.key}
        class=${`pop-menu-row ${index === active ? "on" : ""} ${each.branch?.worktree && !isCurrent(each.branch) ? "elsewhere" : ""}`}
        role="option"
        aria-selected=${each.kind === "local" && isCurrent(each.branch)}
        disabled=${switching}
        onMouseMove=${() => index !== active && setAt(index)}
        onClick=${() => pick(each)}
    >
        ${body}
    </button>`;

    onKeyRef.current = onKeyDown;

    return html`<div class="work-own">
        <div class="pop-menu-label">
            This folder · ${view.branch?.detached ? "no branch, at " : "on "}<b class="mono">${headLabel(view.branch) || "…"}</b>
        </div>
        <div ref=${list} role="listbox" aria-label="Branches">
            ${error && html`<p class="muted pop-menu-note">${error}</p>`}
            ${!branches && !error && html`<div class="pop-menu-note"><${Loader} label="Asking git" /></div>`}
            ${
                branches &&
                rows.length === 0 &&
                html`<p class="muted pop-menu-note">No branch matches “${query.trim()}”.</p>`
            }
            ${rows.flatMap((each, index) => [
                each.kind === "remote" &&
                    rows[index - 1]?.kind !== "remote" &&
                    html`<div class="pop-menu-label" key="remote">Remote</div>`,
                row(each, index, rowBody(each)),
            ])}
        </div>
        ${
            branches &&
            (blocked || branches.changed > 0 || branches.more > 0) &&
            html`<div class="pop-menu-foot small">
                ${blocked && html`<p class="warn">${blocked}</p>`}
                ${
                    !blocked &&
                    branches.changed > 0 &&
                    html`<p class="muted">
                        ${branches.changed} ${branches.changed === 1 ? "file has" : "files have"} uncommitted changes: they come along, unless the other branch changes them too.
                    </p>`
                }
                ${
                    branches.more > 0 &&
                    html`<p class="muted">
                        ${`${branches.more.toLocaleString()} older branches are not listed.`}
                    </p>`
                }
            </div>`
        }
    </div>`;
}

/**
 * The picker by branches: this folder's own branches first, to switch or make one, then every repository a session
 * worked in, folded; open one to see its worktrees, and each worktree's sessions. Ticking a repository shows all of it.
 */
function BranchesPicker({ map, data, picked, setPicked, query, home }) {
    const [open, setOpen] = useState(() => new Set());
    const needle = query.trim().toLowerCase();

    const flip = (set, key) => {
        const next = new Set(set);

        if (!next.delete(key)) {
            next.add(key);
        }

        return next;
    };

    const ago = (hour) => timeAgo(Date.parse(map.windowStart) + hour * 3_600_000);
    const last = (wt) =>
        Math.max(
            -1e9,
            ...wt.sessions.flatMap(({ session }) =>
                session.touches
                    .filter((touch) => touch.wt === wt.id)
                    .map((touch) => touch.h.at(-1)?.[0] ?? -1e9),
            ),
        );
    const repos = map.repos
        .map((repo) => {
            const wts = repo.worktrees
                .map((each) => data.worktrees.get(each.id))
                .filter(
                    (wt) =>
                        needle === "" ||
                        `${wt.branch} ${wt.id} ${repo.name}`.toLowerCase().includes(needle) ||
                        wt.sessions.some(({ session }) =>
                            session.title.toLowerCase().includes(needle),
                        ),
                )
                .sort(
                    (a, b) =>
                        Number(b.isMain) - Number(a.isMain) ||
                        b.sessions.length - a.sessions.length ||
                        last(b) - last(a),
                );

            return { repo, wts, busy: wts.reduce((n, wt) => n + wt.sessions.length, 0) };
        })
        .filter(({ wts }) => wts.length > 0)
        .sort((a, b) => b.busy - a.busy);

    if (repos.length === 0) {
        return html`<p class="muted pop-menu-note">${needle ? `No repository or branch matches “${query.trim()}”.` : "No repository had a session in the last 14 days."}</p>`;
    }

    return repos.map(({ repo, wts, busy }) => {
        const rkey = `r:${repo.main}`;
        const unfolded = open.has(rkey) || needle !== "";
        const keys = wts.map((wt) => `w:${wt.id}`);
        const all = keys.every((key) => picked.has(key));

        return html`<div class="work-group" key=${rkey}>
            <${RepoHead}
                repo=${repo}
                label=${repo.main === map.appRoot ? `${repo.name} · this server` : repo.name}
                count=${`${wts.length} · ${busy} ${busy === 1 ? "session" : "sessions"}`}
                open=${unfolded}
                ticked=${all}
                home=${home}
                onToggle=${() => setOpen((was) => flip(was, rkey))}
                onTick=${() =>
                    setPicked((was) => {
                        const next = new Set(was);

                        for (const key of keys) {
                            if (all) {
                                next.delete(key);
                            } else {
                                next.add(key);
                            }
                        }

                        return next;
                    })}
            />
            ${
                unfolded &&
                html`<div class="work-children">
                    ${wts.map((wt) => {
                        const wkey = `w:${wt.id}`;
                        const wopen = open.has(wkey);

                        return html`<div key=${wkey}>
                            <div class=${`work-row ${picked.has(wkey) ? "on" : ""}`}>
                                <${Tick} on=${picked.has(wkey)} label=${`Show ${wt.branch || wt.id}`} onChange=${() => setPicked((was) => flip(was, wkey))} />
                                <button class="work-row-main" aria-expanded=${wopen} disabled=${wt.sessions.length === 0} onClick=${() => setOpen((was) => flip(was, wkey))}>
                                    <${Icon} name="chevron" size=${12} class=${wopen ? "open" : ""} />
                                    <span class="pop-menu-row-text">
                                        <span class="pop-menu-row-name mono">${wt.branch || `at ${wt.head}`}${wt.isMain ? html` <span class="work-main">main copy</span>` : ""}</span>
                                        <span class="pop-menu-row-sub">
                                            ${tilde(wt.id, home)}${wt.isMain ? "" : ` · +${wt.ahead} −${wt.behind}`}${wt.dirty ? ` · ${wt.dirty} uncommitted` : ""}
                                        </span>
                                    </span>
                                    <span class="work-count" title="Sessions">${wt.sessions.length}</span>
                                </button>
                            </div>
                            ${
                                wopen &&
                                html`<div class="work-children">
                                    ${wt.sessions.map(({ session, r, w }) => {
                                        const skey = `s:${session.id}`;

                                        return html`<div class=${`work-row child ${picked.has(skey) ? "on" : ""}`} key=${skey}>
                                            <${Tick} on=${picked.has(skey)} label=${`Show ${session.title}`} onChange=${() => setPicked((was) => flip(was, skey))} />
                                            <span class="pop-menu-row-text">
                                                <span class="pop-menu-row-name">${session.title}</span>
                                                <span class="pop-menu-row-sub">${w > 0 ? `changed ${w}×, ` : ""}read ${r}× · ${ago(session.updated)}</span>
                                            </span>
                                            <button class="icon-button small" title="Open the session" aria-label=${`Open ${session.title}`} onClick=${() => navigate(session.id)}>
                                                <${Icon} name="external" size=${14} />
                                            </button>
                                        </div>`;
                                    })}
                                </div>`
                            }
                        </div>`;
                    })}
                </div>`
            }
        </div>`;
    });
}

/**
 * The Work board: the picker on the left, by Sessions or by Branches, and the maps of what is ticked on the right.
 * It opens on Sessions with this session ticked; `/branch` opens it on Branches, searching for its name. Esc closes it.
 */
export function BranchBoard() {
    const { view, server, conversationId: id, branchQuery } = store.state;
    const owner = ownsServer();
    const [mode, setMode] = useState(() =>
        branchQuery?.text || !owner ? "branches" : (personStorage.get(MODE_KEY) ?? "sessions"),
    );
    const [query, setQuery] = useState(branchQuery?.text ?? "");
    const [map, setMap] = useState(() => (owner ? keptWork() : null));
    const [mapError, setMapError] = useState(null);
    const [askingMap, setAskingMap] = useState(false);
    const [askingGit, setAskingGit] = useState(false);
    const [picked, setPickedState] = useState(
        () => keptPicked() ?? new Set(id === null ? [] : [`s:${id}`]),
    );
    const [connected, setConnectedState] = useState(
        () => personStorage.get(CONNECTED_KEY) !== "off",
    );
    const field = useRef(null);
    const onKeyRef = useRef(null);
    const home = map?.home || server?.home;

    const setPicked = (change) =>
        setPickedState((was) => {
            const next = typeof change === "function" ? change(was) : change;

            personStorage.set(PICKED_KEY, JSON.stringify([...next]));

            return next;
        });

    const setConnected = (on) => {
        setConnectedState(on);
        personStorage.set(CONNECTED_KEY, on ? null : "off");
    };

    const switchMode = (next) => {
        setMode(next);
        personStorage.set(MODE_KEY, next);
    };

    useBack(true, closeBranches);

    // Esc closes the board, unless something over it, or the search, takes it first.
    useEffect(() => {
        const keys = (event) => {
            if (event.defaultPrevented || store.state.sheet || store.state.launcher) {
                return;
            }

            if (event.key === "Escape" && !event.isComposing) {
                event.preventDefault();
                closeBranches();
            }
        };

        addEventListener("keydown", keys);

        return () => removeEventListener("keydown", keys);
    }, []);

    // `/branch name` searches the branches, also with the board already open; a keyboard goes to the search.
    useEffect(() => {
        if (branchQuery?.text) {
            setMode("branches");
        }

        setQuery(branchQuery?.text ?? "");

        if (!matchMedia("(pointer: coarse)").matches) {
            field.current?.focus({ preventScroll: true });
        }
    }, [branchQuery]);

    // The map, asked for as the board opens; what this device kept shows meanwhile.
    useEffect(() => {
        if (!owner) {
            return;
        }

        let live = true;

        setAskingMap(true);
        fetchWork()
            .then(
                (each) => live && (setMap(each), setMapError(null)),
                (failure) => live && setMapError(failure.message),
            )
            .finally(() => live && setAskingMap(false));

        return () => {
            live = false;
        };
    }, [owner]);

    const data = useMemo(() => {
        if (!map) {
            return null;
        }

        const joinedMap = joined(map);
        // This session's folder may be deep in a worktree: its worktree is the longest that holds it.
        const ids = [...joinedMap.worktrees.keys()].sort((a, b) => b.length - a.length);

        joinedMap.mainOfCwd = (cwd) =>
            cwd ? ids.find((each) => cwd === each || cwd.startsWith(`${each}/`)) : undefined;

        return joinedMap;
    }, [map]);

    const cwd = cwdOf(store.state);
    const own = branchAvailable();

    return html`<section class="board branch-board" data-part="branch-board" aria-label="Sessions, branches, and the work map">
        <header class="board-head">
            <div class="board-title">
                <h2>Work map</h2>
                <div class="board-sub">
                    ${cwd && html`<span class="mono">${shortPath(cwd, home)}</span>`}
                    ${view.branch && html`${" · "}${view.branch?.detached ? "no branch, at " : "on "}<b class="mono">${headLabel(view.branch) || "…"}</b>`}
                    ${(askingGit || (askingMap && map)) && html`<span class="branch-board-asking"><${Spinner} hidden=${true} /> updating</span>`}
                </div>
            </div>
            <button class="icon-button" title="Back to the conversation (Esc)" aria-label="Close" onClick=${closeBranches}>
                <${Icon} name="close" />
            </button>
        </header>
        <div class="branch-board-body">
            <div class="branch-picker branch-list">
                <div class="branch-search">
                    ${
                        owner &&
                        html`<div class="segmented work-modes" role="tablist" aria-label="Pick by">
                            ${[
                                ["sessions", "Sessions"],
                                ["branches", "Branches"],
                            ].map(
                                ([key, label]) => html`<button
                                    key=${key}
                                    role="tab"
                                    class=${mode === key ? "on" : ""}
                                    aria-selected=${mode === key}
                                    onClick=${() => switchMode(key)}
                                >
                                    ${label}
                                </button>`,
                            )}
                        </div>`
                    }
                    <label class="search pop-menu-search">
                        <${Icon} name="search" size=${15} />
                        <input
                            ref=${field}
                            placeholder=${mode === "sessions" ? "Find a session, branch, or folder" : own ? "Switch to or make a branch, or find one" : "Find a repository or branch"}
                            value=${query}
                            autocapitalize="off"
                            autocomplete="off"
                            spellcheck="false"
                            onKeyDown=${(event) => mode === "branches" && onKeyRef.current?.(event)}
                            onInput=${(event) => setQuery(event.currentTarget.value)}
                        />
                    </label>
                </div>
                <div class="pop-menu-list work-list">
                    ${
                        mode === "branches" &&
                        own &&
                        html`<${BranchSwitcher}
                            query=${query}
                            setQuery=${setQuery}
                            data=${data}
                            picked=${picked}
                            setPicked=${setPicked}
                            setAskingGit=${setAskingGit}
                            onKeyRef=${onKeyRef}
                        />`
                    }
                    ${owner && mode === "branches" && own && html`<div class="pop-menu-label">Every repository</div>`}
                    ${owner && mapError && !map && html`<p class="muted pop-menu-note">${mapError}</p>`}
                    ${owner && !map && !mapError && html`<div class="pop-menu-note"><${Loader} label="Reading every session's work" /></div>`}
                    ${
                        owner &&
                        map &&
                        (mode === "sessions"
                            ? html`<${SessionsPicker} map=${map} data=${data} picked=${picked} setPicked=${setPicked} query=${query} home=${home} />`
                            : html`<${BranchesPicker} map=${map} data=${data} picked=${picked} setPicked=${setPicked} query=${query} home=${home} />`)
                    }
                </div>
            </div>
            ${
                owner
                    ? html`<${WorkMaps}
                          map=${map}
                          data=${data}
                          picked=${picked}
                          setPicked=${setPicked}
                          connected=${connected}
                          setConnected=${setConnected}
                          error=${mapError}
                          asking=${askingMap}
                      />`
                    : html`<div class="branch-maps"><p class="muted branch-maps-note">Only the owner of this server sees every session's work.</p></div>`
            }
        </div>
    </section>`;
}
