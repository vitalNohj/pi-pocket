// Runs at document start only in the verified Pi Pocket view. The page gets results, never PCM or OS access.
(origin, post, listen) => {
    if (
        window.top !== window ||
        window.origin !== origin ||
        location.origin !== origin ||
        !isSecureContext
    ) {
        return;
    }

    const nonce = () =>
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
    let attached = null;
    let request = null;
    let gesture = false;

    function send(op, scope, id) {
        return post({ type: "dictation", op, scope, ...(id ? { id } : {}) });
    }

    function finish(error, message) {
        const recognition = request;

        request = null;

        if (recognition) {
            if (error) {
                recognition.onerror?.({ error, message });
            }

            recognition.onend?.();
        }
    }

    listen((event) => {
        if (event.type === "bind" && attached) {
            finish("aborted");
            send("attach", attached.scope);

            return;
        }

        if (event.type !== "dictation" || !attached || event.scope !== attached.scope) {
            return;
        }

        if (event.op === "toggle" || event.op === "hold" || event.op === "release") {
            if (document.hidden || !document.hasFocus()) {
                return;
            }

            gesture = true;

            try {
                attached.control(event.op);
            } finally {
                gesture = false;
            }

            return;
        }

        if (!request || event.id !== request.id) {
            return;
        }

        switch (event.op) {
            case "result":
                request.onresult?.({
                    resultIndex: 0,
                    results: event.parts.map(({ final, text }) =>
                        Object.assign([{ transcript: text }], { isFinal: final }),
                    ),
                });
                break;
            case "end":
                finish();
                break;
            case "empty":
                finish("no-speech");
                break;
            case "cancel":
                finish("aborted");
                break;
            case "error":
                finish("desktop", event.message);
                break;
        }
    });

    function disconnect(entry) {
        if (entry !== attached) {
            return;
        }

        attached = null;
        send("detach", entry.scope);
        finish("aborted");
    }

    Object.defineProperty(window, "pocketDictation", {
        value: Object.freeze({
            apiVersion: 1,
            settings: () => post({ type: "dictation", op: "settings" }),
            attach(control) {
                if (typeof control !== "function") {
                    return null;
                }

                if (attached) {
                    disconnect(attached);
                }

                const entry = (attached = { scope: nonce(), control });

                send("attach", entry.scope);

                return {
                    detach: () => disconnect(entry),
                    Recognition: class {
                        start() {
                            if (
                                attached !== entry ||
                                request ||
                                document.hidden ||
                                !document.hasFocus() ||
                                (!gesture && !navigator.userActivation?.isActive)
                            ) {
                                throw new Error(
                                    "Focus a Pi Pocket composer and press its microphone button or your dictation key.",
                                );
                            }

                            this.id = nonce();

                            if (!send("start", entry.scope, this.id)) {
                                throw new Error("Wait for the desktop window to finish loading.");
                            }

                            request = this;
                        }

                        stop() {
                            if (request === this) {
                                send("stop", entry.scope, this.id);
                            }
                        }

                        abort() {
                            if (request === this) {
                                request = null;
                                send("cancel", entry.scope, this.id);
                            }
                        }
                    },
                };
            },
        }),
    });
    addEventListener("pagehide", () => {
        if (attached) {
            disconnect(attached);
        }
    });
};
