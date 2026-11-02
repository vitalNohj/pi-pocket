import assert from "node:assert/strict";
import test from "node:test";
import { cachePrices } from "../src/server/keep-warm.ts";
const m = (api: string, cost: object) =>
    ({ api, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost } }) as never;

test("keep warm: cache prices, a miss at the input price where no write price is listed", () => {
    assert.deepEqual(
        cachePrices(m("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 }), 3600),
        { read: 0.2, write: 8 },
    );
    assert.deepEqual(
        cachePrices(m("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 }), 300),
        { read: 0.2, write: 5 },
    );
    assert.deepEqual(cachePrices(m("openai-responses", { input: 2, cacheRead: 0.5 }), undefined), {
        read: 0.5,
        write: 2,
    });
    assert.deepEqual(cachePrices(m("openai-responses", {}), undefined), {});
});
