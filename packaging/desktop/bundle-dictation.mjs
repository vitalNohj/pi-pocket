// Keep the desktop speech backend fixed to the installer, not to the independently updated server.
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [source, destination] = process.argv.slice(2).map((path) => resolve(path));
const extension = "src/server/extensions/dictation";
const packages = "@sherpaw/asr";
const nested = join(source, "node_modules", packages);
const vendor = (await stat(nested).catch(() => null))?.isDirectory()
    ? nested
    : join(dirname(source), packages);

await mkdir(join(destination, extension), { recursive: true });
await mkdir(join(destination, "vendor"), { recursive: true });

for (const name of [
    "catalog.js",
    "model-cache.ts",
    "model-config.js",
    "phrases.js",
    "engine-worker.js",
    "README.md",
]) {
    await cp(join(source, extension, name), join(destination, extension, name));
}

await cp(join(source, "src/server/errors.ts"), join(destination, "src/server/errors.ts"));

for (const [name, packaged] of [
    ["index.js", "asr-api.js"],
    ["asr-B3QtWJoU.js", "asr-B3QtWJoU.js"],
    ["tokens-wFJ0vjND.js", "tokens-wFJ0vjND.js"],
    ["prebuilt/asr.wasm", "asr.wasm"],
]) {
    await cp(join(vendor, "dist", name), join(destination, "vendor", packaged));
}

await cp(join(vendor, "LICENSE"), join(destination, "vendor", "LICENSE"));
