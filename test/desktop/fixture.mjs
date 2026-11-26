import { createServer } from "node:http";

export async function fixture({ prefix = "/pocket", mode = "pocket" } = {}) {
    let current = mode;
    const requests = [];
    const server = createServer((request, response) => {
        requests.push({
            path: request.url,
            authenticated: Boolean(request.headers.authorization || request.headers.cookie),
        });
        const send = (code, type, body) =>
            response.writeHead(code, { "Content-Type": type }).end(body);

        if (current === "down") {
            send(503, "text/html", "<h1>Temporarily unavailable</h1>");
        } else if (current === "sso") {
            send(401, "text/html", "<!doctype html><h1>Fixture sign-in</h1>");
        } else if (request.url === `${prefix}/api/pocket/info` && current === "pocket") {
            send(200, "application/json", JSON.stringify({ name: "pi-pocket", bridge: 1 }));
        } else if (request.url === `${prefix}/manifest.webmanifest` && current === "legacy") {
            send(200, "application/manifest+json", JSON.stringify({ name: "Pi Pocket" }));
        } else if (request.url === prefix || request.url === `${prefix}/`) {
            send(
                200,
                "text/html",
                "<!doctype html><title>Fixture Pi Pocket</title><h1>Fixture Pi Pocket</h1>",
            );
        } else {
            send(404, "application/json", "{}");
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const origin = `http://127.0.0.1:${server.address().port}`;

    return {
        address: origin + prefix,
        origin,
        requests,
        setMode(next) {
            current = next;
        },
        close: () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
    };
}
