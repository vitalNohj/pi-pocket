// The cache keeper with fake streams and a fake clock: when it warms, when it stops, and what it never does.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    type Api,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
    CacheKeeper,
    decide,
    type IdlePolicy,
    type ModelFacts,
    type IdleRecord,
    type IdleStore,
    breakEvenRefreshes,
    idleEveryMs,
    idleFiles,
    MAX_AGE_MS,
    refreshDelayMs,
} from "../src/server/cache-keeper.ts";

// Claude Sonnet prices per million tokens, with a 5 minute cache.
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const model = {
    id: "m",
    provider: "anthropic",
    api: "anthropic-messages",
    cost: COST,
    promptCache: { short: 300, long: 3600 },
} as unknown as Model<Api>;
const usage = {
    input: 10,
    output: 5,
    cacheRead: 50_000,
    cacheWrite: 0,
    totalTokens: 50_015,
    cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 },
};

/** A model runtime plus a clock. `timers` are the keeper's pending timers; `advance` fires the next one. */
function rig(
    disabled = false,
    idle?: {
        policy?: IdlePolicy | (() => IdlePolicy | undefined);
        facts?: ModelFacts;
        store?: IdleStore;
    },
) {
    let now = 1_000_000;
    let warmUsage = usage;
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
        conversationOf: async (sessionId) => ({ a: 1, b: 2, s: 3 })[sessionId],
        isRunning: (id) => !ended.has(id),
        disabled: () => off,
        ...(idle?.policy === undefined
            ? {}
            : {
                  idlePolicy: () =>
                      typeof idle.policy === "function" ? idle.policy() : idle.policy,
              }),
        ...(idle?.facts === undefined ? {} : { modelFacts: () => idle.facts! }),
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

    const advance = async () => {
        const next = timers.sort((a, b) => a.at - b.at)[0];

        assert.ok(next, "a timer is pending");
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
        await new Promise((r) => setTimeout(r, 5));
    };

    return {
        keeper,
        send,
        advance,
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
            warmUsage = { ...usage, cacheRead: 0, cacheWrite: 50_000 };
        },
        /** OpenAI and xAI: a miss is billed as plain input, with no cache write. */
        missOnWarm: () => {
            warmUsage = { ...usage, input: 50_000, cacheRead: 0, cacheWrite: 0 };
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

    for (let i = 0; i < 40 && r.timers.length > 0; i++) {
        await r.advance();
    }

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

    for (let i = 0; i < 40 && r.timers.length > 0; i++) {
        await r.advance();
    }

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

const POLICY: IdlePolicy = { hours: 2, maxCost: 1, maxRefreshes: 30, share: 75 };
/** Claude's prices for a 1 hour cache: read $0.50, write $10 per million tokens, so 20 refreshes break even. */
const CLAUDE = { read: 0.5, write: 10 };
const HOUR_MODEL = { short: 3600 };

/** The run of session "s" (conversation 3) ends after a finished answer. */
async function idleRun(r: ReturnType<typeof rig>) {
    await r.send("s", "stop");
    await new Promise((x) => setImmediate(x));
    r.endRun(3);
    r.keeper.runEnded(3);
}

function memoryStore() {
    const saved = new Map<string, IdleRecord>();

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

    for (let i = 0; i < 100 && r.timers.length > 0; i++) {
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

    for (let i = 0; i < 10 && capped.timers.length > 0; i++) {
        await capped.advance();
    }

    assert.equal(capped.keeper.status().warms, 3);
    const one = capped.keeper.idleStatus(3);

    assert.equal(!one.warm && one.stopped, "the refresh cap was reached");

    const cost = rig(false, { policy: { ...POLICY, hours: 1000, maxCost: 0.04 } });

    await idleRun(cost);

    for (let i = 0; i < 10 && cost.timers.length > 0; i++) {
        await cost.advance();
    }

    assert.equal(cost.keeper.status().warms, 2, "$0.015 a refresh: a third would pass $0.04");
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

test("keep warm: two refreshes in a row that wrote the cache stop it, with the reason", async () => {
    const r = rig(false, { policy: { ...POLICY, hours: 1000 } });

    await idleRun(r);
    r.rewriteOnWarm();
    await r.advance();
    assert.equal(r.keeper.idleStatus(3).warm, true, "one miss is allowed");
    await r.advance();
    const status = r.keeper.idleStatus(3);

    assert.equal(status.warm, false);
    assert.match(!status.warm ? (status.stopped ?? "") : "", /already gone 2 times/);
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

test("keep warm: forget (a model change, New context) and turning it off stop it", async () => {
    let policy: IdlePolicy | undefined = POLICY;
    const r = rig(false, { policy: () => policy });

    await idleRun(r);
    r.keeper.forget(3, "the model changed");
    const one = r.keeper.idleStatus(3);

    assert.equal(!one.warm && one.stopped, "the model changed");
    assert.equal(r.timers.length, 0);

    await r.send("s", "stop");
    r.keeper.runEnded(3);
    assert.equal(r.keeper.idleStatus(3).warm, true);
    policy = undefined;
    r.keeper.reconsider();
    const two = r.keeper.idleStatus(3);

    assert.equal(!two.warm && two.stopped, "turned off");
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

test("keep warm: break-even is the write price over the read price", () => {
    assert.equal(breakEvenRefreshes(CLAUDE), 20);
    assert.equal(
        breakEvenRefreshes({ read: 0.5, write: 6.25 }),
        12,
        "the 5 minute write: 12.5, rounded down",
    );
    assert.equal(breakEvenRefreshes({ read: 0, write: 10 }), 0, "no read price: not known");
    assert.equal(breakEvenRefreshes({ read: 1, write: 0.5 }), 1);
});

test("keep warm: Auto stops at break-even, with its own reason", async () => {
    const r = rig(false, {
        policy: { ...POLICY, hours: "auto" },
        facts: { prices: { read: 0.5, write: 2 } },
    });

    await idleRun(r);

    for (let i = 0; i < 20 && r.timers.length > 0; i++) {
        await r.advance();
    }

    assert.equal(r.keeper.status().warms, 4, "write 4× the read: 4 refreshes");
    const status = r.keeper.idleStatus(3);

    assert.equal(
        !status.warm && status.stopped,
        "Auto: more refreshes would cost more than writing the cache again",
    );
});

test("keep warm: Auto with no published prices stops at the refresh cap; the cap below break-even wins", async () => {
    const none = rig(false, { policy: { ...POLICY, hours: "auto", maxRefreshes: 3 } });

    await idleRun(none);

    for (let i = 0; i < 20 && none.timers.length > 0; i++) {
        await none.advance();
    }

    const unpriced = none.keeper.idleStatus(3);

    assert.equal(none.keeper.status().warms, 3);
    assert.equal(!unpriced.warm && unpriced.stopped, "the refresh cap was reached");

    const capped = rig(false, {
        policy: { ...POLICY, hours: "auto", maxRefreshes: 2 },
        facts: { prices: CLAUDE },
    });

    await idleRun(capped);

    for (let i = 0; i < 20 && capped.timers.length > 0; i++) {
        await capped.advance();
    }

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

test("keep warm: changing a time limit to Auto drops the old deadline", async () => {
    let policy: IdlePolicy = { ...POLICY, hours: 1 };
    const r = rig(false, { policy: () => policy, facts: { prices: CLAUDE } });

    await idleRun(r);
    const before = r.keeper.idleStatus(3);

    assert.ok(before.warm && before.until !== undefined, "a 1 h limit has a deadline");

    policy = { ...POLICY, hours: "auto" };
    r.keeper.reconsider();
    const after = r.keeper.idleStatus(3);

    assert.ok(after.warm && after.until === undefined, "Auto has none");
    assert.equal(r.timers.length, 1, "one timer after the change");
});

test("keep warm: a run that ends while a tool-wait refresh is on its way leaves one timer", async () => {
    const r = rig(false, { policy: POLICY });

    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 1);

    // The tool-wait refresh starts; the run ends before its answer comes back.
    const next = r.timers.sort((a, b) => a.at - b.at)[0]!;

    r.timers.splice(r.timers.indexOf(next), 1);
    r.setNow(next.at);
    next.fn();
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

test("keep warm: a miss billed as plain input (OpenAI, xAI) counts as the cache being gone", async () => {
    const r = rig(false, { policy: { ...POLICY, hours: 1000 } });

    await idleRun(r);
    r.missOnWarm();
    await r.advance();
    await r.advance();
    const status = r.keeper.idleStatus(3);

    assert.equal(status.warm, false);
    assert.match(!status.warm ? (status.stopped ?? "") : "", /already gone 2 times/);
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
    const next = first.timers.sort((a, b) => a.at - b.at)[0]!;

    first.timers.splice(first.timers.indexOf(next), 1);
    first.setNow(next.at);
    next.fn();
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
    const next = r.timers.sort((a, b) => a.at - b.at)[0]!;

    r.timers.splice(r.timers.indexOf(next), 1);
    r.setNow(next.at);
    next.fn();
    // Archived (or turned off) while the refresh is being prepared: it must not be sent.
    policy = undefined;
    release();
    await new Promise((x) => setTimeout(x, 5));
    assert.equal(r.keeper.status().warms, 0);
    const status = r.keeper.idleStatus(3);

    assert.equal(!status.warm && status.stopped, "turned off");
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

test("keep warm: the cost cap counts the next refresh, so it is never passed", async () => {
    const r = rig(false, { policy: { ...POLICY, hours: 1000, maxCost: 0.02 } });

    await idleRun(r);

    for (let i = 0; i < 10 && r.timers.length > 0; i++) {
        await r.advance();
    }

    assert.ok(r.keeper.status().spent <= 0.02, String(r.keeper.status().spent));
});

test("keep warm files: an edited or damaged record is never warmed, and leaves nothing behind", async () => {
    const folder = await mkdtemp(join(tmpdir(), "keep-warm-"));

    try {
        const store = idleFiles(
            folder,
            () => {},
            () => 2_000_000,
        );
        const record: IdleRecord = {
            version: 1,
            key: "s",
            conversationId: 3,
            provider: "anthropic",
            modelId: "m",
            messages: [],
            options: { sessionId: "s", apiKey: "planted", headers: { x: "1" } },
            promptTokens: 10,
            payloadHash: "h",
            lastTouch: 1_000_000,
            since: 1_000_000,
            warms: 0,
            spent: 0,
            failures: 0,
        };

        store.save(record, true);
        store.save({ ...record, key: "t", options: { sessionId: "t" }, warms: -5 }, true);
        await store.flush();
        await writeFile(join(folder, "orphan.context.json"), "[]");
        await writeFile(join(folder, "cut.json.tmp"), "{");

        const loaded = await store.load();

        assert.equal(loaded.length, 1, "the record with a negative count is dropped");
        assert.deepEqual(loaded[0]?.options, { sessionId: "s" }, "no key, headers, or address");
        assert.equal(
            (await readdir(folder)).length,
            2,
            "only the good record's two files are left",
        );
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});
