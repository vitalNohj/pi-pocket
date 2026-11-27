(() => {
    const webview = window.chrome?.webview;
    const send = webview
        ? (packet) => webview.postMessage(packet)
        : (packet) => window.webkit.messageHandlers.desktopSettings.postMessage(packet);
    const listeners = new Set();
    const pending = new Map();
    let id = 0;
    let state;
    let section = "home";
    let card = "local";
    let remoteDraft;
    let busy = false;

    let refresh = () => {};

    const $ = (selector) => document.querySelector(selector);
    const content = $("#content");

    function call(command, value) {
        return new Promise((resolve, reject) => {
            if (pending.size >= 24) {
                reject(new Error("Wait for the current action to finish."));

                return;
            }

            const next = (id = (id % 2147483647) + 1);
            const timer = setTimeout(() => {
                pending.delete(next);
                reject(new Error("Pi Pocket did not complete the action in time."));
            }, 375000);

            pending.set(next, { resolve, reject, timer });

            try {
                send({ v: 1, id: next, command, ...(value === undefined ? {} : { value }) });
            } catch {
                pending.delete(next);
                clearTimeout(timer);
                reject(new Error("The desktop controller is not available."));
            }
        });
    }

    const api = {
        getState: () => call("getState"),
        subscribe(listener) {
            listeners.add(listener);

            if (state) {
                listener(state);
            }

            return () => listeners.delete(listener);
        },
        patchPreferences: (patch) => call("patchPreferences", patch),
        action: (id, data) => call("action", { id, ...(data === undefined ? {} : { data }) }),
    };

    function receive(packet) {
        if (packet?.v !== 1) {
            return;
        }

        if (packet.type === "result") {
            const request = pending.get(packet.id);

            if (!request) {
                return;
            }

            pending.delete(packet.id);
            clearTimeout(request.timer);

            if (packet.ok) {
                request.resolve(packet.value);
            } else {
                request.reject(new Error(packet.error?.message || "The action did not finish."));
            }
        } else if (packet.type === "state") {
            applyState(packet.state);
        } else if (packet.type === "section") {
            showSection(packet.section);
        }
    }

    Object.defineProperty(window, "desktopSettings", { value: Object.freeze(api) });

    if (webview) {
        webview.addEventListener("message", ({ data }) => receive(data));
    } else {
        Object.defineProperty(window, "__desktopSettingsReceive", { value: receive });
    }

    function element(tag, text, props = {}) {
        const node = document.createElement(tag);

        if (text) {
            node.textContent = text;
        }

        Object.assign(node, props);

        return node;
    }

    function action(label, run, primary = false) {
        return element("button", label, {
            type: "button",
            className: primary ? "primary" : "",
            onclick: run,
        });
    }

    function sayError(message = "") {
        const error = $("#error");

        error.hidden = !message;
        error.textContent = message;
    }

    async function run(id, data, pendingUI = false) {
        if (pendingUI && busy) {
            return;
        }

        sayError();

        if (pendingUI) {
            busy = true;
            refresh();
        }

        try {
            await api.action(id, data);
        } catch (error) {
            sayError(error.message);
        } finally {
            if (pendingUI) {
                busy = false;
                refresh();
            }
        }
    }

    async function patch(section, key, value) {
        sayError();

        try {
            applyState(await api.patchPreferences({ [section]: { [key]: value } }));
        } catch (error) {
            sayError(error.message);
            render();
        }
    }

    function applyState(next) {
        if (!next || (state && next.revision < state.revision)) {
            return;
        }

        const first = !state;

        state = next;

        if (first) {
            card = state.preferences.home.mode === "remote" ? "remote" : "local";
            remoteDraft = state.preferences.home.remoteAddress;
            $("#version").textContent = `App version ${state.version}`;
            $("#content").removeAttribute("aria-busy");
            render();
        }

        const { active } = state.home;

        $("#connection").textContent = active
            ? `${active.status === "reconnecting" ? "Reconnecting" : active.kind === "preview" ? "Sign-in webpage" : "Connected"} · ${active.mode === "local" ? "This computer" : "Another server"}`
            : "No server open";
        $("#warnings").hidden = !state.warnings.length;
        $("#warnings").textContent = state.warnings.join(" ");
        refresh();
        listeners.forEach((listener) => listener(state));
    }

    function showSection(next) {
        const buttons = [...document.querySelectorAll("[data-section]")];

        if (!buttons.some((button) => button.dataset.section === next)) {
            return;
        }

        section = next;
        buttons.forEach((button) => {
            if (button.dataset.section === section) {
                button.setAttribute("aria-current", "page");
            } else {
                button.removeAttribute("aria-current");
            }
        });
        sayError();

        if (state) {
            render();
        }
    }

    function field(label, control) {
        const wrapper = element("label", "", { className: "field" });

        wrapper.append(element("span", label), control);

        return wrapper;
    }

    function options(values, value) {
        const select = element("select");

        for (const [key, label] of values) {
            select.add(new Option(label, key));
        }

        select.value = value;

        return select;
    }

    function checkbox(label, group, name, disabled = false) {
        const wrapper = element("label", "", { className: "check" });
        const input = element("input", "", {
            type: "checkbox",
            checked: state.preferences[group][name],
            disabled,
        });

        input.name = name;
        input.onchange = () => patch(group, name, input.checked);
        wrapper.append(input, label);

        return wrapper;
    }

    function selectField(label, group, name, values, disabled = false) {
        const control = options(values, state.preferences[group][name]);

        control.disabled = disabled;
        control.onchange = () => patch(group, name, control.value);

        return field(label, control);
    }

    function number(label, group, name, min, max, disabled = false) {
        const control = element("input", "", {
            type: "number",
            min,
            max,
            value: state.preferences[group][name],
            disabled,
        });

        control.onchange = () => patch(group, name, control.valueAsNumber);

        return field(label, control);
    }

    function panel(title, ...children) {
        const panel = element("section", "", { className: "panel" });

        panel.append(element("h2", title), ...children);

        return panel;
    }

    function advanced(...children) {
        const details = element("details");

        details.append(element("summary", "Advanced"), ...children);

        return details;
    }

    async function confirm(title, message) {
        const dialog = $("#confirm");

        $("#confirm-title").textContent = title;
        $("#confirm-message").textContent = message;
        dialog.returnValue = "cancel";
        dialog.showModal();

        return new Promise((resolve) =>
            dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), {
                once: true,
            }),
        );
    }

    function localPanel() {
        const status = element("p", "", { className: "muted" });
        const details = element("p", "", { className: "address" });
        const controls = element("div", "", { className: "actions" });
        const start = action(
            "Start Pi Pocket",
            () => run("home.local.open", undefined, true),
            true,
        );
        const stop = action("Stop", async () => {
            if (
                await confirm(
                    "Stop Pi Pocket on this computer?",
                    "This stops the server started by this app. Work on that server will pause.",
                )
            ) {
                await run("home.local.stop", undefined, true);
            }
        });
        const restart = action("Restart", () => run("home.local.restart", undefined, true));

        status.setAttribute("role", "status");
        controls.append(
            start,
            stop,
            restart,
            action("Show server log", () => run("local.log")),
        );

        refresh = () => {
            const { local } = state.home;

            status.textContent = {
                stopped: "Not running",
                starting: "Starting Pi Pocket…",
                error: "Pi Pocket could not start",
                running: local.owned
                    ? "Running on this computer"
                    : "Already running (console or other launcher)",
            }[local.status];
            details.textContent =
                local.message ||
                local.address ||
                "Use the Pi Pocket server included in this installation.";
            start.textContent = local.status === "running" ? "Open Pi Pocket" : "Start Pi Pocket";
            start.disabled = busy || local.status === "starting";
            stop.hidden = !local.owned || local.status !== "running";
            restart.hidden = !local.verified;
            stop.disabled = restart.disabled = busy;
        };

        return panel("This computer", status, details, controls);
    }

    function remotePanel() {
        const type = options(
            [
                ["full", "Full address"],
                ["parts", "Host and port"],
            ],
            "full",
        );
        const entry = element("input", "", {
            type: "url",
            value: remoteDraft,
            placeholder: "https://pocket.example.com",
            maxLength: 2048,
            spellcheck: false,
        });
        const full = field("Server address", entry);
        const scheme = options(
            [
                ["https", "HTTPS"],
                ["http", "HTTP"],
            ],
            "https",
        );
        const host = element("input", "", { spellcheck: false, maxLength: 256 });
        const port = element("input", "", { type: "number", min: 1, max: 65535 });
        const path = element("input", "", { placeholder: "/", maxLength: 1024, spellcheck: false });
        const parts = element("div", "", { className: "parts", hidden: true });
        const status = element("p", "", { className: "muted address" });
        const controls = element("div", "", { className: "actions" });
        const check = action("Check", () => submit("home.check"));
        const connect = action("Connect", () => submit("home.connect"), true);
        const retry = action("Retry now", () => run("home.retry", undefined, true));
        const preview = action("Open webpage anyway", async () => {
            const address = remoteDraft;

            if (
                await confirm(
                    "Open this webpage?",
                    `Pi Pocket could not verify ${address}. Open it to sign in without desktop page actions.`,
                )
            ) {
                await run("home.preview", { address }, true);
            }
        });
        const help = element("details");

        function submit(id) {
            return run(id, { address: remoteDraft }, true);
        }

        function fromParts() {
            const name = host.value.trim();
            const address = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;

            remoteDraft = name
                ? `${scheme.value}://${address}${port.value ? `:${port.value}` : ""}${path.value ? `/${path.value.replace(/^\/+/, "")}` : ""}`
                : "";
            entry.value = remoteDraft;
            refresh();
        }

        type.onchange = () => {
            full.hidden = type.value !== "full";
            parts.hidden = !full.hidden;

            if (full.hidden) {
                try {
                    const url = new URL(remoteDraft);

                    scheme.value = url.protocol.slice(0, -1);
                    host.value = url.hostname;
                    port.value = url.port;
                    path.value = url.pathname === "/" ? "" : url.pathname;
                } catch {
                    /* Keep the draft until the person enters the parts. */
                }
            }
        };

        entry.oninput = () => {
            remoteDraft = entry.value.trim();
            refresh();
        };

        entry.onkeydown = (event) => {
            if (event.key === "Enter") {
                void submit("home.connect");
            }
        };

        for (const control of [scheme, host, port, path]) {
            control.oninput = fromParts;
        }

        parts.append(
            field("Scheme", scheme),
            field("Host", host),
            field("Port", port),
            field("Entry path", path),
        );
        status.setAttribute("role", "status");
        controls.append(check, connect, retry, preview);
        help.append(
            element("summary", "Get the Server"),
            element(
                "p",
                "Install Pi Pocket on the other computer with the fork's desktop installer, or follow the setup instructions in the fork. Then enter the address that server gives you.",
            ),
            action("Open the fork on GitHub", () => run("help.repository")),
        );

        refresh = () => {
            const { home, preferences } = state;
            const address = remoteDraft.replace(/\/$/, "");
            let normalized = address;

            try {
                normalized = new URL(address).href.replace(/\/$/, "");
            } catch {
                /* An unfinished address. */
            }

            const same = (candidate) => candidate?.replace(/\/$/, "") === normalized;
            const current = home.active?.mode === "remote" ? home.active : null;
            const match = same(home.check?.address) ? home.check : null;

            status.textContent =
                match?.message ||
                (current && same(current.address)
                    ? current.message
                    : "Enter the HTTP or HTTPS address of an existing Pi Pocket server.");
            check.disabled = connect.disabled = !address || busy;
            preview.hidden = match?.status !== "preview";
            preview.disabled = retry.disabled = busy;
            retry.hidden = !(
                (current?.status === "reconnecting" && same(current.address)) ||
                (!current && match?.status === "error" && same(preferences.home.remoteAddress))
            );
        };

        return panel(
            "Another server",
            field("Address format", type),
            full,
            parts,
            controls,
            status,
            element(
                "p",
                "Sign in inside the app as you would in a browser. Plain HTTP on another computer does not support the web microphone.",
                { className: "hint" },
            ),
            help,
        );
    }

    function home() {
        const choices = element("div", "", { className: "choices" });
        const tiles = element("div", "", { className: "actions" });
        const active = state.home.active;

        for (const [mode, name] of [
            ["local", "This computer"],
            ["remote", "Another server"],
        ]) {
            const button = action(
                name,
                () => {
                    card = mode;
                    sayError();
                    render();
                },
                card === mode,
            );

            button.setAttribute("aria-pressed", String(mode === card));
            choices.append(button);
        }

        for (const name of ["Runner", "Updates", "Dictation"]) {
            tiles.append(action(name, () => showSection(name.toLowerCase())));
        }

        content.append(
            element("p", "Start Pi Pocket here or connect to a server you already use."),
        );

        if (active) {
            content.append(element("p", active.address, { className: "address muted" }));
        }

        content.append(choices, card === "local" ? localPanel() : remotePanel(), tiles);
    }

    function server() {
        content.append(
            element(
                "p",
                card === "local" ? "Settings for This computer" : "Settings for Another server",
            ),
        );

        if (card === "local") {
            content.append(
                panel(
                    "Local server",
                    element(
                        "p",
                        "Use Pi Pocket's own menu to update the server. More local server settings are coming soon.",
                    ),
                    action("Show server log", () => run("local.log")),
                    action("Go to Home", () => showSection("home")),
                ),
            );
        } else {
            const origins = element("textarea", "", {
                rows: 3,
                value: state.preferences.home.allowedOrigins.join("\n"),
                spellcheck: false,
            });

            origins.onchange = () =>
                patch("home", "allowedOrigins", origins.value.trim().split(/\s+/).filter(Boolean));
            content.append(
                panel(
                    "Connection",
                    checkbox("Connect at startup", "home", "connectAtStartup"),
                    field("Other allowed sign-in origins (one per line)", origins),
                    element(
                        "p",
                        "Check or connect again to use a changed origin list. On macOS, allow Local Network access to connect to a server on your network.",
                        { className: "hint" },
                    ),
                    advanced(
                        number(
                            "Seconds between checks (0 to turn off)",
                            "home",
                            "healthInterval",
                            0,
                            300,
                        ),
                        number(
                            "Failed checks before reconnecting",
                            "home",
                            "failureThreshold",
                            1,
                            10,
                        ),
                        number("Maximum delay (seconds)", "home", "maxBackoff", 1, 300),
                        number("Probe timeout (seconds)", "home", "probeTimeout", 1, 30),
                    ),
                ),
            );
        }
    }

    const coming = () => element("p", "More options are coming soon.", { className: "hint" });

    function dictation() {
        const unavailable = state.dictation.status !== "available";
        const mac = state.platform === "macos";
        const models = element("div");
        const selected = element("p", "", { className: "muted" });
        const progress = element("p", "", { className: "muted", role: "status" });
        const cancel = action("Cancel download", () => run("dictation.cancelDownload"));
        const words = element("textarea", "", {
            rows: 3,
            maxLength: 2000,
            value: state.preferences.dictation.words ?? "",
            placeholder: "Names or terms, one per line",
        });

        words.onchange = () => patch("dictation", "words", words.value);
        let modelKey;

        refresh = () => {
            const speech = state.dictation;
            const task = speech.progress;
            const current = speech.models?.find(({ id }) => id === speech.selected);

            selected.textContent =
                speech.message ||
                (current ? `Selected: ${current.name}` : "No speech model selected.");
            progress.textContent =
                task?.kind === "download"
                    ? `Downloading and verifying${task.total ? `… ${Math.round((100 * task.written) / task.total)}%` : "…"}`
                    : task
                      ? "Updating speech models…"
                      : speech.busy
                        ? "Dictation is in progress…"
                        : "";
            cancel.hidden = task?.kind !== "download";
            const next = JSON.stringify([speech.models, speech.selected, speech.busy]);

            if (next === modelKey) {
                return;
            }

            modelKey = next;
            models.replaceChildren(
                ...(speech.models ?? []).map((model) => {
                    const controls = element("div", "", { className: "actions" });
                    const button = (label, kind) =>
                        action(label, () => run(`dictation.${kind}`, { model: model.id }));

                    if (model.installed) {
                        const use = button(
                            model.id === speech.selected ? "Selected" : "Select",
                            "select",
                        );
                        const remove = button("Remove", "remove");

                        use.disabled = speech.busy || model.id === speech.selected;
                        remove.disabled = speech.busy;
                        controls.append(use, remove);
                    } else {
                        const download = button(
                            model.supported ? "Download" : "Too large for this engine",
                            "download",
                        );

                        download.disabled = speech.busy || !model.supported;
                        controls.append(download);
                    }

                    return panel(
                        model.name,
                        element(
                            "p",
                            `${model.languages} · ${Math.round(model.bytes / 1e6)} MB · ${model.license}${model.recommended ? " · Recommended" : ""}`,
                            { className: "muted" },
                        ),
                        controls,
                    );
                }),
            );
        };

        content.append(
            panel(
                "Offline dictation",
                element(
                    "p",
                    "Speech is recognized on this device. Enable Offline dictation in Pi Pocket’s Extensions menu and focus an editable composer. Dictation changes the draft; it never sends it.",
                ),
                selectField(
                    "Dictation key",
                    "dictation",
                    "key",
                    [
                        ["default", mac ? "Default (Right Option)" : "Default (Right Ctrl)"],
                        ["none", "None"],
                        ["primary-shift-d", mac ? "Command + Shift + D" : "Ctrl + Shift + D"],
                        ["F8", "F8"],
                        ["F9", "F9"],
                    ],
                    unavailable,
                ),
                selectField(
                    "Key behavior",
                    "dictation",
                    "keyMode",
                    [
                        ["both", "Hold or tap"],
                        ["hold", "Hold"],
                        ["tap", "Tap"],
                    ],
                    unavailable,
                ),
                checkbox("Show words as you speak", "dictation", "live", unavailable),
                field("Custom words (Parakeet models)", words),
            ),
            panel("Speech models", selected, progress, cancel),
            models,
        );
    }

    const sections = {
        home,
        server,
        runner: () =>
            content.append(
                panel(
                    "This computer's runner",
                    element("p", `Runner: ${state.runner.label}`),
                    checkbox("Enable runner", "runner", "enabled", true),
                    coming(),
                ),
            ),
        updates: () =>
            content.append(
                panel(
                    "Desktop app",
                    element("p", `Version ${state.version}`),
                    checkbox("Check for app updates at startup", "updates", "checkAtStartup", true),
                    coming(),
                ),
                element(
                    "p",
                    "The server checks for its own updates in Pi Pocket. The desktop app does not update the server or runner.",
                ),
            ),
        dictation,
        window: () => {
            const controls = [
                checkbox("Close to tray", "window", "closeToTray"),
                checkbox("Start hidden at sign-in", "window", "startHidden", true),
                selectField(
                    "Title bar",
                    "window",
                    "titleBar",
                    [
                        ["seamless", "Seamless"],
                        ["system", "System"],
                    ],
                    true,
                ),
            ];

            if (state.platform === "windows") {
                controls.push(checkbox("Show menu bar", "window", "showMenuBar"));
            }

            controls.push(
                selectField(
                    "Links to Pi Pocket pages",
                    "window",
                    "links",
                    [
                        ["app", "App window"],
                        ["browser", "System browser"],
                    ],
                    true,
                ),
                checkbox("Global show/hide shortcut", "window", "shortcutEnabled", true),
                advanced(checkbox("Enable developer tools", "window", "developerTools")),
                coming(),
            );
            content.append(panel("Window options", ...controls));
        },
        appearance: () =>
            content.append(
                panel(
                    "Desktop appearance",
                    element("p", "Settings follow this computer's light or dark appearance."),
                    checkbox("See-through background", "appearance", "transparent", true),
                    number("Opacity (%)", "appearance", "opacity", 0, 100, true),
                    coming(),
                ),
            ),
        notifications: () =>
            content.append(
                panel(
                    "Native notifications",
                    checkbox("Show notifications", "notifications", "enabled"),
                    checkbox("Play a sound", "notifications", "sound", true),
                    selectField(
                        "Approve from notifications",
                        "notifications",
                        "approve",
                        [
                            ["full", "When the full command is shown"],
                            ["always", "Always"],
                            ["never", "Never"],
                        ],
                        true,
                    ),
                    coming(),
                ),
            ),
    };

    function render() {
        refresh = () => {};

        const name = section.charAt(0).toUpperCase() + section.slice(1);

        content.replaceChildren(element("h1", name));
        sections[section]();
        refresh();
    }

    document
        .querySelectorAll("[data-section]")
        .forEach((button) => (button.onclick = () => showSection(button.dataset.section)));
    $("#back").onclick = () => run("settings.back");
    $("#preferences").onclick = () => run("preferences.open");
    $("#diagnostics").onclick = () => run("logs.open");
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !$("#confirm").open) {
            void run("settings.back");
        }
    });
    api.getState()
        .then(applyState)
        .catch((error) => sayError(error.message));
})();
