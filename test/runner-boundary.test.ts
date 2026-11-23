// The line between Pi Pocket and its runner (`packages/runner/`): the runner's folder holds everything it needs, and
// Pi Pocket's own code never imports it, except the bridge (`src/runner/main.ts`) that starts it when it is here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT, "packages", "runner");
const BRIDGE = join(ROOT, "src", "runner", "main.ts");

/** The `.ts`, `.js`, and `.mjs` files in `folder` and below, without `node_modules`. */
function sources(folder: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);

        if (entry.isDirectory()) {
            if (entry.name !== "node_modules") {
                found.push(...sources(path));
            }
        } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
            found.push(path);
        }
    }

    return found;
}

/** A module specifier in a file, and whether it imports only types. */
type Specifier = { specifier: string; typeOnly: boolean };

/**
 * The string specifiers of a file: `import … from`, a bare `import "…"`, `export … from`, `import("…")`, and
 * `new URL("…", import.meta.url)`.
 */
function specifiers(file: string): Specifier[] {
    const text = readFileSync(file, "utf8");
    const found: Specifier[] = [];
    const patterns = [
        /\bimport\s+(type\s+)?[^"'`;()]*?\bfrom\s*["']([^"']+)["']/g,
        /\bexport\s+(type\s+)?[^"'`;()]*?\bfrom\s*["']([^"']+)["']/g,
        /^\s*import\s*()["']([^"']+)["']/gm,
        /\bimport\(\s*()["']([^"']+)["']\s*\)/g,
        /\bnew URL\(\s*()["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            found.push({
                specifier: match[2]!,
                typeOnly: match[1] !== undefined && match[1] !== "",
            });
        }
    }

    return found;
}

/** The package a bare specifier names: `ws`, `@scope/name`. */
function packageOf(specifier: string): string {
    const parts = specifier.split("/");

    return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/** A relative specifier: `./x`, `../x`, and also `.` or `..` alone (`new URL("..", import.meta.url)`). */
const relativeTo = (specifier: string) => /^\.\.?(\/|$)/.test(specifier);

describe("the runner's boundary", () => {
    it("each relative specifier in packages/runner/ points inside it", () => {
        const outside: string[] = [];

        for (const file of sources(RUNNER)) {
            for (const { specifier } of specifiers(file)) {
                if (!relativeTo(specifier)) {
                    continue;
                }

                const target = resolve(file, "..", specifier);

                if (target !== RUNNER && !target.startsWith(RUNNER + sep)) {
                    outside.push(`${relative(ROOT, file)}: ${specifier}`);
                }
            }
        }

        assert.deepEqual(outside, [], "The runner's package must hold everything it needs.");
    });

    it("each package the runner's code imports is in its dependencies (or devDependencies, for types only)", () => {
        const manifest = JSON.parse(readFileSync(join(RUNNER, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const imports = new Map<string, { files: string[]; code: boolean }>();

        for (const file of sources(join(RUNNER, "src"))) {
            for (const { specifier, typeOnly } of specifiers(file)) {
                if (relativeTo(specifier) || specifier.startsWith("node:")) {
                    continue;
                }

                const name = packageOf(specifier);
                const seen = imports.get(name) ?? { files: [], code: false };

                seen.files.push(relative(ROOT, file));
                seen.code ||= !typeOnly;
                imports.set(name, seen);
            }
        }

        assert.ok(imports.size > 0, "The scan found no package imports at all.");
        const missing: string[] = [];

        for (const [name, { files, code }] of imports) {
            const listed =
                manifest.dependencies?.[name] !== undefined ||
                (!code && manifest.devDependencies?.[name] !== undefined);

            if (!listed) {
                missing.push(`${name} (${[...new Set(files)].join(", ")})`);
            }
        }

        assert.deepEqual(missing, [], "Add these to packages/runner/package.json.");
    });

    it("Pi Pocket's own code never imports the runner, except the bridge", () => {
        const found: string[] = [];

        for (const folder of ["src", "bin", "web"]) {
            for (const file of sources(join(ROOT, folder))) {
                if (file === BRIDGE) {
                    continue;
                }

                for (const { specifier } of specifiers(file)) {
                    if (
                        specifier.includes("packages/runner") ||
                        specifier.startsWith("pi-pocket-runner")
                    ) {
                        found.push(`${relative(ROOT, file)}: ${specifier}`);
                    }
                }
            }
        }

        assert.deepEqual(
            found,
            [],
            "Pi Pocket runs the same without its runner: use its own copy in src/server/runner-link/.",
        );
    });

    it("src/runner/ holds only the bridge", () => {
        assert.deepEqual(readdirSync(join(ROOT, "src", "runner")), ["main.ts"]);
    });

    it("Pi Pocket pins the runner's own version", () => {
        const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
            optionalDependencies?: Record<string, string>;
        };
        const runner = JSON.parse(readFileSync(join(RUNNER, "package.json"), "utf8")) as {
            version: string;
        };

        assert.equal(root.optionalDependencies?.["pi-pocket-runner"], runner.version);
    });
});
