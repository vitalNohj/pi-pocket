/**
 * The cache keeper: it re-sends the last model request with a one-token output cap just before its prompt cache entry
 * expires, so the next real request reads the cache instead of writing it again. Pi's own cache warmer
 * (`cache-warmer.ts` in pi-coding-agent) does this for Pi's CLI; Pi Durable has none. It has two modes.
 *
 * **During a run** (a tool wait), on by default: a request that ended in a tool call will be followed by another when
 * the tool ends, so the chance of a real request is high. At each refresh point: warm when
 * `hazard * missCost > warmCost`.
 *   - `warmCost`  a cache read of the whole prompt plus one output token.
 *   - `missCost`  what the next real request pays more if the entry is gone: a cache write instead of a read.
 *   - `hazard`    the chance that the run's next request comes in the next interval (`TOOL_HAZARD`).
 * A new real request, the run ending or being stopped (`runEnded`), an error, shutdown, or the age cap (`MAX_AGE_MS`,
 * 30 minutes) stops it. An entry whose first refresh would fall after the cap (the 1h tier) is never started.
 * The cap is the best of 10 to 60 minutes on the owner's own tool-call gaps, and it bounds the loss when a tool waits
 * on a person (an approval).
 *
 * **Keep warm** (idle), off until the owner turns it on (`idlePolicy`): after a run ends, it refreshes the cache of the
 * run's last request every `everyMs` (a share of the model's cache lifetime), for
 * as long as the owner's time limit, or with Auto until the refreshes have cost as much as one more cache write
 * (`breakEvenRefreshes`), within a cost and a refresh cap for each session. A new run (`runStarted`), a model change,
 * a compaction, New context, archiving (`forget`), the setting turned off (`reconsider`), or two failed refreshes in a
 * row stop it. A refresh fails when it errs, or when it wrote the cache instead of reading it: the cache
 * was gone, so the interval is too long for that model. Idle warming has no price check: the owner chose to pay, and
 * the caps bound it. Its entries are saved (`IdleStore`), so warming goes on after a restart while the cache lives.
 *
 * `install` wraps `models.streamSimple` in place, as `timing.ts` and `limit-gate.ts` do. The warm request goes to the
 * wrapped function, so it is not recorded as a real request. `PI_POCKET_CACHE_KEEPER=off` turns both modes off.
 */
import { createHash } from "node:crypto";
import {
    IDLE_FAILURES,
    type IdlePlan,
    type IdlePolicy,
    idlePlan,
    type ModelFacts,
} from "./idle-plan.ts";
import { type IdleRecord, type IdleStore, savedOptions } from "./keep-warm-store.ts";
import { cacheTier } from "./model-cache-facts.ts";
import { noWait } from "./limit-gate.ts";
import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Model,
    SimpleStreamOptions,
    TranscriptContext,
} from "@earendil-works/pi-ai";

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const FINAL_PAYLOAD = Symbol("cache-keeper-final-payload");

type ObservedOptions = SimpleStreamOptions & { [FINAL_PAYLOAD]?: (payload: unknown) => void };

/** Hash the JSON sent to the provider. Only provider output-cap fields may differ on a warm. */
function payloadHash(payload: unknown): string {
    const caps = new Set(
        [
            ["max_tokens"],
            ["max_completion_tokens"],
            ["max_output_tokens"],
            ["maxTokens"],
            ["options", "maxTokens"],
            ["config", "maxOutputTokens"],
            ["inferenceConfig", "maxTokens"],
            ["generationConfig", "maxOutputTokens"],
        ].map((path) => JSON.stringify(path)),
    );

    const canonical = (value: unknown, path: string[] = []): unknown => {
        if (Array.isArray(value)) {
            return value.map((item, index) => canonical(item, [...path, String(index)]));
        }

        if (value !== null && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .flatMap(([key, item]) => {
                        const next = [...path, key];

                        return caps.has(JSON.stringify(next)) ? [] : [[key, canonical(item, next)]];
                    }),
            );
        }

        return value;
    };

    // Match wire JSON semantics (undefined fields, toJSON), without retaining another prompt copy.
    return createHash("sha256")
        .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(payload)))))
        .digest("hex");
}

/** Refresh at 90% of the lifetime, and never closer than 10 seconds to its end. */
export function refreshDelayMs(ttlMs: number): number | undefined {
    return ttlMs <= 10_000
        ? undefined
        : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Warming never goes on past this long after the real request that started it. */
export const MAX_AGE_MS = 30 * 60_000;
/** Chance of a real request in the next interval after a tool call: the run goes on when the tool ends. */
export const TOOL_HAZARD = 0.9;

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Decision = {
    action: "warm" | "stop";
    warmCost: number;
    missCost: number;
    hazard: number;
    expectedSavings: number;
};

/** Dollars. `rates` are per million tokens, as `Model.cost` is. */
export function decide(input: {
    promptTokens: number;
    rates: Rates;
    /** What a cache write costs per million tokens for the tier in use (the 1h tier costs more than the 5m tier). */
    writeRate: number;
    hazard: number;
}): Decision {
    const { promptTokens, rates, writeRate, hazard } = input;
    const warmCost = (promptTokens * rates.cacheRead + rates.output) / 1e6;
    const missCost = (promptTokens * (writeRate - rates.cacheRead)) / 1e6;
    const expectedSavings = hazard * missCost - warmCost;

    return {
        action: expectedSavings > 0 ? "warm" : "stop",
        warmCost,
        missCost,
        hazard,
        expectedSavings,
    };
}

/** Whether a one-token replay leaves the cache entry alone: budget-based thinking would change `budget_tokens`. */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
    if (!options?.reasoning || model.api !== "anthropic-messages") {
        return true;
    }

    return (
        (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking ===
        true
    );
}

/** The model's cache lifetime for the tier in use, as its `promptCache` says; undefined when not known or not cached. */
function ttlMsOf(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
    const retention = cacheTier(options);

    if (retention === "none") {
        return undefined;
    }

    const seconds = model.promptCache?.[retention];

    return seconds === undefined ? undefined : seconds * 1000;
}

/** `provider/modelId`, the name the owner's per-model values use. */
export function specOf(model: { provider: string; id: string }): string {
    return `${model.provider}/${model.id}`;
}

/** The request's options as a replay may repeat them: its abort signal and telemetry belong to the real request. */
function replayOptions(options: SimpleStreamOptions): SimpleStreamOptions {
    const {
        signal: _signal,
        telemetry: _telemetry,
        ...rest
    } = options as SimpleStreamOptions & { telemetry?: unknown };

    return rest;
}

/** How long one idle refresh may take before it is given up. */
const IDLE_DEADLINE_MS = 5 * 60_000;
/** A refresh that erred is tried again this much later, while the cache lives. */
const IDLE_RETRY_MS = 30_000;

type IdleState = IdlePlan & { failures: number };

type Entry = {
    /** `tool`: a run waits on a tool. `parked`: the run's last request, kept until the run ends. `idle`: kept warm. */
    kind: "tool" | "parked" | "idle";
    model: Model<Api>;
    context: TranscriptContext;
    options: SimpleStreamOptions;
    promptTokens: number;
    ttlMs?: number;
    payloadHash: string;
    /** The conversation this session belongs to, once known. */
    conversationId?: number;
    warms: number;
    spent: number;
    /** When the real request ended; the tool-wait age cap counts from here, not from a refresh. */
    endedAt: number;
    /** The last time a request read or wrote this cache entry. */
    lastTouch: number;
    /** When the next refresh should go out; a refresh later than the slack after it would pay a full rewrite. */
    dueAt: number;
    timer?: ReturnType<typeof setTimeout>;
    abort?: AbortController;
    deadline?: ReturnType<typeof setTimeout>;
    account?: WarmAccount;
    idle?: IdleState;
    /** Dropped at shutdown but kept on disk: a refresh on its way still saves what it counted. */
    keptSaved?: boolean;
};

/** A real request on its way: `seq` orders it against stops (`forget`), and the lookup fills in its conversation. */
type PendingRequest = { seq: number; conversationId?: number };

type WarmAccount = {
    /** Check the captured payer's current spend limits immediately before each warm; `idle` allows a run that ended. */
    check: (idle: boolean) => boolean;
    /** Count even failed, aborted, or superseded responses when the provider reports usage. */
    recordUsage: (message: AssistantMessage) => Promise<void>;
};

export type KeeperStatus = { warming: number; warms: number; spent: number };
/** One conversation's idle warming, for the app. */
export type IdleStatus =
    | {
          warm: true;
          nextAt: number;
          everyMs: number;
          lifeMs: number;
          until?: number;
          refreshes: number;
          /** The refreshes this stretch may have: Auto's break-even, or the owner's cap. */
          maxRefreshes: number;
          spent: number;
          model: string;
      }
    | { warm: false; stopped?: string; at?: number };

export type KeeperDeps = {
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    log?: (line: string) => void;
    /** The conversation that sends requests under a provider session id, so `runEnded` can find its warm. */
    conversationOf?: (sessionId: string) => Promise<number | undefined>;
    /** Whether a conversation is in a run now. */
    isRunning?: (conversationId: number) => boolean;
    /** Capture who pays for this run, with its spend check and usage recorder. */
    accountFor?: (conversationId: number) => WarmAccount | undefined;
    /** True turns the keeper off. Read at each decision. */
    disabled?: () => boolean;
    /** Whether, and how, a conversation is kept warm once its run ends; undefined: it is not. */
    idlePolicy?: (conversationId: number) => IdlePolicy | undefined;
    /** What is known of a model (`provider/modelId`): its cache lifetime and published cache prices. */
    modelFacts?: (spec: string) => ModelFacts;
    /** A model by provider and id, to warm a saved entry after a restart. */
    modelOf?: (provider: string, modelId: string) => Model<Api> | undefined;
    /** Where idle entries are kept between restarts. */
    store?: IdleStore;
    /** Idle warming of a conversation started, refreshed, or stopped (`idleStatus` says why it stopped). */
    changed?: (conversationId: number) => void;
};

type OptionalDeps =
    | "conversationOf"
    | "isRunning"
    | "accountFor"
    | "idlePolicy"
    | "modelFacts"
    | "modelOf"
    | "store"
    | "changed";

export class CacheKeeper {
    readonly #deps: Required<Omit<KeeperDeps, OptionalDeps>> & Pick<KeeperDeps, OptionalDeps>;
    readonly #entries = new Map<string, Entry>();
    readonly #requests = new Map<string, PendingRequest>();
    readonly #pending = new Set<Promise<void>>();
    /** Why idle warming last stopped, by conversation, while nothing warms it. */
    readonly #stopped = new Map<number, { reason: string; at: number }>();
    /**
     * What the conversations of a session that stopped warming in its idle stretch spent, so a stop does not reset the
     * session's cost cap. A new run in the session ends the stretch (`runStarted`).
     */
    readonly #sessionStopped = new Map<number, number>();
    /** Counts requests and stops, so that each can tell which came first. */
    #seq = 0;
    /**
     * When each conversation's cache last stopped counting (`forget`: another model or context, archived; `runStarted`):
     * a request that began before it, or an entry saved before the restart, is never kept warm.
     */
    readonly #invalidated = new Map<number, number>();
    #underlying: StreamSimple | undefined;
    #closed = false;
    #warms = 0;
    #spent = 0;

    constructor(deps: KeeperDeps = {}) {
        this.#deps = {
            now: Date.now,
            setTimer: (fn, ms) => {
                const timer = setTimeout(fn, ms);

                timer.unref();

                return timer;
            },
            clearTimer: clearTimeout,
            log: () => {},
            disabled: () => process.env.PI_POCKET_CACHE_KEEPER === "off",
            ...deps,
        };
    }

    status(): KeeperStatus {
        let warming = 0;

        for (const entry of this.#entries.values()) {
            if (entry.kind !== "parked") {
                warming++;
            }
        }

        return { warming, warms: this.#warms, spent: this.#spent };
    }

    /** Idle warming now: how many conversations, and their refreshes and spend in this stretch. */
    idleSummary(): { warm: number; refreshes: number; spent: number } {
        let warm = 0;
        let refreshes = 0;
        let spent = 0;

        for (const entry of this.#entries.values()) {
            if (entry.kind === "idle") {
                warm++;
                refreshes += entry.warms;
                spent += entry.spent;
            }
        }

        return { warm, refreshes, spent };
    }

    /** One conversation's idle warming: when the next refresh goes out, or why it last stopped. */
    idleStatus(conversationId: number): IdleStatus {
        for (const entry of this.#entries.values()) {
            if (entry.kind === "idle" && entry.conversationId === conversationId && entry.idle) {
                return {
                    warm: true,
                    nextAt: entry.dueAt,
                    everyMs: entry.idle.everyMs,
                    lifeMs: entry.idle.lifeMs,
                    ...(entry.idle.until === undefined ? {} : { until: entry.idle.until }),
                    refreshes: entry.warms,
                    maxRefreshes: entry.idle.maxRefreshes,
                    spent: entry.spent,
                    model: specOf(entry.model),
                };
            }
        }

        const stopped = this.#stopped.get(conversationId);

        return stopped === undefined
            ? { warm: false }
            : { warm: false, stopped: stopped.reason, at: stopped.at };
    }

    /** Shutdown: no warm goes out after this. Idle entries stay saved, so the next start goes on warming them. */
    async close(): Promise<void> {
        this.#closed = true;
        this.#requests.clear();

        for (const key of [...this.#entries.keys()]) {
            this.#drop(key, undefined, true);
        }

        // Keep the usage listener and storage open until aborted responses have been counted.
        await Promise.allSettled([...this.#pending]);
        await this.#deps.store?.flush();
    }

    /** Install before request shaping, so this callback sees its final output at the adapter boundary. */
    installPayloadObserver(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        models.streamSimple = (model, context, options) => {
            const observe = (options as ObservedOptions | undefined)?.[FINAL_PAYLOAD];

            if (observe === undefined) {
                return underlying(model, context, options);
            }

            return underlying(model, context, {
                ...options,
                onPayload: async (payload, payloadModel) => {
                    const shaped = await options?.onPayload?.(payload, payloadModel);

                    observe(shaped === undefined ? payload : shaped);

                    return shaped;
                },
            });
        };
    }

    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        this.#underlying = underlying;
        models.streamSimple = (model, context, options) =>
            this.#stream(underlying, model, context, options);
    }

    #stream(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
    ): AssistantMessageEventStream {
        const key = options?.sessionId;
        const facts = this.#deps.modelFacts?.(specOf(model)) ?? {};
        // The owner or the maker's docs may know a lifetime for a model whose `promptCache` says nothing.
        const known = ttlMsOf(model, options) !== undefined || facts.lifetimeMs !== undefined;

        // Uncached calls (a compaction's, a model with no known lifetime) leave an existing entry alone.
        if (key === undefined || cacheTier(options) === "none" || !known) {
            return underlying(model, context, options);
        }

        const eligible = !this.#closed && !this.#deps.disabled() && isReplayable(model, options);
        let fingerprint: string | undefined;
        const observed: ObservedOptions = {
            ...options,
            [FINAL_PAYLOAD]: (payload) => {
                try {
                    fingerprint = payloadHash(payload);
                } catch {
                    // A payload we cannot compare can serve the real request, but must never be warmed.
                    fingerprint = undefined;
                }
            },
        };
        const stream = underlying(model, context, eligible ? observed : options);

        // A real request that writes the cache replaces the entry, so stop warming the old one.
        this.#drop(key);
        const request: PendingRequest = { seq: ++this.#seq };

        this.#requests.set(key, request);
        void this.#deps.conversationOf?.(key).then(
            (id) => {
                if (id !== undefined) {
                    request.conversationId = id;
                }
            },
            () => {},
        );
        void stream.result().then(
            (message) => {
                if (this.#requests.get(key) !== request) {
                    return;
                }

                this.#requests.delete(key);
                this.#onSettled(key, model, context, options, message, fingerprint, request);
            },
            () => {
                if (this.#requests.get(key) === request) {
                    this.#requests.delete(key);
                }
            },
        );

        return stream;
    }

    /** Whether a request that began at `seq` still counts for this conversation: no stop came after it began. */
    #current(conversationId: number, seq: number): boolean {
        return (this.#invalidated.get(conversationId) ?? 0) < seq;
    }

    #invalidate(conversationId: number): void {
        this.#invalidated.set(conversationId, ++this.#seq);
    }

    #onSettled(
        key: string,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        message: AssistantMessage,
        fingerprint: string | undefined,
        request: PendingRequest,
    ): void {
        const finished =
            message.stopReason === "toolUse" ||
            message.stopReason === "stop" ||
            message.stopReason === "length";

        if (!finished || options === undefined || fingerprint === undefined) {
            return;
        }

        if (this.#closed || this.#deps.disabled() || !isReplayable(model, options)) {
            return;
        }

        if (
            request.conversationId !== undefined &&
            !this.#current(request.conversationId, request.seq)
        ) {
            return;
        }

        const ttlMs = ttlMsOf(model, options);
        const usage = message.usage;
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        const delay = ttlMs === undefined ? undefined : refreshDelayMs(ttlMs);

        if (promptTokens === 0) {
            return;
        }

        // A tool wait is warmed when its first refresh falls inside the cap: a longer cache outlives any wait it allows.
        const tool = message.stopReason === "toolUse" && delay !== undefined && delay < MAX_AGE_MS;

        // The run's last request is parked for keep warm only when its conversation has a policy now, or is not known
        // yet; `#toIdle` asks again when the run ends.
        if (
            !tool &&
            (this.#deps.idlePolicy === undefined ||
                (request.conversationId !== undefined &&
                    this.#deps.idlePolicy(request.conversationId) === undefined))
        ) {
            return;
        }

        const now = this.#deps.now();
        const entry: Entry = {
            kind: tool ? "tool" : "parked",
            model,
            context,
            options,
            promptTokens,
            ...(ttlMs === undefined ? {} : { ttlMs }),
            payloadHash: fingerprint,
            ...(request.conversationId === undefined
                ? {}
                : { conversationId: request.conversationId }),
            endedAt: now,
            lastTouch: now,
            dueAt: now + (delay ?? 0),
            warms: 0,
            spent: 0,
        };

        this.#entries.set(key, entry);

        if (tool) {
            this.#schedule(key, entry, delay);
        }

        const known = (id: number) => {
            // A stop came for this conversation while the request was on its way: its cache is not the one used next.
            if (!this.#current(id, request.seq)) {
                return this.#drop(key);
            }

            entry.conversationId = id;
            entry.account = this.#deps.accountFor?.(id);

            // The run ended before the lookup came back: its end was missed.
            if (this.#deps.isRunning?.(id) === false) {
                this.#toIdle(key, entry);
            }
        };

        if (entry.conversationId !== undefined) {
            known(entry.conversationId);

            return;
        }

        // Which conversation it is, so that the run's end can stop it. A tool wait still warms when this is not known.
        void this.#deps.conversationOf?.(key).then(
            (id) => {
                if (id !== undefined && this.#entries.get(key) === entry) {
                    known(id);
                }
            },
            () => {},
        );
    }

    /** A run ended or was stopped: no request follows its last tool call. Its last request may be kept warm. */
    runEnded(conversationId: number): void {
        // An unresolved lookup cannot prove which run owns the request. Discard it rather than charge a later run.
        for (const [key, request] of this.#requests) {
            if (request.conversationId === undefined || request.conversationId === conversationId) {
                this.#requests.delete(key);
            }
        }

        for (const [key, entry] of [...this.#entries]) {
            if (
                entry.kind !== "idle" &&
                (entry.conversationId === undefined || entry.conversationId === conversationId)
            ) {
                this.#toIdle(key, entry);
            }
        }
    }

    /** A run started: its own requests take over the cache, so the idle warming stops, with nothing to report. */
    runStarted(conversationId: number): void {
        this.#stopped.delete(conversationId);

        for (const [key, entry] of [...this.#entries]) {
            if (entry.kind === "idle" && entry.conversationId === conversationId) {
                this.#drop(key);
            }
        }

        // A session's new run ends its idle stretch: the next one starts its cost cap from nothing.
        this.#sessionStopped.delete(conversationId);
    }

    /**
     * Stop warming a conversation: its next request differs (another model, a compaction, New context), it was
     * archived, or its session no longer wants it.
     */
    forget(conversationId: number, reason: string): void {
        this.#invalidate(conversationId);

        for (const [key, entry] of [...this.#entries]) {
            if (entry.conversationId === conversationId) {
                this.#drop(key, entry.kind === "idle" ? reason : undefined);
            }
        }
    }

    /** The owner's settings or a session's choice changed: each idle entry follows them now. */
    reconsider(): void {
        for (const [key, entry] of [...this.#entries]) {
            if (entry.kind !== "idle" || entry.idle === undefined) {
                continue;
            }

            const plan = this.#plan(entry, entry.idle.since);

            if (plan === undefined) {
                this.#drop(key, "turned off");
                continue;
            }

            // Auto and Off have no deadline: one left from a time limit must not stay.
            delete entry.idle.until;
            Object.assign(entry.idle, plan);

            // A refresh on its way plans the next itself.
            if (entry.abort === undefined) {
                this.#scheduleIdle(key, entry);
            }

            this.#deps.changed?.(entry.conversationId!);
        }
    }

    /** Go on warming the idle entries saved before a restart, while their caches live. */
    async restore(): Promise<void> {
        const store = this.#deps.store;

        if (store === undefined) {
            return;
        }

        const began = ++this.#seq;

        for (const record of await store.load()) {
            // The provider session id must still be this conversation's: a record never warms another's context.
            const owner = await this.#deps.conversationOf?.(record.key).catch(() => undefined);
            const model = this.#deps.modelOf?.(record.provider, record.modelId);

            if (
                owner !== record.conversationId ||
                // Another model, a new context, or archiving came while the saved entries were loading.
                !this.#current(record.conversationId, began) ||
                this.#closed ||
                this.#deps.disabled() ||
                model === undefined ||
                // Its run goes on after the restart: that run's requests touch the cache.
                this.#deps.isRunning?.(record.conversationId) === true ||
                this.#entries.has(record.key)
            ) {
                if (!this.#entries.has(record.key)) {
                    store.delete(record.key);
                }

                continue;
            }

            const entry: Entry = {
                kind: "parked",
                model,
                context: { messages: record.messages } as unknown as TranscriptContext,
                options: record.options as SimpleStreamOptions,
                promptTokens: record.promptTokens,
                ...(record.ttlMs === undefined ? {} : { ttlMs: record.ttlMs }),
                payloadHash: record.payloadHash,
                conversationId: record.conversationId,
                endedAt: record.since,
                lastTouch: record.lastTouch,
                dueAt: record.lastTouch,
                warms: record.warms,
                spent: record.spent,
                account: this.#deps.accountFor?.(record.conversationId),
            };

            this.#entries.set(record.key, entry);
            this.#toIdle(record.key, entry, { since: record.since, failures: record.failures });
        }
    }

    /**
     * How an entry is kept warm now, from the owner's settings and the session's choice: how often, how long its cache
     * lives, and when it stops. Undefined: it is not kept warm (off, or nothing says how often to refresh it).
     */
    #plan(entry: Entry, since: number): IdlePlan | undefined {
        const policy =
            entry.conversationId === undefined || this.#closed || this.#deps.disabled()
                ? undefined
                : this.#deps.idlePolicy?.(entry.conversationId);

        return policy === undefined
            ? undefined
            : idlePlan(
                  policy,
                  this.#deps.modelFacts?.(specOf(entry.model)) ?? {},
                  entry.ttlMs,
                  since,
              );
    }

    /** Plan the next idle refresh, `everyMs` after a request last touched the cache. */
    #scheduleIdle(key: string, entry: Entry): void {
        this.#schedule(
            key,
            entry,
            Math.max(1, entry.lastTouch + entry.idle!.everyMs - this.#deps.now()),
        );
    }

    /** The run is over: keep its last request warm when the owner wants that, else stop. */
    #toIdle(key: string, entry: Entry, saved?: { since: number; failures: number }): void {
        const conversationId = entry.conversationId;
        const now = this.#deps.now();
        const plan = this.#plan(entry, saved?.since ?? now);

        // A saved entry that is not warmed again is deleted, so the next start does not find it.
        const stop = (reason?: string) => {
            this.#drop(key, reason);

            if (saved !== undefined) {
                this.#deps.store?.delete(key);
            }
        };

        if (plan === undefined || conversationId === undefined) {
            return stop();
        }

        const idle: IdleState = { ...plan, failures: saved?.failures ?? 0 };

        // The cache is gone already (a long restart): a refresh would only write it again.
        if (now >= entry.lastTouch + idle.lifeMs - 10_000) {
            return stop(saved === undefined ? undefined : "the cache expired during a restart");
        }

        if (saved === undefined) {
            entry.warms = 0;
            entry.spent = 0;
        }

        entry.kind = "idle";
        entry.idle = idle;
        entry.account ??= this.#deps.accountFor?.(conversationId);
        this.#stopped.delete(conversationId);

        // A tool-wait refresh on its way plans the next itself, as an idle one, when it settles.
        if (entry.abort === undefined) {
            this.#scheduleIdle(key, entry);
        }

        this.#save(key, entry, true);
        this.#deps.changed?.(conversationId);
    }

    #save(key: string, entry: Entry, withContext: boolean): void {
        const store = this.#deps.store;

        if (store === undefined || entry.idle === undefined || entry.conversationId === undefined) {
            return;
        }

        store.save(
            {
                version: 1,
                key,
                conversationId: entry.conversationId,
                provider: entry.model.provider,
                modelId: entry.model.id,
                messages: withContext ? entry.context.messages : [],
                // Only what JSON keeps: a replay that differs because of a lost field fails the payload check.
                options: savedOptions(
                    JSON.parse(JSON.stringify(replayOptions(entry.options))) as Record<
                        string,
                        unknown
                    >,
                ),
                promptTokens: entry.promptTokens,
                ...(entry.ttlMs === undefined ? {} : { ttlMs: entry.ttlMs }),
                payloadHash: entry.payloadHash,
                lastTouch: entry.lastTouch,
                since: entry.idle.since,
                warms: entry.warms,
                spent: entry.spent,
                failures: entry.idle.failures,
            } satisfies IdleRecord,
            withContext,
        );
    }

    #schedule(key: string, entry: Entry, delay: number | undefined): void {
        const wait = delay ?? 0;
        const now = this.#deps.now();
        const cap =
            entry.kind === "idle"
                ? entry.idle?.until === undefined
                    ? wait
                    : Math.max(0, entry.idle.until - now)
                : Math.max(0, entry.endedAt + MAX_AGE_MS - now);

        // One timer per entry: a new plan replaces the one before.
        if (entry.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
        }

        entry.dueAt = now + wait;
        entry.timer = this.#deps.setTimer(
            () => {
                const pending = this.#tick(key, entry);

                this.#pending.add(pending);
                void pending.finally(() => this.#pending.delete(pending));
            },
            Math.min(wait, cap),
        );
    }

    #decision(entry: Entry): Decision {
        // Only the 5m tier is ever warmed during a tool wait (see `#onSettled`), at the model's `cacheWrite` price.
        const writeRate = entry.model.cost.cacheWrite || entry.model.cost.input;

        return decide({
            promptTokens: entry.promptTokens,
            rates: entry.model.cost,
            writeRate,
            hazard: TOOL_HAZARD,
        });
    }

    /** What a session's idle stretch has cost: its conversations warm now, and those that stopped since it began. */
    #sessionSpent(session: number): number {
        let spent = this.#sessionStopped.get(session) ?? 0;

        for (const entry of this.#entries.values()) {
            if (entry.kind === "idle" && entry.idle?.session === session) {
                spent += entry.spent;
            }
        }

        return spent;
    }

    /** Why an idle entry may not refresh now; undefined: it may. */
    #idleStop(entry: Entry, now: number): string | undefined {
        const idle = entry.idle!;
        const slack = Math.max((idle.lifeMs - idle.everyMs) / 2, 60_000);

        if (now > entry.dueAt + slack || now >= entry.lastTouch + idle.lifeMs) {
            return "the refresh came too late (the server was busy or asleep)";
        }

        if (idle.until !== undefined && now >= idle.until) {
            return "the time limit was reached";
        }

        if (entry.warms >= idle.maxRefreshes) {
            return idle.breakEven
                ? "Auto: more refreshes would cost more than writing the cache again"
                : "the refresh cap was reached";
        }

        // The session's whole idle stretch counts (its subagents' too), and the next refresh at its worst: a cache that
        // is gone is written again in full. So the cap is never passed.
        const rates = entry.model.cost;
        const worst =
            (entry.promptTokens * Math.max(rates.cacheWrite, rates.input, rates.cacheRead) +
                rates.output) /
            1_000_000;

        if (idle.maxCost > 0 && this.#sessionSpent(idle.session) + worst > idle.maxCost) {
            return "the cost cap was reached";
        }

        if (
            entry.conversationId === undefined ||
            this.#deps.idlePolicy?.(entry.conversationId) === undefined
        ) {
            return "turned off";
        }

        if (
            (this.#deps.accountFor !== undefined && entry.account === undefined) ||
            entry.account?.check(true) === false
        ) {
            return "a spend limit was reached";
        }

        return undefined;
    }

    async #tick(key: string, entry: Entry): Promise<void> {
        if (this.#entries.get(key) !== entry) {
            return;
        }

        const now = this.#deps.now();
        const idle = entry.kind === "idle" ? entry.idle : undefined;
        // An idle entry's stop is reported; a tool wait's is not. A run can end while this refresh is on its way.
        const why = (reason: string) => (entry.kind === "idle" ? reason : undefined);

        if (this.#deps.disabled()) {
            return this.#drop(key, why("turned off"));
        }

        let delay = 0;

        if (idle !== undefined) {
            const stop = this.#idleStop(entry, now);

            if (stop !== undefined) {
                return this.#drop(key, stop);
            }
        } else {
            delay = refreshDelayMs(entry.ttlMs!) as number;
            // A timer that fired late (the machine slept) would send its refresh after the entry expired.
            const slack = (entry.ttlMs! - delay) / 2;

            if (now - entry.endedAt >= MAX_AGE_MS || now > entry.dueAt + slack) {
                return this.#drop(key);
            }

            if (
                this.#decision(entry).action === "stop" ||
                (this.#deps.accountFor !== undefined && entry.account === undefined) ||
                entry.account?.check(false) === false
            ) {
                return this.#drop(key);
            }
        }

        const abort = new AbortController();

        entry.abort = abort;
        entry.deadline = this.#deps.setTimer(
            () => {
                if (this.#entries.get(key) === entry) {
                    this.#drop(key, why("a refresh did not finish"));
                }
            },
            idle === undefined ? entry.endedAt + MAX_AGE_MS - now : IDLE_DEADLINE_MS,
        );

        let rejected = true;
        const options: ObservedOptions = {
            ...replayOptions(entry.options),
            maxTokens: 1,
            maxRetries: 0,
            signal: abort.signal,
            [FINAL_PAYLOAD]: (payload) => {
                rejected = true;
                abort.signal.throwIfAborted();

                // The last moment before it is sent: an idle session archived or turned off meanwhile is not refreshed.
                if (
                    entry.kind === "idle" &&
                    (entry.conversationId === undefined ||
                        this.#deps.idlePolicy?.(entry.conversationId) === undefined)
                ) {
                    if (this.#entries.get(key) === entry) {
                        this.#drop(key, "turned off");
                    }

                    throw new Error("Keep warm was turned off for this session.");
                }

                let matches = false;

                try {
                    matches = payloadHash(payload) === entry.payloadHash;
                } catch {
                    // Fail closed when the shaped payload no longer has a comparable JSON representation.
                }

                if (!matches) {
                    if (this.#entries.get(key) === entry) {
                        this.#drop(key, why("the request changed, so it could not be repeated"));
                    }

                    // This callback runs after all shapers, outside their error handlers, before transmission.
                    throw new Error("The warm payload differs from the cached request.");
                }

                rejected = false;
            },
        };

        try {
            // `noWait`: a warm request that meets a limit fails; it must not queue behind the limit gate.
            const stream = (this.#underlying as StreamSimple)(
                entry.model,
                entry.context,
                noWait(options),
            );
            const message = await stream.result();

            if (rejected) {
                if (this.#entries.get(key) === entry) {
                    this.#drop(key, why("a refresh could not be sent"));
                }

                return;
            }

            // A request can cost money even when a new request or Stop superseded it.
            await entry.account?.recordUsage(message);
            this.#warms++;
            this.#spent += message.usage.cost.total;
            entry.warms++;
            entry.spent += message.usage.cost.total;

            if (this.#entries.get(key) !== entry) {
                // Shutdown came while it was on its way: the next start must count this refresh against the caps.
                if (entry.keptSaved === true) {
                    this.#save(key, entry, false);
                }

                return;
            }

            const failed = message.stopReason === "error" || message.stopReason === "aborted";

            entry.abort = undefined;

            // The run ended while a tool-wait refresh was on its way: it counts as the entry's first idle refresh.
            if (entry.kind === "idle") {
                return this.#idleAfter(key, entry, entry.idle!, message, failed);
            }

            if (failed) {
                return this.#drop(key);
            }

            // The refresh read the cache, so it lives from now: keep warm, when the run ends, counts from here.
            entry.lastTouch = now;

            return this.#schedule(key, entry, delay);
        } catch (error) {
            this.#deps.log(
                `Cache keeper stopped for a session: ${error instanceof Error ? error.message : String(error)}`,
            );

            if (this.#entries.get(key) === entry) {
                this.#drop(key, why("a refresh failed"));
            }
        } finally {
            if (entry.deadline !== undefined) {
                this.#deps.clearTimer(entry.deadline);
                entry.deadline = undefined;
            }
        }
    }

    /** After an idle refresh: count a failure (an error, or a cache write: the cache was gone), and plan the next. */
    #idleAfter(
        key: string,
        entry: Entry,
        idle: IdleState,
        message: AssistantMessage,
        failed: boolean,
    ): void {
        const now = this.#deps.now();
        const usage = message.usage;
        // It read nothing of a prompt it was billed for: the cache had expired, so this interval is too long for the
        // model. Anthropic reports the write; OpenAI and xAI bill the miss as plain input. No usage at all says nothing.
        const rewrote = !failed && usage.cacheRead === 0 && usage.cacheWrite + usage.input > 0;

        if (!failed && !rewrote) {
            idle.failures = 0;
            entry.lastTouch = now;
            this.#schedule(key, entry, idle.everyMs);
            this.#save(key, entry, false);
            this.#deps.changed?.(entry.conversationId!);

            return;
        }

        idle.failures++;

        if (idle.failures >= IDLE_FAILURES) {
            return this.#drop(
                key,
                rewrote
                    ? `the cache was already gone ${String(idle.failures)} times in a row: refresh this model more often`
                    : `${String(idle.failures)} refreshes in a row failed`,
            );
        }

        if (rewrote) {
            // The write made a new cache entry: it lives from now.
            entry.lastTouch = now;
            this.#schedule(key, entry, idle.everyMs);
        } else if (entry.lastTouch + idle.lifeMs - now > 2 * IDLE_RETRY_MS) {
            this.#schedule(key, entry, IDLE_RETRY_MS);
        } else {
            return this.#drop(key, "a refresh failed and the cache ran out");
        }

        this.#save(key, entry, false);
        this.#deps.changed?.(entry.conversationId!);
    }

    /** Stop warming one entry. `reason` (idle only) is kept for the app; `keepSaved` leaves it for the next start. */
    #drop(key: string, reason?: string, keepSaved = false): void {
        const entry = this.#entries.get(key);

        if (entry === undefined) {
            return;
        }

        if (entry.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
        }

        if (entry.deadline !== undefined) {
            this.#deps.clearTimer(entry.deadline);
        }

        // A diagnostic only: production requests also count in the conversation's usage and spend.
        if (entry.warms > 0) {
            this.#deps.log(
                `Cache keeper: ${String(entry.warms)} warm requests for ${entry.kind === "idle" ? "an idle session" : "one tool wait"}, $${entry.spent.toFixed(4)}${reason === undefined ? "" : ` (${reason})`}.`,
            );
        }

        entry.abort?.abort();
        this.#entries.delete(key);

        if (keepSaved) {
            entry.keptSaved = true;
        }

        // What it spent still counts against its session's cost cap for the rest of the stretch.
        if (entry.kind === "idle" && entry.idle !== undefined && !keepSaved && entry.spent > 0) {
            const session = entry.idle.session;

            this.#sessionStopped.set(
                session,
                (this.#sessionStopped.get(session) ?? 0) + entry.spent,
            );
        }

        if (entry.kind === "idle" && !keepSaved) {
            this.#deps.store?.delete(key);

            if (entry.conversationId !== undefined) {
                if (reason !== undefined) {
                    this.#stopped.set(entry.conversationId, { reason, at: this.#deps.now() });
                }

                this.#deps.changed?.(entry.conversationId);
            }
        }
    }
}
