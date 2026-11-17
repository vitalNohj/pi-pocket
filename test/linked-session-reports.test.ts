import {
    type App,
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AppEvents } from "../src/server/app-events.ts";

after(cleanUp);

type RunEnd = AppEvents["run.ended"];

/** Capture a second watcher without subscribing it, so a test can await delivery rather than race the event bus. */
function reporter(app: App, t: TestContext) {
    let report!: (run: RunEnd) => unknown;
    const on = t.mock.method(app.events, "on", (event: keyof AppEvents, listener: unknown) => {
        assert.equal(event, "run.ended");
        report = listener as (run: RunEnd) => unknown;

        return () => {};
    });

    app.linkedSessions.watch();
    on.mock.restore();

    return report;
}

const model = () =>
    scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        if (role === "user" && text.includes("FAIL_NOW")) {
            return {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "the model fell over",
            } as never;
        }

        if (role === "user" && text.includes("WAIT_FOR_STOP")) {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });

for (const report of [undefined, "all", "none"] as const) {
    test(`linked run reports with report=${String(report)} cover done, failed, and aborted`, async (t) => {
        const app = await openApp(model(), join(root, `outcomes-${String(report)}`));
        const ended: RunEnd[] = [];
        const detach = app.events.on("run.ended", (run) => ended.push(run));
        const deliver = reporter(app, t);

        try {
            const lead = await newSession(app);

            await say(app, lead, "hello");
            const received = t.mock.method(app.commands, "submit");
            const notice = t.mock.method(app, "notice");

            for (const [outcome, message] of [
                ["done", "a task"],
                ["failed", "FAIL_NOW"],
                ["aborted", "WAIT_FOR_STOP"],
            ] as const) {
                const child = await app.linkedSessions.start(lead, { message, report }, outcome);

                if (outcome === "aborted") {
                    await until(() => app.isBusy(child.session), "the run to start");
                    await app.linkedSessions.stop(lead, { to: child.address }, "stop");
                }

                await until(
                    () => ended.some((run) => run.conversationId === Number(child.session)),
                    `the ${outcome} run to end`,
                );
                const run = ended.find((each) => each.conversationId === Number(child.session))!;

                assert.equal(run.outcome, outcome);
                // The real watcher also runs. Awaiting its idempotent repeat drains the same report path.
                await deliver(run);
                assert.ok(
                    app.sessions(owner(app)).some((each) => each.id === Number(child.session)),
                );
                assert.ok(
                    (await app.linkedSessions.list(lead)).some(
                        (each) => each.address === child.address,
                    ),
                );
            }

            const reports = received.mock.calls.filter((call) => call.arguments[0] === lead);
            const text = (await modelTexts(app, lead)).join("\n");

            if (report === "none") {
                assert.equal(
                    reports.length,
                    0,
                    "no automatic message is even submitted to the lead",
                );
                assert.equal(
                    notice.mock.calls.filter((call) => call.arguments[2] === lead).length,
                    0,
                    "suppression needs no fallback notice at the lead",
                );
                assert.doesNotMatch(
                    text,
                    /Linked session \S+ (?:finished its run|failed|was stopped)/,
                );
            } else {
                // Both watchers can attempt delivery; the durable request key admits each report only once.
                await until(
                    async () =>
                        (await modelTexts(app, lead)).filter(
                            (item) =>
                                item.startsWith('"') &&
                                /Linked session \S+ (?:finished its run|failed|was stopped)/.test(
                                    item,
                                ),
                        ).length === 3,
                    "the three default reports",
                );
            }
        } finally {
            detach();
            await app.close();
        }
    });
}

test("report policy survives a restart and a repeated start keeps the first policy", async (t) => {
    const data = join(root, "restart");
    let app = await openApp(model(), data);

    try {
        const lead = await newSession(app);

        await say(app, lead, "hello");
        const silent = await app.linkedSessions.start(
            lead,
            { message: "a task", report: "none" },
            "silent",
        );
        const automatic = await app.linkedSessions.start(lead, { message: "a task" }, "automatic");

        await until(
            () => !app.isBusy(silent.session) && !app.isBusy(automatic.session),
            "the initial runs to finish",
        );
        await reporter(
            app,
            t,
        )({
            conversationId: Number(automatic.session),
            session: Number(automatic.session),
            outcome: "done",
        });
        await until(() => !app.isBusy(lead), "the lead to finish");
        await app.close();
        app = await openApp(model(), data);
        const deliver = reporter(app, t);
        const ended: RunEnd[] = [];
        const detach = app.events.on("run.ended", (run) => ended.push(run));
        const received = t.mock.method(app.commands, "submit");

        assert.equal(app.sessionMeta(silent.session)?.linkedFrom?.report, "none");
        assert.equal(app.sessionMeta(automatic.session)?.linkedFrom?.report, undefined);
        assert.deepEqual(
            await app.linkedSessions.start(lead, { message: "changed", report: "all" }, "silent"),
            silent,
        );
        assert.deepEqual(
            await app.linkedSessions.start(
                lead,
                { message: "changed", report: "none" },
                "automatic",
            ),
            automatic,
        );
        assert.equal(app.sessionMeta(silent.session)?.linkedFrom?.report, "none");
        assert.equal(app.sessionMeta(automatic.session)?.linkedFrom?.report, undefined);
        const baseline = (await modelTexts(app, lead)).filter((text) =>
            text.startsWith('"'),
        ).length;

        assert.deepEqual(
            await app.linkedSessions.send(
                lead,
                { to: silent.address, message: "more work" },
                "silent-again",
            ),
            { answers: false },
        );
        assert.deepEqual(
            await app.linkedSessions.send(
                lead,
                { to: automatic.address, message: "more work" },
                "automatic-again",
            ),
            { answers: true },
        );

        for (const child of [silent, automatic]) {
            await until(
                () => ended.some((run) => run.conversationId === Number(child.session)),
                "the restarted child to finish",
            );
            await deliver(ended.find((run) => run.conversationId === Number(child.session))!);
        }

        await until(
            async () =>
                (await modelTexts(app, lead)).filter((text) => text.startsWith('"')).length ===
                baseline + 1,
            "only the automatic child's report",
        );
        assert.ok(
            received.mock.calls
                .filter((call) => call.arguments[0] === lead)
                .every((call) => call.arguments[2].text.includes(automatic.address)),
        );
        const messages = (await modelTexts(app, silent.session)).filter(
            (text) => text.startsWith('"') && text.includes("<linked-session-message>"),
        );

        assert.equal(messages.length, 2, "replaying start sent no new first message");
        assert.ok(
            messages.every((text) => /Automatic run reports to that session are off/.test(text)),
        );
        assert.ok(
            messages.every(
                (text) =>
                    !/your final answer reaches it by itself|when the message asks for an answer or a result, send it/.test(
                        text,
                    ),
            ),
        );
        const [origin] = await app.linkedSessions.list(silent.session);

        assert.ok(origin);
        assert.deepEqual(
            await app.linkedSessions.send(
                silent.session,
                { to: origin.address, message: "an explicit result" },
                "manual-result",
            ),
            { answers: false },
        );
        await until(
            async () =>
                (await modelTexts(app, lead)).some(
                    (text) => text.startsWith('"') && text.includes("an explicit result"),
                ),
            "the explicit result",
        );
        detach();
    } finally {
        await app.close();
    }
});

test("an invalid report policy is refused before a linked session is made", async () => {
    const app = await openApp(model(), join(root, "invalid"));

    try {
        const lead = await newSession(app);

        await say(app, lead, "hello");
        const count = app.sessions().length;

        for (const report of ["errors", "", false, null]) {
            await assert.rejects(
                app.linkedSessions.start(
                    lead,
                    { message: "a task", report: report as never },
                    crypto.randomUUID(),
                ),
                /Report must be all or none/,
            );
            assert.equal(app.sessions().length, count);
        }
    } finally {
        await app.close();
    }
});
