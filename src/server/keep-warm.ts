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

/** What Pi knows of a model for keep warm: its cache lifetime in minutes, and where Auto stops, in refreshes. */
type PiFacts = { lifetime?: number; breakEven?: number };

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
const MODEL_FIELDS = ["minutes", "lifetime"] as const;

/** Providers that make the models they list: their published prices win over a reseller's or a cloud's. */
const MAKERS = new Set(["anthropic", "openai", "xai", "google", "mistral", "deepseek"]);

/** The last part of a model id, which a reseller's id (`cc/claude-opus-5-5`) shares with the maker's. */
const bareId = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

/**
 * A model's published cache prices per million tokens, for Auto's stop only: the read, and what a miss costs (the
 * write). Anthropic's 1-hour write is twice the input price, where Pi's price is the 5-minute write; a maker with no
 * write price (OpenAI, xAI) charges the plain input price. Undefined: not published.
 */
export function cachePrices(
    model: Model<Api>,
    seconds: number | undefined,
): { read: number; write: number } | undefined {
    const { input, cacheRead, cacheWrite } = model.cost;

    if (cacheRead <= 0 || input <= 0) {
        return undefined;
    }

    const hourWrite = model.api === "anthropic-messages" && (seconds ?? 0) >= 3600;

    return { read: cacheRead, write: hourWrite ? input * 2 : cacheWrite > 0 ? cacheWrite : input };
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
     * What is known of a model (`provider/modelId`): the owner's minutes and lifetime, and Pi's published cache prices,
     * which only decide where Auto stops (a model at $0, such as a subscription, takes the maker's for the same id).
     * The keeper reads Pi's lifetime from the model itself, for the tier in use.
     */
    facts(spec: string): ModelFacts {
        const own = this.#app.config.keepWarm.models[spec] ?? {};
        const model = this.#model(spec);
        const seconds = model?.promptCache?.[tier()];
        const listed = model === undefined ? undefined : this.#published(model.id);
        const prices =
            (model === undefined ? undefined : cachePrices(model, seconds)) ??
            (listed === undefined ? undefined : cachePrices(listed, seconds));

        return {
            ...(own.minutes === undefined ? {} : { minutes: own.minutes }),
            ...(own.lifetime === undefined ? {} : { lifetimeMs: own.lifetime * 60_000 }),
            ...(prices === undefined ? {} : { prices }),
        };
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
                        throw new HttpError(400, `${field} is not minutes or lifetime`);
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

    /** Every model people can pick, and every model the owner set values for, with Pi's facts. */
    /** What Pi knows of a model: its cache lifetime, and Auto's stop from its published prices. */
    #piFacts(model: Model<Api> | undefined): PiFacts {
        if (model === undefined) {
            return {};
        }

        const seconds = model.promptCache?.[tier()];
        const prices = this.facts(specOf(model)).prices;
        const breakEven = prices === undefined ? 0 : breakEvenRefreshes(prices);

        return {
            ...(seconds === undefined ? {} : { lifetime: Math.round(seconds / 60) }),
            ...(breakEven > 0 ? { breakEven } : {}),
        };
    }

    #rows(settings: KeepWarmSettings): ModelRow[] {
        const rows = new Map<string, ModelRow>();

        for (const model of this.#app.models.getAvailableSnapshot()) {
            const spec = specOf(model);

            rows.set(spec, {
                spec,
                name: model.name,
                pi: this.#piFacts(model),
            });
        }

        for (const spec of Object.keys(settings.models)) {
            if (!rows.has(spec)) {
                const model = this.#model(spec);

                rows.set(spec, {
                    spec,
                    name: model?.name ?? spec.slice(spec.indexOf("/") + 1),
                    pi: this.#piFacts(model),
                });
            }
        }

        return [...rows.values()];
    }
}
