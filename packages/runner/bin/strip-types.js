// Lets Node run this package's TypeScript from an npm install. Node strips types itself, but never from a file under a
// node_modules folder, which is where npm puts this package. Imported before any of this package's code (by its
// command or entry, and with `--import` in a process it starts), it strips the types of this package's own .ts files
// there with Node's own stripper, and leaves every other file to Node. In a git checkout it does nothing. Pi Pocket
// and its runner (packages/runner/) each have a copy of this file, the same bytes: test/runner-copies.test.ts.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's folder, as a URL that ends in `/`. */
const ROOT = new URL("..", import.meta.url).href;

/** Whether this package runs from a node_modules folder, where Node does not strip types. */
export const needed = fileURLToPath(ROOT).split(sep).includes("node_modules");

/** Node's stripper, without the warning that it is experimental at every start. */
function strip(source) {
    const warn = process.emitWarning;

    process.emitWarning = (warning, ...rest) => {
        if (!String(warning).includes("stripTypeScriptTypes")) {
            warn.call(process, warning, ...rest);
        }
    };

    try {
        return stripTypeScriptTypes(source);
    } finally {
        process.emitWarning = warn;
    }
}

/** One of this package's own TypeScript files (not one of a package inside it), as a file path; else undefined. */
function ownTypeScript(url) {
    const bare = url.split(/[?#]/)[0];

    if (!bare.startsWith(ROOT) || !/\.m?ts$/.test(bare)) {
        return undefined;
    }

    return bare.slice(ROOT.length).split("/").includes("node_modules")
        ? undefined
        : fileURLToPath(bare);
}

if (needed) {
    registerHooks({
        load(url, context, nextLoad) {
            const file = ownTypeScript(url);

            if (file === undefined) {
                return nextLoad(url, context);
            }

            return {
                format: "module",
                source: strip(readFileSync(file, "utf8")),
                shortCircuit: true,
            };
        },
    });
}
