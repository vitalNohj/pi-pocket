/**
 * Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, each session's own choice,
 * and what browsers see of both. The refreshes themselves are `cache-keeper.ts`'s.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { IdlePolicy, IdleStatus } from "./cache-keeper.ts";
import { KEEP_WARM_HOURS, type KeepWarmSettings, keepWarmFrom, type User } from "./config.ts";
import { SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

/** A session's choice: the owner's default, on with no time limit, or never. */
export type KeepWarmChoice = "default" | "on" | "off";

const CHOICES: readonly KeepWarmChoice[] = ["default", "on", "off"];

/** What the settings window lists for one model: its cache lifetime in seconds, when known. */
type ModelLifetime = { spec: string; name: string; lifetime?: number };

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

        const choice = meta.keepWarm ?? "default";
        const hours = choice === "on" ? null : settings.hours;

        if (choice === "off" || hours === 0) {
            return undefined;
        }

        return {
            hours,
            maxCost: settings.maxCost,
            maxRefreshes: settings.maxRefreshes,
            share: settings.share,
            minutes: settings.minutes,
        };
    }

    /** The owner's minutes for a model, whether or not anything is kept warm now. */
    minutes(spec: string): number | undefined {
        return this.#app.config.keepWarm.minutes[spec];
    }

    /** For a tab's hello: the owner's time limit, which the session row names as its default. */
    hello() {
        return { hours: this.#app.config.keepWarm.hours };
    }

    /** The settings window's: every setting, each model's known cache lifetime, and what is warm now. */
    overview(user: User) {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const settings = this.#app.config.keepWarm;

        return {
            settings,
            models: this.#lifetimes(settings),
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
            choice: meta.keepWarm ?? "default",
            status: this.#app.cacheKeeper.idleStatus(Number(id)),
        };
    }

    /** The owner changes some of the settings; the rest stay. Each warm session follows the new ones at once. */
    setSettings(user: User, patch: unknown): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
            throw new HttpError(400, "keepWarm must be an object of settings");
        }

        const asked = patch as Partial<Record<keyof KeepWarmSettings, unknown>>;
        const current = this.#app.config.keepWarm;
        const next: KeepWarmSettings = { ...current, minutes: { ...current.minutes } };

        if ("hours" in asked) {
            if (!KEEP_WARM_HOURS.includes(asked.hours as number | null)) {
                throw new HttpError(
                    400,
                    `hours must be one of ${KEEP_WARM_HOURS.map(String).join(", ")}`,
                );
            }

            next.hours = asked.hours as number | null;
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

        // Minutes by model: a number sets one, null takes it off so the model's lifetime decides again.
        if (asked.minutes !== undefined) {
            if (
                typeof asked.minutes !== "object" ||
                asked.minutes === null ||
                Array.isArray(asked.minutes)
            ) {
                throw new HttpError(
                    400,
                    "minutes must be an object of provider/modelId to minutes",
                );
            }

            for (const [spec, value] of Object.entries(asked.minutes as Record<string, unknown>)) {
                if (spec.indexOf("/") <= 0) {
                    throw new HttpError(400, `${spec} is not provider/modelId`);
                }

                if (value === null) {
                    delete next.minutes[spec];
                } else if (
                    typeof value === "number" &&
                    Number.isFinite(value) &&
                    value >= 0 &&
                    value <= 24 * 60
                ) {
                    next.minutes[spec] = Math.round(value);
                } else {
                    throw new HttpError(400, "Minutes must be a number from 0 to 1440, or null");
                }
            }
        }

        this.#app.config.keepWarm = keepWarmFrom(next);
        this.#app.cacheKeeper.reconsider();
    }

    /** Someone who can steer chooses for one session. Only the owner may lift the time limit: it spends the owner's money. */
    async setSession(user: User, id: ConversationId, choice: unknown): Promise<void> {
        if (typeof choice !== "string" || !CHOICES.includes(choice as KeepWarmChoice)) {
            throw new HttpError(400, `keepWarm must be one of ${CHOICES.join(", ")}`);
        }

        if (choice === "on" && user.role !== "owner") {
            throw new HttpError(403, "Only the owner can keep a session warm with no time limit");
        }

        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined || meta.pip !== undefined) {
                throw new HttpError(404, "Not a session");
            }

            if (choice === "default") {
                delete meta.keepWarm;
            } else {
                meta.keepWarm = choice as "on" | "off";
            }
        }, BACKGROUND_CONTEXT);
        this.#app.cacheKeeper.reconsider();
    }

    /** Every model people can pick, and every model the owner set minutes for, with its known cache lifetime. */
    #lifetimes(settings: KeepWarmSettings): ModelLifetime[] {
        const models = this.#app.models;
        const tier = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
        const rows = new Map<string, ModelLifetime>();

        for (const model of models.getAvailableSnapshot()) {
            const spec = `${model.provider}/${model.id}`;
            const lifetime = model.promptCache?.[tier];

            rows.set(spec, {
                spec,
                name: model.name,
                ...(lifetime === undefined ? {} : { lifetime }),
            });
        }

        for (const spec of Object.keys(settings.minutes)) {
            if (!rows.has(spec)) {
                const slash = spec.indexOf("/");
                const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
                const lifetime = model?.promptCache?.[tier];

                rows.set(spec, {
                    spec,
                    name: model?.name ?? spec.slice(slash + 1),
                    ...(lifetime === undefined ? {} : { lifetime }),
                });
            }
        }

        return [...rows.values()];
    }
}
