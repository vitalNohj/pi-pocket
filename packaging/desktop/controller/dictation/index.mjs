import { isId, isText, onlyKeys } from "../../protocol/index.mjs";
import { boolean, choice } from "../../protocol/state.mjs";
import { connectionError } from "../connection/probe.mjs";
import { SpeechEngine } from "./engine.mjs";
import { loadExtension } from "./extension.mjs";
import { ENGINE_MODEL_LIMIT, SpeechModels } from "./models.mjs";

// Mono, signed 16-bit LE at 16 kHz. 50 ms fits the controller's bound on a single JSON string.
export const FRAME_SAMPLES = 800;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const SESSION_MS = 120_000;
const MAX_FRAMES = SESSION_MS / 50 + 1;
const opaque = (value) => typeof value === "string" && /^[\da-f]{32}$/.test(value);
const noData = (value) => value === undefined;
const target =
    (extra = []) =>
    (data) =>
        onlyKeys(data, ["generation", "scope", ...extra]) &&
        isId(data.generation) &&
        opaque(data.scope);
const request =
    (extra = []) =>
    (data) =>
        target(["id", ...extra])(data) && opaque(data.id);
const keyChoice = choice("default", "none", "primary-shift-d", "F8", "F9");
const notReady = () =>
    connectionError(
        "dictation-unavailable",
        "Select a speech model and open an editable Pi Pocket composer with Offline dictation enabled.",
    );
const busy = () =>
    connectionError("dictation-busy", "Finish the current dictation or model change first.");

export function pcmFrame(encoded) {
    if (
        typeof encoded !== "string" ||
        encoded.length !== Math.ceil(FRAME_BYTES / 3) * 4 ||
        !/^[\w+/]+={2}$/.test(encoded)
    ) {
        return null;
    }

    const bytes = Buffer.from(encoded, "base64");

    return bytes.length === FRAME_BYTES && bytes.toString("base64") === encoded ? bytes : null;
}

export async function registerDictation(
    desktop,
    { folder, root, extension, engine = new SpeechEngine(root) },
) {
    desktop.registerPreference("dictation", "key", "default", keyChoice);
    desktop.registerPreference("dictation", "keyMode", "both", choice("hold", "tap", "both"));
    desktop.registerPreference("dictation", "live", true, boolean);
    desktop.registerPreference("dictation", "words", "", (value) => isText(value, 2000));

    let catalogue;
    let models;

    try {
        catalogue = extension ?? (await loadExtension(root));
        models = new SpeechModels(folder, catalogue);
        await models.open();
    } catch {
        desktop.setSlice("dictation", {
            message:
                "Speech models are not available. Check device storage or reinstall Pi Pocket.",
        });

        return;
    }

    const { MODELS, modelById, modelSize, Phrases, cleanWords } = catalogue;
    const targets = new Map();
    let record = null;
    let last = null;
    let job = null;
    let progress = null;

    const current = ({ generation, scope }) =>
        desktop.activeGeneration === generation && targets.get(scope) === generation;
    const same = (data, session = record) =>
        session &&
        session.id === data.id &&
        session.scope === data.scope &&
        session.generation === data.generation;
    const selected = () => modelById(models.selected);
    const ready = () => !job && models.selected && modelSize(selected()) <= ENGINE_MODEL_LIMIT;
    const publish = () =>
        desktop.setSlice("dictation", {
            status: "available",
            selected: models.selected,
            models: MODELS.map(({ id, name, languages, license, recommended }) => ({
                id,
                name,
                languages,
                license,
                recommended,
                bytes: modelSize(modelById(id)),
                installed: models.installed.includes(id),
                supported: modelSize(modelById(id)) <= ENGINE_MODEL_LIMIT,
            })),
            progress,
            busy: Boolean(job || record),
            recording: Boolean(record && !record.finishing),
            canDictate: Boolean(
                (record ? !record.finishing : ready()) &&
                [...targets.values()].includes(desktop.activeGeneration),
            ),
            canCopy: Boolean(last && current(last)),
        });

    function event(session, type, fields = {}) {
        if (current(session)) {
            const { id, scope, generation } = session;

            void desktop
                .callHost("dictation.event", { id, scope, generation, type, ...fields })
                .catch(() => {});
        }
    }

    function clear(session, canceled = false) {
        if (record === session) {
            clearTimeout(session.timer);
            record = null;

            if (canceled) {
                session.phrases?.cancel();
                engine.drop();
            } else {
                engine.idle();
            }

            publish();
        }
    }

    function fail(session, message) {
        if (session === record) {
            event(session, "error", { message });
            clear(session, true);
        }
    }

    function expire(session) {
        if (session === record) {
            event(session, "stop");
            session.timer = setTimeout(
                () => fail(session, "The microphone did not stop in time."),
                5000,
            ).unref();
        }
    }

    const known = (data) => onlyKeys(data, ["model"]) && Boolean(modelById(data.model));

    async function change(kind, id) {
        if (record || job) {
            throw busy();
        }

        job = new AbortController();
        progress = { kind, id };
        publish();

        try {
            if (kind === "download") {
                const signal = AbortSignal.any([job.signal, AbortSignal.timeout(12 * 60_000)]);

                await models.install(modelById(id), signal, (written, total) => {
                    progress = { kind, id, written, total };
                    publish();
                });
            } else if (models.installed.includes(id)) {
                engine.drop();

                if (kind === "remove") {
                    await models.remove(id);
                } else {
                    await models.select(id);
                }
            } else {
                throw new Error("Download the model first.");
            }
        } catch {
            if (!job.signal.aborted) {
                throw connectionError(
                    "dictation-model",
                    kind === "download"
                        ? "Could not download or verify the model. Check disk space and your connection, then try again."
                        : "Could not change the installed model. Try again.",
                );
            }
        } finally {
            job = progress = null;
            publish();
        }
    }

    desktop.registerHostReport("dictation.attach", target(), (data) => {
        if (data.generation === desktop.activeGeneration) {
            for (const [scope, generation] of targets) {
                if (generation !== data.generation) {
                    targets.delete(scope);
                }
            }

            if (targets.size < 32) {
                targets.set(data.scope, data.generation);
                publish();
            }
        }
    });
    desktop.registerHostReport("dictation.detach", target(), (data) => {
        if (targets.get(data.scope) === data.generation) {
            targets.delete(data.scope);

            // The voice extension detaches on account change; the host detaches on navigation and close.
            if (last) {
                last = null;
            }

            if (record?.scope === data.scope) {
                clear(record, true);
            } else {
                publish();
            }
        }
    });
    desktop.registerHostReport("dictation.start", request(), async (data) => {
        if (!current(data) || !ready()) {
            throw notReady();
        }

        if (record) {
            throw busy();
        }

        const session = (record = { ...data, frames: 0, finishing: false, half: null, text: "" });
        const model = selected();
        const prefs = desktop.dictationPreferences;
        const words = model.family === "parakeet" ? cleanWords(prefs.words) : [];

        publish();

        try {
            await engine.warm(model.id, models.folder(model.id), words);

            if (record !== session || !current(session)) {
                throw new Error("The composer changed.");
            }
        } catch {
            clear(session, true);

            throw connectionError(
                "dictation-engine",
                "The speech model did not start. Try a smaller model or download it again.",
            );
        }

        session.phrases = new Phrases({
            live: prefs.live,
            seconds: model.family === "whisper" ? 20 : 30,
            decode: (samples) => engine.decode(samples),
            publish: ({ results }) => {
                if (record !== session || !current(session)) {
                    return;
                }

                const parts = results.map((result) => ({
                    text: result[0].transcript,
                    final: result.isFinal,
                }));
                const size = parts.reduce((sum, { text }) => sum + text.length, 0);

                if (size > 6000 || parts.length > 64) {
                    fail(session, "The dictation is too long. Start another recording.");

                    return;
                }

                session.text = parts
                    .filter(({ final }) => final)
                    .map(({ text }) => text)
                    .join(" ");
                event(session, "result", { parts });
            },
            error: () =>
                fail(session, "Recognition stopped. Try a shorter recording or a smaller model."),
        });
        session.timer = setTimeout(() => expire(session), SESSION_MS).unref();
    });
    desktop.registerHostReport(
        "dictation.frame",
        (data) => request(["pcm"])(data) && Boolean(pcmFrame(data.pcm)),
        (data) => {
            if (!same(data) || !current(data) || record.finishing || !record.phrases) {
                return;
            }

            if (++record.frames > MAX_FRAMES) {
                fail(record, "The recording exceeded its time limit.");

                return;
            }

            const bytes = pcmFrame(data.pcm);

            if (!record.half) {
                record.half = bytes;

                return;
            }

            record.phrases.accept(samples(record.half, bytes));
            record.half = null;
        },
    );
    desktop.registerHostReport("dictation.cancel", request(), (data) => {
        if (same(data)) {
            clear(record, true);
        }
    });
    desktop.registerHostReport("dictation.stop", request(), async (data) => {
        if (!same(data) || !current(data) || record.finishing || !record.phrases) {
            return;
        }

        const session = record;

        session.finishing = true;
        clearTimeout(session.timer);
        publish();

        if (session.half) {
            session.phrases.accept(samples(session.half, Buffer.alloc(FRAME_BYTES)));
            session.half = null;
        }

        const heard = await session.phrases.finish();

        if (session === record) {
            if (heard && current(session)) {
                last = { ...data, text: session.text };
            }

            event(session, heard ? "end" : "empty");
            clear(session);
        }
    });

    desktop.registerHostCommand("dictation.event", (data) =>
        request(["type", "parts", "message"])(data),
    );
    desktop.registerHostCommand("dictation.toggle", noData);
    desktop.registerHostCommand(
        "dictation.copy",
        (data) => request(["text"])(data) && isText(data.text, 6000),
    );
    desktop.registerAction("dictation.toggle", noData, () => desktop.callHost("dictation.toggle"));
    desktop.registerAction("dictation.copyLast", noData, () => {
        if (!last?.text || !current(last)) {
            throw notReady();
        }

        return desktop.callHost("dictation.copy", last);
    });

    for (const kind of ["select", "download", "remove"]) {
        desktop.registerAction(`dictation.${kind}`, known, ({ model }) => change(kind, model));
    }

    desktop.registerAction("dictation.cancelDownload", noData, () => {
        if (progress?.kind === "download") {
            job?.abort();
        }
    });
    publish();
}

function samples(a, b) {
    const output = new Float32Array(FRAME_SAMPLES * 2);

    for (let i = 0; i < FRAME_SAMPLES; i++) {
        output[i] = a.readInt16LE(i * 2) / 32768;
        output[i + FRAME_SAMPLES] = b.readInt16LE(i * 2) / 32768;
    }

    return output;
}
