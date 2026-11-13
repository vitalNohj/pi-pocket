import {
    addPerson,
    type App,
    cleanUp,
    fakeTab,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { BrowserPage, SHOT_MAX, titleFrom } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { normalizeUrl } from "../src/server/browser/urls.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";

/** A JPEG's size in pixels, from its first frame header. */
function jpegSize(data: string): { width: number; height: number } {
    const bytes = Buffer.from(data, "base64");

    for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
        const marker = bytes[at + 1]!;

        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
    }

    throw new Error("no JPEG frame header");
}

test("addresses as people type them become URLs the browser may open", () => {
    assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
    assert.equal(normalizeUrl("about:blank"), "about:blank");

    for (const refused of [
        "javascript:alert(1)",
        "chrome://settings",
        "view-source:https://example.com",
        "file:///etc/hosts",
        "/etc/hosts",
        "data:text/html,hi",
    ]) {
        assert.equal(normalizeUrl(refused), undefined, refused);
    }

    // Pi and the owner may open files on this machine.
    assert.equal(normalizeUrl("file:///etc/hosts", { trusted: true }), "file:///etc/hosts");
    assert.equal(
        normalizeUrl("./site/index.html", { trusted: true, cwd: "/work" }),
        "file:///work/site/index.html",
    );
    assert.equal(normalizeUrl("data:text/html,hi", { trusted: true }), "data:text/html,hi");
    assert.equal(normalizeUrl("javascript:alert(1)", { trusted: true }), undefined);
});

test("plan mode lets Pi look at pages but not act on them", () => {
    for (const action of ["navigate", "snapshot"]) {
        assert.equal(blockedInPlanMode("browser", { action }), undefined, action);
    }

    for (const action of ["click", "type", "press", "select", "evaluate"]) {
        assert.match(
            blockedInPlanMode("browser", { action }) ?? "",
            /Plan mode is on: The browser's \w+ can change things/,
            action,
        );
    }

    // A data: page is one Pi writes, scripts and all.
    assert.match(
        blockedInPlanMode("browser", {
            action: "navigate",
            url: "data:text/html,<script>fetch('/x')</script>",
        }) ?? "",
        /Plan mode is on/,
    );
});

// ─── With a real browser ────────────────────────────────────────────────

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const PAGE = `<!doctype html><html><head><title>Smoke test</title><meta name="viewport" content="width=device-width"></head><body>
<header><nav><a href="/two">Second page</a> <a href="/two" target="_blank">Popup</a></nav></header>
<main><h1>Hello</h1><p>Some intro text for the page.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Sent ' + document.getElementById('email').value + ' ' + document.getElementById('pick').value">
<label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="old@example.com">
<select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
<button type="submit">Send</button></form>
<div id="out"></div>
<div id="fancy" style="cursor:pointer" onclick="this.textContent='clicked div'">Fancy div</div>
<button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<div style="height:3000px"></div><p id="bottom">The end</p>
</main><script>console.log("hello", {a: 1}); console.error("boom"); setTimeout(() => { throw new Error("late failure") }, 10);</script></body></html>`;

/** An app that names its page a moment after it has loaded. */
const APP = `<!doctype html><title>Loading</title><h1>App</h1>
<script>addEventListener("load", () => setTimeout(() => { document.title = "App ready"; }, 50));</script>`;

let site: Server;
let base = "";
/** How many times "/fresh" was loaded: its title says which load it is. */
let freshLoads = 0;

before(async () => {
    site = createServer((request, response) => {
        const late = /^\/late(?:\?(.*))?$/.exec(request.url ?? "");
        const fresh = request.url === "/fresh";

        response.writeHead(200, {
            "content-type": "text/html",
            // Never kept: a reload loads it again.
            ...(fresh ? { "cache-control": "no-store" } : {}),
        });

        // A page whose head comes a while after its first bytes, as from a slow server. "/fresh" has another title each
        // time it loads.
        if (late !== null || fresh) {
            const title = fresh ? `Fresh ${++freshLoads}` : `Late ${late?.[1] ?? "title"}`;

            response.write(`<!doctype html><!-- ${"x".repeat(2048)} -->`);
            setTimeout(() => response.end(`<title>${title}</title><h1>Late</h1>`), 400);

            return;
        }

        if (request.url === "/app") {
            response.end(APP);

            return;
        }

        response.end(request.url === "/two" ? "<title>Two</title><h1>Second</h1>" : PAGE);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

test(
    "the engine reads, clicks, types in, and streams a real page, and opens it again where it was",
    real,
    async () => {
        const saved = new Map<number, { url?: string }>();
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "engine-")),
            load: async (id) => saved.get(id),
            save: (id, value) => saved.set(id, value),
        });

        try {
            const page = await browsers.open(1);

            assert.deepEqual(await page.navigate(`${base}/`), { status: 200 });
            await until(() => page.title === "Smoke test", "the title");

            // A huge page comes back small enough for a model to take: too large an image breaks the conversation.
            await page.evaluate("document.body.style.cssText = 'width: 2600px; height: 6000px'; 1");
            const whole = await page.screenshot({ fullPage: true });
            const image = jpegSize(whole.data);

            assert.ok(
                whole.width >= 2600 && whole.height >= 6000,
                `${whole.width}×${whole.height}`,
            );
            assert.ok(Math.max(image.width, image.height) <= SHOT_MAX, JSON.stringify(image));
            await page.evaluate("document.body.style.cssText = ''; scrollTo(0, 0); 1");

            // A web page cannot use a new tab to open a file here, which it could not open itself.
            await page.evaluate("window.open('file:///etc/hosts'); 1");
            // Chromium refuses it by itself; the page's own rule refuses it too, should a tab open anyway.
            await until(
                () =>
                    page
                        .logs()
                        .some((entry) =>
                            /^(Not allowed to load local resource: |A new tab for )file:\/\/\/etc\/hosts/.test(
                                entry.text,
                            ),
                        ),
                "the refused tab",
            );
            await new Promise((done) => setTimeout(done, 500));
            assert.equal(page.url, `${base}/`);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("a page's address, as Chromium shows it until there is a title, is no title", () => {
    assert.equal(titleFrom("Docs", "http://localhost:5173/"), "Docs");
    assert.equal(titleFrom("http://localhost:5173/", "http://localhost:5173/"), "");
    assert.equal(titleFrom("localhost:5173/", "http://localhost:5173/"), "");
    // A bare host loses its slash too.
    assert.equal(titleFrom("localhost:5173", "http://localhost:5173/"), "");
    assert.equal(titleFrom("example.com/docs", "https://example.com/docs"), "");
    // A path keeps its slash: this is another page's address, so it is a title here.
    assert.equal(titleFrom("example.com/docs", "https://example.com/docs/"), "example.com/docs");
    // Either address it may be: the one the browser names, or the one the page is at.
    assert.equal(titleFrom("localhost:5173", "about:blank", "http://localhost:5173/"), "");
    assert.equal(titleFrom("", "http://localhost:5173/"), "");
});

test(
    "a page's title is its document's, also when its head comes late or nothing here started the load",
    real,
    async () => {
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "title-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1, { restore: false });

            // The answer of a navigation has the title, with no wait after it.
            assert.deepEqual(await page.navigate(`${base}/late`), { status: 200 });
            assert.equal(page.title, "Late title");

            // A load the page started itself, as a link does: its title comes once it has loaded.
            await page.evaluate(`location.href = "/late?again"; 1`);
            await until(
                () => page.url === `${base}/late?again` && page.title === "Late again",
                "the title of a load the page started",
            );

            // An app names its page just after the load: the answer has that name, not the one it loaded with.
            await page.navigate(`${base}/app`);
            assert.equal(page.title, "App ready");

            // A reload answers with the title of the document it loaded, not the one from before.
            freshLoads = 0;
            await page.navigate(`${base}/fresh`);
            assert.equal(page.title, "Fresh 1");
            await page.reload();
            assert.equal(freshLoads, 2, "the reload loaded it again");
            assert.equal(page.title, "Fresh 2");

            // Going back answers with the title of the page it went back to, as that document has it.
            await page.navigate(`${base}/two`);
            assert.equal(page.title, "Two");
            assert.equal(await page.go(-1), true);
            assert.equal(page.url, `${base}/fresh`);
            assert.match(page.title, /^Fresh \d$/);
            assert.equal(page.title, await page.evaluate("document.title"));
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test(
    "a page's title is in the answer of a navigation, a reload, and going back, however late the browser's history answers",
    real,
    async () => {
        // With no page kept whole for Back, going back loads the page again, as a browser short of memory does.
        const browser = await Chromium.launch(chromium!, mkdtempSync(join(root, "title-slow-")), [
            "--disable-features=BackForwardCache",
        ]);
        const connection = browser.connection;
        const send = connection.send.bind(connection);
        /** History reads whose answer has not come yet. */
        let late = 0;

        // The browser's history, which a title is also read from in the background, answers a second late here. So
        // nothing below passes because such a read happened to come in time: the answer itself has to have the title.
        connection.send = (...args: Parameters<typeof send>) => {
            const answer = send(...args);

            if (args[0] !== "Page.getNavigationHistory") {
                return answer;
            }

            late++;

            return answer
                .then(async (value) => {
                    await new Promise((done) => setTimeout(done, 1000));

                    return value;
                })
                .finally(() => late--);
        };

        try {
            const { targetId } = await connection.send("Target.createTarget", {
                url: "about:blank",
            });
            const { sessionId } = await connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            const page = new BrowserPage({
                conversationId: 1,
                connection,
                session: sessionId,
                target: targetId,
                context: "",
                userAgent: browser.userAgent,
                viewport: VIEWPORTS.desktop,
                changed: () => {},
                saved: () => {},
            });

            // What the browser tells of the page's target reaches the page, as `Browsers` passes it on.
            connection.onEvent = (method, params) => {
                if (method.startsWith("Target.") && params.targetInfo !== undefined) {
                    page.targetEvent(method, params.targetInfo);
                }
            };

            await page.init();
            // Between the steps, the late answers of the step before come in: they change nothing.
            const quiet = () => until(() => late === 0, "the late answers", 15_000);

            await page.navigate(`${base}/two`);
            assert.equal(page.title, "Two");
            await quiet();
            assert.equal(page.title, "Two");

            freshLoads = 0;
            await page.navigate(`${base}/fresh`);
            assert.equal(page.title, "Fresh 1");
            await quiet();
            await page.reload();
            assert.equal(freshLoads, 2, "the reload loaded it again");
            assert.equal(page.title, "Fresh 2");
            await quiet();
            assert.equal(page.title, "Fresh 2");

            // Back, to a page that loads again with another title: the answer has that one.
            await page.navigate(`${base}/two`);
            assert.equal(page.title, "Two");
            await quiet();
            assert.equal(await page.go(-1), true);
            assert.equal(page.url, `${base}/fresh`);
            assert.equal(freshLoads, 3, "going back loaded it again");
            assert.equal(page.title, "Fresh 3");
            await quiet();
            assert.equal(page.title, "Fresh 3");
        } finally {
            browser.kill();
            await browser.exited;
        }
    },
);

test("a command sent while a navigation swaps the page waits for it", real, async () => {
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "swap-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const page = await browsers.open(1, { restore: false });

        // Across sites (to the test site and back to about:blank), Chromium moves the page to a new process and for a
        // moment refuses commands. A reload or stop sent right then used to fail: "Not attached to an active page".
        for (let round = 0; round < 3; round++) {
            await page.navigate("about:blank");
            await page.navigate(`${base}/`);
            await page.go(-1, { wait: false });
            await page.reload({ wait: false });
            await page.navigate(`${base}/two`, { wait: false });
            await page.stop();
        }
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "Pi uses the browser tool, and people watch and use the same page in the panel",
    real,
    async () => {
        const results: string[] = [];

        const route: FauxResponseStep = (context) => {
            const { role, text } = lastText(context as never);
            const call = (args: Parameters<typeof fauxToolCall>[1]) =>
                fauxAssistantMessage([fauxToolCall("browser", args)], { stopReason: "toolUse" });

            if (role === "toolResult") {
                results.push(text);

                return fauxAssistantMessage([fauxText("done")]);
            }

            if (text.includes("open the test page")) {
                return call({
                    action: "navigate",
                    url: base.replace("http://", ""),
                    snapshot: true,
                });
            }

            if (text.includes("take a screenshot")) {
                return call({ action: "screenshot" });
            }

            return fauxAssistantMessage([fauxText("ok")]);
        };

        const app: App = await openApp(scriptedModel(route), join(root, "app"));
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
        const viewer = await addPerson(app, "Vee", "viewer");
        const guest = await addPerson(app, "Gus", "guest");
        const request = (token: string, path: string, body?: unknown) =>
            fetch(
                `${api}/${path}`,
                body === undefined
                    ? { headers: { authorization: `Bearer ${token}` } }
                    : {
                          method: "POST",
                          headers: {
                              authorization: `Bearer ${token}`,
                              "x-pocket": "1",
                              "content-type": "application/json",
                          },
                          body: JSON.stringify(body),
                      },
            );

        try {
            const id = await newSession(app);

            await loadTools(app, id, "browser");

            // A model that takes images keeps the screenshot in the transcript.
            await app.commands.configure(id, owner(app), {
                model: { provider: "faux", modelId: "faux-vision" },
            });
            const tab = fakeTab(id, owner(app));

            await app.attach(tab.client);
            assert.equal(tab.last("browser")?.open, false);

            await say(app, id, "open the test page");
            await until(() => results.length === 1, "the navigate result");
            assert.match(results[0]!, /\[e\d+\] button "Send"/);
            await until(() => tab.last("browser")?.url === `${base}/`, "the page reaching the tab");

            await say(app, id, "take a screenshot");
            await until(() => results.length === 2, "the screenshot result");
            const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
            const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
            const shot = entries.items.find(
                (entry) =>
                    entry.kind === "pi.tool-result" &&
                    JSON.stringify(entry.model).includes("Screenshot of the viewport"),
            )!;

            assert.equal(
                (await app.transcripts.entryImage(id, shot.id as unknown as number, 0))?.mimeType,
                "image/jpeg",
                "Pi sees the screenshot",
            );

            // Everyone who sees the session watches; only people who can steer use the page, and files are the owner's.
            await request(app.config.ownerToken, `c/${id}/browser/navigate`, { url: `${base}/` });
            const state = (await (await request(viewer.token, `c/${id}/browser`)).json()) as {
                open: boolean;
            };

            assert.equal(state.open, true);
            // The first frame comes a moment after the page opens: until then, the answer is 204.
            let frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);

            await until(async () => {
                if (frame.status === 204) {
                    frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);
                }

                return frame.status !== 204;
            }, "the first frame");
            assert.equal(frame.status, 200);
            assert.equal(frame.headers.get("content-type"), "image/jpeg");
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/navigate`, { url: "example.com" }))
                    .status,
                403,
            );
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/input`, { events: [] })).status,
                403,
            );
            const file = await request(guest.token, `c/${id}/browser/navigate`, {
                url: "file:///etc/hosts",
            });

            assert.equal(file.status, 400);
            assert.equal(
                (
                    await request(guest.token, `c/${id}/browser/navigate`, {
                        url: `${base.replace("http://", "")}/two`,
                    })
                ).status,
                200,
            );
            await until(
                () => app.browsers.page(Number(id))?.url === `${base}/two`,
                "the guest's address",
            );
            assert.deepEqual(await (await request(guest.token, `c/${id}/browser/servers`)).json(), {
                servers: [],
            });
            assert.equal((await request(guest.token, `c/${id}/browser/teleport`, {})).status, 404);
            app.detach(tab.client);
        } finally {
            server.closeAllConnections();
            server.close();
            await app.close();
        }
    },
);
