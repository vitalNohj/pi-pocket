/** Public model pins from Pi Pocket GUI. Keep this catalogue shared by the device and the model asset route. */
const HF = "https://huggingface.co/csukuangfj";

function hf(repo, commit, name, size, sha256) {
    return { name, url: `${HF}/${repo}/resolve/${commit}/${name}`, size, sha256 };
}

const WHISPER_TOKENS = {
    size: 816_730,
    sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
};

function whisper(id, name, repo, commit, prefix, encoder, decoder, extra) {
    return {
        id,
        name,
        family: "whisper",
        license: "MIT",
        ...extra,
        files: [
            hf(repo, commit, `${prefix}-encoder.int8.onnx`, encoder[0], encoder[1]),
            hf(repo, commit, `${prefix}-decoder.int8.onnx`, decoder[0], decoder[1]),
            hf(repo, commit, `${prefix}-tokens.txt`, WHISPER_TOKENS.size, WHISPER_TOKENS.sha256),
        ],
    };
}

const PARAKEET_V3 = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_V3_AT = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
const PARAKEET_V2 = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const PARAKEET_V2_AT = "1ab9323565ddb038682214b292f588070a538ce2";
const MOONSHINE = "sherpa-onnx-moonshine-base-en-int8";
const MOONSHINE_AT = "052b0798ad1bf046a140fdd4efcd9426530fa3f5";
const SENSE_VOICE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09";
const SENSE_VOICE_AT = "355f4d4884d8afd08aef04b9007a8556d7b463b2";

/** The models, in the order the list shows them. */
export const MODELS = [
    {
        id: "parakeet-tdt-0.6b-v2",
        name: "Parakeet TDT 0.6B v2",
        family: "parakeet",
        languages: "English",
        note: "Fast and very accurate, with punctuation.",
        license: "CC BY 4.0 (NVIDIA)",
        recommended: true,
        files: [
            hf(
                PARAKEET_V2,
                PARAKEET_V2_AT,
                "encoder.int8.onnx",
                652_184_296,
                "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab",
            ),
            hf(
                PARAKEET_V2,
                PARAKEET_V2_AT,
                "decoder.int8.onnx",
                7_257_753,
                "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e",
            ),
            hf(
                PARAKEET_V2,
                PARAKEET_V2_AT,
                "joiner.int8.onnx",
                1_739_080,
                "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2",
            ),
            hf(
                PARAKEET_V2,
                PARAKEET_V2_AT,
                "tokens.txt",
                9384,
                "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
            ),
        ],
    },
    {
        id: "parakeet-tdt-0.6b-v3",
        name: "Parakeet TDT 0.6B v3",
        family: "parakeet",
        languages: "25 European languages, found by itself",
        note: "Fast and accurate, with punctuation.",
        license: "CC BY 4.0 (NVIDIA)",
        recommended: true,
        files: [
            hf(
                PARAKEET_V3,
                PARAKEET_V3_AT,
                "encoder.int8.onnx",
                652_184_281,
                "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
            ),
            hf(
                PARAKEET_V3,
                PARAKEET_V3_AT,
                "decoder.int8.onnx",
                11_845_275,
                "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
            ),
            hf(
                PARAKEET_V3,
                PARAKEET_V3_AT,
                "joiner.int8.onnx",
                6_355_277,
                "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
            ),
            hf(
                PARAKEET_V3,
                PARAKEET_V3_AT,
                "tokens.txt",
                93_939,
                "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
            ),
        ],
    },
    whisper(
        "whisper-large-v3-turbo",
        "Whisper large-v3 turbo",
        "sherpa-onnx-whisper-turbo",
        "2ca6ff69fc878651b770880507669577ac41c2ff",
        "turbo",
        [674_716_297, "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b"],
        [361_080_764, "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547"],
        {
            languages: "99 languages, found by itself",
            note: "Very accurate; slow without a fast processor (about as long as the speech).",
        },
    ),
    whisper(
        "whisper-large-v3",
        "Whisper large-v3",
        "sherpa-onnx-whisper-large-v3",
        "2a6507094dd6020d939d78e3f1834a1d06267fca",
        "large-v3",
        [766_671_985, "d531cf17248acc43e8c09b472a0877055e770877857a5332fc1304b36534ec85"],
        [1_008_265_203, "ebc6bfd88e162a46cb3edee8a7e727e1dcbc65cabecb19e2573695e4d495e1af"],
        {
            languages: "99 languages, found by itself",
            note: "Whisper's most accurate; the slowest here.",
        },
    ),
    whisper(
        "whisper-distil-large-v3.5",
        "Distil-Whisper large-v3.5",
        "sherpa-onnx-whisper-distil-large-v3.5",
        "2933155a51e982b9ebd9ca3b7fb80fc78162fa64",
        "distil-large-v3.5",
        [668_147_593, "c30727100ba2dfbe64f2309a2ec44a5049b005d8a6c0acce49952f635083cbdb"],
        [314_871_757, "7cef98c7b5491ba52a520fd61da957a62e6e64c702c6c8aeac8cdfb146cbdb6a"],
        { languages: "English", note: "Close to large-v3, faster." },
    ),
    whisper(
        "whisper-small",
        "Whisper small",
        "sherpa-onnx-whisper-small",
        "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
        "small",
        [112_442_483, "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"],
        [262_226_114, "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee"],
        { languages: "99 languages, found by itself", note: "Good; quick." },
    ),
    whisper(
        "whisper-base",
        "Whisper base",
        "sherpa-onnx-whisper-base",
        "bb53ee204431c90d314c1cc08d28d23e5b7927cc",
        "base",
        [29_120_534, "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"],
        [130_672_026, "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d"],
        { languages: "99 languages, found by itself", note: "Fair; very quick." },
    ),
    whisper(
        "whisper-tiny",
        "Whisper tiny",
        "sherpa-onnx-whisper-tiny",
        "65176e2deb88badc814a94058666cadccc29b61c",
        "tiny",
        [12_937_772, "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"],
        [89_855_401, "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"],
        {
            languages: "99 languages, found by itself",
            note: "The smallest and fastest; makes more mistakes.",
        },
    ),
    {
        id: "moonshine-base-en",
        name: "Moonshine base",
        family: "moonshine",
        languages: "English",
        note: "Small and quick, with punctuation.",
        license: "MIT (Useful Sensors)",
        files: [
            hf(
                MOONSHINE,
                MOONSHINE_AT,
                "preprocess.onnx",
                14_077_290,
                "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2",
            ),
            hf(
                MOONSHINE,
                MOONSHINE_AT,
                "encode.int8.onnx",
                50_311_494,
                "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2",
            ),
            hf(
                MOONSHINE,
                MOONSHINE_AT,
                "uncached_decode.int8.onnx",
                122_120_451,
                "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987",
            ),
            hf(
                MOONSHINE,
                MOONSHINE_AT,
                "cached_decode.int8.onnx",
                99_983_837,
                "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03",
            ),
            hf(
                MOONSHINE,
                MOONSHINE_AT,
                "tokens.txt",
                436_688,
                "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea",
            ),
        ],
    },
    {
        id: "sense-voice-2025-09-09",
        name: "SenseVoice small",
        family: "sense-voice",
        languages: "Chinese, Cantonese, Japanese, Korean (English is weak)",
        note: "Very quick.",
        license: "FunASR model license (Alibaba)",
        files: [
            hf(
                SENSE_VOICE,
                SENSE_VOICE_AT,
                "model.int8.onnx",
                237_115_547,
                "12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d",
            ),
            hf(
                SENSE_VOICE,
                SENSE_VOICE_AT,
                "tokens.txt",
                315_894,
                "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
            ),
        ],
    },
];

export function modelById(id) {
    return MODELS.find((model) => model.id === id);
}

export function modelSize(model) {
    return model.files.reduce((sum, file) => sum + file.size, 0);
}
