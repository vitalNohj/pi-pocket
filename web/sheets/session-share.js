// Share a session with people, one at a time (`commands.ts` `sharing` and `shareSession`): its starter and who is in
// charge of its computer pick from everyone chosen for it. Someone taken off leaves it at once.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/**
 * May this tab share session `session` (a row of the list): the server says so on the row (`access.ts` `mayShare`): who
 * is in charge of its computer, and its starter while they steer it.
 */
export function canShare(session) {
    return Boolean(store.state.me) && session?.mayShare === true;
}

/** Whom session `id` is shared with, in a word for its menu item. */
export function sharedHint(id) {
    const shared = store.state.sessions.find((each) => each.id === id)?.sharedWith ?? [];

    return shared.length === 0
        ? "private"
        : shared.length === 1
          ? `with ${store.state.users.find((person) => person.id === shared[0])?.name ?? "1 person"}`
          : `with ${shared.length} people`;
}

export function SessionShareSheet({ id }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let live = true;

        api(`sessions/${id}/share`).then(
            (answer) => {
                if (live) {
                    setData(answer);
                    setSelected(answer.sharedWith);
                }
            },
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
        };
    }, [id]);

    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api(`sessions/${id}/share`, { people: selected });
                notify(
                    "info",
                    selected.length === 0
                        ? "The session is private again."
                        : "Saved who the session is shared with.",
                );
                closeSheet();
            } finally {
                setBusy(false);
            }
        });

    const title = session?.title ? `Share “${session.title}”` : "Share the session";

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
        ${!error && !data && html`<${Loader} label="Loading people" />`}
        ${
            data &&
            html`<p class="muted small">
                    The people you pick see this session; those who steer can also send to Pi. You can pick only people
                    chosen for ${data.computer} (Menu → People, or Menu → Runners).
                </p>
                ${
                    data.people.length === 0
                        ? html`<p class="muted small">
                              No one to pick yet. Turn ${data.computer} on for someone first, in People or in Runners.
                          </p>`
                        : html`<div role="group" aria-label="People to share with">
                              ${data.people.map(
                                  (person) => html`<label class="check" key=${person.id}>
                                      <input
                                          type="checkbox"
                                          checked=${selected.includes(person.id)}
                                          disabled=${busy}
                                          onChange=${(event) =>
                                              setSelected(
                                                  event.currentTarget.checked
                                                      ? [...selected, person.id]
                                                      : selected.filter(
                                                            (each) => each !== person.id,
                                                        ),
                                              )}
                                      />
                                      ${person.name}${
                                          person.role === "viewer"
                                              ? html` <span class="muted small">(view only)</span>`
                                              : ""
                                      }${
                                          person.notChosen
                                              ? html` <span class="muted small">(not chosen for ${data.computer}: once taken off, choose them first)</span>`
                                              : ""
                                      }
                                  </label>`,
                              )}
                          </div>`
                }
                <div class="row">
                    <button class="button ghost" onClick=${closeSheet}>Cancel</button>
                    <button class="button primary" disabled=${busy} onClick=${save}>Save</button>
                </div>`
        }
    <//>`;
}
