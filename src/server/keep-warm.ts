/**
 * Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, each session's own choice,
 * and what browsers see of both. The refreshes themselves are `cache-keeper.ts`'s.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type IdlePolicy, type IdleStatus, type ModelFacts, specOf } from "./cache-keeper.ts";
import {
    isKeepWarmTime,
    type KeepWarmModel,
    type KeepWarmSettings,
    type KeepWarmTime,
    keepWarmFrom,
    keepWarmModelFrom,
    type User,
} from "./config.ts";
import { SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

/** A session's choice: the owner's default, or a time of its own (0: off, "auto", or hours). */
export type KeepWarmChoice = "default" | KeepWarmTime;

/**
 * What Pi knows of a model for keep warm: its cache lifetime in minutes, and its cache prices per million tokens.
 * `pricesFrom`: the model in Pi's own list the prices came from, when this one has none (a subscription at $0).
 */
type PiFacts = { lifetime?: number; read?: number; write?: number; pricesFrom?: string };

/** What the settings window lists for one model: Pi's facts, which the owner's own replace field by field. */
type ModelRow = { spec: string; name: string; pi: PiFacts };

/** The cache tier requests use: Pi's `PI_CACHE_RETENTION`. */
const tier = (): "short" | "long" => (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");

const ownerOnly = (user: User) => {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can do that");
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields of a model the owner may set; null takes one off. */
const MODEL_FIELDS = ["minutes", "lifetime", "read", "write"] as const;

/**
 * A model's cache prices per million tokens. Prices of 0 are not known (a subscription, or a `models.json` that left them
 * out). Anthropic charges twice the input price to write a cache that lives an hour, where Pi's price is the 5-minute
 * write.
 */
function cachePrices(
    model: Model<Api>,
    seconds: number | undefined,
): { read?: number; write?: number } {
    const { input, cacheRead, cacheWrite } = model.cost;
    const hourWrite = model.api === "anthropic-messages" && (seconds ?? 0) >= 3600 && input > 0;

    return {
        ...(cacheRead > 0 ? { read: cacheRead } : {}),
        ...(hourWrite ? { write: input * 2 } : cacheWrite > 0 ? { write: cacheWrite } : {}),
    };
}

/** The last part of a model id, which a reseller's id (`cc/claude-opus-5-5`) shares with the maker's. */
const bareId = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

/** Pi's facts about a model; `priced` finds the same model from a provider that lists prices. */
function piFacts(
    model: Model<Api> | undefined,
    priced: (id: string) => Model<Api> | undefined,
): PiFacts {
    if (model === undefined) {
        return {};
    }

    const seconds = model.promptCache?.[tier()];
    const own = cachePrices(model, seconds);
    const lacking = own.read === undefined || own.write === undefined;
    // No prices of its own: the same model from a provider that lists them, at this model's cache lifetime.
    const twin = lacking ? priced(model.id) : undefined;
    const theirs =
        twin === undefined ? {} : cachePrices(twin, seconds ?? twin.promptCache?.[tier()]);
    const read = own.read ?? theirs.read;
    const write = own.write ?? theirs.write;
    const borrowed =
        twin !== undefined && (theirs.read !== undefined || theirs.write !== undefined);

    return {
        ...(seconds === undefined ? {} : { lifetime: Math.round(seconds / 60) }),
        ...(read === undefined ? {} : { read }),
        ...(write === undefined ? {} : { write }),
        ...(borrowed ? { pricesFrom: specOf(twin) } : {}),
    };
}

export class KeepWarm {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** How a conversation is kept warm once its run ends; undefined: it is not. Read at each refresh. */
    policy(conversationId: number): IdlePolicy | undefined {
        const app = this.#app;
        const id = conversationId as ConversationId;
        const root = app.rootOf(id);
        const meta = app.sessionMeta(root);
        const settings = app.config.keepWarm;

        // Sessions and their subagents only: PiP and conversations no person opened are left alone.
        if (meta === undefined || meta.pip !== undefined || meta.archived === true) {
            return undefined;
        }

        if (root !== id && !settings.subagents) {
            return undefined;
        }

        const hours = isKeepWarmTime(meta.keepWarm) ? meta.keepWarm : settings.hours;

        if (hours === 0) {
            return undefined;
        }

        return {
            hours,
            maxCost: settings.maxCost,
            maxRefreshes: settings.maxRefreshes,
            share: settings.share,
        };
    }

    /**
     * What is known of a model (`provider/modelId`): the owner's minutes and lifetime, and cache prices, the owner's
     * over Pi's. The lifetime is the owner's only: the keeper reads Pi's from the model itself, for the tier in use.
     */
    facts(spec: string): ModelFacts {
        const own = this.#app.config.keepWarm.models[spec] ?? {};
        const pi =
            own.read === undefined || own.write === undefined
                ? piFacts(this.#model(spec), (id) => this.#priced(id))
                : {};
        const read = own.read ?? pi.read;
        const write = own.write ?? pi.write;

        return {
            ...(own.minutes === undefined ? {} : { minutes: own.minutes }),
            ...(own.lifetime === undefined ? {} : { lifetimeMs: own.lifetime * 60_000 }),
            ...(read === undefined || write === undefined ? {} : { prices: { read, write } }),
        };
    }

    /** For a tab's hello: the owner's time, which the session row names as its default. */
    hello() {
        return { hours: this.#app.config.keepWarm.hours };
    }

    /** The settings window's: every setting, Pi's facts about each model, and what is warm now. */
    overview(user: User) {
        ownerOnly(user);
        const settings = this.#app.config.keepWarm;

        return {
            settings,
            models: this.#rows(settings),
            now: this.#app.cacheKeeper.idleSummary(),
        };
    }

    /** A session's choice and what its cache keeper does now, for its view. */
    session(id: ConversationId): { choice: KeepWarmChoice; status: IdleStatus } | undefined {
        const meta = this.#app.sessionMeta(id);

        if (meta === undefined || meta.pip !== undefined) {
            return undefined;
        }

        return {
            choice: isKeepWarmTime(meta.keepWarm) ? meta.keepWarm : "default",
            status: this.#app.cacheKeeper.idleStatus(Number(id)),
        };
    }

    /** The owner changes some of the settings; the rest stay. Each warm session follows the new ones at once. */
    async setSettings(user: User, patch: unknown): Promise<void> {
        ownerOnly(user);

        if (!isRecord(patch)) {
            throw new HttpError(400, "keepWarm must be an object of settings");
        }

        const asked = patch as Partial<Record<keyof KeepWarmSettings, unknown>>;
        const current = this.#app.config.keepWarm;
        const next: KeepWarmSettings = { ...current, models: { ...current.models } };

        if ("hours" in asked) {
            if (!isKeepWarmTime(asked.hours)) {
                throw new HttpError(400, 'hours must be 0, "auto", 1, 2, 4, or 8');
            }

            next.hours = asked.hours;
        }

        const number = (key: "maxCost" | "maxRefreshes" | "share", low: number, high: number) => {
            const value = asked[key];

            if (value === undefined) {
                return;
            }

            if (
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                value < low ||
                value > high
            ) {
                throw new HttpError(
                    400,
                    `${key} must be a number from ${String(low)} to ${String(high)}`,
                );
            }

            next[key] = key === "maxCost" ? value : Math.round(value);
        };

        number("maxCost", 0, 1000);
        number("maxRefreshes", 1, 10_000);
        number("share", 10, 95);

        if (asked.subagents !== undefined) {
            if (typeof asked.subagents !== "boolean") {
                throw new HttpError(400, "subagents must be true or false");
            }

            next.subagents = asked.subagents;
        }

        // A model's facts, field by field: a number sets one, null takes it off so Pi's counts again.
        if (asked.models !== undefined) {
            if (!isRecord(asked.models)) {
                throw new HttpError(
                    400,
                    "models must be an object of provider/modelId to its values",
                );
            }

            for (const [spec, fields] of Object.entries(asked.models)) {
                if (spec.indexOf("/") <= 0 || !isRecord(fields)) {
                    throw new HttpError(400, `${spec} is not provider/modelId with values`);
                }

                const merged: Record<string, unknown> = { ...next.models[spec] };

                for (const [field, value] of Object.entries(fields)) {
                    if (!(MODEL_FIELDS as readonly string[]).includes(field)) {
                        throw new HttpError(
                            400,
                            `${field} is not minutes, lifetime, read, or write`,
                        );
                    }

                    if (value === null) {
                        delete merged[field];
                    } else if (keepWarmModelFrom({ [field]: value }) === undefined) {
                        throw new HttpError(400, `${field} for ${spec} is out of range`);
                    } else {
                        merged[field] = value;
                    }
                }

                const model: KeepWarmModel | undefined = keepWarmModelFrom(merged);

                if (model === undefined) {
                    delete next.models[spec];
                } else {
                    next.models[spec] = model;
                }
            }
        }

        this.#app.config.keepWarm = keepWarmFrom(next);
        this.#app.cacheKeeper.reconsider();
        await this.#app.keepWarmSettingsChanged();
    }

    /** Someone who can steer chooses for one session; the owner's caps bound every choice. */
    async setSession(id: ConversationId, choice: unknown): Promise<void> {
        if (choice !== "default" && !isKeepWarmTime(choice)) {
            throw new HttpError(400, 'keepWarm must be "default", 0, "auto", 1, 2, 4, or 8');
        }

        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined || meta.pip !== undefined) {
                throw new HttpError(404, "Not a session");
            }

            if (choice === "default") {
                delete meta.keepWarm;
            } else {
                meta.keepWarm = choice;
            }
        }, BACKGROUND_CONTEXT);
        this.#app.cacheKeeper.reconsider();
    }

    /** Pi's models with cache prices, by bare id; built again a minute later, as model lists change rarely. */
    #pricedIndex: { at: number; byId: Map<string, Model<Api>> } | undefined;

    /** A model Pi lists with cache prices, of the same bare id as `id`: the maker's, first. */
    #priced(id: string): Model<Api> | undefined {
        const now = Date.now();

        if (this.#pricedIndex === undefined || now - this.#pricedIndex.at > 60_000) {
            const byId = new Map<string, Model<Api>>();

            for (const model of this.#app.models.getModels()) {
                const key = bareId(model.id);
                const known = byId.get(key);

                // The maker's own listing wins over a cloud's (Bedrock, Vertex), whose ids and prices differ.
                if (
                    model.cost.cacheRead > 0 &&
                    model.cost.input > 0 &&
                    (known === undefined ||
                        ((model.provider === "anthropic" || model.provider === "openai") &&
                            known.provider !== model.provider))
                ) {
                    byId.set(key, model);
                }
            }

            this.#pricedIndex = { at: now, byId };
        }

        return this.#pricedIndex.byId.get(bareId(id));
    }

    #model(spec: string): Model<Api> | undefined {
        const slash = spec.indexOf("/");

        return slash > 0
            ? this.#app.models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
            : undefined;
    }

    /** Every model people can pick, and every model the owner set values for, with Pi's facts. */
    #rows(settings: KeepWarmSettings): ModelRow[] {
        const rows = new Map<string, ModelRow>();

        for (const model of this.#app.models.getAvailableSnapshot()) {
            const spec = specOf(model);

            rows.set(spec, {
                spec,
                name: model.name,
                pi: piFacts(model, (id) => this.#priced(id)),
            });
        }

        for (const spec of Object.keys(settings.models)) {
            if (!rows.has(spec)) {
                const model = this.#model(spec);

                rows.set(spec, {
                    spec,
                    name: model?.name ?? spec.slice(spec.indexOf("/") + 1),
                    pi: piFacts(model, (id) => this.#priced(id)),
                });
            }
        }

        return [...rows.values()];
    }
}
