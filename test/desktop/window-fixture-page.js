// This script replaces app.js in the CI package only. It renders a real Window Controls Overlay surface.
const root = document.documentElement;
const mode = new URLSearchParams(location.search).get("mode") === "dark" ? "dark" : "light";
root.dataset.mode = mode;
root.dataset.tiling = "on";
root.style.setProperty("--o-bg", mode === "dark" ? "#212833" : "#f5f1e9");
root.style.setProperty("--o-bg-darker", mode === "dark" ? "#171c25" : "#e3dccd");
root.style.setProperty("--o-fg", mode === "dark" ? "#d7e0ea" : "#25303b");
root.style.setProperty("--o-fg-bright", mode === "dark" ? "#f5f7fa" : "#182330");
root.style.setProperty("--o-accent", mode === "dark" ? "#87c9b0" : "#195a48");

const style = document.createElement("style");
style.textContent = `
    .fixture { width: 100vw; height: 100vh; padding: 8px; display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 8px; }
    .fixture .window { min-width: 0; height: 100%; border: 1px solid var(--line); }
    .fixture .topbar { height: 48px; padding: 4px 14px; font-weight: 600; }
    .fixture .home-list { padding: 22px; }
    .fixture main { padding: 20px 28px; }
    .fixture button, .fixture a { display: inline-grid; place-items: center; width: 128px; height: 48px; color: var(--text);
        border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
    .fixture .hits { position: fixed; top: 150px; left: 280px; display: flex; gap: 8px; }
`;
document.head.append(style);
document.body.innerHTML = `
    <div id="app" class="fixture layout">
        <aside class="home-list window"><h2>Sessions</h2><p>Native window fixture</p><p>Installer smoke</p></aside>
        <section class="window">
            <header class="topbar">Pi Pocket · ${mode === "dark" ? "Dark" : "Light"}</header>
            <main>
                <h1>Window actions</h1>
                <p>System buttons · Page controls · File downloads</p>
                <span class="hits">
                    <button id="theme"><span>Dark theme</span></button>
                    <button id="extra"><span>Extra window</span></button>
                    <a id="download" download="window-fixture.txt">Session file</a>
                    <a id="save" download="window-dialog.txt">Save dialog</a>
                </span>
            </main>
        </section>
    </div>
`;

await import("/window-controls.js");
const other = new URL("?mode=dark", location.href);
document.querySelector("#theme").addEventListener("click", () => location.assign(other));
document.querySelector("#extra").addEventListener("click", () => window.open(other, "_blank"));
document.querySelector("#save").href = URL.createObjectURL(new Blob(["A different download\n"], { type: "text/plain" }));

// Use the installed server's real session route, file access checks, and Content-Disposition. No model runs.
if (mode === "light") {
    const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pocket": "1" },
        body: JSON.stringify({ cwd: folder }),
    });
    const session = await response.json();

    if (!response.ok || !session.id) {
        document.querySelector("#download").textContent = "Fixture needs a session";
    } else {
        document.querySelector("#download").href = `/api/c/${session.id}/download?path=window-fixture.txt`;
    }
}

await fetch("/api/me"); // Gives the installer the usual signed-in readiness signal.
