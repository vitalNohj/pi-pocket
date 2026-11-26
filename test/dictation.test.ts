import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { ModelCache } from "../src/server/extensions/dictation/model-cache.ts";
import { MODELS, modelById } from "../src/server/extensions/dictation/catalog.js";
import { DICTATION_ASSET_VERSION } from "../src/server/extensions/dictation/assets.ts";

const { Phrases } = await import(
    new URL("../src/server/extensions/dictation/phrases.js", import.meta.url).href
);
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const pin = (content: string) => ({
    name: "fixture.onnx",
    url: "https://huggingface.co/example/fixture",
    size: Buffer.byteLength(content),
    sha256: digest(content),
});
const read = (expected: string) => async (path: string) =>
    assert.equal(await readFile(path, "utf8"), expected);
const signal = () => AbortSignal.timeout(10_000);

after(cleanUp);

test("public model pins name every family and provide a size and SHA-256 for every file", () => {
    assert.equal(MODELS.length, 10);
    assert.deepEqual(
        new Set(MODELS.map((each) => each.family)),
        new Set(["parakeet", "whisper", "moonshine", "sense-voice"]),
    );

    for (const model of MODELS) {
        assert.ok(model.languages && model.license);

        for (const file of model.files) {
            assert.match(
                file.url,
                /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[a-f0-9]{40}\/[\w.-]+$/,
            );
            assert.match(file.sha256, /^[a-f0-9]{64}$/);
            assert.ok(file.size > 0);
        }
    }
});

test("model cache verifies the bytes, preserves good entries, and evicts within the limit", async () => {
    const folder = join(root, "dictation-cache");
    let reply = "abcdefgh";
    let calls = 0;
    const cache = new ModelCache(folder, {
        limit: 16,
        fetcher: async (_url, options) => {
            assert.equal(options?.credentials, "omit");
            assert.equal(options?.redirect, "manual");
            calls++;

            return new Response(reply);
        },
    });
    const first = pin(reply);

    await cache.withFile(first, signal(), read(reply));
    await cache.withFile(first, signal(), read(reply));
    assert.equal(calls, 1);

    await assert.rejects(
        cache.withFile(pin("bad hash"), signal(), () => assert.fail()),
        /SHA-256/,
    );
    assert.deepEqual(await readdir(folder), [first.sha256]);

    reply = "new limit";
    await cache.withFile(pin(reply), signal(), read(reply));
    assert.deepEqual(await readdir(folder), [digest(reply)]);

    await assert.rejects(
        cache.withFile(pin("this file is too large"), signal(), () => assert.fail()),
        { status: 507 },
    );
    assert.deepEqual(await readdir(folder), [digest(reply)]);
});

test("aborted and parallel downloads do not publish partial files; redirects stay on the approved CDN", async () => {
    const folder = join(root, "dictation-cancel");
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const cache = new ModelCache(folder, {
        fetcher: async (_url, options) => {
            const stream = new ReadableStream({
                start(stream) {
                    stream.enqueue(Buffer.from("half"));
                    options?.signal?.addEventListener(
                        "abort",
                        () => stream.error(new Error("stopped")),
                        { once: true },
                    );
                    started.resolve();
                },
            });

            return new Response(stream);
        },
    });
    const download = cache.withFile(pin("halfway!"), controller.signal, () => assert.fail());
    const rejected = assert.rejects(download, /download stopped/);

    await started.promise;
    await assert.rejects(
        cache.withFile(pin("second"), signal(), () => assert.fail()),
        { status: 429 },
    );
    controller.abort();
    await rejected;
    assert.deepEqual(await readdir(folder), []);

    let requests = 0;
    const redirect = new ModelCache(folder, {
        fetcher: async () => {
            requests++;

            return Response.redirect("https://example.invalid/model");
        },
    });

    await assert.rejects(
        redirect.withFile(pin("pin"), signal(), () => assert.fail()),
        { status: 502 },
    );
    assert.equal(requests, 1);
});

test("the extension is off by default and serves only fixed public assets while enabled", async (t) => {
    const app = await openApp(scriptedModel());
    const first = owner(app);
    const guest = app.config.addUser("Invited guest", "guest", ["1"]);
    const host = "127.0.0.1";
    const server = createServer(
        createHandler({ app, listen: { host, port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    t.after(() => {
        server.closeAllConnections();

        return new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const address = server.address();

    assert(typeof address === "object" && address);
    const base = `http://${host}:${address.port}`;
    const url = `${base}/x/dictation/${DICTATION_ASSET_VERSION}`;
    const headers = { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1" };
    const scoped = { authorization: `Bearer ${guest.token}`, "x-pocket": "1" };

    assert.equal(app.loader.enabled("dictation.ts"), false);
    assert.equal((await fetch(`${url}/worker.js`, { headers })).status, 404);
    await app.setExtensionEnabled(first, "dictation.ts", true);

    assert.ok(app.webs.clients(guest.user).find((each) => each.module === "dictation"));
    assert.equal((await fetch(`${url}/worker.js`)).status, 401);
    const worker = await fetch(`${url}/worker.js`, { headers: scoped });

    assert.equal(worker.status, 200);
    assert.match(
        worker.headers.get("content-security-policy") ?? "",
        /'wasm-unsafe-eval'; connect-src 'none'/,
    );
    assert.equal(worker.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.ok((await worker.text()).includes("new OfflineRecognizer"));
    const page = await fetch(base, { headers });

    assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /wasm-unsafe-eval/);
    assert.equal(
        (await fetch(`${url}/engine.wasm`, { method: "HEAD", headers })).headers.get(
            "content-type",
        ),
        "application/wasm",
    );
    assert.equal((await fetch(`${url}/arbitrary.wasm`, { headers })).status, 404);
    assert.equal(
        (await fetch(`${url}/worker.js`, { method: "POST", headers, body: "fixture" })).status,
        405,
    );

    // HEAD proves range handling and explicit request gating without fetching any model in this test.
    const model = modelById("whisper-tiny")!;
    const file = model.files[0]!;
    const modelUrl = `${url}/model/${model.id}/${file.name}`;
    const range = await fetch(modelUrl, {
        method: "HEAD",
        headers: { ...scoped, range: "bytes=2-9" },
    });

    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 2-9/${file.size}`);
    assert.equal(
        (await fetch(modelUrl, { method: "HEAD", headers: { ...headers, range: "bytes=8-1" } }))
            .status,
        416,
    );
    assert.equal(
        (await fetch(modelUrl, { headers: { authorization: scoped.authorization } })).status,
        403,
    );
    assert.equal((await fetch(`${url}/model/${model.id}/wrong.onnx`, { headers })).status, 404);
    assert.equal(
        (await fetch(`${base}/api/x/dictation/audio`, { method: "POST", headers, body: "{}" }))
            .status,
        404,
    );

    await app.setExtensionEnabled(first, "dictation.ts", false);
    assert.equal((await fetch(`${url}/worker.js`, { headers })).status, 404);
});

test("the fixed PCM fixture is segmented locally without a network recognizer", async () => {
    const pcm = await readFile(new URL("./fixtures/dictation-jfk.pcm", import.meta.url));
    const final: string[] = [];
    let calls = 0;
    const speech = new Phrases({
        live: false,
        decode: async (samples: Float32Array) => {
            assert.ok(samples.length >= 3200 && samples.length <= 320_000);
            assert.ok(samples.some((sample) => Math.abs(sample) > 0.1));
            calls++;

            return "A local draft";
        },
        publish: ({
            results,
        }: {
            results: Array<{ 0: { transcript: string }; isFinal: boolean }>;
        }) => {
            assert.ok(results.every(({ isFinal }) => isFinal));
            final.push(results.at(-1)![0].transcript);
        },
        error: assert.fail,
    });

    assert.equal(digest(pcm), "a29462b8ebd467318000e683b9117ade46230d3255ed2024e7db894abd9b38c9");

    for (let offset = 0; offset + 3200 <= pcm.length; offset += 3200) {
        speech.accept(
            Float32Array.from({ length: 1600 }, (_, i) => pcm.readInt16LE(offset + i * 2) / 32768),
        );
        // Give the simulated backend its turn, as each 100 ms AudioWorklet frame does in a browser.
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(await speech.finish(), true);
    assert.ok(calls > 0);
    assert.equal(final.at(-1), "A local draft");
});
