# What the browser does before drawing a session

**The first frame is mostly browser work, not JSON.** The browser mounts a fixed window of 60 transcript rows regardless of the session length. A warm switch reuses the Markdown, but still creates the row DOM, measures the scroller, and styles, lays out, and paints the window. Growing the older history from 200 to 10,000 entries does not make this step grow with it.

This follows [the server-open study](https://github.com/vitalNohj/pi-pocket/blob/perf/open-measure/docs/open-measurements.md). That study's socket write → rows number includes transport and event delivery, and its transcript text was much lighter. This study starts inside the browser and uses richer content. The absolute cold numbers are not a regression comparison between the two revisions.

## Method

- Revision: `d10ab8914256c3102a0d0740dad29aede0201d5d` (`feat/session-cache-ready`). Separate `test/serve.ts` on loopback, with its scripted model and disposable data. The driver added timing probes to a `git archive` copy, not to this checkout's product code.
- `opti2`, six CPUs; the runner, server and sandboxed headless Chromium shared a 200% systemd CPU quota and CPUs 0–1. Node v22.22.1, Chromium 157.0.8103.50. The branch uses its own `Chromium` CDP helper in its browser tests, not Playwright; the driver uses that same helper. Desktop: 1440 × 960, 1× CPU; phone stand-in: 390 × 844, touch, DPR 2, DevTools 4× CPU throttle. Both use loopback, not a simulated phone network. This is not a measurement of a physical phone, iOS, or Safari.
- Synthetic sessions were written by the app's durable transaction API. Each turn has a prompt, an assistant thinking/tool-call entry, one `read` result, one `bash` result, and a Markdown answer. Every 17th read is 50 KiB and every 23rd bash result is 112 KiB. The answers have prose, tables or lists, 15–22 lines of TypeScript, Python, Rust, or bash, some inline math, and local 600 × 304 PNGs in about one turn in eight. Model payloads before storage: 0.63, 7.28, and 36.66 MB. No owner sessions or files were used.
- **First:** direct route, fresh browser context, no client copy. **Device:** prime the real IndexedDB copy, close the tab, then reopen the route in a new tab. **Switch:** leave and navigate back in the same tab; the retained view and rendered-Markdown cache are warm. Both return cases used their normal `have` path. In half of each return case the driver explicitly scrolled 150 CSS px up before leaving and verified a saved position. The other half used the app's default placement. Runs were serial, with rotated size and case order. The server stays up throughout; no server startup time is in the measured window.
- **Start** for a first open is entry to the event listener before parsing the first SSE view. For device and switch it is the first store update that adopts rows from the verified local copy; the server often answers later. **Paint** is the end of the first renderer-main-thread `Paint` with the transcript after the newest row is present and the root is no longer hidden. The driver records the first paint after the DOM mark; saved traces can confirm the transcript paint inside that frame. This is not a compositor presentation timestamp or the end of the entrance animation. Two `requestAnimationFrame` callbacks check that a frame was possible, not set the reported boundary.
- The driver aligns `performance.mark` / `measure` and Chromium's [DevTools trace](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/) clocks on `dp.dom`. It attributes overlapping intervals only once, in this order: style/layout, paint, scroll JS, Markdown builds, math, Preact, JSON/store, other renderer work. The first two include synchronous browser work triggered by JavaScript. Preact excludes nested Markdown and layout; JSON/store includes parse, view merge, and the remaining state commits. The other column includes unattributed main-thread tasks and any gap. The columns' quantiles are independent and need not add to the total. Median is the middle pair's mean; p95 is nearest rank (the maximum in each 10-run cell).

On 2026-11-25 UTC there were **180 measured opens** (10 per size, case and viewport), not counting smoke runs or the tracing control. The host was shared; it did not stay at its initial load. These are `loadavg`'s 1/5/15-minute fields at the set boundaries, and the 1-minute range across the before/after samples.

| Set (UTC)                 | Start load         | End load           | Sample 1-min range |
| ------------------------- | ------------------ | ------------------ | -----------------: |
| Desktop 10:13:55–10:18:22 | 3.41 / 2.90 / 2.35 | 5.95 / 4.97 / 3.38 |          3.29–8.24 |
| Phone 10:18:22–10:28:00   | 5.95 / 4.97 / 3.38 | 6.17 / 5.41 / 4.26 |          3.26–6.79 |

Comparisons within a viewport are interleaved; the two viewport sets are not. Treat long tails as observed, not machine-independent latency. The largest 200-entry desktop first-open tail (784 ms) was mostly style/layout (340 ms) and Preact + Markdown (336 ms). The 715 ms repeat started and finished under load 4, so high load alone does not explain that tail.

## Results in milliseconds (median / p95)

**Style/layout** covers style recalculation, layout and pre-paint. **Scroll JS** excludes the style/layout forced by scroll geometry reads (that time is in style/layout). There was no measured math or image decode on the first-frame path. All 180 endpoints were `Paint`, and all 18 retained traces (one per cell) showed a transcript paint in the selected frame.

### Desktop · first open

| Entries |   n | Event → paint | JSON/store |       Preact |     Markdown |  Style/layout |       Paint | Scroll JS |       Other |
| ------- | --: | ------------: | ---------: | -----------: | -----------: | ------------: | ----------: | --------: | ----------: |
| 200     |  10 | 329.8 / 784.1 | 3.5 / 11.6 | 79.1 / 197.2 | 66.5 / 138.3 | 140.6 / 340.1 | 19.0 / 41.5 | 0.4 / 3.8 | 20.7 / 55.1 |
| 2,000   |  10 | 313.8 / 542.0 |  3.6 / 8.6 | 75.1 / 144.6 | 60.2 / 134.6 | 131.8 / 191.5 | 16.8 / 30.7 | 0.4 / 3.6 | 22.1 / 42.5 |
| 10,000  |  10 | 304.3 / 534.2 | 5.0 / 13.2 | 74.5 / 160.4 | 65.3 / 102.8 | 136.5 / 155.0 | 17.7 / 54.9 | 0.4 / 2.0 | 19.2 / 63.4 |

### Desktop · device reopen

| Entries |   n |  Copy → paint | JSON/store |       Preact |     Markdown |  Style/layout |       Paint | Scroll JS |       Other |
| ------- | --: | ------------: | ---------: | -----------: | -----------: | ------------: | ----------: | --------: | ----------: |
| 200     |  10 | 373.7 / 432.9 |  3.0 / 3.9 | 90.5 / 107.2 | 95.4 / 122.6 | 163.1 / 192.8 | 15.7 / 20.6 | 0.2 / 0.4 | 10.2 / 12.1 |
| 2,000   |  10 | 376.8 / 583.7 |  3.4 / 7.1 | 86.6 / 178.1 | 99.5 / 167.8 | 161.4 / 191.4 | 16.3 / 19.2 | 0.1 / 0.2 | 11.0 / 24.6 |
| 10,000  |  10 | 367.8 / 499.9 | 2.7 / 10.6 | 81.6 / 128.9 | 93.7 / 128.4 | 156.6 / 192.2 | 16.1 / 18.1 | 0.2 / 0.2 | 10.7 / 21.5 |

### Desktop · warm switch

| Entries |   n |  Copy → paint | JSON/store |       Preact |  Markdown |  Style/layout |       Paint | Scroll JS |      Other |
| ------- | --: | ------------: | ---------: | -----------: | --------: | ------------: | ----------: | --------: | ---------: |
| 200     |  10 | 204.7 / 276.9 |  0.5 / 3.0 |  35.9 / 62.9 | 0.0 / 0.0 | 143.9 / 205.6 | 17.0 / 24.1 | 0.6 / 9.5 | 4.9 / 11.3 |
| 2,000   |  10 | 231.3 / 326.6 |  0.5 / 0.9 | 38.2 / 110.1 | 0.0 / 0.0 | 163.2 / 191.6 | 16.9 / 20.5 | 5.7 / 9.0 | 5.6 / 14.9 |
| 10,000  |  10 | 218.0 / 255.2 |  0.4 / 2.0 |  41.6 / 48.1 | 0.0 / 0.0 | 155.3 / 184.2 | 17.4 / 19.4 | 0.7 / 9.4 | 6.1 / 11.4 |

### Phone (4×) · first open

| Entries |   n |   Event → paint |  JSON/store |        Preact |      Markdown |  Style/layout |        Paint | Scroll JS |        Other |
| ------- | --: | --------------: | ----------: | ------------: | ------------: | ------------: | -----------: | --------: | -----------: |
| 200     |  10 |  928.8 / 1685.4 | 12.2 / 21.6 | 190.0 / 448.5 | 208.0 / 349.3 | 403.2 / 630.6 | 68.9 / 150.5 | 1.2 / 6.0 |  42.4 / 85.3 |
| 2,000   |  10 | 1088.4 / 1524.6 | 11.4 / 32.1 | 194.0 / 436.7 | 219.9 / 334.3 | 547.0 / 636.2 |  71.7 / 98.2 | 1.6 / 3.9 |  51.2 / 85.9 |
| 10,000  |  10 |  938.3 / 2175.2 | 15.4 / 39.8 | 201.0 / 589.1 | 222.2 / 421.8 | 374.6 / 928.7 |  72.2 / 80.0 | 0.7 / 4.8 | 45.7 / 118.6 |

### Phone (4×) · device reopen

| Entries |   n |    Copy → paint |  JSON/store |        Preact |      Markdown |  Style/layout |       Paint | Scroll JS |       Other |
| ------- | --: | --------------: | ----------: | ------------: | ------------: | ------------: | ----------: | --------: | ----------: |
| 200     |  10 | 1354.1 / 1410.9 | 10.2 / 13.2 | 281.6 / 291.8 | 346.5 / 368.3 | 626.5 / 652.2 | 68.5 / 74.5 | 1.1 / 3.8 | 36.2 / 41.3 |
| 2,000   |  10 | 1428.0 / 1893.9 | 11.4 / 32.6 | 287.6 / 490.5 | 361.0 / 528.1 | 677.2 / 709.3 | 78.4 / 94.8 | 0.8 / 1.6 | 43.8 / 81.6 |
| 10,000  |  10 | 1462.5 / 2182.2 | 11.0 / 28.6 | 281.1 / 528.3 | 362.6 / 623.2 | 658.1 / 813.3 | 71.5 / 96.4 | 0.8 / 1.4 | 38.9 / 91.7 |

### Phone (4×) · warm switch

| Entries |   n |   Copy → paint | JSON/store |       Preact |  Markdown |   Style/layout |        Paint | Scroll JS |       Other |
| ------- | --: | -------------: | ---------: | -----------: | --------: | -------------: | -----------: | --------: | ----------: |
| 200     |  10 |  758.7 / 807.6 |  1.4 / 2.8 | 83.5 / 109.3 | 0.0 / 0.0 |  586.2 / 620.5 |  74.2 / 93.3 | 2.0 / 5.7 | 10.5 / 16.4 |
| 2,000   |  10 | 792.4 / 1775.7 |  2.4 / 7.0 | 91.5 / 271.8 | 0.0 / 0.0 | 602.9 / 1338.3 | 74.1 / 190.9 | 3.1 / 5.1 | 14.9 / 45.3 |
| 10,000  |  10 | 769.2 / 1195.8 |  2.6 / 5.3 | 99.3 / 216.3 | 0.0 / 0.0 |  583.5 / 792.9 | 74.3 / 137.1 | 2.7 / 4.0 | 15.9 / 43.6 |

## What uses the time

- **Fixed work per open.** A no-copy first view for these fixtures carried 135 entries (including tool calls and results); the transcript mounted 60 rows plus the “Show earlier messages” divider. All three fixture sizes draw essentially the same last 20 turns. `web/transcript.js` rebuilds those row DOMs even when `web/ui.js` can reuse all their rendered Markdown. For example, at 10,000 entries a desktop warm switch spends 155 ms in style/layout and 42 ms in Preact, with zero Markdown builds.
- **Scroll reads make layout synchronous.** Trace spans inside `toEnd`, `restorePlace`, `place`, `catchUp` and `anchorOf` separate JavaScript from the engine's work. First opens force a layout mainly in `toEnd`; warm switches do so in bottom placement or saved-place restoration. Pure scroll JS and catch-up are small in these unchanged sessions. On one 2,000-entry desktop warm switch, the trace shows 73 ms of style updates, 105 ms of layout and 13 ms of pre-paint, including a 104 ms layout pass inside scroll placement. These numbers are an example trace, not cell medians; most other desktop examples have shorter layout passes.
- **On a fresh tab the work is not just Markdown parsing.** `web/ui.js` runs Marked, then DOMPurify and post-processing in a detached fragment. Its code-block renderer calls `web/highlight.js` and adds syntax spans and controls. First opens built 20 Markdown answers. A device reopen built 40: one pass before, and one after, a Markdown revision change during extension startup (`web/markdown-ext.js`, `web/extension-ui.js`). The first device `Paint` still beat the first server view by a median 281 ms desktop and 273 ms phone. The browser had more work after it got cached data, but it started earlier; the larger local draw interval is not evidence that the device copy hurts end-to-end time.
- **The whole follow-up arrives before the initial frame.** All 60 no-copy opens got the second, whole-entry update before `Paint`. They ran a median seven traced app renders on desktop and six on phone after first-view receipt. Not all of these renders are caused by the second update. In 59 of 60 warm switches the cached rows painted before the server's first view handler ran.
- **Math and images are late, not blocking the first frame here.** The fixture shows five KaTeX renders and three local images in the mounted window after settling. The first image load event and traced decode were always after `Paint`. Later KaTeX work can change the row heights. The 350 ms post-paint window can miss extension work scheduled later. For the same reason, a two-frame proxy can measure work after the rows have already drawn; its median delay here is 14–71 ms desktop and 61–116 ms phone, depending on the case.

Additional spans, pooled across sizes (**median / p95**, 30 samples per row). These overlap the main tables or are outside their time windows; do not add them to the totals. Highlight is inside sanitize/post-processing. IndexedDB is before cache adoption; KaTeX and decode here cover the next 350 ms after the first frame.

| Viewport / case | First JSON parse | Marked parse | Sanitize + post-process |   Highlight | Layout inside scroll | IndexedDB read | KaTeX after paint | Decode after paint |
| --------------- | ---------------: | -----------: | ----------------------: | ----------: | -------------------: | -------------: | ----------------: | -----------------: |
| Desktop first   |        0.5 / 1.9 |  19.3 / 41.1 |             41.0 / 74.3 | 11.5 / 21.3 |         81.6 / 164.8 |              — |       24.5 / 33.2 |          1.5 / 6.5 |
| Desktop device  |        0.1 / 0.3 |  22.4 / 37.5 |             64.7 / 85.8 | 18.1 / 23.8 |            0.1 / 0.2 |    25.1 / 52.6 |        0.0 / 28.6 |          0.9 / 9.1 |
| Desktop switch  |        0.1 / 0.4 |    0.0 / 0.0 |               0.0 / 0.0 |   0.0 / 0.0 |         80.7 / 105.0 |              — |       13.4 / 29.2 |          0.0 / 1.3 |
| Phone first     |       1.4 / 13.5 | 71.4 / 119.5 |           131.9 / 239.0 | 34.7 / 79.6 |        336.8 / 544.6 |              — |       57.8 / 71.3 |          1.4 / 7.5 |
| Phone device    |        0.2 / 7.4 | 87.8 / 148.4 |           239.6 / 337.2 | 59.7 / 87.4 |        247.4 / 284.0 |   81.2 / 177.1 |         0.0 / 0.0 |         1.9 / 10.0 |
| Phone switch    |        0.1 / 1.2 |    0.0 / 0.0 |               0.0 / 0.0 |   0.0 / 0.0 |        278.0 / 367.4 |              — |       33.3 / 56.6 |          0.0 / 0.1 |

**Tracing control.** A separate 2,000-entry desktop warm switch alternated tracing on/off for 10 pairs, with the same in-page marks, at 1-minute load 5.45–6.22. Copy → DOM was 115/163 ms with tracing and 117/242 ms without it. Copy → the common two-frame proxy was 285/378 ms with tracing and 266/506 ms without. The paired median traced-minus-untraced proxy was +31 ms, with wide variation in both directions. This checks the scale of the wait; it does not provide an exact correction for the paint timings.

## Changes to try, in order

These are **unimplemented estimates**, not A/B measurements. Each uses a share of work in the trace as a budget. They overlap: do not add the savings.

| Rank | What to change                                                                                                                                                                                                                                                                                | Estimated first-frame savings                                                                                                                                                                                                                              | What a person could notice                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Mount the viewport plus a buffer first.** Start near the newest row or saved anchor. Defer offscreen rows' Preact and Markdown until idle or near scroll. Test CSS containment separately; it can reduce style/layout but it does not skip Markdown or DOM creation.                        | **80–160 ms desktop; 250–500 ms throttled phone.** Budget: avoid roughly half the relevant style/layout and some row construction; it helps even with no Markdown misses.                                                                                  | High risk if done as truncation. Keep scrolling, find and jump targets, selection, accessibility, and loading earlier rows working. Reserve heights and adjust them without moving the reader. |
| 2    | **Coalesce first scroll placement with layout.** Read geometry together, write once after the row commit, and avoid forcing layout again from effects plus `ResizeObserver`. Prefer a stable row anchor over measuring the entire column if it can give the same position.                    | **20–50 / 60–150 ms** where scroll forces layout. This budgets only a fraction of the measured geometry work that could be avoided or combined. Moving the same work to another callback is not a gain. Little direct savings for the desktop device path. | The first frame must already be at the saved place or the bottom. Test content growing after image/font loads and catch-up while the reader scrolls.                                           |
| 3    | **Reuse rendered Markdown for unchanged entries across device reopens.** Reuse parsed/rendered parts keyed by content, path/link context, renderer version, and effective extension set. Invalidate only entries affected by a fence/math renderer change rather than rebuilding all answers. | **30–65 / 100–240 ms** on device reopen if one rebuild pass or part of both is eliminated. A warm switch already has zero measured Markdown builds.                                                                                                        | Stale parts could show old links, math, or content. Respect build, access and sign-in changes; keep the current sanitization and live/streaming behavior.                                      |
| 4    | **Keep the whole-entry update out of the first frame if row geometry does not change.** Apply closed tool detail after first paint, or merge its view update without rendering unaffected rows again.                                                                                         | **5–25 / 15–80 ms** on first open: a fraction of the follow-up merge, diff and layout work. Do not delay visible errors, input, or expanded content.                                                                                                       | An immediate click on a tool row must still work. An update that changes row geometry or accessibility text may need different handling.                                                       |
| 5    | **Worker for pure Markdown tokenization or syntax coloring**, only if traces after steps 1–4 still show them on the path. Main-thread sanitization, DOM work and paint remain.                                                                                                                | **10–30 / 30–100 ms** with enough overlap; the sum of parse and highlight times is an upper bound before transfer and scheduling costs. No gain on warm Markdown cache hits.                                                                               | Preserve extension semantics and HTML sanitization. A worker awaited for the first visible answer may make that answer slower.                                                                 |

JSON, IndexedDB and image decode are not the first targets for this workload. Reserve image dimensions and keep math and image enhancements after the first usable frame rather than making the text wait for them.

## Reproduce

From the `perf/draw-measure` checkout with its lockfile dependencies installed, on Linux with sandboxed Chromium and a Node build with native TypeScript stripping:

```sh
systemd-run --user --scope -q --expand-environment=no -p CPUQuota=200% -- \
  taskset -c 0,1 env UV_THREADPOOL_SIZE=2 PI_POCKET_BROWSER=/snap/bin/chromium \
  node --experimental-strip-types scripts/perf/draw-measure.mjs --runs=10
```

Use CPUs available to the process and the local Chromium path. Stdout gives the output JSONL path. By default the private temporary folder contains one gzip-compressed DevTools trace per cell; `--trace=all` retains all traces. `--runs=1` is a smoke run. `--control` runs the paired tracing check, also with `--runs=10` by default. The script stops its server and browser; after saving any wanted data, remove the printed temporary folder. The branch contains only this report and the driver.

### Draw fixes rerun (Stage A)

The table below compares fresh matrices on `opti2`, rather than comparing against the earlier study above. Both use Node v24.15.0, Chromium 157.0.8103.50, CPUs 0–1, the 200% systemd scope, and the same viewports, fixtures, half-restored return cases, and trace endpoint. Each cell is **10 runs, median / p95 milliseconds**. Every measured endpoint was a `Paint`.

| Viewport | Entries | Open   |        baseline |         Stage A |
| -------- | ------: | ------ | --------------: | --------------: |
| Desktop  |     200 | First  |   298.7 / 380.6 |   304.8 / 357.4 |
| Desktop  |     200 | Device |   361.8 / 416.6 |   321.2 / 375.9 |
| Desktop  |     200 | Switch |   211.8 / 286.9 |   211.3 / 266.4 |
| Desktop  |   2,000 | First  |   309.2 / 366.5 |   305.8 / 342.7 |
| Desktop  |   2,000 | Device |   388.3 / 472.6 |   306.1 / 334.3 |
| Desktop  |   2,000 | Switch |   219.5 / 245.0 |   219.2 / 285.0 |
| Desktop  |  10,000 | First  |   263.5 / 330.0 |   293.8 / 398.3 |
| Desktop  |  10,000 | Device |   361.2 / 445.4 |   305.3 / 332.7 |
| Desktop  |  10,000 | Switch |   214.6 / 236.6 |   240.9 / 273.0 |
| Phone    |     200 | First  | 1006.5 / 1129.1 | 1050.5 / 1060.5 |
| Phone    |     200 | Device | 1365.6 / 1466.6 | 1183.5 / 1259.3 |
| Phone    |     200 | Switch |   742.1 / 845.4 |   766.0 / 960.8 |
| Phone    |   2,000 | First  | 1010.6 / 1076.7 |  965.1 / 1100.8 |
| Phone    |   2,000 | Device | 1331.9 / 1414.2 | 1197.2 / 1254.0 |
| Phone    |   2,000 | Switch |   775.6 / 869.2 |   763.5 / 853.0 |
| Phone    |  10,000 | First  |  905.5 / 1039.1 |  993.7 / 1097.2 |
| Phone    |  10,000 | Device | 1328.2 / 1380.3 | 1185.4 / 1325.0 |
| Phone    |  10,000 | Switch |   771.2 / 894.9 |   754.4 / 792.7 |

| Set      | Viewport | UTC               | Start load         | End load           | Sample 1-min range |
| -------- | -------- | ----------------- | ------------------ | ------------------ | -----------------: |
| baseline | Desktop  | 12:35:17–12:39:25 | 2.10 / 1.92 / 1.90 | 5.79 / 3.89 / 2.71 |          2.10–5.60 |
| baseline | Phone    | 12:39:25–12:47:50 | 5.79 / 3.89 / 2.71 | 5.06 / 4.59 / 3.48 |          2.77–6.29 |
| Stage A  | Desktop  | 12:51:41–12:55:45 | 5.03 / 5.20 / 4.01 | 4.81 / 5.31 / 4.36 |          4.59–6.76 |
| Stage A  | Phone    | 12:55:45–13:03:57 | 4.81 / 5.31 / 4.36 | 4.43 / 4.49 / 4.30 |          3.27–5.55 |

- Device reopen built 20 Markdown answers, down from 40, on both viewports. Hello lists extension names but does not register renderers. When a renderer does register, only parts that depend on its fence or math rules are rebuilt. An access change uses a separate cache key.

- In warm switches, median layout inside scroll placement fell from 75.0 ms desktop and 272.0 ms phone to less than 0.1 ms on both. The browser still lays the rows out before paint. At 10,000 entries, warm-switch style/layout was 155.3 → 170.4 ms desktop and 581.6 → 586.3 ms phone. Do not count the moved layout as an equivalent saving in wall time. Desktop ran under higher load in the Stage A matrix, and desktop first-open and switch latency at 10,000 entries did not improve.

- Closed tool output was not in the DOM or either Find before. The tool command remains searchable; opening builds the same body in that draw. The full-entry follow-up still reaches the view, so opening does not wait for a new request except where clipped content already required one.
