// The endpoint form's context window, maximum output, and price fields (`web/model-limits.js`): what their text means,
// what a save sends of them, and what Find again fills in.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import * as limits from "../web/model-limits.js";

const {
    dollars,
    dollarsFrom,
    dollarsText,
    fillLimits,
    limitsChanges,
    limitsSet,
    limitsText,
    tokensFrom,
} = limits;

const tier = { inputTokensAbove: 200000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 0 };
const saved = {
    id: "m",
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0, tiers: [tier] },
};

test("a field shows its number as typed, a tiny price without an exponent", () => {
    assert.deepEqual(limitsText(saved), {
        contextWindow: "131072",
        maxTokens: "8192",
        cost: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "0" },
        tiers: [tier],
    });
    assert.equal(limitsText({ cost: { input: 1e-7, output: 0.0000025 } }).cost.input, "0.0000001");

    // Every digit, so a price that is not edited reads back as the same number.
    for (const [value, text] of [
        [4e-13, "0.0000000000004"],
        [1.25e-7, "0.000000125"],
        [0.123456789012345, "0.123456789012345"],
        [1 / 3, "0.3333333333333333"],
        [1000000, "1000000"],
        [0, "0"],
    ] as const) {
        assert.equal(dollarsText(value), text);
        assert.equal(dollarsFrom(text), value);
    }

    assert.equal(dollarsText(undefined), "");
    assert.deepEqual(limitsText(undefined), {
        contextWindow: "",
        maxTokens: "",
        cost: { input: "", output: "", cacheRead: "", cacheWrite: "" },
        tiers: [],
    });
});

test("a token count is digits, with thousands marked if any; anything else is no count", () => {
    for (const [text, value] of [
        ["", null],
        ["  ", null],
        ["131072", 131072],
        [" 131,072 ", 131072],
        ["1_000_000", 1000000],
        ["1 000 000", 1000000],
        ["1000000000", 1000000000],
    ] as const) {
        assert.equal(tokensFrom(text), value, text);
    }

    for (const text of [
        "0",
        "-5",
        "12.5",
        "1e5",
        "128k",
        "1,00",
        "1,000_000",
        "1000000001",
        "0x10",
    ]) {
        assert.ok(Number.isNaN(tokensFrom(text)), text);
    }
});

test("a saved model sends only what changed, so a value the form cannot take stays", () => {
    const start = limitsText({ ...saved, contextWindow: 0.5, cost: { input: -1, output: 2 } });

    // Nothing changed: nothing sent, also when the saved values are ones the form would refuse.
    assert.deepEqual(limitsChanges(start, start), { changes: {}, problem: "" });

    // A changed window is sent; the price that was there is not.
    assert.deepEqual(limitsChanges({ ...start, contextWindow: "65,536" }, start), {
        changes: { contextWindow: 65536 },
        problem: "",
    });

    // Emptied: Pi's default.
    assert.deepEqual(limitsChanges({ ...start, contextWindow: "" }, start).changes, {
        contextWindow: null,
    });

    // Only space added: no change.
    assert.deepEqual(limitsChanges({ ...start, maxTokens: " 8192 " }, start).changes, {});

    // A price part changed: the whole price is sent, and checked.
    assert.match(
        limitsChanges({ ...start, cost: { ...start.cost, output: "3" } }, start).problem,
        /plain number of dollars/,
    );
});

test("a new model sends all its limits", () => {
    assert.deepEqual(limitsChanges(limitsText(saved), undefined), {
        changes: {
            contextWindow: 131072,
            maxTokens: 8192,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0, tiers: [tier] },
        },
        problem: "",
    });
    assert.deepEqual(limitsChanges(limitsText(undefined), undefined), {
        changes: { contextWindow: null, maxTokens: null, cost: null },
        problem: "",
    });
});

test("a price: plain dollars, input and output both, a cache part left empty is 0", () => {
    const priced = (cost: Record<string, string>, tiers: unknown[] = []) =>
        limitsChanges(
            {
                contextWindow: "",
                maxTokens: "",
                cost: { input: "", output: "", cacheRead: "", cacheWrite: "", ...cost },
                tiers,
            },
            undefined,
        );

    assert.deepEqual(priced({ input: "$0.15", output: ".6" }).changes.cost, {
        input: 0.15,
        output: 0.6,
        cacheRead: 0,
        cacheWrite: 0,
        tiers: [],
    });
    assert.deepEqual(priced({ input: "0", output: "0" }).changes.cost, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tiers: [],
    });
    assert.match(priced({ input: "1" }).problem, /input and output/);
    assert.match(priced({ cacheRead: "1" }).problem, /input and output/);

    for (const bad of ["-1", "1e2", "1,5", "abc", "1000001", "1.2.3"]) {
        assert.match(priced({ input: bad, output: "1" }).problem, /plain number of dollars/, bad);
    }

    // Long-prompt prices without a price of their own are no price.
    assert.match(priced({}, [tier]).problem, /long prompts/);
});

test("a token field that is no count says which it is", () => {
    const start = limitsText(saved);

    assert.match(
        limitsChanges({ ...start, contextWindow: "128k" }, start).problem,
        /context window/,
    );
    assert.match(limitsChanges({ ...start, maxTokens: "-" }, start).problem, /maximum output/);
});

test("removing the long-prompt prices sends the price without them", () => {
    const start = limitsText(saved);

    assert.deepEqual(limitsChanges({ ...start, tiers: [] }, start).changes, {
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0, tiers: [] },
    });
});

test("a changed price of a saved model leaves its tiers to the server, which keeps them as they are", () => {
    const start = limitsText(saved);

    assert.deepEqual(
        limitsChanges({ ...start, cost: { ...start.cost, input: "4" } }, start).changes,
        {
            cost: { input: 4, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        },
    );
});

test("Find again fills the empty fields only, and a price only when none is set", () => {
    const said = {
        id: "m",
        contextWindow: 200000,
        maxTokens: 64000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, tiers: [tier] },
    };
    const empty = limitsText(undefined);

    assert.deepEqual(fillLimits(empty, said), limitsText(said));

    const typed = { ...empty, contextWindow: "100000", cost: { ...empty.cost, cacheRead: "0.1" } };

    assert.deepEqual(fillLimits(typed, said), {
        ...typed,
        maxTokens: "64000",
    });

    // A list that says nothing changes nothing.
    assert.deepEqual(fillLimits(typed, { id: "m" }), typed);
});

test("a model's limits are set when any field has text or it has long-prompt prices", () => {
    const empty = limitsText(undefined);

    assert.equal(limitsSet(empty), false);
    assert.equal(limitsSet({ ...empty, maxTokens: "1" }), true);
    assert.equal(limitsSet({ ...empty, tiers: [tier] }), true);
});

test("a button shows a price short and plain", () => {
    for (const [value, text] of [
        [3, "3"],
        [22.5, "22.5"],
        [0.15, "0.15"],
        [0.075, "0.075"],
        [0.00003, "0.00003"],
        [0.0000123, "0.000012"],
        [0, "0"],
    ] as const) {
        assert.equal(dollars(value), text);
    }
});
