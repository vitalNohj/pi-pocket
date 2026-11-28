import { createServer } from "node:http";

const speechPage = `
    <button id="dictate" style="position:absolute;top:160px;left:55px;width:290px;height:85px">Dictate from native capture fixture</button>
    <textarea id="composer" aria-label="Draft" style="position:absolute;top:260px;left:55px;width:80%;height:120px"></textarea>
    <script>
        const connection = window.pocketDictation?.attach(() => false);
        const ping = (path) => fetch(location.pathname.replace(/\\/$/, '') + path, { method: 'POST' });
        if (connection) {
            ping('/speech-ready');
            document.getElementById('dictate').onclick = () => {
                const speech = new connection.Recognition();
                const composer = document.getElementById('composer');
                composer.focus();
                speech.onresult = ({ results }) => {
                    composer.value = results.filter((part) => part.isFinal).map((part) => part[0].transcript).join(' ');
                };
                speech.onerror = () => ping('/speech-error');
                speech.onend = () => {
                    // A signal, not a transcript: even the test server never gets words or PCM.
                    const normalized = composer.value.toLowerCase().replace(/[^a-z ]/g, '');
                    ping(/ask what you can do for your country/.test(normalized) ? '/speech-pass' : '/speech-mismatch');
                };
                speech.start();
            };
        }
    </script>`;

export async function fixture({ prefix = "/pocket", mode = "pocket", dictation = false } = {}) {
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
        } else if (
            dictation &&
            request.method === "POST" &&
            /^\/speech-(ready|pass|error|mismatch)$/.test(request.url.slice(prefix.length)) &&
            request.url.startsWith(prefix + "/")
        ) {
            send(204, "text/plain", "");
        } else if (request.url === prefix || request.url === `${prefix}/`) {
            send(
                200,
                "text/html",
                `<!doctype html><title>Fixture Pi Pocket</title>
                <meta charset="utf-8"><style>body{background:#eef2f9;color:#17243e;font:18px system-ui;padding:3rem}</style>
                <h1>Pi Pocket fixture server</h1><p>This page runs in the installed app.</p>
                <script>
                    const isolated = typeof window.desktopSettings === 'undefined' &&
                        !window.webkit?.messageHandlers.desktopSettings && window.pocketHost?.apiVersion === 1;
                    fetch(location.pathname.replace(/\\/$/, '') + (isolated ? '/page-only' : '/bad-bridge'));
                </script>${dictation ? speechPage : ""}`,
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
