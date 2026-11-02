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

    const segmented = (label, options, current, key) => html`<div
        class="segmented"
        role="group"
        aria-label=${label}
    >
        ${options.map(
            ([value, text]) => html`<button
                class=${current === value ? "on" : ""}
                aria-pressed=${current === value}
                onClick=${() => save({ [key]: value })}
            >
                ${text}
            </button>`,
        )}
    </div>`;
    const custom = Object.keys(settings.minutes).length;
    const warmable = models.filter(
        (model) =>
            settings.minutes[model.spec] !== 0 &&
            (model.lifetime !== undefined || settings.minutes[model.spec] > 0),
    ).length;

    return html`<${Sheet} title="Keep warm" onClose=${closeSheet} className="keep-warm-sheet">
        <div class="keep-warm-layout">
            <div class="keep-warm-settings">
                <p class="muted small">
                    After Pi finishes, Pocket sends the last request again just before its prompt cache expires, so your
                    next message reads the cache instead of writing it again. Each refresh costs a cache read and counts
                    in Spend.
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
                    ${segmented("How long to keep sessions warm", HOURS, settings.hours, "hours")}
                    <p class="muted small">
                        ${
                            off
                                ? "Off: caches expire as before. A session can still be kept warm from its menu."
                                : settings.hours === null
                                  ? "Until a cap below is reached."
                                  : `Stops ${settings.hours} h after the run ended, or at a cap below.`
                        }${" "}A new message, another model, a compaction, New context, or archiving stops it.
                    </p>
                </section>
                <section class="keep-warm-group keep-warm-grid">
                    <label class="keep-warm-field">
                        <span>Most it may spend</span>
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
                        <span class="muted small">per session, each time Pi finishes; 0: no cap</span>
                    </label>
                    <label class="keep-warm-field">
                        <span>Most refreshes</span>
                        <span class="keep-warm-input">
                            <${NumberField}
                                value=${settings.maxRefreshes}
                                min=${1}
                                max=${10000}
                                label="Most refreshes for a session"
                                onSave=${(value) => value !== null && save({ maxRefreshes: value })}
                            />
                        </span>
                        <span class="muted small">also stops models that cost $0</span>
                    </label>
                    <label class="keep-warm-field">
                        <span>Refresh at</span>
                        <span class="keep-warm-input">
                            <${NumberField}
                                value=${settings.share}
                                min=${10}
                                max=${95}
                                label="Share of a cache lifetime between refreshes, in percent"
                                onSave=${(value) => value !== null && save({ share: value })}
                            />%
                        </span>
                        <span class="muted small">of each cache lifetime; 75%: every 45 min for 1 h</span>
                    </label>
                    <div class="keep-warm-field">
                        <span>Subagents too</span>
                        ${segmented(
                            "Keep subagents warm too",
                            [
                                [false, "No"],
                                [true, "Yes"],
                            ],
                            settings.subagents,
                            "subagents",
                        )}
                        <span class="muted small">subagents that are not running</span>
                    </div>
                </section>
            </div>
            <section class="keep-warm-models">
                <div class="keep-warm-models-head">
                    <div class="label">Models</div>
                    <span class="muted small">${warmable} of ${models.length} kept warm${custom > 0 ? ` · ${custom} set by you` : ""}</span>
                </div>
                <p class="muted small">
                    Minutes between refreshes. Blank uses the grey number, from the model's cache lifetime and the share.
                    0: never. A model with no known lifetime is kept warm only with minutes. Two refreshes in a row that
                    find the cache gone stop it, so a wrong number costs at most two cache writes.
                </p>
                <label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        placeholder="Find a model"
                        aria-label="Find a model to keep warm"
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                <div class="keep-warm-model-list" role="group" aria-label="Minutes by model">
                    ${
                        groups.size === 0 &&
                        html`<p class="muted small">
                            ${models.length === 0 ? "No models: sign in to a provider first." : "No model matches."}
                        </p>`
                    }
                    ${[...groups].map(
                        ([provider, list]) => html`<div class="keep-warm-provider" key=${provider}>
                            <div class="subagent-models-head">${provider} <span class="muted">${list.length}</span></div>
                            <div class="keep-warm-model-grid">
                                ${list.map((model) => {
                                    const set = settings.minutes[model.spec];

                                    return html`<label
                                        class=${`keep-warm-model ${set === 0 ? "never" : ""}`}
                                        key=${model.spec}
                                    >
                                        <span class="keep-warm-model-name">
                                            <span title=${model.spec}>${model.name}</span>
                                            <span class="muted small">
                                                ${
                                                    model.lifetime === undefined
                                                        ? html`<span class="warn">lifetime not known</span>`
                                                        : `cache ${minutesLabel(model.lifetime * 1000)}`
                                                }${set === 0 ? " · never" : ""}
                                            </span>
                                        </span>
                                        <span class="keep-warm-input">
                                            <${NumberField}
                                                value=${set}
                                                min=${0}
                                                max=${1440}
                                                width="4rem"
                                                label=${`Minutes between refreshes for ${model.name}`}
                                                placeholder=${prefill(model) || "—"}
                                                onSave=${(value) => save({ minutes: { [model.spec]: value } })}
                                            />
                                            <span class="muted small">min</span>
                                        </span>
                                    </label>`;
                                })}
                            </div>
                        </div>`,
                    )}
                </div>
            </section>
        </div>
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
