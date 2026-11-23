#!/usr/bin/env node
// The runner's command. It checks the Node version, then runs src/main.ts (Node strips its types, with help from
// strip-types.js in an npm install).
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
    console.error(
        `The Pi Pocket runner needs Node.js 22.19 or newer (found ${process.versions.node}).`,
    );
    process.exit(1);
}

// The first release of each line with the October 21, 2026 security fixes (TLS hostname checks, Brotli,
// dns.resolve). Older ones still run, with a warning; a line not listed here gets none.
const patched = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const patch = Number(process.versions.node.split(".")[2]);
const fixed = patched[major];

if (fixed && (minor < fixed[0] || (minor === fixed[0] && patch < fixed[1]))) {
    console.warn(
        `Node.js ${process.versions.node} lacks security fixes: update to ${major}.${fixed.join(".")} or newer.`,
    );
}

const { main } = await import("../main.js");

await main(process.argv.slice(2));
