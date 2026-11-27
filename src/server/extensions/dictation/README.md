# Offline dictation

The owner can turn on **Offline dictation** in **Menu → Extensions**. Then open **Menu → Dictation** and download a model. The first model is selected on this device. Other people, including people invited to one session, must make their own choice in their browser. A device without an offline choice keeps its existing browser recognizer, if it has one. Turn off **Use offline dictation on this device** explicitly to return to that recognizer.

Use the mic or Alt+V in the composer or PiP. The words go into the draft, not to Send. Click the mic again to finish. Esc stops the recording. The microphone needs a visible top-level HTTPS or localhost tab and site permission. Ordinary remote HTTP is not supported. Audio is processed by a single-threaded CPU worker on the device. The server does not receive audio, recognition results, or custom words through this extension. The usual composer rules still apply when the person edits or sends their draft.

The server caches only fixed, public, SHA-256 checked model files. It streams them on explicit download requests. The cache lives in `dictation-model-cache-v1` under the server's data directory. It is bounded to 2 GiB and evicts old unused files as needed. The browser checks the SHA-256 again and keeps complete models in its own profile (up to 1 GB). Remove models from **Menu → Dictation**. Removing the last model also removes the device's engine data. The engine wakes on the first recording and unloads when idle for 10 minutes. Larger models are listed but can be unavailable when they exceed the browser's memory limit.

## Third-party notices

- The bundled CPU WebAssembly engine is [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx), distributed as [`@sherpaw/asr` 0.3.0](https://www.npmjs.com/package/@sherpaw/asr) under Apache-2.0. Its notice is in the installed dependency's `LICENSE`. The extension uses the CPU WASM and the offline recognizer only. It does not use the WebGPU or streaming network interface.
- [NVIDIA Parakeet v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) and [v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) are CC BY 4.0. The catalogue pins converted, quantized ONNX copies by `csukuangfj`.
- [OpenAI Whisper](https://github.com/openai/whisper#license), [Hugging Face Distil-Whisper](https://huggingface.co/distil-whisper/distil-large-v3.5), and [Useful Sensors Moonshine](https://github.com/moonshine-ai/moonshine) weights are MIT. The catalogue pins converted, quantized ONNX copies by `csukuangfj`.
- SenseVoice uses the [FunASR model license](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE). This pin uses the [ASLP-lab WSYue-ASR](https://huggingface.co/ASLP-lab/WSYue-ASR) adaptation converted to ONNX by `csukuangfj`.
- The test fixture `test/fixtures/dictation-jfk.pcm` is 11 seconds of 16 kHz mono signed 16-bit little-endian PCM. It is the audio from [the `whisper.cpp` JFK sample](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav), a recording of the 1961 US presidential inaugural address.

Update the package lock, the fixed engine asset list, the browser's engine digest, and the packaged smoke test together when changing the engine. Increment the asset and browser storage versions when an engine update changes their content. No engine installer runs at dictation time.
