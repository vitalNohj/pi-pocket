// Wrong runner link codes (`src/server/link-limits.ts`): per client address, a ceiling for the server that voids the
// open codes, and which address counts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigStore } from "../src/server/config.ts";
import {
    ADDRESS_WRONG,
    clientAddress,
    LinkLimits,
    LOCK_MS,
    SERVER_WRONG,
    WINDOW_MS,
} from "../src/server/link-limits.ts";
import { Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-link-limits-"));

after(() => rmSync(root, { recursive: true, force: true }));

/** A clock the test moves. */
function clock(start = 1_000_000) {
    let now = start;

    return { now: () => now, move: (ms: number) => (now += ms) };
}

const request = (address: string, headers: Record<string, string> = {}) => ({
    headers,
    socket: { remoteAddress: address },
});

describe("link code limits", () => {
    it("locks one address after too many wrong codes, for a while, and not the others", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);

        for (let each = 0; each < ADDRESS_WRONG - 1; each++) {
            limits.check("203.0.113.5");
            limits.wrong("203.0.113.5");
        }

        limits.check("203.0.113.5");
        limits.wrong("203.0.113.5");
        assert.throws(
            () => limits.check("203.0.113.5"),
            /Too many wrong link codes from this address/,
        );
        limits.check("203.0.113.6");
        assert.deepEqual(
            limits.locks().addresses.map((lock) => lock.address),
            ["203.0.113.5"],
        );

        time.move(LOCK_MS + 1);
        limits.check("203.0.113.5");
        assert.deepEqual(limits.locks(), { addresses: [] });
    });

    it("forgets wrong codes older than the window", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);

        for (let each = 0; each < ADDRESS_WRONG - 1; each++) {
            limits.wrong("198.51.100.1");
        }

        time.move(WINDOW_MS + 1);
        limits.wrong("198.51.100.1");
        limits.check("198.51.100.1");
    });

    it("pauses all linking when wrong codes from many addresses pass the server's ceiling", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);
        let tripped = false;

        for (let each = 0; each < SERVER_WRONG; each++) {
            tripped = limits.wrong(`192.0.2.${each}`) || tripped;
        }

        assert.ok(tripped);
        assert.throws(() => limits.check("192.0.2.250"), /linking is paused/);
        assert.ok(limits.locks().server !== undefined);
        time.move(LOCK_MS + 1);
        limits.check("192.0.2.250");
    });

    it("takes the client address from the socket, and Cloudflare's header only from its local connector", () => {
        const header = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7" };

        assert.equal(
            clientAddress(request("::ffff:127.0.0.1", header), "cloudflare"),
            "203.0.113.9",
        );
        // Not behind the tunnel, or not from this machine: the header is a client's own claim.
        assert.equal(clientAddress(request("127.0.0.1", header), "tailscale-serve"), "127.0.0.1");
        assert.equal(
            clientAddress(request("100.101.102.103", header), "cloudflare"),
            "100.101.102.103",
        );
        assert.equal(
            clientAddress(request("127.0.0.1", { "cf-connecting-ip": "nonsense" }), "cloudflare"),
            "127.0.0.1",
        );
    });

    it("refuses a right code from a locked address, and voids open codes at the ceiling", () => {
        const config = new ConfigStore(mkdtempSync(join(root, "data-")));
        const runners = new Runners({ config, log: () => {} });
        const good = runners.makeCode("Laptop", "owner").code;

        for (let each = 0; each < ADDRESS_WRONG; each++) {
            assert.throws(
                () => runners.redeem("WRONG-CODE-0000", "203.0.113.5"),
                /wrong, already used/,
            );
        }

        assert.throws(() => runners.redeem(good, "203.0.113.5"), /Too many wrong link codes/);

        // Another address still links with it, until the ceiling voids it.
        const other = runners.makeCode("Desktop", "owner").code;

        for (let each = 0; each < SERVER_WRONG - ADDRESS_WRONG; each++) {
            assert.throws(() => runners.redeem("WRONG-CODE-0000", `192.0.2.${each % 200}`));
        }

        assert.throws(() => runners.redeem(other, "198.51.100.1"), /linking is paused/);
        assert.deepEqual(config.runners, []);
        assert.equal(runners.linkLocks().server !== undefined, true);
        runners.close();
    });
});
