// Run with the installed Node. Load the worker and the WASM from the installed package, not the checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule } from "node:vm";

const [manifest, scratch] = process.argv.slice(2);

assert(manifest && scratch, "Pass the installed package.json and a temporary model folder.");
const installed = (name) => pathToFileURL(join(dirname(manifest), name)).href;

// Use the same type loader as the installed CLI for the package's own TypeScript.
await import(installed("bin/strip-types.js"));

const bundled = (name) => installed(`src/server/extensions/dictation/${name}`);
const [{ engineScript, engineBinary }, { ModelCache }, { modelById }, { modelConfig }] =
    await Promise.all(
        ["assets.ts", "model-cache.ts", "catalog.js", "model-config.js"].map(
            (name) => import(bundled(name)),
        ),
    );
const model = modelById("whisper-tiny");
const cache = new ModelCache(scratch);
const files = [];

for (const pin of model.files) {
    await cache.withFile(pin, AbortSignal.timeout(180_000), async (path) => {
        const bytes = await readFile(path);

        assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
        files.push({ name: pin.name, bytes });
    });
}

const binary = await engineBinary();

assert.equal(
    createHash("sha256").update(binary).digest("hex"),
    "e0dbc36b03561a45a0e41d9da7f4974ceaf4c550cec5a9b8ea50cef84a2f4f43",
);
const speech = await readFile(new URL("../fixtures/dictation-jfk.pcm", import.meta.url));
const samples = Float32Array.from(
    { length: speech.length / 2 },
    (_, i) => speech.readInt16LE(i * 2) / 32768,
);
let response;
let network = 0;

const noNetwork = () => {
    network++;

    throw new Error("Recognition must not use the network");
};

const self = {
    location: { href: "https://example.invalid/worker.js" },
    postMessage: (value) => {
        response = value;
    },
};

const context = createContext({
    self,
    WorkerGlobalScope: {},
    Float32Array,
    TextDecoder,
    TextEncoder,
    URL,
    fetch: noNetwork,
    XMLHttpRequest: noNetwork,
    performance,
    setTimeout,
    clearTimeout,
});

async function source(name) {
    const script = await engineScript(name);

    assert(typeof script === "string", `The installer is missing ${name}`);

    return new SourceTextModule(script, {
        context,
        identifier: name,
        initializeImportMeta: (meta) => {
            meta.url = new URL(name, self.location.href).href;
        },
        importModuleDynamically: noNetwork,
    });
}

const worker = await source("worker.js");

await worker.link((specifier) => source(specifier.slice(2)));
await worker.evaluate();
await self.onmessage({ data: { id: 1, type: "load", binary, config: modelConfig(model), files } });
assert.equal(response?.id, 1);
assert.equal(response.error, undefined);

await self.onmessage({ data: { id: 2, type: "decode", samples } });
assert.equal(response?.id, 2);
assert.equal(response.error, undefined);
assert.equal(
    /ask not what your country can do for you/i.test(response.text),
    true,
    "The installed worker must recognize the fixture.",
);
assert.equal(network, 0);
console.log(`Installed offline speech worker passed (${process.platform}, ${process.arch}).`);
