// The package's entry. Node strips no types under a node_modules folder: the hook does it there (bin/strip-types.js).
await import("./bin/strip-types.js");

const { main } = await import("./src/main.ts");

export { main };
