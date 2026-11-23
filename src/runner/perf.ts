import { perf } from "../perf.ts";
import { FRAME } from "./protocol.ts";

/** Only records a frame's first handoff to WebSocket, including after a reconnect. */
export class OutboxTiming {
    readonly #waiting = new Map<number, (at: number, bufferedBytes: number) => void>();

    keep(offset: number, sent: (at: number, bufferedBytes: number) => void): void {
        this.#waiting.set(offset, sent);
    }

    send(message: Buffer, bufferedBytes: number): void {
        if (this.#waiting.size === 0 || !perf) {
            return;
        }

        // Both senders write exactly one pi-env frame per stream chunk. The peer acknowledges whole chunks.
        const offset = Number(message.readBigUInt64BE(0));
        const sent = this.#waiting.get(offset);

        if (sent !== undefined) {
            this.#waiting.delete(offset);
            sent(perf.now(), bufferedBytes);
        }
    }
}

type Checked = {
    op: string;
    bytesIn: number;
    start: number;
    checking?: number;
    checked?: number;
    via?: "snapshot" | "daemon";
    bytesOut: number;
    maxOutboxQueueMs: number;
    maxBufferedBytes: number;
};

/** The runner's gate, daemon (or snapshot shortcut), and outbox, on one clock. */
export class RunnerRequestTiming {
    readonly outbox = new OutboxTiming();
    readonly #requests = new Map<number, Checked>();

    begin(id: number, op: string, bytesIn: number): void {
        if (perf) {
            this.#requests.set(id, {
                op,
                bytesIn,
                start: perf.now(),
                bytesOut: 0,
                maxOutboxQueueMs: 0,
                maxBufferedBytes: 0,
            });
        }
    }

    check(id: number): void {
        const timing = this.#requests.get(id);

        if (timing && perf) {
            timing.checking = perf.now();
        }
    }

    checked(id: number, via: Checked["via"]): void {
        const timing = this.#requests.get(id);

        if (timing && perf) {
            timing.checked = perf.now();
            timing.via = via;
        }
    }

    output(session: string | null, offset: number, frame: Buffer): void {
        const trace = perf;
        const type = frame[4];

        if (!trace || (type !== FRAME.result && type !== FRAME.error && type !== FRAME.event)) {
            return;
        }

        const id = frame.readUInt32BE(5);
        const timing = this.#requests.get(id);

        if (!timing) {
            return;
        }

        const queued = trace.now();
        const terminal = type !== FRAME.event;

        timing.bytesOut += frame.length;

        if (terminal) {
            this.#requests.delete(id);
        }

        this.outbox.keep(offset, (sent, bufferedBytes) => {
            const outboxQueueMs = sent - queued;

            timing.maxOutboxQueueMs = Math.max(timing.maxOutboxQueueMs, outboxQueueMs);
            timing.maxBufferedBytes = Math.max(timing.maxBufferedBytes, bufferedBytes);

            if (terminal) {
                const checking = timing.checking ?? queued;
                const checked = timing.checked ?? queued;
                const executionMs = queued - checked;

                trace.log("runner.request", {
                    session,
                    id,
                    op: timing.op,
                    start: timing.start,
                    ms: sent - timing.start,
                    bytesIn: timing.bytesIn,
                    bytesOut: timing.bytesOut,
                    checkQueueMs: checking - timing.start,
                    checkMs: checked - checking,
                    daemonMs: timing.via === "daemon" ? executionMs : undefined,
                    snapshotMs: timing.via === "snapshot" ? executionMs : undefined,
                    outboxQueueMs,
                    maxOutboxQueueMs: timing.maxOutboxQueueMs,
                    maxBufferedBytes: timing.maxBufferedBytes,
                    ok: type === FRAME.result,
                });
            }
        });
    }
}
