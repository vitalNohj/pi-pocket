// Who may use a computer, and in which folders (`src/server/access.ts`): the parts the Runners sheet (by computer) and
// the People sheet (by person) share, so a choice made in one is the same choice in the other. Both change the one list
// kept on the server, over the same routes (`POST /api/runners/:id/users` and `/given`).
import { useState } from "preact/hooks";
import { api, attempt, store } from "../store.js";
import { html } from "../ui.js";

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

/** Choose the people of a computer: the whole list. True when it was saved. */
export function choosePeople(computer, users) {
    return attempt(async () => {
        keep(await api(route(computer, "users"), { users }));

        return true;
    });
}

/** Choose one person for a computer, or no longer: the others stay as they are now. True when it was saved. */
export function choosePerson(computer, person, on) {
    return attempt(async () => {
        keep(await api(route(computer, "users"), { person: person.id, on }));

        return true;
    });
}

/**
 * The folders given to one chosen person on a computer: each covers the folders in it. A person given none may not start
 * sessions there. Shown by the Runners sheet under each person, and by the People sheet under each computer.
 */
export function FolderList({ computer, person }) {
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
