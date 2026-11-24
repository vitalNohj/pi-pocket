// A run that failed with no answer that says so (its compaction failed) shows a lasting line in the open session,
// until a run starts again. A failed answer says it under itself already: no second line.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** Whether a summary is cut off at its limit. */
let failSummary = true;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let holdEvents: Promise<void> | undefined;

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script));
const failureLine = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector('[data-part="run-failure"]')?.textContent ?? null)`,
    );

const visibleTime = (selector: string) =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.dateTime ?? null);`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const faux = fauxProvider({
        tokensPerSecond: 100_000,
        models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 32_768 }],
    });

    faux.setResponses(
        Array.from({ length: 50 }, () => (context) => {
            const system = JSON.stringify(
                context.messages.filter((each) => each.role === "system"),
            );
            const { text } = lastText(context as never);

            if (system.includes("context summarization assistant")) {
                return failSummary
                    ? fauxAssistantMessage([fauxText("## Goal")], { stopReason: "length" })
                    : fauxAssistantMessage([fauxText("## Goal\nThe whole summary.")]);
            }

            if (text.endsWith("fail now")) {
                return fauxAssistantMessage([], {
                    stopReason: "error",
                    errorMessage: "Invalid request: unsupported parameter",
                });
            }

            return fauxAssistantMessage([fauxText(`ok: ${text.length}`)]);
        }),
    );
    app = await openApp(faux as never);
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer(async (request, response) => {
        if (/^\/api\/(events|poll)\?/.test(request.url ?? "")) {
            await holdEvents;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "run-failure-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a failed compaction shows a lasting line in the open session until a run starts",
    real,
    async () => {
        const id = await newSession(app);
        const failure = () => app.sessions().find((each) => each.id === Number(id))?.failure;

        failSummary = true;

        for (let turn = 0; turn < 8 && failure() === undefined; turn++) {
            await say(app, id, `turn ${turn} `.repeat(6_000));
        }

        assert.match(failure() ?? "", /Compaction failed/);
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await until(async () => (await failureLine()) !== null, "the failure line", 20_000);
        assert.match(
            (await failureLine()) ?? "",
            /Run failed: .*Compaction failed: Summarization hit the token limit/,
        );

        const stamp = app.sessions().find((each) => each.id === Number(id))?.failureAt;

        assert.ok(stamp, "the server recorded when the run failed");
        const selector = '[data-part="run-failure"] time';
        const sameTime = () =>
            inPage<boolean>(`
            const { store } = await import('/store.js');
            const { fromServer } = await import('/seen.js');
            const failed = store.state.sessions.find(each => each.id === ${id});
            const time = document.querySelector(${JSON.stringify(selector)});
            return JSON.stringify(failed?.failureAt === ${stamp} && time?.dateTime === new Date(fromServer(${stamp})).toISOString());
        `);

        assert.ok(await sameTime());
        await page.reload();
        await until(sameTime, "the same stored run failure time after reload");
        await page.evaluate(
            `(await import('/slots.js')).setShown('reply', 'core:time', false); return 'null';`,
        );
        await until(
            async () => (await visibleTime(selector)) === null,
            "Layout hides the run failure time",
        );
        assert.match((await failureLine()) ?? "", /Compaction failed/);
        await page.evaluate(
            `(await import('/slots.js')).setShown('reply', 'core:time', true); return 'null';`,
        );

        // The next run compacts: the line goes.
        failSummary = false;
        await say(app, id, "again");
        await until(async () => (await failureLine()) === null, "the line to go", 20_000);
    },
);

test(
    "a failed answer keeps its message time on reconnect and reload without a second error line",
    real,
    async () => {
        const id = await newSession(app);

        await page.navigate(`${base}/s/${id}`);
        await until(
            () =>
                inPage<boolean>(`
        const { store } = await import('/store.js');
        return JSON.stringify(store.state.connection === 'open' && store.state.view.conversation?.id === ${id});
    `),
            "the live session",
        );

        const hold = Promise.withResolvers<void>();

        holdEvents = hold.promise;
        server.closeAllConnections();

        try {
            await app.commands.submit(id, owner(app), {
                text: "fail now",
                requestId: "run-failure-ui",
            });
            await until(
                () => app.sessions().find((each) => each.id === Number(id))?.failed === true,
                "the run to fail while the browser is disconnected",
            );
        } finally {
            holdEvents = undefined;
            hold.resolve();
        }

        const selector = ".reply:has(.error-box) time";
        const sameTime = () =>
            inPage<boolean>(`
        const { store } = await import('/store.js');
        const { fromServer } = await import('/seen.js');
        const entry = [...store.state.view.entries.values()].find(each => each.stopReason === 'error');
        const time = document.querySelector(${JSON.stringify(selector)});
        return JSON.stringify(Boolean(entry?.at && time?.dateTime === new Date(fromServer(entry.at)).toISOString()));
    `);

        await until(sameTime, "the failed answer and its message time after reconnect", 20_000);
        assert.equal(await failureLine(), null);
        await page.reload();
        await until(sameTime, "the failed answer and its message time after reload", 20_000);
        assert.equal(await failureLine(), null);
    },
);

/** The views here use recorded server times. No matter where the failure is drawn, Layout controls the same clock. */
test(
    "stops, tool errors and linked and subagent results use the same message time as failed replies",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "A reply to keep the transcript open");
        await page.navigate(`${base}/s/${id}`);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('[data-part="reply"]') !== null);`,
                ),
            "the transcript",
        );

        // Keep the browser and its real render paths. Supply committed entries of the shapes produced by the runtime.
        await page.evaluate(`
        const { store } = await import('/store.js');
        const { setPrefs } = await import('/theme.js');
        const { view, server } = store.state;
        const stamp = Date.now() - 600_000;
        const start = Math.max(0, ...view.order);
        const rows = [];
        const add = (entry) => rows.push({ id: start + rows.length + 1, at: stamp + rows.length * 60_000, ...entry });
        const reply = (stopReason, blocks, error) => add({ kind: 'assistant', stopReason, blocks, error });
        const prompt = (text) => add({ kind: 'user', text, images: 0 });
        const tool = (id, text) => {
            reply('toolUse', [{ type: 'toolCall', name: 'read', id, args: { path: 'test.txt' } }]);
            add({ kind: 'toolResult', name: 'read', callId: id, isError: true, text });
        };

        prompt('Failed request');
        reply('error', [{ type: 'text', text: 'Partial reply' }], 'Request failed after some text.');
        prompt('Stop a model request');
        reply('aborted', []);
        prompt('Read a missing file');
        tool('missing', 'No such file');
        prompt('[subagent reader failed: Bad request]');
        prompt('[via linked session B2] Linked session B2 failed: its run gave up.\\n<linked-session-message>\\nA failed result.\\n</linked-session-message>');
        prompt('[goal] \`test\` still fails (exit 1). Test output.');
        prompt('[background] Task B7 exited with code 1 after 1s.\\nCommand: test\\nIt printed nothing.');
        add({ kind: 'shell', command: 'test', output: 'error', status: 'done', code: 1, name: 'Owner' });
        tool('aborted', 'Operation aborted.');

        // An owner with collaboration enabled gets reply actions when the failed reply has words.
        setPrefs({ foldActivity: false });
        store.set({
            server: { ...server, collab: 2 },
            view: {
                ...view,
                order: [...view.order, ...rows.map(row => row.id)],
                entries: new Map([...view.entries, ...rows.map(row => [row.id, row])]),
            },
        });
        window.failureTimeFixtures = rows;
        return 'null';
    `);

        const selectors = [
            ".reply:has(.error-box) time",
            ".reply:has(> .muted.small) time",
            '[data-part="tool-call"][data-status="error"] time',
            ".report.failed:has(.report-why) time",
            ".linked-message time",
            '[data-part="tool-call"][data-status="stopped"] time',
            ".report.failed:has(.report-name.mono) time",
            ".background-report time",
            ".shell-card.failed time",
        ];
        const hasTimes = (shown: boolean) =>
            inPage<boolean>(`
        const { fromServer } = await import('/seen.js');
        const { clockTime } = await import('/ui.js');
        const rows = window.failureTimeFixtures;
        const nodes = ${JSON.stringify(selectors)}.map(selector => [...document.querySelectorAll(selector)]);
        const stamps = [[1], [3, 13], [6], [7], [8], [13], [9], [10], [11]];
        const checks = nodes.map((times, index) => {
            if (!${shown}) return times.length === 0;
            const expected = stamps[index].map(i => new Date(fromServer(rows[i].at)));
            return times.length === expected.length && times.every((time, i) =>
                time.dateTime === expected[i].toISOString() && time.textContent.trim() === clockTime(expected[i]));
        });
        return JSON.stringify(checks.every(Boolean));
    `);

        // Earlier groups can start folded on a fresh tab. Open them to read the failure itself.
        await page.evaluate(`
        for (const head of document.querySelectorAll('.activity-head[aria-expanded="false"]')) head.click();
        return 'null';
    `);
        await until(() => hasTimes(true), "one correctly formatted time for each failure row");
        const actions = await inPage<number>(
            `return JSON.stringify(document.querySelectorAll('.reply:has(.error-box) button.answer-tool').length);`,
        );

        assert.ok(
            actions > 0,
            "a failed reply with words still has reply actions and only one time",
        );
        await page.evaluate(
            `(await import('/slots.js')).setShown('reply', 'core:time', false); return 'null';`,
        );
        await until(
            () => hasTimes(false),
            "Layout hides time on every failure without hiding the rows",
        );
        await page.evaluate(
            `(await import('/slots.js')).setShown('reply', 'core:time', true); return 'null';`,
        );
        await until(() => hasTimes(true), "Layout shows time again");
    },
);
