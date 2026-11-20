// An opt-in browser benchmark; see README.md for setup and what is timed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const executablePath = process.env.PI_POCKET_BROWSER ?? chromium.executablePath();
const sandbox = mkdtempSync(join(tmpdir(), "pocket-perf-"));

// Do this before importing the server or test helpers, which can read Pi's settings at import time.
Object.assign(process.env, {
    HOME: sandbox,
    USERPROFILE: sandbox,
    TMPDIR: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_STATE_HOME: join(sandbox, "state"),
    PI_OFFLINE: "1",
});

const warmups = 2;
const samples = 24;
let lab, browser;

try {
    const {
        changesLab,
        changesPanel,
        changesPlace,
        changesSession,
        composer,
        measureChange,
        menu,
        send,
    } = await import("../changes-refresh-fixture.ts");
    const files = Array.from({ length: warmups + samples }, (_, i) => `sample-${i}.txt`);

    lab = await changesLab();
    const id = await changesSession(lab.app, files);

    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });

    page.setDefaultTimeout(10_000);
    await page.goto(lab.login);
    await page.goto(`${lab.base}/s/${id}`);
    await page.locator(menu).click();
    await page.locator(changesPlace).click();
    await page
        .locator(changesPanel)
        .getByText("No uncommitted changes", { exact: false })
        .waitFor();

    const results = [];

    for (const file of files) {
        await page.locator(composer).fill(`write ${file}`);
        await page.locator(send).waitFor();
        results.push(await page.evaluate(measureChange(file)));
    }

    const timings = results.slice(warmups);
    const report = Object.fromEntries(
        Object.keys(timings[0]).map((key) => {
            const values = timings.map((sample) => sample[key]).sort((a, b) => a - b);
            const middle = values.length / 2;

            return [
                key,
                {
                    medianMs: Math.round((values[middle - 1] + values[middle]) / 2),
                    p95Ms: Math.round(values[Math.ceil(values.length * 0.95) - 1]),
                },
            ];
        }),
    );

    console.log(
        JSON.stringify(
            { warmups, samples, chromium: browser.version(), ...report, timings },
            null,
            2,
        ),
    );
} finally {
    await browser?.close();
    await lab?.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
