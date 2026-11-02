/**
 * Where a browser stream of the server may connect on this computer: a guard against DNS rebinding. A page on a public
 * site can make its own name resolve to an address on this computer's network (its localhost, its router, its NAS),
 * then read from it as the same origin. So the runner resolves each name itself, refuses a public name that resolves
 * to a private address, and connects to the addresses it checked, never to the name again.
 *
 * Names that are meant to be local keep working: IP literals, `localhost`, single-label names (`nas`), and names under
 * `.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`, and `.localhost`.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Name suffixes of local networks: their names may resolve to private addresses. */
const LOCAL_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal", ".ts.net", ".localhost"];

/** Addresses on a computer's own networks. `BlockList` also matches their IPv4-mapped IPv6 forms (`::ffff:a.b.c.d`). */
const PRIVATE = new BlockList();

for (const [network, prefix] of [
    // This network: on Linux and macOS, 0.0.0.0 reaches this computer.
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["169.254.0.0", 16],
    ["100.64.0.0", 10],
] as const) {
    PRIVATE.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
] as const) {
    PRIVATE.addSubnet(network, prefix, "ipv6");
}

/** Whether an address is on a computer's own networks. */
export function isPrivateAddress(address: string): boolean {
    const family = isIP(address);

    return family !== 0 && PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Whether a host name may resolve to a private address: an IP literal, or a name of a local network. */
export function isLocalName(host: string): boolean {
    const name = host.toLowerCase().replace(/\.$/, "");

    return (
        isIP(name) !== 0 ||
        !name.includes(".") ||
        LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
    );
}

/** A public name resolved to a private address. */
export class PrivateAddressError extends Error {
    readonly code = "EPRIVATE";
}

/** Resolve a name to all its addresses, as `dns.lookup` does. */
export type Resolve = (
    host: string,
    family: number,
    done: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolve: Resolve = (host, family, done) =>
    dnsLookup(host, { all: true, family }, (error, addresses) => done(error, addresses ?? []));

/**
 * The `lookup` of `net.connect` for a browser stream: it resolves the name once, refuses a public name with a private
 * address (`PrivateAddressError`), and gives the socket the addresses it checked.
 */
export function guardedLookup(resolve: Resolve = systemResolve): LookupFunction {
    return (host, options, callback) => {
        resolve(
            host,
            options.family === 4 || options.family === 6 ? options.family : 0,
            (error, addresses) => {
                if (error !== null || addresses.length === 0) {
                    const failed: NodeJS.ErrnoException =
                        error ??
                        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
                            code: "ENOTFOUND",
                        });

                    return callback(failed, "", 4);
                }

                const inside = isLocalName(host)
                    ? undefined
                    : addresses.find((entry) => isPrivateAddress(entry.address));

                if (inside !== undefined) {
                    return callback(
                        new PrivateAddressError(
                            `${host} is a public name, but it resolves to ${inside.address}, a private address: refused, so that a site cannot reach this computer's network`,
                        ),
                        "",
                        4,
                    );
                }

                if (options.all === true) {
                    return (
                        callback as unknown as (error: null, addresses: LookupAddress[]) => void
                    )(null, addresses);
                }

                callback(null, addresses[0]!.address, addresses[0]!.family);
            },
        );
    };
}
