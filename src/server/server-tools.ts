/**
 * Whether git and GitHub are ready on this server, as a runner says it of its own computer (`runner-link/tools.ts`),
 * for This server's page in Access → Settings. Checked only when asked, never at start: one check at a time, and its
 * answer is used again for a minute, so a page that opens often starts no more programs.
 */
import type { RunnerTools } from "./runner-link/protocol.ts";
import { checkTools } from "./runner-link/tools.ts";

/** How long an answer is used again. */
const KEEP_MS = 60_000;

export class ServerTools {
    readonly #check: () => Promise<RunnerTools>;
    readonly #now: () => number;
    /** The check under way: whoever asks meanwhile shares it. */
    #running: Promise<RunnerTools> | undefined;
    #last: { tools: RunnerTools; at: number } | undefined;

    constructor(check: () => Promise<RunnerTools> = checkTools, now: () => number = Date.now) {
        this.#check = check;
        this.#now = now;
    }

    /** The last answer while it is less than a minute old, else a new check. A check that fails is not kept. */
    read(): Promise<RunnerTools> {
        if (this.#last !== undefined && this.#now() - this.#last.at < KEEP_MS) {
            return Promise.resolve(this.#last.tools);
        }

        this.#running ??= this.#check().then(
            (tools) => {
                this.#last = { tools, at: this.#now() };
                this.#running = undefined;

                return tools;
            },
            (error: unknown) => {
                this.#running = undefined;

                throw error;
            },
        );

        return this.#running;
    }
}
