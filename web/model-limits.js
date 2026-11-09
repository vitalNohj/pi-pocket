// What the Providers sheet's endpoint form reads from a model's context window, maximum output, and price fields, kept
// apart from the form so that tests can run it: what each field's text means, what is wrong with it, and what a save
// sends. A model's limits are its fields' text: `contextWindow`, `maxTokens`, `cost` (input, output, cache read, cache
// write, in dollars per million tokens), and its price `tiers` for long prompts (as discovery found them; the form
// only removes them). A saved model also keeps the text its fields started with, so a save sends only what changed.

/** The parts of a model's price, in dollars per million tokens, with their names in the form. */
export const PRICES = [
    ["input", "Input"],
    ["output", "Output"],
    ["cacheRead", "Cache read"],
    ["cacheWrite", "Cache write"],
];
/** The most tokens and dollars the server takes. */
export const MAX_TOKENS = 1_000_000_000;
export const MAX_PRICE = 1_000_000;

/** A token count as its field shows it: empty when there is none. */
const tokensText = (value) => (typeof value === "number" ? String(value) : "");

/** Dollars as plain digits, never as 1e-7: up to `digits` after the point. */
const plainNumber = (value, digits) =>
    value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: digits });

/**
 * A number as the fewest digits that read back as it, without an exponent: 0.0000001, not 1e-7. A price is at most a
 * million dollars, so only small numbers have one.
 */
function exactNumber(value) {
    const text = String(value);
    const small = /^(-?)(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);

    return small === null
        ? text
        : `${small[1]}0.${"0".repeat(Number(small[4]) - 1)}${small[2]}${small[3] ?? ""}`;
}

/** Dollars as their field shows them, exactly: empty when there are none. */
export const dollarsText = (value) => (typeof value === "number" ? exactNumber(value) : "");

/** What a model's fields start with: its context window, maximum output, price, and price tiers, as text. */
export const limitsText = (model) => ({
    contextWindow: tokensText(model?.contextWindow),
    maxTokens: tokensText(model?.maxTokens),
    cost: Object.fromEntries(PRICES.map(([part]) => [part, dollarsText(model?.cost?.[part])])),
    tiers: Array.isArray(model?.cost?.tiers) ? model.cost.tiers : [],
});

/** Digits, with commas, underscores, or spaces between thousands if any: 131072, 131,072, 1_000_000. */
const TOKENS = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?:_\d{3})+|\d{1,3}(?: \d{3})+)$/;
/** Dollars with a point, if any, and a $ before them if any: 3, 0.15, .5, $2.50. */
const DOLLARS = /^\$?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** A count of tokens from its field: null when empty (Pi's default), NaN when it is not one. */
export function tokensFrom(text) {
    const trimmed = text.trim();

    if (trimmed === "") {
        return null;
    }

    const value = TOKENS.test(trimmed) ? Number(trimmed.replace(/[,_ ]/g, "")) : Number.NaN;

    return value >= 1 && value <= MAX_TOKENS ? value : Number.NaN;
}

/** Dollars from a price field: NaN when they are not a plain number from 0 to the most the server takes. */
export function dollarsFrom(text) {
    const trimmed = text.trim();
    const value = DOLLARS.test(trimmed) ? Number(trimmed.replace("$", "")) : Number.NaN;

    return value >= 0 && value <= MAX_PRICE ? value : Number.NaN;
}

/**
 * A model's price from its fields, with its tiers: `price` null when all are empty (it costs nothing; a cache price
 * left empty is 0), or `problem` when the fields say no price.
 */
export function priceFrom({ cost, tiers }) {
    const texts = PRICES.map(([part]) => [part, cost[part].trim()]);

    if (texts.every(([, text]) => text === "")) {
        return tiers.length === 0
            ? { price: null }
            : {
                  problem:
                      "Prices for long prompts need an input and output price, or remove them.",
              };
    }

    if (cost.input.trim() === "" || cost.output.trim() === "") {
        return { problem: "A price needs its input and output dollars." };
    }

    const rates = Object.fromEntries(
        texts.map(([part, text]) => [part, text === "" ? 0 : dollarsFrom(text)]),
    );

    return Object.values(rates).some(Number.isNaN)
        ? { problem: "A price is a plain number of dollars per million tokens, such as 0.15." }
        : { price: { ...rates, tiers } };
}

const sameTiers = (one, other) => JSON.stringify(one) === JSON.stringify(other);

/**
 * What a save sends of a model's limits, and what is wrong with them. A saved model (`start`, the text its fields
 * started with) sends only the fields that changed, the price as one, so a hand-made value the form cannot show stays
 * as it is; a new model sends all. A field sent empty is null: Pi's default, or no price. A saved model's price is sent
 * without its tiers when they did not change, so the server keeps them as they are.
 */
export function limitsChanges(limits, start) {
    const changes = {};
    const changed = (field) => start === undefined || limits[field].trim() !== start[field].trim();

    for (const [field, name] of [
        ["contextWindow", "context window"],
        ["maxTokens", "maximum output"],
    ]) {
        if (changed(field)) {
            const value = tokensFrom(limits[field]);

            if (Number.isNaN(value)) {
                return { problem: `The ${name} is a whole number of tokens, such as 131072.` };
            }

            changes[field] = value;
        }
    }

    const priceChanged =
        start === undefined ||
        PRICES.some(([part]) => limits.cost[part].trim() !== start.cost[part].trim()) ||
        !sameTiers(limits.tiers, start.tiers);

    if (priceChanged) {
        const { price, problem } = priceFrom(limits);

        if (problem !== undefined) {
            return { problem };
        }

        if (price && start !== undefined && sameTiers(limits.tiers, start.tiers)) {
            const { tiers: _kept, ...rates } = price;

            changes.cost = rates;
        } else {
            changes.cost = price;
        }
    }

    return { changes, problem: "" };
}

/**
 * A model's limits with what discovery said of it in the fields that are empty: its context window, its maximum
 * output, and its price with its tiers when no part of the price is set. Text that is there stays.
 */
export function fillLimits(limits, said) {
    const found = limitsText(said);
    const noPrice =
        PRICES.every(([part]) => limits.cost[part].trim() === "") && limits.tiers.length === 0;

    return {
        contextWindow:
            limits.contextWindow.trim() === "" ? found.contextWindow : limits.contextWindow,
        maxTokens: limits.maxTokens.trim() === "" ? found.maxTokens : limits.maxTokens,
        cost: noPrice ? found.cost : limits.cost,
        tiers: noPrice ? found.tiers : limits.tiers,
    };
}

/** Whether any of a model's context, output, or price fields has something in it. */
export const limitsSet = ({ contextWindow, maxTokens, cost, tiers }) =>
    tiers.length > 0 ||
    [contextWindow, maxTokens, ...Object.values(cost)].some((each) => each.trim() !== "");

/** A price as a button shows it: 3, 22.5, 0.15, 0.075, 0.00003. */
export const dollars = (value) =>
    value >= 0.1
        ? plainNumber(value, 2)
        : value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 2 });
