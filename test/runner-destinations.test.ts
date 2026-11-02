// Where a browser stream may connect on the runner's computer (`src/runner/destinations.ts`), and the private folder
// of this server's own downloads (`privateFolder` in `src/server/browser/downloads.ts`).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import type { LookupAddress } from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { guardedLookup, isLocalName, isPrivateAddress } from "../src/runner/destinations.ts";
import { privateFolder } from "../src/server/browser/downloads.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-destinations-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

/** What `guardedLookup` gives `net.connect` for `host`, when the name resolves to `addresses`. */
function look(host: string, addresses: string[]): Promise<LookupAddress[]> {
    const lookup = guardedLookup((_name, _family, done) =>
        done(
            null,
            addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        ),
    );

    return new Promise((resolve, reject) =>
        lookup(host, { all: true }, (error, found) =>
            error ? reject(error) : resolve(found as unknown as LookupAddress[]),
        ),
    );
}

describe("the runner's DNS rebinding guard", () => {
    it("knows private addresses, their IPv4-mapped forms included", () => {
        for (const address of [
            "127.0.0.1",
            "127.255.0.9",
            "::1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:c0a8:101",
            "0.0.0.0",
            "::",
        ]) {
            assert.ok(isPrivateAddress(address), address);
        }

        for (const address of [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "172.15.255.255",
            "100.128.0.1",
            "192.169.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
            "fec0::1",
        ]) {
            assert.ok(!isPrivateAddress(address), address);
        }
    });

    it("lets local names and IP literals resolve to private addresses", async () => {
        for (const host of [
            "localhost",
            "nas",
            "printer.local",
            "router.lan",
            "box.home.arpa",
            "db.internal",
            "laptop.tail1234.ts.net",
            "app.localhost",
            "127.0.0.1",
            "::1",
            "NAS.LOCAL.",
        ]) {
            assert.ok(isLocalName(host), host);
            assert.deepEqual(
                (await look(host, ["192.168.1.5"])).map((entry) => entry.address),
                ["192.168.1.5"],
            );
        }
    });

    it("refuses a public name that resolves to a private address", async () => {
        for (const addresses of [
            ["127.0.0.1"],
            ["10.0.0.7"],
            ["::ffff:192.168.0.1"],
            // One private address among public ones is enough: the socket could try it.
            ["93.184.215.14", "169.254.169.254"],
        ]) {
            await assert.rejects(look("rebind.example.com", addresses), (error: Error) => {
                assert.match(
                    error.message,
                    /rebind\.example\.com is a public name, but it resolves to/,
                );
                assert.equal((error as NodeJS.ErrnoException).code, "EPRIVATE");

                return true;
            });
        }

        for (const host of ["evil.local.example.com", "localhost.example.com", "ts.net.example"]) {
            assert.ok(!isLocalName(host), host);
        }
    });

    it("gives public names their public addresses, the ones it checked", async () => {
        assert.deepEqual(
            (
                await look("example.com", [
                    "93.184.215.14",
                    "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
                ])
            ).map((entry) => entry.address),
            ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
        );
    });

    it("passes on the resolver's error", async () => {
        const lookup = guardedLookup((_name, _family, done) =>
            done(
                Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.example"), {
                    code: "ENOTFOUND",
                }),
                [],
            ),
        );
        const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
            lookup("nowhere.example", { all: true }, (failed) => resolve(failed)),
        );

        assert.equal(error?.code, "ENOTFOUND");
    });
});

describe("this server's private downloads folder", { skip: process.getuid === undefined }, () => {
    const uid = process.getuid!();

    it("is made with mode 0700, and closed again when it is open to others", async () => {
        const base = join(root, "made");

        mkdirSync(base);
        const folder = await privateFolder(base, uid);

        assert.equal(folder, join(base, `pi-pocket-downloads-${uid}`));
        assert.equal(statSync(folder).mode & 0o777, 0o700);

        chmodSync(folder, 0o755);
        assert.equal(await privateFolder(base, uid), folder);
        assert.equal(statSync(folder).mode & 0o777, 0o700);
    });

    it("is refused when another user owns it, or when it is a link", async () => {
        const base = join(root, "taken");

        mkdirSync(base);
        // Owned by "another user": this folder's owner is not the uid asked for.
        mkdirSync(join(base, `pi-pocket-downloads-${uid + 1}`));
        await assert.rejects(privateFolder(base, uid + 1), /belongs to another user: refused/);

        mkdirSync(join(base, "elsewhere"));
        symlinkSync(join(base, "elsewhere"), join(base, `pi-pocket-downloads-${uid}`));
        await assert.rejects(privateFolder(base, uid), /is not a folder: refused/);
    });
});
