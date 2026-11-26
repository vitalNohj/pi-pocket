// Document-start script shared by the two native hosts. The caller supplies a fixed origin and its own message channel.
(function installWindowHost(origin, key, initial, send) {
    if (window.top !== window || window.origin !== origin || location.origin !== origin) {
        return;
    }

    const overlay = new EventTarget();
    const root = document.documentElement;
    let state = initial;
    let ready = false;
    let latestTheme;
    let frame = 0;
    const post = (type, body = {}) => send({ key, type, ...body });

    const getTitlebarAreaRect = () => {
        const { side, width, height } = state;

        return side === "none"
            ? new DOMRect()
            : new DOMRect(side === "left" ? width : 0, 0, Math.max(0, innerWidth - width), height);
    };

    Object.defineProperties(overlay, {
        visible: { get: () => state.side !== "none" },
        getTitlebarAreaRect: { value: getTitlebarAreaRect },
    });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });

    function material() {
        const html = document.documentElement;
        const tint = ready && Number.isInteger(state.tint) && state.tint >= 0 && state.tint <= 100;

        html?.toggleAttribute("data-pocket-window-material", tint);

        if (tint) {
            html.style.setProperty("--pocket-window-opacity", `${state.tint}%`);
        } else {
            html?.style.removeProperty("--pocket-window-opacity");
        }
    }

    function update(next) {
        const geometryChanged = ["side", "width", "height"].some((field) => state[field] !== next[field]);
        const tintChanged = state.tint !== next.tint;

        state = next;

        if (tintChanged) {
            material();
        }

        if (geometryChanged) {
            const event = new Event("geometrychange");

            Object.defineProperties(event, {
                visible: { value: overlay.visible },
                titlebarAreaRect: { value: getTitlebarAreaRect() },
            });
            overlay.dispatchEvent(event);
        }
    }

    // Resolve theme tokens to opaque sRGB. The native app never receives server CSS, HTML or arbitrary styles.
    function publishTheme() {
        frame = 0;
        const html = document.documentElement;
        const style = getComputedStyle(html);
        const node = document.createElement("span");
        const canvas = document.createElement("canvas");

        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d", { willReadFrequently: true });

        if (!paint) {
            return;
        }

        node.hidden = true;
        html.append(node);

        function color(token) {
            node.style.color = `var(${token})`;
            paint.clearRect(0, 0, 1, 1);
            paint.fillStyle = getComputedStyle(node).color;
            paint.fillRect(0, 0, 1, 1);
            const pixels = paint.getImageData(0, 0, 1, 1).data;

            return pixels[3] === 255
                ? "#" + [...pixels.slice(0, 3)].map((n) => n.toString(16).padStart(2, "0")).join("")
                : null;
        }

        const palette = {
            background: color("--desk"),
            panel: color("--panel"),
            text: color("--text"),
            accent: color("--accent"),
            dark: style.colorScheme.startsWith("dark"),
        };

        node.remove();

        if (palette.background && palette.panel && palette.text && palette.accent) {
            const encoded = JSON.stringify(palette);

            if (encoded !== latestTheme) {
                latestTheme = encoded;
                post("theme", palette);
            }
        }
    }

    // Use the actual top-frame link activation, not a remembered or redirected download URL. The native download
    // event must independently match this URL; the message cannot create a download or name its destination.
    addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;

        if (!ready || !event.isTrusted || !link || !link.hasAttribute("download")) {
            return;
        }

        const url = new URL(link.href);

        if (
            url.origin === origin &&
            !url.hash &&
            /^\/api\/c\/[0-9]+\/download$/.test(url.pathname) &&
            url.searchParams.getAll("path").length === 1 &&
            url.searchParams.get("path")
        ) {
            post("download-link", { url: url.href });
        }
    }, true);

    Object.defineProperty(window, "__piPocketWindow", {
        value: Object.freeze({
            update,
            ready(dragTarget) {
                if (ready) {
                    return;
                }

                ready = true;
                post("ready");
                material();
                const html = root ?? document.documentElement;
                const queueTheme = () => {
                    if (!frame) {
                        frame = requestAnimationFrame(publishTheme);
                    }
                };

                new MutationObserver(queueTheme).observe(html, { attributes: true });
                document.addEventListener("load", queueTheme, true);
                matchMedia("(prefers-color-scheme: dark)").addEventListener("change", queueTheme);
                queueTheme();

                addEventListener("mousedown", (event) => {
                    if (overlay.visible && event.isTrusted && event.button === 0 && dragTarget(event)) {
                        post("drag", { x: event.clientX, y: event.clientY, clicks: event.detail });
                    }
                });
                addEventListener("contextmenu", (event) => {
                    if (state.nativeDragContext && overlay.visible && event.isTrusted && dragTarget(event)) {
                        event.preventDefault();
                        post("context");
                    }
                });
            },
        }),
    });
});
