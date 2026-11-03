// Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, and the row a session
// chooses its own time with.
import { useEffect, useState } from "preact/hooks";
import { actions, api, attempt, canSteer, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

/** The times on offer: off, hours (0.5: 30 minutes), or Break-even. The server takes these only. */
const TIMES = [
    [0, "Off"],
    [0.5, "30 min"],
    [1, "1 h"],
    [2, "2 h"],
    [4, "4 h"],
    [8, "8 h"],
    ["break-even", "Break-even"],
];

/** What Break-even means, said the same way wherever it can be chosen. */
const BREAK_EVEN =
    "Keeps the cache warm until it has cost as much as one message without a cache, then stops.";

/**
 * The example every estimate uses, as text the owner approved: Claude Opus 5.5's list prices (2026-11-02) per million
 * tokens, its 1-hour cache, and a 150k context. Nothing here is read from a model or a provider.
 */
const EXAMPLE = {
    name: "Claude Opus 5.5",
    read: 0.2,
    write: 8,
    cacheMinutes: 60,
    context: 150_000,
};

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

/** A keep-warm time in words: "Off", "30 min", "2 h", or "Break-even". */
function timeLabel(hours) {
    // A server from before 0.28 (not released) still calls Break-even "auto".
    return hours === "auto"
        ? "Break-even"
        : (TIMES.find(([value]) => value === hours)?.[1] ?? `${hours} h`);
}

/**
 * What a time costs for the example model under the owner's refresh share and cap: refreshes, their cost, and what
 * one message costs without a cache. The same arithmetic as `idleEveryMs` and `breakEvenRefreshes`.
 */
function estimate(hours, settings) {
    const every = Math.floor(
        Math.min((EXAMPLE.cacheMinutes * settings.share) / 100, EXAMPLE.cacheMinutes - 1 / 6),
    );
    const perRefresh = (EXAMPLE.context * EXAMPLE.read) / 1_000_000;
    const refreshes =
        hours === "break-even"
            ? Math.min(Math.floor(EXAMPLE.write / EXAMPLE.read) - 1, settings.maxRefreshes)
            : Math.floor((hours * 60) / every);

    return {
        refreshes,
        cost: refreshes * perRefresh,
        lasts: refreshes * every,
        uncached: (EXAMPLE.context * EXAMPLE.write) / 1_000_000,
    };
}

/** The estimate under the times: what the chosen time does for the example model, in two short lines. */
function Estimate({ hours, settings }) {
    const { refreshes, cost, lasts, uncached } = estimate(hours, settings);
    const example = `${EXAMPLE.name}, 150k context:`;
    const plural = (count) => `${count} ${count === 1 ? "refresh" : "refreshes"}`;
    let what;

    if (hours === 0) {
        what = html`once its cache expires, the next message costs about <b>${money(uncached)}</b>.`;
    } else if (hours === "break-even") {
        what = html`at most <b>${money(uncached)}</b>, the cost of one message without a cache. ${
            refreshes < Math.floor(EXAMPLE.write / EXAMPLE.read) - 1
                ? html`Your refresh cap stops it sooner: ${plural(refreshes)}, <b>${money(cost)}</b>, about ${durationLabel(lasts * 60_000)}.`
                : html`About ${plural(refreshes)} over ${durationLabel(lasts * 60_000)}.`
        }`;
    } else if (refreshes === 0) {
        what = html`<b>no refreshes</b>, as its cache already lasts ${EXAMPLE.cacheMinutes} min. This time helps models with a shorter cache.`;
    } else {
        what = html`about ${plural(refreshes)} in ${timeLabel(hours)}, <b>${money(cost)}</b>. Without keep warm, the next message costs about <b>${money(uncached)}</b>.`;
    }

    return html`<div class="keep-warm-estimate small">
        ${hours === "break-even" && html`<div>${BREAK_EVEN}</div>`}
        <div><span class="muted">${example}</span> ${what}</div>
    </div>`;
}

/** The menu row's hint: the owner's time. */
export function keepWarmHint() {
    const hours = store.state.server?.keepWarm?.hours;

    return hours === undefined ? "" : hours === 0 ? "off" : `after a run: ${timeLabel(hours)}`;
}

/** Whether keep warm is on for a session: its own time, or the owner's default, is not Off. */
export function keepWarmOn(conversation) {
    const choice = conversation?.keepWarm?.choice;
    const hours = store.state.server?.keepWarm?.hours;

    return (
        choice !== undefined && hours !== undefined && (choice === "default" ? hours : choice) !== 0
    );
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
 * Where Break-even stops, as text, as the owner approved it: the makers' list prices and cache times (2026-11-02), a
 * refresh at 75% of the cache time, a 150k context, and a 30-refresh cap. Nothing here is read from a model or a
 * provider. Keep warm's whole cost to that stop, and one message's without a cache.
 */
const BREAK_EVEN_TABLE = [
    ["Claude Opus 5.5", "1 h", "22 h 30 min", 30, "$0.90", "$1.20"],
    ["GPT-6.1 Sol", "30 min", "8 h 48 min", 24, "$0.36", "$0.38"],
    ["GPT-6.1 Terra", "30 min", "8 h 48 min", 24, "$0.18", "$0.19"],
];

/** One model in the settings window: its cache cost, when its cache expires, and what keep warm does with it. */
function ModelCard({ model, settings, onSet }) {
    const { everyMs, refreshes, autoStopMs } = model.plan;
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
        <div class="small ${everyMs === undefined ? "warn" : "muted"}">
            ${
                everyMs === undefined
                    ? "Not kept warm: its maker publishes no cache time. Type it to turn it on."
                    : `Refreshed every ${durationLabel(everyMs)} · Break-even stops after ${durationLabel(autoStopMs)} (${refreshes} ${refreshes === 1 ? "refresh" : "refreshes"})`
            }
        </div>
    </div>`;
}

export function KeepWarmSheet() {
    const [data, setData] = useState(null);
    const [query, setQuery] = useState("");
    const [advanced, setAdvanced] = useState(false);
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
    const warmable = models.filter((model) => model.plan.everyMs !== undefined);
    const unknown = models.length - warmable.length;
    const setModel = (spec, field, value) => save({ models: { [spec]: { [field]: value } } });

    return html`<${Sheet} title="Keep warm" onClose=${closeSheet} className="keep-warm-sheet">
        <div class="keep-warm-layout">
            <div class="keep-warm-settings">
                ${
                    now.warm > 0 &&
                    html`<p class="small keep-warm-now">
                        <span class="pulse"></span> ${now.warm === 1 ? "1 session" : `${now.warm} sessions`} warm now ·
                        ${now.refreshes} ${now.refreshes === 1 ? "refresh" : "refreshes"} · ${money(now.spent)}
                    </p>`
                }
                <p class="muted small">
                    Pocket sends the smallest possible request to keep the cache alive. This is cheaper than no
                    cache, until you have paid what you would have paid anyway (Break-even).
                </p>
                <section class="keep-warm-group">
                    <div class="label">After a run ends, keep sessions warm for</div>
                    ${segmented("How long to keep sessions warm", TIMES, settings.hours, "hours")}
                    <${Estimate} hours=${settings.hours} settings=${settings} />
                </section>
                <section class="keep-warm-group">
                    <div class="label">Where Break-even stops</div>
                    <table class="keep-warm-stops small">
                        <thead>
                            <tr>
                                <th scope="col">Model</th>
                                <th scope="col">Stops after</th>
                                <th scope="col">Keep warm</th>
                                <th scope="col">No cache</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${BREAK_EVEN_TABLE.map(
                                ([
                                    name,
                                    cache,
                                    stops,
                                    refreshes,
                                    warm,
                                    uncached,
                                ]) => html`<tr key=${name}>
                                    <th scope="row">
                                        ${name}<span class="muted">${cache} cache</span>
                                    </th>
                                    <td>${stops}<span class="muted">${refreshes} refreshes</span></td>
                                    <td>${warm}</td>
                                    <td>${uncached}</td>
                                </tr>`,
                            )}
                        </tbody>
                    </table>
                    <p class="muted small">
                        Keep warm: what all its refreshes cost until it stops. No cache: one message after the cache
                        expired. List prices, a 150k context. These are estimates only: they can be wrong, and prices and cache
                        times can change at any time. As a rule, keeping a session warm for 30 minutes to 3 hours saves
                        money when you step away.
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
                                step="any"
                                label="Most a session may spend on keeping warm, in dollars"
                                onSave=${(value) => value !== null && save({ maxCost: value })}
                            />
                        </span>
                        <span class="muted small">per session, subagents included; 0: no cap</span>
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
                <button
                    class="keep-warm-disclosure"
                    aria-expanded=${advanced}
                    onClick=${() => setAdvanced(!advanced)}
                >
                    <span>Advanced</span>
                    <span class="muted small">
                        refreshes, timing, and ${models.length} ${models.length === 1 ? "model" : "models"}${
                            unknown > 0 ? ` (${unknown} not kept warm)` : ""
                        }
                    </span>
                    <${Icon} name="chevron" size=${14} />
                </button>
                ${
                    advanced &&
                    html`<div class="keep-warm-advanced">
                        <section class="keep-warm-grid">
                            <label class="keep-warm-field">
                                <span>Most refreshes</span>
                                <span class="keep-warm-input">
                                    <${NumberField}
                                        value=${settings.maxRefreshes}
                                        min=${1}
                                        max=${10000}
                                        label="Most refreshes for a conversation"
                                        onSave=${(value) => value !== null && save({ maxRefreshes: value })}
                                    />
                                </span>
                                <span class="muted small">per conversation</span>
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
                        </section>
                        <section class="keep-warm-models">
                            <div class="keep-warm-models-head">
                                <div class="label">Models</div>
                                <span class="muted small">${warmable.length} of ${models.length} kept warm</span>
                            </div>
                            <p class="muted small">
                                Each model's cache cost, and how long its cache lasts once idle. Grey: the maker's
                                published values; type your own to replace one, or clear it to go back.
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
                                ${[...groups].map(([provider, list]) => {
                                    const cold = list.filter(
                                        (model) => model.plan.everyMs === undefined,
                                    ).length;

                                    return html`<details class="keep-warm-provider" key=${provider} open=${needle !== ""}>
                                        <summary>
                                            <span>${provider}</span>
                                            <span class="muted small">
                                                ${list.length} ${list.length === 1 ? "model" : "models"}${
                                                    cold > 0 ? ` · ${cold} not kept warm` : ""
                                                }
                                            </span>
                                        </summary>
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
                                    </details>`;
                                })}
                            </div>
                        </section>
                    </div>`
                }
            </div>
        </div>
    <//>`;
}

/**
 * A session's own time, in its menu and a reply's menu: the owner's default, Break-even, a fixed time, or off. Shows when the
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
    // A server from before 0.28 (not released) still calls Break-even "auto".
    const fallback = server.keepWarm.hours === "auto" ? "break-even" : server.keepWarm.hours;
    const chosen =
        state.choice === "default"
            ? fallback
            : state.choice === "auto"
              ? "break-even"
              : state.choice;
    // The same times as the owner's, the session's own (or the owner's default) selected. Picking the owner's default
    // follows it again ("default"), so a later change of the default reaches this session too.
    const choices = TIMES.slice(1);
    const valueOf = (value) => (value === fallback ? "default" : value);
    // Only the owner turns a session on or picks another time; anyone who can steer may turn it off, or back to the
    // default where that keeps it off (the server checks it too).
    const owner = store.state.me?.role === "owner";
    const allowed = (value) =>
        owner || value === 0 || (value === fallback && (state.choice !== 0 || fallback === 0));
    const hoursLabel = (hours) =>
        hours === 0.5 ? "30 minutes" : hours === 1 ? "1 hour" : `${hours} hours`;
    const line = status.warm
        ? [
              `Keeping cache alive · next ${time(status.nextAt)}`,
              `${status.refreshes} of ${status.maxRefreshes} refreshes`,
              money(status.spent),
              status.until === undefined ? "" : `until ${time(status.until)}`,
          ]
              .filter(Boolean)
              .join(" · ")
        : status.stopped
          ? `Stopped: ${status.stopped}`
          : chosen === 0
            ? "Not keeping cache warm"
            : chosen === "break-even"
              ? "Until it costs as much as one uncached message, keep cache alive"
              : `${hoursLabel(chosen)} after Pi finishes, keep cache alive`;

    return html`<div class="keep-warm-session">
        <div class="segmented keep-warm-times" role="group" aria-label="Keep this session warm">
            <span class="keep-warm-session-title">
                ${
                    chosen !== 0 &&
                    html`<${Icon}
                        name="flame"
                        size=${13}
                        stroke=${2}
                        class=${`warm ${status.warm ? "warming" : ""}`}
                    />`
                }
                Keep this session warm
            </span>
            ${[[0, "Off"], ...choices].map(
                ([value, label]) => html`<button
                    class=${`${chosen === value ? "on" : ""} ${value === 0 ? "keep-warm-off" : ""}`}
                    aria-pressed=${chosen === value}
                    title=${
                        value === fallback
                            ? "The owner's default"
                            : value === "break-even"
                              ? BREAK_EVEN
                              : ""
                    }
                    disabled=${!steer || !allowed(value)}
                    onClick=${() => state.choice !== valueOf(value) && choose(valueOf(value))}
                >
                    ${label}
                </button>`,
            )}
        </div>
        <div class="muted small">${line}</div>
    </div>`;
}
