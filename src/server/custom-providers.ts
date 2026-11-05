/**
 * OpenAI-compatible endpoints the owner adds from the Providers sheet. Each is a provider in Pi's `models.json`
 * (`~/.pi/agent/models.json`, made with its folder when missing), with `api: "openai-completions"`, a base URL, and
 * the models the owner chose. Its API key goes into Pi's sign-ins (`auth.json`), as an API-key sign-in does, never into
 * `models.json`; an endpoint without a key gets the placeholder `none`, as Pi's docs do for Ollama.
 *
 * Pi Pocket rewrites `models.json` only when it is plain JSON that Pi accepts: a file with comments or trailing commas
 * (which Pi reads) or one that Pi refuses is left alone, with a message, so a hand-made file never loses anything.
 * Fields it does not manage (headers, compat, a model's other metadata) are kept as they are. Of a model's metadata, the
 * form sets only image input (`input`) and thinking (`reasoning` and `thinkingLevelMap`).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PocketApp } from "./app.ts";
import { describe, HttpError } from "./errors.ts";

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

export interface CustomModel {
    id: string;
    contextWindow?: number;
    /** It sees images (`input` has `"image"`). Left out of a change: as it was. */
    images?: boolean;
    /** The levels it thinks at, or null when it does not think. Left out of a change: as it was. */
    thinking?: ThinkingTier[] | null;
}

/** A model as the form sees it: what the endpoint says it can do, read back from `models.json`. */
export interface CustomModelInfo {
    id: string;
    images: boolean;
    thinking: ThinkingTier[] | null;
}

/** What discovery found out about a model, when the endpoint says it. */
export interface ListedModel {
    id: string;
    contextWindow?: number;
    images?: boolean;
    reasoning?: boolean;
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
export function modelsPath(): string {
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
export function baseUrlOf(value: unknown): string {
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

/** The models asked for: ids, each once, with a context window when the endpoint said one. */
export function modelsOf(value: unknown): CustomModel[] {
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

        const window = entry?.contextWindow;
        const images = entry?.images;

        if (images !== undefined && typeof images !== "boolean") {
            throw new HttpError(400, `${id}: images must be true or false.`);
        }

        seen.set(id, {
            id,
            ...(typeof window === "number" && Number.isFinite(window) && window > 0
                ? { contextWindow: Math.floor(window) }
                : {}),
            ...(images === undefined ? {} : { images }),
            ...(entry?.thinking === undefined ? {} : { thinking: tiersOf(id, entry.thinking) }),
        });
    }

    return [...seen.values()];
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

/** Sets what the form changes in a model's entry: image input and thinking. Other fields stay as they are. */
function applyCapabilities(entry: Json, model: CustomModel): Json {
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

/** A provider id from its name: lowercase words joined by `-`, not one Pi already has. */
export function idFor(name: string, taken: (id: string) => boolean): string {
    const base =
        name
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "openai-compatible";
    let id = base;

    for (let n = 2; taken(id); n++) {
        id = `${base}-${String(n)}`;
    }

    return id;
}

/**
 * The ids of an endpoint's models, from an OpenAI `/models` answer (or the shapes close to it), and what the model can
 * do where the list says it: OpenRouter's `architecture.input_modalities` and `supported_parameters`, or a
 * `capabilities` list (`vision`, `thinking`).
 */
export function parseModelList(body: unknown): ListedModel[] {
    const list = Array.isArray(body)
        ? body
        : Array.isArray((body as Json | null)?.data)
          ? ((body as Json).data as unknown[])
          : Array.isArray((body as Json | null)?.models)
            ? ((body as Json).models as unknown[])
            : undefined;

    if (list === undefined) {
        throw new Error("The answer has no list of models.");
    }

    const models: ListedModel[] = [];

    for (const each of list) {
        const entry = (typeof each === "string" ? { id: each } : each) as Json | null;
        const id = entry?.id ?? entry?.model ?? entry?.name;

        if (typeof id !== "string" || id === "" || id.length > MAX_ID) {
            continue;
        }

        const window = [entry?.context_length, entry?.max_model_len, entry?.context_window].find(
            (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
        ) as number | undefined;

        const said = (value: unknown): string[] =>
            Array.isArray(value)
                ? value.filter((each): each is string => typeof each === "string")
                : [];
        const modalities = said((entry?.architecture as Json | null)?.input_modalities);
        const parameters = said(entry?.supported_parameters);
        const capabilities = said(entry?.capabilities);
        const images = modalities.includes("image") || capabilities.includes("vision");
        const reasoning =
            parameters.includes("reasoning") ||
            parameters.includes("reasoning_effort") ||
            capabilities.includes("thinking") ||
            capabilities.includes("reasoning");

        models.push({
            id,
            ...(window === undefined ? {} : { contextWindow: Math.floor(window) }),
            ...(images ? { images } : {}),
            ...(reasoning ? { reasoning } : {}),
        });
    }

    return [...new Map(models.map((model) => [model.id, model])).values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, MAX_MODELS);
}

export class CustomProviders {
    readonly #app: PocketApp;
    readonly #path: () => string;
    readonly #fetch: typeof fetch;
    /** Changes, one after another: each reads the file the one before wrote. */
    #queue: Promise<unknown> = Promise.resolve();

    constructor(app: PocketApp, options: { path?: () => string; fetch?: typeof fetch } = {}) {
        this.#app = app;
        this.#path = options.path ?? modelsPath;
        this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    }

    /** The endpoints in `models.json` that this sheet manages: OpenAI-compatible, with a base URL, not built in. */
    list(): CustomProvider[] {
        const providers = (this.#read()?.providers ?? {}) as Record<string, Json>;

        return Object.entries(providers)
            .filter(([id, entry]) => this.#manages(id, entry))
            .map(([id, entry]) => ({
                id,
                name: typeof entry.name === "string" ? entry.name : id,
                baseUrl: entry.baseUrl as string,
                models: (Array.isArray(entry.models) ? (entry.models as (Json | null)[]) : [])
                    .filter((model): model is Json => typeof model?.id === "string")
                    .map((model) => ({
                        id: model.id as string,
                        images: Array.isArray(model.input) && model.input.includes("image"),
                        thinking: tiersOfEntry(model),
                    })),
                key: this.#keyOf(id, entry),
            }))
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
            const id = idFor(
                name,
                (each) =>
                    each in providers ||
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
            this.#write(config);
            await this.#applied(id);

            if (key !== undefined && key !== NO_KEY) {
                await this.#storeKey(id, key);
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

            if (input.baseUrl !== undefined) {
                entry.baseUrl = baseUrlOf(input.baseUrl);
            }

            if (input.models !== undefined) {
                const before = new Map(
                    (Array.isArray(entry.models) ? (entry.models as Json[]) : []).map((model) => [
                        model?.id,
                        model,
                    ]),
                );

                entry.models = modelsOf(input.models).map((model) => {
                    const kept = before.get(model.id);

                    return kept === undefined
                        ? entryOf(model)
                        : applyCapabilities({ ...kept }, model);
                });
            }

            const key = this.#keyInput(input, false);

            if (key === NO_KEY) {
                entry.apiKey = NO_KEY;
            } else if (key !== undefined && entry.apiKey === NO_KEY) {
                // A real key replaces the placeholder: the stored sign-in carries it from now on.
                delete entry.apiKey;
            }

            this.#write(config);
            await this.#applied(id);

            if (key === NO_KEY) {
                await this.#forgetKey(id);
            } else if (key !== undefined) {
                await this.#storeKey(id, key);
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
            this.#write(config);
            await this.#forgetKey(id);
            await this.#applied(id);
        });
    }

    /**
     * Ask an endpoint for its models (`GET <baseUrl>/models`), with the key given, or else the saved endpoint's own.
     * The owner's to ask, so a local or private address is allowed: that is where such servers often are.
     */
    async discover(input: {
        baseUrl?: unknown;
        apiKey?: unknown;
        id?: unknown;
    }): Promise<ListedModel[]> {
        const baseUrl = baseUrlOf(input.baseUrl);
        const headers: Record<string, string> = { accept: "application/json" };
        let key =
            typeof input.apiKey === "string" && input.apiKey.trim() !== ""
                ? input.apiKey.trim()
                : undefined;

        if (
            key === undefined &&
            typeof input.id === "string" &&
            this.list().some((each) => each.id === input.id)
        ) {
            const auth = await this.#app.models.getAuth(input.id).catch(() => undefined);

            key = auth?.auth.apiKey;
            Object.assign(headers, auth?.auth.headers ?? {});
        }

        if (key !== undefined && key !== NO_KEY) {
            headers.authorization = `Bearer ${key}`;
        }

        let response: Response;

        try {
            response = await this.#fetch(`${baseUrl}/models`, {
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
                    : `The endpoint answered ${String(response.status)} for ${baseUrl}/models. Add model IDs by hand.`,
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
        const config = this.#read() ?? { providers: {} };

        if (
            typeof config.providers !== "object" ||
            config.providers === null ||
            Array.isArray(config.providers)
        ) {
            throw new HttpError(409, "models.json has no providers object. Fix it by hand first.");
        }

        if (existsSync(this.#path())) {
            const checked = await ModelRuntime.create({
                modelsPath: this.#path(),
                refreshOnCreate: false,
            });

            if (
                /Failed to (?:load|parse) models.json|Invalid models.json schema/.test(
                    checked.getError() ?? "",
                )
            ) {
                throw new HttpError(
                    409,
                    "Pi cannot read models.json as it is. Fix it by hand first.",
                );
            }
        }

        return config;
    }

    /** The file as plain JSON; undefined when there is none. Comments and trailing commas stop a rewrite. */
    #read(): Json | undefined {
        let raw: string;

        try {
            raw = readFileSync(this.#path(), "utf8").replace(/^\uFEFF/, "");
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
                "models.json is not plain JSON (it may have comments or trailing commas), so Pi Pocket leaves it alone. Edit it by hand.",
            );
        }
    }

    /** Write the whole file at once (a temporary file, then a rename), private, with its folder made when missing. */
    #write(config: Json): void {
        const path = this.#path();
        const temp = `${path}.${String(process.pid)}.tmp`;

        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
    }

    /** Pi's runtime reads the provider again: its models come, change, or go, and every tab gets them. */
    async #applied(id: string): Promise<void> {
        const models = this.#app.models;

        await models.refresh({ allowNetwork: false, providers: [id] });
        const problem = (models.getError() ?? "")
            .split("\n")
            .find((line) => line.startsWith(`Provider "${id}":`));

        this.#app.providers.modelsChanged();

        if (problem !== undefined) {
            throw new HttpError(400, `Pi did not accept the endpoint: ${problem}`);
        }
    }

    /** The key, as a stored API-key sign-in: the same as the Providers sheet's API key button stores. */
    async #storeKey(id: string, key: string): Promise<void> {
        await this.#app.models.login(id, "api_key", {
            prompt: () => Promise.resolve(key),
            notify: () => {},
        });
        await this.#app.models.getAvailable().catch(() => []);
        this.#app.providers.modelsChanged();
    }

    async #forgetKey(id: string): Promise<void> {
        if (this.#app.models.getProviderAuthStatus(id).source === "stored") {
            await this.#app.providers.logout(id);
        }
    }

    #one(id: string): CustomProvider {
        const found = this.list().find((each) => each.id === id);

        if (found === undefined) {
            throw new HttpError(500, "The endpoint was saved, but is not in models.json.");
        }

        return found;
    }
}

function entryOf(model: CustomModel): Json {
    return applyCapabilities(
        {
            id: model.id,
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        },
        model,
    );
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
