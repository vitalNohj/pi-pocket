import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { cachePrices } from "../src/server/keep-warm.ts";

const model = (api: string, cost: Partial<Model<Api>["cost"]>) =>
    ({ api, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost } }) as Model<Api>;

test("cache prices: the published read and write; Anthropic's 1-hour write is twice the input", () => {
    const claude = model("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 });

    assert.deepEqual(cachePrices(claude, 300), { read: 0.2, write: 5 });
    assert.deepEqual(cachePrices(claude, 3600), { read: 0.2, write: 8 });
});

test("cache prices: no write price is the input price; no read or input price is not published", () => {
    assert.deepEqual(
        cachePrices(model("openai-responses", { input: 2, cacheRead: 0.1 }), undefined),
        {
            read: 0.1,
            write: 2,
        },
    );
    assert.equal(cachePrices(model("openai-responses", { input: 2 }), undefined), undefined);
    assert.equal(cachePrices(model("openai-responses", { cacheRead: 0.1 }), undefined), undefined);
});

test("cache prices: the owner's read for a model with none published, with the write its input implies", () => {
    assert.deepEqual(cachePrices(model("openai-completions", { input: 2 }), undefined, 0.5), {
        read: 0.5,
        write: 2,
    });
});
