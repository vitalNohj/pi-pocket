import {
    type App,
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, LiveDoc, ToolResultEntry } from "@earendil-works/pi-durable";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function stream(t: TestContext) {
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app), 3);

    t.mock.timers.enable({ apis: ["setTimeout"] });
    await app.attach(tab.client);
    t.after(() => app.detach(tab.client));
    t.mock.timers.tick(90);

    const views = () =>
        tab.events.flatMap(({ event, data }) =>
            event === "view" && data.full === false ? [data] : [],
        );

    tab.events.length = 0;

    return { id, tab, views, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("first useful text goes early; later text is coalesced and based on what the tab got", async (t) => {
    const { id, tick, views, tab } = await stream(t);

    const partial = async (text: string) => {
        await app.harness.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, id);

            live.generation = { attempt: 1, message: fauxAssistantMessage([fauxText(text)]) };
        }, context);
        await setImmediate();
    };

    const message = () =>
        (tab.last("view")?.live as { generation?: { message?: unknown } })?.generation?.message;

    await partial(" ");
    tick(30);
    assert.equal(views().length, 0, "blank text does not go early");
    await partial("Hel");
    tick(30);
    assert.equal(views().length, 1, "first text arrived before the 90 ms timer");
    assert.deepEqual(message(), { blocks: [{ type: "text", text: "Hel" }] });

    await partial("Hell");
    tick(10);
    await partial("Hello");
    tick(79);
    assert.equal(views().length, 1, "later deltas wait for the ordinary timer");
    tick(1);
    assert.equal(views().length, 2, "the ordinary timer sends both deltas together");
    assert.deepEqual(message(), { keep: 0, blocks: [{ type: "text", from: 3, text: "lo" }] });
});

test("text that first appears in a committed assistant entry also goes early", async (t) => {
    const { id, tick, views } = await stream(t);
    const answer = await app.harness.commit(
        (tx) =>
            tx.appendEntry(AssistantEntry, id, {
                model: [fauxAssistantMessage([fauxText("Complete answer")])],
            }),
        context,
    );

    await setImmediate();
    tick(30);

    const view = views()[0];

    assert.ok(view, "the answer arrived before the 90 ms timer");
    assert.deepEqual(view.order, [answer.id]);
    assert.deepEqual((view.entries as { blocks: unknown }[])[0]?.blocks, [
        { type: "text", text: "Complete answer" },
    ]);
});

test("a tool result goes early only after its commit, with the call before the result", async (t) => {
    const { id, tick, views } = await stream(t);
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const commit = app.harness.commit(async (tx) => {
        const call = await tx.appendEntry(AssistantEntry, id, {
            model: [
                fauxAssistantMessage(
                    [fauxToolCall("read", { path: "test.txt" }, { id: "read-1" })],
                    {
                        stopReason: "toolUse",
                    },
                ),
            ],
        });
        const result = await tx.appendEntry(ToolResultEntry, id, {
            model: [
                {
                    role: "toolResult",
                    toolCallId: "read-1",
                    toolName: "read",
                    content: [fauxText("One line")],
                    isError: false,
                    timestamp: Date.now(),
                },
            ],
            data: { diagnostics: [] },
        });

        staged.resolve();
        await release.promise;

        return [call.id, result.id];
    }, context);

    try {
        await Promise.race([staged.promise, commit]);
        tick(90);
        assert.equal(views().length, 0, "the open transaction has not published either entry");
    } finally {
        release.resolve();
        await commit;
    }

    await setImmediate();
    tick(30);

    const view = views()[0];

    assert.ok(view, "the stored result arrived before the 90 ms timer");
    assert.deepEqual(view.order, await commit);
    assert.deepEqual(
        (view.entries as { kind: string }[]).map((entry) => entry.kind),
        ["assistant", "toolResult"],
    );
    tick(90);
    assert.equal(views().length, 1, "the old timer does not repeat the result");
});
