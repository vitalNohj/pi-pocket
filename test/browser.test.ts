import {
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
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { SHOT_MAX } from "../src/server/browser/page.ts";
import { SCREENSHOT_BYTES, SCREENSHOT_MAX } from "../src/server/browser/screenshots.ts";
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

    assert.equal(blockedInPlanMode("browser", { action: "screenshot" }), undefined);
    assert.match(
        blockedInPlanMode("browser", { action: "screenshot", path: "shot.png" }) ?? "",
        /Plan mode is on: The browser's screenshot with a path writes a file/,
    );

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

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });

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

test("screenshots keep device pixels in files and capture element boxes", real, async () => {
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "shots-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const page = await browsers.open(1, { restore: false });
        const viewport = { width: 1280, height: 1100, scale: 2, mobile: false };

        await page.setViewport(viewport);
        await page.navigate(`${base}/two`);
        await page.evaluate("document.body.style.margin = '0'; 1");
        const dimensions = async (bytes: Buffer, format: string) =>
            JSON.parse(
                await page.evaluate(`
            const bitmap = await createImageBitmap(await (await fetch(${JSON.stringify(`data:image/${format};base64,`)} + ${JSON.stringify(bytes.toString("base64"))})).blob());
            ({ width: bitmap.width, height: bitmap.height });
        `),
            );

        for (const format of ["png", "jpeg", "webp"] as const) {
            const shot = await page.screenshot({ format });

            assert.ok(shot.file);
            assert.deepEqual(
                await dimensions(shot.file.bytes, format),
                {
                    width: viewport.width * viewport.scale,
                    height: viewport.height * viewport.scale,
                },
                format,
            );
            assert.equal(shot.file.width, viewport.width * viewport.scale);
            assert.equal(shot.file.height, viewport.height * viewport.scale);
            assert.equal(shot.file.scaled, false);
            assert.deepEqual(jpegSize(shot.data), {
                width: viewport.width,
                height: viewport.height,
            });
            assert.deepEqual(page.viewport, viewport, "capturing does not change emulation");
        }

        await page.evaluate(
            `document.body.innerHTML = '<div style="height:2000px"></div><button style="box-sizing:border-box;width:123px;height:67px" id="target">Target</button>'; 1`,
        );
        const outline = await page.snapshot();
        const ref = outline.items.find((item) => item.name === "Target")!.ref;

        for (const target of [{ selector: "#target" }, { ref }]) {
            const shot = await page.screenshot({ target, format: "png" });

            assert.ok(shot.file);
            assert.deepEqual(await dimensions(shot.file.bytes, "png"), { width: 246, height: 134 });
            assert.deepEqual(jpegSize(shot.data), { width: 123, height: 67 });
            assert.equal(shot.width, 123);
            assert.equal(shot.height, 67);
            assert.ok(
                Number(await page.evaluate("scrollY")) > 0,
                "the element was scrolled into view",
            );
            assert.deepEqual(jpegSize((await page.screenshot({ target })).data), {
                width: 123,
                height: 67,
            });
            await assert.rejects(
                page.screenshot({ fullPage: true, target }),
                /fullPage or an element, not both/,
            );
        }

        // Fractional CSS sizes and origins must still report the encoded file's exact pixel size.
        await page.evaluate(
            "document.querySelector('#target').style.cssText = 'box-sizing:border-box;width:123.75px;height:67.25px;transform:translate(0.3px,0.2px)'; 1",
        );
        const fractional = await page.screenshot({
            target: { selector: "#target" },
            format: "png",
        });

        assert.ok(fractional.file);
        assert.deepEqual(await dimensions(fractional.file.bytes, "png"), {
            width: fractional.file.width,
            height: fractional.file.height,
        });

        for (const view of [
            { width: 1280, height: 1100, scale: 1.25, mobile: false },
            { width: 1280, height: 1100, scale: 1.5, mobile: false },
            { width: 390, height: 844, scale: 2, mobile: true },
        ]) {
            await page.setViewport(view);
            const shot = await page.screenshot({ format: "png" });

            assert.ok(shot.file);
            assert.deepEqual(await dimensions(shot.file.bytes, "png"), {
                width: shot.file.width,
                height: shot.file.height,
            });
            assert.equal(shot.file.width, view.width * view.scale);
            assert.equal(shot.file.height, view.height * view.scale);
            const element = await page.screenshot({
                target: { selector: "#target" },
                format: "png",
            });

            assert.ok(element.file);
            assert.deepEqual(await dimensions(element.file.bytes, "png"), {
                width: element.file.width,
                height: element.file.height,
            });
        }

        // The file covers the whole page, not only the 8000 CSS pixels kept for the model, and caps pixels by scaling.
        await page.setViewport({ width: 320, height: 240, scale: 1, mobile: false });
        await page.evaluate(
            "document.body.innerHTML = ''; document.body.style.cssText = 'margin:0;height:17000px'; scrollTo(0, 0); 1",
        );
        const whole = await page.screenshot({ fullPage: true, format: "png" });

        assert.ok(whole.file?.scaled);
        assert.equal(whole.file.height, SCREENSHOT_MAX);
        assert.deepEqual(await dimensions(whole.file.bytes, "png"), {
            width: whole.file.width,
            height: whole.file.height,
        });
        assert.equal(whole.height, 8000);
        assert.ok(Math.max(...Object.values(jpegSize(whole.data))) <= SHOT_MAX);
        const webp = await page.screenshot({ fullPage: true, format: "webp" });

        assert.ok(webp.file?.scaled);
        assert.equal(webp.file.height, SCREENSHOT_MAX - 1, "WebP's own dimension limit");
        assert.deepEqual(await dimensions(webp.file.bytes, "webp"), {
            width: webp.file.width,
            height: webp.file.height,
        });
    } finally {
        await browsers.closeAll({ final: true });
    }
});

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
    "the browser tool saves files in the session folder and keeps its JPEG preview",
    real,
    async (t) => {
        const results: { text: string; images: number }[] = [];

        const route: FauxResponseStep = (input) => {
            const { role, text } = lastText(input as never);

            if (role === "toolResult") {
                const message = input.messages.at(-1)!;

                results.push({
                    text,
                    images: Array.isArray(message.content)
                        ? message.content.filter((part) => part.type === "image").length
                        : 0,
                });

                return fauxAssistantMessage([fauxText("done")]);
            }

            return text.startsWith("browser ")
                ? fauxAssistantMessage([fauxToolCall("browser", JSON.parse(text.slice(8)))], {
                      stopReason: "toolUse",
                  })
                : fauxAssistantMessage([fauxText("ok")]);
        };

        const app = await openApp(scriptedModel(route), join(root, "screenshot-app"));

        try {
            const id = await newSession(app);

            await loadTools(app, id, "browser");
            await app.commands.configure(id, owner(app), {
                model: { provider: "faux", modelId: "faux-vision" },
            });

            const browse = async (args: Record<string, unknown>) => {
                const count = results.length;

                await say(app, id, `browser ${JSON.stringify(args)}`);
                await until(() => results.length > count, "the screenshot tool's result");

                return results.at(-1)!;
            };

            await browse({ action: "navigate", url: `${base}/two` });
            const page = app.browsers.page(Number(id))!;

            await page.setViewport({ width: 1280, height: 1100, scale: 2, mobile: false });

            for (const extension of ["png", "jpg", "jpeg", "webp"]) {
                const path = `shots/viewport.${extension}`;
                const saved = await browse({ action: "screenshot", path });
                const bytes = readFileSync(join(work, path));

                assert.ok(
                    saved.text.includes(`Saved ${join(work, path)} (2560×2200 px, `),
                    saved.text,
                );
                assert.equal(saved.images, 1);
                assert.equal(
                    existsSync(join(process.cwd(), path)),
                    false,
                    "not relative to the server process",
                );

                if (extension === "png") {
                    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
                    assert.equal(bytes.readUInt32BE(16), 2560);
                    assert.equal(bytes.readUInt32BE(20), 2200);
                } else if (extension === "webp") {
                    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
                    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
                } else {
                    assert.deepEqual(jpegSize(bytes.toString("base64")), {
                        width: 2560,
                        height: 2200,
                    });
                }
            }

            for (const path of ["shots/wrong.gif", "shots/no-extension"]) {
                assert.match(
                    (await browse({ action: "screenshot", path })).text,
                    /Use \.png, \.jpg\/\.jpeg, or \.webp/,
                );
                assert.equal(existsSync(join(work, path)), false);
            }

            mkdirSync(join(work, "shots/folder.png"));
            const folder = await browse({ action: "screenshot", path: "shots/folder.png" });

            assert.match(folder.text, /is a folder/);
            assert.equal(folder.images, 1);
            assert.match(
                (await browse({ action: "screenshot", selector: "h1" })).text,
                /Screenshot of the element/,
            );
            assert.match(
                (await browse({ action: "screenshot", selector: "h1", fullPage: true })).text,
                /fullPage or an element, not both/,
            );
            assert.match(
                (
                    await browse({
                        action: "screenshot",
                        selector: "h1",
                        fullPage: true,
                        path: "shots/refused.png",
                    })
                ).text,
                /fullPage or an element, not both/,
            );
            assert.equal(existsSync(join(work, "shots/refused.png")), false);

            // Inject only the large encoded file, rather than forcing Chromium to allocate an enormous noisy page.
            const preview = await page.screenshot();

            t.mock.method(page, "screenshot", async () => ({
                ...preview,
                file: {
                    bytes: Buffer.alloc(SCREENSHOT_BYTES + 1),
                    width: 2560,
                    height: 2200,
                    scaled: false,
                },
            }));
            const large = await browse({ action: "screenshot", path: "shots/large.png" });

            assert.match(large.text, /exceeds 50 MB: it was not saved/);
            assert.equal(large.images, 1, "an over-limit file still returns the model's image");
            assert.equal(existsSync(join(work, "shots/large.png")), false);
        } finally {
            await app.close();
        }
    },
);

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
        const viewer = app.config.addUser("Vee", "viewer");
        const guest = app.config.addUser("Gus", "guest");
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
