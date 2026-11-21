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
    store,
} from "../store.js";
import { html, Icon, Switch } from "../ui.js";
import { accessFolder, below, inFolder, leaving, placed, seenBy } from "./access-tree.js";

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
function heir(computer) {
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

/**
 * One person's folders on one computer and their sessions there, as one tree (`access-tree.js`), with the rows of the
 * Files panel's. A folder given to them (`starts`: they start sessions, so they have folders) holds the sessions they
 * have in it, and stays closed until opened; the sessions in no given folder are a group of their own. Each row is
 * taken back alone: a folder with Remove, a session with Revoke (`app.ts` `revokeSession`). A session opens from its
 * row, and a locked one is allowed again there.
 */
function AccessTree({ computer, person, starts }) {
    const folders = starts ? (computer.given?.[person.id] ?? []) : [];
    const sees = seenFolders(computer, person);
    const sessions = sessionsOf(computer, person);
    const there = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id,
    );
    const shape = placed(folders, sessions, there);
    // The folder that gives them a session they have in no other way: taken back with its switch, not alone.
    const onlyBy = (session) => (holds(person, session) ? undefined : seenBy(sees, session, there));
    const [open, setOpen] = useState(() => new Set());
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const field = useRef(null);
    const title = (session) => session.title ?? "New session";
    const on = `${person.name} on ${computer.name}`;

    useEffect(() => {
        if (adding) {
            field.current?.focus();
        }
    }, [adding]);

    const toggle = (key) =>
        setOpen((now) => {
            const next = new Set(now);

            if (!next.delete(key)) {
                next.add(key);
            }

            return next;
        });

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
            sessions.filter((each) => each.createdBy === person.id),
            there,
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
        const more = there.filter(
            (each) => !holds(person, each) && inFolder(accessFolder(each, there), folder),
        ).length;
        const now =
            more === 0
                ? "No one else has a session there now. They will see each one started there later."
                : `${more === 1 ? "1 session of someone else's is" : `${more} sessions of other people's are`} theirs to open and prompt now, and so is each one started there later.`;

        if (on && !confirm(`Let ${person.name} access all sessions in ${folder}? ${now}`)) {
            return;
        }

        setBusy(true);

        try {
            await attempt(async () =>
                keep(await api(route(computer, "sees"), { person: person.id, folder, on })),
            );
        } finally {
            setBusy(false);
        }
    };

    const how = (session, folder) =>
        [
            person.sessions?.includes(session.id)
                ? "invited to it alone"
                : session.createdBy === person.id
                  ? "started it"
                  : session.sharedWith?.includes(person.id)
                    ? "shared with them"
                    : onlyBy(session) === folder
                      ? "accesses all sessions here"
                      : `accesses all sessions in ${onlyBy(session)}`,
            session.archived && "archived",
            locked(session) && "locked until allowed",
        ]
            .filter(Boolean)
            .join(" · ");

    // Where in its folder a session works, when that is not the folder itself; its whole folder outside one.
    const where = (session, folder) =>
        session.worktree
            ? `⎇ ${session.worktree.branch}`
            : folder === undefined
              ? session.cwd
              : below(session.cwd, folder);

    const go = (session) => {
        closeSheet();
        navigate(session.id);
    };

    const revoke = async (session) => {
        const asked = person.sessions?.includes(session.id)
            ? `Take “${title(session)}” from ${person.name}? They were invited to it alone.`
            : session.createdBy === person.id
              ? `Take “${title(session)}” from ${person.name}? They started it: it moves to ${heir(computer)}, with the tasks they set up in it.`
              : `Stop sharing “${title(session)}” with ${person.name}?`;

        if (!confirm(asked)) {
            return;
        }

        setBusy(true);

        try {
            await attempt(() => api(`sessions/${session.id}/revoke`, { person: person.id }));
        } finally {
            setBusy(false);
        }
    };

    const allow = (session) =>
        attempt(() => api(`session-approvals/${encodeURIComponent(session.id)}`, {}));

    /** The sessions of one opened row, set in under it. */
    const inside = (list, folder) => html`<div class="at-group" role="group">
        ${list.length === 0 && html`<div class="ft-row muted at-note" style="--depth:1">No sessions ${folder === undefined ? "here" : "in it"}.</div>`}
        ${list.map((session) => {
            const place = where(session, folder);

            return html`<div class="at-line at-session" key=${session.id}>
                <div class="ft-row" style="--depth:1" title=${title(session)}>
                    <span class="ft-spacer"></span>
                    <${Icon} name="chat" size=${13} />
                    <span class="ft-name at-session-name">${title(session)}</span>
                    <span class="at-about">
                        <span class="at-how">${how(session, folder)}</span>
                        ${place && html`<span class="at-where" title=${place}>${place}</span>`}
                    </span>
                </div>
                <div class="at-actions">
                    ${
                        locked(session) &&
                        html`<button
                            class="button small"
                            aria-label=${`Allow ${title(session)} again`}
                            onClick=${() => allow(session)}
                        >
                            Allow
                        </button>`
                    }
                    <button
                        class="button small"
                        aria-label=${`Go to ${title(session)}`}
                        onClick=${() => go(session)}
                    >
                        Go to session
                    </button>
                    ${
                        // One they have by its folder alone has no Revoke: its place stays, so the buttons before
                        // it are one column down the tree.
                        onlyBy(session) === undefined
                            ? html`<button
                                  class="button small ghost at-end"
                                  disabled=${busy}
                                  aria-label=${`Revoke ${title(session)} from ${person.name}`}
                                  onClick=${() => revoke(session)}
                              >
                                  Revoke
                              </button>`
                            : html`<span class="at-end" aria-hidden="true"></span>`
                    }
                </div>
            </div>`;
        })}
    </div>`;

    // With folders, the sessions outside them are the others; without (a viewer, someone invited to one session),
    // they are all there is.
    const rest = folders.length > 0 ? "Other sessions" : "Sessions";

    return html`<div class="at-tree" role="group" aria-label=${`Folders and sessions of ${on}`}>
        ${starts && folders.length === 0 && html`<div class="ft-row muted at-note">No folders yet: ${person.name} cannot start sessions here.</div>`}
        ${shape.folders.map(
            (node) => html`<div class="at-node" key=${node.folder}>
                <div class="at-line at-folder-line">
                    <button
                        type="button"
                        class="ft-row dir at-folder"
                        aria-expanded=${open.has(node.folder)}
                        aria-label=${`Folder ${node.folder} of ${on}: ${node.sessions.length}`}
                        onClick=${() => toggle(node.folder)}
                    >
                        <${Icon}
                            name="chevron"
                            size=${11}
                            class=${`chev ${open.has(node.folder) ? "open" : ""}`}
                        />
                        <${Icon} name="folder" size=${13} />
                        <span class="ft-name">${node.folder}</span>
                        <span class="at-count">${node.sessions.length}</span>
                    </button>
                    <div class="at-actions">
                        <span class="at-sees" title="Every session in this folder, whoever started it: to open and to prompt.">
                            User accesses all sessions in folder
                        </span>
                        <${Switch}
                            on=${sees.includes(node.folder)}
                            disabled=${busy}
                            label=${`${person.name} accesses all sessions in ${node.folder} on ${computer.name}: ${sees.includes(node.folder) ? "on" : "off"}`}
                            onChange=${() => seeAll(node.folder)}
                        />
                        <button
                            class="button small ghost at-end"
                            disabled=${busy}
                            aria-label=${`Remove ${node.folder} from ${on}`}
                            onClick=${() => remove(node.folder)}
                        >
                            Remove
                        </button>
                    </div>
                </div>
                ${open.has(node.folder) && inside(node.sessions, node.folder)}
            </div>`,
        )}
        ${
            (shape.other.length > 0 || !starts) &&
            html`<div class="at-node">
                <div class="at-line">
                    <button
                        type="button"
                        class="ft-row dir at-rest"
                        aria-expanded=${open.has(OTHER)}
                        aria-label=${`${rest} of ${on}: ${shape.other.length}`}
                        title=${folders.length > 0 ? "In no folder given to them: shared with them, or invited to." : undefined}
                        onClick=${() => toggle(OTHER)}
                    >
                        <${Icon}
                            name="chevron"
                            size=${11}
                            class=${`chev ${open.has(OTHER) ? "open" : ""}`}
                        />
                        <${Icon} name="chat" size=${13} />
                        <span class="ft-name">${rest}</span>
                        <span class="at-count">${shape.other.length}</span>
                    </button>
                </div>
                ${open.has(OTHER) && inside(shape.other, undefined)}
            </div>`
        }
        ${
            starts &&
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
 * `title`: the person); People shows it per computer under a person (the computer).
 */
export function AccessRow({ computer, person, lead, title }) {
    const [busy, setBusy] = useState(false);
    const chosen = chosenFor(computer, person);
    // In charge here because they manage runners: they have everything here whatever this switch says. It sets what
    // they keep once they manage runners no longer.
    const manager = computer.managers?.includes(person.id) === true;
    const folders = computer.given?.[person.id] ?? [];
    const sessions = sessionsOf(computer, person);
    // Folders are for those who start sessions: who steers, and is not held to one session.
    const starts = chosen && person.role === "guest" && !person.sessions;
    // The rights given one person at a time are for those who prompt here. A computer's view names who holds each
    // only for who manages it.
    const rights =
        chosen && person.role !== "viewer" && !person.sessions && computer.rights
            ? declaredRights("computer").filter((each) => Array.isArray(computer.rights[each.key]))
            : [];

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

    return html`<div class="access-row">
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
                                  ? "In charge here: they manage runners. On: what they keep here if that ends."
                                  : "In charge here: they manage runners. Off: they keep nothing here if that ends."
                              : !chosen
                                ? sessions.length === 0
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
            (chosen || sessions.length > 0) &&
            html`<${AccessTree} computer=${computer} person=${person} starts=${starts} />`
        }
    </div>`;
}
