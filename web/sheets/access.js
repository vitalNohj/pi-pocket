// Who may use a computer, in which folders, and which sessions they have there (`src/server/access.ts`): the parts the
// Runners sheet (by computer) and the People sheet (by person) share, so a choice made in one is the same choice in the
// other. Both change the one record kept on the server, over the same routes (`POST /api/runners/:id/users`,
// `/given`, `/sees`, and `/rights`, `POST /api/sessions/:id/revoke`). One person on one computer is a switch and, under it, one
// tree with the rows of the Files panel's: the folders given to them there, and in each the sessions they have in it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
    api,
    attempt,
    closeSheet,
    declaredRights,
    managesRunners,
    navigate,
    notify,
    store,
} from "../store.js";
import { html, Icon, Marked, Switch } from "../ui.js";
import {
    accessFolder as accessFolderOf,
    ago,
    arrange,
    below,
    foldersOf,
    inFolder as inFolderOf,
    hitsOf,
    keeps,
    keepsFolder,
    leaving,
    levelOf,
    orderOf,
    ranked,
    seenBy,
} from "./access-tree.js";
import { shortPath } from "../folder-paths.js";
import { canShare } from "./session-share.js";

export const THIS_SERVER = "this-server";

/**
 * Whether I am in charge of a computer (`access.ts` `inCharge`): the server says (`inCharge` on its record), since
 * besides its linker, and this server's owner, that is whoever manages runners on this server and the runners the
 * owner linked. A server from before it does not say: its linker, or for this server the owner. Nobody is in charge of
 * a blocked computer: its linker is a viewer now (`blocked`).
 */
export function inCharge(computer) {
    return (
        computer.inCharge ??
        (computer.id === THIS_SERVER
            ? store.state.me?.role === "owner"
            : computer.createdBy === store.state.me?.id && !computer.blocked)
    );
}

/** The computers this person knows of: this server first (the owner's alone to know), then the linked ones. */
export function computers() {
    const { runners, thisServer } = store.state;

    return [...(thisServer ? [thisServer] : []), ...runners];
}

/** Read the computers again: a sheet that opens shows them as they are now. */
export async function loadComputers() {
    // This server's record is the business of who is in charge of it: the owner, and who manages runners.
    const [list, server] = await Promise.all([
        api("runners"),
        managesRunners() ? api("runners/this-server") : null,
    ]);

    store.set({ runners: list, thisServer: server });
}

/** Whether `person` can be chosen for `computer`: not who is in charge of it, who has it anyway. */
export function choosable(computer, person) {
    return computer.id === THIS_SERVER ? person.role !== "owner" : person.id !== computer.createdBy;
}

/** Whether `person` is among the people chosen for `computer`. */
export function chosenFor(computer, person) {
    return (computer.users ?? []).some((each) => each.id === person.id);
}

/**
 * Who a computer's sessions go to when they are taken from someone: the one person they are handed to (`access.ts`
 * `inChargeOf`), its linker, the owner for this server. "you" for that person; their name for a user who is in charge
 * there because they manage runners.
 */
export function heir(computer) {
    return computer.createdBy === store.state.me?.id
        ? "you"
        : (store.state.users.find((each) => each.id === computer.createdBy)?.name ?? "the owner");
}

/** A computer as the server answered it after a change: shown at once, before its event arrives. */
function keep(view) {
    if (!view) {
        return;
    }

    if (view.id === THIS_SERVER) {
        store.set({ thisServer: view });
    } else {
        store.set({
            runners: store.state.runners.map((each) => (each.id === view.id ? view : each)),
        });
    }
}

const route = (computer, part) => `runners/${encodeURIComponent(computer.id)}/${part}`;

/**
 * Take `computer` from `person`, or let them use it, as its switch does: said first what that takes from them. True
 * when it was saved.
 */
export function toggleUse(computer, person) {
    const { chosen, manager } = standing(computer, person);

    if (
        chosen &&
        !confirm(
            manager
                ? `Take ${computer.name} from ${person.name}? They manage runners, so they stay in charge of it and nothing moves now. They keep nothing here once that ends.`
                : `Take ${computer.name} from ${person.name}? They leave its sessions at once, and the sessions they started there move to ${heir(computer)}.`,
        )
    ) {
        return Promise.resolve(false);
    }

    return choosePerson(computer, person, !chosen);
}

/**
 * Change what `person` has of `folder` on `computer` to `level` (`app.ts` `setFolderLevel`). Taking it back says first
 * which of the sessions they started go with it, to who is in charge. True when it was saved.
 */
export async function setLevelOf(computer, person, folder, level) {
    if (level === "none") {
        const there = store.state.sessions.filter(
            (each) => (each.runner ?? THIS_SERVER) === computer.id,
        );
        const gone = leaving(
            folder,
            computer.given?.[person.id] ?? [],
            there.filter((each) => each.createdBy === person.id),
            there.filter((each) => each.worktree),
        ).length;

        if (
            gone > 0 &&
            !confirm(
                `Take ${folder} from ${person.name}? ${gone === 1 ? "The session they started in it moves" : `The ${gone} sessions they started in it move`} to ${heir(computer)}, with the tasks they set up there. Sessions shared with them stay.`,
            )
        ) {
            return false;
        }
    }

    return attempt(async () => {
        keep(await api(route(computer, "level"), { person: person.id, folder, level }));

        return true;
    });
}

/**
 * What `person` has of `folder` on `computer` (`access-tree.js` `levelOf`), and with none of its own, the nearest
 * folder above it they have, with its level (`from`): they have that one here too.
 */
export function levelFor(computer, person, folder) {
    const given =
        chosenFor(computer, person) && !person.sessions ? (computer.given?.[person.id] ?? []) : [];
    const sees = seenFolders(computer, person);
    const until = untilOf(computer, person);
    const level = levelOf(folder, given, sees, until);

    if (level !== "none") {
        return { level };
    }

    const holder = given
        .filter((each) => each !== folder && inFolderOf(folder, each))
        .sort((one, other) => other.length - one.length)[0];

    return holder === undefined
        ? { level }
        : { level, from: { folder: holder, level: levelOf(holder, given, sees, until) } };
}

/**
 * The projects on a computer I am in charge of and how Pi trusts their folders (`GET /api/runners/:id/projects`), as
 * the server last said: kept in the store, so the sheet shows them at once when it opens again. Undefined until known.
 */
export function projectsOf(computer) {
    return store.state.accessProjects?.[computer.id];
}

/** Keep what the server said of a computer's projects (`projectsOf`). */
export function keepProjects(id, answer) {
    store.set({ accessProjects: { ...store.state.accessProjects, [id]: answer } });
}

/**
 * Ask again for the projects of every computer I am in charge of, all at once. One that cannot be asked keeps what was
 * known of it.
 */
export function loadProjects() {
    return Promise.all(
        computers()
            .filter(inCharge)
            .map((computer) =>
                api(route(computer, "projects")).then(
                    (answer) => keepProjects(computer.id, answer),
                    () => undefined,
                ),
            ),
    );
}

/**
 * Save how Pi trusts `folders` on `computer` (`POST /api/runners/:id/trust`: `choice` is "trust", "trust-parent", or
 * "distrust"), and keep the projects the server answers: a decision for a folder above changes other projects too.
 */
export function setTrust(computer, folders, choice) {
    return attempt(async () =>
        keepProjects(computer.id, await api(route(computer, "trust"), { folders, choice })),
    );
}

/**
 * How Pi trusts a project's folders (`src/server/projects.ts` `ProjectView.trust`: its root first, then each folder
 * outside it): `mixed` when they do not all have one answer. Undefined when the server could not read it.
 */
export function trustOfProject(project) {
    const entries = project.trust;

    if (entries === undefined || entries.length === 0) {
        return undefined;
    }

    return {
        entries,
        root: entries[0],
        mixed: entries.some((each) => each.trusted !== entries[0].trusted),
    };
}

/**
 * The small tag beside a project's name where nobody changes its trust (By person): "Not trusted" for a decision
 * against it, "Mixed" where its folders differ; nothing when it is trusted or nobody decided yet.
 */
export function trustTag(project) {
    const trust = trustOfProject(project);

    if (trust === undefined) {
        return undefined;
    }

    if (trust.mixed) {
        return "Mixed";
    }

    return trust.root.saved !== null && !trust.root.trusted ? "Not trusted" : undefined;
}

/** Choose one person for a computer, or no longer: the others stay as they are now. True when it was saved. */
export function choosePerson(computer, person, on) {
    return attempt(async () => {
        keep(await api(route(computer, "users"), { person: person.id, on }));

        return true;
    });
}

/**
 * Give `person` one right on `computer`, or take it back (`app.ts` `setRight`): `wheel`, to take the wheel from a
 * driver there; `allows`, to allow a call their own message led to there; `reshares`, to share what they were given
 * there. True when it was saved.
 */
export function setRight(computer, person, right, on) {
    return attempt(async () => {
        keep(await api(route(computer, "rights"), { person: person.id, right, on }));

        return true;
    });
}

/**
 * One of those rights, as the server declares it (`each`: `rights.ts`, `store.js` `declaredRights`): under a person's
 * switch for a computer, once they prompt there.
 */
function RightSwitch({ computer, person, each }) {
    const [busy, setBusy] = useState(false);
    const on = computer.rights[each.key].includes(person.id);

    const flip = async () => {
        setBusy(true);

        try {
            await setRight(computer, person, each.key, !on);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="setting wrap" data-right=${each.key}>
        <div class="grow">
            <div class="small">${each.label}</div>
            <div class="muted small">${on ? each.on : (each.off ?? each.on)}</div>
        </div>
        <${Switch}
            on=${on}
            disabled=${busy}
            label=${`${person.name} ${each.says} ${computer.name}: ${on ? "on" : "off"}`}
            onChange=${flip}
        />
    </div>`;
}

/**
 * The rights given one person at a time on `computer` (`rights.ts`), for those who prompt there: chosen, not a viewer,
 * not held to one session. A computer's view names who holds each only for who manages it.
 */
export function rightsFor(computer, person) {
    return chosenFor(computer, person) &&
        person.role !== "viewer" &&
        !person.sessions &&
        computer.rights
        ? declaredRights("computer").filter((each) => Array.isArray(computer.rights[each.key]))
        : [];
}

/**
 * Those rights of one person on one computer, as a group of their own: a person's page in People shows them with what
 * else the person is let do, apart from their folders and sessions there. Nothing where there is none to give.
 */
export function ComputerRights({ computer, person }) {
    const rights = rightsFor(computer, person);

    if (rights.length === 0) {
        return null;
    }

    return html`<div class="group">
        <div class="group-title">On ${computer.name}</div>
        ${rights.map(
            (each) =>
                html`<${RightSwitch}
                    key=${each.key}
                    computer=${computer}
                    person=${person}
                    each=${each}
                />`,
        )}
    </div>`;
}

/**
 * One session as a line of a tree: its name, how the person has it, where it works, and at its end what is done with
 * it (`children`: its buttons). The tree of a computer draws its sessions with it, and so does the list of one's own
 * sessions on a computer someone else is in charge of (`people.js` `OtherComputer`). The three are one group that
 * takes more lines where one is too short (`style.css` `.at-about`): a place is never cut short, since its end is what
 * tells two folders apart. `off`: one the person does not have, listed to be given: its name is dimmed. `used`: when
 * whoever reads last used it themselves, after what it says. `words`: what is searched for, marked in its name and
 * its place.
 */
export function SessionLine({
    name,
    how,
    where,
    used,
    words = [],
    off = false,
    depth = 1,
    children,
}) {
    return html`<div class=${`at-line at-session ${off ? "off" : ""}`}>
        <div class="ft-row" style=${`--depth:${depth}`} title=${name}>
            <span class="ft-spacer"></span>
            <${Icon} name="chat" size=${13} />
            <span class="at-about">
                <span class="at-session-name">
                    <${Marked} text=${name} hits=${hitsOf(name, words)} />
                </span>
                <span class="at-how">${how}</span>
                ${
                    where &&
                    html`<span class="at-where" title=${where}>
                        <${Marked} text=${where} hits=${hitsOf(where, words)} />
                    </span>`
                }
            </span>
            ${
                used !== undefined &&
                html`<span
                    class="at-used"
                    title=${`Last used by you: ${new Date(used).toLocaleString()}`}
                >
                    ${ago(used, Date.now())}
                </span>`
            }
        </div>
        <div class="at-actions">${children}</div>
    </div>`;
}

/**
 * The folders on `computer` in which `person` sees every session (`access.ts` `seesFolder`): among the ones given to
 * them there, while they use it and are not held to one session. A viewer's too, who reads them.
 */
export function seenFolders(computer, person) {
    if (!chosenFor(computer, person) || person.role === "owner" || person.sessions) {
        return [];
    }

    const given = computer.given?.[person.id] ?? [];

    return (computer.sees?.[person.id] ?? []).filter((each) => given.includes(each));
}

/** Of those, the ones `person` sees only the sessions made up to a time in ("Sessions so far"): that time, by folder. */
export const untilOf = (computer, person) => computer.seesUntil?.[person.id] ?? {};

/** The home folder of `computer`, as the tree's top row: this server's, or a runner's as it said when it connected. */
export function homeOf(computer) {
    return computer.id === THIS_SERVER ? store.state.server?.home : computer.home;
}

/** Whether `person` has `session` in their own right: they started it, it is shared with them, or they were invited to it. */
export const holds = (person, session) =>
    session.createdBy === person.id ||
    session.sharedWith?.includes(person.id) === true ||
    person.sessions?.includes(session.id) === true;

/**
 * The sessions `person` has on `computer`, of the ones I see (who is in charge of it sees every one): the ones they
 * started, the ones shared with them, one they were invited to alone, and every one in a folder they see all of.
 */
export function sessionsOf(computer, person) {
    const there = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id,
    );
    const sees = seenFolders(computer, person);
    const until = untilOf(computer, person);

    return there.filter(
        (each) => holds(person, each) || seenBy(sees, each, there, until) !== undefined,
    );
}

/** Whether a session is locked now: its approval ended, or was revoked, and nobody renewed it (`folder-approvals.ts`). */
export function locked(session) {
    return (store.state.folderApprovals ?? []).some(
        (each) =>
            each.session === String(session.id) &&
            (each.ended || (each.expiresAt !== null && each.expiresAt <= Date.now())),
    );
}

/** What the group of sessions in no given folder is opened by, in the tree's own record of what is open. */
const OTHER = "\0other";

/** The owner's id: a session from before sessions had a starter is theirs (`access.ts` `starter`). */
const ownerId = () => store.state.users.find((each) => each.role === "owner")?.id;

/**
 * How `person` stands on `computer`: chosen for it; in charge of it because they manage runners (`manager`); starting
 * sessions there, so with folders (`starts`); and someone sessions there can be given to one at a time (`offers`:
 * chosen, not held to one session, not in charge).
 */
export function standing(computer, person) {
    const chosen = chosenFor(computer, person);
    const manager = computer.managers?.includes(person.id) === true;

    return {
        chosen,
        manager,
        starts: chosen && person.role === "guest" && !person.sessions,
        offers: chosen && !person.sessions && !manager,
    };
}

/**
 * One person's folders on one computer and the sessions in them, as the tree draws them and as a search over it counts
 * them: a row for the computer's home folder, always first; one for each folder given to them there; and one for each
 * folder a listed session works in (`access-tree.js` `foldersOf`), nested by path. `giving`: the tree also lists the
 * sessions there that are mine to share and that they do not have, each to be given (People); without it, only
 * theirs (Runners). An archived session is never listed. Null where there is no tree: someone not chosen there who
 * has no session there.
 *
 * A folder: its path, whether it is Home, what they have of it (`level`: `access-tree.js` `levelOf`), its sessions
 * (`rows`), the folders under it (`children`), and every session in it and under it (`all`). A session row: the
 * session, whether they have it themselves (`own`: started, shared, invited alone) or by a folder they see the
 * sessions of (`by`), when whoever reads last used it (`usedAt`), who started it, and the folders a search finds it by
 * (`places`).
 */
export function treeOf(computer, person, giving, { group = "folders", projects } = {}) {
    const { chosen, manager, starts, offers } = standing(computer, person);
    const there = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id,
    );
    // Where a session counts as working asks only about the sessions with a worktree (`access-tree.js`
    // `accessFolder`): with every session of the computer listed, the others are left out of that search.
    const worktrees = there.filter((each) => each.worktree);
    const sees = seenFolders(computer, person);
    const until = untilOf(computer, person);
    const theirs = (session) =>
        holds(person, session) || seenBy(sees, session, worktrees, until) !== undefined;
    // Archived ones too: whether they have anything here at all.
    const held = there.filter(theirs);

    if (!chosen && held.length === 0) {
        return null;
    }

    // Folders are kept for whoever uses the computer, a viewer too; someone in charge has every one anyway.
    const given = chosen && !person.sessions ? (computer.given?.[person.id] ?? []) : [];
    const gives = giving && offers;
    const listed = there.filter(
        (each) => !each.archived && (theirs(each) || (gives && canShare(each))),
    );
    const home = homeOf(computer);
    const homeKey = home === undefined ? undefined : foldersOf(home, [], [], [])[0]?.folder;
    const owner = ownerId();

    const row = (session, folder) => {
        const own = holds(person, session);
        const by = own ? undefined : seenBy(sees, session, worktrees, until);

        return {
            id: session.id,
            session,
            title: session.title ?? "New session",
            own,
            by,
            has: own || by !== undefined,
            usedAt: session.usedAt,
            updatedAt: session.updatedAt,
            starter: session.createdBy ?? owner,
            places: [session.cwd, folder],
        };
    };

    // `from`: the nearest folder above with a level, which this one has too while it has none of its own.
    const nodeOf = (node, from) => {
        const level = levelOf(node.folder, given, sees, until);
        const children = node.children.map((each) =>
            nodeOf(each, level === "none" ? from : { folder: node.folder, level }),
        );
        const rows = node.sessions.map((each) => row(each, node.folder));

        return {
            key: node.project ? `project:${node.folder}` : node.folder,
            folder: node.folder,
            ...(node.project ? { project: node.project } : {}),
            home: node.folder === homeKey && !node.project,
            level,
            ...(level === "none" && from !== undefined ? { from } : {}),
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

    // A project's row has the level of the folder above it that has one, as a folder's does.
    const above = (folder) => {
        const holder = given
            .filter((each) => each !== folder && inFolderOf(folder, each))
            .sort((one, other) => other.length - one.length)[0];

        return holder === undefined
            ? undefined
            : { folder: holder, level: levelOf(holder, given, sees, until) };
    };

    const roots = arranged.roots.map((each) =>
        nodeOf(each, each.project ? above(each.folder) : undefined),
    );
    const folders = roots.flatMap(function flat(node) {
        return [node, ...node.children.flatMap(flat)];
    });
    const flat = (arranged.flat ?? []).map((each) => row(each, accessFolderOf(each, worktrees)));

    return {
        chosen,
        manager,
        starts,
        offers: gives,
        sees,
        until,
        there,
        worktrees,
        given,
        held,
        roots,
        other: arranged.other,
        flat,
        folders,
        rows: [...folders.flatMap((each) => each.rows), ...flat],
    };
}

/**
 * The folders of a tree (`treeOf`) that show under what is searched for and filtered by (`find`), nested as they are:
 * each with the sessions it lists (`listed`) and the folders under it that show. A folder shows while a session in it
 * or under it is listed, or its own path is what was searched for; with nothing searched for, every one shows.
 */
export function shownOf(nodes, find = NO_FIND) {
    return nodes.flatMap((node) => {
        const children = shownOf(node.children, find);
        const listed = node.rows.filter((row) => keeps(find, row));

        return !find.active ||
            listed.length > 0 ||
            children.length > 0 ||
            keepsFolder(find, node.folder)
            ? [{ ...node, children, listed }]
            : [];
    });
}

/** What a tree reads where nothing is searched for or filtered: every row is listed, and no change is noted. */
const NO_FIND = {
    words: [],
    access: "",
    time: "",
    by: "",
    active: false,
    kept: new Set(),
    now: 0,
    stamp: "",
    keep() {},
};

/**
 * Which rows of a tree are open, and the order of the sessions in each open one. Nothing searched for (`find`): a row
 * is closed until opened by hand. A search or a filter opens every row it lists, until one is closed by hand; that
 * starts over when what is searched for changes (`find.stamp`).
 *
 * `inOrder(key, rows)`: the sessions of row `key` as they stood when it was first drawn open, the one whoever reads
 * used last first (`access-tree.js` `orderOf`, `ranked`): a session stays where it is while its button changes, or it
 * is used. Closing the row, or a change of what is searched for, lets go of that order.
 */
export function useGroups(find = NO_FIND) {
    const [open, setOpen] = useState(() => new Set());
    const [shut, setShut] = useState(() => ({ stamp: find.stamp, keys: new Set() }));
    const orders = useRef({ stamp: find.stamp, at: new Map() });

    if (orders.current.stamp !== find.stamp) {
        orders.current = { stamp: find.stamp, at: new Map() };
    }

    const closed = shut.stamp === find.stamp ? shut.keys : new Set();

    return {
        isOpen: (key) => (find.active ? !closed.has(key) : open.has(key)),
        toggle(key) {
            orders.current.at.delete(key);

            if (find.active) {
                const keys = new Set(closed);

                if (!keys.delete(key)) {
                    keys.add(key);
                }

                setShut({ stamp: find.stamp, keys });
            } else {
                setOpen((now) => {
                    const next = new Set(now);

                    if (!next.delete(key)) {
                        next.add(key);
                    }

                    return next;
                });
            }
        },
        inOrder(key, rows) {
            let order = orders.current.at.get(key);

            if (order === undefined) {
                order = orderOf(rows);
                orders.current.at.set(key, order);
            }

            return ranked(rows, order);
        },
    };
}

/**
 * The rows of a tree that open: for a computer someone else is in charge of as `people.js` shapes it, its folders,
 * then the sessions outside them, each with the sessions it lists under what is searched for and filtered by
 * (`listed`), and a row with nothing to list left out, but for a folder that is itself what was searched for. For a
 * tree of `treeOf`, its top folders as `shownOf` keeps them.
 */
export function groupsOf(tree, find = NO_FIND) {
    if (tree.roots !== undefined) {
        return shownOf(tree.roots, find);
    }

    return [
        ...tree.folders.map((each) => ({ key: each.folder, ...each })),
        ...(tree.other.length > 0 || !tree.starts ? [{ key: OTHER, rows: tree.other }] : []),
    ]
        .map((each) => ({ ...each, listed: each.rows.filter((row) => keeps(find, row)) }))
        .filter(
            (each) =>
                !find.active ||
                each.listed.length > 0 ||
                (each.folder !== undefined && keepsFolder(find, each.folder)),
        );
}

/** How many of a row's sessions the person has: "2 of 5" where it lists others too. */
export function countOf(rows) {
    const theirs = rows.filter((each) => each.has).length;

    return theirs === rows.length ? String(theirs) : `${theirs} of ${rows.length}`;
}

/**
 * One row of a tree that opens: a folder (`folder`), or the sessions outside the folders. Its name, how many sessions
 * the person has in it (`count`), at its end what is done with the folder (`actions`), and under it, open, its
 * sessions (`children`). `off`: a folder the person does not have, listed to be given. `words`: what is searched for,
 * marked in a folder's name. `depth`: how far in the tree it is, as the Files panel's rows. `home`: the computer's
 * home folder, with its own icon. `project`: a project's row, named for it, with its top folder's path (`path`) and a
 * small tag (`tag`: "Not trusted") beside its name.
 */
export function TreeGroup({
    folder = false,
    home = false,
    project = false,
    path,
    tag,
    name,
    label,
    count,
    title,
    depth = 0,
    open,
    onToggle,
    words = [],
    off = false,
    actions,
    children,
}) {
    return html`<div class=${`at-node ${off ? "off" : ""}`}>
        <div class=${`at-line ${folder ? "at-folder-line" : ""}`}>
            <button
                type="button"
                class=${`ft-row dir ${folder || project ? "at-folder" : "at-rest"} ${project ? "at-project" : ""}`}
                style=${`--depth:${depth}`}
                aria-expanded=${open}
                aria-label=${label}
                title=${title}
                onClick=${onToggle}
            >
                <${Icon} name="chevron" size=${11} class=${`chev ${open ? "open" : ""}`} />
                <${Icon} name=${project ? "fork" : home ? "home" : folder ? "folder" : "chat"} size=${13} />
                <span class="ft-name">
                    ${
                        project
                            ? html`<${Marked} text=${name} hits=${hitsOf(name, words)} />${tag && html`<span class="at-trust-tag">${tag}</span>`}${path && html`<span class="at-path">${path}</span>`}`
                            : folder
                              ? pathParts(name).map(
                                    ([part, at]) =>
                                        html`<${Marked}
                                              text=${part}
                                              hits=${hitsOf(name, words)
                                                  .filter(
                                                      (each) =>
                                                          each >= at && each < at + part.length,
                                                  )
                                                  .map((each) => each - at)}
                                          /><wbr />`,
                                )
                              : name
                    }
                </span>
                <span class="at-count">${count}</span>
            </button>
            ${actions && html`<div class="at-actions">${actions}</div>`}
        </div>
        ${open && children}
    </div>`;
}

/** A path in parts that each end in a separator, with where each starts: a long path breaks only after one. */
const pathParts = (path) => {
    const parts = path.match(/[^\\/]*[\\/]?/g).filter(Boolean);
    let at = 0;

    return parts.map((part) => {
        const start = at;

        at += part.length;

        return [part, start];
    });
};

/**
 * Where a menu or a note that opens from `button` goes: under it, or above it where the sheet has no room under it,
 * kept inside the sheet (`.sheet`) on both sides. Fixed to the screen, so a list or a grid that scrolls does not cut
 * it off. `width`, `height`: the menu's own size.
 */
export function placeIn(button, width, height) {
    const at = button.getBoundingClientRect();
    const sheet = button.closest(".sheet")?.getBoundingClientRect() ?? {
        top: 0,
        left: 0,
        right: innerWidth,
        bottom: innerHeight,
    };
    const below = sheet.bottom - at.bottom - 8;
    const above = at.top - sheet.top - 8;
    const up = height > below && above > below;
    const left = Math.max(sheet.left + 8, Math.min(at.right - width, sheet.right - 8 - width));

    return {
        up,
        left,
        top: up ? Math.max(sheet.top + 8, at.top - 4 - height) : at.bottom + 4,
        maxHeight: Math.max(120, up ? above : below),
    };
}

/**
 * A menu button (`PopMenu`): the Access menu of a folder (`LevelMenu`) and the trust menu of a project
 * (`access-grid.js` `TrustMenu`) are this one control. The button shows `face`; open, one item for each of `items`
 * (`{ key, name, says, checked }`), with the checked one marked and focused. `onPick(key)` for another than the
 * checked one. Escape, a press outside, or a scroll around it closes it. It opens where there is room in the sheet
 * (`placeIn`).
 */
export function PopMenu({ face, buttonClass, label, title, disabled, menuLabel, items, onPick }) {
    const [open, setOpen] = useState(false);
    const [place, setPlace] = useState(null);
    const box = useRef(null);
    const menu = useRef(null);
    const button = useRef(null);

    useLayoutEffect(() => {
        if (!open || !menu.current || !button.current) {
            setPlace(null);

            return;
        }

        setPlace(placeIn(button.current, menu.current.offsetWidth, menu.current.scrollHeight));
        (
            menu.current.querySelector('[aria-checked="true"]') ??
            menu.current.querySelector("button")
        )?.focus({ preventScroll: true });
    }, [open]);

    // A press outside closes it, as a menu does; so does a scroll of what holds it, which would leave it behind.
    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const outside = (event) => {
            if (!box.current?.contains(event.target)) {
                setOpen(false);
            }
        };

        // The scroll that brought the button into sight as it opened does not close it.
        const opened = Date.now();

        const scrolled = (event) => {
            if (!menu.current?.contains(event.target) && Date.now() - opened > 250) {
                setOpen(false);
            }
        };

        addEventListener("pointerdown", outside, true);
        addEventListener("scroll", scrolled, true);
        addEventListener("resize", scrolled);

        return () => {
            removeEventListener("pointerdown", outside, true);
            removeEventListener("scroll", scrolled, true);
            removeEventListener("resize", scrolled);
        };
    }, [open]);

    const onKey = (event) => {
        const all = [...(menu.current?.querySelectorAll("button") ?? [])];
        const index = all.indexOf(document.activeElement);

        if (event.key === "Escape" && open) {
            // Escape closes the menu, not the sheet around it.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
        } else if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            all[(index + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
        }
    };

    return html`<div class="at-level-box" ref=${box} onKeyDown=${onKey}>
        <button
            ref=${button}
            type="button"
            class=${`button small at-level ${buttonClass ?? ""}`}
            aria-haspopup="menu"
            aria-expanded=${open}
            aria-label=${label}
            title=${title}
            disabled=${disabled}
            onClick=${(event) => {
                // A button half out of a scroller's sight comes into it first, so its menu opens beside it.
                event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                setOpen(!open);
            }}
        >
            ${face}
            <${Icon} name="down" size=${11} />
        </button>
        ${
            open &&
            html`<div
                class=${`at-level-menu ${place?.up ? "up" : ""}`}
                role="menu"
                aria-label=${menuLabel}
                ref=${menu}
                style=${
                    place
                        ? `left:${place.left}px;top:${place.top}px;max-height:${place.maxHeight}px`
                        : "visibility:hidden;left:0;top:0"
                }
            >
                ${items.map(
                    (each) => html`<button
                        key=${each.key}
                        type="button"
                        class="at-level-item"
                        role="menuitemradio"
                        aria-checked=${each.checked ? "true" : "false"}
                        onClick=${() => {
                            setOpen(false);

                            if (!each.checked) {
                                onPick(each.key);
                            }
                        }}
                    >
                        <span class="at-level-name">
                            ${each.name}
                            ${each.checked && html`<${Icon} name="check" size=${13} />`}
                        </span>
                        ${each.says.map((line) => html`<span class="at-level-says">${line}</span>`)}
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}

/**
 * The levels of the Access menu of a folder's row (`src/server/config.ts` `FolderLevel`), each including the ones
 * before it: its name in the menu, what the row says when it is chosen, and the one line under its name that says
 * what the person gets. A viewer's menu has no "start": they read, and start nothing.
 */
export const LEVELS = {
    none: {
        name: "No access",
        short: "None",
        user: "Nothing in this folder but the sessions shared with them.",
        viewer: "Nothing in this folder but the sessions shared with them.",
    },
    start: {
        name: "Start sessions",
        short: "Start",
        user: "They start sessions here, and see theirs and the ones shared with them.",
    },
    past: {
        name: "Sessions so far",
        short: "So far",
        user: "They start sessions here, and see every session here now, not later ones.",
        viewer: "They read every session here now, whoever started it. Not later ones.",
    },
    all: {
        name: "All sessions",
        short: "All",
        user: "They start sessions here, and see every session here, also later ones.",
        viewer: "They read every session here, whoever started it, also later ones.",
    },
};

/** The levels `person` can be given in the Access menu: a viewer's have no "start". */
export const levelsFor = (person) =>
    person.role === "viewer" ? ["none", "past", "all"] : ["none", "start", "past", "all"];

/**
 * The Access menu of a folder (`PopMenu`): a button that says what the person has of it now (`level`, in that level's
 * colour), and open, one item for each level they can be given (`levels`), each with what they get (`LEVELS`).
 * `reason`: why nothing can be changed here; the button is then off, with the reason beside it, or in its title
 * where there is no room beside it (`compact`: a cell of the grid).
 */
export function LevelMenu({
    person,
    folder,
    where,
    level,
    from,
    levels,
    reason,
    busy,
    compact = false,
    onPick,
}) {
    const viewer = person.role === "viewer";
    // With no level of its own, a folder has the one of the folder above it that has one (`from`): said, quietly.
    const shown = from?.level ?? level;

    return html`${reason && !compact && html`<span class="at-sees at-reason">${reason}</span>`}
        <${PopMenu}
            face=${html`<span>${LEVELS[shown].short}</span>`}
            buttonClass=${`lv-${shown} ${level === "none" ? "ghost" : ""} ${from ? "inherited" : ""}`}
            label=${`Access of ${person.name} to ${folder} on ${where}: ${LEVELS[shown].name}${from ? ` (from ${from.folder})` : ""}`}
            title=${reason ?? (from ? `${LEVELS[shown].name}, from ${from.folder}` : `Access: ${LEVELS[level].name}`)}
            disabled=${busy || Boolean(reason)}
            menuLabel=${`Access of ${person.name} to ${folder}`}
            items=${levels.map((each) => ({
                key: each,
                name: LEVELS[each].name,
                says: [LEVELS[each][viewer ? "viewer" : "user"]],
                checked: each === level,
            }))}
            onPick=${onPick}
        />`;
}

/** The "i" of an explanation: one SVG drawn about its centre (a circle, a dot, a stem), 14 px at every width. */
function InfoGlyph() {
    return html`<svg class="info-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" stroke-width="1.5" />
        <circle cx="8" cy="4.75" r="1" fill="currentColor" />
        <path d="M8 7v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>`;
}

/**
 * An explanation behind a small "i" (`.info-tip`), the one of this sheet: shown while a mouse is over it and on
 * keyboard focus, and by a tap or a click. Escape or a press outside closes it. It opens where there is
 * room in the sheet (`placeIn`).
 */
export function InfoTip({ about, text }) {
    const [open, setOpen] = useState(false);
    // Opened by a mouse over it: it closes when the mouse leaves, unless it was clicked.
    const hovered = useRef(false);
    const [place, setPlace] = useState(null);
    const button = useRef(null);
    const note = useRef(null);

    useLayoutEffect(() => {
        if (!open || !note.current || !button.current) {
            setPlace(null);

            return;
        }

        setPlace(placeIn(button.current, note.current.offsetWidth, note.current.offsetHeight));
    }, [open]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const outside = (event) => {
            if (!button.current?.contains(event.target) && !note.current?.contains(event.target)) {
                setOpen(false);
            }
        };

        const key = (event) => {
            if (event.key === "Escape") {
                // Escape closes the note, not the sheet around it.
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
            }
        };

        const scrolled = () => setOpen(false);

        addEventListener("pointerdown", outside, true);
        addEventListener("keydown", key, true);
        addEventListener("scroll", scrolled, true);

        return () => {
            removeEventListener("pointerdown", outside, true);
            removeEventListener("keydown", key, true);
            removeEventListener("scroll", scrolled, true);
        };
    }, [open]);

    return html`<button
            ref=${button}
            type="button"
            class="info-tip"
            aria-label=${`About ${about}`}
            aria-expanded=${open}
            onClick=${() => {
                // A click on what a mouse opened already keeps it open, until the mouse leaves or Escape.
                setOpen(hovered.current || !open);
                hovered.current = false;
            }}
            onPointerEnter=${(event) => {
                if (event.pointerType === "mouse") {
                    hovered.current = true;
                    setOpen(true);
                }
            }}
            onPointerLeave=${(event) => {
                if (event.pointerType === "mouse" && hovered.current) {
                    hovered.current = false;
                    setOpen(false);
                }
            }}
            onFocus=${(event) => event.currentTarget.matches(":focus-visible") && setOpen(true)}
            onBlur=${() => setOpen(false)}
        >
            <${InfoGlyph} />
        </button>
        ${
            open &&
            html`<div
                class="info-note"
                role="tooltip"
                ref=${note}
                style=${place ? `left:${place.left}px;top:${place.top}px` : "visibility:hidden;left:0;top:0"}
            >
                ${text}
            </div>`
        }`;
}

/**
 * One person's folders on one computer and their sessions there, as one tree (`treeOf`), with the rows of the Files
 * panel's: the computer's home folder first, then every folder given to them and every folder a listed session works
 * in, nested by path, each closed until opened. A session shows once, in the deepest folder that holds it. Each
 * folder row ends in its Access menu (`LevelMenu`): what the person has of that folder, from nothing to every session
 * in it (`app.ts` `setFolderLevel`), for a viewer too, who reads. A session opens from its row, is taken back alone
 * with Revoke (`app.ts` `revokeSession`), and a locked one is allowed again there. In an open row, the session I used
 * last is first.
 *
 * Where sessions can be given to them (`tree.offers`: People), a row lists every session there that is mine to share,
 * not only theirs, and one they do not have themselves ends in Invite where Revoke would be (`commands.ts`
 * `shareWith`). That button follows only what the person has of the session themselves: a folder whose sessions they
 * see gives them its sessions without changing any of them, so with that taken back each session is as it was.
 *
 * `find`: what People searches for and filters by (`access-tree.js` `keeps`). Then a folder shows while it or a
 * session in it matches, the ones shown are open, and the tree offers no new folder.
 */
function AccessTree({ computer, person, tree, find = NO_FIND }) {
    const { offers, sees, until, worktrees, given: folders } = tree;
    const { chosen, manager, starts } = standing(computer, person);
    const groups = useGroups(find);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const field = useRef(null);
    const on = `${person.name} on ${computer.name}`;
    // Folders are given to whoever uses the computer and is not in charge of it: a viewer too, to read.
    const gives = chosen && !person.sessions && !manager;
    const reason = person.sessions
        ? "Invited to one session only"
        : manager
          ? "In charge here"
          : !chosen
            ? `Not on ${computer.name}`
            : undefined;

    useEffect(() => {
        if (adding) {
            field.current?.focus();
        }
    }, [adding]);

    const setLevel = async (folder, level) => {
        setBusy(true);

        try {
            return await setLevelOf(computer, person, folder, level);
        } finally {
            setBusy(false);
        }
    };

    const add = async () => {
        const folder = draft.trim();

        // What was typed stays when it is refused (not a folder there), to correct it. A user starts sessions in it;
        // a viewer reads every session in it.
        if (folder !== "" && (await setLevel(folder, person.role === "viewer" ? "all" : "start"))) {
            setDraft("");
            setAdding(false);
        }
    };

    // The sessions they started in a folder go with it, to who is in charge: said before it is taken back
    // (`setLevelOf`). Each stays listed under a filter it no longer passes, so the level can be changed back where it is.
    const pick = (node, level) => {
        find.keep(node.all.map((each) => each.id));
        void setLevel(node.folder, level);
    };

    const how = (row, folder) =>
        [
            person.sessions?.includes(row.id)
                ? "invited to it alone"
                : row.session.createdBy === person.id
                  ? "started it"
                  : row.own
                    ? "shared with them"
                    : row.by === undefined
                      ? "not shared with them"
                      : row.by === folder
                        ? "sees the sessions here"
                        : `sees the sessions in ${row.by.split(/[\\/]/).filter(Boolean).at(-1) ?? row.by}`,
            locked(row.session) && "locked until allowed",
        ]
            .filter(Boolean)
            .join(" · ");

    // Where in its folder a session works, when that is not the folder itself.
    const where = ({ session }, folder) =>
        session.worktree ? `⎇ ${session.worktree.branch}` : below(session.cwd, folder);

    const go = (row) => {
        closeSheet();
        navigate(row.id);
    };

    const revoke = async (row) => {
        // A folder whose sessions they see still gives it to them: said, since Revoke then changes little.
        const kept = seenBy(sees, row.session, worktrees, until);
        const still =
            kept === undefined
                ? ""
                : ` They still have it after that: they see the sessions in ${kept}.`;
        const asked = person.sessions?.includes(row.id)
            ? `Take “${row.title}” from ${person.name}? They were invited to it alone.`
            : row.session.createdBy === person.id
              ? `Take “${row.title}” from ${person.name}? They started it: it moves to ${heir(computer)}, with the tasks they set up in it.`
              : `Stop sharing “${row.title}” with ${person.name}?`;

        if (!confirm(asked + still)) {
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

    // Shared with that one person, the others it is shared with left as they are. One they have by its folder is
    // theirs alone from then on too: it stays when the folder is taken back.
    const invite = async (row) => {
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

    const allow = (row) =>
        attempt(() => api(`session-approvals/${encodeURIComponent(row.id)}`, {}));

    /** The buttons at the end of a session's row: Allow, Go to session, and Revoke or Invite. */
    const sessionButtons = (row) => html`${
        locked(row.session) &&
        html`<button
                                    class="button small"
                                    aria-label=${`Allow ${row.title} again`}
                                    onClick=${() => allow(row)}
                                >
                                    Allow
                                </button>`
    }
                            <button
                                class="button small"
                                aria-label=${`Go to ${row.title}`}
                                onClick=${() => go(row)}
                            >
                                Go to session
                            </button>
                            ${
                                // Theirs themselves: Revoke. Not theirs, or theirs by its folder alone: Invite in its
                                // place, where sessions can be given to them. With neither, the place stays, so the
                                // buttons before it are one column down the tree.
                                row.own
                                    ? html`<button
                                          class="button small ghost at-end"
                                          disabled=${busy}
                                          aria-label=${`Revoke ${row.title} from ${person.name}`}
                                          onClick=${() => revoke(row)}
                                      >
                                          Revoke
                                      </button>`
                                    : offers && canShare(row.session)
                                      ? html`<button
                                            class="button small at-end"
                                            disabled=${busy}
                                            aria-label=${`Invite ${person.name} to ${row.title}`}
                                            title=${
                                                row.by === undefined
                                                    ? undefined
                                                    : "They have it through the folder now. Invited, they keep it when that ends."
                                            }
                                            onClick=${() => invite(row)}
                                        >
                                            Invite
                                        </button>`
                                      : html`<span class="at-end" aria-hidden="true"></span>`
                            }`;

    /** The sessions of one open folder, a level in from it. */
    const inside = (node, depth) => html`
        ${node.rows.length === 0 && node.children.length === 0 && html`<div class="ft-row muted at-note" style=${`--depth:${depth}`}>No sessions in it.</div>`}
        ${
            node.listed.length > 0 &&
            html`<div class="at-group" role="group">
                ${groups.inOrder(node.key, node.listed).map(
                    (row) =>
                        html`<${SessionLine}
                            key=${row.id}
                            name=${row.title}
                            how=${how(row, node.folder)}
                            where=${where(row, node.folder)}
                            used=${row.usedAt}
                            words=${find.words}
                            off=${!row.has}
                            depth=${depth}
                        >
                            ${sessionButtons(row)}
                        <//>`,
                )}
            </div>`
        }
    `;

    /** One folder's row, and open, the folders under it, then its sessions. A project's row is named for it. */
    const folderRow = (node, depth, parent) => {
        const name = node.project
            ? node.project.name
            : node.home
              ? "Home"
              : parent === undefined
                ? shortPath(node.folder, homeOf(computer))
                : below(node.folder, parent.folder);
        const tag = node.project ? trustTag(node.project) : undefined;
        // Where sessions are given (People), how many they have of all there; elsewhere (Runners) all are theirs.
        const has = node.all.filter((each) => each.has).length;
        const count = offers ? `${has} of ${node.all.length}` : String(has);

        return html`<${TreeGroup}
            key=${node.key}
            folder=${!node.project}
            project=${Boolean(node.project)}
            home=${node.home}
            name=${name}
            path=${node.project ? shortPath(node.folder, homeOf(computer)) : undefined}
            tag=${tag}
            title=${node.folder}
            depth=${depth}
            label=${`${node.project ? `Project ${node.project.name} (${node.folder})` : `Folder ${node.home ? `Home (${node.folder})` : node.folder}`} of ${on}: ${count}`}
            count=${count}
            open=${groups.isOpen(node.key)}
            onToggle=${() => groups.toggle(node.key)}
            words=${find.words}
            off=${node.level === "none" && !node.all.some((each) => each.has)}
            actions=${html`<${LevelMenu}
                person=${person}
                folder=${node.folder}
                where=${computer.name}
                level=${node.level}
                from=${node.from}
                levels=${levelsFor(person)}
                reason=${reason}
                busy=${busy}
                onPick=${(level) => pick(node, level)}
            />`}
        >
            ${node.children.map((each) => folderRow(each, depth + 1, node))}
            ${inside(node, depth + 1)}
        <//>`;
    };

    const shown = shownOf(tree.roots, find);
    // Grouped by Sessions: one list, newest first, with each session's folder beside its name.
    const flat = tree.flat.filter((row) => keeps(find, row));
    // The rows that are no project's, under their own heading after the projects.
    const projectsShown = shown.filter((each) => each.project).length;

    if (find.active && shown.length === 0 && flat.length === 0) {
        return null;
    }

    return html`<div class="at-tree" role="group" aria-label=${`Folders and sessions of ${on}`}>
        ${!find.active && starts && folders.length === 0 && html`<div class="ft-row muted at-note">No folders yet: ${person.name} cannot start sessions here.</div>`}
        ${shown.map(
            (each, index) =>
                html`${
                    projectsShown > 0 &&
                    index === projectsShown &&
                    html`<div class="at-heading" key="other-heading">Other folders</div>`
                }${folderRow(each, 0, undefined)}`,
        )}
        ${
            flat.length > 0 &&
            html`<div class="at-group" role="group">
                ${groups.inOrder("\0flat", flat).map(
                    (row) =>
                        html`<${SessionLine}
                            key=${row.id}
                            name=${row.title}
                            how=${how(row, row.places[1])}
                            where=${shortPath(row.session.cwd, homeOf(computer))}
                            used=${row.usedAt}
                            words=${find.words}
                            off=${!row.has}
                            depth=${0}
                        >
                            ${sessionButtons(row)}
                        <//>`,
                )}
            </div>`
        }
        ${
            gives &&
            !find.active &&
            (adding
                ? html`<div class="at-line at-adding">
                      <input
                          ref=${field}
                          type="text"
                          placeholder="A folder, as ~/projects/app"
                          aria-label=${`Add a folder for ${on}`}
                          value=${draft}
                          onInput=${(event) => setDraft(event.currentTarget.value)}
                          onKeyDown=${(event) => {
                              if (event.key === "Enter" && !busy) {
                                  void add();
                              } else if (event.key === "Escape") {
                                  // Escape closes the field, not the sheet around it.
                                  event.stopPropagation();
                                  setDraft("");
                                  setAdding(false);
                              }
                          }}
                      />
                      <button
                          class="button small"
                          disabled=${busy || draft.trim() === ""}
                          onClick=${add}
                      >
                          Add
                      </button>
                      <button
                          class="button small ghost"
                          onClick=${() => {
                              setDraft("");
                              setAdding(false);
                          }}
                      >
                          Cancel
                      </button>
                  </div>`
                : html`<button
                      type="button"
                      class="ft-row at-add"
                      aria-label=${`Give ${person.name} a folder on ${computer.name}`}
                      onClick=${() => setAdding(true)}
                  >
                      <span class="ft-spacer"></span>
                      <${Icon} name="plus" size=${13} />
                      <span class="ft-name">Add a folder</span>
                  </button>`)
        }
    </div>`;
}

/**
 * One person on one computer, for who is in charge of it: whether they may use it, then the tree of that computer's
 * folders given to them and their sessions there (`AccessTree`). Runners shows it per person under a computer (`lead`,
 * `title`: the person); People shows it per computer under a person (the computer), and keeps the rights given one
 * person at a time there with what else the person is let do (`rights` false: `ComputerRights`).
 *
 * `find`: People's search and filters over the tree. With it the tree also lists the sessions that can be given to
 * the person; Runners, without it, lists what they have.
 */
export function AccessRow({
    computer,
    person,
    lead,
    title,
    rights: withRights = true,
    find,
    grouping,
}) {
    const [busy, setBusy] = useState(false);
    const tree = treeOf(computer, person, find !== undefined, grouping);
    const { chosen, manager } = standing(computer, person);
    const folders = computer.given?.[person.id] ?? [];
    const rights = withRights ? rightsFor(computer, person) : [];

    // Under a search or a filter, a computer with nothing to list is left out whole.
    if (find?.active && (tree === null || groupsOf(tree, find).length === 0)) {
        return null;
    }

    const toggle = async () => {
        setBusy(true);

        try {
            await toggleUse(computer, person);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="access-row" data-computer=${computer.id}>
        <div class="setting wrap">
            ${lead}
            <div class="grow">
                <div class="small"><strong>${title}</strong></div>
                <div class="muted small">
                    ${
                        person.sessions
                            ? "Invited to one session only: not chosen for a computer."
                            : manager
                              ? chosen
                                  ? "In charge here because they manage runners. If that ends, they keep their access here."
                                  : "In charge here because they manage runners. If that ends, they have no access here."
                              : !chosen
                                ? tree === null
                                    ? "Off: they see nothing of it."
                                    : person.role === "viewer"
                                      ? "Off: they see only the sessions shared with them here."
                                      : "Off: they have only the sessions shared with them here, and start none."
                                : person.role === "viewer"
                                  ? "On: they read the sessions shared with them here, and the ones in the folders they see. View only."
                                  : folders.length === 0
                                    ? "On, with no folders yet: they cannot start sessions here."
                                    : "On: they start sessions in their folders here, and see the ones shared with them."
                    }
                </div>
            </div>
            <${Switch}
                on=${chosen}
                disabled=${busy || Boolean(person.sessions)}
                label=${`${person.name} may use ${computer.name}: ${chosen ? "on" : "off"}`}
                onChange=${toggle}
            />
        </div>
        ${rights.map(
            (each) =>
                html`<${RightSwitch}
                    key=${each.key}
                    computer=${computer}
                    person=${person}
                    each=${each}
                />`,
        )}
        ${
            tree !== null &&
            html`<${AccessTree} computer=${computer} person=${person} tree=${tree} find=${find} />`
        }
    </div>`;
}
