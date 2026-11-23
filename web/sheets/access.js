// Who may use a computer, in which folders, and which sessions they have there (`src/server/access.ts`): the parts the
// Runners sheet (by computer) and the People sheet (by person) share, so a choice made in one is the same choice in the
// other. Both change the one record kept on the server, over the same routes (`POST /api/runners/:id/users`,
// `/given`, `/sees`, and `/rights`, `POST /api/sessions/:id/revoke`). One person on one computer is a switch and, under it, one
// tree with the rows of the Files panel's: the folders given to them there, and in each the sessions they have in it.
import { useEffect, useRef, useState } from "preact/hooks";
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
    accessFolder,
    ago,
    below,
    hitsOf,
    inFolder,
    keeps,
    keepsFolder,
    leaving,
    orderOf,
    placed,
    ranked,
    seenBy,
} from "./access-tree.js";
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

/** Choose one person for a computer, or no longer: the others stay as they are now. True when it was saved. */
export function choosePerson(computer, person, on) {
    return attempt(async () => {
        keep(await api(route(computer, "users"), { person: person.id, on }));

        return true;
    });
}

/**
 * Give `person` one right on `computer`, or take it back (`app.ts` `setRight`): `wheel`, to take the wheel from a
 * driver there; `allows`, to allow a call their own message led to there. True when it was saved.
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
export function SessionLine({ name, how, where, used, words = [], off = false, children }) {
    return html`<div class=${`at-line at-session ${off ? "off" : ""}`}>
        <div class="ft-row" style="--depth:1" title=${name}>
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
 * them there, and only while they start sessions there (chosen, a user, not held to one session).
 */
export function seenFolders(computer, person) {
    if (!chosenFor(computer, person) || person.role !== "guest" || person.sessions) {
        return [];
    }

    const given = computer.given?.[person.id] ?? [];

    return (computer.sees?.[person.id] ?? []).filter((each) => given.includes(each));
}

/** Whether `person` has `session` in their own right: they started it, it is shared with them, or they were invited to it. */
const holds = (person, session) =>
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

    return there.filter((each) => holds(person, each) || seenBy(sees, each, there) !== undefined);
}

/** Whether a session is locked now: its approval ended, or was revoked, and nobody renewed it (`folder-approvals.ts`). */
function locked(session) {
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
function standing(computer, person) {
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
 * One person's folders on one computer and the sessions under them (`access-tree.js` `placed`), as the tree draws them
 * and as a search over it counts them. `giving`: the tree also lists the sessions there that are mine to share and
 * that they do not have, each to be given (People); without it, only theirs (Runners). An archived session is never
 * listed. Null where there is no tree: someone not chosen there who has no session there.
 *
 * A row: the session, whether they have it themselves (`own`: started, shared, invited alone) or by a folder they
 * access all sessions in (`by`), when whoever reads last used it (`usedAt`), who started it, and the folders a search
 * finds it by (`places`).
 */
export function treeOf(computer, person, giving) {
    const { chosen, manager, starts, offers } = standing(computer, person);
    const there = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id,
    );
    // Where a session counts as working asks only about the sessions with a worktree (`access-tree.js`
    // `accessFolder`): with every session of the computer listed, the others are left out of that search.
    const worktrees = there.filter((each) => each.worktree);
    const sees = seenFolders(computer, person);
    const theirs = (session) =>
        holds(person, session) || seenBy(sees, session, worktrees) !== undefined;
    // Archived ones too: whether they have anything here at all.
    const held = there.filter(theirs);

    if (!chosen && held.length === 0) {
        return null;
    }

    const given = starts ? (computer.given?.[person.id] ?? []) : [];
    const gives = giving && offers;
    const shape = placed(
        given,
        there.filter((each) => !each.archived && (theirs(each) || (gives && canShare(each)))),
        worktrees,
    );
    const owner = ownerId();

    const row = (session, folder) => {
        const own = holds(person, session);
        const by = own ? undefined : seenBy(sees, session, worktrees);

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
            places: folder === undefined ? [session.cwd] : [session.cwd, folder],
        };
    };

    const folders = shape.folders.map((node) => ({
        folder: node.folder,
        rows: node.sessions.map((each) => row(each, node.folder)),
    }));
    const other = shape.other.map((each) => row(each, undefined));

    return {
        chosen,
        manager,
        starts,
        offers: gives,
        sees,
        there,
        worktrees,
        given,
        held,
        folders,
        other,
        rows: [...folders.flatMap((each) => each.rows), ...other],
    };
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
 * The rows of a tree that open (`tree`: `treeOf`, or a computer someone else is in charge of as `people.js` shapes
 * it): its folders, then the sessions outside them. Each with the sessions it lists under what is searched for and
 * filtered by (`listed`). Then a row with nothing to list is left out, but for a folder that is itself what was
 * searched for.
 */
export function groupsOf(tree, find = NO_FIND) {
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
 * marked in a folder's path.
 */
export function TreeGroup({
    folder = false,
    name,
    label,
    count,
    title,
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
                class=${`ft-row dir ${folder ? "at-folder" : "at-rest"}`}
                aria-expanded=${open}
                aria-label=${label}
                title=${title}
                onClick=${onToggle}
            >
                <${Icon} name="chevron" size=${11} class=${`chev ${open ? "open" : ""}`} />
                <${Icon} name=${folder ? "folder" : "chat"} size=${13} />
                <span class="ft-name">
                    <${Marked} text=${name} hits=${folder ? hitsOf(name, words) : []} />
                </span>
                <span class="at-count">${count}</span>
            </button>
            ${actions && html`<div class="at-actions">${actions}</div>`}
        </div>
        ${open && html`<div class="at-group" role="group">${children}</div>`}
    </div>`;
}

/**
 * One person's folders on one computer and their sessions there, as one tree (`treeOf`), with the rows of the Files
 * panel's. A folder given to them (they start sessions, so they have folders) holds the sessions in it, and stays
 * closed until opened; the sessions in no given folder are a group of their own. Each row is taken back alone: a
 * folder with Remove, a session with Revoke (`app.ts` `revokeSession`). A session opens from its row, and a locked
 * one is allowed again there. In an open row, the session I used last is first.
 *
 * Where sessions can be given to them (`tree.offers`: People), a row lists every session there that is mine to share,
 * not only theirs, and one they do not have themselves ends in Invite where Revoke would be (`commands.ts`
 * `shareWith`). That button follows only what the person has of the session themselves: a folder they access all
 * sessions in gives them its sessions without changing any of them, so with its switch off again each session is as
 * it was.
 *
 * `find`: what People searches for and filters by (`access-tree.js` `keeps`). Then a row lists only what that keeps,
 * a row with nothing to list is left out, the others are open, and the tree offers no new folder.
 */
function AccessTree({ computer, person, tree, find = NO_FIND }) {
    const { starts, offers, sees, there, worktrees, given: folders } = tree;
    const groups = useGroups(find);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const field = useRef(null);
    const on = `${person.name} on ${computer.name}`;

    useEffect(() => {
        if (adding) {
            field.current?.focus();
        }
    }, [adding]);

    const save = async (next) => {
        setBusy(true);

        try {
            return await attempt(async () => {
                keep(await api(route(computer, "given"), { person: person.id, folders: next }));

                return true;
            });
        } finally {
            setBusy(false);
        }
    };

    const add = async () => {
        const folder = draft.trim();

        // What was typed stays when it is refused (not a folder there), to correct it.
        if (folder !== "" && (await save([...folders, folder]))) {
            setDraft("");
            setAdding(false);
        }
    };

    // The sessions they started in a folder go with it, to who is in charge: said before it is taken back.
    const remove = (folder) => {
        const gone = leaving(
            folder,
            folders,
            tree.held.filter((each) => each.createdBy === person.id),
            worktrees,
        ).length;

        if (
            gone > 0 &&
            !confirm(
                `Remove ${folder} from ${person.name}? ${gone === 1 ? "The session they started in it moves" : `The ${gone} sessions they started in it move`} to ${heir(computer)}, with the tasks they set up there. Sessions shared with them stay.`,
            )
        ) {
            return;
        }

        void save(folders.filter((each) => each !== folder));
    };

    // They see every session in a folder, or no longer. Turning it on says how many become theirs now.
    const seeAll = async (folder) => {
        const on = !sees.includes(folder);
        const inside = there.filter((each) => inFolder(accessFolder(each, worktrees), folder));
        const more = inside.filter((each) => !holds(person, each)).length;
        const now =
            more === 0
                ? "No one else has a session there now. They will see each one started there later."
                : `${more === 1 ? "1 session of someone else's is" : `${more} sessions of other people's are`} theirs to open and prompt now, and so is each one started there later.`;

        if (on && !confirm(`Let ${person.name} access all sessions in ${folder}? ${now}`)) {
            return;
        }

        // Each stays listed under a filter it no longer passes, so the switch can be turned back where it is.
        find.keep(inside.map((each) => each.id));
        setBusy(true);

        try {
            await attempt(async () =>
                keep(await api(route(computer, "sees"), { person: person.id, folder, on })),
            );
        } finally {
            setBusy(false);
        }
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
                        ? "accesses all sessions here"
                        : `accesses all sessions in ${row.by}`,
            locked(row.session) && "locked until allowed",
        ]
            .filter(Boolean)
            .join(" · ");

    // Where in its folder a session works, when that is not the folder itself; its whole folder outside one.
    const where = ({ session }, folder) =>
        session.worktree
            ? `⎇ ${session.worktree.branch}`
            : folder === undefined
              ? session.cwd
              : below(session.cwd, folder);

    const go = (row) => {
        closeSheet();
        navigate(row.id);
    };

    const revoke = async (row) => {
        // A folder they access all sessions in still gives it to them: said, since Revoke then changes little.
        const kept = seenBy(sees, row.session, worktrees);
        const still =
            kept === undefined
                ? ""
                : ` They still have it after that: they access all sessions in ${kept}.`;
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
    // theirs alone from then on too: it stays when the folder's switch goes off.
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

    /** The sessions of one open row. */
    const inside = (key, rows, folder) => html`
        ${rows.length === 0 && html`<div class="ft-row muted at-note" style="--depth:1">No sessions ${folder === undefined ? "here" : "in it"}.</div>`}
        ${groups.inOrder(key, rows).map(
            (row) =>
                html`<${SessionLine}
                    key=${row.id}
                    name=${row.title}
                    how=${how(row, folder)}
                    where=${where(row, folder)}
                    used=${row.usedAt}
                    words=${find.words}
                    off=${!row.has}
                >
                    ${
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
                        // Theirs themselves: Revoke. Not theirs, or theirs by its folder alone: Invite in its place,
                        // where sessions can be given to them. With neither, the place stays, so the buttons before
                        // it are one column down the tree.
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
                    }
                <//>`,
        )}
    `;

    // With folders, the sessions outside them are the others; without (a viewer, someone invited to one session),
    // they are all there is.
    const rest = folders.length > 0 ? "Other sessions" : "Sessions";
    const shown = groupsOf(tree, find);

    if (find.active && shown.length === 0) {
        return null;
    }

    return html`<div class="at-tree" role="group" aria-label=${`Folders and sessions of ${on}`}>
        ${!find.active && starts && folders.length === 0 && html`<div class="ft-row muted at-note">No folders yet: ${person.name} cannot start sessions here.</div>`}
        ${shown.map((each) =>
            each.folder === undefined
                ? html`<${TreeGroup}
                      key=${each.key}
                      name=${rest}
                      label=${`${rest} of ${on}: ${countOf(each.rows)}`}
                      count=${countOf(each.rows)}
                      title=${folders.length > 0 ? "In no folder given to them." : undefined}
                      open=${groups.isOpen(each.key)}
                      onToggle=${() => groups.toggle(each.key)}
                  >
                      ${inside(each.key, each.listed, undefined)}
                  <//>`
                : html`<${TreeGroup}
                      key=${each.key}
                      folder=${true}
                      name=${each.folder}
                      label=${`Folder ${each.folder} of ${on}: ${countOf(each.rows)}`}
                      count=${countOf(each.rows)}
                      open=${groups.isOpen(each.key)}
                      onToggle=${() => groups.toggle(each.key)}
                      words=${find.words}
                      actions=${html`<span
                              class="at-sees"
                              title="Every session in this folder, whoever started it: to open and to prompt."
                          >
                              User accesses all sessions in folder
                          </span>
                          <${Switch}
                              on=${sees.includes(each.folder)}
                              disabled=${busy}
                              label=${`${person.name} accesses all sessions in ${each.folder} on ${computer.name}: ${sees.includes(each.folder) ? "on" : "off"}`}
                              onChange=${() => seeAll(each.folder)}
                          />
                          <button
                              class="button small ghost at-end"
                              disabled=${busy}
                              aria-label=${`Remove ${each.folder} from ${on}`}
                              onClick=${() => remove(each.folder)}
                          >
                              Remove
                          </button>`}
                  >
                      ${inside(each.key, each.listed, each.folder)}
                  <//>`,
        )}
        ${
            starts &&
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
export function AccessRow({ computer, person, lead, title, rights: withRights = true, find }) {
    const [busy, setBusy] = useState(false);
    const tree = treeOf(computer, person, find !== undefined);
    const { chosen, manager } = standing(computer, person);
    const folders = computer.given?.[person.id] ?? [];
    const rights = withRights ? rightsFor(computer, person) : [];

    // Under a search or a filter, a computer with nothing to list is left out whole.
    if (find?.active && (tree === null || groupsOf(tree, find).length === 0)) {
        return null;
    }

    const toggle = async () => {
        if (
            chosen &&
            !confirm(
                manager
                    ? `Take ${computer.name} from ${person.name}? They manage runners, so they stay in charge of it and nothing moves now. They keep nothing here once that ends.`
                    : `Take ${computer.name} from ${person.name}? They leave its sessions at once, and the sessions they started there move to ${heir(computer)}.`,
            )
        ) {
            return;
        }

        setBusy(true);

        try {
            await choosePerson(computer, person, !chosen);
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
                                  ? "On: they see the sessions shared with them here. View only."
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
