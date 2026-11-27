// Run only in the installer job, against its disposable Pi Pocket package and user profile.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [app, work] = process.argv.slice(2);
const bundle = join(dirname(app), "web", "app.js");

mkdirSync(work, { recursive: true });
writeFileSync(join(work, "window-fixture.txt"), "Pi Pocket desktop download fixture\n");
writeFileSync(
    bundle,
    `const folder = ${JSON.stringify(work)};\n${readFileSync(new URL("./window-fixture-page.js", import.meta.url), "utf8")}`,
);
