/**
 * Limits on wrong runner link codes (`runners.ts` `redeem`), the one way in that needs no sign-in: a code is the whole
 * of the access, so guessing must stay slow.
 *
 * - Per client address: `ADDRESS_WRONG` wrong codes within `WINDOW_MS` lock that address out for `LOCK_MS`.
 * - For the whole server, a ceiling above that: `SERVER_WRONG` wrong codes from all addresses together within
 *   `WINDOW_MS` lock every redeem for `LOCK_MS`, and the caller voids every open code, so the owner makes a new one.
 *
 * The client address is the socket's own. A proxy's headers are believed only for Cloudflare's tunnel: when the server
 * runs behind it (access mode "cloudflare") and the request came from this machine, where its connector runs,
 * `CF-Connecting-IP` names the client. Every other header is ignored, so a client cannot pick its own address. Behind
 * another local proxy (Tailscale Serve), all its clients share the proxy's address, and the per-address limit is then
 * the server's.
 *
 * Kept in memory: a restart clears the counts, as it voids no codes.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { HttpError } from "./errors.ts";

export const ADDRESS_WRONG = 5;
export const SERVER_WRONG = 50;
export const WINDOW_MS = 10 * 60_000;
export const LOCK_MS = 10 * 60_000;

/** A lock for the Runners sheet: who, until when. */
export type LinkLock = { address: string; until: number };

export type LinkLocks = { server?: number; addresses: LinkLock[] };

/** Whether `address` is this machine's loopback address. */
function loopback(address: string): boolean {
    const bare = address.replace(/^::ffff:/i, "");

    return bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127."));
}

/** The address a request came from, as said above. `accessMode`: how the server is reached (`AccessInfo.mode`). */
export function clientAddress(
    request: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } },
    accessMode: string | undefined,
): string {
    const direct = (request.socket.remoteAddress ?? "unknown").replace(/^::ffff:/i, "");

    if (accessMode === "cloudflare" && loopback(direct)) {
        const header = request.headers["cf-connecting-ip"];
        const named = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";

        if (isIP(named) !== 0) {
            return named.replace(/^::ffff:/i, "");
        }
    }

    return direct;
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export class LinkLimits {
    readonly #now: () => number;
    /** The times of recent wrong codes, by address. */
    readonly #wrong = new Map<string, number[]>();
    readonly #locked = new Map<string, number>();
    #all: number[] = [];
    #serverUntil = 0;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** Refuse a redeem from `address` while it, or the server, is locked. */
    check(address: string): void {
        const now = this.#now();

        this.#prune(now);

        if (this.#serverUntil > now) {
            throw new HttpError(
                429,
                `Too many wrong link codes reached this server, so linking is paused for ${minutes(this.#serverUntil - now)} min, and the open codes were voided. Get a new code in Menu → Runners after that.`,
            );
        }

        const until = this.#locked.get(address);

        if (until !== undefined && until > now) {
            throw new HttpError(
                429,
                `Too many wrong link codes from this address. Try again in ${minutes(until - now)} min.`,
            );
        }
    }

    /** Count a wrong code from `address`. True when that tripped the server's ceiling: void every open code then. */
    wrong(address: string): boolean {
        const now = this.#now();

        this.#prune(now);

        const times = [...(this.#wrong.get(address) ?? []), now];

        this.#wrong.set(address, times);

        if (times.length >= ADDRESS_WRONG) {
            this.#locked.set(address, now + LOCK_MS);
            this.#wrong.delete(address);
        }

        this.#all.push(now);

        if (this.#all.length >= SERVER_WRONG) {
            this.#serverUntil = now + LOCK_MS;
            this.#all = [];

            return true;
        }

        return false;
    }

    /** The locks now, for the Runners sheet. */
    locks(): LinkLocks {
        const now = this.#now();

        this.#prune(now);

        return {
            ...(this.#serverUntil > now ? { server: this.#serverUntil } : {}),
            addresses: [...this.#locked].map(([address, until]) => ({ address, until })),
        };
    }

    #prune(now: number): void {
        const since = now - WINDOW_MS;

        for (const [address, times] of this.#wrong) {
            const recent = times.filter((time) => time > since);

            if (recent.length === 0) {
                this.#wrong.delete(address);
            } else {
                this.#wrong.set(address, recent);
            }
        }

        for (const [address, until] of this.#locked) {
            if (until <= now) {
                this.#locked.delete(address);
            }
        }

        this.#all = this.#all.filter((time) => time > since);
    }
}
