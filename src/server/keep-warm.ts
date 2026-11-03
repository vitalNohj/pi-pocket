/**
 * Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, each session's own choice,
 * and what browsers see of both. The refreshes themselves are `cache-keeper.ts`'s.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type IdleStatus, specOf } from "./cache-keeper.ts";
import {
    isKeepWarmTime,
    savedKeepWarmTime,
    type KeepWarmModel,
    type KeepWarmSettings,
    type KeepWarmTime,
    keepWarmFrom,
    keepWarmModelFrom,
    type User,
} from "./config.ts";
import type { SessionMeta } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { breakEvenRefreshes, type IdlePolicy, idlePlan, type ModelFacts } from "./idle-plan.ts";
import { cachePrices, cacheTier, publishedLifetime, PublishedPrices } from "./model-cache-facts.ts";

/** The tier requests use when they say nothing: the lifetime the settings window and Break-even count with. */
const defaultTier = () => (cacheTier() === "long" ? "long" : "short");

/** The settings, sessions, models, and keeper calls that keep warm uses. */
export type KeepWarmDeps = {
    /** Throws unless `user` may see and steer the session. */
    requireAccess: (user: User, id: ConversationId) => void;
    settings: () => KeepWarmSettings;
    saveSettings: (next: KeepWarmSettings) => void;
    sessionMeta: (id: ConversationId) => SessionMeta | undefined;
    rootOf: (id: ConversationId) => ConversationId;
    commitSession: (id: ConversationId, change: (meta: SessionMeta) => void) => Promise<void>;
    model: (provider: string, id: string) => Model<Api> | undefined;
    models: () => Model<Api>[];
    availableModels: () => Model<Api>[];
    keeper: {
        idleSummary(): { warm: number; refreshes: number; spent: number };
        idleStatus(id: number): IdleStatus;
        reconsider(): void;
    };
    settingsChanged: () => Promise<void>;
};

/** A session's choice: the owner's default, or a time of its own (0: off, "break-even", or hours). */
export type KeepWarmChoice = "default" | KeepWarmTime;

/**
 * What is known of a model for the settings window: its cache lifetime in minutes from Pi or the maker's docs (the
 * owner's own replaces it), its published cache read price per million tokens (none: the owner may type one), and
 * where Break-even stops, in refreshes.
 */
type Known = { lifetime?: number; read?: number; breakEven?: number };

/** What the settings window lists for one model. */
type ModelRow = {
    spec: string;
    name: string;
    known: Known;
    /** How Break-even keeps it warm: undefined fields when no cache time is known, so it is not kept warm. */
    plan: { lifetime?: number; everyMs?: number; refreshes?: number; autoStopMs?: number };
};

const ownerOnly = (user: User) => {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can do that");
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields of a model the owner may set; null takes one off. */
const MODEL_FIELDS = ["lifetime", "read"] as const;

export class KeepWarm {
    readonly #deps: KeepWarmDeps;
    readonly #published: PublishedPrices;

    constructor(deps: KeepWarmDeps) {
        this.#deps = deps;
        this.#published = new PublishedPrices(deps.models);
    }

    /** How a conversation is kept warm once its run ends; undefined: it is not. Read at each refresh. */
    policy(conversationId: number): IdlePolicy | undefined {
        const id = conversationId as ConversationId;
        const root = this.#deps.rootOf(id);
        const meta = this.#deps.sessionMeta(root);
        const settings = this.#deps.settings();

        // Sessions and their subagents only: PiP and conversations no person opened are left alone.
        if (meta === undefined || meta.pip !== undefined || meta.archived === true) {
            return undefined;
        }

        if (root !== id && !settings.subagents) {
            return undefined;
        }

        const hours = savedKeepWarmTime(meta.keepWarm) ?? settings.hours;

        if (hours === 0) {
            return undefined;
        }

        return {
            session: Number(root),
            hours,
            maxCost: settings.maxCost,
            maxRefreshes: settings.maxRefreshes,
            share: settings.share,
        };
    }

    /**
     * What is known of a model (`provider/modelId`): its cache lifetime (the owner's, else one a maker publishes that
     * Pi's list leaves out; the keeper reads Pi's own from the model), and Pi's published cache prices, which only decide
     * where Break-even stops (a model at $0, such as a subscription, takes the maker's for the same id).
     */
    facts(spec: string): ModelFacts {
        const own = this.#deps.settings().models[spec] ?? {};
        const model = this.#model(spec);
        const seconds = model?.promptCache?.[defaultTier()];
        const listed = model === undefined ? undefined : this.#published.lookup(model.id);
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
     * the maker's for the same id). No input price: only the read is known, and Break-even stops at the refresh cap.
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

    /** For a tab's hello: the owner's time, which the session row names as its default. */
    hello() {
        return { hours: this.#deps.settings().hours };
    }

    /** The settings window's: every setting, Pi's facts about each model, and what is warm now. */
    overview(user: User) {
        ownerOnly(user);
        const settings = this.#deps.settings();

        return {
            settings,
            models: this.#rows(settings),
            now: this.#deps.keeper.idleSummary(),
        };
    }

    /** A session's choice and what its cache keeper does now, for its view. */
    session(id: ConversationId): { choice: KeepWarmChoice; status: IdleStatus } | undefined {
        const meta = this.#deps.sessionMeta(id);

        if (meta === undefined || meta.pip !== undefined) {
            return undefined;
        }

        return {
            choice: savedKeepWarmTime(meta.keepWarm) ?? "default",
            status: this.#deps.keeper.idleStatus(Number(id)),
        };
    }

    /** The owner changes some of the settings; the rest stay. Each warm session follows the new ones at once. */
    async setSettings(user: User, patch: unknown): Promise<void> {
        ownerOnly(user);

        if (!isRecord(patch)) {
            throw new HttpError(400, "keepWarm must be an object of settings");
        }

        const asked = patch as Partial<Record<keyof KeepWarmSettings, unknown>>;
        const current = this.#deps.settings();
        const next: KeepWarmSettings = { ...current, models: { ...current.models } };

        if ("hours" in asked) {
            if (!isKeepWarmTime(asked.hours)) {
                throw new HttpError(400, 'hours must be 0, "break-even", 0.5, 1, 2, 4, or 8');
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

        this.#deps.saveSettings(keepWarmFrom(next));
        this.#deps.keeper.reconsider();
        await this.#deps.settingsChanged();
    }

    /**
     * Check that `user` may choose `choice` for a session that has `current` now, and give the choice. Anyone who can see
     * and steer the session may turn it off. Only the owner turns it on or picks a time, as a refresh may be charged to
     * whoever pays for the session: so another person's Default may not turn on what is off.
     */
    checkChoice(
        user: User,
        id: ConversationId,
        choice: unknown,
        current?: unknown,
    ): KeepWarmChoice {
        this.#deps.requireAccess(user, id);

        if (choice !== "default" && !isKeepWarmTime(choice)) {
            throw new HttpError(
                400,
                'keepWarm must be "default", 0, "break-even", 0.5, 1, 2, 4, or 8',
            );
        }

        const turnsOn =
            choice === "default"
                ? savedKeepWarmTime(current) === 0 && this.#deps.settings().hours !== 0
                : choice !== 0;

        if (user.role !== "owner" && turnsOn) {
            throw new HttpError(403, "Only the owner can keep a session warm");
        }

        return choice;
    }

    /** Someone who can steer chooses for one session (`checkChoice`); the owner's caps bound every choice. */
    async setSession(user: User, id: ConversationId, choice: unknown): Promise<void> {
        await this.#deps.commitSession(id, (meta) => {
            // Checked against the choice in the same commit, so two requests at once cannot pass it together.
            const chosen = this.checkChoice(user, id, choice, meta.keepWarm);

            if (chosen === "default") {
                delete meta.keepWarm;
            } else {
                meta.keepWarm = chosen;
            }
        });
        this.#deps.keeper.reconsider();
    }

    #model(spec: string): Model<Api> | undefined {
        const slash = spec.indexOf("/");

        return slash > 0
            ? this.#deps.model(spec.slice(0, slash), spec.slice(slash + 1))
            : undefined;
    }

    /** What the settings window shows of a model before the owner's value: lifetime, read price, and Break-even's stop. */
    #known(model: Model<Api> | undefined): Known {
        if (model === undefined) {
            return {};
        }

        const seconds = model.promptCache?.[defaultTier()];
        const lifetime =
            seconds === undefined ? publishedLifetime(model.id) : Math.round(seconds / 60);
        const prices = this.facts(specOf(model)).prices;
        const breakEven = prices === undefined ? 0 : breakEvenRefreshes(prices);
        const listed = this.#published.lookup(model.id);
        const published = (model.cost.cacheRead > 0 ? model : listed)?.cost.cacheRead;

        return {
            ...(lifetime === undefined ? {} : { lifetime }),
            ...(published === undefined || published <= 0 ? {} : { read: published }),
            ...(breakEven > 0 ? { breakEven } : {}),
        };
    }

    /** One model's cache facts and its Break-even plan for the settings window, from the same `idlePlan` the keeper follows. */
    #row(spec: string, model: Model<Api> | undefined, settings: KeepWarmSettings): ModelRow {
        const known = this.#known(model);
        const lifetime = settings.models[spec]?.lifetime ?? known.lifetime;
        const plan = idlePlan(
            {
                session: 0,
                hours: "break-even",
                maxCost: settings.maxCost,
                maxRefreshes: settings.maxRefreshes,
                share: settings.share,
            },
            {
                ...this.facts(spec),
                ...(lifetime === undefined ? {} : { lifetimeMs: lifetime * 60_000 }),
            },
            undefined,
            0,
        );

        return {
            spec,
            name: model?.name ?? spec.slice(spec.indexOf("/") + 1),
            known,
            plan: {
                ...(lifetime === undefined ? {} : { lifetime }),
                ...(plan === undefined
                    ? {}
                    : {
                          everyMs: plan.everyMs,
                          refreshes: plan.maxRefreshes,
                          autoStopMs: plan.maxRefreshes * plan.everyMs,
                      }),
            },
        };
    }

    /** Every model people can pick, and every model the owner set values for, with what is known of each. */
    #rows(settings: KeepWarmSettings): ModelRow[] {
        const rows = new Map<string, ModelRow>();

        for (const model of this.#deps.availableModels()) {
            const spec = specOf(model);

            rows.set(spec, this.#row(spec, model, settings));
        }

        for (const spec of Object.keys(settings.models)) {
            if (!rows.has(spec)) {
                rows.set(spec, this.#row(spec, this.#model(spec), settings));
            }
        }

        return [...rows.values()];
    }
}
