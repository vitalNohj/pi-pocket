/** sherpa-onnx uses these names for model files. The same mapping works for WASM and the native helper. */
export function modelConfig(model, folder = "/", words = []) {
    const named = (suffix) => {
        const file = model.files.find(({ name }) => name === suffix || name.endsWith(`-${suffix}`));

        if (!file) {
            throw new Error("The speech model is incomplete.");
        }

        return `${folder}${file.name}`;
    };

    const modelConfig = { tokens: named("tokens.txt"), numThreads: 1, provider: "cpu", debug: 0 };
    const config = { featConfig: { sampleRate: 16_000, featureDim: 80 }, modelConfig };

    switch (model.family) {
        case "whisper":
            modelConfig.whisper = {
                encoder: named("encoder.int8.onnx"),
                decoder: named("decoder.int8.onnx"),
                language: "",
                task: "transcribe",
                tailPaddings: -1,
            };
            break;
        case "parakeet":
            modelConfig.modelType = "nemo_transducer";
            modelConfig.transducer = {
                encoder: named("encoder.int8.onnx"),
                decoder: named("decoder.int8.onnx"),
                joiner: named("joiner.int8.onnx"),
            };

            if (words.length) {
                modelConfig.modelingUnit = "bpe";
                modelConfig.bpeVocab = `${folder}hotwords.vocab`;
                config.decodingMethod = "modified_beam_search";
                config.maxActivePaths = 4;
                config.hotwordsScore = 3;
                config.hotwordsFile = `${folder}hotwords.txt`;
            }

            break;
        case "moonshine":
            modelConfig.moonshine = {
                preprocessor: named("preprocess.onnx"),
                encoder: named("encode.int8.onnx"),
                uncachedDecoder: named("uncached_decode.int8.onnx"),
                cachedDecoder: named("cached_decode.int8.onnx"),
            };
            break;
        case "sense-voice":
            modelConfig.senseVoice = {
                model: named("model.int8.onnx"),
                language: "auto",
                useInverseTextNormalization: 1,
            };
            break;
        default:
            throw new Error("This speech model is not supported.");
    }

    return config;
}

export const cleanWords = (value) =>
    [
        ...new Set(
            String(value ?? "")
                .slice(0, 2000)
                .split(/\r?\n/)
                .map((word) =>
                    word
                        .replace(/[/:\p{Cc}\p{Cf}]/gu, " ")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 80),
                )
                .filter(Boolean),
        ),
    ].slice(0, 20);

export function bpeVocab(tokens) {
    return tokens
        .split("\n")
        .flatMap((line) => {
            const match = /^(.*) (\d+)$/.exec(line.trimEnd());

            return match ? [`${match[1]}\t${-Number(match[2])}\n`] : [];
        })
        .join("");
}
