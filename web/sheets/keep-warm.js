// Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, a calculator of what it
// costs, and the row a session chooses its own time with.
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

/** A keep-warm time in words: "Auto", "2 h", or "off". */
function timeLabel(hours) {
    return hours === 0 ? "off" : hours === "auto" ? "Auto" : `${hours} h`;
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

/** Refreshes that cost as much as one cache write; 0: the prices are not known. `breakEvenRefreshes` on the server. */
const breakEvenOf = (read, write) =>
    read > 0 && write > 0 ? Math.max(1, Math.floor(write / read)) : 0;

/**
 * One model as keep warm sees it, the owner's values over Pi's: minutes between refreshes (undefined: not kept warm),
 * cache lifetime and prices, and the refreshes after which Auto stops (0: Auto cannot tell, so it does not warm).
 * Mirrors `#plan` and `breakEvenRefreshes` in `src/server/cache-keeper.ts`.
 */
function modelPlan(model, settings) {
    const own = settings.models[model.spec] ?? {};
    const lifetime = own.lifetime ?? model.pi.lifetime;
    // Prices are the owner's only: Pocket reads none from Pi or a provider.
    const { read, write } = own;
    const shared =
        lifetime === undefined
            ? undefined
            : Math.floor(
                  Math.min(lifetime * settings.share * 600, lifetime * 60_000 - 10_000) / 60_000,
              ) || undefined;
    const every = own.minutes === undefined ? shared : own.minutes > 0 ? own.minutes : undefined;
    const breakEven = breakEvenOf(read, write);
    // Where Auto stops, in minutes: at break-even or at the owner's refresh cap, whichever comes first.
    const autoStop =
        every === undefined || breakEven === 0
            ? undefined
            : Math.min(breakEven, settings.maxRefreshes) * every;

    return { lifetime, read, write, shared, every, breakEven, autoStop, own };
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

/**
 * Examples of where Auto stops, written here as text from the makers' docs (2026-11-02): the price per million tokens to
 * read the cache and to write it (what a miss costs), the default cache tier's lifetime in minutes, and a refresh at 75%
 * of it. Claude: the 1-hour tier, read 0.05×, write 2× input. GPT-6.1: the 30-minute tier, read 0.05×, write 1.25×.
 * Grok: read 0.25×, no write charge, and no published lifetime (assumed an hour). Pocket reads no prices from anywhere.
 */
const EXAMPLES = [
    { name: "Claude Opus 5.5", read: 0.2, write: 8, lifetime: 60, every: 45 },
    { name: "GPT-6.1 Sol", read: 0.1, write: 2.5, lifetime: 30, every: 22 },
    { name: "GPT-6.1 Terra", read: 0.05, write: 1.25, lifetime: 30, every: 22 },
    { name: "Grok 4.7", read: 0.5, write: 2, every: 45 },
];

/** Minutes between refreshes in the calculator until a model says otherwise: 75% of a 1-hour cache. */
const ESTIMATED_EVERY = 45;

/** The context size the examples' cost is for, in tokens. */
const EXAMPLE_CONTEXT = 150_000;

/** Context sizes a tap fills in, in tokens. */
const CONTEXTS = [
    [50_000, "50k"],
    [150_000, "150k"],
    [500_000, "500k"],
    [1_000_000, "1M"],
];

/** The absences the table compares, in hours. */
const AWAY = [1, 8, 24, 72, 144];

/** A plain number input of the calculator: no saving, the number goes straight to `onChange`. */
function CalcNumber({ value, onChange, min = 0, step = 1, unit, prefix, wide = false }) {
    return html`<span class="keep-warm-input">
        ${prefix}<input
            type="number"
            inputmode="decimal"
            class="keep-warm-number"
            style=${wide ? "width:7rem" : ""}
            min=${min}
            step=${step}
            value=${value}
            onInput=${(event) => onChange(Math.max(min, Number(event.currentTarget.value) || min))}
        />${unit && html`<span class="muted small">${unit}</span>`}
    </span>`;
}

const tokensLabel = (tokens) =>
    tokens >= 1e9
        ? `${(tokens / 1e9).toFixed(1)}B`
        : tokens >= 1e6
          ? `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`
          : `${Math.round(tokens / 1000)}k`;

/**
 * What keeping one session warm costs against letting its cache expire, for a context size and an absence. Letting it
 * expire costs one cache write when you come back, however long you were away; keeping warm costs a read each refresh.
 */
function Calculator({ models, settings }) {
    // The examples' list prices, then the models the owner priced.
    const usable = [
        ...EXAMPLES.map((example) => ({
            key: `example:${example.name}`,
            label: `${example.name} · list price`,
            plan: { read: example.read, write: example.write, every: example.every },
        })),
        ...models
            .map((model) => ({ model, plan: modelPlan(model, settings) }))
            .filter(({ plan }) => plan.read > 0 && plan.write > 0)
            .map(({ model, plan }) => ({
                key: model.spec,
                label: `${model.name} · your prices`,
                plan,
            })),
    ];
    const [spec, setSpec] = useState(() => usable[0].key);
    const chosen = usable.find((each) => each.key === spec)?.plan;
    const [read, setRead] = useState(null);
    const [write, setWrite] = useState(null);
    const [every, setEvery] = useState(null);
    const [context, setContext] = useState(150_000);
    const [away, setAway] = useState(6);
    const [unit, setUnit] = useState(24);

    const r = read ?? chosen?.read ?? 0.5;
    const w = write ?? chosen?.write ?? 10;
    const e = every ?? chosen?.every ?? chosen?.shared ?? 45;
    const millions = context / 1e6;
    const refresh = millions * r;
    const rewrite = millions * w;
    const breakEven = breakEvenOf(r, w);
    // What the owner's settings let it do: Auto's break-even or the hours, and the caps.
    const stopsAfter = (() => {
        const byCap = Math.min(
            settings.maxRefreshes,
            settings.maxCost > 0 && refresh > 0 ? Math.floor(settings.maxCost / refresh) : Infinity,
        );
        const byTime =
            settings.hours === "auto"
                ? breakEven
                : settings.hours === 0
                  ? 0
                  : Math.floor((settings.hours * 60) / e);

        return Math.min(byCap, byTime);
    })();

    const row = (hours, own = false) => {
        const refreshes = Math.floor((hours * 60) / e);
        const warm = refreshes * refresh;
        const settled = refreshes <= stopsAfter ? warm : stopsAfter * refresh + rewrite;
        const diff = rewrite - warm;

        return html`<tr class=${own ? "own" : ""} key=${own ? "own" : hours}>
            <th scope="row">${durationLabel(hours * 3_600_000)}</th>
            <td>
                ${money(warm)}
                <span class=${`small ${diff >= 0 ? "ok" : "warn"}`}>
                    ${diff >= 0 ? `saves ${money(diff)}` : `${money(-diff)} more`}
                </span>
                <span class="muted small">${tokensLabel(refreshes * context)} read</span>
            </td>
            <td>${money(rewrite)}</td>
            <td>${money(settled)}</td>
        </tr>`;
    };

    const awayHours = away * unit;

    return html`<div class="keep-warm-calc">
        <p class="muted small">
            Letting the cache expire costs one cache write when you come back, however long you were away. Keeping it
            warm costs one cache read each refresh, so it grows the longer you are away.
        </p>
        <div class="keep-warm-calc-grid">
            <label class="keep-warm-field wide">
                <span>Model</span>
                <select
                    value=${spec}
                    onChange=${(event) => {
                        setSpec(event.currentTarget.value);
                        setRead(null);
                        setWrite(null);
                        setEvery(null);
                    }}
                >
                    ${usable.map(({ key, label }) => html`<option value=${key}>${label}</option>`)}
                </select>
            </label>
            <label class="keep-warm-field">
                <span>Cache read</span>
                <${CalcNumber} value=${r} onChange=${setRead} step=${0.01} prefix="$" unit="/M" />
            </label>
            <label class="keep-warm-field">
                <span>Cache write</span>
                <${CalcNumber} value=${w} onChange=${setWrite} step=${0.01} prefix="$" unit="/M" />
            </label>
            <label class="keep-warm-field">
                <span>Refresh every</span>
                <${CalcNumber} value=${e} onChange=${setEvery} min=${1} unit="min" />
            </label>
            <label class="keep-warm-field">
                <span>Away for</span>
                <span class="keep-warm-input">
                    <${CalcNumber} value=${away} onChange=${setAway} />
                    <select class="keep-warm-unit" value=${unit} onChange=${(event) => setUnit(Number(event.currentTarget.value))}>
                        <option value="1">hours</option>
                        <option value="24">days</option>
                    </select>
                </span>
            </label>
            <div class="keep-warm-field wide">
                <span>Context</span>
                <${CalcNumber} value=${context} onChange=${setContext} step=${1000} unit="tokens" wide />
                <div class="segmented" role="group" aria-label="Context size">
                    ${CONTEXTS.map(([tokens, label]) => html`<button class=${context === tokens ? "on" : ""} aria-pressed=${context === tokens} onClick=${() => setContext(tokens)}>${label}</button>`)}
                </div>
            </div>
        </div>
        <p class="small">
            One refresh: <b>${money(refresh)}</b> · one cache write: <b>${money(rewrite)}</b> · keeping warm pays off
            when you come back within <b>${breakEven > 0 ? durationLabel(breakEven * e * 60_000) : "—"}</b>
            ${breakEven > 0 ? ` (${breakEven} refreshes)` : ""}.
        </p>
        <div class="keep-warm-table-wrap">
            <table class="keep-warm-table">
                <thead>
                    <tr>
                        <th scope="col">Away</th>
                        <th scope="col">Kept warm all along</th>
                        <th scope="col">Let it expire</th>
                        <th scope="col">Your settings</th>
                    </tr>
                </thead>
                <tbody>
                    ${AWAY.filter((hours) => Math.abs(hours - awayHours) > 0.01).map((hours) => row(hours))}
                    ${awayHours > 0 && row(awayHours, true)}
                </tbody>
            </table>
        </div>
        <p class="muted small">
            ${
                stopsAfter === 0
                    ? "With your settings it is not kept warm, so you pay the cache write when you come back."
                    : `With your settings it stops after ${stopsAfter} ${stopsAfter === 1 ? "refresh" : "refreshes"} (${durationLabel(stopsAfter * e * 60_000)}, ${money(stopsAfter * refresh)}); away longer, you pay those and the cache write.`
            }${" "}Tokens read are what counts against a subscription's limits, where the prices are $0.
        </p>
    </div>`;
}

/** The values the owner may set for a model: what it is called, its unit, the most it takes, and Pi's value. */
const MODEL_FIELDS = [
    {
        key: "lifetime",
        label: "Cache",
        unit: "min",
        min: 1,
        max: 10_080,
        pi: (model) => model.pi.lifetime,
    },
    {
        key: "read",
        label: "Read",
        prefix: "$",
        max: 10_000,
        step: 0.01,
        pi: () => undefined,
    },
    {
        key: "write",
        label: "Write",
        prefix: "$",
        max: 10_000,
        step: 0.01,
        pi: () => undefined,
    },
    { key: "minutes", label: "Every", unit: "min", max: 1440, pi: (_model, plan) => plan.shared },
];

/** One model in the settings window: what keep warm does with it, and its four values, Pi's in grey. */
function ModelCard({ model, plan, onSet }) {
    const { own, every, breakEven, autoStop } = plan;
    const note =
        own.minutes === 0
            ? "never kept warm"
            : every === undefined
              ? html`<span class="warn">cache lifetime not known: set Cache or Every</span>`
              : breakEven === 0
                ? html`<span class="warn">prices not known: Auto skips it</span>`
                : `every ${durationLabel(every * 60_000)} · Auto stops after ${durationLabel(autoStop * 60_000)}`;

    return html`<div class=${`keep-warm-model ${own.minutes === 0 ? "never" : ""}`}>
        <div class="keep-warm-model-name">
            <span title=${model.spec}>${model.name}</span>
            <span class="muted small">${note}</span>
        </div>
        <div class="keep-warm-cells">
            ${MODEL_FIELDS.map((field) => {
                const pi = field.pi(model, plan);

                return html`<label class="keep-warm-cell" key=${field.key}>
                    <span class="muted small">${field.label}</span>
                    <span class="keep-warm-input">
                        ${field.prefix}<${NumberField}
                            value=${own[field.key]}
                            min=${field.min ?? 0}
                            max=${field.max}
                            step=${field.step ?? 1}
                            width="100%"
                            label=${`${field.label} for ${model.name}`}
                            placeholder=${pi === undefined ? "—" : String(pi)}
                            onSave=${(value) => onSet(field.key, value)}
                        />${field.unit && html`<span class="muted small">${field.unit}</span>`}
                    </span>
                </label>`;
            })}
        </div>
    </div>`;
}

export function KeepWarmSheet() {
    const [data, setData] = useState(null);
    const [query, setQuery] = useState("");
    const [calc, setCalc] = useState(false);
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
    const plans = new Map(models.map((model) => [model.spec, modelPlan(model, settings)]));
    const custom = Object.keys(settings.models).length;
    const warmable = models.filter((model) => plans.get(model.spec).every !== undefined);
    // Where Auto stops for the examples, at their list prices and a refresh every 45 minutes, within the refresh cap.
    const autoStops = EXAMPLES.map(({ name, read, write, lifetime, every }) => {
        const refreshes = Math.min(breakEvenOf(read, write), settings.maxRefreshes);

        return {
            name,
            read,
            cache: lifetime === undefined ? "?" : durationLabel(lifetime * 60_000),
            time: durationLabel(refreshes * every * 60_000),
            refreshes,
            cost: money((refreshes * read * EXAMPLE_CONTEXT) / 1e6),
        };
    });
    const setModel = (spec, field, value) => save({ models: { [spec]: { [field]: value } } });

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
                    ${segmented("How long to keep sessions warm", TIMES, settings.hours, "hours")}
                    <p class="muted small">
                        ${
                            settings.hours === 0
                                ? "Off: caches expire as before. A session can still be kept warm from its menu."
                                : settings.hours === "auto"
                                  ? AUTO
                                  : `Stops ${settings.hours} h after the run ended, or at a cap below.`
                        }
                    </p>
                    ${
                        settings.hours === "auto" &&
                        html`<p class="muted small">
                            Where it stops, about: list prices, a refresh at 75% of the cache time, and a
                            ${tokensLabel(EXAMPLE_CONTEXT)} context.
                        </p>
                        <table class="keep-warm-stops small">
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
                                ${autoStops.map(
                                    ({
                                        name,
                                        cache,
                                        read,
                                        time,
                                        refreshes,
                                        cost,
                                    }) => html`<tr key=${name}>
                                        <th scope="row">${name}</th>
                                        <td>${cache}</td>
                                        <td>${money(read)}/M</td>
                                        <td>${time} (${refreshes})</td>
                                        <td>${cost}</td>
                                    </tr>`,
                                )}
                            </tbody>
                        </table>
                        <p class="muted small">
                            Grok publishes no cache time (?): its row assumes an hour. The cheaper a cache read is next
                            to a cache write, the longer Auto lasts. Auto keeps a model
                            warm only once you set its Read and Write prices below; Pocket reads no prices itself.
                        </p>`
                    }
                    <p class="muted small">
                        A new message, another model, a compaction, New context, or archiving stops it. Each session can
                        choose its own time in its menu.
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
                <section class="keep-warm-group">
                    <button
                        type="button"
                        class="keep-warm-disclosure"
                        aria-expanded=${calc}
                        onClick=${() => setCalc(!calc)}
                    >
                        <${Icon} name="chevron" size=${16} />
                        Calculate the cost
                    </button>
                    ${calc && html`<${Calculator} models=${models} settings=${settings} />`}
                </section>
            </div>
            <section class="keep-warm-models">
                <div class="keep-warm-models-head">
                    <div class="label">Models</div>
                    <span class="muted small">${warmable.length} of ${models.length} kept warm${custom > 0 ? ` · ${custom} set by you` : ""}</span>
                </div>
                <p class="muted small">
                    Grey numbers are what Pi knows; type one to replace it, or clear it to go back. Cache: how long the
                    model's prompt cache lives. Read and write: its cache prices in dollars per million tokens, yours
                    only (Auto needs both). Every: minutes between refreshes, by default a
                    share of the cache; 0 never keeps it warm. Two refreshes in a row that find the cache gone stop it.
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
                                        plan=${plans.get(model.spec)}
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
    const chosen = state.choice === "default" ? server.keepWarm.hours : state.choice;
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
            ${[["default", "Default"], ...TIMES.slice(1), [0, "Off"]].map(
                ([value, label]) => html`<button
                    class=${state.choice === value ? "on" : ""}
                    aria-pressed=${state.choice === value}
                    title=${value === "default" ? `The owner's: ${timeLabel(server.keepWarm.hours)}` : value === "auto" ? AUTO : ""}
                    disabled=${!steer}
                    onClick=${() => state.choice !== value && choose(value)}
                >
                    ${label}
                </button>`,
            )}
        </div>
        <div class="muted small">
            ${state.choice === "default" ? `Default: ${timeLabel(server.keepWarm.hours)} · ` : ""}${line}
        </div>
    </div>`;
}
