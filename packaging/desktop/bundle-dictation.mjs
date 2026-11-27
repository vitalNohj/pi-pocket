// Keep the desktop speech backend fixed to the installer, not to the independently updated server.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [sourceArg, destinationArg, mode] = process.argv.slice(2);
const source = resolve(sourceArg);
const destination = resolve(destinationArg);
const extension = "src/server/extensions/dictation";
const packageName = "@sherpaw/asr";
const vendorFiles = [
    ["dist/index.js", "asr-api.js"],
    ["dist/asr-B3QtWJoU.js", "asr-B3QtWJoU.js"],
    ["dist/tokens-wFJ0vjND.js", "tokens-wFJ0vjND.js"],
    ["dist/prebuilt/asr.wasm", "asr.wasm"],
    ["LICENSE", "LICENSE"],
];

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

async function copyVendor(vendor) {
    for (const [name, packaged] of vendorFiles) {
        await cp(join(vendor, name), join(destination, "vendor", packaged));
    }
}

if (mode === "--from-checkout") {
    // A desktop-only update ships no server dependencies. Build the same speech runtime
    // from the source checkout and the tarball pinned in its lockfile instead.
    const lock = JSON.parse(await readFile(join(source, "package-lock.json"), "utf8"));
    const pin = lock.packages?.[`node_modules/${packageName}`];
    const url = `https://registry.npmjs.org/${packageName}/-/asr-${pin?.version}.tgz`;

    if (
        !/^\d+\.\d+\.\d+$/.test(pin?.version) ||
        pin?.resolved !== url ||
        !pin.integrity?.startsWith("sha512-")
    ) {
        throw new Error("The lockfile does not pin the speech engine tarball.");
    }

    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(90_000) });

    if (!response.ok) {
        throw new Error(`Could not download the locked speech engine (HTTP ${response.status}).`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

    if (actual !== pin.integrity) {
        throw new Error("The speech engine tarball does not match the lockfile.");
    }

    const staging = await mkdtemp(join(tmpdir(), "pocket-speech-build-"));

    try {
        const archive = "speech.tgz";

        await writeFile(join(staging, archive), bytes);
        const tar = spawnSync(
            "tar",
            [
                "-xzf",
                archive,
                "--strip-components=1",
                ...vendorFiles.map(([name]) => `package/${name}`),
            ],
            {
                cwd: staging,
                stdio: "inherit",
            },
        );

        if (tar.status !== 0) {
            throw tar.error ?? new Error("Could not extract the locked speech engine.");
        }

        await copyVendor(staging);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
} else {
    const nested = join(source, "node_modules", packageName);
    const vendor = (await stat(nested).catch(() => null))?.isDirectory()
        ? nested
        : join(dirname(source), packageName);

    await copyVendor(vendor);
}
