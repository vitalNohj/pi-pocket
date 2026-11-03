import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { keepWarmFrom } from "../src/server/config.ts";
import type { SessionMeta } from "../src/server/docs.ts";
import { KeepWarm, type KeepWarmDeps } from "../src/server/keep-warm.ts";
import { cachePrices } from "../src/server/model-cache-facts.ts";
import { cleanUp, newSession, openApp, owner, scriptedModel } from "./helpers.ts";

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

const fakeDeps = (overrides: Partial<KeepWarmDeps> = {}): KeepWarmDeps => ({
    requireAccess: () => {},
    settings: () => keepWarmFrom({}),
    saveSettings: () => {},
    sessionMeta: () => undefined,
    rootOf: (id) => id,
    commitSession: async () => {},
    model: () => undefined,
    models: () => [],
    availableModels: () => [],
    keeper: {
        idleSummary: () => ({ warm: 0, refreshes: 0, spent: 0 }),
        idleStatus: () => ({ warm: false }),
        reconsider: () => {},
    },
    settingsChanged: async () => {},
    ...overrides,
});

test("keep warm: policy uses the owner's hours and excludes PiP, archived sessions, and disallowed subagents", () => {
    const settings = keepWarmFrom({ hours: 4 });
    const meta: SessionMeta = { cwd: "/tmp", createdAt: 0, updatedAt: 0 };
    const pip = 1 as ConversationId;
    const archived = 2 as ConversationId;
    const session = 3 as ConversationId;
    const subagent = 4 as ConversationId;
    const sessions = new Map<ConversationId, SessionMeta>([
        [pip, { ...meta, pip: "owner" }],
        [archived, { ...meta, archived: true }],
        [session, { ...meta }],
    ]);
    const keepWarm = new KeepWarm(
        fakeDeps({
            settings: () => settings,
            sessionMeta: (id) => sessions.get(id),
            rootOf: (id) => (id === subagent ? session : id),
        }),
    );

    assert.equal(keepWarm.policy(pip), undefined);
    assert.equal(keepWarm.policy(archived), undefined);
    assert.equal(keepWarm.policy(subagent), undefined);
    assert.equal(keepWarm.policy(session)?.hours, settings.hours);
});

test("keep warm: overview gives each model's refresh interval and Break-even cap", () => {
    const cached: Model<Api> = {
        ...model("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 }),
        provider: "anthropic",
        id: "cached-model",
        name: "Cached model",
        promptCache: { short: 3600 },
    };
    const keepWarm = new KeepWarm(
        fakeDeps({
            model: (provider, id) =>
                provider === cached.provider && id === cached.id ? cached : undefined,
            models: () => [cached],
            availableModels: () => [cached],
        }),
    );
    const overview = keepWarm.overview({
        id: "owner",
        name: "Owner",
        role: "owner",
        tokenHash: "",
        createdAt: 0,
    });

    assert.equal(overview.models.length, 1);
    assert.equal(overview.models[0]!.plan.everyMs, 2_700_000);
    assert.equal(overview.models[0]!.plan.refreshes, 30);
});

test("keep warm: a guest may turn a session's keep warm off, and only the owner turns it on", async () => {
    const app = await openApp(scriptedModel());

    try {
        const guest = app.config.addUser("Alex", "guest").user;
        const id = await newSession(app);

        for (const choice of ["break-even", 8, 1]) {
            assert.throws(() => app.keepWarm.checkChoice(guest, id, choice), /Only the owner/);
        }

        app.keepWarm.checkChoice(guest, id, 0);
        app.keepWarm.checkChoice(guest, id, "default");
        app.keepWarm.checkChoice(owner(app), id, 8);
        assert.throws(() => app.keepWarm.checkChoice(owner(app), id, 3), /must be/);
        await app.keepWarm.setSession(guest, id, 0);
        assert.equal(app.sessionMeta(id)?.keepWarm, 0);
        await assert.rejects(app.keepWarm.setSession(guest, id, "break-even"), /Only the owner/);

        // The owner's default is on: a guest's Default would turn the session back on.
        await app.keepWarm.setSettings(owner(app), { hours: "break-even" });
        await assert.rejects(app.keepWarm.setSession(guest, id, "default"), /Only the owner/);
        assert.equal(app.sessionMeta(id)?.keepWarm, 0);
        await app.keepWarm.setSession(owner(app), id, "break-even");
        assert.equal(app.sessionMeta(id)?.keepWarm, "break-even");
        await app.keepWarm.setSession(guest, id, "default");
        assert.equal(
            app.sessionMeta(id)?.keepWarm,
            undefined,
            "from a time back to Default is allowed",
        );

        // Someone who cannot see the session chooses nothing for it.
        const stranger = app.config.addUser("Bea", "viewer").user;

        assert.throws(() => app.keepWarm.checkChoice(stranger, id, 0));
    } finally {
        await app.close();
        cleanUp();
    }
});

test("keep warm: 30 minutes is the default; break-even saved as auto before 0.28 still reads as break-even", () => {
    assert.equal(keepWarmFrom({}).hours, 0.5);
    assert.equal(keepWarmFrom({ hours: 0.5 }).hours, 0.5);
    assert.equal(keepWarmFrom({ hours: "auto" }).hours, "break-even");
    assert.equal(keepWarmFrom({ hours: null }).hours, "break-even");
    assert.equal(keepWarmFrom({ hours: 3 }).hours, 0.5, "a time not on offer is the default");

    const meta: SessionMeta = {
        cwd: "/tmp",
        createdAt: 0,
        updatedAt: 0,
        keepWarm: "auto" as never,
    };
    const session = 3 as ConversationId;
    const keepWarm = new KeepWarm(
        fakeDeps({ settings: () => keepWarmFrom({ hours: 2 }), sessionMeta: () => meta }),
    );

    assert.equal(keepWarm.policy(session)?.hours, "break-even");
    assert.equal(keepWarm.session(session)?.choice, "break-even");
});
