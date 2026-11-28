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
    const systemDark = matchMedia("(prefers-color-scheme: dark)");
    const forcedColors = matchMedia("(forced-colors: active)");

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
            }, 405000);

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
            refresh();
        }
    }

    function applyState(next) {
        if (!next || (state && next.revision < state.revision)) {
            return;
        }

        const first = !state;

        state = next;
        applyTheme(state.window.theme);

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

        if (section === "notifications") {
            // Read the current OS setting. This does not request permission.
            void run("notifications.refresh");
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

        control.name = name;
        control.disabled = disabled;
        control.onchange = () => patch(group, name, control.value);

        return field(label, control);
    }

    function number(label, group, name, min, max, disabled = false) {
        const control = element("input", "", {
            type: "number",
            name,
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

    function localSettingsPending() {
        const applied = state.home.local.settings;

        return (
            applied &&
            Object.entries(state.preferences.server).some(([key, value]) => applied[key] !== value)
        );
    }

    async function applyLocalSettings() {
        if (
            await confirm(
                "Restart with the saved server settings?",
                "Work on this server will pause. If you chose a different data folder, the app will use that folder without moving any existing data.",
            )
        ) {
            await run("home.local.apply", undefined, true);
        }
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
        const restart = action("Restart", () =>
            localSettingsPending()
                ? applyLocalSettings()
                : run("home.local.restart", undefined, true),
        );

        status.setAttribute("role", "status");
        controls.append(
            start,
            stop,
            restart,
            action("Show server log", () => run("local.log")),
            action("Local server settings", () => showSection("server")),
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
            const pending = localSettingsPending();

            restart.textContent = pending ? "Restart to apply" : "Restart";
            restart.hidden = !local.verified && !pending;
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

    function localServerSettings() {
        const port = element("input", "", {
            type: "text",
            inputMode: "numeric",
            maxLength: 6,
            value: state.preferences.server.port,
        });
        const exposure = options(
            [
                ["local", "This device only"],
                ["lan", "Local network"],
                ["tailscale", "Tailscale"],
                ["cloudflare", "Cloudflare Tunnel"],
            ],
            state.preferences.server.access,
        );
        const scope = element("p", "", { className: "hint" });
        const status = element("p", "", { className: "muted" });
        const pickers = [];

        const folder = (key, label, buttonLabel) => {
            const input = element("input", "", {
                type: "text",
                spellcheck: false,
                maxLength: 2048,
                value: state.preferences.server[key],
            });
            const pick = action(buttonLabel, async () => {
                if (busy) {
                    return;
                }

                sayError();
                busy = true;
                refresh();

                try {
                    const chosen = await api.action("server.pickFolder", {
                        kind: key,
                        folder: input.value,
                    });

                    if (chosen !== null) {
                        input.value = chosen;
                    }
                } catch (error) {
                    sayError(error.message);
                } finally {
                    busy = false;
                    refresh();
                }
            });

            input.oninput = () => refresh();
            pickers.push(pick);

            return { input, label: field(label, input), pick };
        };

        const sessionFolder = folder("cwd", "Default session folder", "Choose session folder…");
        const dataFolder = folder("data", "Data folder", "Choose data folder…");
        const draft = () => ({
            cwd: sessionFolder.input.value,
            data: dataFolder.input.value,
            port: /^\d{1,5}$/.test(port.value) ? Number(port.value) : NaN,
            access: exposure.value,
        });
        const save = action(
            "Save local settings",
            async () => {
                if (busy) {
                    return;
                }

                sayError();

                const settings = draft();

                if (
                    !Number.isInteger(settings.port) ||
                    settings.port < 1 ||
                    settings.port > 65535
                ) {
                    sayError("Enter a whole port number between 1 and 65535.");
                    port.focus();

                    return;
                }

                busy = true;
                refresh();

                try {
                    applyState(await api.patchPreferences({ server: settings }));
                } catch (error) {
                    sayError(error.message);
                } finally {
                    busy = false;
                    refresh();
                }
            },
            true,
        );
        const restart = action("Restart to apply", applyLocalSettings, true);
        const actions = element("div", "", { className: "actions" });
        const folderActions = element("div", "", { className: "actions" });

        folderActions.append(sessionFolder.pick, dataFolder.pick);
        actions.append(
            save,
            restart,
            action("Go to Home", () => showSection("home")),
            action("Show server log", () => run("local.log")),
        );
        status.setAttribute("role", "status");
        port.oninput = exposure.onchange = () => refresh();

        refresh = () => {
            const local = state.home.local;
            const dirty = Object.entries(draft()).some(
                ([key, value]) => state.preferences.server[key] !== value,
            );
            const locked = busy || local.status === "starting";

            scope.textContent = {
                local: "Only this computer can connect.",
                lan: "Devices on your network can reach this server over HTTP.",
                tailscale:
                    "Devices on your tailnet can reach this server. Tailscale must be connected on this computer.",
                cloudflare:
                    "The tunnel gives your server a public HTTPS address. Install cloudflared first. Check the tunnel in Pi Pocket → Access.",
            }[exposure.value];
            status.textContent =
                local.status === "starting"
                    ? "Starting Pi Pocket…"
                    : local.status === "running" && !local.owned
                      ? "Another launcher owns this server. Saved settings apply only when this app starts its own server."
                      : localSettingsPending()
                        ? "Restart the server to use the saved settings."
                        : local.message ||
                          (local.status === "running"
                              ? `Running at ${local.address}`
                              : "Saved settings take effect the next time this app starts the server.");
            save.disabled = locked || !dirty;
            restart.hidden = !localSettingsPending();
            restart.disabled = locked || dirty;

            for (const control of [
                port,
                exposure,
                sessionFolder.input,
                dataFolder.input,
                ...pickers,
            ]) {
                control.disabled = locked;
            }
        };

        content.append(
            panel(
                "Local server",
                sessionFolder.label,
                dataFolder.label,
                folderActions,
                element(
                    "p",
                    "Changing the data folder does not move your sessions or server settings.",
                    { className: "hint" },
                ),
                field("Port", port),
                field("Who can connect", exposure),
                scope,
                status,
                actions,
                element("p", "Use Pi Pocket’s own menu to update the server.", {
                    className: "hint",
                }),
            ),
        );
    }

    function server() {
        if (card === "local") {
            localServerSettings();
        } else {
            content.append(element("p", "Settings for Another server"));
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

    function runnerCard() {
        const status = element("strong");
        const activity = element("span", "", { className: "muted" });
        const headline = element("p", "", { className: "runner-status" });
        const identity = element("p", "", { className: "address" });
        const message = element("p", "", { className: "hint" });
        const controls = element("div", "", { className: "actions" });
        const help = element("p", "", { className: "hint" });
        const source = element("p", "", { className: "hint" });
        let pending = false;
        let editLink = false;
        let editedAddress = false;

        headline.setAttribute("role", "status");
        headline.append(status, activity);

        const stopWarning = () =>
            `${state.runner.working ? "The runner is working now. " : ""}Stopping the runner can interrupt commands. Its background tasks stop even when the runner is idle.`;
        const mayStop = () => state.runner.running || state.runner.status === "retrying";

        async function perform(id, data, title, warning) {
            if (pending || state.runner.busy) {
                return;
            }

            pending = true;
            sayError();
            refresh();

            try {
                if (!title || (await confirm(title, warning))) {
                    await api.action(id, { ...data, confirmed: Boolean(title) });

                    if (id === "runner.link" || id === "runner.unlink") {
                        editLink = editedAddress = false;
                    }
                }
            } catch (error) {
                sayError(error.message);
            } finally {
                pending = false;
                refresh();
            }
        }

        const enable = action(
            "Enable runner",
            () => {
                const enabled = !state.runner.enabled;
                const stops = !enabled && mayStop();

                return perform(
                    "runner.enable",
                    { enabled },
                    stops ? "Disable the runner?" : "",
                    stops ? stopWarning() : "",
                );
            },
            true,
        );
        const reconnect = action("Reconnect", () =>
            perform("runner.reconnect", {}, "Reconnect the runner?", stopWarning()),
        );
        const unlink = action("Unlink", () =>
            perform(
                "runner.unlink",
                {},
                "Unlink this computer?",
                `${mayStop() ? `${stopWarning()} ` : ""}This removes the link from this app only. To cancel this computer’s key, also remove it in Menu → Access → Settings on the server.`,
            ),
        );
        const relink = action("Link again", () => {
            editLink = !editLink;
            clearLink();
            refresh();
        });

        controls.append(enable, reconnect, relink, unlink);

        const form = element("form", "", { autocomplete: "off" });
        const fields = element("fieldset", "", { className: "runner-link" });
        const address = element("input", "", {
            type: "url",
            name: "runnerServer",
            maxLength: 2048,
            required: true,
            spellcheck: false,
        });
        const code = element("input", "", {
            type: "password",
            name: "runnerCode",
            maxLength: 32,
            required: true,
            spellcheck: false,
        });
        const allowHttp = element("input", "", { type: "checkbox" });
        const allow = element("label", "", { className: "check" });
        const trusted = element("input", "", { type: "checkbox", required: true });
        const trust = element("label", "", { className: "check" });
        const link = element("button", "Link", { type: "submit", className: "primary" });

        function clearLink() {
            code.value = "";
            allowHttp.checked = trusted.checked = false;
        }

        address.oninput = () => {
            editedAddress = true;
        };

        allow.append(allowHttp, "Allow plain HTTP for this link (trusted networks only)");
        trust.append(trusted, "I trust this server");
        fields.append(
            element("legend", "Link this computer"),
            element(
                "p",
                "Sessions from this server can run commands and change files as your OS user. There is no sandbox. Link only to a server you trust.",
                { className: "runner-trust" },
            ),
            trust,
            field("Runner server address", address),
            field("One-time code", code),
            allow,
            link,
        );
        form.append(fields);

        form.onsubmit = async (event) => {
            event.preventDefault();
            const data = {
                server: address.value,
                code: code.value,
                allowHttp: allowHttp.checked,
                trusted: trusted.checked,
            };
            const replace = mayStop();

            clearLink();
            await perform(
                "runner.link",
                data,
                replace ? "Replace the runner link?" : "",
                replace ? stopWarning() : "",
            );
        };

        const log = element("details");
        const lines = element("ul", "", { className: "runner-log" });
        const noLog = element("p", "No runner messages yet.", { className: "hint" });
        let lastLog;

        log.append(element("summary", "Runner log"), noLog, lines);

        refresh = () => {
            const { runner, home } = state;
            const locked = pending || runner.busy || runner.status === "checking";
            const ended = runner.status === "ended";
            const canStart = runner.linked && !ended && runner.status !== "unavailable";
            const working = runner.workingFolders;

            status.textContent = runner.label;
            activity.textContent = runner.working
                ? ` · ${working} working ${working === 1 ? "folder" : "folders"}`
                : "";
            identity.textContent = runner.linked ? `${runner.name} · ${runner.server}` : "";
            identity.hidden = !runner.linked;
            message.textContent =
                runner.message ||
                (runner.status === "disabled"
                    ? "Enable the runner to let the linked server use this computer while Pi Pocket is open."
                    : "");
            message.hidden = !message.textContent;
            enable.textContent = runner.enabled ? "Disable runner" : "Enable runner";
            enable.hidden = reconnect.hidden = unlink.hidden = !runner.linked;
            relink.hidden = !runner.linked || ended;
            relink.textContent = editLink ? "Cancel link again" : "Link again";
            enable.disabled = locked || (!canStart && !runner.enabled);
            reconnect.disabled = locked || !canStart || !runner.enabled;
            unlink.disabled = relink.disabled = locked;
            form.hidden = runner.status === "checking" || (runner.linked && !ended && !editLink);
            fields.disabled = locked || runner.status === "unavailable";
            link.textContent = runner.linked ? "Replace link" : "Link";
            help.textContent = runner.linked
                ? "On the linked server, see Menu → Access → By computer. To replace the link and keep the server’s settings for this computer, choose Link again in Access → Settings."
                : "On the server, open Menu → Access → By computer → Link a computer to get a one-time code.";
            source.textContent = runner.source ? `Bundled runner source: ${runner.source}` : "";
            source.hidden = !runner.source;

            if (!editedAddress) {
                const active = home.active;
                const candidate =
                    runner.server ||
                    (active?.kind !== "preview" && active?.status === "connected"
                        ? active.address
                        : "");

                // Do not offer a sign-in page or URL with a credential, query, or fragment.
                address.value = /^https?:\/\/[^/@?#]+(?:\/[^?#]*)?$/i.test(candidate)
                    ? candidate
                    : "";
            }

            const entries = runner.log ?? [];
            const text = entries.join("\n");

            if (text !== lastLog) {
                lastLog = text;
                lines.replaceChildren(...entries.map((entry) => element("li", entry)));
                noLog.hidden = entries.length > 0;
            }
        };

        content.append(
            panel(
                "This computer's runner",
                headline,
                identity,
                message,
                controls,
                form,
                log,
                help,
                source,
            ),
        );
    }

    function updates() {
        const latest = element("p");
        const status = element("p", "", { className: "update-status" });
        const detail = element("p", "", { className: "muted" });
        const check = action("Check now", () => run("updates.check"));
        const download = action("Download", () => run("updates.download"));
        const apply = action("Apply", () => run("updates.apply"), true);
        const select = action("Select installer…", () => run("updates.selectInstaller"));
        const startup = checkbox("Check for app updates at startup", "updates", "checkAtStartup");
        const labels = {
            disabled: "App updates are off",
            unavailable: "No build available",
            idle: "Not checked yet",
            checking: "Checking for updates…",
            current: "Up to date",
            available: "Update available",
            opening: "Opening the download link…",
            downloading: "Downloading in your browser",
            selecting: "Downloading in your browser",
            verifying: "Verifying the installer…",
            ready: "Ready to apply",
            staging: "Staging the update…",
            staged: "Update ready - restart to apply",
            failed: "Update failed",
        };
        const instructions = {
            available: "Download opens GitHub in your browser. This is an unsigned test build.",
            downloading:
                "Sign in to GitHub if asked. After the download finishes, select the installer here.",
            selecting: "Select the installer that you downloaded from GitHub.",
            verifying: "Checking the size and SHA-256 against the GitHub build.",
            ready: "The size and SHA-256 match. Apply stages the update without closing Pi Pocket.",
            staged: "Quit Pi Pocket and open it again to install the update.",
        };
        const controls = element("div", "", { className: "actions" });
        const announcement = element("div");

        announcement.setAttribute("role", "status");
        announcement.append(status, detail);
        controls.append(check, download, apply, select);
        content.append(
            panel(
                "Desktop app",
                element("p", `Current version: ${state.version}`),
                latest,
                controls,
                announcement,
                startup,
            ),
            element(
                "p",
                "This updates only the desktop app. The server updates itself from its own menu. This does not update the runner.",
            ),
        );

        refresh = () => {
            const update = state.updates;
            const phase = update.status;
            const label = labels[phase];
            const message = update.message || instructions[phase] || "";
            const newest = `Newest build: ${update.latest ?? "—"}`;
            const working = ["checking", "opening", "selecting", "verifying", "staging"].includes(
                phase,
            );

            if (latest.textContent !== newest) {
                latest.textContent = newest;
            }

            if (status.textContent !== label) {
                status.textContent = label;
            }

            if (detail.textContent !== message) {
                detail.textContent = message;
            }

            detail.hidden = !message;
            status.classList.toggle("update-failed", phase === "failed");
            check.disabled = working || ["disabled", "ready", "staged"].includes(phase);
            download.disabled = phase !== "available";
            apply.disabled = phase !== "ready";
            select.hidden = !["downloading", "selecting", "verifying"].includes(phase);
            select.disabled = phase !== "downloading";
            startup.querySelector("input").disabled = phase === "disabled";
        };
    }

    function applyTheme(theme) {
        const root = document.documentElement;
        const site = forcedColors.matches ? null : theme;

        root.dataset.theme = (site?.dark ?? systemDark.matches) ? "dark" : "light";
    }

    for (const query of [systemDark, forcedColors]) {
        query.addEventListener("change", () => applyTheme(state?.window.theme));
    }

    applyTheme(null);

    function refreshControls(panel, group) {
        for (const input of panel.querySelectorAll("input[name], select[name]")) {
            const value = state.preferences[group][input.name];

            if (value === undefined) {
                continue;
            }

            if (input.type === "checkbox") {
                input.checked = value;
            } else if (input.type !== "number" || input !== document.activeElement) {
                // A native status update must not replace a number as the user types it.
                input.value = value;
            }
        }
    }

    function describeShortcut(shortcut) {
        return shortcut
            .replace("Meta", state.platform === "macos" ? "Cmd" : "Win")
            .replace("Alt", state.platform === "macos" ? "Option" : "Alt");
    }

    function recordedShortcutKey(event) {
        if (state.platform === "macos") {
            const physical = event.code.match(/^(?:Key([A-Z])|Digit(\d))$/);

            return physical?.[1] ?? physical?.[2];
        }

        if (/^[a-zA-Z]$/.test(event.key)) {
            return event.key.toUpperCase();
        }

        // WebView2 gives the Windows virtual key for the number row, even when key is punctuation.
        // Do not use the physical position or turn a number pad digit into a number row binding.
        const { keyCode } = event;

        return keyCode >= 0x30 && keyCode <= 0x39 ? String.fromCharCode(keyCode) : undefined;
    }

    function windowOptions() {
        let settingLogin = false;
        let recording = false;
        const login = element("input", "", { type: "checkbox", name: "launchAtLogin" });
        const launch = element("label", "", { className: "check" });

        launch.append(login, "Launch at login");

        login.onchange = async () => {
            settingLogin = true;
            refresh();
            sayError();

            try {
                await api.action("window.login.set", { enabled: login.checked });
            } catch (error) {
                sayError(error.message);
            } finally {
                settingLogin = false;
                refresh();
            }
        };

        const shortcutButton = action("", () => {
            recording = !recording;
            refresh();
        });

        shortcutButton.onblur = () => {
            recording = false;
            refresh();
        };

        shortcutButton.onkeydown = (event) => {
            if (!recording || event.key === "Tab") {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (event.key === "Escape") {
                recording = false;
                refresh();

                return;
            }

            const key = recordedShortcutKey(event);

            if (!key || event.repeat || !(event.ctrlKey || event.altKey || event.metaKey)) {
                return;
            }

            recording = false;
            refresh();
            void patch(
                "window",
                "shortcut",
                [
                    event.ctrlKey && "Ctrl",
                    event.altKey && "Alt",
                    event.metaKey && "Meta",
                    event.shiftKey && "Shift",
                    key,
                ]
                    .filter(Boolean)
                    .join("+"),
            );
        };

        const defaultKey = state.platform === "macos" ? "Meta+Shift+P" : "Ctrl+Shift+P";
        const shortcutStatus = element("p", "", { className: "hint", role: "status" });
        const shortcutButtons = element("div", "", { className: "actions" });

        shortcutButtons.append(
            shortcutButton,
            action("Use default", () => patch("window", "shortcut", defaultKey)),
        );
        const controls = [
            checkbox("Close to tray", "window", "closeToTray"),
            launch,
            checkbox("Start hidden at login", "window", "startHidden"),
            element("p", "Login changes apply the next time you sign in to this computer.", {
                className: "hint",
            }),
            selectField("Title bar", "window", "titleBar", [
                ["seamless", "Seamless"],
                ["system", "System"],
            ]),
        ];

        if (state.platform === "windows") {
            controls.push(checkbox("Show menu bar", "window", "showMenuBar"));
        }

        const settings = panel(
            "Window options",
            ...controls,
            selectField("Links to Pi Pocket pages", "window", "links", [
                ["app", "App window"],
                ["browser", "System browser"],
            ]),
            checkbox("Global show/hide shortcut", "window", "shortcutEnabled"),
            shortcutButtons,
            shortcutStatus,
            advanced(checkbox("Enable developer tools", "window", "developerTools")),
        );

        content.append(settings);

        refresh = () => {
            refreshControls(settings, "window");

            if (!settingLogin) {
                login.checked = state.window.loginEnabled === true;
            }

            login.disabled = settingLogin || state.window.loginEnabled === null;
            shortcutButton.textContent = recording
                ? "Press a shortcut…"
                : `Change shortcut (${describeShortcut(state.preferences.window.shortcut)})`;
            shortcutButton.setAttribute("aria-pressed", String(recording));
            shortcutStatus.textContent = recording
                ? "Use a letter or number with Ctrl, Alt or the system key. Esc cancels."
                : state.preferences.window.shortcutEnabled && state.window.shortcutActive === false
                  ? "This shortcut is not active. It may be in use by another app. Choose another shortcut."
                  : "";
            shortcutStatus.hidden = !shortcutStatus.textContent;
        };
    }

    function appearanceOptions() {
        const windows = state.platform === "windows";
        const note = element("p", "", { className: "hint", role: "status" });
        const controls = [
            element(
                "p",
                "Desktop Settings follow the Pi Pocket theme. Without a Pi Pocket page, they use the system theme.",
            ),
            checkbox("See-through background", "appearance", "transparent"),
            number("Opacity (%)", "appearance", "opacity", 0, 100),
            selectField(
                "Blur",
                "appearance",
                "material",
                windows
                    ? [
                          ["acrylic", "Acrylic"],
                          ["mica", "Mica"],
                      ]
                    : [
                          ["window", "Window"],
                          ["sidebar", "Sidebar"],
                          ["dark", "Dark glass"],
                          ["full-screen", "Full-screen"],
                      ],
            ),
            note,
        ];

        if (windows) {
            controls.push(
                selectField("Tray menu style", "appearance", "trayStyle", [
                    ["system", "Windows"],
                    ["pocket", "Pi Pocket"],
                ]),
            );
        }

        const settings = panel("Desktop appearance", ...controls);

        content.append(settings);

        refresh = () => {
            refreshControls(settings, "appearance");
            const text = {
                unsupported: windows
                    ? "See-through needs Windows 11 version 22H2 or later, with transparency on and high contrast off."
                    : "See-through is unavailable when Reduce Transparency or Increase Contrast is on.",
                page: "See-through applies to supported Pi Pocket pages, not Desktop Settings or sign-in pages.",
                "full-screen": "See-through pauses in full screen.",
                "web-view":
                    "This version of macOS cannot make the Pi Pocket page see-through. The page uses a solid background.",
            };

            note.textContent = text[state.window.effect] ?? "";
            note.hidden = !note.textContent;
        };
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
        runner: runnerCard,
        updates,
        dictation,
        window: windowOptions,
        appearance: appearanceOptions,
        notifications: () => {
            const permission = element("p", "", { className: "muted", role: "status" });
            const system = action("Open system settings", () =>
                run("notifications.systemSettings"),
            );
            const statusText = {
                prompt: "Your computer may ask for permission the first time Pi Pocket shows a notification.",
                allowed: "System settings allow Pi Pocket notifications.",
                blocked:
                    "System settings block Pi Pocket notifications. The needs-you badge still shows.",
                unknown: "Check your system settings if notifications do not show.",
            };

            content.append(
                panel(
                    "Native notifications",
                    checkbox("Show notifications", "notifications", "enabled"),
                    checkbox("Play a sound", "notifications", "sound"),
                    selectField("Approve from notifications", "notifications", "approve", [
                        ["full", "When the full command is shown"],
                        ["always", "Always"],
                        ["never", "Never"],
                    ]),
                    element(
                        "p",
                        "Deny is available when you can answer a request from a notification.",
                    ),
                    element(
                        "p",
                        "Always can show Allow even if part of the command is hidden. Open the session to review the whole command.",
                    ),
                    advanced(
                        number(
                            "Command length limit (characters)",
                            "notifications",
                            "commandLimit",
                            20,
                            2000,
                        ),
                        element(
                            "p",
                            "Control and other invisible characters show as codes, for example [U+000A]. Shortened commands are marked.",
                        ),
                    ),
                    permission,
                    system,
                    element(
                        "p",
                        "Choose which alerts the server sends in Pi Pocket → Menu → Notifications.",
                        { className: "hint" },
                    ),
                ),
            );

            refresh = () => {
                const status = state.notifications.permission;

                permission.textContent = statusText[status] || statusText.unknown;
                system.hidden = status === "allowed" || status === "prompt";
            };
        },
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
