// A check made again where a durable save happens. A command checks who may do it, then prepares (reads the
// conversation, resolves a folder, waits for an approval); meanwhile the person can lose the session, the wheel, or its
// approval. Pi Durable reads a context's abort signal when the queued save reaches the line where it changes anything
// (`Session.#runCommit`), so a context that checks on that read refuses the save there, and nothing is stored.
import type { Context, ContextKey } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

const MARK = new AbortController().signal;
const PROBE = withAbortSignal(MARK, BACKGROUND_CONTEXT);

/**
 * `parent`, with `check` run each time its abort signal is read: a throw aborts the context with that error, which is
 * what the save then rejects with. `check` must be synchronous and change nothing: no session calls, no writes.
 *
 * A context derived from this one (Pi Durable adds its telemetry span) reads the signal through `value`, with a key that
 * is not exported; `PROBE` tells that key from any other, so the check runs on that path too.
 */
export function checkedContext(parent: Context, check: () => void): Context {
    const stopped = new AbortController();

    const signal = (): AbortSignal | undefined => {
        // The parent's own check, if it has one, runs on its read.
        const own = parent.abortSignal;

        if (!stopped.signal.aborted) {
            try {
                check();
            } catch (error) {
                stopped.abort(error);
            }
        }

        return stopped.signal.aborted ? stopped.signal : own;
    };

    return {
        get abortSignal() {
            return signal();
        },
        get telemetry() {
            return parent.telemetry;
        },
        value<T>(key: ContextKey<T>): T | undefined {
            return PROBE.value(key) === (MARK as unknown)
                ? (signal() as T | undefined)
                : parent.value(key);
        },
        toString: () => `${parent.toString()}.Checked`,
    };
}
