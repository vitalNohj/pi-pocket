import http from "node:http";
import https from "node:https";

const agents = { "http:": new http.Agent(), "https:": new https.Agent() };
const REDIRECTS = [301, 302, 303, 307, 308];
const BODY_LIMIT = 16 * 1024;

export function serverAddress(value) {
    if (typeof value !== "string" || value.length > 2048) {
        return null;
    }

    const address = value.trim();

    if (!/^https?:\/\/[^/]/i.test(address) || /[\s\\?#\x00-\x1f\x7f]/u.test(address)) {
        return null;
    }

    try {
        const url = new URL(address);

        if (url.username || url.password || /^https?:\/\/[^/]*@/i.test(address)) {
            return null;
        }

        return url.origin + (url.pathname === "/" ? "" : url.pathname);
    } catch {
        return null;
    }
}

export function signInOrigin(value) {
    const address = serverAddress(value);

    return address && new URL(address).origin === address ? address : null;
}

export function allowedOrigins(value) {
    return (
        Array.isArray(value) &&
        value.length <= 12 &&
        value.every((origin) => signInOrigin(origin) !== null)
    );
}

function endpoint(address, route) {
    const url = new URL(address);

    url.pathname = url.pathname.replace(/\/+$/, "") + route;

    return url;
}

function response(url, signal, peek) {
    const transport = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const request = transport.request(
            url,
            {
                agent: agents[url.protocol],
                signal,
                rejectUnauthorized: true,
                headers: { Accept: "application/json, application/manifest+json, text/html;q=0.5" },
            },
            (incoming) => {
                const code = incoming.statusCode;
                const type = String(incoming.headers["content-type"] || "")
                    .split(";", 1)[0]
                    .trim()
                    .toLowerCase();
                const location = incoming.headers.location;
                const finish = (body) => resolve({ code, type, location, body });

                incoming.on("error", reject);

                if (
                    peek ||
                    code !== 200 ||
                    !["application/json", "application/manifest+json"].includes(type)
                ) {
                    finish("");
                    incoming.destroy();

                    return;
                }

                const chunks = [];
                let size = 0;

                incoming.on("data", (chunk) => {
                    size += chunk.length;

                    if (size > BODY_LIMIT) {
                        finish("");
                        incoming.destroy();
                    } else {
                        chunks.push(chunk);
                    }
                });
                incoming.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
            },
        );

        request.on("error", reject);
        request.end();
    });
}

export function connectionError(code, message) {
    return { code, message };
}

async function follow(start, origins, signal, peek = false) {
    let url = start;

    for (let redirects = 0; redirects <= 4; redirects++) {
        const answer = await response(url, signal, peek);

        if (!REDIRECTS.includes(answer.code) || !answer.location) {
            return { ...answer, origin: url.origin };
        }

        let next;

        try {
            next = new URL(answer.location, url);
        } catch {
            break;
        }

        if (
            !["http:", "https:"].includes(next.protocol) ||
            next.username ||
            next.password ||
            (url.protocol === "https:" && next.protocol !== "https:")
        ) {
            throw connectionError("redirect", "The server redirected to an unsafe address.");
        }

        if (!origins.includes(next.origin)) {
            throw connectionError(
                "origin",
                `The server redirected to ${next.origin.slice(0, 256)}. Add this origin under Server before you connect.`,
            );
        }

        url = next;
    }

    throw connectionError(
        "redirect",
        "The server redirected too many times or returned an invalid redirect.",
    );
}

function body(answer) {
    try {
        return JSON.parse(answer.body);
    } catch {
        return null;
    }
}

export async function probeServer(address, settings, canceled) {
    const origin = new URL(address).origin;
    const origins = [origin, ...settings.allowedOrigins];
    const timeout = AbortSignal.timeout(settings.probeTimeout * 1000);
    const signal = canceled ? AbortSignal.any([timeout, canceled]) : timeout;

    try {
        const info = await follow(endpoint(address, "/api/pocket/info"), origins, signal);
        const identity = body(info);

        if (
            info.origin === origin &&
            identity?.name === "pi-pocket" &&
            Number.isInteger(identity.bridge) &&
            identity.bridge >= 0 &&
            identity.bridge <= 1000
        ) {
            return identity.bridge === 1
                ? { kind: "pocket", bridge: 1, message: "Pi Pocket is ready." }
                : {
                      kind: "legacy",
                      bridge: identity.bridge,
                      message:
                          "Pi Pocket is ready. This bridge version does not support desktop page actions.",
                  };
        }

        const manifest = await follow(endpoint(address, "/manifest.webmanifest"), origins, signal);

        if (manifest.origin === origin && body(manifest)?.name === "Pi Pocket") {
            return {
                kind: "legacy",
                bridge: null,
                message:
                    "An older Pi Pocket is ready. Some desktop page actions are not available.",
            };
        }

        const entry = await follow(new URL(address), origins, signal, true);

        if (
            entry.type === "text/html" &&
            ((entry.code >= 200 && entry.code < 300) || [401, 403].includes(entry.code))
        ) {
            return {
                kind: "preview",
                bridge: null,
                message:
                    "This address returned a webpage, but Pi Pocket could not verify it. It may require sign-in.",
            };
        }

        throw connectionError("not-pocket", "No Pi Pocket server answered at this address.");
    } catch (error) {
        if (canceled?.aborted) {
            throw connectionError("canceled", "The check was canceled.");
        }

        if (timeout.aborted) {
            throw connectionError("timeout", "The server did not answer in time.");
        }

        if (["origin", "redirect", "not-pocket"].includes(error.code)) {
            throw error;
        }

        if (["ENOTFOUND", "EAI_AGAIN"].includes(error.code)) {
            throw connectionError("dns", "The server name could not be found.");
        }

        if (error.code === "ECONNREFUSED") {
            throw connectionError(
                "refused",
                "The server refused the connection. Check the address and port.",
            );
        }

        if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(error.code || "")) {
            throw connectionError(
                "certificate",
                "This computer does not trust the server's certificate.",
            );
        }

        throw connectionError(
            "network",
            "Could not reach the server. Check the address and the network.",
        );
    }
}
