// Who may use a computer, in which folders, and which sessions they have there (`src/server/access.ts`): the parts the
// Runners sheet (by computer) and the People sheet (by person) share, so a choice made in one is the same choice in the
// other. Both change the one record kept on the server, over the same routes (`POST /api/runners/:id/users` and
// `/given`, `POST /api/sessions/:id/revoke`).
import { useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, store } from "../store.js";
import { html, Icon, Switch } from "../ui.js";

export const THIS_SERVER = "this-server";

/** Whether I am in charge of a computer: its linker, or for this server the owner (`access.ts` `inCharge`). */
export function inCharge(computer) {
    return computer.id === THIS_SERVER
        ? store.state.me?.role === "owner"
        : computer.createdBy === store.state.me?.id;
}

/** The computers this person knows of: this server first (the owner's alone to know), then the linked ones. */
export function computers() {
    const { runners, thisServer } = store.state;

    return [...(thisServer ? [thisServer] : []), ...runners];
}

/** Read the computers again: a sheet that opens shows them as they are now. */
export async function loadComputers() {
    // This server's record is the owner's business alone (who is in charge of it).
    const [list, server] = await Promise.all([
        api("runners"),
        store.state.me?.role === "owner" ? api("runners/this-server") : null,
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
 * The sessions `person` has on `computer`, of the ones I see (who is in charge of it sees every one): the ones they
 * started, the ones shared with them, and one they were invited to alone.
 */
export function sessionsOf(computer, person) {
    return store.state.sessions.filter(
        (each) =>
            (each.runner ?? THIS_SERVER) === computer.id &&
            (each.createdBy === person.id ||
                each.sharedWith?.includes(person.id) === true ||
                person.sessions?.includes(each.id) === true),
    );
}

/**
 * The folders given to one chosen person on a computer: each covers the folders in it, and each is taken back alone. A
 * person given none may not start sessions there.
 */
function FolderList({ computer, person }) {
    const folders = computer.given?.[person.id] ?? [];
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);

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
        }
    };

    return html`<div class="given-folders">
        ${folders.length === 0 && html`<div class="muted small">No folders yet: ${person.name} cannot start sessions here.</div>`}
        ${folders.map(
            (folder) => html`<div class="runner-permission-row" key=${folder}>
                <code>${folder}</code>
                <button
                    class="button small ghost"
                    disabled=${busy}
                    aria-label=${`Remove ${folder} from ${person.name} on ${computer.name}`}
                    onClick=${() => save(folders.filter((each) => each !== folder))}
                >
                    Remove
                </button>
            </div>`,
        )}
        <div class="row">
            <input
                type="text"
                placeholder="Add a folder, as ~/projects/app"
                aria-label=${`Add a folder for ${person.name} on ${computer.name}`}
                value=${draft}
                onInput=${(event) => setDraft(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && !busy && add()}
            />
            <button class="button small" disabled=${busy || draft.trim() === ""} onClick=${add}>
                Add
            </button>
        </div>
    </div>`;
}

/** Whether a session is locked now: its approval ended, or was revoked, and nobody renewed it (`folder-approvals.ts`). */
function locked(session) {
    return (store.state.folderApprovals ?? []).some(
        (each) =>
            each.session === String(session.id) &&
            (each.ended || (each.expiresAt !== null && each.expiresAt <= Date.now())),
    );
}

/**
 * The sessions one person has on a computer: each opens from here, and each is taken from them alone
 * (`app.ts` `revokeSession`). A locked one is allowed again here.
 */
function SessionList({ computer, person }) {
    const sessions = sessionsOf(computer, person);
    const [busy, setBusy] = useState(false);
    const name = (session) => session.title ?? "New session";
    const how = (session) =>
        person.sessions?.includes(session.id)
            ? "invited to it alone"
            : session.createdBy === person.id
              ? "started it"
              : "shared with them";

    const go = (session) => {
        closeSheet();
        navigate(session.id);
    };

    const revoke = async (session) => {
        const asked = person.sessions?.includes(session.id)
            ? `Take “${name(session)}” from ${person.name}? They were invited to it alone.`
            : session.createdBy === person.id
              ? `Take “${name(session)}” from ${person.name}? They started it: it moves to you, with the tasks they set up in it.`
              : `Stop sharing “${name(session)}” with ${person.name}?`;

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

    return html`<div class="access-sessions">
        ${sessions.length === 0 && html`<div class="muted small">No sessions here.</div>`}
        ${sessions.map(
            (session) => html`<div class="access-session" key=${session.id}>
                <div class="access-session-text">
                    <div class="access-session-name">${name(session)}</div>
                    <div class="muted small">
                        <code>${session.cwd}</code>${` · ${[
                            how(session),
                            session.archived && "archived",
                            locked(session) && "locked until allowed",
                        ]
                            .filter(Boolean)
                            .join(" · ")}`}
                    </div>
                </div>
                <div class="access-session-actions">
                    ${
                        locked(session) &&
                        html`<button
                            class="button small"
                            aria-label=${`Allow ${name(session)} again`}
                            onClick=${() => allow(session)}
                        >
                            Allow
                        </button>`
                    }
                    <button
                        class="button small"
                        aria-label=${`Go to ${name(session)}`}
                        onClick=${() => go(session)}
                    >
                        Go to session
                    </button>
                    <button
                        class="button small ghost"
                        disabled=${busy}
                        aria-label=${`Revoke ${name(session)} from ${person.name}`}
                        onClick=${() => revoke(session)}
                    >
                        Revoke
                    </button>
                </div>
            </div>`,
        )}
    </div>`;
}

/** A list that stays closed until asked for: what it is, and how many it holds. */
function Fold({ label, count, name, children }) {
    const [open, setOpen] = useState(false);

    return html`<div class=${`access-fold ${open ? "open" : ""}`}>
        <button
            class="access-fold-head"
            aria-expanded=${open}
            aria-label=${`${name}: ${count}`}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="chevron" size=${12} class=${`chev ${open ? "open" : ""}`} />
            <span class="small">${label}</span>
            <span class="access-fold-count">${count}</span>
        </button>
        ${open && html`<div class="access-fold-body">${children}</div>`}
    </div>`;
}

/**
 * One person on one computer, for who is in charge of it: whether they may use it, then two separate lists, closed
 * until asked for: the folders given to them there, and the sessions they have there. Runners shows it per person under
 * a computer (`lead`, `title`: the person); People shows it per computer under a person (the computer).
 */
export function AccessRow({ computer, person, lead, title }) {
    const [busy, setBusy] = useState(false);
    const chosen = chosenFor(computer, person);
    const folders = computer.given?.[person.id] ?? [];
    const sessions = sessionsOf(computer, person);
    // Folders are for those who start sessions: who steers, and is not held to one session.
    const starts = chosen && person.role === "guest" && !person.sessions;

    const toggle = async () => {
        if (
            chosen &&
            !confirm(
                `Take ${computer.name} from ${person.name}? They leave its sessions at once, and the sessions they started there move to you.`,
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
                            : !chosen
                              ? "Off: they see nothing of it."
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
        ${
            (chosen || sessions.length > 0) &&
            html`<div class="person-access">
                ${
                    starts &&
                    html`<${Fold}
                        label="Folders"
                        count=${folders.length}
                        name=${`Folders of ${person.name} on ${computer.name}`}
                    >
                        <${FolderList} computer=${computer} person=${person} />
                    <//>`
                }
                <${Fold}
                    label="Sessions"
                    count=${sessions.length}
                    name=${`Sessions of ${person.name} on ${computer.name}`}
                >
                    <${SessionList} computer=${computer} person=${person} />
                <//>
            </div>`
        }
    </div>`;
}
