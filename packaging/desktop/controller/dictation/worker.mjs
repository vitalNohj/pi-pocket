import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import { loadExtension } from "./extension.mjs";

// The same extension worker used in a browser, with no Node APIs, network, dynamic imports or stdout in its realm.
const root = new URL(workerData.root);
const { ModelCache, modelById, modelConfig, bpeVocab } = await loadExtension(root);
const self = { postMessage: (packet) => parentPort.postMessage(packet) };
const context = createContext({
    self,
    WorkerGlobalScope: {},
    Float32Array,
    TextDecoder,
    TextEncoder,
    URL,
    performance,
    setTimeout,
    clearTimeout,
});
const modules = new Map();

async function script(name) {
    if (!modules.has(name)) {
        const path =
            name === "worker.js"
                ? "src/server/extensions/dictation/engine-worker.js"
                : `vendor/${name}`;
        const text = await readFile(new URL(path, root), "utf8");

        modules.set(
            name,
            new SourceTextModule(text, {
                context,
                identifier: name,
                initializeImportMeta: (meta) => {
                    meta.url = `https://offline.invalid/${name}`;
                },
            }),
        );
    }

    return modules.get(name);
}

const worker = await script("worker.js");

await worker.link((path) => {
    if (!/^\.\/[a-zA-Z0-9_-]+\.js$/.test(path)) {
        throw new Error("Unknown speech worker import");
    }

    return script(path.slice(2));
});
await worker.evaluate();

parentPort.on("message", async (packet) => {
    const { id, type } = packet;

    try {
        if (type === "load") {
            const signal = AbortSignal.timeout(55_000);
            const { folder, selected, words } = workerData;
            const model = modelById(selected);
            const cache = new ModelCache(folder);
            const binary = await readFile(new URL("vendor/asr.wasm", root));
            const files = [];

            if (
                createHash("sha256").update(binary).digest("hex") !==
                "e0dbc36b03561a45a0e41d9da7f4974ceaf4c550cec5a9b8ea50cef84a2f4f43"
            ) {
                throw new Error("Invalid speech engine");
            }

            for (const pin of model.files) {
                const path = await cache.installedFile(pin, signal);
                const bytes = await readFile(path, { signal });

                // Check the bytes we actually load, not only the file entry seen by the cache.
                if (
                    bytes.length !== pin.size ||
                    createHash("sha256").update(bytes).digest("hex") !== pin.sha256
                ) {
                    throw new Error("Invalid speech model");
                }

                files.push({ name: pin.name, bytes });
            }

            if (model.family === "parakeet" && words.length) {
                const tokens = files.find(({ name }) => name === "tokens.txt");

                files.push({ name: "hotwords.txt", bytes: Buffer.from(words.join("\n")) });
                files.push({
                    name: "hotwords.vocab",
                    bytes: Buffer.from(bpeVocab(tokens.bytes.toString("utf8"))),
                });
            }

            await self.onmessage({
                data: { id, type, binary, files, config: modelConfig(model, "/", words) },
            });
        } else if (type === "decode") {
            await self.onmessage({ data: packet });
        }
    } catch {
        parentPort.postMessage({
            id,
            error: "The speech model could not load. Remove it and download it again.",
        });
    }
});
