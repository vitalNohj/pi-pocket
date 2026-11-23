/** Opt-in diagnostics. Never put paths, request bodies, tool arguments, or output in these records. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream } from "node:fs";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

type Fields = Record<string, unknown>;
type Phase = { name: string; start: number; ms: number; span?: number };

function createPerf(file: string) {
    const out = createWriteStream(file, { flags: "a", mode: 0o600 });
    const scope = new AsyncLocalStorage<number>();
    const phases: Phase[] = [];
    let serial = 0;
    let dropped = 0;

    out.on("error", (error) => console.warn(`PI_POCKET_PERF_FILE: ${error.message}`));

    const now = () => performance.now();
    const current = () => scope.getStore();

    const log = (kind: string, fields: Fields) => {
        if (out.destroyed) {
            return;
        }

        // A slow destination must not make the trace an unbounded queue.
        if (out.writableLength > 1024 * 1024) {
            dropped++;

            return;
        }

        const t = now();

        out.write(
            `${JSON.stringify({ kind, pid: process.pid, t, at: performance.timeOrigin + t, ...fields, ...(dropped === 0 ? {} : { dropped }) })}\n`,
        );
        dropped = 0;
    };

    const operation = <T>(op: string, fields: Fields, work: () => T | Promise<T>): Promise<T> => {
        const span = ++serial;
        const parent = current();
        const start = now();

        return scope.run(span, async () => {
            let ok = false;

            try {
                const value = await work();

                ok = true;

                return value;
            } finally {
                log("operation", { op, span, parent, start, ms: now() - start, ok, ...fields });
            }
        });
    };

    const remember = (phase: Phase) => {
        phases.push(phase);

        if (phases.length > 64) {
            phases.shift();
        }
    };

    /** Bracket synchronous work only. An awaited operation is not evidence of a block. */
    const phase = (name: string) => {
        const start = now();
        const span = current();

        return () => {
            const ms = now() - start;

            if (ms >= 5) {
                remember({ name, start, ms, span });
            }
        };
    };

    const watchEventLoop = () => {
        const resolution = 10;
        const threshold = 50;
        const histogram = monitorEventLoopDelay({ resolution });
        const gc = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration >= 5) {
                    remember({ name: "gc", start: entry.startTime, ms: entry.duration });
                }
            }
        });

        histogram.enable();
        gc.observe({ entryTypes: ["gc"] });
        let previous = now();
        let reported = -Infinity;
        const timer = setInterval(() => {
            const end = now();
            const elapsed = end - previous;
            const driftMs = Math.max(0, elapsed - resolution);
            const histogramMs = Math.max(0, histogram.max / 1e6 - resolution);

            previous = end;
            histogram.reset();

            if (
                driftMs <= threshold &&
                (histogramMs <= threshold || end - reported < 2 * resolution)
            ) {
                return;
            }

            reported = end;
            const start = end - Math.max(elapsed, histogramMs + resolution);

            // Give perf_hooks a turn to publish GC entries for the same interval.
            setImmediate(() =>
                log("event-loop", {
                    start,
                    end,
                    driftMs,
                    histogramMs,
                    phases: phases.filter(
                        (each) => each.start < end && each.start + each.ms > start,
                    ),
                }),
            ).unref();
        }, resolution);

        timer.unref();

        return () => {
            clearInterval(timer);
            histogram.disable();
            gc.disconnect();
        };
    };

    return { now, current, log, operation, phase, watchEventLoop };
}

const file = process.env.PI_POCKET_PERF_FILE;

/** Undefined by default: no clock reads, trace state, timers, or I/O on the normal path. */
export const perf = process.env.PI_POCKET_PERF === "1" && file ? createPerf(file) : undefined;
