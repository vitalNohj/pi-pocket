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

function pageScript(prefix) {
    return `
        const base = ${JSON.stringify(prefix)};
        const host = window.pocketHost;
        const report = (event) => fetch(base + '/' + event);
        const isolated = typeof window.desktopSettings === 'undefined' &&
            !window.webkit?.messageHandlers.desktopSettings && host?.apiVersion === 1;
        report(isolated ? 'page-only' : 'bad-bridge');
        if (isolated) {
            const sheet = document.querySelector('#new');
            host.subscribe((event) => {
                if (event.type === 'open') {
                    document.querySelector('#session').textContent = 'Opened ' + event.url;
                    report('opened' + event.url);
                } else if (event.type === 'newSession') {
                    if (sheet.open) { sheet.close(); }
                    sheet.showModal();
                    if (sheet.open) { report('new-sheet'); }
                } else if (event.type === 'visibility' && !host.visible()) {
                    report('window-hidden');
                } else if (event.type === 'primary' && host.primary()) {
                    report('primary');
                }
            }, ['visibility', 'open', 'newSession', 'primary']);
            host.setAccount(true);
            host.setPinned([
                { id: 4, title: 'Release notes & checks', label: 'Waiting for you', state: 'waiting' },
                { id: 17, title: 'Installer smoke', label: 'Working', state: 'working' },
            ]);
            let seen = 0;
            async function nextStep() {
                try {
                    const step = await fetch(base + '/fixture-step').then((r) => r.json());
                    if (step.number > seen && host.primary()) {
                        if (step.badge !== undefined) {
                            if (step.hidden && host.visible()) { return; }
                            host.setBadge(step.badge);
                        } else if (step.call) {
                            host.notify({ title: 'Pi needs approval', url: '/s/4',
                                tag: 'approval-fixture-' + step.number,
                                approval: { id: 'fixture-' + step.number, may: true, call: step.call },
                            });
                        }
                        seen = step.number;
                        report('step-' + seen);
                    }
                } finally {
                    setTimeout(nextStep, 300);
                }
            }
            nextStep();
        }
    `;
}

export async function fixture({ prefix = "/pocket", mode = "pocket", dictation = false } = {}) {
    let current = mode;
    let step = { number: 0 };
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
                <h1>Pi Pocket fixture server</h1><p id="session">This page runs in the installed app.</p>
                <dialog id="new"><h2>New Session</h2><p>Choose where to start a session.</p>
                    <form method="dialog"><button>Cancel</button></form>
                </dialog>
                <script src="${prefix}/fixture.js"></script>${dictation ? speechPage : ""}`,
            );
        } else if (request.url === `${prefix}/fixture.js`) {
            send(200, "text/javascript", pageScript(prefix));
        } else if (request.url === `${prefix}/fixture-step`) {
            response.setHeader("Cache-Control", "no-store");
            send(200, "application/json", JSON.stringify(step));
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
        step(data) {
            step = { ...data, number: step.number + 1 };

            return step.number;
        },
        close: () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
    };
}
