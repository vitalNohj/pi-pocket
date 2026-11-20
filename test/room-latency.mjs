// Optional local benchmark (not part of npm test). Run the same script and Chromium on both revisions:
//   npm ci
//   npm install --no-save playwright@1.62.1
//   npx playwright install chromium
//   node test/room-latency.mjs
// It uses a faux model, a temporary home, and a loopback server on an ephemeral port.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright";

const host = "127.0.0.1";
const warmups = 2;
const samples = 24;
const sendButton = '.composer-wrap button[aria-label="Send"]';

/** Record the click and the first matching rendered row in the page, without polling from Node. */
function observeSample({ sendButton, tool, marker }) {
    const selector = tool ? '[data-part="tool-call"][data-status="done"]' : '[data-part="reply"]';

    window.latencySample = new Promise((resolve, reject) => {
        let sent;
        const now = () => performance.timeOrigin + performance.now();
        const observer = new MutationObserver(() => {
            const matched = Array.from(document.querySelectorAll(selector)).some((node) => {
                const text = tool ? node.querySelector(".step-subject") : node;

                // A slot can say "done" alone. The line count comes from the committed result.
                return (
                    text?.textContent.includes(marker) &&
                    text.getClientRects().length > 0 &&
                    (!tool || node.querySelector(".step-meta")?.textContent.trim() === "1 line")
                );
            });

            if (sent !== undefined && matched) {
                observer.disconnect();
                clearTimeout(timeout);
                resolve({ sent, visible: now() });
            }
        });
        const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`No visible update for ${marker}`));
        }, 5000);

        document.querySelector(sendButton).addEventListener(
            "click",
            () => {
                sent = now();
            },
            { once: true, capture: true },
        );
        observer.observe(document.body, {
            childList: true,
            characterData: true,
            attributes: true,
            subtree: true,
        });
    });
}

const home = mkdtempSync(join(tmpdir(), "pocket-latency-"));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, "config");
process.env.XDG_DATA_HOME = join(home, "data");
process.env.XDG_CACHE_HOME = join(home, "cache");

let app;
let server;
let browser;
let cleanUp;
let toolStarted;

try {
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
    const { fauxAssistantMessage, fauxText, fauxToolCall } =
        await import("@earendil-works/pi-ai/providers/faux");
    const helpers = await import("./helpers.ts");
    const { createHandler } = await import("../src/server/http.ts");
    const { lastText, loadTools, newSession, openApp, scriptedModel, work } = helpers;

    cleanUp = helpers.cleanUp;
    app = await openApp(
        scriptedModel((context) => {
            const { role, text } = lastText(context);
            const path = /^read (sample-\d+\.txt)$/.exec(text)?.[1];

            if (role === "user" && path !== undefined) {
                return fauxAssistantMessage([fauxToolCall("read", { path })], {
                    stopReason: "toolUse",
                });
            }

            return fauxAssistantMessage([
                fauxText(role === "toolResult" ? "Read finished." : `Reply ${text}`),
            ]);
        }),
    );

    // Time the model's first tool call event, not the click that asks it to make the call.
    const streamSimple = app.models.streamSimple.bind(app.models);

    app.models.streamSimple = (...args) => {
        const source = streamSimple(...args);
        const output = createAssistantMessageEventStream();

        void (async () => {
            for await (const event of source) {
                if (event.type === "toolcall_start") {
                    toolStarted = performance.timeOrigin + performance.now();
                }

                // Leave time for Durable to publish live text before the answer is committed.
                if (event.type === "done" && event.message.content[0]?.text?.startsWith("Reply ")) {
                    await wait(300);
                }

                output.push(event);
            }

            output.end(await source.result());
        })();

        return output;
    };

    const id = await newSession(app);

    await loadTools(app, id, "read");
    server = createServer(createHandler({ app, listen: { host, port: 0 }, restart: () => {} }));
    server.listen(0, host);
    await once(server, "listening");
    browser = await chromium.launch();

    const base = `http://${host}:${server.address().port}`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const composer = page.locator(".composer-wrap .composer textarea");

    await page.goto(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.goto(`${base}/s/${id}`);

    for (const tool of [false, true]) {
        const durations = [];

        for (let i = 0; i < warmups + samples; i++) {
            const name = tool ? `sample-${i}.txt` : `sample-${i}:`;
            const marker = tool ? name : `Reply ${name}`;

            if (tool) {
                writeFileSync(join(work, name), "One line of test data.\n");
            }

            toolStarted = undefined;
            await composer.fill(tool ? `read ${name}` : name);
            await page.evaluate(observeSample, { sendButton, tool, marker });
            await page.locator(sendButton).click();

            const { sent, visible } = await page.evaluate(() => window.latencySample);
            const start = tool ? toolStarted : sent;

            // Chromium and Node are on the same host: their monotonic clocks are aligned to epoch time.
            assert(start !== undefined && visible >= start, `Invalid timestamps for ${marker}`);

            if (i >= warmups) {
                durations.push(visible - start);
            }

            await page.waitForFunction(async () => {
                const { store } = await import("/store.js");

                return store.state.view.live.busy === false;
            });
        }

        durations.sort((a, b) => a - b);

        const middle = samples / 2;
        const median = (durations[middle - 1] + durations[middle]) / 2;
        const p95 = durations[Math.ceil(samples * 0.95) - 1];
        const label = tool ? "Tool call -> visible result" : "Send -> first visible text";

        console.log(
            `${label}: ${median.toFixed(1)} ms median, ${p95.toFixed(1)} ms p95 (n=${samples})`,
        );
    }
} finally {
    await browser?.close();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp?.();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
