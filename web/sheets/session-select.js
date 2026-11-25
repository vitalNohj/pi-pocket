// A selection of sessions on a person's page in People, to share or take back several at once with one request
// (`POST /api/users/:id/sharing`, `commands.ts` `shareWith`): the tree of a computer I am in charge of (`access.js`
// `AccessTree`) and the list of my sessions on one someone else is in charge of (`people.js` `OtherComputer`) use it
// alike. Select in the tool row turns it on: each listed session and folder then has a checkbox, and a bar over the
// list shares or takes back what is checked. Only what is listed can be checked: a row that leaves the list (under a
// search, a folder closed, a session gone) leaves the selection too.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { api, attempt, notify } from "../store.js";
import { html } from "../ui.js";

/**
 * The selection of one page. `scope`: the person and the computers shown; a change of it ends the selection mode.
 *
 * Each list on the page tells what it lists now (`useListed`): one entry for each session row it draws, `{ id, share,
 * revoke, started, heir, kept }`: whether it can be shared with the person now, or taken back from them; whether they
 * started it, and then who it moves to (`heir`); and whether a folder still gives it to them after that (`kept`).
 */
export function useSelect(scope) {
    const [on, setOn] = useState(false);
    const [picked, setPicked] = useState(() => new Set());
    const [lists, setLists] = useState(() => new Map());
    const [busy, setBusy] = useState(false);
    const listed = [...lists.values()].flatMap((each) => each.entries);
    const ids = new Set(listed.map((each) => each.id));
    const shown = JSON.stringify([...ids]);

    useEffect(() => {
        setOn(false);
        setPicked(new Set());
    }, [scope]);

    // What is no longer listed is no longer selected.
    useEffect(() => {
        setPicked((now) =>
            [...now].every((id) => ids.has(id))
                ? now
                : new Set([...now].filter((id) => ids.has(id))),
        );
    }, [shown]);

    const chosen = listed.filter((each) => picked.has(each.id));

    return {
        on,
        busy,
        setBusy,
        listed,
        chosen,
        toggle() {
            setPicked(new Set());
            setOn(!on);
        },
        clear: () => setPicked(new Set()),
        has: (id) => picked.has(id),
        /** Check, or uncheck, every session of `ids`. */
        set(ids, checked) {
            setPicked((now) => {
                const next = new Set(now);

                for (const id of ids) {
                    if (checked) {
                        next.add(id);
                    } else {
                        next.delete(id);
                    }
                }

                return next;
            });
        },
        /** What one list (`key`) lists now; none once it is gone. */
        report(key, entries) {
            const stamp = JSON.stringify(entries);

            setLists((now) =>
                now.get(key)?.stamp === stamp ? now : new Map(now).set(key, { stamp, entries }),
            );
        },
        drop(key) {
            setLists((now) => {
                if (!now.has(key)) {
                    return now;
                }

                const next = new Map(now);

                next.delete(key);

                return next;
            });
        },
    };
}

/** The most sessions one request names (`commands.ts` `shareWith`). */
const MOST = 500;

/** `ids` in lists of at most `size`, in their order. */
export function chunks(ids, size = MOST) {
    const lists = [];

    for (let at = 0; at < ids.length; at += size) {
        lists.push(ids.slice(at, at + size));
    }

    return lists;
}

/** What nothing selects: a list drawn outside a page with a selection. */
export const NO_SELECT = {
    on: false,
    busy: false,
    has: () => false,
    set() {},
    report() {},
    drop() {},
};

/** One list of the page tells the selection what it lists now (`useSelect`), under its own `key`. */
export function useListed(select, key, entries) {
    const stamp = JSON.stringify(entries);

    useLayoutEffect(() => {
        select.report(key, entries);
    }, [key, stamp]);

    useLayoutEffect(() => () => select.drop(key), [key]);
}

/**
 * A checkbox of the selection, with a hit area a finger finds (`style.css` `.sel-check`). `mixed`: some of what it
 * stands for is checked, not all.
 */
export function SelectCheck({ label, checked, mixed = false, disabled = false, onChange }) {
    return html`<label class="sel-check">
        <input
            type="checkbox"
            aria-label=${label}
            checked=${checked}
            indeterminate=${mixed}
            disabled=${disabled}
            onChange=${(event) => onChange(event.currentTarget.checked)}
        />
    </label>`;
}

/** The checkbox of a session's row. */
export const sessionCheck = (select, row) =>
    select.on &&
    html`<${SelectCheck}
        label=${`Select ${row.title}`}
        checked=${select.has(row.id)}
        disabled=${select.busy}
        onChange=${(checked) => select.set([row.id], checked)}
    />`;

/** The checkbox of a folder's row: every session listed under it, in the folders in it too. */
export function folderCheck(select, name, ids) {
    if (!select.on) {
        return undefined;
    }

    const some = ids.filter((id) => select.has(id)).length;

    return html`<${SelectCheck}
        label=${`Select the sessions in ${name}`}
        checked=${ids.length > 0 && some === ids.length}
        mixed=${some > 0 && some < ids.length}
        disabled=${select.busy || ids.length === 0}
        onChange=${(checked) => select.set(ids, checked)}
    />`;
}

/** Select in the tool row, Done while the selection is on. */
export function SelectButton({ select }) {
    return html`<button type="button" class="button small sel-toggle" onClick=${select.toggle}>
        ${select.on ? "Done" : "Select"}
    </button>`;
}

/** Several in a word: "1 session", "3 sessions". */
const sessions = (count) => `${count} ${count === 1 ? "session" : "sessions"}`;

/**
 * The bar over the list while the selection is on: Select all (every session listed now), how many are selected, and
 * Share and Revoke for the ones each can change now. Each sends one request for all of them (one for each 500, past
 * that); Revoke asks first. The server changes each alone and names the ones it refused (`refused`): one notice says how many, and why for the first.
 * `onAnswer`: what the page does with the server's answer, besides the store's own events.
 */
export function SelectBar({ select, person, find, onAnswer }) {
    if (!select.on) {
        return null;
    }

    const { listed, chosen, busy } = select;
    const sharing = chosen.filter((each) => each.share);
    const revoking = chosen.filter((each) => each.revoke);
    const all = listed.length > 0 && chosen.length === listed.length;

    const send = async (what, ids) => {
        // Each stays listed under a filter it no longer passes, as after its own button.
        find.keep(ids);
        select.setBusy(true);

        try {
            await attempt(async () => {
                const refused = [];

                // More than one request takes, they go one after another: each answer is the whole list as it then
                // stands, and the page keeps the last.
                for (const some of chunks(ids)) {
                    const answer = await api(`users/${encodeURIComponent(person.id)}/sharing`, {
                        [what]: some,
                    });

                    onAnswer?.(answer);
                    refused.push(...answer.refused);
                }

                if (refused.length > 0) {
                    notify(
                        "error",
                        `${refused.length} of ${ids.length} were not changed: ${refused[0].reason}`,
                    );
                }

                select.clear();
            });
        } finally {
            select.setBusy(false);
        }
    };

    const share = () =>
        send(
            "share",
            sharing.map((each) => each.id),
        );

    const revoke = () => {
        const ids = revoking.map((each) => each.id);
        const started = revoking.filter((each) => each.started);
        const heirs = [...new Set(started.map((each) => each.heir))];
        const kept = revoking.filter((each) => each.kept).length;
        // The sessions they started move to whoever is in charge of each one's computer: where those differ, how many
        // go to each.
        const to =
            heirs.length === 1
                ? heirs[0]
                : heirs
                      .map(
                          (heir) =>
                              `${heir} (${started.filter((each) => each.heir === heir).length})`,
                      )
                      .join(", ");
        const asked =
            `Revoke ${sessions(ids.length)} from ${person.name}?` +
            (started.length > 0
                ? ` ${started.length} they started move to ${to}, with the tasks they set up in them.`
                : "") +
            (kept > 0 ? ` They still have ${kept} of them through a folder.` : "");

        if (confirm(asked)) {
            void send("revoke", ids);
        }
    };

    return html`<div class="sel-bar" data-part="select-bar">
        <label class="sel-all">
            <span class="sel-check">
                <input
                    type="checkbox"
                    checked=${all}
                    indeterminate=${chosen.length > 0 && !all}
                    disabled=${busy || listed.length === 0}
                    onChange=${(event) =>
                        select.set(
                            listed.map((each) => each.id),
                            event.currentTarget.checked,
                        )}
                />
            </span>
            Select all
        </label>
        <span class="sel-count" aria-live="polite">${chosen.length} selected</span>
        <div class="sel-buttons">
            <button
                type="button"
                class="button small"
                disabled=${busy || sharing.length === 0}
                onClick=${share}
            >
                Share (${sharing.length})
            </button>
            <button
                type="button"
                class="button small ghost"
                disabled=${busy || revoking.length === 0}
                onClick=${revoke}
            >
                Revoke (${revoking.length})
            </button>
        </div>
    </div>`;
}
