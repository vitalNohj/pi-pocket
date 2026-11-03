// The cache keeper with fake streams and a fake clock: when it warms, when it stops, and what it never does.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type Api,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { CacheKeeper, decide, MAX_AGE_MS, refreshDelayMs } from "../src/server/cache-keeper.ts";
import {
    breakEvenRefreshes,
    type IdlePolicy,
    idleEveryMs,
    type ModelFacts,
} from "../src/server/idle-plan.ts";
import type { IdleRecord, IdleStore } from "../src/server/keep-warm-store.ts";

// Claude Sonnet prices per million tokens, with a 5 minute cache.
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const model = {
    id: "m",
    provider: "anthropic",
    api: "anthropic-messages",
    cost: COST,
    promptCache: { short: 300, long: 3600 },
} as unknown as Model<Api>;

/** Bill each token type at the model's prices per million tokens. */
function billedUsage({ input = 10, output = 5, cacheRead = 50_000, cacheWrite = 0 } = {}) {
    const cost = {
        input: (input * COST.input) / 1_000_000,
        output: (output * COST.output) / 1_000_000,
        cacheRead: (cacheRead * COST.cacheRead) / 1_000_000,
        cacheWrite: (cacheWrite * COST.cacheWrite) / 1_000_000,
    };

    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
    };
}

const usage = billedUsage();

/** A model runtime plus a clock. `timers` are the keeper's pending timers; `advance` fires the next one. */
function rig(
    disabled = false,
    idle?: {
        policy?: IdlePolicy | (() => IdlePolicy | undefined);
        /** Provider session ids to conversations; default: a 1, b 2, s 3. */
        conversations?: Map<string, number>;
        facts?: ModelFacts | ((spec: string, tier?: "short" | "long") => ModelFacts);
        store?: IdleStore;
    },
) {
    let now = 1_000_000;
    let warmUsage = billedUsage({ output: 1 });
    let off = disabled;
    const timers: { at: number; fn: () => void }[] = [];
    let failNext = false;
    const ended = new Set<number>();
    const calls: { maxTokens?: number; maxRetries?: number }[] = [];
    let stopReason = "stop";
    /** Set: the next answer waits until it is called, before its payload is sent, or after (`holdSent`). */
    let hold: Promise<void> | undefined;
    let holdSent = false;
    const models = {
        streamSimple(m: Model<Api>, _c: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();

            calls.push({
                ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
                ...(options?.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
            });
            const message = {
                role: "assistant",
                content: [],
                api: m.api,
                provider: m.provider,
                model: m.id,
                usage: options?.maxTokens === 1 ? warmUsage : usage,
                stopReason: failNext && options?.maxTokens === 1 ? "error" : stopReason,
                timestamp: now,
            };

            const wait = hold;
            const sentFirst = holdSent;

            hold = undefined;
            holdSent = false;
            queueMicrotask(async () => {
                if (!sentFirst) {
                    await wait;
                }

                // As a provider does: a payload hook that throws, or an abort, ends the stream with an error.
                try {
                    await options?.onPayload?.({ model: m.id, max_tokens: options.maxTokens }, m);

                    if (sentFirst) {
                        await wait;
                    }

                    options?.signal?.throwIfAborted();
                } catch {
                    const aborted = options?.signal?.aborted === true;

                    stream.push({
                        type: "error",
                        reason: aborted ? "aborted" : "error",
                        error: { ...message, stopReason: aborted ? "aborted" : "error" },
                    } as never);

                    return;
                }

                stream.push({ type: "done", reason: "stop", message } as never);
            });

            return stream;
        },
    };
    const keeper = new CacheKeeper({
        now: () => now,
        conversationOf: async (sessionId) =>
            idle?.conversations?.get(sessionId) ?? { a: 1, b: 2, s: 3 }[sessionId],
        isRunning: (id) => !ended.has(id),
        disabled: () => off,
        ...(idle?.policy === undefined
            ? {}
            : {
                  idlePolicy: () =>
                      typeof idle.policy === "function" ? idle.policy() : idle.policy,
              }),
        ...(idle?.facts === undefined
            ? {}
            : {
                  modelFacts: (spec: string, tier?: "short" | "long") =>
                      typeof idle.facts === "function" ? idle.facts(spec, tier) : idle.facts!,
              }),
        ...(idle?.store === undefined ? {} : { store: idle.store, modelOf: () => model }),
        setTimer: ((fn: () => void, ms: number) => {
            const t = { at: now + ms, fn };

            timers.push(t);

            return t as never;
        }) as never,
        clearTimer: ((t: { fn: () => void }) => {
            const i = timers.indexOf(t as never);

            if (i >= 0) {
                timers.splice(i, 1);
            }
        }) as never,
    });

    keeper.installPayloadObserver(models);
    keeper.install(models);

    const send = async (
        sessionId: string | undefined,
        stop: string,
        cacheRetention: "short" | "long" | "none" = "short",
        signal?: AbortSignal,
    ) => {
        stopReason = stop;
        await models
            .streamSimple(model, { messages: [] } as never, {
                ...(sessionId === undefined ? {} : { sessionId }),
                cacheRetention,
                ...(signal === undefined ? {} : { signal }),
            })
            .result();
        await new Promise((r) => setImmediate(r));
    };

    const fireNext = () => {
        const next = timers.sort((a, b) => a.at - b.at)[0];

        assert.ok(next, "a timer is pending");
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
    };

    const advance = async () => {
        fireNext();
        await new Promise((r) => setTimeout(r, 5));
    };

    const drain = async (count: number) => {
        for (let i = 0; i < count && timers.length > 0; i++) {
            await advance();
        }
    };

    return {
        keeper,
        send,
        advance,
        drain,
        fireNext,
        calls,
        timers,
        setNow: (t: number) => {
            now = t;
        },
        now: () => now,
        setOff: (v: boolean) => {
            off = v;
        },
        failWarm: () => {
            failNext = true;
        },
        rewriteOnWarm: () => {
            warmUsage = billedUsage({ output: 1, cacheRead: 0, cacheWrite: 50_000 });
        },
        /** OpenAI and xAI: a miss is billed as plain input, with no cache write. */
        missOnWarm: () => {
            warmUsage = billedUsage({ input: 50_000, output: 1, cacheRead: 0 });
        },
        endRun: (id: number) => {
            ended.add(id);
        },
        startRun: (id: number) => {
            ended.delete(id);
        },
        /** The next stream answers only once the returned function is called. */
        holdNext: (sent = false) => {
            let release = () => {};

            holdSent = sent;
            hold = new Promise<void>((resolve) => {
                release = resolve;
            });

            return release;
        },
    };
}

test("break-even: a 5m write costs 12.5x a read, so a 0.9 hazard pays and a 0.05 one does not", () => {
    const at = (hazard: number) =>
        decide({ promptTokens: 50_000, rates: COST, writeRate: COST.cacheWrite, hazard }).action;

    assert.equal(at(0.05), "stop");
    assert.equal(at(0.9), "warm");
});

test("a small prompt is not worth a warm: the output token costs more than the saving", () => {
    assert.equal(
        decide({ promptTokens: 1, rates: COST, writeRate: COST.cacheWrite, hazard: 0.9 }).action,
        "stop",
    );
});

test("refresh delay is 90% of the lifetime, 10 seconds early at least", () => {
    assert.equal(refreshDelayMs(300_000), 270_000);
    assert.equal(refreshDelayMs(5_000), undefined);
});

test("a request that ended in a tool call is warmed, with a one-token cap and no retries", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 1);
    await r.advance();
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1]?.maxTokens, 1);
    assert.equal(r.calls[1]?.maxRetries, 0);
    assert.equal(r.keeper.status().warms, 1);
    assert.equal(r.timers.length, 1, "the next refresh is scheduled");
});

test("a finished answer is not warmed: an idle session costs about what it saves", async () => {
    const r = rig();

    await r.send("s", "stop");
    assert.equal(r.timers.length, 0);
});

test("a warm is not a real request: it never starts a warm of its own beyond the next refresh", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.advance();
    await r.advance();
    assert.equal(r.timers.length, 1, "one pending refresh, not one per warm");
    assert.equal(r.keeper.status().warming, 1);
});

test("a new real request replaces the pending warm", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 1, "one timer for the newest request, not two");
});

test("the run ending (a finished answer) stops the warm of its last tool call", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.send("s", "stop");
    assert.equal(r.timers.length, 0);
});

test("a request that does not use the cache leaves the pending warm alone", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.send("s", "stop", "none");
    assert.equal(r.timers.length, 1);
});

test("turned off: no warm starts, and a pending one is dropped when it fires", async () => {
    const off = rig(true);

    await off.send("s", "toolUse");
    assert.equal(off.timers.length, 0);

    const r = rig();

    await r.send("s", "toolUse");
    r.setOff(true);
    await r.advance();
    assert.equal(r.calls.length, 1, "only the real request");
    assert.equal(r.timers.length, 0);
});

test("a timer that fires long after its due time sends nothing", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    const timer = r.timers[0];

    assert.ok(timer);
    r.setNow(timer.at + 120_000); // slept through the refresh window; the entry is expired
    r.timers.splice(0, 1);
    timer.fn();
    await new Promise((x) => setTimeout(x, 5));
    assert.equal(r.calls.length, 1, "only the real request");
});

test("the age cap ends warming from the real request, not from the last warm", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    const start = r.now();

    await r.drain(40);

    assert.ok(r.now() - start < MAX_AGE_MS + 300_000, "it stopped near the cap");
    assert.equal(r.timers.length, 0);
    assert.ok(r.keeper.status().warms >= 5, "it did warm up to the cap");
});

test("close cancels every pending warm", async () => {
    const r = rig();

    await r.send("a", "toolUse");
    await r.send("b", "toolUse");
    assert.equal(r.timers.length, 2);
    r.keeper.close();
    assert.equal(r.timers.length, 0);
});

test("a request with no session id is never warmed", async () => {
    const r = rig();

    await r.send(undefined, "toolUse");
    assert.equal(r.timers.length, 0);
});

test("a warm that ends in an error stops warming that session", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    r.failWarm();
    await r.advance();
    assert.equal(r.timers.length, 0);
    assert.equal(r.keeper.status().warms, 1, "a failed response can still report billable usage");
});

test("a request that ends after close starts no new warm", async () => {
    const r = rig();

    r.keeper.close();
    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 0);
});

test("the end of a run stops its warm and leaves the warm of another conversation", async () => {
    const r = rig();

    await r.send("a", "toolUse");
    await r.send("b", "toolUse");
    await new Promise((x) => setImmediate(x)); // the conversation of each session is found
    r.keeper.runEnded(1);
    assert.equal(r.timers.length, 1);
    r.keeper.runEnded(2);
    assert.equal(r.timers.length, 0);
});

test("a signal that aborts after the request, as Durable's does when an invocation ends, does not stop the warm", async () => {
    const r = rig();
    const abort = new AbortController();

    await r.send("s", "toolUse", "short", abort.signal);
    abort.abort(new Error("invocation has ended"));
    assert.equal(r.timers.length, 1);
    await r.advance();
    assert.equal(r.keeper.status().warms, 1);
});

test("a one hour cache is never warmed: a 30 minute tool wait does not outlive it", async () => {
    const r = rig();

    await r.send("s", "toolUse", "long");
    assert.equal(r.timers.length, 0);
});

test("a tool that waits for a person is bounded by the cap: about six warms, not more", async () => {
    const r = rig();

    await r.send("s", "toolUse");

    await r.drain(40);

    assert.ok(
        r.keeper.status().warms >= 5 && r.keeper.status().warms <= 7,
        "30 minutes at 270 s is 6 or 7 warms",
    );
});

test("a run that ended before the conversation lookup came back stops the warm", async () => {
    const r = rig();

    r.endRun(3); // session "s" is conversation 3; its run is over when the lookup returns
    await r.send("s", "toolUse");
    await new Promise((x) => setImmediate(x));
    assert.equal(r.timers.length, 0);
});

// ─── Keep warm (idle) ────────────────────────────────────────────────────

const POLICY: IdlePolicy = { session: 3, hours: 2, maxCost: 1, maxRefreshes: 30, share: 75 };
/** Claude's prices for a 1 hour cache: read $0.50, write $10 per million tokens, so 20 refreshes break even. */
const CLAUDE = { read: 0.5, write: 10 };
const HOUR_MODEL = { short: 3600 };

/** The run of session "s" (conversation 3) ends after a finished answer. */
async function idleRun(r: ReturnType<typeof rig>, tier: "short" | "long" = "short") {
    await r.send("s", "stop", tier);
    await new Promise((x) => setImmediate(x));
    r.endRun(3);
    r.keeper.runEnded(3);
}

function memoryStore() {
    const saved = new Map<string, IdleRecord>();
    let budgets: Record<string, number> = {};

    return {
        saved,
        store: {
            save: (record: IdleRecord, withContext: boolean) => {
                const before = saved.get(record.key);

                saved.set(record.key, {
                    ...record,
                    messages: withContext ? record.messages : (before?.messages ?? []),
                });
            },
            delete: (key: string) => {
                saved.delete(key);
            },
            load: async () => [...saved.values()],
            saveBudgets: (spent: Record<string, number>) => {
                budgets = { ...spent };
            },
            loadBudgets: async () => ({ ...budgets }),
            flush: async () => {},
        } satisfies IdleStore,
    };
}

test("keep warm: every 75% of the lifetime; no known lifetime is never", () => {
    assert.equal(idleEveryMs(3_600_000, 75), 2_700_000);
    assert.equal(idleEveryMs(undefined, 75), undefined);
    assert.equal(idleEveryMs(20_000, 100), 10_000, "10 seconds before the end at least");
});

test("keep warm: off by default, a finished run keeps nothing", async () => {
    const r = rig();

    await idleRun(r);
    assert.equal(r.timers.length, 0);
    assert.equal(r.keeper.idleStatus(3).warm, false);
});

test("keep warm: after the run ends it refreshes until the time limit", async () => {
    const r = rig(false, { policy: { ...POLICY, maxRefreshes: 100 } });

    await idleRun(r);
    const start = r.now();

    assert.equal(r.timers.length, 1);
    assert.equal(r.timers[0]?.at, start + 270_000 * (75 / 90), "75% of a 5 minute cache");

    // Until it stops: the request then stays parked until its cache expires, in case the limit grows.
    for (let i = 0; i < 100 && r.keeper.idleStatus(3).warm; i++) {
        await r.advance();
    }

    const status = r.keeper.idleStatus(3);

    assert.equal(status.warm, false);
    assert.equal(!status.warm && status.stopped, "the time limit was reached");
    assert.ok(r.now() - start <= 2 * 3_600_000 + 1);
    assert.ok(r.keeper.status().warms >= 31, "2 hours at 225 s is 32 refreshes");
});

test("keep warm: the refresh cap and the cost cap stop it", async () => {
    const capped = rig(false, { policy: { ...POLICY, hours: 1000, maxRefreshes: 3 } });

    await idleRun(capped);

    await capped.drain(10);

    assert.equal(capped.keeper.status().warms, 3);
    const one = capped.keeper.idleStatus(3);

    assert.equal(!one.warm && one.stopped, "the refresh cap was reached");

    // A refresh reads $0.015; at worst (the cache gone) it writes 50,010 tokens at $3.75/M, about $0.1875. After two
    // ($0.03), a third at its worst would pass $0.21.
    const cost = rig(false, { policy: { ...POLICY, hours: 1000, maxCost: 0.21 } });

    await idleRun(cost);

    await cost.drain(10);

    assert.equal(
        cost.keeper.status().warms,
        2,
        "$0.03 spent plus a third at its worst would pass $0.21",
    );
    const two = cost.keeper.idleStatus(3);

    assert.equal(!two.warm && two.stopped, "the cost cap was reached");
});

test("keep warm: a new message stops it; the next run's end starts it again", async () => {
    const r = rig(false, { policy: POLICY });

    await idleRun(r);
    assert.equal(r.keeper.idleStatus(3).warm, true);
    r.startRun(3);
    await r.send("s", "stop");
    await new Promise((x) => setImmediate(x));
    assert.equal(r.keeper.idleStatus(3).warm, false);
    r.endRun(3);
    r.keeper.runEnded(3);
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: two cache misses in a row, billed as writes or plain input (OpenAI, xAI), stop it with the reason", async () => {
    for (const miss of ["rewriteOnWarm", "missOnWarm"] as const) {
        const r = rig(false, { policy: { ...POLICY, hours: 1000 } });

        await idleRun(r);
        r[miss]();
        await r.advance();
        assert.equal(r.keeper.idleStatus(3).warm, true, "one miss is allowed");
        await r.advance();
        const status = r.keeper.idleStatus(3);

        assert.equal(status.warm, false);
        assert.match(!status.warm ? (status.stopped ?? "") : "", /already gone 2 times/);
    }
});

test("keep warm: a refresh that errs is tried again soon; two in a row stop it", async () => {
    const r = rig(false, { policy: { ...POLICY, hours: 1000 } });

    await idleRun(r);
    r.failWarm();
    const before = r.now();

    await r.advance();
    assert.equal(r.keeper.idleStatus(3).warm, true);
    assert.equal((r.timers[0]?.at ?? 0) - r.now(), 30_000, "tried again 30 seconds later");
    assert.ok(r.now() > before);
    await r.advance();
    assert.equal(r.keeper.idleStatus(3).warm, false);
});

test("keep warm: forget (a model change, New context) stops it", async () => {
    const r = rig(false, { policy: POLICY });

    await idleRun(r);
    r.keeper.forget(3, "the model changed");
    const one = r.keeper.idleStatus(3);

    assert.equal(!one.warm && one.stopped, "the model changed");
    assert.equal(r.timers.length, 0);
});

test("keep warm: turned off and on again while idle, it picks up the same request; no stale stop is shown", async () => {
    let policy: IdlePolicy | undefined = POLICY;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    assert.equal(r.keeper.idleStatus(3).warm, true);

    policy = undefined;
    r.keeper.reconsider();
    const off = r.keeper.idleStatus(3);

    assert.equal(off.warm, false);
    assert.equal(!off.warm && off.stopped, undefined, "Off is a choice, not a stop");
    assert.equal(
        r.timers.filter((t) => t.at - r.now() < 3_000_000).length,
        1,
        "only the expiry of the kept request",
    );

    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, true, "turned on again without a new message");
    await r.advance();
    assert.equal(r.calls.length, 2, "the refresh went out");
});

test("keep warm: a session that was Off when its run ended can be turned on while its cache lives", async () => {
    let policy: IdlePolicy | undefined;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    assert.equal(r.keeper.idleStatus(3).warm, false);
    assert.equal(r.keeper.status().warming, 0, "nothing is warmed while Off");

    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: a request kept while Off goes when its cache expires, or a new run starts", async () => {
    let policy: IdlePolicy | undefined;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    await r.advance();
    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, false, "expired: nothing to pick up");
    assert.equal(r.calls.length, 1, "nothing was sent while Off");

    policy = undefined;
    await idleRun(r);
    r.keeper.runStarted(3);
    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, false, "a new run replaced it");
});

test("keep warm: off and on again keeps the stretch's counts, time limit, and failures", async () => {
    let policy: IdlePolicy | undefined = { ...POLICY, hours: 1000, maxRefreshes: 3 };
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    await r.advance();
    await r.advance();
    assert.equal(r.keeper.status().warms, 2);
    const since = r.keeper.idleStatus(3);

    policy = undefined;
    r.keeper.reconsider();
    policy = { ...POLICY, hours: 1000, maxRefreshes: 3 };
    r.keeper.reconsider();
    const again = r.keeper.idleStatus(3);

    assert.equal(again.warm && again.refreshes, 2, "the 2 refreshes still count");
    assert.equal(again.warm && again.spent, since.warm && since.spent);
    await r.advance();
    assert.equal(r.keeper.status().warms, 3);
    await r.advance();
    assert.equal(r.keeper.status().warms, 3, "no 4th refresh");
    const capped = r.keeper.idleStatus(3);

    assert.equal(
        !capped.warm && capped.stopped,
        "the refresh cap was reached",
        "the cap of 3 holds",
    );
});

test("keep warm: a run that ends during a tool wait while Off can be turned on", async () => {
    let policy: IdlePolicy | undefined;
    const r = rig(false, { policy: () => policy });

    await r.send("s", "toolUse");
    await new Promise((x) => setImmediate(x));
    r.endRun(3);
    r.keeper.runEnded(3);
    assert.equal(r.keeper.status().warming, 0, "nothing warms while Off");

    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: turned off while a refresh is on its way, it can still be turned on", async () => {
    let policy: IdlePolicy | undefined = POLICY;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    const release = r.holdNext(true);

    r.fireNext();
    await new Promise((x) => setImmediate(x));
    policy = undefined;
    r.keeper.reconsider();
    release();
    await new Promise((x) => setTimeout(x, 5));

    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: a time limit that stopped it gives way to a longer time while the cache lives", async () => {
    let policy: IdlePolicy = { ...POLICY, hours: 1000, maxRefreshes: 1 };
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    await r.advance();
    await r.advance();
    const stopped = r.keeper.idleStatus(3);

    assert.equal(!stopped.warm && stopped.stopped, "the refresh cap was reached");

    policy = { ...POLICY, hours: 1000, maxRefreshes: 5 };
    r.keeper.reconsider();
    const again = r.keeper.idleStatus(3);

    assert.equal(again.warm, true, "a higher cap picks it up");
    assert.equal(!again.warm || again.refreshes, 1);
});

test("keep warm: a refresh that finds the session Off parks it, and shows no stop", async () => {
    let policy: IdlePolicy | undefined = POLICY;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    // Turned off without a reconsider (the commit is still on its way): the refresh's own check finds it.
    policy = undefined;
    await r.advance();
    const off = r.keeper.idleStatus(3);

    assert.equal(off.warm, false);
    assert.equal(!off.warm && off.stopped, undefined);
    assert.equal(r.calls.length, 1, "nothing was sent");

    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: a 1 hour cache is kept warm when idle, though a tool wait never warms it", async () => {
    const r = rig(false, { policy: POLICY });
    const hour = model as unknown as { promptCache: unknown };
    const was = hour.promptCache;

    hour.promptCache = HOUR_MODEL;

    try {
        await idleRun(r);
        assert.equal((r.timers[0]?.at ?? 0) - r.now(), 2_700_000, "every 45 minutes");
    } finally {
        hour.promptCache = was;
    }
});

test("keep warm: it goes on after a restart while the cache lives, and not after it expired", async () => {
    const memory = memoryStore();
    const first = rig(false, { policy: { ...POLICY, hours: 1000 }, store: memory.store });

    await idleRun(first);
    await first.advance();
    assert.equal(memory.saved.size, 1);
    await first.keeper.close();
    assert.equal(memory.saved.size, 1, "close keeps it for the next start");
    assert.equal(memory.saved.get("s")?.warms, 1);

    const second = rig(false, { policy: { ...POLICY, hours: 1000 }, store: memory.store });

    second.setNow(first.now() + 60_000);
    second.endRun(3);
    await second.keeper.restore();
    assert.equal(second.keeper.idleStatus(3).warm, true);
    await second.advance();
    assert.equal(second.calls.length, 1, "the restored entry is refreshed");
    assert.equal(second.calls[0]?.maxTokens, 1);

    const late = rig(false, { policy: POLICY, store: memory.store });

    late.setNow(second.now() + 3_600_000);
    late.endRun(3);
    await late.keeper.restore();
    assert.equal(late.keeper.idleStatus(3).warm, false);
    assert.equal(memory.saved.size, 0, "an expired entry is deleted");
});

test("keep warm: a session whose run goes on after the restart is not warmed", async () => {
    const memory = memoryStore();
    const first = rig(false, { policy: POLICY, store: memory.store });

    await idleRun(first);
    await first.keeper.close();

    const second = rig(false, { policy: POLICY, store: memory.store });

    await second.keeper.restore();
    assert.equal(second.keeper.idleStatus(3).warm, false);
    assert.equal(memory.saved.size, 0);
});

test("keep warm: a new run stops it with nothing to report", async () => {
    const r = rig(false, { policy: POLICY });

    await idleRun(r);
    assert.equal(r.keeper.idleStatus(3).warm, true);
    r.keeper.runStarted(3);
    assert.deepEqual(r.keeper.idleStatus(3), { warm: false });
    assert.equal(r.timers.length, 0);
});

test("keep warm: break-even is the write price over the read price, less the next message's own read", () => {
    assert.equal(breakEvenRefreshes(CLAUDE), 19);
    assert.equal(
        breakEvenRefreshes({ read: 0.5, write: 6.25 }),
        11,
        "the 5 minute write: 12.5, rounded down, less one",
    );
    assert.equal(breakEvenRefreshes({ read: 0, write: 10 }), 0, "no read price: not known");
    assert.equal(breakEvenRefreshes({ read: 1, write: 0.5 }), 1);
});

test("keep warm: Break-even stops at break-even, with its own reason", async () => {
    const r = rig(false, {
        policy: { ...POLICY, hours: "break-even" },
        facts: { prices: { read: 0.5, write: 2 } },
    });

    await idleRun(r);

    await r.drain(20);

    assert.equal(
        r.keeper.status().warms,
        3,
        "write 4× the read: 3 refreshes and the next message's read",
    );
    const status = r.keeper.idleStatus(3);

    assert.equal(
        !status.warm && status.stopped,
        "Break-even: more refreshes would cost more than writing the cache again",
    );
});

test("keep warm: Break-even with no published prices stops at the refresh cap; the cap below break-even wins", async () => {
    const none = rig(false, { policy: { ...POLICY, hours: "break-even", maxRefreshes: 3 } });

    await idleRun(none);

    await none.drain(20);

    const unpriced = none.keeper.idleStatus(3);

    assert.equal(none.keeper.status().warms, 3);
    assert.equal(!unpriced.warm && unpriced.stopped, "the refresh cap was reached");

    const capped = rig(false, {
        policy: { ...POLICY, hours: "break-even", maxRefreshes: 2 },
        facts: { prices: CLAUDE },
    });

    await idleRun(capped);

    await capped.drain(20);

    const status = capped.keeper.idleStatus(3);

    assert.equal(capped.keeper.status().warms, 2);
    assert.equal(!status.warm && status.stopped, "the refresh cap was reached");
});

test("keep warm: the owner's lifetime for a model wins over Pi's", async () => {
    const r = rig(false, {
        policy: POLICY,
        facts: { lifetimeMs: 3_600_000 },
    });

    await idleRun(r);
    assert.equal((r.timers[0]?.at ?? 0) - r.now(), 2_700_000, "75% of the owner's hour");
});

test("keep warm: changing a time limit to Break-even drops the old deadline", async () => {
    let policy: IdlePolicy = { ...POLICY, hours: 1 };
    const r = rig(false, { policy: () => policy, facts: { prices: CLAUDE } });

    await idleRun(r);
    const before = r.keeper.idleStatus(3);

    assert.ok(before.warm && before.until !== undefined, "a 1 h limit has a deadline");

    policy = { ...POLICY, hours: "break-even" };
    r.keeper.reconsider();
    const after = r.keeper.idleStatus(3);

    assert.ok(after.warm && after.until === undefined, "Break-even has none");
    assert.equal(r.timers.length, 1, "one timer after the change");
});

test("keep warm: a run that ends while a tool-wait refresh is on its way leaves one timer", async () => {
    const r = rig(false, { policy: POLICY });

    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 1);

    // The tool-wait refresh starts; the run ends before its answer comes back.
    r.fireNext();
    r.endRun(3);
    r.keeper.runEnded(3);
    assert.equal(r.timers.length, 1, "only the refresh's own deadline: no idle timer yet");

    await new Promise((x) => setTimeout(x, 5));
    const status = r.keeper.idleStatus(3);

    assert.ok(status.warm, "the entry is kept warm");
    assert.equal(status.refreshes, 1, "the refresh on its way counts as its first");
    assert.equal(r.timers.length, 1, "exactly one timer: the next idle refresh");
    assert.equal((r.timers[0]?.at ?? 0) - r.now(), 225_000, "75% of the 5 minute cache");
});

test("keep warm: a request on its way when the model changes is not kept warm", async () => {
    const r = rig(false, { policy: POLICY });
    const release = r.holdNext();
    const sent = r.send("s", "stop");

    await new Promise((x) => setImmediate(x));
    r.keeper.forget(3, "the model changed");
    release();
    await sent;
    r.endRun(3);
    r.keeper.runEnded(3);
    assert.equal(r.keeper.idleStatus(3).warm, false);
    assert.equal(r.timers.length, 0);
});

test("keep warm: a model change while saved entries load is not undone by the restore", async () => {
    const memory = memoryStore();
    const first = rig(false, { policy: POLICY, store: memory.store });

    await idleRun(first);
    await first.keeper.close();

    const second = rig(false, { policy: POLICY, store: memory.store });

    let loaded = () => {};

    const load = memory.store.load;

    memory.store.load = async () => {
        await new Promise<void>((resolve) => {
            loaded = resolve;
        });

        return load();
    };

    second.endRun(3);
    const restoring = second.keeper.restore();

    second.keeper.forget(3, "the model changed");
    loaded();
    await restoring;
    assert.equal(second.keeper.idleStatus(3).warm, false);
    assert.equal(memory.saved.size, 0, "the old entry is deleted");
});

test("keep warm: a refresh on its way at shutdown counts after the restart", async () => {
    const memory = memoryStore();
    const first = rig(false, {
        policy: { ...POLICY, hours: 1000, maxRefreshes: 1 },
        store: memory.store,
    });

    await idleRun(first);
    // Sent to the provider already: the abort at shutdown still comes back with usage to pay.
    const release = first.holdNext(true);

    first.fireNext();
    await new Promise((x) => setImmediate(x));
    const closing = first.keeper.close();

    release();
    await closing;
    assert.equal(memory.saved.get("s")?.warms, 1, "the refresh that was on its way is saved");

    const second = rig(false, {
        policy: { ...POLICY, hours: 1000, maxRefreshes: 1 },
        store: memory.store,
    });

    second.setNow(first.now() + 1000);
    second.endRun(3);
    await second.keeper.restore();
    await second.advance().catch(() => {});
    assert.equal(second.calls.length, 0, "the cap of 1 was reached before the restart");
});

test("keep warm: a refresh is not sent once its session is turned off", async () => {
    let policy: IdlePolicy | undefined = POLICY;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    const release = r.holdNext();

    r.fireNext();
    // Archived (or turned off) while the refresh is being prepared: it must not be sent.
    policy = undefined;
    release();
    await new Promise((x) => setTimeout(x, 5));
    assert.equal(r.keeper.status().warms, 0);
    const status = r.keeper.idleStatus(3);

    // Off is a choice: no stop is shown, and turning it on again picks the request up.
    assert.equal(status.warm, false);
    assert.equal(!status.warm && status.stopped, undefined);
    policy = POLICY;
    r.keeper.reconsider();
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: a tool-wait refresh renews the cache's age for keep warm", async () => {
    const r = rig(false, { policy: POLICY });

    await r.send("s", "toolUse");
    await r.advance();
    // The run ends after the first request's 5 minutes, but within 5 minutes of the refresh.
    r.setNow(r.now() + 60_000);
    r.endRun(3);
    r.keeper.runEnded(3);
    assert.equal(r.keeper.idleStatus(3).warm, true);
});

test("keep warm: the cost cap counts the next refresh at its worst, so a rewrite never passes it", async () => {
    const r = rig(false, { policy: { ...POLICY, hours: 1000, maxCost: 0.25 } });

    await idleRun(r);
    // The cache is gone at every refresh: each one writes it again, which a read's price would not foresee.
    r.rewriteOnWarm();

    await r.drain(10);

    assert.equal(
        r.keeper.status().spent,
        billedUsage({ output: 1, cacheRead: 0, cacheWrite: 50_000 }).cost.total,
        "only one full rewrite fits the cap",
    );
    assert.ok(r.keeper.status().spent <= 0.25, String(r.keeper.status().spent));
    assert.equal(r.calls.length, 2, "one real request and one refresh");
});

test("keep warm: the cost cap is the session's, its subagents' refreshes and stopped ones included", async () => {
    const memory = new Map<string, number>([
        ["s", 3],
        ["a", 1],
    ]);
    const policy: IdlePolicy = { ...POLICY, session: 3, hours: 1000, maxCost: 0.21 };
    const r = rig(false, { policy, conversations: memory });

    // The session and one subagent both go idle under session 3.
    await r.send("s", "stop");
    await r.send("a", "stop");
    await new Promise((x) => setImmediate(x));
    r.endRun(3);
    r.endRun(1);
    r.keeper.runEnded(3);
    r.keeper.runEnded(1);

    await r.drain(20);

    // Each could have refreshed twice on its own ($0.015 + $0.1875 at worst fits $0.21); together they stop after two.
    assert.equal(r.keeper.status().warms, 2);
});

/** The root session and its subagent share one idle cost cap. */
async function idlePair(r: ReturnType<typeof rig>) {
    await idleRun(r);
    await r.send("a", "stop");
    r.endRun(1);
    r.keeper.runEnded(1);
}

test("keep warm: an in-flight refresh reserves the session budget for its subagent", async () => {
    const r = rig(false, { policy: { ...POLICY, maxCost: 0.25 } });

    await idlePair(r);
    const release = r.holdNext(true);

    try {
        await r.advance();
        assert.equal(r.calls.length, 3, "the root refresh is in flight");
        await r.advance();
        assert.equal(r.calls.length, 3, "the subagent cannot spend the reserved budget");
        const status = r.keeper.idleStatus(1);

        assert.equal(!status.warm && status.stopped, "the cost cap was reached");
    } finally {
        release();
        await r.keeper.close();
    }
});

test("keep warm: a refresh dropped in flight still counts against the session cost cap", async () => {
    const r = rig(false, { policy: { ...POLICY, maxCost: 0.2 } });

    await idlePair(r);
    const release = r.holdNext(true);

    try {
        await r.advance();
        r.keeper.forget(3, "the model changed");
        release();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(r.keeper.status().spent, billedUsage({ output: 1 }).cost.total);
        await r.advance();
        assert.equal(r.calls.length, 3, "the late response leaves too little for the subagent");
        const status = r.keeper.idleStatus(1);

        assert.equal(!status.warm && status.stopped, "the cost cap was reached");
    } finally {
        release();
        await r.keeper.close();
    }
});

test("keep warm: restore retains the session spend of entries that already stopped", async () => {
    const memory = memoryStore();
    const policy = { ...POLICY, maxCost: 0.21 };
    const first = rig(false, { policy, store: memory.store });

    await idlePair(first);
    await first.advance();
    await first.advance();
    assert.equal(first.keeper.status().spent, 2 * billedUsage({ output: 1 }).cost.total);
    first.keeper.forget(1, "the subagent stopped");
    await first.keeper.close();
    assert.equal(memory.saved.size, 1, "only the root's entry remains");

    const second = rig(false, { policy, store: memory.store });

    second.setNow(first.now() + 1000);
    second.endRun(3);
    await second.keeper.restore();
    await second.advance();
    assert.equal(second.calls.length, 0, "the stopped subagent's spend still counts");
    const status = second.keeper.idleStatus(3);

    assert.equal(!status.warm && status.stopped, "the cost cap was reached");
    await second.keeper.close();
});

test("keep warm: a 1-hour Anthropic miss reserves twice the input price", async () => {
    const r = rig(false, { policy: { ...POLICY, maxCost: 0.25 } });

    await idleRun(r, "long");
    await r.advance();
    assert.equal(r.calls.length, 1, "a $0.30 rewrite cannot fit a $0.25 cap");
    assert.equal(r.keeper.status().spent, 0);
    const status = r.keeper.idleStatus(3);

    assert.equal(!status.warm && status.stopped, "the cost cap was reached");
});

test("keep warm: Break-even uses the request's cache tier for its prices", async () => {
    const r = rig(false, {
        policy: { ...POLICY, hours: "break-even" },
        facts: (_spec, tier) => ({ prices: { read: 0.3, write: tier === "long" ? 6 : 3.75 } }),
    });

    await idleRun(r, "long");
    const status = r.keeper.idleStatus(3);

    assert.ok(status.warm);
    assert.equal(status.maxRefreshes, 19, "the request uses the 1-hour write price");
});
