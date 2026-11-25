// The parts of the Access sheet (`access-sheet.js`) over its lists: the tool row (search, two filters, the People
// filter, Group by), the key of the access levels, the trust menu of a project, and the grid of By computer, where each
// row is a project, a folder, or a session on one computer and each column one person chosen for it.
//
// The grid is one scroller (`.ag-scroll`): its head row and its first two columns stay in sight while it scrolls, so a
// row's cells and the people over them always move together. On a phone a row's name takes a line of its own over its
// cells, and stays where it is while the cells scroll sideways under it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../avatar.js";
import { shortPath } from "../folder-paths.js";
import { api, attempt, notify, store } from "../store.js";
import { html, Icon, Marked } from "../ui.js";
import {
    accessFolder,
    arrange,
    below,
    foldersOf,
    hitsOf,
    keeps,
    keepsFolder,
    seenBy,
} from "./access-tree.js";
import {
    chosenFor,
    choosable,
    holds,
    homeOf,
    InfoTip,
    inCharge,
    LevelMenu,
    levelFor,
    levelsFor,
    placeIn,
    PopMenu,
    seenFolders,
    setLevelOf,
    setTrust,
    standing,
    THIS_SERVER,
    trustOfProject,
    untilOf,
    useAllFolders,
    useGroups,
} from "./access.js";
import { canShare } from "./session-share.js";

/** The explanations of the grid's column heads, and of the people columns (in the key row). */
export const TIPS = {
    first: "A project is a git repository with its worktrees. Access to a project covers its subfolders and worktrees.",
    trust: "A trusted folder loads its own skills and its own model defaults in every session there. Trust is saved for a folder and covers every folder in it, for everyone on this computer. Only who is in charge of the computer changes it.",
    people: "Each column is 1 person. A cell is what that person has in that project or folder. A user starts sessions in the folders they have. A viewer reads the sessions they have and starts none, so a viewer has no Start level.",
};

/** The access levels as the key says them, in the colours of their buttons (`LevelMenu`). */
const KEY = [
    ["none", "None", "only sessions shared one by one"],
    ["start", "Start", "starts sessions, sees their own"],
    ["past", "So far", "also every session here now"],
    ["all", "All", "also every session that starts later"],
];

/**
 * The key of the access levels, small and muted: one row where it fits, and a second where it does not. On a phone it
 * is one row that scrolls sideways. Its "i" explains the people columns, the same for every person.
 */
export function AccessKey() {
    return html`<div class="ak-key" role="note" aria-label="Access levels">
        <${InfoTip} about="the people columns" text=${TIPS.people} />
        ${KEY.map(
            ([level, name, line]) =>
                html`<span class="ak-item"><b class=${`lv-${level}`}>${name}:</b> ${line}</span>`,
        )}
    </div>`;
}

/** What the lists are filtered by: each with the choices it offers, and what its button says while one is set. */
export const TIMES = [
    ["", "Any time"],
    ["24", "Last 24 hours", "Used by you: last 24 hours"],
    ["168", "Last 7 days", "Used by you: last 7 days"],
    ["336", "Last 14 days", "Used by you: last 14 days"],
    ["720", "Last 30 days", "Used by you: last 30 days"],
    ["old", "Older than 30 days", "Used by you: older than 30 days"],
    ["never", "Never", "Never used by you"],
];

export const ACCESS = [
    ["", "Any access"],
    ["has", "Has access"],
    ["none", "No access"],
];

/**
 * One filter: a button that says its name, or what it keeps while it is set, over the device's own list of choices
 * (`choices`: value, what the list says, what the button says when it is chosen).
 */
export function Pick({ name, value, choices, onChange }) {
    const set = choices.find(([key]) => key === value && key !== "");

    return html`<label class=${`access-pick ${set ? "on" : ""}`}>
        <span>${set ? (set[2] ?? set[1]) : name}</span>
        <${Icon} name="down" size=${11} />
        <select
            aria-label=${name}
            value=${value}
            onChange=${(event) => onChange(event.currentTarget.value)}
        >
            ${choices.map(([key, label]) => html`<option key=${key} value=${key}>${label}</option>`)}
        </select>
    </label>`;
}

/** The ways the lists are grouped: Projects only where projects are known. */
const GROUPS = [
    ["projects", "Projects"],
    ["folders", "Folders"],
    ["sessions", "Sessions"],
];

/** Group by: Projects (where `projects` are offered), Folders, Sessions. */
export function GroupBy({ value, projects, onChange }) {
    const offered = GROUPS.filter(([key]) => key !== "projects" || projects);

    return html`<div class="ak-group">
        <span class="ak-group-label" id="ak-group-label">Group by</span>
        <div class="segmented" role="radiogroup" aria-labelledby="ak-group-label">
            ${offered.map(
                ([key, label]) => html`<button
                    key=${key}
                    type="button"
                    role="radio"
                    class=${value === key ? "on" : ""}
                    aria-checked=${value === key}
                    onClick=${() => onChange(key)}
                >
                    ${label}
                </button>`,
            )}
        </div>
    </div>`;
}

/**
 * What the lists of one view are searched and filtered by, and how they are grouped (`group`: null for the default,
 * Projects where they are known). `find` is what `access-tree.js` `keeps` reads; `rows`: every session row there is,
 * for the count beside the search.
 */
export function useFind() {
    const [query, setQuery] = useState("");
    const [filters, setFilters] = useState({ access: "", time: "", by: "" });
    const [kept, setKept] = useState(() => new Set());
    const [group, setGroup] = useState(null);

    return {
        query,
        filters,
        kept,
        group,
        setGroup,
        search(text) {
            setKept(new Set());
            setQuery(text);
        },
        filter(key, value) {
            setKept(new Set());
            setFilters((now) => ({ ...now, [key]: value }));
        },
        clear() {
            setKept(new Set());
            setQuery("");
            setFilters({ access: "", time: "", by: "" });
        },
        keep: (ids) => setKept((now) => new Set([...now, ...ids])),
    };
}

/** The search field with the count of what it finds and Clear, as the person's page has it. */
export function SearchField({ state, active, found, total, placeholder }) {
    return html`<label class="search access-search">
        <${Icon} name="search" size=${14} />
        <input
            placeholder=${placeholder}
            aria-label=${placeholder}
            value=${state.query}
            onInput=${(event) => state.search(event.currentTarget.value)}
            onKeyDown=${(event) => {
                // Escape clears what is typed, not the sheet around it.
                if (event.key === "Escape" && state.query !== "") {
                    event.preventDefault();
                    event.stopPropagation();
                    state.search("");
                }
            }}
        />
        ${
            active &&
            html`<span class="access-found" aria-live="polite">${found} of ${total}</span>
                <button
                    type="button"
                    class="access-clear"
                    aria-label="Clear the search and the filters"
                    onClick=${state.clear}
                >
                    Clear
                </button>`
        }
    </label>`;
}

/**
 * The People filter of By computer: which of the people chosen for the computer have a column, as a list to check.
 * Its button says how many are shown: "8 people", "3 of 8 people".
 */
export function PeopleFilter({ people, hidden, onChange }) {
    const [open, setOpen] = useState(false);
    const [place, setPlace] = useState(null);
    const button = useRef(null);
    const menu = useRef(null);
    const shown = people.filter((each) => !hidden.has(each.id)).length;
    const word = (count) => (count === 1 ? "person" : "people");
    const label =
        shown === people.length
            ? `${people.length} ${word(people.length)}`
            : `${shown} of ${people.length} ${word(people.length)}`;

    useLayoutEffect(() => {
        if (!open || !menu.current || !button.current) {
            setPlace(null);

            return;
        }

        setPlace(placeIn(button.current, menu.current.offsetWidth, menu.current.scrollHeight));
        menu.current.querySelector("button")?.focus({ preventScroll: true });
    }, [open]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const outside = (event) => {
            if (!button.current?.contains(event.target) && !menu.current?.contains(event.target)) {
                setOpen(false);
            }
        };

        const key = (event) => {
            if (event.key === "Escape") {
                // Escape closes the list, not the sheet around it.
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                button.current?.focus();
            }
        };

        addEventListener("pointerdown", outside, true);
        addEventListener("keydown", key, true);

        return () => {
            removeEventListener("pointerdown", outside, true);
            removeEventListener("keydown", key, true);
        };
    }, [open]);

    const flip = (id) => {
        const next = new Set(hidden);

        if (!next.delete(id)) {
            next.add(id);
        }

        onChange(next);
    };

    return html`<button
            ref=${button}
            type="button"
            class=${`access-pick ak-people ${shown < people.length ? "on" : ""}`}
            aria-haspopup="menu"
            aria-expanded=${open}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="users" size=${13} />
            <span>${label}</span>
            <${Icon} name="down" size=${11} />
        </button>
        ${
            open &&
            html`<div
                class="at-level-menu ak-people-menu"
                role="menu"
                aria-label="People shown"
                ref=${menu}
                style=${
                    place
                        ? `left:${place.left}px;top:${place.top}px;max-height:${place.maxHeight}px`
                        : "visibility:hidden;left:0;top:0"
                }
            >
                <div class="ak-menu-head">Show these people</div>
                ${people.map(
                    (person) => html`<button
                        key=${person.id}
                        type="button"
                        class="at-level-item ak-check"
                        role="menuitemcheckbox"
                        aria-checked=${hidden.has(person.id) ? "false" : "true"}
                        onClick=${() => flip(person.id)}
                    >
                        <span class=${`ak-box ${hidden.has(person.id) ? "" : "on"}`}>
                            ${!hidden.has(person.id) && html`<${Icon} name="check" size=${11} />`}
                        </span>
                        <${Avatar} person=${person} size=${22} />
                        <span class="grow">${person.name}</span>
                        <span class="muted small">${roleWord(person)}</span>
                    </button>`,
                )}
                ${
                    hidden.size > 0 &&
                    html`<button
                        type="button"
                        class="at-level-item ak-all"
                        onClick=${() => onChange(new Set())}
                    >
                        Show everyone
                    </button>`
                }
            </div>`
        }`;
}

/** A person's role, in the one word a column head has room for. */
export const roleWord = (person) =>
    person.role === "viewer" ? "Viewer" : person.role === "owner" ? "Owner" : "User";

/** Pi's setting for a folder nobody decided about, as the trust button says it under "Not decided". */
const DEFAULT_TRUST = {
    ask: "Pi asks",
    always: "Trusted by default",
    never: "Not trusted by default",
};

/**
 * The trust menu of a project's row in By computer (or of one of its other folders, `entry` alone: a worktree folder
 * outside it, or a folder in it with a decision of its own): the
 * same menu button as the Access menu (`PopMenu`), with the three choices of the Project trust sheet (`trust.js`
 * `TrustSheet`) and its words. Its button says what holds now: Trusted, Not trusted, Not decided (with Pi's setting
 * for that under it), or Mixed where the project's folders differ; "through" a folder above when that one's decision
 * is what holds. On a project's row, "Trust this folder" and "Don't trust" are saved for its root and each of those
 * other folders at once; "Trust the folder above it" for its root alone.
 */
export function TrustMenu({ computer, project, entry, fallback }) {
    const trust = entry ? { entries: [entry], root: entry, mixed: false } : trustOfProject(project);
    const [busy, setBusy] = useState(false);

    if (trust === undefined) {
        return html`<span class="muted small">Unknown</span>`;
    }

    const home = homeOf(computer);
    const short = (path) => shortPath(path, home);
    const { root } = trust;
    const folders = entry ? [entry.folder] : trust.entries.map((each) => each.folder);
    const face = trust.mixed
        ? "Mixed"
        : root.saved === null
          ? "Not decided"
          : root.trusted
            ? "Trusted"
            : "Not trusted";
    const under =
        !trust.mixed && root.saved === null
            ? DEFAULT_TRUST[fallback]
            : !trust.mixed && root.saved.path !== root.folder
              ? `through ${short(root.saved.path)}`
              : undefined;
    const saved = (path, trusted) =>
        !trust.mixed && root.saved?.path === path && root.saved.trusted === trusted;
    const items = [
        {
            key: "trust",
            name: "Trust this folder",
            says: [short(root.folder)],
            checked: saved(root.folder, true),
        },
        root.parent !== undefined && {
            key: "trust-parent",
            name: "Trust the folder above it",
            says: [short(root.parent), "Covers every project in it"],
            checked: saved(root.parent, true),
        },
        {
            key: "distrust",
            name: "Don't trust",
            says: [],
            checked: saved(root.folder, false),
        },
    ].filter(Boolean);
    const state = trust.mixed
        ? "mixed"
        : root.saved === null
          ? "undecided"
          : root.trusted
            ? "trusted"
            : "untrusted";

    const pick = async (choice) => {
        setBusy(true);

        try {
            await setTrust(computer, choice === "trust-parent" ? [root.folder] : folders, choice);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="ag-trust">
        <${PopMenu}
            face=${html`<span class="ag-trust-face">
                <span>${face}</span>
                ${under && html`<span class="ag-trust-under">${under}</span>`}
            </span>`}
            buttonClass=${`ag-trust-button tr-${state}`}
            label=${`Project trust of ${entry ? short(entry.folder) : project.name}: ${face}${under ? `, ${under}` : ""}`}
            title=${short(root.folder)}
            disabled=${busy}
            menuLabel=${`Project trust of ${entry ? short(entry.folder) : project.name}`}
            items=${items}
            onPick=${pick}
        />
    </div>`;
}

/** The owner's id: a session from before sessions had a starter is theirs (`access.ts` `starter`). */
const ownerId = () => store.state.users.find((each) => each.role === "owner")?.id;

/**
 * The rows of the grid of one computer, for `people` (its columns): every session there that is not archived, under
 * the projects, the folders given to any of them, and the folders the sessions work in (`access-tree.js` `arrange`),
 * Home first; or with `group` "sessions" the sessions alone (`flat`). Each session row as `keeps` reads it: it counts
 * as "has" when one of `people` has it.
 */
export function gridOf(computer, people, { group, projects }) {
    const there = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id,
    );
    const worktrees = there.filter((each) => each.worktree);
    const listed = there.filter((each) => !each.archived);
    const given = [
        ...new Set(
            people.flatMap((person) =>
                chosenFor(computer, person) && !person.sessions
                    ? (computer.given?.[person.id] ?? [])
                    : [],
            ),
        ),
    ];
    const home = homeOf(computer);
    const homeKey = home === undefined ? undefined : foldersOf(home, [], [], [])[0]?.folder;
    const owner = ownerId();
    const seen = people.map((person) => [
        person,
        seenFolders(computer, person),
        untilOf(computer, person),
    ]);
    const has = (session) =>
        seen.some(
            ([person, sees, until]) =>
                holds(person, session) || seenBy(sees, session, worktrees, until) !== undefined,
        );
    const row = (session, folder) => ({
        id: session.id,
        session,
        title: session.title ?? "New session",
        has: has(session),
        usedAt: session.usedAt,
        updatedAt: session.updatedAt,
        starter: session.createdBy ?? owner,
        places: [session.cwd, folder],
    });

    const nodeOf = (node) => {
        const rows = node.sessions.map((each) => row(each, node.folder));
        const children = node.children.map(nodeOf);

        return {
            key: node.project ? `project:${node.folder}` : node.folder,
            folder: node.folder,
            ...(node.project ? { project: node.project } : {}),
            home: node.folder === homeKey && !node.project,
            rows,
            children,
            all: [...rows, ...children.flatMap((each) => each.all)],
        };
    };

    const arranged = arrange({
        home,
        folders: given,
        sessions: listed,
        there: worktrees,
        projects: projects ?? [],
        group,
    });
    const roots = arranged.roots.map(nodeOf);
    const flat = (arranged.flat ?? []).map((each) => row(each, accessFolder(each, worktrees)));
    const folders = roots.flatMap(function each(node) {
        return [node, ...node.children.flatMap(each)];
    });

    return {
        roots,
        other: arranged.other,
        flat,
        worktrees,
        rows: [...folders.flatMap((each) => each.rows), ...flat],
    };
}

/** The nodes of a grid that show under what is searched for (`find`), each with the sessions it lists (`listed`). */
function shownRows(nodes, find) {
    return nodes.flatMap((node) => {
        const children = shownRows(node.children, find);
        const listed = node.rows.filter((row) => keeps(find, row));

        return !find.active ||
            listed.length > 0 ||
            children.length > 0 ||
            keepsFolder(find, node.folder) ||
            (node.project && keepsFolder(find, node.project.name))
            ? [{ ...node, children, listed }]
            : [];
    });
}

/**
 * What `person` has of `session` themselves: invited to it alone, started it, shared with them; or by a folder whose
 * sessions they see; or nothing.
 */
function stateOf(computer, person, session, worktrees) {
    if (person.sessions?.includes(session.id)) {
        return "invited";
    }

    if (session.createdBy === person.id) {
        return "started";
    }

    if (session.sharedWith?.includes(person.id)) {
        return "shared";
    }

    return seenBy(seenFolders(computer, person), session, worktrees, untilOf(computer, person)) !==
        undefined
        ? "folder"
        : "none";
}

/** Why `person`'s level cannot be changed on `computer`, or undefined when it can. */
function reasonOf(computer, person) {
    const { chosen, manager } = standing(computer, person);

    return person.sessions
        ? "Invited to one session only"
        : manager
          ? "In charge here"
          : !chosen
            ? `Not on ${computer.name}`
            : undefined;
}

/**
 * Whether the scroller `box` has more to show past its right edge: the fade there says so. Asked again as it scrolls
 * and as it changes size, when it also says its width to its rows (`--view-w`).
 */
function useMore(box) {
    const [more, setMore] = useState(false);

    useEffect(() => {
        const element = box.current;

        if (!element) {
            return undefined;
        }

        const check = () => {
            // What the rows' names and the people under the grid are as wide as: the scroller's own width, so they
            // stay in sight while the cells scroll sideways under them.
            element.style.setProperty("--view-w", `${element.clientWidth}px`);
            setMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
        };

        const observer = new ResizeObserver(check);

        observer.observe(element);
        element.addEventListener("scroll", check, { passive: true });
        check();

        return () => {
            observer.disconnect();
            element.removeEventListener("scroll", check);
        };
    }, [box.current]);

    return more;
}

/**
 * The grid of one computer (By computer): a row for each project, folder, or session (`gridOf`), the project's or
 * folder's name and its trust first, then one cell for each person shown (`people`): their Access menu on a folder or a
 * project (`LevelMenu`, on its top folder), and on a session what they have of it, with Invite or Revoke. After the
 * rows, in the same scroller, the people who may use the computer, each with the switch that lets them (`after`).
 */
export function ComputerGrid({ computer, people, grid, find, trustColumn, fallback, after }) {
    const groups = useGroups(find);
    const scroller = useRef(null);
    const more = useMore(scroller);
    const [busy, setBusy] = useState(false);
    const home = homeOf(computer);
    const shown = shownRows(grid.roots, find);
    const flat = grid.flat.filter((row) => keeps(find, row));
    const projectsShown = shown.filter((each) => each.project).length;
    // Every folder of the computer, its last row, for who is in charge of it while people are shown and nothing is
    // searched for.
    const all = useAllFolders(
        computer,
        groups,
        inCharge(computer) && people.length > 0 && !find.active,
    );

    const revoke = async (person, row) => {
        if (!confirm(`Stop sharing “${row.title}” with ${person.name}?`)) {
            return;
        }

        find.keep([row.id]);
        setBusy(true);

        try {
            await attempt(() => api(`sessions/${row.id}/revoke`, { person: person.id }));
        } finally {
            setBusy(false);
        }
    };

    const invite = async (person, row) => {
        find.keep([row.id]);
        setBusy(true);

        try {
            await attempt(async () => {
                const answer = await api(`users/${encodeURIComponent(person.id)}/sharing`, {
                    share: [row.id],
                });

                if (answer.refused.length > 0) {
                    notify("error", answer.refused[0].reason);
                }
            });
        } finally {
            setBusy(false);
        }
    };

    const sessionCell = (person, row) => {
        const state = stateOf(computer, person, row.session, grid.worktrees);

        if (state === "started") {
            return html`<span class="ag-state">Started by them</span>`;
        }

        if (state === "shared" || state === "invited") {
            return html`<button
                type="button"
                class="button small ghost ag-act"
                disabled=${busy || state === "invited"}
                aria-label=${`Revoke ${row.title} from ${person.name}`}
                title=${state === "invited" ? "Invited to it alone: revoke it on their page" : undefined}
                onClick=${() => revoke(person, row)}
            >
                Revoke
            </button>`;
        }

        if (state === "folder") {
            return html`<span class="ag-state">Through folder</span>`;
        }

        return canShare(row.session)
            ? html`<button
                  type="button"
                  class="button small ghost ag-act"
                  disabled=${busy}
                  aria-label=${`Invite ${person.name} to ${row.title}`}
                  onClick=${() => invite(person, row)}
              >
                  <${Icon} name="plus" size=${12} /> Invite
              </button>`
            : html`<span class="ag-state">—</span>`;
    };

    const levelCell = (person, node) => {
        const { level, from } = levelFor(computer, person, node.folder);

        return html`<${LevelMenu}
            person=${person}
            folder=${node.folder}
            where=${computer.name}
            level=${level}
            from=${from}
            levels=${levelsFor(person)}
            reason=${reasonOf(computer, person)}
            compact=${true}
            onPick=${(next) => {
                find.keep(node.all.map((each) => each.id));
                void setLevelOf(computer, person, node.folder, next);
            }}
        />`;
    };

    const cells = (each) =>
        html`${people.map(
            (person) => html`<div class="ag-cell" key=${person.id}>
                <span class="ag-cell-who" aria-hidden="true">${person.name}</span>
                ${each(person)}
            </div>`,
        )}`;

    const sessionRow = (row, depth, folder) => {
        const where = row.session.worktree
            ? `⎇ ${row.session.worktree.branch}`
            : folder === undefined
              ? shortPath(row.session.cwd, home)
              : below(row.session.cwd, folder);

        return html`<div class="ag-row ag-session" key=${`s:${row.id}`} role="row">
            <div class="ag-first" role="rowheader" style=${`--depth:${depth}`}>
                <span class="ag-chev-space"></span>
                <${Icon} name="chat" size=${13} />
                <span class="ag-name-box">
                    <span class=${`ag-title ${row.has ? "" : "off"}`}>
                        <${Marked} text=${row.title} hits=${hitsOf(row.title, find.words)} />
                    </span>
                    ${where && html`<span class="ag-sub"><${Marked} text=${where} hits=${hitsOf(where, find.words)} /></span>`}
                </span>
            </div>
            ${trustColumn && html`<div class="ag-trust-cell empty"></div>`}
            ${cells((person) => sessionCell(person, row))}
        </div>`;
    };

    const folderRow = (node, depth, parent) => {
        const open = groups.isOpen(node.key);
        const project = node.project;
        const trust = project ? trustOfProject(project) : undefined;
        const name = project
            ? project.name
            : node.home
              ? "Home"
              : parent === undefined
                ? shortPath(node.folder, home)
                : below(node.folder, parent.folder);
        const count = node.all.length;
        const worktrees = project ? node.all.filter((each) => each.session.worktree).length : 0;
        const sub = [
            project && shortPath(node.folder, home),
            `${count} ${count === 1 ? "session" : "sessions"}${worktrees > 0 ? `, ${worktrees} in worktrees` : ""}`,
        ].filter(Boolean);
        const untrusted =
            trust !== undefined && !trust.mixed && trust.root.saved !== null && !trust.root.trusted;
        // A worktree folder outside the project's root, or a folder in it, with a decision of its own: its own row, with
        // its own menu.
        const parts = trust?.mixed ? trust.entries.slice(1) : [];
        const partName = (entry) =>
            below(entry.folder, trust.root.folder) === entry.folder
                ? "Worktree folder"
                : "Folder in it";

        return html`<div class=${`ag-row ag-group ${untrusted ? "untrusted" : ""}`} key=${node.key} role="row">
                <div class="ag-first" role="rowheader" style=${`--depth:${depth}`}>
                    <button
                        type="button"
                        class="ag-toggle"
                        aria-expanded=${open}
                        aria-label=${`${open ? "Close" : "Open"} ${name}`}
                        title=${node.folder}
                        onClick=${() => groups.toggle(node.key)}
                    >
                        <${Icon} name="chevron" size=${11} class=${`chev ${open ? "open" : ""}`} />
                        <${Icon} name=${project ? "fork" : node.home ? "home" : "folder"} size=${13} />
                        <span class="ag-name-box">
                            <span class="ag-name"><${Marked} text=${name} hits=${hitsOf(name, find.words)} /></span>
                            ${sub.map((line) => html`<span class="ag-sub">${line}</span>`)}
                        </span>
                    </button>
                </div>
                ${
                    trustColumn &&
                    html`<div class=${`ag-trust-cell ${project ? "" : "empty"}`}>
                        ${
                            project &&
                            html`<span class="ag-trust-label" aria-hidden="true">Project trust</span>
                                <${TrustMenu} computer=${computer} project=${project} fallback=${fallback} />`
                        }
                    </div>`
                }
                ${cells((person) => levelCell(person, node))}
                ${
                    untrusted &&
                    html`<div class="ag-note">Its own skills and model defaults stay off.</div>`
                }
            </div>
            ${parts.map(
                (
                    entry,
                ) => html`<div class="ag-row ag-part" key=${`part:${entry.folder}`} role="row">
                    <div class="ag-first" role="rowheader" style=${`--depth:${depth + 1}`}>
                        <span class="ag-chev-space"></span>
                        <${Icon} name="fork" size=${13} />
                        <span class="ag-name-box">
                            <span class="ag-name">${partName(entry)}</span>
                            <span class="ag-sub">${shortPath(entry.folder, home)}</span>
                        </span>
                    </div>
                    ${
                        trustColumn &&
                        html`<div class="ag-trust-cell">
                            <span class="ag-trust-label" aria-hidden="true">Project trust</span>
                            <${TrustMenu} computer=${computer} entry=${entry} fallback=${fallback} />
                        </div>`
                    }
                    ${cells(() => html`<span class="ag-state">Through project</span>`)}
                </div>`,
            )}
            ${
                open &&
                html`${node.children.map((each) => folderRow(each, depth + 1, node))}
                ${groups
                    .inOrder(node.key, node.listed)
                    .map((row) => sessionRow(row, depth + 1, node.folder))}
                ${
                    node.listed.length === 0 &&
                    node.children.length === 0 &&
                    html`<div class="ag-row ag-empty" role="row">
                        <div class="ag-first" style=${`--depth:${depth + 1}`}>
                            <span class="muted small">No sessions in this folder itself.</span>
                        </div>
                    </div>`
                }`
            }`;
    };

    /**
     * The rows of All folders at `depth`: a folder of the computer with a cell for each person, as a folder row above
     * has (`levelCell`), and open, the folders in it; a note; or the row that shows the rest of a long list.
     */
    const browsed = (rows, depth) =>
        rows.map((row) => {
            if (row.note !== undefined) {
                return html`<div class="ag-row ag-empty" role="row">
                    <div class="ag-first" style=${`--depth:${depth}`}>
                        <span class="muted small">${row.note}</span>
                    </div>
                </div>`;
            }

            if (row.more !== undefined) {
                return html`<div class="ag-row ag-empty" role="row">
                    <div class="ag-first" style=${`--depth:${depth}`}>
                        <button type="button" class="ag-more" onClick=${row.show}>
                            Show ${row.more} more
                        </button>
                    </div>
                </div>`;
            }

            return html`<div class="ag-row ag-browse" key=${row.key} role="row">
                    <div class="ag-first" role="rowheader" style=${`--depth:${depth}`}>
                        <button
                            type="button"
                            class="ag-toggle"
                            aria-expanded=${row.open}
                            aria-label=${`${row.open ? "Close" : "Open"} ${row.path} in All folders`}
                            title=${row.path}
                            onClick=${row.toggle}
                        >
                            <${Icon} name="chevron" size=${11} class=${`chev ${row.open ? "open" : ""}`} />
                            <${Icon} name=${row.home ? "home" : "folder"} size=${13} />
                            <span class="ag-name-box">
                                <span class="ag-name">${row.name}</span>
                            </span>
                        </button>
                    </div>
                    ${trustColumn && html`<div class="ag-trust-cell empty"></div>`}
                    ${cells((person) => levelCell(person, { folder: row.path, all: [] }))}
                </div>
                ${row.open && browsed(row.rows, depth + 1)}`;
        });

    const nothing = find.active && shown.length === 0 && flat.length === 0;

    return html`<div class=${`ag-wrap ${more ? "more" : ""}`}>
        <div
            class=${`ag-scroll ${trustColumn ? "with-trust" : ""}`}
            ref=${scroller}
            style=${`--n:${people.length};--cells:${people.length > 0 ? `repeat(${people.length}, var(--cw))` : "0px"}`}
        >
            <div class="ag-table" role="table" aria-label=${`Access on ${computer.name}`}>
                <div class="ag-row ag-head" role="row">
                    <div class="ag-first ag-first-head" role="columnheader">
                        <span>${find.group === "sessions" ? "Session" : find.group === "folders" ? "Folder" : "Project or folder"}</span>
                        <${InfoTip} about="Project or folder" text=${TIPS.first} />
                    </div>
                    ${
                        trustColumn &&
                        html`<div class="ag-trust-cell ag-trust-head" role="columnheader">
                            <span>Project trust</span>
                            <${InfoTip} about="Project trust" text=${TIPS.trust} />
                        </div>`
                    }
                    ${people.map(
                        (person) => html`<div
                            class="ag-cell ag-who"
                            role="columnheader"
                            key=${person.id}
                            title=${person.name}
                        >
                            <${Avatar} person=${person} size=${20} />
                            <span class="ag-who-text">
                                <span class="ag-who-name">${person.name}</span>
                                <span class="ag-who-role">${roleWord(person)}</span>
                            </span>
                        </div>`,
                    )}
                </div>
                ${
                    find.group === "sessions"
                        ? groups.inOrder("\0flat", flat).map((row) => sessionRow(row, 0, undefined))
                        : shown.map(
                              (each, index) =>
                                  html`${
                                      projectsShown > 0 &&
                                      index === projectsShown &&
                                      html`<div class="ag-row ag-heading" role="row" key="other-heading">
                                          <div class="ag-first">Other folders</div>
                                      </div>`
                                  }${folderRow(each, 0, undefined)}`,
                          )
                }
                ${
                    all.shown &&
                    html`<div class="ag-row ag-all" key="all-folders" role="row">
                            <div class="ag-first" role="rowheader">
                                <button
                                    type="button"
                                    class="ag-toggle"
                                    aria-expanded=${all.open}
                                    aria-label=${`${all.open ? "Close" : "Open"} All folders of ${computer.name}`}
                                    title=${`Every folder on ${computer.name}`}
                                    onClick=${all.toggle}
                                >
                                    <${Icon} name="chevron" size=${11} class=${`chev ${all.open ? "open" : ""}`} />
                                    <${Icon} name="monitor" size=${13} />
                                    <span class="ag-name-box">
                                        <span class="ag-name">All folders</span>
                                    </span>
                                </button>
                            </div>
                        </div>
                        ${all.open && browsed(all.rows, 1)}`
                }
                ${
                    nothing &&
                    html`<div class="ag-row ag-empty" role="row">
                        <div class="ag-first">
                            <span class="muted small">Nothing here matches. <button type="button" class="access-clear" onClick=${find.clear}>Clear</button></span>
                        </div>
                    </div>`
                }
            </div>
            ${after && html`<div class="ag-after">${after}</div>`}
        </div>
        <div class="ag-fade" aria-hidden="true"></div>
    </div>`;
}

/** The people who can be chosen for `computer`, each a column of its grid while chosen. */
export function peopleOf(computer) {
    return store.state.users.filter(
        (person) => person.role !== "owner" && choosable(computer, person) && inCharge(computer),
    );
}
