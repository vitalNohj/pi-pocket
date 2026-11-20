# Browser performance tests

## Automatic Changes refresh

Run from the repository root after `npm ci`. Playwright is only needed for this benchmark:

```sh
npm install --prefix test/perf --no-save --package-lock=false playwright
npx --prefix test/perf playwright install chromium
node test/perf/changes-refresh.mjs
```

Set `PI_POCKET_BROWSER` to use an existing Chromium executable instead. The benchmark starts an
isolated server on a free loopback port with a temporary `HOME`, a fresh Git repository, and a
faux model. Each prompt calls the `write` tool to change one tracked file. The benchmark opens
the Changes tab before the warmups and does not click Refresh.

It prints the median, nearest-rank p95, and all 24 samples in milliseconds, after 2 warmups.
`sendToRow` runs from clicking Send to the new Changes row appearing. `idleToRequest` and
`idleToRow` start when the browser receives the idle view. To compare revisions, run the same
script and fixture on each revision with the same Node, Chromium, and machine. This measures the
local refresh path, not remote model or runner latency.
