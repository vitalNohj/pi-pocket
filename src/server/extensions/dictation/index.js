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
    const { html, Switch, useEffect, useState } = pocket;
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

        function row(model) {
            const size = modelSize(model);
            const installed = ids.includes(model.id);
            const selected = installed && prefs.selected === model.id;
            const supported = size <= browserLimit();
            const reason = supported ? undefined : `dictation-size-${model.id}`;
            const current = progress?.id === model.id ? progress : null;
            const meta = `${model.languages} · ${megabytes(size)} · ${model.license}`;
            let actions;

            if (current?.remove) {
                actions = html`<span class="muted small" role="status">Removing model…</span>`;
            } else if (current) {
                actions = html`
                    <div class="dictation-transfer">
                        <progress
                            aria-label=${`Downloading ${model.name}`}
                            value=${current.written || null}
                            max=${current.total}
                        ></progress>
                        <span class="muted small">
                            ${
                                current.written === 0
                                    ? "Preparing download…"
                                    : `${megabytes(current.written)} of ${megabytes(current.total)}`
                            }
                        </span>
                    </div>
                    <button
                        type="button"
                        class="button small"
                        aria-label=${`Cancel download of ${model.name}`}
                        onClick=${() => task?.abort()}
                    >
                        Cancel
                    </button>
                `;
            } else if (installed) {
                actions = html`
                    ${
                        selected
                            ? html`<span class="dictation-selected">Selected</span>`
                            : html`<button
                                  type="button"
                                  class="button small"
                                  aria-label=${`Select ${model.name}`}
                                  aria-describedby=${reason}
                                  disabled=${!supported || !!progress}
                                  onClick=${() => save({ selected: model.id }, true)}
                              >
                                  Select
                              </button>`
                    }
                    <button
                        type="button"
                        class="button small"
                        aria-label=${`Remove ${model.name}`}
                        disabled=${!!progress}
                        onClick=${() => change(model, true)}
                    >
                        Remove
                    </button>
                `;
            } else {
                actions = html`<button
                    type="button"
                    class="button small"
                    aria-label=${`Download ${model.name}`}
                    aria-describedby=${reason}
                    disabled=${!supported || !!progress}
                    onClick=${() => change(model, false)}
                >
                    Download
                </button>`;
            }

            return html`<li class="list-item dictation-model" key=${model.id}>
                <div class="dictation-model-info">
                    <div class="dictation-model-title">
                        <strong>${model.name}</strong>
                        ${model.recommended && html`<span class="small muted">Recommended</span>`}
                    </div>
                    <p class="small muted">${meta}</p>
                    <p class="small">${model.note}</p>
                    ${
                        reason &&
                        html`<p class="small muted" id=${reason}>Too large for this browser.</p>`
                    }
                </div>
                <div class="dictation-model-actions">${actions}</div>
            </li>`;
        }

        return html`<div class="dictation-settings">
            <p>
                Use the mic or <kbd>Alt+V</kbd> to dictate. <kbd>Esc</kbd> cancels.${" "} Offline
                dictation keeps audio on this device and does not send the draft.
            </p>
            <div class="sheet-list">
                <div class="list-item">
                    <div>
                        <div>Use offline dictation on this device</div>
                        ${
                            !offline &&
                            html`<p class="muted small">
                                The built-in browser recognizer may send audio to its provider.
                            </p>`
                        }
                    </div>
                    <${Switch}
                        on=${offline}
                        label="Use offline dictation on this device"
                        disabled=${!!progress || (!offline && ids.length === 0)}
                        onChange=${() => save({ selected: prefs.selected ?? ids[0] }, !offline)}
                    />
                </div>
                <div class="list-item">
                    <div>
                        <div>Words as you speak</div>
                        <p class="muted small">Show words before you finish dictating.</p>
                    </div>
                    <${Switch}
                        on=${prefs.live}
                        label="Words as you speak"
                        disabled=${!!progress}
                        onChange=${() => save({ live: !prefs.live })}
                    />
                </div>
            </div>
            ${
                modelById(prefs.selected)?.family === "parakeet"
                    ? html`<label class="field">
                          <span class="label">Custom words (up to 20, one per line)</span>
                          <textarea
                              rows="4"
                              maxlength="2000"
                              disabled=${!!progress}
                              value=${prefs.words.join("\n")}
                              onChange=${(event) => {
                                  save({ words: cleanWords(event.currentTarget.value).join("\n") });
                              }}
                          ></textarea>
                      </label>`
                    : html`<p class="muted small">
                          Custom words are available with Parakeet models.
                      </p>`
            }
            ${error && html`<p class="error-box" role="alert">${error}</p>`}
            <section class="dictation-catalog">
                <div class="dictation-catalog-head">
                    <h3 id="dictation-models-title">Speech models</h3>
                    <span class="muted small">
                        ${megabytes(storageUse(ids))} of 1 GB used in this browser
                    </span>
                </div>
                <ul
                    class="sheet-list dictation-models"
                    role="list"
                    aria-labelledby="dictation-models-title"
                >
                    ${MODELS.map(row)}
                </ul>
            </section>
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "settings", title: "Offline dictation", component: Settings, wide: true });
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
