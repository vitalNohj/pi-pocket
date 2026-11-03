// Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, and the row a session
// chooses its own time with.
import { useEffect, useState } from "preact/hooks";
import { actions, api, attempt, canSteer, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

/** The times on offer: off, Auto, or hours. The server takes these only. */
const TIMES = [
    [0, "Off"],
    ["auto", "Auto"],
    [1, "1 h"],
    [2, "2 h"],
    [4, "4 h"],
    [8, "8 h"],
];

/** What Auto means, said the same way wherever it can be chosen. */
const AUTO =
    "Auto keeps the cache warm until the refreshes have cost as much as writing the cache once more, then lets it expire. Come back before then and you save; stay away longer and you pay at most about twice what letting it expire would have cost.";

const money = (amount) =>
    amount >= 100
        ? `$${Math.round(amount)}`
        : amount >= 0.995 || amount === 0
          ? `$${amount.toFixed(2)}`
          : `$${amount.toFixed(3)}`;

/** A span of time: "45 min", "1 h", "1 h 30 min", "2 d 4 h". */
function durationLabel(ms) {
    const minutes = Math.round(ms / 60_000);

    if (minutes < 60) {
        return `${Math.max(minutes, 1)} min`;
    }

    if (minutes >= 48 * 60) {
        const hours = Math.round(minutes / 60);

        return `${Math.floor(hours / 24)} d${hours % 24 === 0 ? "" : ` ${hours % 24} h`}`;
    }

    const rest = minutes % 60;

    return `${Math.floor(minutes / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
}

/** A keep-warm time in words: "Auto", "2 h", or "Off". */
function timeLabel(hours) {
    return hours === 0 ? "Off" : hours === "auto" ? "Auto" : `${hours} h`;
}

/** The menu row's hint: the owner's time. */
export function keepWarmHint() {
    const hours = store.state.server?.keepWarm?.hours;

    return hours === undefined ? "" : hours === 0 ? "off" : `after a run: ${timeLabel(hours)}`;
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
    step = "1",
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

/**
 * Where Auto stops, as text, as the owner approved it: the makers' list prices and cache times (2026-11-02), a refresh
 * at 75% of the cache time, a 150k context, and a 30-refresh cap. Nothing here is read from a model or a provider.
 */
const AUTO_TABLE = [
    ["Claude Opus 5.5", "1 h", "$0.200/M", "22 h 30 min (30)", "$0.900"],
    ["GPT-6.1 Sol", "30 min", "$0.100/M", "9 h 10 min (25)", "$0.375"],
    ["GPT-6.1 Terra", "30 min", "$0.050/M", "9 h 10 min (25)", "$0.188"],
    ["Grok 4.7", "?", "$0.500/M", "3 h (4)", "$0.300"],
];

/** One model in the settings window: its cache cost, when its cache expires, and what keep warm does with it. */
function ModelCard({ model, settings, onSet }) {
    const { everyMinutes, refreshes, autoStopMinutes } = model.plan;
    const own = settings.models[model.spec]?.lifetime;
    const read = model.known.read;

    return html`<div class="keep-warm-model">
        <div class="keep-warm-model-name" title=${model.spec}>${model.name}</div>
        ${
            read === undefined
                ? html`<label class="keep-warm-model-row">
                      <span class="muted">Cache cost</span>
                      <span class="keep-warm-input">
                          <span class="muted small">$</span>
                          <${NumberField}
                              value=${settings.models[model.spec]?.read}
                              min=${0}
                              max=${10_000}
                              step="any"
                              width="4.5rem"
                              label=${`Dollars per million tokens to read the cache of ${model.name}`}
                              placeholder="?"
                              onSave=${(value) => onSet("read", value)}
                          />
                          <span class="muted small">per million tokens</span>
                      </span>
                  </label>`
                : html`<div class="keep-warm-model-row">
                      <span class="muted">Cache cost</span>
                      <span>${money(read)} per million tokens</span>
                  </div>`
        }
        <label class="keep-warm-model-row">
            <span class="muted">Cache expires after</span>
            <span class="keep-warm-input">
                <${NumberField}
                    value=${own}
                    min=${1}
                    max=${10_080}
                    width="4rem"
                    label=${`Minutes until the cache of ${model.name} expires`}
                    placeholder=${model.known.lifetime === undefined ? "" : String(model.known.lifetime)}
                    onSave=${(value) => onSet("lifetime", value)}
                />
                <span class="muted small">min idle</span>
            </span>
        </label>
        <div class="small ${everyMinutes === undefined ? "warn" : "muted"}">
            ${
                everyMinutes === undefined
                    ? "Not kept warm: its maker publishes no cache time. Type it to turn it on."
                    : `Refreshed every ${durationLabel(everyMinutes * 60_000)} · Auto stops after ${durationLabel(autoStopMinutes * 60_000)} (${refreshes} ${refreshes === 1 ? "refresh" : "refreshes"})`
            }
        </div>
    </div>`;
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
    const needle = query.trim().toLowerCase();
    const groups = new Map();

    for (const model of models) {
        const provider = model.spec.slice(0, model.spec.indexOf("/"));

        if (needle === "" || `${model.spec} ${model.name}`.toLowerCase().includes(needle)) {
            groups.set(provider, [...(groups.get(provider) ?? []), model]);
        }
    }

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
    const warmable = models.filter((model) => model.plan.everyMinutes !== undefined);
    const setModel = (spec, field, value) => save({ models: { [spec]: { [field]: value } } });

    return html`<${Sheet} title="Keep warm" onClose=${closeSheet} className="keep-warm-sheet">
        <div class="keep-warm-layout">
            <div class="keep-warm-settings">
                <p class="muted small">
                    Pocket sends the smallest possible request to keep the cache alive. This is cheaper than no
                    cache, until you have paid what you would have paid anyway (Auto).
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
                    ${segmented("How long to keep sessions warm", TIMES, settings.hours, "hours")}
                    <p class="muted small">
                        ${
                            settings.hours === 0
                                ? "Off. A session can still be kept warm from its menu."
                                : settings.hours === "auto"
                                  ? AUTO
                                  : `Stops ${settings.hours} h after the run ended, or at a cap below.`
                        }
                    </p>
                    ${
                        settings.hours === "auto" &&
                        html`<table class="keep-warm-stops small">
                            <thead>
                                <tr>
                                    <th scope="col">Model</th>
                                    <th scope="col">Cache</th>
                                    <th scope="col">Read</th>
                                    <th scope="col">Stops after</th>
                                    <th scope="col">Cost</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${AUTO_TABLE.map(
                                    ([name, ...cells]) => html`<tr key=${name}>
                                        <th scope="row">${name}</th>
                                        ${cells.map((cell, index) => html`<td key=${index}>${cell}</td>`)}
                                    </tr>`,
                                )}
                            </tbody>
                        </table>
                        <p class="muted small">List prices, a 150k context. Grok publishes no cache time.</p>`
                    }
                </section>
                <section class="keep-warm-group keep-warm-grid">
                    <label class="keep-warm-field">
                        <span>Most it may spend</span>
                        <span class="keep-warm-input">
                            $<${NumberField}
                                value=${settings.maxCost}
                                min=${0}
                                max=${1000}
                                step="any"
                                label="Most a session may spend on keeping warm, in dollars"
                                onSave=${(value) => value !== null && save({ maxCost: value })}
                            />
                        </span>
                        <span class="muted small">per session; 0: no cap</span>
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
                        <span class="muted small">per session</span>
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
                        <span class="muted small">of the cache time</span>
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
                    </div>
                </section>
            </div>
            <section class="keep-warm-models">
                <div class="keep-warm-models-head">
                    <div class="label">Models</div>
                    <span class="muted small">${warmable.length} of ${models.length} kept warm</span>
                </div>
                <p class="muted small">
                    "Min idle": minutes from the last request until the cache is gone. Grey: the maker's published
                    time; type your own to replace it, or clear it to go back.
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
                <div class="keep-warm-model-list" role="group" aria-label="Keep warm by model">
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
                                ${list.map(
                                    (model) => html`<${ModelCard}
                                        key=${model.spec}
                                        model=${model}
                                        settings=${settings}
                                        onSet=${(field, value) => setModel(model.spec, field, value)}
                                    />`,
                                )}
                            </div>
                        </div>`,
                    )}
                </div>
            </section>
        </div>
    <//>`;
}

/**
 * A session's own time, in its menu and a reply's menu: the owner's default, Auto, a fixed time, or off. Shows when the
 * next refresh goes out and when it stops, or why it last stopped.
 */
export function KeepWarmRow() {
    const { view, server } = store.state;
    const conversation = view.conversation;
    const state = conversation?.keepWarm;

    if (!state || server?.keepWarm === undefined || conversation.kind !== "session") {
        return null;
    }

    const steer = canSteer();
    const choose = (choice) =>
        attempt(() => actions.updateSession(conversation.id, { keepWarm: choice }));
    const status = state.status;
    const time = (at) =>
        new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const fallback = server.keepWarm.hours;
    const chosen = state.choice === "default" ? fallback : state.choice;
    // The owner's time is named in the Default button, so it is not a button of its own. Only the owner turns it on.
    const owner = store.state.me?.role === "owner";
    const choices = [
        ["default", `Default: ${timeLabel(fallback)}`],
        ...[...TIMES.slice(1), [0, "Off"]].filter(
            ([value]) => value !== fallback && (owner || value === 0 || value === state.choice),
        ),
    ];
    const line = status.warm
        ? [
              `next ${time(status.nextAt)}`,
              `${status.refreshes} of ${status.maxRefreshes} refreshes`,
              money(status.spent),
              `every ${durationLabel(status.everyMs)}`,
              status.until === undefined ? "" : `until ${time(status.until)}`,
          ]
              .filter(Boolean)
              .join(" · ")
        : status.stopped
          ? `stopped: ${status.stopped}`
          : chosen === 0
            ? "not kept warm"
            : chosen === "auto"
              ? "until keeping warm stops paying off"
              : `${chosen} h after Pi finishes`;

    return html`<div class="keep-warm-session">
        <div class="keep-warm-session-head">
            <span>Keep this session warm</span>
            <span class=${`small ${status.warm ? "ok" : "muted"}`}>${status.warm ? "warm" : ""}</span>
        </div>
        <div class="segmented keep-warm-times" role="group" aria-label="Keep this session warm">
            ${choices.map(
                ([value, label]) => html`<button
                    class=${state.choice === value ? "on" : ""}
                    aria-pressed=${state.choice === value}
                    title=${value === "default" ? "The owner's default" : value === "auto" ? AUTO : ""}
                    disabled=${!steer}
                    onClick=${() => state.choice !== value && choose(value)}
                >
                    ${label}
                </button>`,
            )}
        </div>
        <div class="muted small">${line}</div>
    </div>`;
}
