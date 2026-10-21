// Compressed answers: web files (and "not modified"), and an event stream that stays live while compressed.
import { type App, cleanUp, newSession, openApp, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createBrotliDecompress } from "node:zlib";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let port = 0;

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve) => {
        request(
            {
                port,
                path,
                headers: { authorization: `Bearer ${app.config.ownerToken}`, ...headers },
            },
            (res) => {
                const chunks: Buffer[] = [];

                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode!,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        ).end();
    });

test("a web file goes compressed, and not again to a browser that has it", async () => {
    const file = readFileSync(new URL("../web/style.css", import.meta.url));
    const first = await get("/style.css", { "accept-encoding": "br, gzip" });

    assert.equal(first.headers["content-encoding"], "br");
    assert.ok(first.body.length < file.length / 3);

    const again = await get("/style.css", {
        "accept-encoding": "gzip",
        "if-none-match": String(first.headers.etag),
    });

    assert.equal(again.status, 304, "the same bytes in another encoding are still the same file");
    assert.equal(
        (await get("/style.css", { "accept-encoding": "identity" })).body.length,
        file.length,
    );
});

test("a compressed event stream delivers each event as it happens", async () => {
    const seen: string[] = [];

    await new Promise<void>((resolve, reject) => {
        const open = request(
            {
                port,
                path: "/api/events?tab=z&p=2",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "accept-encoding": "br",
                },
            },
            (res) => {
                assert.equal(res.headers["content-encoding"], "br");
                const inflate = res.pipe(createBrotliDecompress());

                inflate.setEncoding("utf8");
                inflate.on("data", (text: string) => {
                    seen.push(...[...text.matchAll(/^event: (.*)$/gm)].map((match) => match[1]!));
                });
                inflate.on("error", reject);
                until(() => seen.includes("hello"), "the first event")
                    // A new session reaches the open stream, though the stream has not ended.
                    .then(() => newSession(app))
                    .then(() =>
                        until(
                            () => seen.filter((e) => e === "sessions").length > 1,
                            "a flushed event",
                        ),
                    )
                    .then(() => (open.destroy(), resolve()), reject);
            },
        );

        open.on("error", () => {});
        open.end();
    });
});

test("the app page lists the modules it loads, even those imported by others", async () => {
    const page = (await get("/", { "accept-encoding": "identity" })).body.toString("utf8");
    const listed = [...page.matchAll(/rel="modulepreload" href="([^"]+)\?v=[0-9a-f]+"/g)].map(
        (m) => m[1],
    );

    for (const address of [
        "/app.js",
        "/store.js",
        "/vendor/preact-hooks.mjs",
        "/sheets/session.js",
    ]) {
        assert.ok(listed.includes(address), address);
    }
});

test("the app page names its files by their bytes, which a browser keeps for good, and an edit by new ones", async () => {
    const page = () =>
        get("/", { "accept-encoding": "identity" }).then((answer) => answer.body.toString("utf8"));
    const map = (html: string) =>
        JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!)
            .imports as Record<string, string>;
    const first = await page();
    const imports = map(first);
    const store = imports["/store.js"]!;

    // A bare name and a module's own address both go to its hashed one, so relative imports find the same module.
    assert.match(store, /^\/store\.js\?v=[0-9a-f]{24}$/);
    assert.match(imports.preact!, /^\/vendor\/preact\.mjs\?v=[0-9a-f]{24}$/);
    assert.match(first, /<script type="module" src="\/app\.js\?v=[0-9a-f]{24}"><\/script>/);
    assert.match(first, /"\/style\.css\?v=[0-9a-f]{24}"/);

    const kept = await get(store, {});
    const plain = await get("/store.js", {});
    const stale = await get("/store.js?v=000000000000000000000000", {});

    assert.equal(kept.status, 200);
    assert.equal(kept.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.deepEqual(kept.body, plain.body);
    assert.equal(
        plain.headers["cache-control"],
        "no-cache",
        "without its hash, it is asked for again",
    );
    assert.equal(stale.headers["cache-control"], "no-cache", "another version than its own now");
    assert.equal(
        map(await page())["/store.js"],
        store,
        "the same bytes, the same address: the browser asks for nothing",
    );
});
