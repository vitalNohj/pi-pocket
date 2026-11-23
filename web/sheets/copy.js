// Every way to copy a session opens one sheet, laid out the same: a title, what is copied, rows of choices (a label on
// the left, a value on the right that opens a picker), one main button, and small actions under it. The button tapped
// decides the action: fork from a reply (`message.js`), send a message again (`message.js`), or fork the whole session
// from the session list (here). The rows choose where the copy runs (a computer and a folder there), with which model
// and thinking level, and in a git worktree of its own. Unchanged rows copy as the session is.
import { useEffect, useState } from "preact/hooks";
import { copyDraft, modelOf, updateDraft, useCopyDraft } from "../copy-draft.js";
import { shortPath } from "../folder-paths.js";
import {
    actions,
    api,
    attempt,
    canStart,
    closeSheet,
    navigate,
    notify,
    openSheet,
    store,
} from "../store.js";
import { html, Icon, Sheet, Switch } from "../ui.js";

// ─── Rows ─────────────────────────────────────────────────────────────────────────

/** A group of choice rows, one under another. */
export function ChoiceRows({ children, label }) {
    return html`<div class="choice-rows" role="group" aria-label=${label}>${children}</div>`;
}

/**
 * One choice: its label on the left, its value on the right with a muted line under it (`sub`), and a chevron when a
 * tap opens a picker (`onPick`). `open`: the picker it opens shows under it.
 */
export function ChoiceRow({ label, value, sub = null, onPick = null, open = undefined, title }) {
    const body = html`<span class="choice-label">${label}</span>
        <span class="choice-value">
            <span class="choice-main">${value}</span>
            ${sub && html`<span class="choice-sub">${sub}</span>`}
        </span>`;

    if (!onPick) {
        return html`<div class="choice-row" title=${title}>${body}</div>`;
    }

    return html`<button
        type="button"
        class="choice-row"
        title=${title}
        aria-expanded=${open === undefined ? undefined : open ? "true" : "false"}
        onClick=${onPick}
    >
        ${body}
        <${Icon} name=${open ? "down" : "chevron"} size=${14} class="choice-chev" />
    </button>`;
}

/** A choice that is on or off: its label, a muted note, and a switch. */
export function SwitchRow({ label, on, disabled = false, note = null, onChange }) {
    return html`<div class=${`choice-row ${disabled ? "off" : ""}`}>
        <span class="choice-label">${label}</span>
        <span class="choice-value">
            ${note && html`<span class="choice-sub">${note}</span>`}
        </span>
        <${Switch} on=${on} disabled=${disabled} label=${label} onChange=${onChange} />
    </div>`;
}

// ─── Where the copy runs ─────────────────────────────────────────────────────────

/** Why the folder shown is the one suggested (`commands.ts` `copySuggestion`), in a few words. */
const REASONS = {
    current: "this session's folder",
    repository: "same repository",
    name: "same folder name",
    home: "home: no match, pick one",
    picked: null,
};

/** A computer's name: This server, a linked one's, or the session's own when the list does not have it. */
function computerName(runner) {
    if (runner === null || runner === undefined) {
        return "This server";
    }

    const view = store.state.view;

    return (
        store.state.runners.find((each) => each.id === runner)?.name ??
        (view.conversation?.runner === runner ? view.conversation.runnerName : undefined) ??
        store.state.sessions.find((each) => each.runner === runner && each.runnerName)
            ?.runnerName ??
        "another computer"
    );
}

/** A computer's home folder, for short paths: this server's, or a linked computer's as it last reported. */
const homeOf = (runner) =>
    runner === null || runner === undefined
        ? store.state.server?.home
        : store.state.runners.find((each) => each.id === runner)?.home;

/** A model and thinking level in a few words: "Claude Opus 5.5 · high". */
function modelText(ref, level) {
    if (!ref) {
        return "No model";
    }

    const model = modelOf(ref);

    if (!model) {
        return `${ref.modelId}${level && level !== "off" ? ` · ${level}` : ""}`;
    }

    return `${model.name}${model.reasoning ? ` · ${level ?? "off"}` : ""}`;
}

/** Ask the server for a computer's suggested folder (or about `cwd`, one picked), and the session's own place. */
function askPlace(sessionId, runner, cwd = null) {
    const query = new URLSearchParams({ runner: runner ?? "" });

    if (cwd) {
        query.set("cwd", cwd);
    }

    return api(`c/${sessionId}/copy-place?${query}`);
}

/** Prefer the source's computer. With no choices, still show the source's place. */
function preferredRunner(source, choices) {
    const own = source?.runner;
    const choice = choices.find((each) => each.id === own) ?? choices[0];

    return choice ? choice.id : own;
}

/** Show the catalogue's folder without waiting if the copy stays on the source's computer. */
function knownFolder(source, runner) {
    return source && source.runner === runner
        ? { cwd: source.cwd, reason: "current", inRepository: undefined }
        : { cwd: null, reason: null, inRepository: undefined };
}

const suggestedFolder = ({ cwd, reason, inRepository }) => ({ cwd, reason, inRepository });

/** The first answer for a chosen computer confirms the source, without taking back a model or level choice. */
function confirmSource(draft, source) {
    return draft.confirmed
        ? {}
        : {
              source,
              confirmed: true,
              ...(draft.modelPicked
                  ? {}
                  : { model: source.model ?? null, thinkingLevel: source.thinkingLevel ?? "off" }),
          };
}

/** One request per computer at a time. The map also identifies this opening of the sheet, even under a picker. */
function loadPlace(sessionId, runner, places) {
    if (places.has(runner)) {
        return;
    }

    places.set(runner, null);
    askPlace(sessionId, runner).then(
        (place) => {
            places.set(runner, place);
            const now = copyDraft();

            if (now?.places === places && now.runner === runner && canStart(runner)) {
                updateDraft({
                    ...confirmSource(now, place.from),
                    ...(now.picked === undefined ? suggestedFolder(place) : {}),
                    failed: undefined,
                });
            }
        },
        (error) => {
            places.delete(runner);
            const now = copyDraft();

            if (now?.places === places && now.runner === runner && canStart(runner)) {
                updateDraft({ failed: error.message });
            }
        },
    );
}

/** Another computer chosen: show its saved answer in the same draw, or ask if one is not on its way. */
function chooseComputer(sessionId, runner) {
    const now = copyDraft();

    if (!now || !canStart(runner)) {
        return;
    }

    if (runner === now.runner) {
        updateDraft({ computers: false });
    } else {
        const place = now.places.get(runner);

        updateDraft({
            ...(place
                ? { ...confirmSource(now, place.from), ...suggestedFolder(place) }
                : knownFolder(now.source, runner)),
            runner,
            computers: false,
            picked: undefined,
            worktree: false,
            failed: undefined,
        });
    }

    loadPlace(sessionId, runner, now.places);
}

/** Start with the facts in this tab and ask for all allowed computers at once. Pickers keep the same draft. */
export function usePlace(sessionId, key, { enabled = true, extra = () => ({}) } = {}) {
    const { me, runners, sessions, view } = store.state;
    const choices = [{ id: null, name: "This server", online: true }, ...runners].filter((each) =>
        canStart(each.id),
    );
    const draft = useCopyDraft(key, () => {
        const open = view.conversation?.id === sessionId;
        const session =
            sessions.find((each) => each.id === sessionId) ?? (open ? view.conversation : null);
        const agent = open ? view.agent : null;
        const model = agent ? (agent.model ?? null) : undefined;
        const thinkingLevel = agent?.thinkingLevel ?? "off";
        const source = session
            ? { runner: session.runner ?? null, cwd: session.cwd, model, thinkingLevel }
            : undefined;
        const runner = preferredRunner(source, choices);

        return {
            ...extra(),
            ...knownFolder(source, runner),
            source,
            runner,
            model,
            thinkingLevel,
            places: new Map(),
            worktree: false,
            computers: false,
        };
    });

    useEffect(() => {
        const now = copyDraft();

        if (!enabled || now?.places !== draft.places) {
            return;
        }

        if (choices.length > 0 && !choices.some((each) => each.id === now.runner)) {
            chooseComputer(sessionId, preferredRunner(now.source, choices));
        }

        for (const { id } of choices) {
            loadPlace(sessionId, id, now.places);
        }
    }, [draft.places, enabled, me, runners]);

    // A folder picked on this server: whether it is a git repository, for the worktree row.
    useEffect(() => {
        const now = copyDraft();

        if (
            now?.places !== draft.places ||
            now.runner !== null ||
            now.inRepository !== undefined ||
            now.picked === undefined ||
            !canStart(null)
        ) {
            return;
        }

        askPlace(sessionId, null, now.picked).then(
            (place) => {
                const latest = copyDraft();

                if (
                    latest?.places === now.places &&
                    latest.runner === null &&
                    latest.picked === now.picked
                ) {
                    updateDraft({
                        inRepository: place.inRepository,
                        ...(place.inRepository ? {} : { worktree: false }),
                    });
                }
            },
            () => {},
        );
    }, [draft.places, draft.picked]);

    return { draft, choices };
}

/**
 * The rows that choose where a copy runs: computer, folder, model, worktree; and, for another computer, that it asks
 * first. `verb`, the action in the folder picker's title ("Fork", "Send again").
 */
export function PlaceRows({ sessionId, draft, choices, verb }) {
    const { runners, me } = store.state;
    const owner = me?.role === "owner";
    const runner = draft.runner;
    const name = runner === undefined ? "…" : computerName(runner);
    const there = runner !== null && runner !== undefined;
    const allowed = runner !== undefined && canStart(runner);

    useEffect(() => {
        // The linked computers, when this tab has not got the list yet.
        if (owner && runners.length === 0) {
            api("runners").then(
                (list) => store.set({ runners: list }),
                () => {},
            );
        }
    }, []);

    const online = runners.find((each) => each.id === runner)?.online;
    const pickFolder = () =>
        openSheet({
            type: "cwd",
            mode: "pick",
            runner: runner ?? null,
            start: draft.cwd ?? "~",
            title: `${verb}: pick a folder on ${name}`,
        });
    const pickModel = () => openSheet({ type: "model", choose: true });

    return html`<${ChoiceRows} label="Where the copy runs">
            <${ChoiceRow}
                label="Computer"
                value=${html`<span class="choice-computer">
                    ${there && html`<span class=${`runner-dot ${online === false ? "" : "on"}`}></span>`}
                    ${name}
                </span>`}
                sub=${there && online === false ? "offline" : null}
                open=${draft.computers}
                onPick=${choices.length > 1 ? () => updateDraft({ computers: !draft.computers }) : null}
            />
            ${
                draft.computers &&
                html`<div class="choice-options" role="radiogroup" aria-label="Computer">
                    ${choices.map(
                        (each) => html`<button
                            key=${each.id ?? "server"}
                            type="button"
                            role="radio"
                            class=${`choice-option ${each.id === runner ? "on" : ""}`}
                            aria-checked=${each.id === runner ? "true" : "false"}
                            disabled=${!each.online}
                            onClick=${() => chooseComputer(sessionId, each.id)}
                        >
                            <${Icon} name=${each.id === null ? "home" : "monitor"} size=${15} />
                            <span class="grow">${each.name}</span>
                            ${each.id !== null && !each.online && html`<span class="muted small">offline</span>`}
                            ${each.id !== null && html`<span class=${`runner-dot ${each.online ? "on" : ""}`}></span>`}
                            ${each.id === runner && html`<${Icon} name="check" size=${14} />`}
                        </button>`,
                    )}
                </div>`
            }
            <${ChoiceRow}
                label="Folder"
                value=${html`<bdi dir="ltr">${draft.cwd ? shortPath(draft.cwd, homeOf(runner)) : "…"}</bdi>`}
                sub=${draft.reason ? REASONS[draft.reason] : null}
                title=${draft.cwd ?? undefined}
                onPick=${allowed && draft.cwd ? pickFolder : null}
            />
            <${ChoiceRow}
                label="Model"
                value=${draft.model === undefined ? "…" : modelText(draft.model, draft.thinkingLevel)}
                onPick=${allowed && draft.model !== undefined ? pickModel : null}
            />
            <${SwitchRow}
                label="Own git worktree"
                on=${draft.worktree}
                disabled=${!allowed || !draft.cwd || (!there && !draft.inRepository)}
                note=${draft.inRepository === false ? "not a git repository" : null}
                onChange=${() => updateDraft({ worktree: !draft.worktree })}
            />
        <//>
        ${
            there &&
            allowed &&
            html`<p class="muted small copy-asks">
                ${name} asks before the copy starts. Its tools run there.
            </p>`
        }
        ${draft.failed && html`<p class="muted small copy-asks">${draft.failed}</p>`}`;
}

/**
 * What the copy's request says of its place: only what the person changed, so a copy with no row changed is the copy
 * it always was. Undefined: nothing changed.
 */
export function placeOf(draft) {
    const source = draft.source;

    if (!source || !draft.cwd || draft.runner === undefined) {
        return undefined;
    }

    const place = {};
    const moved = draft.runner !== source.runner;

    if (moved) {
        place.runner = draft.runner;
    }

    if (moved || draft.cwd !== source.cwd) {
        place.cwd = draft.cwd;
    }

    // A model or level changed: both go, so the copy has the pair the sheet shows.
    if (
        draft.model &&
        (draft.model.provider !== source.model?.provider ||
            draft.model.modelId !== source.model?.modelId ||
            draft.thinkingLevel !== (source.thinkingLevel ?? "off"))
    ) {
        place.model = draft.model;
        place.thinkingLevel = draft.thinkingLevel;
    }

    if (draft.worktree) {
        place.worktree = true;
    }

    return Object.keys(place).length === 0 ? undefined : place;
}

/** A copy on its way: a second tap waits for it. */
let copying = false;

/** Make the copy with `run` and open it. A second tap while the first is on its way does nothing. */
export function startCopy(run, notice) {
    if (copying) {
        return Promise.resolve();
    }

    copying = true;

    return attempt(async () => {
        // A new folder waits for its approval in Pi Pocket (`folder-requests.js`), here as on a runner.
        const created = await run(undefined);

        if (!created) {
            return;
        }

        navigate(created.id);
        notify("info", notice);
    }).finally(() => {
        copying = false;
    });
}

/** Ctrl/⌘+Enter presses the main button while the sheet `type` is on top. */
export function useMainKey(type, press) {
    useEffect(() => {
        const onKey = (event) => {
            if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !event.isComposing &&
                store.state.sheet?.type === type
            ) {
                event.preventDefault();
                press();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [type, press]);
}

/** The main action needs a complete place and the right to start a session on its computer. */
export const copyReady = (draft) =>
    !!draft?.source && !!draft.cwd && draft.runner !== undefined && canStart(draft.runner);

/** Read the place again at the tap or keypress, in case the rows have not drawn the latest choice yet. */
export function readyDraft(draft) {
    const now = copyDraft();

    return now?.places === draft.places && copyReady(now) ? now : null;
}

/** The main button and its note, shared by the three copy sheets. */
export function CopyAction({ label, choices, disabled, onClick, children }) {
    return html`<div class="copy-go">
        <button type="button" class="button primary wide" disabled=${disabled} onClick=${onClick}>
            ${label}
        </button>
        <p class="muted small">
            ${choices.length === 0 ? "You cannot start sessions on any computer." : children}
        </p>
    </div>`;
}

// ─── Fork a whole session ─────────────────────────────────────────────────────────

/** Session menu → Fork: a copy of the whole session, with the place rows. */
export function ForkSessionSheet({ id }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const { draft, choices } = usePlace(id, `session:${id}`);
    const [busy, setBusy] = useState(false);

    const go = () => {
        const now = readyDraft(draft);

        if (busy || !now) {
            return;
        }

        setBusy(true);
        startCopy(
            (signal) => actions.forkSession(id, placeOf(now), signal),
            "Opened the fork. The original is unchanged.",
        ).finally(() => setBusy(false));
    };

    useMainKey("fork", go);

    return html`<${Sheet} title="Fork this session" onClose=${closeSheet} className="copy-sheet">
        <div class="copy-what">${session?.title ?? "New session"}</div>
        <${PlaceRows} sessionId=${id} draft=${draft} choices=${choices} verb="Fork" />
        <${CopyAction}
            label="Fork"
            choices=${choices}
            disabled=${busy || !copyReady(draft)}
            onClick=${go}
        >
            A new session with everything up to the last reply. The original stays as it is.
        <//>
    <//>`;
}
