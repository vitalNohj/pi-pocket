import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, mock, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import { json } from "../src/server/http/io.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
const box = ".composer textarea";
const card = ".inbox .queued:first-child";
const mode = `${card} .queued-mode`;
const edit = `${card} .queued-actions button:nth-child(1)`;
const move = `${card} .queued-actions button:nth-child(2)`;
const interrupt = `${card} .queued-actions button:nth-child(3)`;
const withdraw = `${card} .queued-remove`;
const errorNotice = ".notice.error .notice-text";
const staleError = "That message has already gone to Pi.";
const heldReplies = new Map<string, { capture(response: ServerResponse): void; answer?: object }>();
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

        if (request.method === "POST" && path !== undefined) {
            const held = heldReplies.get(path);

            if (held) {
                response.once("finish", () => responses.set(path, response.statusCode));
                held.capture(response);

                if (held.answer) {
                    request.resume();
                    json(response, 409, held.answer);

                    return;
                }
            }
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

function boxText(): Promise<string> {
    return page.evaluate(`document.querySelector(${JSON.stringify(box)}).value`);
}

/** Hold the reply body even when the server has finished the action and sent its view. */
function holdReply(t: TestContext, id: ConversationId, endpoint: string, answer?: object) {
    const path = `/api/c/${id}/${endpoint}`;
    const endings: (() => void)[] = [];
    let requests = 0;
    let holding = true;

    const release = () => {
        holding = false;

        for (const end of endings.splice(0)) {
            end();
        }
    };

    heldReplies.set(path, {
        answer,
        capture(response) {
            requests += 1;
            const end = response.end.bind(response);

            // The JSON sender uses writeHead() and end(body). Nothing is written to the socket until end().
            mock.method(response, "end", (body: string | Buffer) => {
                if (holding) {
                    endings.push(() => end(body));
                } else {
                    end(body);
                }

                return response;
            });
        },
    });
    t.after(() => {
        release();
        heldReplies.delete(path);
    });

    return {
        release,
        received: () => requests,
        ready: () => endings.length > 0,
    };
}

async function posted(id: ConversationId, endpoint: string, status: number): Promise<void> {
    const path = `/api/c/${id}/${endpoint}`;

    await until(() => responses.has(path), `the ${endpoint} response`);
    assert.equal(responses.get(path), status);
}

/** Queue a message while a real Bash tool waits. The test decides when Bash finishes. */
async function startQueued(
    t: TestContext,
    label = "Steer",
    prepare?: (id: ConversationId, cwd: string) => Promise<void>,
) {
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

    if (prepare) {
        await prepare(id, cwd);
    } else {
        await send(queuedText, label === "Queue" ? "Control+Enter" : "Enter");
    }

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

const actions = [
    { label: "Move to queue", selector: move, endpoint: "move", from: "Steer", pending: "Queue" },
    { label: "Steer now", selector: move, endpoint: "move", from: "Queue", pending: "Steer" },
    { label: "Edit", selector: edit, endpoint: "edit-queued", from: "Steer", pending: "" },
    {
        label: "Interrupt now",
        selector: interrupt,
        endpoint: "move",
        from: "Steer",
        pending: "Sending...",
    },
    {
        label: "Withdraw",
        selector: withdraw,
        endpoint: "withdraw",
        from: "Steer",
        pending: "Withdrawing...",
    },
] as const;

type Action = (typeof actions)[number];

async function act(action: Action): Promise<void> {
    if (action.selector === interrupt) {
        await click(interrupt);
        await until(async () => (await textOf(interrupt)) === "Interrupt now?", "the confirmation");
    }

    // The first click is a pointer click. Keep the original target so we can also try a repeated click when
    // the card or its buttons are no longer in the document.
    await page.evaluate(
        `window.queueButton = document.querySelector(${JSON.stringify(action.selector)}); "ready"`,
    );
    await click(action.selector);
}

async function checkPending(action: Action, draft = queuedText): Promise<void> {
    assert.ok((await textOf(mode)).startsWith(action.pending), "the label before either reply");

    if (action.selector === edit) {
        assert.equal(await textOf(card), "", "the original card is hidden");
        assert.equal(await boxText(), draft);
        assert.equal(
            await page.evaluate(
                `!!document.querySelector('.composer .send-button:disabled .spinner')`,
            ),
            "true",
        );
    } else {
        assert.equal(
            await page.evaluate(
                `!!document.querySelector('${mode} .spinner') && !document.querySelector('${card} button:enabled')`,
            ),
            "true",
            "a spinner shows and no button on the card is enabled",
        );

        if (action.selector === interrupt) {
            assert.equal(await textOf(`${card} .queued-actions`), "");
            assert.equal(await page.evaluate(`!!document.querySelector('${withdraw}')`), "false");
        }
    }

    await page.evaluate('window.queueButton.click(); "repeated"');
}

for (const action of actions) {
    test(
        `${action.label} updates immediately, even with the reply and view held`,
        real,
        async (t) => {
            const { id, releaseBash } = await startQueued(t, action.from);
            const releaseViews = delayViews(t, id);
            const reply = holdReply(t, id, action.endpoint);

            await act(action);
            await checkPending(action);
            await until(reply.ready, "the server's held success reply");
            assert.equal(reply.received(), 1);

            const remaining = await inbox(id);

            if (action.selector === move) {
                assert.equal(remaining[0]?.mode, action.pending === "Queue" ? "followUp" : "steer");
            } else {
                assert.equal(remaining.length, 0);
            }

            // Interrupt exercises a view that removes the card before the HTTP reply.
            const viewFirst = action.selector === interrupt;

            if (viewFirst) {
                releaseViews();
                await until(async () => (await textOf(card)) === "", "the view to remove the card");
                assert.equal(responses.has(`/api/c/${id}/${action.endpoint}`), false);
            }

            reply.release();
            await posted(id, action.endpoint, 200);

            if (action.selector === move) {
                await until(
                    async () =>
                        (await page.evaluate(`!!document.querySelector('${move}:enabled')`)) ===
                        "true",
                    "move to unlock",
                );
                assert.ok((await textOf(mode)).startsWith(action.pending));
            } else {
                await until(async () => (await textOf(card)) === "", "the card to leave the queue");
            }

            if (!viewFirst) {
                releaseViews();
            }

            releaseBash();
            await until(() => !app.isBusy(id), "Pi to finish");
            await until(async () => (await textOf(card)) === "", "the queue to empty");
            assert.equal(await boxText(), action.selector === edit ? queuedText : "");
            assert.equal(reply.received(), 1);
        },
    );

    test(`${action.label} rolls back and shows the 409 reason`, real, async (t) => {
        const { id, releaseBash } = await startQueued(t, action.from);
        const releaseViews = delayViews(t, id);
        // The legacy Withdraw API reports a stale submission in a 200 body. Also exercise an HTTP error for it.
        const reply = holdReply(
            t,
            id,
            action.endpoint,
            action.selector === withdraw ? { error: staleError } : undefined,
        );

        await page.type({ selector: box }, "Unsent draft");
        releaseBash();
        await until(
            async () => (await inbox(id)).length === 0,
            "Pi to take the message at the tool boundary",
        );
        await act(action);
        await checkPending(action, queuedText + "\nUnsent draft");
        await until(reply.ready, "the server's held conflict reply");
        assert.equal(reply.received(), 1);

        reply.release();
        await posted(id, action.endpoint, 409);
        await until(async () => (await textOf(errorNotice)) === staleError, "the conflict reason");
        assert.ok(
            (await textOf(mode)).startsWith(action.from),
            "the card is back in its original mode",
        );
        assert.equal(await boxText(), "Unsent draft");
        assert.equal(await textOf(edit), "Edit");
        releaseViews();
        await until(async () => (await textOf(card)) === "", "the newer view to remove the card");
        assert.equal(reply.received(), 1);
    });
}

for (const sent of [true, false]) {
    test(
        `Edit takes back a card while another send ${sent ? "succeeds" : "fails"}`,
        real,
        async (t) => {
            const { id, releaseBash } = await startQueued(t);
            const releaseViews = delayViews(t, id);
            const editReply = holdReply(t, id, "edit-queued");
            const outgoing = "A separate message on its way";
            const refusal = "The other message could not go.";
            const sendReply = holdReply(t, id, "submit", sent ? undefined : { error: refusal });

            await send(outgoing);
            await until(sendReply.ready, "the held send reply");
            await act(actions[2]);
            assert.equal(await textOf(card), "", "the card leaves before the reply or view");
            assert.equal(await boxText(), outgoing, "the box still holds what is on its way");
            assert.equal(
                await page.evaluate(
                    `!!document.querySelector('.send-button .spinner[aria-label="Taking back queued message"]')`,
                ),
                "true",
            );
            await page.evaluate('window.queueButton.click(); "repeated"');
            await until(editReply.ready, "the held Edit reply");
            assert.equal(editReply.received(), 1);

            if (sent) {
                editReply.release();
                await posted(id, "edit-queued", 200);
                await until(
                    async () =>
                        (await page.evaluate(
                            `!!document.querySelector('.send-button .spinner[aria-label="Sending"]')`,
                        )) === "true",
                    "Edit to confirm while the send still waits",
                );
                assert.equal(await boxText(), outgoing);
                sendReply.release();
                await posted(id, "submit", 200);
            } else {
                sendReply.release();
                await posted(id, "submit", 409);
                await until(async () => (await textOf(errorNotice)) === refusal, "the send error");
                assert.equal(await boxText(), outgoing);
                editReply.release();
                await posted(id, "edit-queued", 200);
            }

            const draft = sent ? queuedText : `${queuedText}\n${outgoing}`;

            await until(async () => (await boxText()) === draft, "the confirmed draft in the box");
            releaseViews();
            releaseBash();
            await until(() => !app.isBusy(id), "Pi to finish");
            assert.equal(editReply.received(), 1);
        },
    );
}

test("a newer view can reverse a move while the original reply is held", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const releaseViews = delayViews(t, id);
    const reply = holdReply(t, id, "move");

    await act(actions[0]);
    await checkPending(actions[0]);
    await until(reply.ready, "the held move reply");
    const [item] = await inbox(id);

    assert.ok(item);
    await app.commands.moveQueued(id, owner(app), Number(item.id), "steer");
    releaseViews();
    await until(async () => (await textOf(mode)).startsWith("Steer"), "the newer Steer view");
    assert.equal(await page.evaluate(`!!document.querySelector('${move}:enabled')`), "false");
    await page.evaluate(`document.querySelector('${move}').click(); "repeated"`);

    reply.release();
    await posted(id, "move", 200);
    await until(
        async () => (await page.evaluate(`!!document.querySelector('${move}:enabled')`)) === "true",
        "move to unlock",
    );
    assert.ok((await textOf(mode)).startsWith("Steer"));
    assert.equal(reply.received(), 1);
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test(
    "Edit restores the full expanded template and attachment, and keeps text typed before the reply",
    real,
    async (t) => {
        const expanded = "Find issue 42. " + "Long queued text. ".repeat(40).trimEnd();
        const { id, releaseBash } = await startQueued(t, "Steer", async (id, cwd) => {
            const prompts = join(cwd, ".pi", "prompts");
            const uploads = app.workspace.uploadDirectory(id);
            const name = "notes (2).txt";
            const path = join(uploads, `fixture-${name}`);

            mkdirSync(prompts, { recursive: true });
            mkdirSync(uploads, { recursive: true });
            writeFileSync(join(prompts, "fix.md"), expanded.replace("42", "$1"));
            writeFileSync(path, "note");
            await app.commands.submit(id, owner(app), {
                text: "/fix 42",
                requestId: "edit-template",
                mode: "steer",
                attachments: [{ path, name, mime: "text/plain", size: 4 }],
            });
        });
        const releaseViews = delayViews(t, id);
        const reply = holdReply(t, id, "edit-queued");

        assert.match(await textOf(`${card} .queued-text`), /…$/);
        await act(actions[2]);
        await checkPending(actions[2], expanded);
        assert.equal(await textOf(".composer .chip-name"), "notes (2).txt");
        await page.press("Control+End");
        await page.type(undefined, " Please check it.", { append: true });
        const typed = await boxText();

        assert.equal(typed, expanded + " Please check it.");
        reply.release();
        await posted(id, "edit-queued", 200);
        await until(
            async () =>
                (await page.evaluate(
                    `!!document.querySelector('.composer .send-button:enabled')`,
                )) === "true",
            "the box to unlock",
        );
        assert.equal(await boxText(), typed);
        assert.equal(await textOf(".composer .chip-name"), "notes (2).txt");
        releaseViews();
        releaseBash();
        await until(() => !app.isBusy(id), "Pi to finish");
    },
);
