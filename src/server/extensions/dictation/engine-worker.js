// The worker receives verified files and PCM, not URLs. Its CSP allows WASM and forbids network connections.
import createEngine from "./asr-B3QtWJoU.js";
import { OfflineRecognizer } from "./asr-api.js";

(() => {
    const MAX_MODEL_BYTES = 700_000_000;
    const MAX_SAMPLES = 30 * 16_000;
    let engine = null;
    let loading = false;

    self.onmessage = async ({ data }) => {
        const { id, type } = data;

        try {
            if (type === "load" && !engine && !loading) {
                loading = true;

                const { binary, files, config } = data;
                const size = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

                if (binary.byteLength > 16_000_000 || size > MAX_MODEL_BYTES || files.length > 8) {
                    throw new Error("Speech model too large");
                }

                const wasm = await createEngine({
                    wasmBinary: binary,
                    // The library can log its inputs or file paths. Keep those out of console and diagnostics.
                    print() {},
                    printErr() {},
                });

                for (const { name, bytes } of files) {
                    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(name)) {
                        throw new Error("Bad model file name");
                    }

                    wasm.FS_createDataFile("/", name, new Uint8Array(bytes), true, false, true);
                }

                engine = new OfflineRecognizer(config, wasm);

                if (!engine.handle) {
                    throw new Error("Model refused");
                }

                self.postMessage({ id });

                return;
            }

            const samples = data.samples;

            if (
                type !== "decode" ||
                !engine?.handle ||
                !(samples instanceof Float32Array) ||
                samples.length < 1 ||
                samples.length > MAX_SAMPLES
            ) {
                throw new Error("Bad speech request");
            }

            const stream = engine.createStream();

            try {
                stream.acceptWaveform(16_000, samples);
                engine.decode(stream);
                const result = engine.getResult(stream);

                self.postMessage({
                    id,
                    text: String(result.text ?? "")
                        .trim()
                        .slice(0, 4000),
                });
            } finally {
                stream.free();
            }
        } catch {
            self.postMessage({
                id,
                error:
                    type === "load"
                        ? "The speech model could not load. Try a smaller model."
                        : "Recognition stopped. Try a smaller model.",
            });
        }
    };
})();
