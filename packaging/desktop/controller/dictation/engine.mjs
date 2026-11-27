import { Worker } from "node:worker_threads";

export class SpeechEngine {
    #root;
    #worker;
    #key;
    #request;
    #next = 0;
    #idle;

    constructor(root) {
        this.#root = root.href;
    }

    async warm(selected, folder, words) {
        clearTimeout(this.#idle);
        const key = JSON.stringify([selected, words]);

        if (this.#key === key) {
            return;
        }

        this.drop();
        const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
            execArgv: ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning"],
            stdout: true,
            stderr: true,
            workerData: { root: this.#root, selected, folder, words },
        });

        this.#worker = worker;
        worker.stdout.resume();
        worker.stderr.resume();
        worker.on("message", ({ id, text, error }) => {
            if (worker === this.#worker && id === this.#request?.id) {
                this.#settle(error, text);
            }
        });

        const failed = () => {
            if (worker === this.#worker) {
                this.drop("The offline speech engine stopped. Try a smaller model.");
            }
        };

        worker.on("error", failed);
        worker.on("exit", failed);
        await this.#call({ type: "load" });

        if (worker !== this.#worker) {
            throw new Error("Dictation canceled.");
        }

        this.#key = key;
    }

    #settle(error, value) {
        const request = this.#request;

        this.#request = null;
        clearTimeout(request?.timer);

        if (error) {
            request?.reject(new Error(error));
        } else {
            request?.resolve(value);
        }
    }

    #call(data, transfer = []) {
        return new Promise((resolve, reject) => {
            if (this.#request || !this.#worker) {
                reject(new Error("The speech engine is not ready."));

                return;
            }

            const id = ++this.#next;
            const timer = setTimeout(
                () => this.drop("The speech model took too long. Try a smaller model."),
                60_000,
            ).unref();

            this.#request = { id, timer, resolve, reject };

            try {
                this.#worker.postMessage({ id, ...data }, transfer);
            } catch {
                this.drop("The speech engine could not accept audio.");
            }
        });
    }

    decode(samples) {
        return this.#call({ type: "decode", samples }, [samples.buffer]);
    }

    idle() {
        clearTimeout(this.#idle);
        this.#idle = setTimeout(() => this.drop(), 10 * 60_000).unref();
    }

    drop(message = "Dictation canceled.") {
        clearTimeout(this.#idle);
        void this.#worker?.terminate();
        this.#worker = this.#key = null;
        this.#settle(message);
    }
}
