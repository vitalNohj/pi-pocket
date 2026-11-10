// Reply from a viewer, in a real Chromium: text selected in an artifact's page (HTML or Markdown, inside its sandboxed
// frame) brings the app's Reply pill over the frame, and goes in the message box as a quote; "Ask about this" quotes the
// whole artifact. The quote keeps where it came from, and Pi gets that (and the artifact's source) unseen by people.
// A passage of the file viewer does the same with the file's path.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const STORE = "(await import('/store.js'))";
const BOX = ".composer textarea";
const SLOW = 30_000;

const PAGE = `<!doctype html><html><body style="margin:0;padding:40px;font:20px sans-serif">
<p id="line">The quick brown fox jumps over the lazy dog.</p>
</body></html>`;
const NOTES = "# Notes\n\nShip the **beta** on Friday.\n";

/** What the model got in the newest request of the session (not the one that writes its title), as JSON. */
let lastRequest = "";
const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);

    if (!all.includes("You name chat sessions")) {
        lastRequest = all;
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let calls = 0;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(`return JSON.stringify(${script})`)) as T;
const see = (condition: string, what: string, timeout = SLOW) =>
    until(() => inPage<boolean>(`Boolean(await (async () => ${condition})())`), what, timeout);

async function publish(id: string, title: string, content: string, type?: string) {
    await createArtifacts({} as PocketHost).tools![0]!.execute(
        { id, title, content, type } as never,
        {
            conversationId: session,
            taskId: 9100 + (calls += 1),
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
}

/** Open an artifact's viewer, and wait until its page opened its line to the app (it then watches the selection). */
async function openViewer(id: string) {
    await page.evaluate(`${STORE}.openSheet({ type: "viewer", id: ${JSON.stringify(id)} })`);
    await see(`document.querySelector('.viewer iframe')`, "the viewer's frame");
    // The frame's page is another origin: only the app's pill tells what it heard, so select, and wait for it.
}

/**
 * Select a paragraph of the frame's page as a person would: a triple click on it, at `x`, `y` in the frame. The frame is
 * another origin, so the test finds the words by their place in the test page's layout. Chromium routes a pointer to a
 * just-opened frame only once its hit-test data arrives: click again until the pill shows.
 */
async function selectInFrame(x: number, y: number) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const box = await inPage<{ x: number; y: number }>(
            `(() => { const box = document.querySelector('.viewer iframe').getBoundingClientRect(); return { x: box.x, y: box.y }; })()`,
        );

        await page.click({ x: Math.round(box.x + x), y: Math.round(box.y + y) }, { count: 3 });

        try {
            await see(
                `document.querySelector('.viewer .quote-reply-button')`,
                "the Reply pill over the frame",
                3000,
            );

            return;
        } catch {
            // Not routed to the page yet: select again.
        }
    }

    throw new Error("The pill never showed over the frame");
}

before(async () => {
    if (real.skip) {
        return;
    }

    writeFileSync(join(work, "plan.md"), "# Plan\n\nStep one: write the tests.\n");
    app = await openApp(scriptedModel(route));
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    ({ id: session } = await app.commands.createSession(owner(app), { cwd: work }));
    await publish("page", "Fox page", PAGE);
    await publish("notes", "Notes", NOTES, "markdown");
    await publish(
        "logo",
        "Logo",
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        "svg",
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-reply-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1280, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await see(
        `document.querySelector('${BOX}') !== null && ${STORE}.store.state.streamId`,
        "the box",
    );
});

beforeEach(async () => {
    if (real.skip) {
        return;
    }

    await page.evaluate(`(await import('/theme.js')).setPrefs({ quoteStyle: 'fade' });
        const { personStorage } = await import('/person-storage.js');
        for (const key of ['draft', 'quotes', 'quoteStrips']) personStorage.set(key + '.${session}', null);`);
    await page.navigate(`${base}/s/${session}`);
    await see(`document.querySelector('${BOX}')?.value === ''`, "an empty box");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** Send what is in the box, and wait for Pi's answer. */
async function send() {
    const before = lastRequest;

    await page.evaluate(`document.querySelector('.composer .send-button')?.click()`);
    await until(() => lastRequest !== before, "Pi got the message", SLOW);
}

test(
    "text selected in an HTML artifact's page: Reply quotes it, and Pi gets the artifact",
    real,
    async () => {
        await openViewer("page");
        // The page's first line sits 40 px in.
        await selectInFrame(80, 70);
        await page.evaluate(`document.querySelector('.viewer .quote-reply-action').click()`);
        // The viewer covers the box: a notice says where the quote went; closing the viewer shows it.
        await see(
            `${STORE}.store.state.notices.some((each) => each.message.startsWith('Quoted in your message box'))`,
            "the notice",
        );
        await page.evaluate(`${STORE}.closeSheet()`);
        await see(
            `document.querySelector('${BOX}').value.startsWith('> The quick')`,
            "the quote in the box",
        );

        const pieces = await inPage<{ source?: unknown }[]>(
            `JSON.parse((await import('/person-storage.js')).personStorage.get('quotes.${session}'))`,
        );

        assert.deepEqual(pieces[0]?.source, { artifact: "page", version: 1 });

        await page.type(undefined, "what is this?", { append: true });
        await send();

        // Pi gets where the quote came from, with the page's source; people see only the quote and the words.
        assert.match(lastRequest, /pocket-context quotes=/);
        assert.match(
            lastRequest,
            /comes from the artifact “Fox page” \(id “page”, version 1, html\)/,
        );
        assert.match(lastRequest, /The quick brown fox jumps over the lazy dog/);
        const mine = (await app.transcripts.allEntries(session, true)).findLast(
            (entry) => entry.kind === "user",
        );

        assert.ok(mine?.kind === "user" && mine.text.startsWith("> The quick"));
        assert.ok(mine?.kind === "user" && !mine.text.includes("pocket-context"));
    },
);

test(
    "Ask about this quotes a whole Markdown document; selecting in it works too",
    real,
    async () => {
        await openViewer("notes");
        await see(
            `[...document.querySelectorAll('.viewer-head button')].some((each) => each.textContent.includes('Ask about this'))`,
            "Ask about this",
        );
        await page.evaluate(
            `[...document.querySelectorAll('.viewer-head button')].find((each) => each.textContent.includes('Ask about this')).click()`,
        );
        await page.evaluate(`${STORE}.closeSheet()`);
        await see(
            `document.querySelector('${BOX}').value.startsWith('> The document “Notes” (version 1)')`,
            "the whole document quoted",
        );
        await page.type(undefined, "summarize", { append: true });
        await send();
        assert.match(
            lastRequest,
            /comes from the artifact “Notes” \(id “notes”, version 1, markdown\)/,
        );
        assert.match(lastRequest, /Ship the \*\*beta\*\* on Friday/);

        // A Markdown page has the bridge now: a selection in it brings the pill too. Its paragraph is under the heading.
        await openViewer("notes");
        await selectInFrame(60, 100);
    },
);

test("a passage of the file viewer is quoted with its file's path", real, async () => {
    await page.evaluate(
        `(await import('/ui.js')).openFile(${JSON.stringify(join(work, "plan.md"))})`,
    );
    await see(`document.querySelector('[data-quote-file] .md')`, "the rendered file");
    await page.evaluate(`(() => {
        const text = [...document.querySelectorAll('[data-quote-file] .md p')].find((each) => each.textContent.includes('Step one')).firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 8);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    })()`);
    await see(`document.querySelector('.quote-reply-button')`, "the Reply pill");
    // A file's passage is for Reply alone: no PiP orb.
    assert.equal(await inPage(`document.querySelector('.quote-reply-pip') === null`), true);
    await page.evaluate(`document.querySelector('.quote-reply-action').click()`);
    await page.evaluate(`${STORE}.closeSheet()`);
    await see(
        `document.querySelector('${BOX}').value.startsWith('> Step one')`,
        "the quote in the box",
    );
    await page.type(undefined, "go", { append: true });
    await send();
    assert.match(lastRequest, /comes from the file “[^”]*plan\.md”/);
});

test("the server refuses a source that is not the conversation's", real, async () => {
    const submit = (quotes: unknown[]) =>
        app.commands.submit(session, owner(app), {
            text: "> x\n\nhi",
            requestId: `refused-${Math.random()}`,
            about: { quotes: quotes as never },
        });

    await assert.rejects(submit([{ artifact: "nope", version: 1 }]), /No such artifact/);
    await assert.rejects(submit([{ artifact: "page", version: 9 }]), /No such version/);
    await assert.rejects(submit([{ artifact: "page" }]), /artifact and its version, or a file/);
    await assert.rejects(submit(Array.from({ length: 21 }, () => ({ file: "x" }))), /up to 20/);
    // A message with no quotes' sources and no PiP session is about nothing: as before.
    await assert.rejects(
        app.commands.submit(session, owner(app), {
            text: "hi",
            requestId: "s-1",
            about: { session: 1 },
        }),
        /Only a message to PiP/,
    );
});
