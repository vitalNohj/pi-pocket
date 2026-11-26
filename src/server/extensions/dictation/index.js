import { offlineVoiceKey, registerDictationProvider } from "/voice.js";
import { store } from "/store.js";
import { MODELS, modelById, modelSize } from "./catalog.js";
import { cleanWords } from "./model-config.js";
import { browserLimit, installModel, modelKeys, removeModel, storageUse } from "./model-store.js";
import { BrowserEngine, captureAvailable, createRecognition } from "./recognition.js";

export const pocketApi = 1;

const MODELS_CHANGED = "x.dictation.models.changed";
const megabytes = (bytes) => `${Math.round(bytes / 1_000_000)} MB`;

function preferences(key) {
    try {
        const data = JSON.parse(localStorage.getItem(`${key}.settings`) ?? "{}");

        return {
            selected: modelById(data.selected)?.id ?? null,
            live: data.live !== false,
            words: cleanWords(Array.isArray(data.words) ? data.words.join("\n") : data.words),
        };
    } catch {
        return { selected: null, live: true, words: [] };
    }
}

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;
    const engine = new BrowserEngine();
    const listeners = new Set();
    let key = null;
    let unregister = null;
    let task = null;

    function chosen() {
        try {
            return key !== null && localStorage.getItem(key) === "on";
        } catch {
            return false;
        }
    }

    function refresh() {
        unregister?.();
        engine.drop();
        unregister =
            chosen() && captureAvailable()
                ? registerDictationProvider(createRecognition(engine, () => preferences(key)))
                : null;
        listeners.forEach((listener) => listener());
    }

    function follow() {
        const next = offlineVoiceKey();

        if (key !== next) {
            task?.abort();
            key = next;
            refresh();
        }
    }

    function save(changes, offline = chosen()) {
        if (!key) {
            return;
        }

        try {
            localStorage.setItem(
                `${key}.settings`,
                JSON.stringify({ ...preferences(key), ...changes }),
            );
            offline ? localStorage.setItem(key, "on") : localStorage.removeItem(key);
            refresh();
        } catch {
            pocket.notify("error", "This browser could not save dictation preferences.");
        }
    }

    function storage(event) {
        if (
            key &&
            (event.key === key ||
                event.key === `${key}.settings` ||
                event.key === MODELS_CHANGED ||
                event.key === null)
        ) {
            refresh();
        }
    }

    const unsubscribe = store.subscribe(follow);

    follow();
    window.addEventListener("storage", storage);

    function Settings() {
        const [ids, setIds] = useState([]);
        const [prefs, setPrefs] = useState(() => preferences(key));
        const [offline, setOffline] = useState(chosen);
        const [progress, setProgress] = useState(null);
        const [error, setError] = useState(null);
        const available = captureAvailable();

        useEffect(() => {
            let closed = false;

            const update = () => {
                setPrefs(preferences(key));
                setOffline(chosen());

                if (available) {
                    void modelKeys()
                        .then((models) => {
                            if (!closed) {
                                setIds(models);
                            }
                        })
                        .catch(() => {
                            if (!closed) {
                                setError(
                                    "This browser does not allow speech model storage in this profile.",
                                );
                            }
                        });
                }
            };

            listeners.add(update);
            update();

            return () => {
                closed = true;
                listeners.delete(update);
                task?.abort();
            };
        }, [available]);

        async function change(model, remove) {
            if (task || !key) {
                return;
            }

            const control = new AbortController();
            const { signal } = control;
            const account = key;

            task = control;
            unregister?.();
            engine.drop();
            setError(null);
            setProgress({ id: model.id, written: 0, total: modelSize(model), remove });

            try {
                if (remove) {
                    await removeModel(model.id);

                    if (key === account && preferences(key).selected === model.id) {
                        const other = await modelKeys();

                        if (key === account) {
                            save({ selected: other[0] ?? null });
                        }
                    }
                } else {
                    await installModel(model, signal, (written, total) => {
                        setProgress({ id: model.id, written, total, remove });
                    });

                    if (key === account && !signal.aborted && !preferences(key).selected) {
                        save({ selected: model.id }, true);
                    }
                }

                localStorage.setItem(MODELS_CHANGED, String(Date.now()));
            } catch (failure) {
                if (!signal.aborted) {
                    setError(
                        failure?.name === "QuotaExceededError"
                            ? "Browser storage is full. Remove an unused model."
                            : failure.message,
                    );
                }
            } finally {
                task = null;
                setProgress(null);
                refresh();
            }
        }

        if (!available) {
            return html`<p>
                Offline dictation needs a top-level HTTPS or localhost tab with microphone,
                WebAssembly and device storage support.
            </p>`;
        }

        return html`
            <p>
                The microphone writes a draft in the message box or PiP. Audio stays on this device.
                Dictation never presses Send.
            </p>
            <p>
                To dictate, use the mic or Alt+V. Press Esc to cancel. You can allow the mic in this
                site's permissions.
            </p>
            <p>
                Models and preferences stay in this browser. Storage used:
                ${megabytes(storageUse(ids))} of 1 GB.
            </p>
            <label>
                <input
                    type="checkbox"
                    checked=${offline}
                    disabled=${!!progress || (!offline && ids.length === 0)}
                    onChange=${(event) => save({ selected: prefs.selected ?? ids[0] }, event.currentTarget.checked)}
                />
                Use offline dictation on this device
            </label>
            ${!offline && html`<p>The built-in browser recognizer, if available, may send audio to its provider.</p>`}
            <p>
                <label>
                    <input
                        type="checkbox"
                        checked=${prefs.live}
                        disabled=${!!progress}
                        onChange=${(event) => save({ live: event.currentTarget.checked })}
                    />
                    Words as you speak
                </label>
            </p>
            ${
                modelById(prefs.selected)?.family === "parakeet"
                    ? html` <label>
                          Custom words (up to 20, one per line)
                          <textarea
                              rows="4"
                              maxlength="2000"
                              disabled=${!!progress}
                              value=${prefs.words.join("\n")}
                              onChange=${(event) => save({ words: cleanWords(event.currentTarget.value).join("\n") })}
                          />
                      </label>`
                    : html`<p>Custom words are available with Parakeet models.</p>`
            }
            ${error && html`<p class="error-box" role="alert">${error}</p>`}
            ${
                progress &&
                html`<p role="status">
                    ${
                        progress.remove
                            ? "Removing model…"
                            : progress.written === 0
                              ? "Preparing download…"
                              : `Downloading ${megabytes(progress.written)} of ${megabytes(progress.total)}…`
                    }
                    ${!progress.remove && html`<button type="button" class="btn" onClick=${() => task?.abort()}>Cancel</button>`}
                </p>`
            }
            <ul>
                ${MODELS.map((model) => {
                    const installed = ids.includes(model.id);
                    const selected = prefs.selected === model.id;
                    const supported = modelSize(model) <= browserLimit();

                    return html`<li key=${model.id}>
                        <p>
                            <strong>${model.name}</strong
                            >${model.recommended ? " · Recommended" : ""} <br />${model.languages} ·
                            ${megabytes(modelSize(model))} · ${model.license} <br />${model.note}
                            ${!supported && html`<br />Too large for this browser. Choose a smaller model.`}
                        </p>
                        ${
                            installed
                                ? html`
                                      <button
                                          type="button"
                                          class="btn"
                                          disabled=${selected || !supported || !!progress}
                                          onClick=${() => save({ selected: model.id }, true)}
                                      >
                                          ${selected ? "Selected" : "Select"}
                                      </button>
                                      <button
                                          type="button"
                                          class="btn"
                                          disabled=${!!progress}
                                          onClick=${() => change(model, true)}
                                      >
                                          Remove
                                      </button>
                                  `
                                : html`
                                      <button
                                          type="button"
                                          class="btn"
                                          disabled=${!supported || !!progress}
                                          onClick=${() => change(model, false)}
                                      >
                                          Download
                                      </button>
                                  `
                        }
                    </li>`;
                })}
            </ul>
        `;
    }

    pocket.sheet({ id: "settings", title: "Offline dictation", component: Settings });
    pocket.menu({
        id: "dictation",
        label: "Dictation",
        hint: "Manage offline speech models",
        sheet: "settings",
    });

    return () => {
        task?.abort();
        key = null;
        unsubscribe();
        window.removeEventListener("storage", storage);
        unregister?.();
        engine.drop();
    };
}
