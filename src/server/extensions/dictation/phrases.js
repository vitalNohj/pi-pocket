export const PCM_RATE = 16_000;
export const PCM_FRAME = PCM_RATE / 10;
const PAUSE = 6; // 600 ms
const PRE_ROLL = 3;
const MIN_SPEECH = 2;
const PARTIAL_EVERY = 2 * PCM_RATE;

/** A bounded segmenter for mono 16 kHz input. Decode one request at a time; never queue interim work. */
export class Phrases {
    #chunks = [];
    #results = [];
    #voice = 0;
    #quiet = 0;
    #lastPartial = 0;
    #publishedPartial = false;
    #pending = 0;
    #chain = Promise.resolve();
    #stopped = false;
    #cancelled = false;
    #generation = 0;
    #decode;
    #publish;
    #error;
    #live;
    #limit;

    constructor({ decode, publish, error, live = true, seconds = 20 }) {
        this.#decode = decode;
        this.#publish = publish;
        this.#error = error;
        this.#live = live;
        this.#limit = seconds * PCM_RATE;
    }

    accept(frame) {
        if (
            this.#stopped ||
            this.#cancelled ||
            !(frame instanceof Float32Array) ||
            frame.length !== PCM_FRAME
        ) {
            return;
        }

        let energy = 0;

        for (const value of frame) {
            energy += value * value;
        }

        const loud = energy / frame.length > 0.0001;

        this.#chunks.push(frame);

        if (!loud && this.#voice === 0) {
            if (this.#chunks.length > PRE_ROLL) {
                this.#chunks.shift();
            }

            return;
        }

        this.#voice += Number(loud);
        this.#quiet = loud ? 0 : this.#quiet + 1;

        const length = this.#chunks.length * PCM_FRAME;

        if (this.#quiet >= PAUSE || length >= this.#limit) {
            this.#finalize();
        } else if (
            this.#live &&
            this.#pending === 0 &&
            length - this.#lastPartial >= PARTIAL_EVERY
        ) {
            this.#lastPartial = length;
            this.#run(this.#samples(), false);
        }
    }

    #samples() {
        const samples = new Float32Array(this.#chunks.length * PCM_FRAME);

        this.#chunks.forEach((frame, index) => samples.set(frame, index * PCM_FRAME));

        return samples;
    }

    #finalize() {
        this.#generation++;

        if (this.#voice >= MIN_SPEECH) {
            this.#run(this.#samples(), true);
        }

        this.#chunks = [];
        this.#voice = this.#quiet = this.#lastPartial = 0;
    }

    #run(samples, final) {
        if (this.#pending >= 3) {
            this.cancel();
            this.#error(new Error("The speech model cannot keep up. Try a smaller model."));

            return;
        }

        const generation = this.#generation;

        this.#pending++;
        this.#chain = this.#chain
            .then(async () => {
                if (this.#cancelled) {
                    return;
                }

                const text = await this.#decode(samples);

                if (this.#cancelled || (!final && generation !== this.#generation)) {
                    return;
                }

                if (final && text) {
                    this.#results.push({ 0: { transcript: text }, isFinal: true });
                }

                const results = liveResult(this.#results, !final ? text : "");

                if (results.length > 0 || this.#publishedPartial) {
                    this.#publish({ results });
                }

                this.#publishedPartial = !final && Boolean(text);
            })
            .catch((error) => {
                if (!this.#cancelled) {
                    this.cancel();
                    this.#error(error);
                }
            })
            .finally(() => this.#pending--);
    }

    async finish() {
        if (!this.#stopped && !this.#cancelled) {
            this.#stopped = true;
            this.#finalize();
        }

        await this.#chain;

        return this.#results.length > 0;
    }

    cancel() {
        this.#cancelled = true;
        this.#chunks = [];
        this.#results = [];
    }
}

function liveResult(results, text) {
    return text ? [...results, { 0: { transcript: text }, isFinal: false }] : [...results];
}
