// A silent sink. Group and downsample audio next to the microphone before handing it to the page.
class DictationPcm extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ratio = sampleRate / 16_000;
        this.left = this.ratio;
        this.sum = 0;
        this.frame = new Float32Array(1600);
        this.offset = 0;
    }

    process(inputs) {
        const channel = inputs[0]?.[0];

        if (!channel) {
            return true;
        }

        for (const value of channel) {
            let remaining = 1;

            while (remaining > 1e-9) {
                const weight = Math.min(remaining, this.left);

                this.sum += value * weight;
                this.left -= weight;
                remaining -= weight;

                if (this.left <= 1e-9) {
                    this.frame[this.offset++] = this.sum / this.ratio;
                    this.left = this.ratio;
                    this.sum = 0;

                    if (this.offset === this.frame.length) {
                        this.port.postMessage(this.frame, [this.frame.buffer]);
                        this.frame = new Float32Array(1600);
                        this.offset = 0;
                    }
                }
            }
        }

        return true;
    }
}

registerProcessor("dictation-pcm", DictationPcm);
