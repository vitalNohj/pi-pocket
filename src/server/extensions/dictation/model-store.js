import { MODELS, modelById, modelSize } from "./catalog.js";

export const ASSETS = "/x/dictation/offline-v1";
const DATABASE = "x.dictation.models.v1";
const STORE = "files";
const ENGINE = "engine";
const ENGINE_FILE = {
    size: 13_788_938,
    sha256: "e0dbc36b03561a45a0e41d9da7f4974ceaf4c550cec5a9b8ea50cef84a2f4f43",
};
const DISK_LIMIT = 1_000_000_000;

export function browserLimit() {
    const memory = navigator.deviceMemory;

    // Cap both the JavaScript buffers and the ORT session in a tab. The full catalogue is still shown.
    return memory >= 8 ? 700_000_000 : memory <= 4 ? 165_000_000 : 380_000_000;
}

export function storageUse(ids) {
    const bytes = MODELS.filter(({ id }) => ids.includes(id)).reduce(
        (sum, model) => sum + modelSize(model),
        0,
    );

    return bytes === 0 ? 0 : bytes + ENGINE_FILE.size;
}

function receive(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function database() {
    const request = indexedDB.open(DATABASE, 1);

    request.onupgradeneeded = () => request.result.createObjectStore(STORE);

    return receive(request);
}

async function transaction(mode, task, signal) {
    const db = await database();

    try {
        signal?.throwIfAborted();

        const tx = db.transaction(STORE, mode);
        const stop = () => tx.abort();
        const done = new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error ?? new Error("The speech model store was changed."));
        });

        signal?.addEventListener("abort", stop, { once: true });

        try {
            const [result] = await Promise.all([task(tx.objectStore(STORE)), done]);

            return result;
        } finally {
            signal?.removeEventListener("abort", stop);
        }
    } finally {
        db.close();
    }
}

export async function modelKeys() {
    const keys = await transaction("readonly", (store) => receive(store.getAllKeys()));

    return keys.filter((id) => modelById(id));
}

export async function removeModel(id) {
    await transaction("readwrite", async (store) => {
        store.delete(id);
        const keys = await receive(store.getAllKeys());

        if (!keys.some((key) => modelById(key))) {
            store.delete(ENGINE);
        }
    });
}

export async function verify(bytes, pin) {
    if (bytes.byteLength !== pin.size) {
        throw new Error("A speech file is incomplete. Download the model again.");
    }

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");

    if (hex !== pin.sha256) {
        throw new Error("A speech file failed its SHA-256 check. Download the model again.");
    }
}

async function download(url, pin, signal, received) {
    const response = await fetch(url, {
        signal,
        credentials: "same-origin",
        redirect: "error",
        headers: { "X-Pocket": "1" },
    });

    if (!response.ok || !response.body) {
        await response.body?.cancel();

        throw new Error(
            response.status === 507
                ? "The server's speech model cache is full."
                : response.status === 429
                  ? "The server is busy preparing a speech file. Try again shortly."
                  : "The server could not provide this speech file. Try again.",
        );
    }

    const body = response.body.getReader();
    const bytes = new Uint8Array(pin.size);
    let offset = 0;

    try {
        for (;;) {
            const part = await body.read();

            if (part.done) {
                break;
            }

            if (offset + part.value.length > bytes.length) {
                throw new Error("A speech file is larger than expected.");
            }

            bytes.set(part.value, offset);
            offset += part.value.length;
            received(part.value.length);
        }
    } finally {
        await body.cancel().catch(() => {});
    }

    if (offset !== bytes.length) {
        throw new Error("A speech file did not download completely. Try again.");
    }

    await verify(bytes, pin);
    signal.throwIfAborted();

    return new Blob([bytes]);
}

export async function installModel(model, signal, progress) {
    if (modelSize(model) > browserLimit()) {
        throw new Error("This model exceeds this browser's memory limit. Choose a smaller model.");
    }

    const keys = await modelKeys();
    const use = storageUse(keys);
    const next = storageUse([...keys, model.id]);
    const estimate = await navigator.storage?.estimate?.();

    if (
        next > DISK_LIMIT ||
        (estimate?.quota && (estimate.usage ?? 0) + next - use > estimate.quota)
    ) {
        throw new Error(
            "Not enough browser storage. Remove an unused model or choose a smaller one.",
        );
    }

    let done = 0;
    let engine = await transaction("readonly", (store) => receive(store.get(ENGINE)));
    const total = modelSize(model) + (engine ? 0 : ENGINE_FILE.size);
    const files = [];

    const received = (size) => {
        done += size;
        progress(done, total);
    };

    progress(0, total);

    // Prime the browser cache before enabling the mic. These scripts are public and versioned with the asset protocol.
    for (const script of [
        "worker.js",
        "worklet.js",
        "asr-api.js",
        "asr-B3QtWJoU.js",
        "tokens-wFJ0vjND.js",
    ]) {
        const response = await fetch(`${ASSETS}/${script}`, {
            signal,
            credentials: "same-origin",
            redirect: "error",
        });

        if (!response.ok) {
            await response.body?.cancel();

            throw new Error("The offline speech engine could not be loaded.");
        }

        await response.arrayBuffer();
    }

    if (!engine) {
        engine = await download(`${ASSETS}/engine.wasm`, ENGINE_FILE, signal, received);
    }

    for (const pin of model.files) {
        files.push(
            await download(`${ASSETS}/model/${model.id}/${pin.name}`, pin, signal, received),
        );
    }

    // Keep the old model intact until every new file has been checked. Recheck the limit across tabs in this transaction.
    await transaction(
        "readwrite",
        async (store) => {
            const keys = await receive(store.getAllKeys());

            if (storageUse([...keys, model.id]) > DISK_LIMIT) {
                throw new Error("Browser model storage is full. Remove an unused model first.");
            }

            store.put(engine, ENGINE);
            store.put(files, model.id);
        },
        signal,
    );
}

export async function modelBytes(model, signal) {
    const [engine, blobs] = await transaction(
        "readonly",
        (store) => Promise.all([receive(store.get(ENGINE)), receive(store.get(model.id))]),
        signal,
    );

    if (!engine || !Array.isArray(blobs) || blobs.length !== model.files.length) {
        throw new Error("Download a model in Menu → Dictation first.");
    }

    const binary = await engine.arrayBuffer();
    const files = [];

    await verify(binary, ENGINE_FILE);

    for (const [index, pin] of model.files.entries()) {
        signal.throwIfAborted();
        const bytes = await blobs[index].arrayBuffer();

        await verify(bytes, pin);
        files.push({ name: pin.name, bytes });
    }

    return { binary, files };
}
