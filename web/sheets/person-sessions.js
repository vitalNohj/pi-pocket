// Several sessions for one person at once (`commands.ts` `sharingWith`, `shareWith`): on that person's page in People,
// whoever prompts checks sessions of their own, or all of them, and shares them with one button or takes them back with
// another. The list of sessions to check (`SessionPicker`) knows nothing of people: an invite uses the same one.
import { useEffect, useState } from "preact/hooks";
import { shortPath } from "../folder-paths.js";
import { api, store } from "../store.js";
import { html, Loader } from "../ui.js";
import { computers, inCharge } from "./access.js";

/**
 * Sessions to check, under the name of what each belongs to (`group`): `rows` are `{ id, title, group, about, off }`,
 * where `off` says that a row cannot be checked. `selected` is the set of checked ids, and `onChange` gets the next
 * one. Select all checks every row that can be, and unchecks them when all are.
 */
export function SessionPicker({ rows, selected, onChange, busy = false, label }) {
    const open = rows.filter((each) => !each.off);
    const all = open.length > 0 && open.every((each) => selected.has(each.id));
    const groups = [...new Set(rows.map((each) => each.group))];

    const set = (ids, on) => {
        const next = new Set(selected);

        for (const id of ids) {
            if (on) {
                next.add(id);
            } else {
                next.delete(id);
            }
        }

        onChange(next);
    };

    return html`<div class="session-picker" role="group" aria-label=${label}>
        <div class="sp-head">
            <label class="check sp-row sp-all">
                <input
                    type="checkbox"
                    checked=${all}
                    disabled=${busy || open.length === 0}
                    onChange=${(event) =>
                        set(
                            open.map((each) => each.id),
                            event.currentTarget.checked,
                        )}
                />
                <span class="sp-title">Select all</span>
            </label>
            <span class="sp-count" aria-live="polite">${selected.size} selected</span>
        </div>
        <div class="sp-list">
            ${groups.map(
                (group) => html`<div class="sp-group" key=${group} role="group" aria-label=${group}>
                    <div class="sp-group-title">${group}</div>
                    ${rows
                        .filter((each) => each.group === group)
                        .map(
                            (row) => html`<label
                                class=${`check sp-row ${row.off ? "off" : ""}`}
                                key=${row.id}
                                title=${row.about}
                            >
                                <input
                                    type="checkbox"
                                    aria-label=${row.title}
                                    checked=${selected.has(row.id)}
                                    disabled=${busy || row.off}
                                    onChange=${(event) =>
                                        set([row.id], event.currentTarget.checked)}
                                />
                                <span class="sp-title">${row.title}</span>
                                <span class="sp-about">${row.about}</span>
                            </label>`,
                        )}
                </div>`,
            )}
        </div>
    </div>`;
}

/** The home folder on a session's computer, when this tab knows it: its paths are written from there ("~"). */
const homeOf = (computer) =>
    computer === "this-server"
        ? store.state.server?.home
        : store.state.runners.find((each) => each.id === computer)?.home;

/** How a person has a session now, in the words of the tree of their access (`access.js`). */
const HOW = {
    started: "started it",
    invited: "invited to it alone",
    shared: "shared with them",
    folder: "accesses all sessions in its folder",
};

/**
 * The sessions I may share, with how `person` has each now: check some, then Share them or Revoke them. A session they
 * cannot have says why and cannot be checked; neither can one that is not mine to take back and is theirs already.
 * What the server refuses of a change is said under the buttons, and the rest is done. `turnOn`: where on this page I
 * turn a computer of mine on for them.
 */
export function PersonSessions({ person, turnOn }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState([]);
    const path = `users/${encodeURIComponent(person.id)}/sharing`;

    useEffect(() => {
        let live = true;

        api(path).then(
            (answer) => live && setData(answer),
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
        };
    }, [path]);

    if (error) {
        return html`<p class="runner-code-error" role="alert">${error}</p>`;
    }

    if (!data) {
        return html`<${Loader} label="Loading your sessions" />`;
    }

    if (data.sessions.length === 0) {
        return html`<p class="muted small">You have no session to share with ${person.name}.</p>`;
    }

    const rows = data.sessions.map((each) => ({
        id: each.id,
        title: each.title,
        group: each.computerName,
        about: [
            each.state === "blocked" ? each.reason : HOW[each.state],
            each.archived && "archived",
            shortPath(each.cwd, homeOf(each.computer)),
        ]
            .filter(Boolean)
            .join(" · "),
        off: !each.give && !each.take,
    }));
    const checked = data.sessions.filter((each) => selected.has(each.id));
    const give = checked.filter((each) => each.give);
    const take = checked.filter((each) => each.take);
    const title = (id) => data.sessions.find((each) => each.id === id)?.title ?? "A session";
    // The computers they cannot use yet: a session there is shared once they are chosen for it, by me where I am in
    // charge of it, and by whoever is where I am not.
    const closed = [
        ...new Map(
            data.sessions
                .filter((each) => each.state === "blocked" && /^cannot use /.test(each.reason))
                .map((each) => [each.computer, each.computerName]),
        ),
    ].map(([id, name]) => ({
        name,
        mine: computers().some((each) => each.id === id && inCharge(each)),
    }));
    const names = (list) => list.map((each) => each.name).join(" or ");
    const count = (list) => (list.length === 1 ? "1 session" : `${list.length} sessions`);

    const change = async (body) => {
        setBusy(true);
        setRefused([]);

        try {
            const answer = await api(path, body);

            setData(answer);
            setRefused(answer.refused);
            // What was refused stays checked, to try again once its reason is gone.
            setSelected(new Set(answer.refused.map((each) => each.id)));
        } catch (failure) {
            setRefused([{ id: -1, reason: failure.message }]);
        } finally {
            setBusy(false);
        }
    };

    const revoke = () => {
        const moves = take.some((each) => each.state === "started");

        return (
            confirm(
                moves
                    ? `Take ${count(take)} from ${person.name}? The ones they started move to you, with the tasks they set up in them.`
                    : `Stop sharing ${count(take)} with ${person.name}?`,
            ) && change({ revoke: take.map((each) => each.id) })
        );
    };

    return html`<div class="person-sessions">
        <${SessionPicker}
            rows=${rows}
            selected=${selected}
            onChange=${setSelected}
            busy=${busy}
            label=${`Your sessions, for ${person.name}`}
        />
        <div class="row sp-actions">
            <button
                class="button small"
                disabled=${busy || give.length === 0}
                onClick=${() => change({ share: give.map((each) => each.id) })}
            >
                Share
            </button>
            <button
                class="button small ghost"
                disabled=${busy || take.length === 0}
                onClick=${revoke}
            >
                Revoke
            </button>
            <span class="muted small grow">
                ${
                    checked.length === 0
                        ? "Check sessions, then share them or take them back."
                        : `${count(give)} to share, ${count(take)} to take back.`
                }
            </span>
        </div>
        ${[true, false].map((mine) => {
            const list = closed.filter((each) => each.mine === mine);

            return (
                list.length > 0 &&
                html`<div class="muted small" key=${mine}>
                    ${person.name} cannot use ${names(list)} yet.${" "}
                    ${
                        mine
                            ? `Turn it on for them first, ${turnOn}.`
                            : "Whoever is in charge of it turns it on for them first."
                    }
                </div>`
            );
        })}
        ${
            refused.length > 0 &&
            html`<div class="runner-note warning" role="alert">
                ${refused.map(
                    (each) =>
                        html`<div key=${each.id}>
                            ${each.id === -1 ? "" : `“${title(each.id)}”: `}${each.reason}
                        </div>`,
                )}
            </div>`
        }
    </div>`;
}
