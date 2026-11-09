/**
 * OpenAI-compatible endpoints the owner adds from the Providers sheet. Each is a provider in Pi's `models.json`
 * (`~/.pi/agent/models.json`, made with its folder when missing), with `api: "openai-completions"`, a base URL, and
 * the models the owner chose. Its API key goes into Pi's sign-ins (`auth.json`), as an API-key sign-in does, never into
 * `models.json`; an endpoint without a key gets the placeholder `none`, as Pi's docs do for Ollama.
 *
 * Pi Pocket rewrites `models.json` only when it is plain JSON that Pi accepts: a file with comments or trailing commas
 * (which Pi reads) or one that Pi refuses is left alone, with a message, so a hand-made file never loses anything.
 * Fields it does not manage (headers, compat, a model's other metadata) are kept as they are. Of a model's metadata, the
 * form sets only image input (`input`), thinking (`reasoning` and `thinkingLevelMap`), its context window and maximum
 * output (`contextWindow`, `maxTokens`), and its price (`cost`, with its `tiers`). A hand-made `modelOverrides` entry
 * would win over these in Pi: the form shows what Pi uses, and a field it sets leaves the override.
 */
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PocketApp } from "./app.ts";
import { describe, HttpError } from "./errors.ts";
import { MODELS_JSON_REFUSED } from "./model-refresh.ts";

/** The API every endpoint here speaks. */
const API = "openai-completions";
/** What an endpoint without a key sends: Pi needs some key to count the provider as signed in. */
const NO_KEY = "none";
const MAX_MODELS = 500;
const MAX_ID = 200;
const MAX_NAME = 80;
const MAX_URL = 2000;
const MAX_KEY = 4000;
/** How long, and how much, an endpoint's model list may take. */
const DISCOVER_MS = 10_000;
const DISCOVER_BYTES = 5_000_000;
/** The most tokens a context window or output may have, and the most dollars per million tokens. */
const MAX_TOKENS = 1_000_000_000;
const MAX_PRICE = 1_000_000;
/** The most price tiers a model may have. */
const MAX_PRICE_TIERS = 16;

/** Pi's thinking levels, in order: a model's `thinkingLevelMap` names what each one sends. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** One level a model thinks at, and what it sends the endpoint for it; `off` may send nothing (`""`). */
export interface ThinkingTier {
    level: ThinkingLevel;
    value: string;
}

/** The levels a model gets when thinking is turned on: low to max, each sending its own name. */
export const DEFAULT_TIERS: ThinkingTier[] = (
    ["low", "medium", "high", "xhigh", "max"] as const
).map((level) => ({ level, value: level }));

const MAX_TIER_VALUE = 64;

/** What a model costs in dollars per million tokens, for each kind of token. */
export interface PriceRates {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Pi's price tier: the rates for a whole request whose input is more than `inputTokensAbove` tokens. */
export interface PriceTier extends PriceRates {
    inputTokensAbove: number;
}

/**
 * A model's price: Pi's `cost`. Its tiers are in order of their token counts, each count once. In a change, tiers left
 * out keep the ones the model has, and an empty list takes them out.
 */
export interface ModelPrice extends PriceRates {
    tiers?: PriceTier[];
}

export interface CustomModel {
    id: string;
    /** Its context window in tokens, or null for Pi's default. Left out of a change: as it was. */
    contextWindow?: number | null;
    /** The most tokens it writes in one answer, or null for Pi's default. Left out of a change: as it was. */
    maxTokens?: number | null;
    /** It sees images (`input` has `"image"`). Left out of a change: as it was. */
    images?: boolean;
    /** The levels it thinks at, or null when it does not think. Left out of a change: as it was. */
    thinking?: ThinkingTier[] | null;
    /** What it costs, or null when it costs nothing. Left out of a change: as it was. */
    cost?: ModelPrice | null;
}

/** A model as the form sees it: what the endpoint says it can do, read back from `models.json`. */
export interface CustomModelInfo {
    id: string;
    images: boolean;
    thinking: ThinkingTier[] | null;
    contextWindow: number | null;
    maxTokens: number | null;
    cost: ModelPrice | null;
}

/** What discovery found out about a model, when the endpoint says it. */
export interface ListedModel {
    id: string;
    contextWindow?: number;
    maxTokens?: number;
    images?: boolean;
    reasoning?: boolean;
    cost?: ModelPrice;
}

export interface CustomProvider {
    id: string;
    name: string;
    baseUrl: string;
    models: CustomModelInfo[];
    /** Where its key is: Pi's sign-ins, `models.json` (a hand-made entry), none (the placeholder), or nowhere. */
    key: "stored" | "file" | "none" | "missing";
}

export interface CustomProviderInput {
    name?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    noKey?: unknown;
    models?: unknown;
}

type Json = Record<string, unknown>;

/** Pi's `models.json`, as `ModelRuntime.create()` finds it. */
function modelsPath(): string {
    return join(getAgentDir(), "models.json");
}

function text(value: unknown, name: string, max: number): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new HttpError(400, `Enter ${name}.`);
    }

    if (value.length > max) {
        throw new HttpError(400, `${name} is too long.`);
    }

    return value.trim();
}

/** An http(s) URL without a trailing slash: Pi adds `/chat/completions` to it. */
function baseUrlOf(value: unknown): string {
    const raw = text(value, "a base URL", MAX_URL);
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        throw new HttpError(400, "The base URL must be a full address, such as https://host/v1.");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new HttpError(400, "The base URL must start with http:// or https://.");
    }

    if (url.username !== "" || url.password !== "") {
        throw new HttpError(400, "Put the key in the API key field, not in the URL.");
    }

    return raw.replace(/\/+$/, "");
}

/** The models asked for: ids, each once, with what the form says of each. */
function modelsOf(value: unknown): CustomModel[] {
    if (!Array.isArray(value)) {
        throw new HttpError(400, "models must be a list.");
    }

    if (value.length > MAX_MODELS) {
        throw new HttpError(400, `At most ${String(MAX_MODELS)} models.`);
    }

    const seen = new Map<string, CustomModel>();

    for (const each of value as unknown[]) {
        const entry = typeof each === "string" ? { id: each } : (each as Json | null);
        const id = typeof entry?.id === "string" ? entry.id.trim() : "";

        if (id === "" || id.length > MAX_ID) {
            throw new HttpError(
                400,
                `Each model needs an id of 1 to ${String(MAX_ID)} characters.`,
            );
        }

        const images = entry?.images;

        if (images !== undefined && typeof images !== "boolean") {
            throw new HttpError(400, `${id}: images must be true or false.`);
        }

        const window = tokensOf(id, entry?.contextWindow, "context window");
        const most = tokensOf(id, entry?.maxTokens, "maximum output");

        seen.set(id, {
            id,
            ...(window === undefined ? {} : { contextWindow: window }),
            ...(most === undefined ? {} : { maxTokens: most }),
            ...(images === undefined ? {} : { images }),
            ...(entry?.thinking === undefined ? {} : { thinking: tiersOf(id, entry.thinking) }),
            ...(entry?.cost === undefined ? {} : { cost: priceOf(id, entry.cost) }),
        });
    }

    return [...seen.values()];
}

/** A count of tokens as asked for: a whole number, null for Pi's default, or undefined to leave it as it is. */
function tokensOf(id: string, value: unknown, name: string): number | null | undefined {
    if (value === undefined || value === null) {
        return value;
    }

    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > MAX_TOKENS
    ) {
        throw new HttpError(
            400,
            `${id}: the ${name} must be a whole number of tokens, from 1 to ${MAX_TOKENS.toLocaleString("en-US")}.`,
        );
    }

    return value;
}

const RATES = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * A price as asked for, or null: dollars per million tokens, input and output given and the cache ones 0 when not. Its
 * tiers, when given, are each a token count (1 or more, whole, each once) and its rates; a rate a tier leaves out is the
 * price's own, as OpenRouter's are.
 */
export function priceOf(id: string, value: unknown): ModelPrice | null {
    if (value === null) {
        return null;
    }

    const given = (typeof value === "object" ? value : {}) as Json;

    if (given.input === undefined || given.output === undefined) {
        throw new HttpError(400, `${id}: a price needs its input and output dollars.`);
    }

    const rate = (each: unknown): number => {
        if (typeof each !== "number" || !Number.isFinite(each) || each < 0 || each > MAX_PRICE) {
            throw new HttpError(
                400,
                `${id}: a price is dollars per million tokens, from 0 to ${MAX_PRICE.toLocaleString("en-US")}.`,
            );
        }

        return each;
    };

    const base = Object.fromEntries(
        RATES.map((field) => [field, rate(given[field] ?? 0)]),
    ) as unknown as PriceRates;

    if (given.tiers === undefined) {
        return base;
    }

    if (!Array.isArray(given.tiers) || given.tiers.length > MAX_PRICE_TIERS) {
        throw new HttpError(
            400,
            `${id}: price tiers are a list of at most ${String(MAX_PRICE_TIERS)}.`,
        );
    }

    const tiers = (given.tiers as (Json | null)[]).map((tier, index): PriceTier => {
        const above = tier?.inputTokensAbove;
        const which = `${id}: price tier ${String(index + 1)}`;

        if (
            typeof above !== "number" ||
            !Number.isSafeInteger(above) ||
            above < 1 ||
            above > MAX_TOKENS
        ) {
            throw new HttpError(
                400,
                `${which} starts above a whole number of tokens, from 1 to ${MAX_TOKENS.toLocaleString("en-US")}.`,
            );
        }

        try {
            return {
                inputTokensAbove: above,
                ...(Object.fromEntries(
                    RATES.map((field) => [field, rate(tier?.[field] ?? base[field])]),
                ) as unknown as PriceRates),
            };
        } catch {
            throw new HttpError(
                400,
                `${which}: a price is dollars per million tokens, from 0 to ${MAX_PRICE.toLocaleString("en-US")}.`,
            );
        }
    });

    if (new Set(tiers.map((tier) => tier.inputTokensAbove)).size !== tiers.length) {
        throw new HttpError(400, `${id}: two price tiers start at the same number of tokens.`);
    }

    return { ...base, tiers: tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove) };
}

/**
 * A model entry's price as Pi reads it, with the tiers that are whole: null when it has none (Pi then counts it free).
 */
export function priceOfEntry(model: Json): ModelPrice | null {
    const cost = model.cost as Json | null | undefined;

    if (typeof cost?.input !== "number" || typeof cost.output !== "number") {
        return null;
    }

    const rates = (from: Json): PriceRates => ({
        input: typeof from.input === "number" ? from.input : 0,
        output: typeof from.output === "number" ? from.output : 0,
        cacheRead: typeof from.cacheRead === "number" ? from.cacheRead : 0,
        cacheWrite: typeof from.cacheWrite === "number" ? from.cacheWrite : 0,
    });
    const tiers = (Array.isArray(cost.tiers) ? (cost.tiers as (Json | null)[]) : [])
        .filter(
            (tier): tier is Json =>
                typeof tier?.inputTokensAbove === "number" &&
                RATES.every((field) => typeof tier[field] === "number"),
        )
        .map((tier) => ({ inputTokensAbove: tier.inputTokensAbove as number, ...rates(tier) }));

    return { ...rates(cost), ...(tiers.length === 0 ? {} : { tiers }) };
}

/**
 * A model's entry as Pi uses it: with the fields that the form shows taken from the provider's `modelOverrides` entry
 * for it, as Pi takes them (`applyModelOverride`). A price in an override is over the model's price, or over a price
 * of 0 when it has none.
 */
export function withOverride(model: Json, override: unknown): Json {
    if (typeof override !== "object" || override === null || Array.isArray(override)) {
        return model;
    }

    const over = override as Json;
    const map = (value: unknown) =>
        (typeof value === "object" && value !== null ? value : {}) as Json;
    const cost = map(model.cost);
    const costOver = over.cost === undefined ? undefined : map(over.cost);

    return {
        ...model,
        ...(over.input === undefined ? {} : { input: over.input }),
        ...(over.reasoning === undefined ? {} : { reasoning: over.reasoning }),
        ...(over.thinkingLevelMap === undefined
            ? {}
            : {
                  thinkingLevelMap: {
                      ...map(model.thinkingLevelMap),
                      ...map(over.thinkingLevelMap),
                  },
              }),
        ...(over.contextWindow === undefined ? {} : { contextWindow: over.contextWindow }),
        ...(over.maxTokens === undefined ? {} : { maxTokens: over.maxTokens }),
        ...(costOver === undefined
            ? {}
            : {
                  cost: {
                      ...Object.fromEntries(
                          RATES.map((field) => [field, costOver[field] ?? cost[field] ?? 0]),
                      ),
                      ...((costOver.tiers ?? cost.tiers) === undefined
                          ? {}
                          : { tiers: costOver.tiers ?? cost.tiers }),
                  },
              }),
    };
}

/**
 * Takes out of a model's `modelOverrides` entry each field that the form has just set, so that what the form saved is
 * what Pi uses; other fields stay. An entry left empty goes. Gives the entry, or undefined when none is left.
 */
function clearOverride(override: Json, model: CustomModel): Json | undefined {
    const over = { ...override };

    for (const field of ["contextWindow", "maxTokens"] as const) {
        if (model[field] !== undefined) {
            delete over[field];
        }
    }

    if (model.images !== undefined) {
        delete over.input;
    }

    if (model.thinking !== undefined) {
        delete over.reasoning;
        delete over.thinkingLevelMap;
    }

    if (model.cost !== undefined && typeof over.cost === "object" && over.cost !== null) {
        const cost = { ...(over.cost as Json) };

        for (const field of RATES) {
            delete cost[field];
        }

        // A price without tiers keeps the tiers there are, wherever they are.
        if (model.cost === null || model.cost.tiers !== undefined) {
            delete cost.tiers;
        }

        if (Object.keys(cost).length === 0) {
            delete over.cost;
        } else {
            over.cost = cost;
        }
    }

    return Object.keys(over).length === 0 ? undefined : over;
}

/** A model's thinking levels as asked for: null (it does not think), or each of Pi's levels at most once. */
export function tiersOf(id: string, value: unknown): ThinkingTier[] | null {
    if (value === null) {
        return null;
    }

    if (!Array.isArray(value) || value.length === 0) {
        throw new HttpError(400, `${id}: give its thinking levels, or turn thinking off.`);
    }

    const tiers = new Map<ThinkingLevel, string>();

    for (const each of value as (Json | null)[]) {
        const level = each?.level;
        const sent = typeof each?.value === "string" ? each.value.trim() : undefined;

        if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
            throw new HttpError(
                400,
                `${id}: a thinking level is one of ${THINKING_LEVELS.join(", ")}.`,
            );
        }

        if (tiers.has(level as ThinkingLevel)) {
            throw new HttpError(400, `${id}: the level ${String(level)} is there twice.`);
        }

        if (
            sent === undefined ||
            sent.length > MAX_TIER_VALUE ||
            (sent === "" && level !== "off")
        ) {
            throw new HttpError(
                400,
                `${id}: the level ${String(level)} needs a value of 1 to ${String(MAX_TIER_VALUE)} characters.`,
            );
        }

        tiers.set(level as ThinkingLevel, sent);
    }

    return THINKING_LEVELS.filter((level) => tiers.has(level)).map((level) => ({
        level,
        value: tiers.get(level)!,
    }));
}

/**
 * A model's thinking levels as Pi reads its entry: none without `reasoning`; else each level the map does not mark
 * null, sending what the map says. A level the map leaves out sends its own name, as Pi does, except xhigh and max,
 * which Pi then leaves out; and off, which sends nothing.
 */
export function tiersOfEntry(model: Json): ThinkingTier[] | null {
    if (model.reasoning !== true) {
        return null;
    }

    const map = (
        typeof model.thinkingLevelMap === "object" && model.thinkingLevelMap !== null
            ? model.thinkingLevelMap
            : {}
    ) as Record<string, unknown>;

    return THINKING_LEVELS.flatMap((level): ThinkingTier[] => {
        const sent = map[level];

        if (sent === null || (sent === undefined && (level === "xhigh" || level === "max"))) {
            return [];
        }

        if (typeof sent === "string") {
            return [{ level, value: sent }];
        }

        return [{ level, value: level === "off" ? "" : level }];
    });
}

/**
 * Sets what the form changes in a model's entry: image input, thinking, context window, maximum output, and price.
 * Other fields stay as they are, and so do the price tiers of a price given without them.
 */
function applyForm(entry: Json, model: CustomModel): Json {
    for (const field of ["contextWindow", "maxTokens"] as const) {
        if (model[field] === null) {
            delete entry[field];
        } else if (model[field] !== undefined) {
            entry[field] = model[field];
        }
    }

    if (model.cost === null) {
        delete entry.cost;
    } else if (model.cost !== undefined) {
        const { tiers: given, ...rates } = model.cost;
        const tiers = given ?? (entry.cost as Json | null | undefined)?.tiers;

        entry.cost = { ...rates, ...(Array.isArray(tiers) && tiers.length > 0 ? { tiers } : {}) };
    }

    if (model.images === true) {
        entry.input = ["text", "image"];
    } else if (model.images === false) {
        delete entry.input;
    }

    if (model.thinking === null) {
        delete entry.reasoning;
        delete entry.thinkingLevelMap;
    } else if (model.thinking !== undefined) {
        const sent = new Map(model.thinking.map((tier) => [tier.level, tier.value]));

        entry.reasoning = true;
        // Every level named: null where it is not one of the model's. Off without a value sends nothing.
        entry.thinkingLevelMap = Object.fromEntries(
            THINKING_LEVELS.flatMap((level) => {
                const value = sent.get(level);

                return value === "" ? [] : [[level, value ?? null]];
            }),
        );
    }

    return entry;
}

/** The text of models.json as it is now; undefined when there is none. */
function rawModels(): string | undefined {
    try {
        return readFileSync(modelsPath(), "utf8");
    } catch {
        return undefined;
    }
}

/** A provider id from its name: lowercase words joined by `-`, not one Pi already has. */
export function idFor(name: string, taken: (id: string) => boolean): string {
    const base =
        name
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "endpoint";
    let id = base;

    for (let n = 2; taken(id); n++) {
        id = `${base}-${String(n)}`;
    }

    return id;
}

/**
 * The ids of an endpoint's models, from an OpenAI `/models` answer, and what the list says of each, where it says it:
 * - its context window: the smallest of vLLM's `max_model_len`, `context_length` (OpenRouter, Chutes), Groq's
 *   `context_window`, OpenRouter's `top_provider.context_length`, and DeepInfra's `metadata.context_length`;
 * - its maximum output: the smallest of OpenRouter's `top_provider.max_completion_tokens`, Groq's
 *   `max_completion_tokens`, nano-gpt's `max_output_tokens`, and Chutes' `max_output_length`;
 * - its price (`listedPrice`);
 * - what it can do: OpenRouter's `architecture.input_modalities` and `supported_parameters`, or `capabilities`
 *   (`vision`, `thinking`, `reasoning`), as a list or as each true or false.
 */
export function parseModelList(body: unknown): ListedModel[] {
    const list = (body as Json | null)?.data;

    if (!Array.isArray(list)) {
        throw new Error("The answer has no list of models.");
    }

    const models = new Map<string, ListedModel>();

    for (const entry of list as (Json | null)[]) {
        const id = entry?.id;

        if (typeof id === "string" && id !== "" && id.length <= MAX_ID) {
            const top = (entry?.top_provider ?? null) as Json | null;
            const metadata = (entry?.metadata ?? null) as Json | null;
            // The smallest: one too small only compacts early, and one too large breaks requests.
            const window = smallestCount(
                entry?.max_model_len,
                entry?.context_length,
                entry?.context_window,
                top?.context_length,
                metadata?.context_length,
            );
            const most = smallestCount(
                top?.max_completion_tokens,
                entry?.max_completion_tokens,
                entry?.max_output_tokens,
                entry?.max_output_length,
            );
            const cost = listedPrice(entry ?? {});
            const said = (value: unknown): string[] =>
                Array.isArray(value)
                    ? value.filter((each): each is string => typeof each === "string")
                    : [];
            const modalities = said((entry?.architecture as Json | null)?.input_modalities);
            const parameters = said(entry?.supported_parameters);
            // A list of what it can do, or each of them true or false (nano-gpt).
            const can = entry?.capabilities;
            const capabilities =
                typeof can === "object" && can !== null && !Array.isArray(can)
                    ? Object.entries(can).flatMap(([name, on]) => (on === true ? [name] : []))
                    : said(can);
            const images = modalities.includes("image") || capabilities.includes("vision");
            const reasoning =
                parameters.includes("reasoning") ||
                parameters.includes("reasoning_effort") ||
                capabilities.includes("thinking") ||
                capabilities.includes("reasoning");

            models.set(id, {
                id,
                ...(window === undefined ? {} : { contextWindow: window }),
                ...(most === undefined ? {} : { maxTokens: most }),
                ...(images ? { images } : {}),
                ...(reasoning ? { reasoning } : {}),
                ...(cost === undefined ? {} : { cost }),
            });
        }
    }

    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}

/** The smallest of a model list's token counts that are one: whole, from 1 to the most there may be. */
function smallestCount(...values: unknown[]): number | undefined {
    const counts = values.filter(
        (value): value is number =>
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 1 &&
            value <= MAX_TOKENS,
    );

    return counts.length === 0 ? undefined : Math.min(...counts);
}

/** Dollars per million tokens as Pi keeps them (3, not 2.9999999999999996); none below 0 or past the most. */
function dollars(value: number): number | undefined {
    const rounded = Number(value.toPrecision(12));

    return Number.isFinite(rounded) && rounded >= 0 && rounded <= MAX_PRICE ? rounded : undefined;
}

/** A price with its tiers: in order of their token counts, each count once, at most as many as a price may have. */
function withTiers(base: PriceRates, tiers: PriceTier[]): ModelPrice {
    const unique = [...new Map(tiers.map((tier) => [tier.inputTokensAbove, tier])).values()]
        .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
        .slice(0, MAX_PRICE_TIERS);

    return unique.length === 0 ? base : { ...base, tiers: unique };
}

/** A token count a price tier starts above: whole, from 1 to the most there may be. */
const isThreshold = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TOKENS;

/**
 * What a model list says a model costs, as Pi's price in dollars per million tokens, from a list that says its unit:
 * - OpenRouter's `pricing`: dollars per token, as text; its `overrides` for long prompts become Pi's tiers, as Pi's own
 *   OpenRouter provider makes them (`openRouterCost`): a time-of-day one is left out, and a rate one leaves out is the
 *   base one.
 * - `pricing` as numbers with `unit: "per_million_tokens"` (nano-gpt): its cache rates are per thousand tokens, and so
 *   are its rates past `highContextThresholdTokens`, which become a tier.
 * - DeepInfra's `metadata.pricing`: `input_tokens`, `output_tokens`, and `cache_read_tokens`, per million.
 * None when the list does not say the input and output price, gives one below 0 (OpenRouter's router models say -1), or
 * gives numbers without their unit (Chutes): they could be per token or per million.
 */
function listedPrice(entry: Json): ModelPrice | undefined {
    const object = (value: unknown) =>
        (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Json;
    const pricing = object(entry.pricing);
    const number = (value: unknown, scale: number) =>
        typeof value === "number" ? dollars(value * scale) : undefined;
    const price = (input?: number, output?: number, cacheRead?: number, cacheWrite?: number) =>
        input === undefined || output === undefined
            ? undefined
            : { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };

    if (typeof pricing.prompt === "string" || typeof pricing.completion === "string") {
        const perToken = (value: unknown) =>
            typeof value === "string" && value.trim() !== ""
                ? dollars(Number(value) * 1_000_000)
                : undefined;
        const base = price(
            perToken(pricing.prompt),
            perToken(pricing.completion),
            perToken(pricing.input_cache_read),
            perToken(pricing.input_cache_write),
        );

        if (base === undefined) {
            return undefined;
        }

        const overrides = Array.isArray(pricing.overrides) ? pricing.overrides : [];
        const tiers = overrides.map(object).flatMap((override): PriceTier[] =>
            !isThreshold(override.min_prompt_tokens) ||
            override.utc_start !== undefined ||
            override.utc_end !== undefined ||
            override.utc_days !== undefined
                ? []
                : [
                      {
                          inputTokensAbove: override.min_prompt_tokens,
                          input: perToken(override.prompt) ?? base.input,
                          output: perToken(override.completion) ?? base.output,
                          cacheRead: perToken(override.input_cache_read) ?? base.cacheRead,
                          cacheWrite: perToken(override.input_cache_write) ?? base.cacheWrite,
                      },
                  ],
        );

        return withTiers(base, tiers);
    }

    if (pricing.unit === "per_million_tokens") {
        const base =
            pricing.currency === undefined || pricing.currency === "USD"
                ? price(
                      number(pricing.prompt, 1),
                      number(pricing.completion, 1),
                      number(pricing.cacheReadInputPer1kTokens, 1000),
                      number(pricing.cacheWriteInputPer1kTokens, 1000),
                  )
                : undefined;
        // Its rates for a long prompt: per thousand tokens, past `highContextThresholdTokens` (whatever the names say).
        const above = pricing.highContextThresholdTokens;

        return base === undefined || !isThreshold(above)
            ? base
            : withTiers(base, [
                  {
                      inputTokensAbove: above,
                      input: number(pricing.inputPer1kTokensAbove200k, 1000) ?? base.input,
                      output: number(pricing.outputPer1kTokensAbove200k, 1000) ?? base.output,
                      cacheRead:
                          number(pricing.cacheReadInputPer1kTokensAbove200k, 1000) ??
                          base.cacheRead,
                      cacheWrite: base.cacheWrite,
                  },
              ]);
    }

    const deepInfra = object(object(entry.metadata).pricing);

    return price(
        number(deepInfra.input_tokens, 1),
        number(deepInfra.output_tokens, 1),
        number(deepInfra.cache_read_tokens, 1),
    );
}

export class CustomProviders {
    readonly #app: PocketApp;
    /** Changes, one after another: each reads the file the one before wrote. */
    #queue: Promise<unknown> = Promise.resolve();
    /** The file's text when the change in progress read it. */
    #seen: string | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The endpoints in `models.json` that this sheet manages: OpenAI-compatible, with a base URL, not built in. */
    list(): CustomProvider[] {
        let config: Json | undefined;

        // A file Pi Pocket does not rewrite (comments, trailing commas) has no endpoints to edit here.
        try {
            config = this.#read();
        } catch {
            return [];
        }

        const providers = (config?.providers ?? {}) as Record<string, Json>;

        return Object.entries(providers)
            .filter(([id, entry]) => this.#manages(id, entry))
            .map(([id, entry]) => {
                const overrides = (entry.modelOverrides ?? {}) as Record<string, unknown>;

                return {
                    id,
                    name: typeof entry.name === "string" ? entry.name : id,
                    baseUrl: entry.baseUrl as string,
                    models: (Array.isArray(entry.models) ? (entry.models as (Json | null)[]) : [])
                        .filter((model): model is Json => typeof model?.id === "string")
                        // What Pi uses: a hand-made override wins over the model's own fields.
                        .map((model) => withOverride(model, overrides[model.id as string]))
                        .map((model) => ({
                            id: model.id as string,
                            images: Array.isArray(model.input) && model.input.includes("image"),
                            thinking: tiersOfEntry(model),
                            contextWindow:
                                typeof model.contextWindow === "number"
                                    ? model.contextWindow
                                    : null,
                            maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : null,
                            cost: priceOfEntry(model),
                        })),
                    key: this.#keyOf(id, entry),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Add an endpoint: its entry in `models.json` (and the file and folder when missing), then its key. */
    create(input: CustomProviderInput): Promise<CustomProvider> {
        return this.#serial(async () => {
            const name = text(input.name, "a name", MAX_NAME);
            const baseUrl = baseUrlOf(input.baseUrl);
            const models = modelsOf(input.models ?? []);
            const key = this.#keyInput(input, true);
            const config = await this.#editable();
            const providers = config.providers as Record<string, Json>;
            // An id that auth.json still has a key for (an endpoint removed by hand) is taken: that key
            // is not this one's.
            const keyed = new Set(
                (await this.#app.models.listCredentials()).map((each) => each.providerId),
            );
            const id = idFor(
                name,
                (each) =>
                    each in providers ||
                    keyed.has(each) ||
                    this.#app.models.getProvider(each) !== undefined ||
                    getBuiltinProviders().includes(each as never),
            );

            providers[id] = {
                name,
                baseUrl,
                api: API,
                ...(key === NO_KEY ? { apiKey: NO_KEY } : {}),
                models: models.map(entryOf),
            };
            await this.#write(config);
            await this.#applied(id);

            if (key !== undefined && key !== NO_KEY) {
                await this.#app.providers.storeApiKey(id, key);
            }

            return this.#one(id);
        });
    }

    /** Change an endpoint: its name, URL, models (each kept model keeps its metadata), and key, as given. */
    update(id: string, input: CustomProviderInput): Promise<CustomProvider> {
        return this.#serial(async () => {
            const config = await this.#editable();
            const providers = config.providers as Record<string, Json>;
            const entry = providers[id];

            if (entry === undefined || !this.#manages(id, entry)) {
                throw new HttpError(404, "No such endpoint.");
            }

            if (input.name !== undefined) {
                entry.name = text(input.name, "a name", MAX_NAME);
            }

            const key = this.#keyInput(input, false);
            let moved = false;

            if (input.baseUrl !== undefined) {
                const baseUrl = baseUrlOf(input.baseUrl);

                moved = new URL(String(entry.baseUrl)).origin !== new URL(baseUrl).origin;

                // The saved key goes only where it was saved for, as in `discover`: also one Pi stored.
                if (
                    key === undefined &&
                    moved &&
                    (entry.apiKey !== NO_KEY || (await this.#stored(id)))
                ) {
                    throw new HttpError(
                        400,
                        "The URL changed. Enter the API key again, or choose No key.",
                    );
                }

                entry.baseUrl = baseUrl;
            }

            if (input.models !== undefined) {
                const before = new Map(
                    (Array.isArray(entry.models) ? (entry.models as Json[]) : []).map((model) => [
                        model?.id,
                        model,
                    ]),
                );

                const asked = modelsOf(input.models);

                entry.models = asked.map((model) => {
                    const kept = before.get(model.id);

                    return kept === undefined ? entryOf(model) : applyForm({ ...kept }, model);
                });

                // A hand-made override of a field the form set would win over it: that field goes.
                const overrides = entry.modelOverrides;

                if (
                    typeof overrides === "object" &&
                    overrides !== null &&
                    !Array.isArray(overrides)
                ) {
                    const left = { ...(overrides as Json) };

                    for (const model of asked) {
                        const was = left[model.id];

                        if (typeof was === "object" && was !== null && !Array.isArray(was)) {
                            const over = clearOverride(was as Json, model);

                            if (over === undefined) {
                                delete left[model.id];
                            } else {
                                left[model.id] = over;
                            }
                        }
                    }

                    if (Object.keys(left).length === 0) {
                        delete entry.modelOverrides;
                    } else {
                        entry.modelOverrides = left;
                    }
                }
            }

            if (key === NO_KEY) {
                entry.apiKey = NO_KEY;
            } else if (key !== undefined && (entry.apiKey === NO_KEY || moved)) {
                // A real key replaces the placeholder, and on a move a key in the file too: it was for
                // the old address.
                delete entry.apiKey;
            }

            // The old key goes before the new address is in the file, so no request takes it there. A save that is
            // refused puts it back, unless a sign-in or sign-out came meanwhile.
            const taken =
                key === NO_KEY || (key !== undefined && moved)
                    ? await this.#takeKey(id)
                    : undefined;

            try {
                await this.#write(config);
            } catch (error) {
                if (taken !== undefined) {
                    await this.#app.providers.restoreApiKey(id, taken.key, taken.epoch);
                }

                throw error;
            }

            try {
                await this.#applied(id);
            } finally {
                if (key !== undefined && key !== NO_KEY) {
                    await this.#app.providers.storeApiKey(id, key);
                }
            }

            return this.#one(id);
        });
    }

    /** Take an endpoint out of `models.json`, and its key out of Pi's sign-ins. */
    remove(id: string): Promise<void> {
        return this.#serial(async () => {
            const config = await this.#editable();
            const providers = config.providers as Record<string, Json>;
            const entry = providers[id];

            if (entry === undefined || !this.#manages(id, entry)) {
                throw new HttpError(404, "No such endpoint.");
            }

            delete providers[id];
            await this.#write(config);
            await this.#forgetKey(id);
            await this.#applied(id);
        });
    }

    /**
     * Ask an endpoint for its models (`GET <baseUrl>/models`), with the key given, or else the saved endpoint's own.
     * The owner's to ask, so a local or private address is allowed: that is where such servers often are.
     */
    discover(input: { baseUrl?: unknown; apiKey?: unknown; id?: unknown }): Promise<ListedModel[]> {
        // After any save in progress: a saved key is read with the address it belongs to.
        return this.#serial(() => this.#discover(input));
    }

    async #discover(input: {
        baseUrl?: unknown;
        apiKey?: unknown;
        id?: unknown;
    }): Promise<ListedModel[]> {
        const baseUrl = baseUrlOf(input.baseUrl);
        const headers = new Headers({ accept: "application/json" });
        let key =
            typeof input.apiKey === "string" && input.apiKey.trim() !== ""
                ? input.apiKey.trim()
                : undefined;

        const saved =
            key === undefined && typeof input.id === "string"
                ? this.list().find((each) => each.id === input.id)
                : undefined;

        if (saved !== undefined && saved.key !== "none") {
            // The saved key goes only where it was saved for: a new address needs the key typed again.
            if (new URL(saved.baseUrl).origin !== new URL(baseUrl).origin) {
                throw new HttpError(400, "The URL changed. Enter the API key again to ask it.");
            }

            const auth = await this.#app.models.getAuth(saved.id).catch(() => undefined);

            key = auth?.auth.apiKey;

            for (const [name, value] of Object.entries(auth?.auth.headers ?? {})) {
                if (value !== null) {
                    headers.set(name, value);
                }
            }
        }

        if (key !== undefined && key !== NO_KEY) {
            // One Authorization header, also where Pi's own (`authHeader`) carries the same key.
            headers.set("authorization", `Bearer ${key}`);
        }

        let response: Response;

        try {
            response = await fetch(`${baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(DISCOVER_MS),
            });
        } catch (error) {
            // Not the error itself: some carry the request, and with it the key.
            throw new HttpError(
                502,
                (error as Error)?.name === "TimeoutError"
                    ? "The endpoint did not answer in 10 seconds."
                    : "Could not reach the endpoint. Check the URL.",
            );
        }

        if (!response.ok) {
            await response.body?.cancel().catch(() => {});

            throw new HttpError(
                502,
                response.status === 401 || response.status === 403
                    ? `The endpoint refused the key (${String(response.status)}).`
                    : `The endpoint answered ${String(response.status)} for ${baseUrl}/models. ` +
                          "Add model IDs by hand.",
            );
        }

        try {
            return parseModelList(JSON.parse(await limitedText(response, DISCOVER_BYTES)));
        } catch {
            throw new HttpError(
                502,
                "The endpoint's model list could not be read. Add model IDs by hand.",
            );
        }
    }

    #serial<T>(run: () => Promise<T>): Promise<T> {
        const next = this.#queue.then(run, run);

        this.#queue = next.catch(() => {});

        return next;
    }

    #manages(id: string, entry: Json | undefined): boolean {
        return (
            typeof entry === "object" &&
            entry !== null &&
            entry.api === API &&
            typeof entry.baseUrl === "string" &&
            !getBuiltinProviders().includes(id as never)
        );
    }

    #keyOf(id: string, entry: Json): CustomProvider["key"] {
        const status = this.#app.models.getProviderAuthStatus(id);

        if (status.source === "stored") {
            return "stored";
        }

        if (entry.apiKey === NO_KEY) {
            return "none";
        }

        return typeof entry.apiKey === "string" ? "file" : "missing";
    }

    /** The key asked for: a key, `NO_KEY` when the endpoint takes none, or undefined to leave it as it is. */
    #keyInput(input: CustomProviderInput, creating: boolean): string | undefined {
        if (input.noKey === true) {
            return NO_KEY;
        }

        if (input.apiKey === undefined || input.apiKey === null || input.apiKey === "") {
            if (creating) {
                throw new HttpError(400, "Enter an API key, or choose No key.");
            }

            return undefined;
        }

        return text(input.apiKey, "an API key", MAX_KEY);
    }

    /** `models.json` as Pi Pocket may rewrite it: plain JSON that Pi accepts, or a new one. */
    async #editable(): Promise<Json> {
        this.#seen = rawModels();
        const config = this.#read();

        if (config === undefined) {
            return { providers: {} };
        }

        if (
            typeof config.providers !== "object" ||
            config.providers === null ||
            Array.isArray(config.providers)
        ) {
            throw new HttpError(409, "models.json has no providers object. Fix it by hand first.");
        }

        if ((await refusal(modelsPath())) !== undefined) {
            throw new HttpError(409, "Pi cannot read models.json as it is. Fix it by hand first.");
        }

        return config;
    }

    /** The file as plain JSON; undefined when there is none. Comments and trailing commas stop a rewrite. */
    #read(): Json | undefined {
        let raw: string;

        try {
            raw = readFileSync(modelsPath(), "utf8").replace(/^\uFEFF/, "");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }

            throw new HttpError(500, `Could not read models.json: ${describe(error)}`);
        }

        if (raw.trim() === "") {
            return undefined;
        }

        try {
            const value = JSON.parse(raw) as unknown;

            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                throw new Error("not an object");
            }

            return value as Json;
        } catch {
            throw new HttpError(
                409,
                "models.json is not plain JSON (it may have comments or trailing commas), " +
                    "so Pi Pocket leaves it alone. Edit it by hand.",
            );
        }
    }

    /**
     * Write the whole file at once (a temporary file, then a rename), private, with its folder made when missing.
     * A file Pi would refuse is not written: Pi then loads none of its providers.
     */
    async #write(config: Json): Promise<void> {
        const link = modelsPath();
        // A models.json that links elsewhere (a dotfiles folder) stays a link: the file it names changes.
        const path = existsSync(link) ? realpathSync(link) : link;
        const temp = `${path}.${String(process.pid)}.tmp`;

        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);

        const refused = await refusal(temp);

        if (refused !== undefined) {
            rmSync(temp, { force: true });

            throw new HttpError(400, `Pi did not accept the endpoint: ${refused}`);
        }

        // Another server or Pi changed the file since it was read: writing now would undo that change.
        if (rawModels() !== this.#seen) {
            rmSync(temp, { force: true });

            throw new HttpError(409, "models.json changed meanwhile. Try again.");
        }

        renameSync(temp, path);
    }

    /** Pi's runtime reads the provider again: its models come, change, or go, and every tab gets them. */
    async #applied(id: string): Promise<void> {
        const models = this.#app.models;
        const { errors } = await models.refresh({ allowNetwork: false, providers: [id] });
        const problem = (models.getError() ?? "")
            .split("\n")
            .find((line) => line.startsWith(`Provider "${id}":`));

        this.#app.providers.modelsChanged();

        if (problem !== undefined) {
            throw new HttpError(400, `Pi did not accept the endpoint: ${problem}`);
        }

        // Not the error itself, which can come from the sign-in store.
        if (errors.has(id)) {
            throw new HttpError(500, "Pi could not load the endpoint. Try Refresh models.");
        }
    }

    /** Remove the endpoint's stored key; give it back, with the sign-in count after, for a save to put back. */
    async #takeKey(id: string): Promise<{ key: string; epoch: number } | undefined> {
        if (!(await this.#stored(id))) {
            return undefined;
        }

        const providers = this.#app.providers;
        const epoch = providers.signInEpoch(id);
        const key = (await this.#app.models.getAuth(id).catch(() => undefined))?.auth.apiKey;

        await providers.logout(id);

        // Another sign-in or sign-out ended meanwhile: the key read may not be the one that went.
        return key === undefined || providers.signInEpoch(id) !== epoch + 1
            ? undefined
            : { key, epoch: epoch + 1 };
    }

    async #forgetKey(id: string): Promise<void> {
        if (await this.#stored(id)) {
            await this.#app.providers.logout(id);
        }
    }

    /** Whether auth.json has a key for the endpoint now: also one that Pi in a terminal stored. */
    async #stored(id: string): Promise<boolean> {
        return (await this.#app.models.listCredentials()).some((each) => each.providerId === id);
    }

    #one(id: string): CustomProvider {
        const found = this.list().find((each) => each.id === id);

        if (found === undefined) {
            throw new HttpError(500, "The endpoint was saved, but is not in models.json.");
        }

        return found;
    }
}

/** What Pi says when it refuses a `models.json` file, by the field it refuses; undefined when Pi reads the file. */
async function refusal(path: string): Promise<string | undefined> {
    const runtime = await ModelRuntime.create({ modelsPath: path, refreshOnCreate: false });
    const error = runtime.getError() ?? "";

    if (!MODELS_JSON_REFUSED.test(error)) {
        return undefined;
    }

    // Not the parser's own words: they can quote the file, and a hand-made key with it.
    return (
        error
            .split("\n")
            .find((line) => line.startsWith("  - "))
            ?.slice(4) ?? "the file is not valid"
    );
}

function entryOf(model: CustomModel): Json {
    return applyForm({ id: model.id }, model);
}

/** A response's text, refused past `max` bytes. */
async function limitedText(response: Response, max: number): Promise<string> {
    const reader = response.body?.getReader();

    if (reader === undefined) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        size += value.byteLength;

        if (size > max) {
            await reader.cancel().catch(() => {});

            throw new Error("too large");
        }

        chunks.push(value);
    }

    return Buffer.concat(chunks).toString("utf8");
}
