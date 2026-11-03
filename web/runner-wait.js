// A session waits for the person at its computer. Cancel ends the request, so the server withdraws its question.
import { render } from "preact";
import { addLayer, removeLayer } from "./back.js";
import { store } from "./store.js";
import { html, Spinner } from "./ui.js";

/** A small modal over the folder or copy sheet; it must not replace that sheet. */
function waiting(computer, folder, since, cancel) {
    const host = document.createElement("div");
    const app = document.getElementById("app");
    const focused = document.activeElement;
    const wasInert = app?.inert;
    const layer = addLayer(cancel);

    if (app) {
        app.inert = true;
    }

    document.body.append(host);

    const draw = () => {
        const seconds = Math.max(0, Math.ceil((120_000 - (Date.now() - since)) / 1000));

        render(
            html`<div class="overlay runner-wait-overlay">
                <section
                    class="runner-wait"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="runner-wait-title"
                    aria-describedby="runner-wait-help"
                >
                    <h2 id="runner-wait-title">Waiting for ${computer}</h2>
                    <p id="runner-wait-help">Allow the session on ${computer}. Its runner shows a question there (in the Pi Pocket app, or in the terminal where the runner runs).</p>
                    <p class="runner-wait-folder">Folder: <bdi dir="ltr">${folder}</bdi></p>
                    <p class="runner-wait-countdown">
                        <${Spinner} label="Waiting for the computer" />
                        Nobody answered? It stops in ${seconds} s.
                    </p>
                    <button type="button" class="button wide" onClick=${cancel}>Cancel</button>
                </section>
            </div>`,
            host,
        );
    };

    const onKey = (event) => {
        if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            event.stopImmediatePropagation();
            cancel();
        }
    };

    draw();
    host.querySelector("button").focus({ preventScroll: true });
    addEventListener("keydown", onKey, true);

    const timer = setInterval(draw, 1000);

    return () => {
        clearInterval(timer);
        removeEventListener("keydown", onKey, true);
        removeLayer(layer);
        render(null, host);
        host.remove();

        if (app) {
            app.inert = wasInert;
        }

        if (focused?.isConnected) {
            focused.focus({ preventScroll: true });
        }
    };
}

/** Run `start(signal)` and show where to answer after 400 ms. A person's Cancel returns no session and no error. */
export async function waitOnComputer(runnerId, folder, kind, start) {
    const computer = store.state.runners.find((each) => each.id === runnerId);

    if (!computer?.asks) {
        return start(undefined);
    }

    const controller = new AbortController();
    const since = Date.now();
    let close;
    const timer = setTimeout(() => {
        close = waiting(computer.name, folder, since, () => controller.abort());
    }, 400);

    try {
        const result = await start(controller.signal);

        return controller.signal.aborted ? undefined : result;
    } catch (error) {
        if (!controller.signal.aborted) {
            throw error;
        }

        return undefined;
    } finally {
        clearTimeout(timer);
        close?.();
    }
}
