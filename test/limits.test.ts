import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, responseFacts } from "../src/server/limits.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const ask = (message: string, status?: number, headers: Record<string, string> = {}) =>
    classify({
        message,
        now,
        ...(status === undefined ? {} : { facts: { status, headers } }),
    });

test("what clears with time waits for that model until the time the provider gave", () => {
    assert.deepEqual(ask("429 rate_limit_error", 429), {
        type: "limit",
        scope: "model",
        backoff: true,
        reason: "429 rate_limit_error",
    });
    assert.equal(
        (ask("429", 429, { "retry-after": "120" }) as { resetAt: number }).resetAt,
        now + 120_000,
    );

    // The headers can identify a usage window when the message does not identify another cause.
    const claude = ask("Request rejected", 429, {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(now / 1000 + 3600),
    });
    const chatgpt = ask("You have hit your ChatGPT usage limit. Try again in ~95 min.");

    assert.deepEqual(
        [claude, chatgpt].map((each) => each.type === "limit" && each.scope),
        ["model", "model"],
    );
    assert.equal((chatgpt as { resetAt: number }).resetAt, now + 95 * 60_000);

    // Distinguish a 5-hour window from windows of days. An explicit usage limit takes precedence over a 429.
    const reset = String(now / 1000 + 4 * 3600);
    const five = ask("Request rejected", 429, {
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": reset,
    });
    const seven = ask("Request rejected", 429, {
        "anthropic-ratelimit-unified-7d-status": "rejected",
        "anthropic-ratelimit-unified-7d-reset": String(now / 1000 + 3 * 86400),
    });
    const weekly = ask("429 usage_limit_reached", 429, {
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "86400",
    });

    assert.equal((five as { resetAt: number; long?: true }).resetAt, now + 4 * 3_600_000);
    assert.deepEqual(
        [five, seven, weekly].map((each) => each.type === "limit" && each.long === true),
        [false, true, true],
    );
});

test("an overload with a full 10080-minute usage window uses the normal backoff", () => {
    const message = "server_is_overloaded: Our servers are currently overloaded";
    const reset = Date.parse("2026-11-27T17:40:00Z");
    const headers = {
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": String(reset / 1000),
    };

    for (const status of [200, 429, 503]) {
        assert.deepEqual(
            classify({
                message,
                facts: { status, headers },
                now: Date.parse("2026-11-24T02:46:00Z"),
            }),
            { type: "limit", scope: "model", backoff: true, reason: message },
        );
    }
});

test("an explicit rate limit honors Retry-After, not the usage window", () => {
    const message = "429 rate_limit_error";

    assert.deepEqual(
        ask(message, 429, {
            "anthropic-ratelimit-unified-7d-status": "rejected",
            "anthropic-ratelimit-unified-7d-reset": String(now / 1000 + 3 * 86_400),
            "retry-after": "30",
        }),
        {
            type: "limit",
            scope: "model",
            resetAt: now + 30_000,
            source: "header",
            backoff: false,
            reason: message,
        },
    );
});

test("a person's problem, a refused request, or a monthly plan limit never waits", () => {
    for (const [text, status] of [
        ["insufficient_quota: you exceeded your current quota", undefined],
        ["OAuth refresh failed for anthropic", undefined],
        ["Monthly usage limit reached. Enable available balance.", undefined],
        // A permanent 4xx never waits, whatever its text says.
        ["400 invalid_request_error: unsupported parameter 'rate_limit'", 400],
        // A plain 409 does not wait.
        ["409 Conflict: resource already exists", 409],
        // With no status (Google), a refusal whose text holds a number that looks like a 5xx.
        ["400 INVALID_ARGUMENT: contents exceed 500 tokens", undefined],
    ] as const) {
        assert.equal(ask(text, status).type, "other", text);
    }

    // A 409 waits only when a header gives the time.
    assert.equal(ask("409 Conflict", 409, { "retry-after": "5" }).type, "limit");
});

test("words near billing that ask for no money do not stop a wait", () => {
    // A rate limit that says the account is fine, or names a model with "recharge" in it, waits as any other.
    for (const text of [
        "429 Too Many Requests. Your account is in good standing; slow down.",
        "429 rate limit reached for model recharge-7b",
    ]) {
        assert.equal(ask(text, 429, { "retry-after": "30" }).type, "limit", text);
    }

    // The words that do ask for money still stop it.
    for (const text of [
        "403 Your account is not in good standing.",
        "429 Insufficient balance or no resource package. Please recharge.",
        "Please recharge your account to continue.",
    ]) {
        assert.equal(ask(text, 429).type, "other", text);
    }
});

test("OpenAI Subscription Sharing waits without a reset, but a window of days needs a reset time", () => {
    const message =
        "The ChatGPT user has reached their Subscription Sharing usage limit. " +
        "Ask the user to try again after their usage limit resets or use an API key instead.";

    for (const status of [undefined, 200, 403, 429]) {
        assert.deepEqual(ask(message, status), {
            type: "limit",
            scope: "model",
            backoff: true,
            subscription: true,
            reason: message,
        });
    }

    for (const message of [
        "subscription_sharing_usage_limit_exceeded",
        "Codex error: The usage limit has been reached",
        "Usage limit reached for the past 5 hours",
    ]) {
        assert.equal((ask(message) as { subscription?: true }).subscription, true);
    }

    const known = ask(message, 429, { "retry-after": "3600" });

    assert.equal((known as { resetAt: number }).resetAt, now + 3_600_000);
    assert.equal((known as { subscription?: true }).subscription, undefined);

    for (const message of [
        "Weekly usage limit reached",
        "Monthly usage limit reached",
        "Daily usage limit reached",
    ]) {
        assert.equal(ask(message).type, "other");
        assert.equal((ask(message, 429, { "retry-after": "60" }) as { long?: true }).long, true);
    }

    const streamedReset = ask(message, 200, { "retry-after": "3600" });

    assert.equal((streamedReset as { resetAt: number }).resetAt, now + 3_600_000);
    assert.equal(ask(message, 401).type, "other");
    assert.equal(ask(message, 402).type, "other");
    assert.equal(ask(`${message} insufficient_quota`, 429).type, "other");
});

test("a ChatGPT Business admin cap never waits, even with a retry time", () => {
    const message = "subscription_sharing_workplace_individual_usage_limit_exceeded";

    for (const status of [undefined, 429]) {
        assert.equal(ask(message, status, { "retry-after": "60" }).type, "other");
        assert.equal(
            ask(`${message}: ChatGPT workspace's usage limit`, status, {
                "retry-after": "60",
            }).type,
            "other",
        );
    }
});

test("a transient server failure may be about one conversation, not model load", () => {
    for (const message of [
        "Previous response owner account is unavailable; retry later.",
        "Invalid conversation ID",
    ]) {
        assert.equal(ask(message, 502, { "retry-after": "30" }).type, "request");
        assert.equal(ask(message, 400).type, "other");
    }

    for (const [message, status] of [
        ["Bad Gateway", 502],
        ["conversation service unavailable", 503],
        ["529 overloaded_error", 529],
        ["Too many requests", 429],
    ] as const) {
        const verdict = ask(message, status);

        assert.ok(verdict.type === "limit" && verdict.scope === "model", message);
    }
});

test("only limit headers are kept from a response, never a key or a token", () => {
    const kept = responseFacts(
        429,
        new Headers({ authorization: "Bearer secret", "x-api-key": "secret", "Retry-After": "30" }),
    );

    assert.deepEqual(kept, { status: 429, headers: { "retry-after": "30" } });
});
