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

/** Mark when the browser has processed a particular reply, not just when the server sent it. */
async function watchReply(id: ConversationId, endpoint: string): Promise<void> {
    const path = JSON.stringify(`/api/c/${id}/${endpoint}`);

    await page.evaluate(`
        const originalFetch = window.fetch;
        window.queueReplyRead = false;
        window.fetch = async (url, ...args) => {
            const response = await originalFetch(url, ...args);
            if (url === ${path}) {
                const text = response.text.bind(response);
                response.text = async () => {
                    const body = await text();
                    setTimeout(() => { window.queueReplyRead = true; }, 0);
                    return body;
                };
            }
            return response;
        };
        'watching';
    `);
}

/** Let the server act, but replace what the gateway gives back to the tab. */
async function replaceQueueReply(
    id: ConversationId,
    endpoint: string,
    status: number,
    body: string,
) {
    await page.evaluate(`
        const originalFetch = window.fetch;
        window.fetch = async (url, ...args) => {
            const response = await originalFetch(url, ...args);
            if (url !== ${JSON.stringify(`/api/c/${id}/${endpoint}`)}) {
                return response;
            }
            await response.text();
            return new Response(${JSON.stringify(body)}, { status: ${status} });
        };
        'watching';
    `);
}

const moveEnabled = async () =>
    (await page.evaluate(`!!document.querySelector('${move}:enabled')`)) === "true";

async function streamId(): Promise<string> {
    return page.evaluate(`(await import('/store.js')).store.state.streamId ?? ''`);
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
    const delayed = mock.method(
        client,
        "send",
        (event: string, data: unknown, conversation?: ConversationId) => {
            if (event === "view") {
                pending.push(() => send(event, data, conversation));
            } else {
                send(event, data, conversation);
            }
        },
    );
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
                assert.ok((await textOf(mode)).startsWith(action.pending));
            } else {
                await until(async () => (await textOf(card)) === "", "the card to leave the queue");
            }

            if (!viewFirst) {
                releaseViews();
            }

            if (action.selector === move) {
                await until(moveEnabled, "the queue view to unlock the card");
            }

            releaseBash();
            await until(() => !app.isBusy(id), "Pi to finish");
            await until(async () => (await textOf(card)) === "", "the queue to empty");
            assert.equal(await boxText(), action.selector === edit ? queuedText : "");
            assert.equal(reply.received(), 1);
        },
    );

    test(`${action.label} refreshes its stale card on refusal`, real, async (t) => {
        const { id, releaseBash } = await startQueued(t, action.from);
        const previous = await streamId();
        const withdrawing = action.selector === withdraw;
        const reason = withdrawing ? "That message is no longer waiting." : staleError;

        delayViews(t, id);
        const reply = holdReply(t, id, action.endpoint);

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
        // Withdraw reports the conflict in a 200 body; the other actions use HTTP 409.
        await posted(id, action.endpoint, withdrawing ? 200 : 409);
        await until(async () => (await textOf(errorNotice)) === reason, "the conflict reason");
        await until(async () => (await streamId()) !== previous, "a fresh view after the conflict");
        await until(async () => (await textOf(card)) === "", "the stale card to leave the queue");
        assert.equal(await boxText(), "Unsent draft");
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

test("a successful move waits for the queue view before another action", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const releaseViews = delayViews(t, id);
    const reply = holdReply(t, id, "move");

    await watchReply(id, "move");
    await act(actions[0]);
    await checkPending(actions[0]);
    await until(reply.ready, "the held move reply");
    reply.release();
    await until(
        async () => (await page.evaluate("window.queueReplyRead")) === "true",
        "the reply in the tab",
    );
    assert.equal(await moveEnabled(), false, "another action cannot use an unconfirmed mode");

    await page.evaluate(`document.querySelector('${withdraw}').click(); 'tried Withdraw'`);
    assert.equal((await inbox(id)).length, 1);
    releaseViews();
    await until(moveEnabled, "the confirmed card to unlock");
    assert.ok((await textOf(mode)).startsWith("Queue"));
    await act(actions[4]);
    await until(async () => (await textOf(card)) === "", "the next action to remove the card");
    assert.equal(reply.received(), 1);
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test(
    "no move reply leaves the reconnected card locked only until the deadline",
    real,
    async (t) => {
        const { id, releaseBash } = await startQueued(t);
        const reply = holdReply(t, id, "move");
        const previous = await streamId();

        await act(actions[0]);
        await until(reply.ready, "the held move reply");
        const client = [...app.clients].find((client) => client.conversationId === id);

        assert.ok(client?.close);
        client.close();
        await until(async () => (await streamId()) !== previous, "the new event connection");
        await until(async () => (await textOf(mode)).startsWith("Queue"), "the Queue view");
        await until(moveEnabled, "the deadline to unlock the reconnected card", 13_000);
        assert.match(await textOf(errorNotice), /no reply/i);
        assert.ok((await textOf(mode)).startsWith("Queue"));
        assert.equal(reply.received(), 1);
        releaseBash();
        await until(() => !app.isBusy(id), "Pi to finish");
    },
);

test("a gateway error refreshes a move that already committed", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const previous = await streamId();

    delayViews(t, id);
    await replaceQueueReply(id, "move", 502, '{"error":"Gateway did not relay the reply."}');
    await act(actions[0]);
    await until(
        async () => (await textOf(errorNotice)) === "Gateway did not relay the reply.",
        "the gateway error",
    );
    await until(
        async () => (await streamId()) !== previous,
        "the full queue view instead of an HTTP guess",
    );
    await until(moveEnabled, "the card to unlock");
    assert.ok((await textOf(mode)).startsWith("Queue"));
    assert.equal((await inbox(id))[0]?.mode, "followUp");
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test("an unreadable Withdraw reply is not proof that Pi took the message", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const previous = await streamId();

    delayViews(t, id);
    await replaceQueueReply(id, "withdraw", 200, "<title>Gateway</title>");
    await act(actions[4]);
    await until(async () => (await textOf(errorNotice)) !== "", "the unreadable reply notice");
    assert.match(await textOf(errorNotice), /did not confirm/i);
    await until(
        async () => (await streamId()) !== previous,
        "a full view after the unreadable reply",
    );
    await until(async () => (await textOf(card)) === "", "the confirmed empty queue");
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test("a successful Withdraw refreshes the queue if no view arrives", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const previous = await streamId();

    delayViews(t, id);
    const reply = holdReply(t, id, "withdraw");

    await act(actions[4]);
    await until(reply.ready, "the held Withdraw reply");
    reply.release();
    await posted(id, "withdraw", 200);
    await until(async () => (await textOf(card)) === "", "Withdraw to hide the card");
    await until(
        async () => (await streamId()) !== previous,
        "a fresh queue view after the deadline",
        13_000,
    );
    await until(
        async () =>
            (await page.evaluate(`(await import('/store.js')).store.state.view.inbox.length`)) ===
            "0",
        "the server snapshot to contain no card",
    );
    assert.equal(await textOf(card), "");
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test(
    "a timed-out Edit unlocks the original draft without guessing what the server did",
    real,
    async (t) => {
        const { id, releaseBash } = await startQueued(t);
        const reply = holdReply(t, id, "edit-queued");

        await page.type({ selector: box }, "Unsent draft");
        await act(actions[2]);
        await checkPending(actions[2], queuedText + "\nUnsent draft");
        await until(reply.ready, "the held Edit reply");
        await until(
            async () => (await boxText()) === "Unsent draft",
            "the deadline to unlock the draft",
            13_000,
        );
        assert.match(await textOf(errorNotice), /no reply/i);
        assert.equal(await textOf(card), "");
        assert.equal((await inbox(id)).length, 0);
        releaseBash();
        await until(() => !app.isBusy(id), "Pi to finish");
    },
);

test("reordered snapshots keep an Edit on its unchanged card", real, async (t) => {
    const second = "Second waiting message";
    const third = "Third waiting message";
    const { id, releaseBash } = await startQueued(t, "Steer", async (id) => {
        for (const [index, text] of [queuedText, second, third].entries()) {
            await app.commands.submit(id, owner(app), {
                text,
                mode: "steer",
                requestId: `order-${index}`,
            });
        }
    });
    const reply = holdReply(t, id, "edit-queued", { error: "Edit was refused." });
    const cards = () =>
        page.evaluate(
            '[...document.querySelectorAll(".inbox .queued-text")].map((row) => row.textContent.trim()).join("|")',
        );

    await act(actions[2]);
    await until(reply.ready, "the held Edit refusal");
    assert.equal(await cards(), `${second}|${third}`);
    await app.harness.commit(async (tx) => {
        const { items } = await tx.doc(InboxDoc, id);
        const [first, second, third] = items;

        assert.ok(first && second && third);
        items.splice(0, items.length, third, first, second);
    }, context);
    await until(async () => (await cards()).startsWith(third), "the reordered snapshot in the tab");
    assert.equal(
        await cards(),
        `${third}|${second}`,
        "a still pending Edit does not show its card again",
    );
    reply.release();
    await posted(id, "edit-queued", 409);
    await until(
        async () => (await cards()) === `${third}|${queuedText}|${second}`,
        "the original card at its new place",
    );
    assert.equal(await boxText(), "");
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test("a changed card replaces the pending Edit preview in the box", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const refusal = "Edit was refused.";
    const draft = "Unsent draft";
    const reply = holdReply(t, id, "edit-queued", { error: refusal });
    const [item] = await inbox(id);

    assert.ok(item);
    await page.type({ selector: box }, draft);
    await act(actions[2]);
    await checkPending(actions[2], `${queuedText}\n${draft}`);
    await until(reply.ready, "the held Edit refusal");
    await app.commands.moveQueued(id, owner(app), Number(item.id), "followUp");
    await until(async () => (await textOf(mode)).startsWith("Queue"), "the changed Queue card");
    assert.equal(await boxText(), draft, "the message is not in both the queue and the box");
    assert.equal(responses.has(`/api/c/${id}/edit-queued`), false);

    reply.release();
    await until(async () => (await textOf(errorNotice)) === refusal, "the Edit refusal");
    await until(moveEnabled, "the changed card to unlock");
    assert.equal(await boxText(), draft);
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test("a newer view can reverse a move while the original reply is held", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const reply = holdReply(t, id, "move");

    await act(actions[0]);
    await until(reply.ready, "the held move reply");
    await until(
        async () =>
            (await page.evaluate(`(await import('/store.js')).store.state.view.inbox[0]?.mode`)) ===
            "followUp",
        "the actual Queue view",
    );
    const [item] = await inbox(id);

    assert.ok(item);
    // This is the same server command a second tab sends, without using this tab's local lock.
    await app.commands.moveQueued(id, owner(app), Number(item.id), "steer");
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

test("an Edit reply after a session switch goes only to the original draft", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const other = await newSession(app);
    const reply = holdReply(t, id, "edit-queued");

    await page.type({ selector: box }, "Original draft");
    await watchReply(id, "edit-queued");
    await act(actions[2]);
    await until(reply.ready, "the held Edit reply");
    await page.evaluate(`(await import('/store.js')).navigate(${Number(other)}); 'switched'`);
    await until(
        async () =>
            (await page.evaluate(
                `(await import('/store.js')).store.state.view.conversation?.id`,
            )) === String(other),
        "the other session",
    );
    await page.type({ selector: box }, "Other draft");
    reply.release();
    await until(
        async () => (await page.evaluate("window.queueReplyRead")) === "true",
        "the reply in the other session",
    );
    assert.equal(await boxText(), "Other draft");
    assert.equal(await textOf(card), "");

    await page.navigate(`${base}/s/${id}`);
    await until(
        async () => (await boxText()) === `${queuedText}\nOriginal draft`,
        "the original session's confirmed edit after reload",
    );
    assert.equal(await textOf(card), "");
    releaseBash();
    await until(() => !app.isBusy(id), "Pi to finish");
});

test("a reload shows the server queue with no pending card action", real, async (t) => {
    const { id, releaseBash } = await startQueued(t);
    const reply = holdReply(t, id, "move");

    await act(actions[0]);
    await until(reply.ready, "the held move reply");
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () => (await textOf(mode)).startsWith("Queue"),
        "the server's Queue card after reload",
    );
    await click(`${card} .queued-text`);
    await until(moveEnabled, "usable card actions after reload");
    assert.equal(await page.evaluate('document.querySelectorAll(".inbox .queued").length'), "1");
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
