import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, mock, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
const box = ".composer textarea";
const card = ".inbox .queued";
const mode = `${card} .queued-mode`;
const edit = `${card} .queued-actions button:nth-child(1)`;
const move = `${card} .queued-actions button:nth-child(2)`;
const interrupt = `${card} .queued-actions button:nth-child(3)`;
const queuedText = "Please wait for the answer";
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
const responses = new Map<string, number>();

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            const { text } = lastText(request as never);

            return text === "Start Bash"
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("bash", {
                              command:
                                  "touch bash-started; while [ ! -f release-bash ]; do sleep 0.1; done",
                              timeout: 30,
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
        }),
    );
    const listen = { host: "127.0.0.1", port: 0 };
    const handler = createHandler({ app, listen, restart: () => {} });

    server = createServer((request, response) => {
        const path = request.url;

        if (request.method === "POST" && path !== undefined && /\/(move|edit-queued)$/.test(path)) {
            response.once("finish", () => responses.set(path, response.statusCode));
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, listen.host, resolve));
    base = `http://${listen.host}:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "queue-move-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 808, height: 555, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

function textOf(selector: string): Promise<string> {
    return page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? ""`,
    );
}

async function send(text: string, keys = "Enter"): Promise<void> {
    await page.type({ selector: box }, text);
    await until(
        async () =>
            (await page.evaluate(
                `!!document.querySelector('.composer button[aria-label="Send"]:enabled')`,
            )) === "true",
        "the Send button to enable",
    );
    await page.press(keys);
}

async function click(selector: string): Promise<void> {
    assert.equal((await page.click({ selector })).covered, undefined);
}

async function interruptNow(): Promise<void> {
    await click(interrupt);
    await until(async () => (await textOf(interrupt)) === "Interrupt now?", "the confirmation");
    await click(interrupt);
}

async function posted(id: ConversationId, endpoint: string, status: number): Promise<void> {
    const path = `/api/c/${id}/${endpoint}`;

    await until(() => responses.has(path), `the ${endpoint} response`);
    assert.equal(responses.get(path), status);
}

/** Queue a message while a real Bash tool waits. The test decides when Bash finishes. */
async function startQueued(t: TestContext, label = "Steer") {
    const cwd = mkdtempSync(join(work, "queue-"));
    const id = await newSession(app, cwd);
    const releaseBash = () => writeFileSync(join(cwd, "release-bash"), "");

    t.after(releaseBash);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await page.evaluate(`!!document.querySelector(${JSON.stringify(box)})`)) === "true",
        "the message box",
    );
    await send("Start Bash");
    await until(() => existsSync(join(cwd, "bash-started")), "Bash to start");
    await until(async () => (await textOf(".scroller")).includes("bash"), "Bash in the browser");
    await send(queuedText, label === "Queue" ? "Control+Enter" : "Enter");
    await until(async () => (await textOf(mode)).startsWith(label), `a ${label} card`);
    await click(`${card} .queued-text`);
    await until(async () => (await textOf(edit)) === "Edit", "the queued actions");

    return { id, releaseBash };
}

/** Delay the tab's view events, not its HTTP requests or the queue changes on the server. */
function delayViews(t: TestContext, id: ConversationId): () => void {
    const client = [...app.clients].find((client) => client.conversationId === id);

    assert.ok(client, "the browser's event stream");
    const send = client.send.bind(client);
    const pending: (() => void)[] = [];
    const delayed = mock.method(client, "send", (event: string, data: unknown) => {
        if (event === "view") {
            pending.push(() => send(event, data));
        } else {
            send(event, data);
        }
    });
    let holding = true;

    const release = () => {
        if (!holding) {
            return;
        }

        holding = false;
        delayed.mock.restore();

        for (const deliver of pending) {
            deliver();
        }
    };

    t.after(release);

    return release;
}

const inbox = async (id: ConversationId) =>
    (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

test(
    "a successful move to Queue shows on the card before the view update arrives",
    real,
    async (t) => {
        const { id, releaseBash } = await startQueued(t);
        const releaseViews = delayViews(t, id);

        assert.equal(await textOf(move), "Move to queue");
        await click(move);
        await posted(id, "move", 200);
        assert.equal((await inbox(id))[0]?.mode, "followUp");
        assert.equal(app.isBusy(id), true);
        await until(
            async () => (await textOf(mode)).startsWith("Queue"),
            "the Queue label with view events still delayed",
            2500,
        );
        assert.equal(await textOf(move), "Steer now");
        releaseViews();
        releaseBash();
        await until(() => !app.isBusy(id), "Pi to finish both messages");
        await until(
            async () => (await textOf(".scroller")).includes("echo: Please wait for the answer"),
            "the queued message's answer",
        );
        assert.equal(await textOf(card), "");
    },
);

test("Steer now shows on the card before the view update arrives", real, async (t) => {
    const { id, releaseBash } = await startQueued(t, "Queue");
    const releaseViews = delayViews(t, id);

    assert.equal(await textOf(move), "Steer now");
    await click(move);
    await posted(id, "move", 200);
    assert.equal((await inbox(id))[0]?.mode, "steer");
    assert.equal(app.isBusy(id), true);
    await until(
        async () => (await textOf(mode)).startsWith("Steer"),
        "the Steer label with view events still delayed",
        2500,
    );
    assert.equal(await textOf(move), "Move to queue");
    releaseViews();
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish both messages");
});

test(
    "Edit returns the text and removes the card before the view update arrives",
    real,
    async (t) => {
        const { id, releaseBash } = await startQueued(t);
        const releaseViews = delayViews(t, id);

        await click(edit);
        await posted(id, "edit-queued", 200);
        assert.equal((await inbox(id)).length, 0);
        assert.equal(app.isBusy(id), true);
        await until(
            async () =>
                (await page.evaluate(`document.querySelector(${JSON.stringify(box)}).value`)) ===
                queuedText,
            "the edited text in the message box",
        );
        assert.equal(await textOf(card), "", "the card without a view update");
        releaseViews();
        releaseBash();
        await until(() => !app.isBusy(id), "Bash to finish");
    },
);

test("Interrupt now shows Sending before the view update removes the card", real, async (t) => {
    const { id } = await startQueued(t);
    const releaseViews = delayViews(t, id);

    await interruptNow();
    await posted(id, "move", 200);
    await until(
        async () => (await textOf(mode)).startsWith("Sending..."),
        "the Sending label with view events still delayed",
        2500,
    );
    assert.equal(await textOf(`${card} .queued-actions`), "");
    assert.equal(
        await page.evaluate(`!!document.querySelector('${card} .queued-remove')`),
        "false",
    );
    releaseViews();
    await until(async () => (await textOf(card)) === "", "the sent card to leave the queue");
    await until(
        async () => (await textOf(".scroller")).includes(`echo: ${queuedText}`),
        "the interrupted message's answer",
    );
    await until(() => !app.isBusy(id), "Pi to finish answering");
});

for (const [label, endpoint, act] of [
    ["Move to queue", "move", () => click(move)],
    ["Edit", "edit-queued", () => click(edit)],
    ["Interrupt now", "move", interruptNow],
] as const) {
    test(`${label} on a stale card keeps it and says it has gone to Pi`, real, async (t) => {
        const { id, releaseBash } = await startQueued(t);
        const releaseViews = delayViews(t, id);

        releaseBash();
        await until(
            async () => (await inbox(id)).length === 0,
            "Pi to take the Steer at the tool boundary",
        );
        await act();
        await posted(id, endpoint, 409);
        await until(
            async () =>
                (await textOf(".notice.error .notice-text")) ===
                "That message has already gone to Pi.",
            `the failed ${label}'s reason`,
        );
        assert.ok((await textOf(mode)).startsWith("Steer"), "the card is still queued in the tab");
        assert.equal(await textOf(edit), "Edit", "the queued actions are still available");
        assert.equal(
            await page.evaluate(`document.querySelector(${JSON.stringify(box)}).value`),
            "",
        );
        releaseViews();
        await until(async () => (await textOf(card)) === "", "the sent card to leave the queue");
        await until(() => !app.isBusy(id), "Pi to finish answering");
    });
}
