/**
 * Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, each session's own choice,
 * and what browsers see of both. The refreshes themselves are `cache-keeper.ts`'s.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    breakEvenRefreshes,
    type IdlePolicy,
    type IdleStatus,
    type ModelFacts,
    specOf,
} from "./cache-keeper.ts";
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
 * What is known of a model for the settings window: its cache lifetime in minutes from Pi or the maker's docs (the
 * owner's own replaces it), its published cache read price per million tokens (none: the owner may type one), and
 * where Auto stops, in refreshes.
 */
type Known = { lifetime?: number; read?: number; breakEven?: number };

/** What the settings window lists for one model. */
type ModelRow = { spec: string; name: string; known: Known };

/**
 * Cache lifetimes in minutes that makers publish and Pi's list leaves out, by bare model id, as written in their docs
 * (2026-11-02): OpenAI's default tier keeps a prompt at least 30 minutes. xAI publishes none for Grok.
 */
const PUBLISHED_LIFETIMES: readonly [RegExp, number][] = [[/^gpt-/, 30]];

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
const MODEL_FIELDS = ["lifetime", "read"] as const;

/** Providers that make the models they list: their published prices win over a reseller's or a cloud's. */
const MAKERS = new Set(["anthropic", "openai", "xai", "google", "mistral", "deepseek"]);

/** The last part of a model id, which a reseller's id (`cc/claude-opus-5-5`) shares with the maker's. */
const bareId = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

/** A cache lifetime in minutes a maker publishes for this model, when Pi's list has none. */
function publishedLifetime(id: string): number | undefined {
    const bare = bareId(id);

    return PUBLISHED_LIFETIMES.find(([pattern]) => pattern.test(bare))?.[1];
}

/**
 * A model's published cache prices per million tokens, for Auto's stop only: the read, and what a miss costs (the
 * write). Anthropic's 1-hour write is twice the input price, where Pi's price is the 5-minute write; a maker with no
 * write price (OpenAI, xAI) charges the plain input price. Undefined: not published.
 */
export function cachePrices(
    model: Model<Api>,
    seconds: number | undefined,
    read = model.cost.cacheRead,
): { read: number; write: number } | undefined {
    const { input, cacheWrite } = model.cost;

    if (read <= 0 || input <= 0) {
        return undefined;
    }

    const hourWrite = model.api === "anthropic-messages" && (seconds ?? 0) >= 3600;

    return { read, write: hourWrite ? input * 2 : cacheWrite > 0 ? cacheWrite : input };
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
     * What is known of a model (`provider/modelId`): its cache lifetime (the owner's, else one a maker publishes that
     * Pi's list leaves out; the keeper reads Pi's own from the model), and Pi's published cache prices, which only decide
     * where Auto stops (a model at $0, such as a subscription, takes the maker's for the same id).
     */
    facts(spec: string): ModelFacts {
        const own = this.#app.config.keepWarm.models[spec] ?? {};
        const model = this.#model(spec);
        const seconds = model?.promptCache?.[tier()];
        const listed = model === undefined ? undefined : this.#published(model.id);
        const prices =
            (model === undefined ? undefined : cachePrices(model, seconds)) ??
            (listed === undefined ? undefined : cachePrices(listed, seconds)) ??
            this.#ownPrices(own.read, model, listed, seconds);
        const minutes =
            own.lifetime ??
            (seconds === undefined && model !== undefined
                ? publishedLifetime(model.id)
                : undefined);

        return {
            ...(minutes === undefined ? {} : { lifetimeMs: minutes * 60_000 }),
            ...(prices === undefined ? {} : { prices }),
        };
    }

    /**
     * The owner's read price for a model with none published, with the write its input price implies (the model's, else
     * the maker's for the same id). No input price: only the read is known, and Auto stops at the refresh cap.
     */
    #ownPrices(
        read: number | undefined,
        model: Model<Api> | undefined,
        listed: Model<Api> | undefined,
        seconds: number | undefined,
    ): ModelFacts["prices"] {
        if (read === undefined || read <= 0) {
            return undefined;
        }

        const priced = [model, listed].find((each) => (each?.cost.input ?? 0) > 0);

        return (
            (priced === undefined ? undefined : cachePrices(priced, seconds, read)) ?? {
                read,
                write: 0,
            }
        );
    }

    /** Pi's models with published cache prices, by bare id; built again a minute later, as model lists change rarely. */
    #publishedIndex: { at: number; byId: Map<string, Model<Api>> } | undefined;

    /** The model Pi lists with published cache prices under the same bare id as `id`: the maker's, first. */
    #published(id: string): Model<Api> | undefined {
        const now = Date.now();

        if (this.#publishedIndex === undefined || now - this.#publishedIndex.at > 60_000) {
            const byId = new Map<string, Model<Api>>();

            for (const model of this.#app.models.getModels()) {
                const key = bareId(model.id);
                const known = byId.get(key);

                // The maker's own listing wins over a cloud's (Bedrock, Vertex), whose ids and prices differ.
                if (
                    cachePrices(model, undefined) !== undefined &&
                    (known === undefined ||
                        (MAKERS.has(model.provider) && known.provider !== model.provider))
                ) {
                    byId.set(key, model);
                }
            }

            this.#publishedIndex = { at: now, byId };
        }

        return this.#publishedIndex.byId.get(bareId(id));
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
                        throw new HttpError(400, `${field} is not lifetime or read`);
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

    #model(spec: string): Model<Api> | undefined {
        const slash = spec.indexOf("/");

        return slash > 0
            ? this.#app.models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
            : undefined;
    }

    /** What the settings window shows of a model before the owner's value: lifetime, read price, and Auto's stop. */
    #known(model: Model<Api> | undefined): Known {
        if (model === undefined) {
            return {};
        }

        const seconds = model.promptCache?.[tier()];
        const lifetime =
            seconds === undefined ? publishedLifetime(model.id) : Math.round(seconds / 60);
        const prices = this.facts(specOf(model)).prices;
        const breakEven = prices === undefined ? 0 : breakEvenRefreshes(prices);
        const listed = this.#published(model.id);
        const published = (model.cost.cacheRead > 0 ? model : listed)?.cost.cacheRead;

        return {
            ...(lifetime === undefined ? {} : { lifetime }),
            ...(published === undefined || published <= 0 ? {} : { read: published }),
            ...(breakEven > 0 ? { breakEven } : {}),
        };
    }

    /** Every model people can pick, and every model the owner set values for, with what is known of each. */
    #rows(settings: KeepWarmSettings): ModelRow[] {
        const rows = new Map<string, ModelRow>();

        for (const model of this.#app.models.getAvailableSnapshot()) {
            const spec = specOf(model);

            rows.set(spec, {
                spec,
                name: model.name,
                known: this.#known(model),
            });
        }

        for (const spec of Object.keys(settings.models)) {
            if (!rows.has(spec)) {
                const model = this.#model(spec);

                rows.set(spec, {
                    spec,
                    name: model?.name ?? spec.slice(spec.indexOf("/") + 1),
                    known: this.#known(model),
                });
            }
        }

        return [...rows.values()];
    }
}
