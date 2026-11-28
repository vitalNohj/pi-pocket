// Prepare only the disposable installer smoke. The screenshot still shows the installed Pi Pocket page.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [command, file, mode] = process.argv.slice(2);

if (command === "theme" && ["dark", "light"].includes(mode)) {
    const source = readFileSync(`${file}.evidence-original`, "utf8");
    const marker = "(function () {";
    const appearance = { theme: mode === "light" ? "catppuccin-latte" : "tokyo-night" };

    if (!source.includes(marker)) {
        throw new Error("The installed Pi Pocket page has no early theme script");
    }

    writeFileSync(
        file,
        source.replace(
            marker,
            `${marker}
        localStorage.removeItem("pocket.themeCache");
        localStorage.setItem("pocket.appearance", ${JSON.stringify(JSON.stringify(appearance))});
        // Use the real Not now action on this disposable owner's setup prompt.
        const welcome = new MutationObserver(() => {
            const actions = document.querySelectorAll('[data-sheet="owner-setup"] button');
            const later = Array.from(actions).find((button) => button.textContent.trim() === "Not now");
            if (later && !later.disabled) {
                welcome.disconnect();
                later.click();
            }
        });
        welcome.observe(document.documentElement, { childList: true, subtree: true });`,
        ),
    );
} else if (command === "wallpaper") {
    // Color shapes with distinct edges make a native blur visible both inside and outside the window.
    const width = 1600;
    const height = 1000;
    const bmp = Buffer.alloc(54 + width * height * 3);
    bmp.write("BM");
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(width, 18);
    bmp.writeInt32LE(height, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    const colors = [
        [24, 63, 135],
        [21, 159, 172],
        [108, 62, 187],
        [238, 100, 117],
        [251, 185, 82],
        [33, 191, 154],
    ];

    for (let y = height - 1, i = 54; y >= 0; y--) {
        for (let x = 0; x < width; x++, i += 3) {
            const wave = x + 260 * Math.sin(y / 240) - y * 0.4;
            const stripe = Math.floor(wave / 330) % colors.length;
            const [r, g, b] = colors[(stripe + colors.length) % colors.length];
            const shade = 0.86 + 0.14 * Math.cos((x + y) / 310);
            bmp[i] = b * shade;
            bmp[i + 1] = g * shade;
            bmp[i + 2] = r * shade;
        }
    }

    writeFileSync(file, bmp);
} else if (command === "alternate-origin") {
    async function listen(serve) {
        const server = createServer(serve);

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

        return `http://127.0.0.1:${server.address().port}`;
    }

    // Simulate a verified server sending the app to a permitted sign-in origin. There is no sign-in,
    // and this page leaves the background clear so the native opaque fallback has to paint it.
    const signIn = await listen((request, response) => {
        if (request.url === "/displayed") {
            writeFileSync(`${file}.displayed`, "The alternate-origin page loaded in WebView2.\n");
            response.writeHead(204).end();
        } else {
            response.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html>
                <title>Fixture sign-in</title><h1>Fixture sign-in</h1><p>No credentials needed.</p>
                <script>fetch('/displayed')</script>`);
        }
    });
    const remoteAddress = await listen((request, response) => {
        if (request.url === "/api/pocket/info") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ name: "pi-pocket", bridge: 1 }));
        } else {
            response.writeHead(302, { Location: signIn }).end();
        }
    });

    writeFileSync(file, JSON.stringify({ remoteAddress, allowedOrigins: [signIn] }));
} else {
    throw new Error(
        "Use wallpaper <file>, theme <installed index.html> <dark|light>, or alternate-origin <file>",
    );
}
