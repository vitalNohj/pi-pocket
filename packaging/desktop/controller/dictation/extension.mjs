// Reuse the bundled extension's immutable catalogue, verifier and CPU engine. No HTTP server or user credentials.
export async function loadExtension(root) {
    const load = (file) => import(new URL(`src/server/extensions/dictation/${file}`, root));
    const [catalogue, cache, phrases, config] = await Promise.all([
        load("catalog.js"),
        load("model-cache.ts"),
        load("phrases.js"),
        load("model-config.js"),
    ]);

    return { ...catalogue, ...cache, ...phrases, ...config };
}
