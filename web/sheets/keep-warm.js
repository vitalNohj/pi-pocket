// Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, and the row a session
// chooses its own with.
import { useEffect, useState } from "preact/hooks";
import { actions, api, attempt, canSteer, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

/** The time limits on offer, in hours; null: no time limit. The server takes these only. */
const HOURS = [
    [0, "Off"],
    [1, "1 h"],
    [2, "2 h"],
    [4, "4 h"],
    [8, "8 h"],
    [null, "No time limit"],
];

/** Models past this many get a box to find them by. */
const MODEL_SEARCH_AT = 8;

const money = (amount) => `$${amount.toFixed(2)}`;

/** "45 min", "1 h", "1 h 30 min". */
export function minutesLabel(ms) {
    const minutes = Math.round(ms / 60_000);

    if (minutes < 60) {
        return `${Math.max(minutes, 1)} min`;
    }

    const rest = minutes % 60;

    return `${Math.floor(minutes / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
}

/** The default as a session's row names it: "2 h", "no time limit", or "off". */
export function defaultLabel(hours) {
    return hours === 0 ? "off" : hours === null ? "no time limit" : `${hours} h`;
}

/** The menu row's hint: the time limit, or what is warm now. */
export function keepWarmHint() {
    const hours = store.state.server?.keepWarm?.hours;

    return hours === undefined ? "" : hours === 0 ? "off" : `after a run: ${defaultLabel(hours)}`;
}

/** Whether this server keeps sessions warm once their run ends. */
export function keepWarmAvailable() {
    return store.state.server?.keepWarm !== undefined;
}

/** A number field that saves when it loses focus or Enter is pressed, and shows what the server kept. */
function NumberField({
    value,
    min,
    max,
    step = 1,
    label,
    placeholder = "",
    onSave,
    width = "4.5rem",
}) {
    const [draft, setDraft] = useState(null);
    const shown = draft ?? (value === undefined || value === null ? "" : String(value));

    const save = () => {
        if (draft === null) {
            return;
        }

        const text = draft.trim();

        setDraft(null);

        if (text === "") {
            onSave(null);

            return;
        }

        const number = Number(text);

        if (Number.isFinite(number) && number >= min && number <= max) {
            onSave(number);
        }
    };

    return html`<input
        type="number"
        inputmode="decimal"
        class="keep-warm-number"
        style=${`width:${width}`}
        min=${min}
        max=${max}
        step=${step}
        aria-label=${label}
        placeholder=${placeholder}
        value=${shown}
        onInput=${(event) => setDraft(event.currentTarget.value)}
        onBlur=${save}
        onKeyDown=${(event) => event.key === "Enter" && event.currentTarget.blur()}
    />`;
}

export function KeepWarmSheet() {
    const [data, setData] = useState(null);
    const [query, setQuery] = useState("");
    const load = () => attempt(async () => setData(await api("keep-warm")));

    useEffect(() => {
        load();
    }, []);

    const save = (patch) =>
        attempt(async () => {
            setData(await api("keep-warm", patch));
        });

    if (data === null) {
        return html`<${Sheet} title="Keep warm" onClose=${closeSheet}>
            <${Loader} label="Loading" />
        <//>`;
    }

    const { settings, models, now } = data;
    const off = settings.hours === 0;
    const needle = query.trim().toLowerCase();
    const groups = new Map();

    for (const model of models) {
        const provider = model.spec.slice(0, model.spec.indexOf("/"));

        if (needle === "" || `${model.spec} ${model.name}`.toLowerCase().includes(needle)) {
            groups.set(provider, [...(groups.get(provider) ?? []), model]);
        }
    }

    const prefill = (model) =>
        model.lifetime === undefined
            ? ""
            : String(
                  Math.max(
                      1,
                      Math.floor(
                          Math.min(
                              model.lifetime * settings.share * 10,
                              model.lifetime * 1000 - 10_000,
                          ) / 60_000,
                      ),
                  ),
              );

    return html`<${Sheet} title="Keep warm" onClose=${closeSheet} className="keep-warm-sheet">
        <p class="muted small">
            After Pi finishes, Pocket sends the last request again just before its prompt cache expires, so your next
            message reads the cache instead of paying to write it again. Each refresh costs a cache read, and counts in
            Spend.
        </p>
        ${
            now.warm > 0 &&
            html`<p class="small keep-warm-now">
                <span class="pulse"></span> ${now.warm === 1 ? "1 session" : `${now.warm} sessions`} warm now ·
                ${now.refreshes} ${now.refreshes === 1 ? "refresh" : "refreshes"} · ${money(now.spent)}
            </p>`
        }
        <section class="keep-warm-group">
            <div class="label">After a run ends, keep sessions warm for</div>
            <div class="segmented" role="group" aria-label="How long to keep sessions warm">
                ${HOURS.map(
                    ([value, label]) => html`<button
                        class=${settings.hours === value ? "on" : ""}
                        aria-pressed=${settings.hours === value}
                        onClick=${() => save({ hours: value })}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
            <p class="muted small">
                ${
                    off
                        ? "Off: caches expire as before. A session can still be kept warm from its menu."
                        : settings.hours === null
                          ? "Until someone sends a message, or a cap below is reached."
                          : `Stops ${settings.hours} h after the run ended, when someone sends a message, or at a cap below.`
                }${" "}A new message, another model, a compaction, New context, or archiving stops it too.
            </p>
        </section>
        <section class="keep-warm-group">
            <div class="label">Caps for each session</div>
            <label class="keep-warm-row">
                <span>Most it may spend<span class="muted small">each time Pi finishes; 0: no cap</span></span>
                <span class="keep-warm-input">
                    $<${NumberField}
                        value=${settings.maxCost}
                        min=${0}
                        max=${1000}
                        step=${0.5}
                        label="Most a session may spend on keeping warm, in dollars"
                        onSave=${(value) => value !== null && save({ maxCost: value })}
                    />
                </span>
            </label>
            <label class="keep-warm-row">
                <span>Most refreshes<span class="muted small">also stops models that cost $0</span></span>
                <${NumberField}
                    value=${settings.maxRefreshes}
                    min=${1}
                    max=${10000}
                    label="Most refreshes for a session"
                    onSave=${(value) => value !== null && save({ maxRefreshes: value })}
                />
            </label>
            <div class="keep-warm-row">
                <span>Subagents too<span class="muted small">a subagent that is not running is warm too</span></span>
                <div class="segmented" role="group" aria-label="Keep subagents warm too">
                    ${[
                        [false, "No"],
                        [true, "Yes"],
                    ].map(
                        ([value, label]) => html`<button
                            class=${settings.subagents === value ? "on" : ""}
                            aria-pressed=${settings.subagents === value}
                            onClick=${() => save({ subagents: value })}
                        >
                            ${label}
                        </button>`,
                    )}
                </div>
            </div>
        </section>
        <section class="keep-warm-group">
            <div class="label">Refresh at</div>
            <label class="keep-warm-row">
                <span>Share of each model's cache lifetime<span class="muted small">75%: every 45 min for a 1 h cache</span></span>
                <span class="keep-warm-input">
                    <${NumberField}
                        value=${settings.share}
                        min=${10}
                        max=${95}
                        label="Share of a cache lifetime between refreshes, in percent"
                        onSave=${(value) => value !== null && save({ share: value })}
                    />%
                </span>
            </label>
        </section>
        <section class="keep-warm-group">
            <div class="label">Models</div>
            <p class="muted small">
                Minutes between refreshes. Blank: the grey number, from the model's cache lifetime and the share above.
                0: never keep this model warm. A model with no known lifetime is kept warm only once you type minutes.
                A refresh that finds the cache gone counts as a failure, and two in a row stop it, so a wrong number
                costs at most two cache writes.
            </p>
            ${
                (models.length > MODEL_SEARCH_AT || query !== "") &&
                html`<label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        placeholder="Find a model"
                        aria-label="Find a model to keep warm"
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>`
            }
            <div class="subagent-models-list" role="group" aria-label="Minutes by model">
                ${
                    groups.size === 0 &&
                    html`<p class="muted small">
                        ${models.length === 0 ? "No models: sign in to a provider first." : "No model matches."}
                    </p>`
                }
                ${[...groups].map(
                    ([provider, list]) => html`<div key=${provider}>
                        <div class="subagent-models-head">${provider}</div>
                        ${list.map((model) => {
                            const set = settings.minutes[model.spec];

                            return html`<label class="subagent-model keep-warm-model" key=${model.spec}>
                                <span>
                                    ${model.name}
                                    <span class="muted small">
                                        ${
                                            model.lifetime === undefined
                                                ? html`<span class="warn">cache lifetime not known</span>`
                                                : `cache ${minutesLabel(model.lifetime * 1000)}`
                                        }
                                        ${set === 0 ? " · never" : ""}
                                    </span>
                                </span>
                                <span class="keep-warm-input">
                                    every
                                    <${NumberField}
                                        value=${set}
                                        min=${0}
                                        max=${1440}
                                        width="3.6rem"
                                        label=${`Minutes between refreshes for ${model.name}`}
                                        placeholder=${prefill(model) || "—"}
                                        onSave=${(value) => save({ minutes: { [model.spec]: value } })}
                                    />
                                    min
                                </span>
                            </label>`;
                        })}
                    </div>`,
                )}
            </div>
        </section>
    <//>`;
}

/**
 * A session's own choice, in its menu and a reply's menu: the owner's default, no time limit, or off. Shows when the
 * next refresh goes out, or why it last stopped.
 */
export function KeepWarmRow() {
    const { view, me, server } = store.state;
    const conversation = view.conversation;
    const state = conversation?.keepWarm;

    if (!state || server?.keepWarm === undefined || conversation.kind !== "session") {
        return null;
    }

    const owner = me?.role === "owner";
    const steer = canSteer();
    const choose = (choice) =>
        attempt(() => actions.updateSession(conversation.id, { keepWarm: choice }));
    const status = state.status;
    const line = status.warm
        ? `warm · next ${new Date(status.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${status.refreshes} ${status.refreshes === 1 ? "refresh" : "refreshes"} · ${money(status.spent)} · every ${minutesLabel(status.everyMs)}`
        : status.stopped
          ? `stopped: ${status.stopped}`
          : "nothing warm now";

    return html`<div class="keep-warm-session">
        <div class="keep-warm-session-head">
            <span>Keep this session warm</span>
            <span class=${`small ${status.warm ? "ok" : "muted"}`}>${status.warm ? "warm" : ""}</span>
        </div>
        <div class="segmented" role="group" aria-label="Keep this session warm">
            ${[
                ["default", `Default (${defaultLabel(server.keepWarm.hours)})`],
                ["on", "No time limit"],
                ["off", "Off"],
            ].map(
                ([value, label]) => html`<button
                    class=${state.choice === value ? "on" : ""}
                    aria-pressed=${state.choice === value}
                    disabled=${!steer || (!owner && value === "on" && state.choice !== value)}
                    onClick=${() => state.choice !== value && choose(value)}
                >
                    ${label}
                </button>`,
            )}
        </div>
        <div class="muted small">${line}</div>
    </div>`;
}
