import { modelById, modelSize } from "./catalog.js";
import { ASSETS, browserLimit, modelBytes } from "./model-store.js";
import { bpeVocab, modelConfig } from "./model-config.js";
import { Phrases } from "./phrases.js";

const IDLE_MS = 10 * 60_000;
const SESSION_MS = 2 * 60_000;
const TIMEOUT_MS = 60_000;

export function captureAvailable() {
    return (
        globalThis.isSecureContext &&
        window.top === window &&
        Boolean(
            navigator.mediaDevices?.getUserMedia &&
            globalThis.AudioContext &&
            globalThis.AudioWorkletNode &&
            globalThis.Worker &&
            globalThis.indexedDB &&
            globalThis.crypto?.subtle,
        )
    );
}

/** A single per-tab worker. Canceling during inference terminates it, so a stale generation cannot reply. */
export class BrowserEngine {
    #worker = null;
    #key = null;
    #pending = null;
    #id = 0;
    #timer = null;

    async warm(model, words, signal) {
        clearTimeout(this.#timer);
        const key = JSON.stringify([model.id, words]);

        if (this.#key === key) {
            return;
        }

        this.drop();
        const { binary, files } = await modelBytes(model, signal);
        const config = modelConfig(model, "/", words);

        if (model.family === "parakeet" && words.length) {
            const tokens = files.find(({ name }) => name === "tokens.txt");
            const encoder = new TextEncoder();

            files.push({ name: "hotwords.txt", bytes: encoder.encode(words.join("\n")).buffer });
            files.push({
                name: "hotwords.vocab",
                bytes: encoder.encode(bpeVocab(new TextDecoder().decode(tokens.bytes))).buffer,
            });
        }

        signal.throwIfAborted();
        this.#worker = new Worker(`${ASSETS}/worker.js`, {
            type: "module",
            name: "Pi Pocket offline dictation",
        });

        this.#worker.onmessage = ({ data }) => {
            if (this.#pending?.id === data.id) {
                this.#pending.done(data.error ? new Error(data.error) : null, data.text);
            }
        };

        this.#worker.onerror = (event) => {
            event.preventDefault();
            this.drop("The offline speech engine could not start. Try a smaller model.");
        };

        await this.#request({ type: "load", binary, config, files }, [
            binary,
            ...files.map((file) => file.bytes),
        ]);
        this.#key = key;
    }

    #request(data, transfer) {
        if (!this.#worker || this.#pending) {
            throw new Error("The offline speech engine is not ready.");
        }

        const id = ++this.#id;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => this.drop("The speech model took too long. Try a smaller model."),
                TIMEOUT_MS,
            );

            const done = (error, text) => {
                clearTimeout(timer);
                this.#pending = null;
                error ? reject(error) : resolve(text);
            };

            this.#pending = { id, done };

            try {
                this.#worker.postMessage({ id, ...data }, transfer);
            } catch {
                this.drop(
                    "The browser could not allocate space for this speech model. Try a smaller model.",
                );
            }
        });
    }

    decode(samples) {
        return this.#request({ type: "decode", samples }, [samples.buffer]);
    }

    idle() {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.drop(), IDLE_MS);
    }

    drop(message = "Dictation canceled.") {
        clearTimeout(this.#timer);
        this.#worker?.terminate();
        this.#worker = this.#key = null;
        this.#pending?.done(new Error(message));
    }
}

/** Only the composer calls start. The adapter never reads or sends the draft. */
export function createRecognition(engine, preferences) {
    return class OfflineRecognition {
        #life = new AbortController();
        #context = null;
        #stream = null;
        #worklet = null;
        #timer = null;
        #phrases = null;
        #finishing = false;

        start() {
            void this.#capture().catch((error) => this.#failed(error));
        }

        async #capture() {
            const signal = this.#life.signal;
            const { selected, live, words } = preferences();
            const model = modelById(selected);

            if (!captureAvailable()) {
                throw new Error(
                    "Offline dictation needs a secure browser tab with microphone and local storage support.",
                );
            }

            if (document.hidden) {
                throw new Error("Show the tab before you start dictation.");
            }

            if (!model) {
                throw new Error("Choose a speech model in Menu → Dictation first.");
            }

            if (modelSize(model) > browserLimit()) {
                throw new Error("This device needs a smaller speech model.");
            }

            // Resume while the click or key still gives the context user activation.
            const context = new AudioContext();

            this.#context = context;
            this.#timer = setTimeout(() => this.stop(), SESSION_MS);
            await context.resume();
            signal.throwIfAborted();
            await engine.warm(model, model.family === "parakeet" ? words : [], signal);
            signal.throwIfAborted();
            await context.audioWorklet.addModule(`${ASSETS}/worklet.js`);
            signal.throwIfAborted();
            const stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: { channelCount: 1 },
            });

            if (signal.aborted) {
                stream.getTracks().forEach((track) => track.stop());

                return;
            }

            this.#stream = stream;
            const lost = () => this.#failed(new Error("The microphone is no longer available."));

            stream
                .getTracks()
                .forEach((track) => track.addEventListener("ended", lost, { once: true, signal }));
            this.#phrases = new Phrases({
                live,
                seconds: model.family === "whisper" ? 20 : 30,
                decode: (samples) => engine.decode(samples),
                publish: (event) => this.onresult?.(event),
                error: (error) => this.#failed(error),
            });
            const worklet = new AudioWorkletNode(context, "dictation-pcm", {
                outputChannelCount: [1],
            });

            this.#worklet = worklet;
            worklet.port.onmessage = ({ data }) => this.#phrases?.accept(data);
            worklet.onprocessorerror = lost;
            context.createMediaStreamSource(stream).connect(worklet).connect(context.destination);
            // The worklet never copies its input to the output. Connecting it keeps it running, but is silent.
            void navigator.permissions
                ?.query({ name: "microphone" })
                .then((status) => {
                    if (signal.aborted) {
                        return;
                    }

                    const changed = () => {
                        if (status.state !== "granted") {
                            lost();
                        }
                    };

                    status.addEventListener("change", changed, { signal });
                    changed();
                })
                .catch(() => {});
        }

        #releaseMic() {
            clearTimeout(this.#timer);
            this.#stream?.getTracks().forEach((track) => track.stop());
            this.#stream = null;
            this.#worklet?.port.close();
            this.#worklet?.disconnect();
            this.#worklet = null;
            void this.#context?.close().catch(() => {});
            this.#context = null;
        }

        #failed(error) {
            if (this.#life.signal.aborted) {
                return;
            }

            const kind =
                error?.name === "NotAllowedError"
                    ? "not-allowed"
                    : error?.name === "NotFoundError" || error?.name === "NotReadableError"
                      ? "audio-capture"
                      : "offline";

            this.onerror?.({ error: kind, message: error?.message });
            this.abort();
        }

        stop() {
            if (this.#life.signal.aborted || this.#finishing) {
                return;
            }

            if (!this.#phrases) {
                this.abort();

                return;
            }

            this.#finishing = true;
            this.#releaseMic();
            void this.#phrases.finish().then((heard) => {
                if (this.#life.signal.aborted) {
                    return;
                }

                if (!heard) {
                    this.onerror?.({ error: "no-speech" });
                }

                this.#life.abort();
                engine.idle();
                this.onend?.();
            });
        }

        abort() {
            if (!this.#life.signal.aborted) {
                this.#life.abort();
                this.#releaseMic();
                this.#phrases?.cancel();
                engine.drop();
                this.onend?.();
            }
        }
    };
}
