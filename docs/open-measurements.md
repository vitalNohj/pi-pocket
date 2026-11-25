# Session open measurements

## Lazy projection on `feat/open-read`

At **10,000 entries**, a fresh first view projected **135 bodies instead of 10,000**. The server wrote the first view in **481 → 440 ms** after restart and **284 → 268 ms** after the room expired (medians). With `have` it wrote in **31 → 16 ms**. Shorter sessions and warm opens did not improve consistently.

### Why the storage read did not change

Pi Durable 1.6.0 has `Conversation.entries(query, limit, cursor, context)` for newest-first pages, including `minEntryId` and `maxEntryId`. Those pages return full history records, not active IDs or row metadata without bodies. `watch()` gives a bounded window and docs; `snapshot()` reads a document. Neither provides the full active order, including a compaction marker placed before the entries it keeps. Reading every page would still decode all bodies and would have to reproduce context and fork rules. Keep `conversation.context()` as the source of the active order. Do not read Pi Durable's storage directly.

The room indexes visible IDs and row kinds and keeps its projection cache. `push` and the one-shot `firstView` project bodies after window and `have` selection. `entriesBefore` projects the selected rows, or the whole requested range for Find. Find's separate pre-compaction/reset history route is unchanged. `userMessages` selects a page of people’s inputs, not the whole transcript. Old tabs and stale copies whose order no longer fits can still need the full active view.

### Paired run on opti2

- Same synthetic turns, output sizes, Chromium/CDP paint proxy, loopback Brotli SSE, and timing boundaries as the [original measurements](#original-measurements-on-upstream-8892071f). The before was `d10ab891`; the after was that tree plus the changes to `src/server/room.ts` and `src/server/projection.ts`. The [original harness](https://github.com/vitalNohj/pi-pocket/blob/e5d5e87ad12143e5bf9c6f5d566f6665c4559473/scripts/perf/open-measure.mjs) was adapted to instrument those two copies, count materialized bodies, and use the same seeded store in both. No live data or service was used.
- Node **22.22.1** and Chromium **157.0.8103.50**, server and browser pinned to CPUs 0–1, server and harness in a `CPUQuota=200%` user scope. Before/after pairs ran serially on the same CPUs so they did not compete. Size order rotated and variant order reversed each repeat. There were **10 pairs per size and case, 240 samples**. Each new server start and measured expired open waited for a 1-minute load of at most **5.50**. Load sometimes rose during a sample; the table shows the sampled ranges, not the start gate.
- The restart/warm/`have` set (2026-11-25, 10:24:11–10:33:57 UTC) went from loadavg `3.37 4.49 3.71` to `3.60 4.58 4.30`. The expiry set (10:33:57–10:40:19 UTC) went from `3.60 4.58 4.30` to `3.21 3.28 3.77`. Warm opens were below 30 s; expired opens were at least 31 s after leave and verified to have closed. The measurement directory was removed after its results were copied.

Values are **before → after**, with **median / p95 in ms** on each side. At 10 samples, p95 is the maximum. These are separate medians, not the median of the paired differences.

| Entries | Case               | 1-min load            | Server first view write       | Browser first SSE bytes        | Browser first view bytes       | Rows painted                    |
| ------- | ------------------ | --------------------- | ----------------------------- | ------------------------------ | ------------------------------ | ------------------------------- |
| 200     | Restart            | 3.22–6.03 → 3.06–6.08 | 100.8 / 159.8 → 87.3 / 113.0  | 122.6 / 197.0 → 113.2 / 172.9  | 125.4 / 197.0 → 120.6 / 172.9  | 471.3 / 738.4 → 462.7 / 721.6   |
| 200     | Warm room          | 3.22–6.03 → 3.06–6.08 | 24.0 / 40.8 → 27.5 / 50.5     | 47.5 / 93.2 → 46.0 / 77.5      | 53.1 / 93.2 → 49.9 / 77.5      | 295.1 / 588.5 → 300.9 / 533.1   |
| 200     | Expired room       | 2.38–3.84 → 2.38–3.84 | 51.8 / 68.0 → 44.2 / 112.9    | 57.0 / 90.9 → 59.2 / 104.1     | 61.7 / 90.9 → 60.4 / 119.3     | 254.5 / 314.8 → 265.8 / 349.1   |
| 200     | Switch with `have` | 3.22–6.03 → 3.06–6.08 | 4.6 / 5.6 → 3.7 / 4.9         | 65.8 / 111.2 → 65.0 / 156.6    | 65.8 / 111.2 → 65.0 / 156.6    | 116.4 / 186.1 → 119.5 / 193.6   |
| 2,000   | Restart            | 2.91–6.22 → 3.16–5.81 | 150.5 / 232.4 → 159.2 / 218.1 | 173.3 / 254.7 → 193.2 / 262.5  | 214.1 / 268.5 → 205.7 / 297.4  | 443.0 / 752.0 → 492.3 / 956.0   |
| 2,000   | Warm room          | 2.91–6.22 → 3.16–6.31 | 39.1 / 60.9 → 27.2 / 59.4     | 50.5 / 94.2 → 43.1 / 87.0      | 66.0 / 94.2 → 56.7 / 87.0      | 258.5 / 491.2 → 273.6 / 731.3   |
| 2,000   | Expired room       | 2.18–3.84 → 2.49–3.84 | 97.4 / 207.2 → 123.2 / 187.2  | 101.4 / 142.1 → 97.1 / 130.4   | 104.3 / 219.0 → 145.0 / 194.8  | 356.3 / 413.6 → 341.3 / 386.1   |
| 2,000   | Switch with `have` | 2.91–6.22 → 3.16–5.81 | 7.9 / 13.8 → 6.3 / 9.3        | 61.0 / 126.0 → 65.9 / 171.8    | 61.0 / 126.0 → 65.9 / 171.8    | 95.4 / 177.9 → 95.0 / 235.4     |
| 10,000  | Restart            | 3.10–5.70 → 2.85–5.69 | 480.9 / 927.3 → 439.7 / 627.5 | 578.0 / 937.4 → 657.3 / 1159.3 | 601.4 / 963.4 → 708.9 / 1159.3 | 879.7 / 1337.9 → 987.2 / 1499.8 |
| 10,000  | Warm room          | 3.10–5.70 → 2.85–5.69 | 56.1 / 77.7 → 59.9 / 139.9    | 68.5 / 162.1 → 84.3 / 211.2    | 80.3 / 162.1 → 84.3 / 211.2    | 366.7 / 634.4 → 417.1 / 643.1   |
| 10,000  | Expired room       | 2.49–3.84 → 2.49–4.26 | 284.2 / 323.5 → 267.6 / 297.3 | 268.4 / 330.5 → 256.4 / 287.8  | 301.4 / 349.5 → 282.6 / 315.6  | 507.2 / 583.0 → 471.5 / 530.9   |
| 10,000  | Switch with `have` | 3.10–5.70 → 2.85–5.69 | 31.1 / 50.0 → 16.0 / 29.3     | 90.9 / 145.9 → 76.5 / 158.3    | 90.9 / 145.9 → 76.5 / 158.3    | 119.2 / 203.8 → 103.1 / 224.5   |

### Server work before encoding

The transcript timer now covers the same part of the push on both sides: the eager projection or the row index, order derivation, `have` handling, row selection, and lightening. “Push” includes that stage and the other view fields, but not JSON encoding. These stages measure wall time, not CPU samples.

| Entries | Case               | Read context                      | Prepare transcript             | Push before encode             | Bodies projected in first view |
| ------- | ------------------ | --------------------------------- | ------------------------------ | ------------------------------ | ------------------------------ |
| 200     | Restart            | 6.36 / 12.71 → 6.60 / 10.58       | 5.23 / 13.87 → 4.83 / 8.04     | 6.99 / 16.33 → 7.35 / 11.87    | 200 → 135                      |
| 200     | Warm room          | —                                 | 0.11 / 0.76 → 0.07 / 0.41      | 0.29 / 1.25 → 0.20 / 6.81      | 0 → 0                          |
| 200     | Expired room       | 4.42 / 14.00 → 6.41 / 16.44       | 0.50 / 3.27 → 0.81 / 4.74      | 0.75 / 3.44 → 1.12 / 4.94      | 200 → 135                      |
| 200     | Switch with `have` | —                                 | 0.46 / 1.62 → 0.34 / 0.98      | 0.70 / 1.86 → 0.53 / 1.24      | 0 → 0                          |
| 2,000   | Restart            | 38.53 / 52.20 → 38.95 / 68.05     | 7.69 / 23.40 → 7.53 / 26.93    | 9.59 / 28.03 → 9.28 / 33.02    | 2,000 → 135                    |
| 2,000   | Warm room          | —                                 | 2.67 / 6.42 → 0.31 / 1.49      | 4.48 / 6.82 → 0.80 / 5.95      | 0 → 0                          |
| 2,000   | Expired room       | 37.07 / 56.19 → 38.72 / 43.59     | 2.61 / 8.33 → 1.20 / 4.00      | 2.97 / 8.72 → 1.48 / 4.39      | 2,000 → 135                    |
| 2,000   | Switch with `have` | —                                 | 2.53 / 4.34 → 1.76 / 3.87      | 3.88 / 5.26 → 2.72 / 4.76      | 0 → 0                          |
| 10,000  | Restart            | 218.03 / 341.85 → 205.77 / 427.90 | 58.04 / 157.00 → 19.36 / 41.29 | 64.44 / 173.92 → 22.39 / 49.61 | 10,000 → 135                   |
| 10,000  | Warm room          | —                                 | 4.32 / 7.03 → 4.11 / 6.83      | 10.71 / 15.02 → 7.15 / 11.74   | 0 → 0                          |
| 10,000  | Expired room       | 185.23 / 248.34 → 192.09 / 224.95 | 20.04 / 76.11 → 4.92 / 24.20   | 21.27 / 77.93 → 6.09 / 34.74   | 10,000 → 135                   |
| 10,000  | Switch with `have` | —                                 | 16.02 / 26.44 → 8.17 / 12.75   | 18.84 / 32.16 → 10.32 / 18.80  | 0 → 0                          |

Across all 120 pairs the first and whole-tail frame sizes, first window, kept count, sent count, and light entry count matched. Fresh tabs got 135 entries with 81 whole replacements; switches with `have` got no bodies. Tests separately compare the serialized transcript fields, not just counts or frame sizes.

At 10,000 entries, transcript preparation fell **58.04 → 19.36 ms** after restart and **20.04 → 4.92 ms** on expiry. The paired median changes in server first-write time were **−31.58 ms** and **−26.76 ms**. The full context read remained the largest stage. Browser times varied more: the 10,000-entry restart paint median rose in the unpaired columns (880 → 987 ms), while the paired median paint delta was −39 ms. The 2,000-entry expired-room first write also rose (97 → 123 ms), despite less time preparing the transcript. These samples do not show a consistent end-to-end speedup for all sizes or loads.

## Original measurements on upstream `8892071f`

**Read the transcript tail for display, not the full model context.** At 10,000 entries, `conversation.context()` took 170 ms median after restart and 171 ms after the room expired. Projecting the whole transcript took another 45 ms and 17 ms, respectively. Keeping the room warm avoided the context read and all projection misses. Picking and lightening the last rows was not the bottleneck.

At this revision, [`FIRST_ROWS`](../src/server/projection.ts) is **80**, not 60. `firstEntries` can step back to the start of a turn. In these fixtures, a fresh tab got 135 entry bodies, then 81 unshortened replacements. The first view still sent the whole **order of entry IDs**, not the whole transcript. A `have` switch got zero entry bodies.

### Method

- Opti2, Ubuntu, 6 logical CPUs, Node **22.22.1**, loopback HTTP SSE with Chromium **157.0.8103.50** and its normal Brotli negotiation. The harness and server ran in a `CPUQuota=200%` user scope. Both they and Chromium were pinned to CPUs 0–1; Snap moves Chromium into its own scope, and its processes were checked for the same CPU affinity. No other service or owner data was used.
- The script uses the repo's test app and scripted-model helpers. It creates sessions through the app, then appends synthetic turns through `app.harness.commit` with Pi Durable's entry types. A turn is a user request, an assistant tool call, a file-read result, a bash result, and a summary. The fixtures had **200 / 2,000 / 10,000 active entries**, and **0.50 / 6.51 / 33.06 MB** of serialized entry payloads. They included **2 / 23 / 117** 50 KiB reads and **1 / 17 / 86** 112 KiB bash outputs. Other outputs were smaller. These sessions were not compacted and had no images or custom renderer modules.
- **Restart:** first session request in a fresh server process and from a new Chromium browser context. Store files and Linux page cache were retained. The request starts after readiness; process launch to readiness was 1.56 s median / 1.78 s p95 and is not in the open times.
- **Warm room:** reopen from a fresh browser context about 0.64–0.69 s after leaving (medians), so no device copy or `have` can help. The server retains the room for 30 s. **Closed room:** reopen from a fresh browser context at least 31 s after leaving, in the same server process. The script checked the room-close mark, cache misses, and actual request time (32.6–32.8 s median after leaving).
- **Switch with `have`:** leave and return in the same tab, on its existing SSE stream. The tab retains the last rows and full ID order. The script checked that the browser sent `have`, the server accepted the ID order, and the first view sent zero entry bodies. The page can render its kept rows without waiting for the server.
- There were **10 samples in every size/case**, 120 in total, with size order rotated. Each timed set recorded `/proc/loadavg` before and after, and each sample retained its readings. The restart/warm/switch set (06:31:52–06:34:57 UTC, 2026-11-25) went from `2.46 2.44 2.38` to `6.01 3.95 2.97`. The closed-room set (06:34:59–06:40:43 UTC) went from `6.01 3.95 2.97` to `4.10 3.22 2.89`. Load is machine-wide and did not stay constant. Compare stages before attributing the whole restart/expiry gap to the restart itself.

### From request to first bytes and rows

Values are **median / p95 in ms**. With 10 samples, the nearest-rank p95 is the maximum; do not treat it as a stable tail estimate.

On the server, the clock starts at the HTTP handler and stops at the first `response.write` for the view. On the browser, it starts at the CDP request timestamp. “First SSE bytes” is the first decoded chunk containing the ping or, for a switch, the `switched` reply. “First view bytes” is the first chunk containing the view, which may be the same chunk. CDP is a renderer-side observation, not a packet capture. For a switch, both refer to the existing SSE connection, not the HTTP response to `POST /api/switch`. Paint means two animation frames after the latest assistant row appears in the DOM, not hardware presentation.

| Entries | Case               | n   | 1 min load | Server first view write | Browser first SSE bytes | Browser first view bytes | Rows painted  |
| ------- | ------------------ | --- | ---------- | ----------------------- | ----------------------- | ------------------------ | ------------- |
| 200     | Restart            | 10  | 2.46–5.40  | 76.9 / 143.7            | 88.6 / 129.3            | 93.4 / 176.2             | 450.1 / 502.2 |
| 200     | Warm room          | 10  | 2.82–6.01  | 31.2 / 50.1             | 46.9 / 59.5             | 49.9 / 66.3              | 242.9 / 332.5 |
| 200     | Closed room        | 10  | 1.68–4.44  | 42.5 / 78.2             | 55.0 / 94.5             | 55.9 / 94.5              | 245.2 / 302.8 |
| 200     | Switch with `have` | 10  | 2.46–5.40  | 5.7 / 10.4              | 85.6 / 128.8            | 85.6 / 128.8             | 139.4 / 176.7 |
| 2,000   | Restart            | 10  | 2.82–5.85  | 143.9 / 223.0           | 170.1 / 233.8           | 182.7 / 233.8            | 555.1 / 610.0 |
| 2,000   | Warm room          | 10  | 3.40–5.85  | 38.1 / 53.1             | 48.8 / 68.6             | 55.3 / 68.6              | 250.2 / 294.9 |
| 2,000   | Closed room        | 10  | 1.48–4.44  | 88.0 / 137.1            | 103.7 / 120.6           | 109.3 / 159.8            | 335.2 / 358.9 |
| 2,000   | Switch with `have` | 10  | 3.40–5.85  | 11.0 / 17.8             | 81.3 / 138.4            | 81.3 / 138.4             | 111.0 / 168.1 |
| 10,000  | Restart            | 10  | 3.37–5.49  | 306.9 / 588.4           | 510.5 / 577.0           | 545.9 / 598.4            | 798.8 / 859.3 |
| 10,000  | Warm room          | 10  | 3.37–6.01  | 56.0 / 79.7             | 57.5 / 89.8             | 73.2 / 89.8              | 275.1 / 349.7 |
| 10,000  | Closed room        | 10  | 1.48–4.73  | 260.2 / 329.9           | 258.2 / 284.3           | 284.1 / 352.2            | 468.5 / 537.4 |
| 10,000  | Switch with `have` | 10  | 3.37–6.01  | 42.2 / 52.9             | 103.1 / 130.2           | 103.1 / 130.2            | 144.6 / 167.1 |

The cached switch is not a fresh navigation. At 10,000 entries, it took **151 / 180 ms** from the switch action to the paint proxy and **42 / 53 ms** for the server to write its confirmation view. A warm-room fresh tab still needed a full recent view and its own paint. The browser took a median **193 ms** from the complete first view event to paint on that warm tab (paired difference), outside the timed server work. Do not add that difference to the server budget.

### Server stages

`Room lookup/open` includes the other room columns. Before room entry is `attach` preparing the initial hello, list and PiP; `have` uses the switch path instead. Watch includes reading its initial view. Extra docs includes the room's snapshots (authors, artifacts, notes, and similar state); it does not include that watch read. Read context is wall time for Pi Durable to walk the active range and build the transcript and model-context structures. This run does not split SQLite, JSON decoding, and context derivation inside that call.

| Entries | Case               | Before room entry | Room lookup/open | Conversation lookup | Watch        | Read context    | Extra docs   |
| ------- | ------------------ | ----------------- | ---------------- | ------------------- | ------------ | --------------- | ------------ |
| 200     | Restart            | 7.16 / 9.98       | 13.14 / 23.24    | 0.11 / 0.63         | 3.41 / 7.65  | 4.76 / 8.58     | 1.35 / 3.11  |
| 200     | Warm room          | 6.88 / 11.67      | 0.01 / 0.01      | —                   | —            | —               | —            |
| 200     | Closed room        | 7.26 / 19.30      | 4.65 / 21.33     | 0.04 / 0.06         | 0.80 / 5.77  | 3.03 / 14.89    | 0.63 / 11.43 |
| 200     | Switch with `have` | —                 | 0.18 / 2.31      | —                   | —            | —               | —            |
| 2,000   | Restart            | 6.01 / 14.73      | 46.42 / 58.33    | 0.12 / 0.67         | 2.88 / 17.04 | 35.78 / 43.11   | 1.52 / 6.35  |
| 2,000   | Warm room          | 5.71 / 9.35       | 0.01 / 0.04      | —                   | —            | —               | —            |
| 2,000   | Closed room        | 7.59 / 32.77      | 38.99 / 41.99    | 0.04 / 0.05         | 1.10 / 2.09  | 37.00 / 39.79   | 0.41 / 0.54  |
| 2,000   | Switch with `have` | —                 | 0.18 / 2.48      | —                   | —            | —               | —            |
| 10,000  | Restart            | 7.19 / 10.08      | 179.71 / 248.21  | 0.62 / 4.40         | 2.24 / 7.26  | 169.72 / 233.18 | 2.31 / 3.27  |
| 10,000  | Warm room          | 4.70 / 8.01       | 0.01 / 0.02      | —                   | —            | —               | —            |
| 10,000  | Closed room        | 6.25 / 10.31      | 175.22 / 214.56  | 0.04 / 0.06         | 0.79 / 5.93  | 171.08 / 213.13 | 0.43 / 0.83  |
| 10,000  | Switch with `have` | —                 | 0.52 / 1.00      | —                   | —            | —               | —            |

The projection timer covers `#projectedEntries` and its cache lookups. “µs / scanned entry” divides that timer by the active record count in each sample; within a room, those are hits, not fresh projections. The push timer includes the projection, order bookkeeping, first-row selection, lightening, and field preparation, but not SSE encoding. “Encode → write” starts after the first JSON/SSE frame is encoded. It includes queued Brotli work, other callbacks, and event-loop scheduling, **not just compression CPU**. `response.write` is the synchronous call cost, not delivery to the tab. The timings are nested; independently computed percentiles do not add up.

| Entries | Case               | Push before encode | Projection    | µs / scanned entry | `firstEntries` | `lightEntry` total | JSON / SSE encode | Encode → write wait | `response.write` call |
| ------- | ------------------ | ------------------ | ------------- | ------------------ | -------------- | ------------------ | ----------------- | ------------------- | --------------------- |
| 200     | Restart            | 4.48 / 13.09       | 0.66 / 9.23   | 3.31 / 46.14       | 0.09 / 0.17    | 0.62 / 3.17        | 0.37 / 0.93       | 44.73 / 104.81      | 0.04 / 0.06           |
| 200     | Warm room          | 0.46 / 2.62        | 0.04 / 0.37   | 0.18 / 1.86        | 0.01 / 0.03    | 0.03 / 0.03        | 0.34 / 2.76       | 20.59 / 44.22       | 0.02 / 0.03           |
| 200     | Closed room        | 1.08 / 5.86        | 0.22 / 5.54   | 1.10 / 27.71       | 0.01 / 0.01    | 0.25 / 0.79        | 0.36 / 1.23       | 23.31 / 34.44       | 0.01 / 0.03           |
| 200     | Switch with `have` | 0.62 / 2.47        | 0.04 / 0.06   | 0.21 / 0.31        | 0.02 / 0.02    | 0.00 / 0.00        | 0.02 / 0.28       | 3.06 / 6.01         | 0.03 / 0.05           |
| 2,000   | Restart            | 14.57 / 22.03      | 9.70 / 13.93  | 4.85 / 6.96        | 0.09 / 5.24    | 0.61 / 0.68        | 0.60 / 9.74       | 58.85 / 146.88      | 0.05 / 0.07           |
| 2,000   | Warm room          | 2.82 / 7.51        | 0.30 / 3.70   | 0.15 / 1.85        | 0.01 / 0.02    | 0.03 / 0.03        | 0.53 / 1.54       | 26.98 / 41.29       | 0.02 / 0.03           |
| 2,000   | Closed room        | 2.92 / 5.48        | 2.04 / 4.30   | 1.02 / 2.15        | 0.01 / 0.01    | 0.20 / 0.26        | 0.46 / 4.60       | 34.11 / 83.53       | 0.02 / 0.04           |
| 2,000   | Switch with `have` | 5.72 / 8.15        | 0.23 / 0.29   | 0.11 / 0.14        | 0.02 / 0.02    | 0.00 / 0.00        | 0.07 / 0.08       | 2.21 / 8.72         | 0.02 / 0.04           |
| 10,000  | Restart            | 53.26 / 72.79      | 45.39 / 55.54 | 4.54 / 5.55        | 0.11 / 0.12    | 0.63 / 0.86        | 1.52 / 4.34       | 54.24 / 268.64      | 0.07 / 0.13           |
| 10,000  | Warm room          | 6.80 / 12.68       | 0.63 / 2.89   | 0.06 / 0.29        | 0.02 / 0.03    | 0.03 / 0.04        | 2.65 / 7.33       | 36.73 / 61.28       | 0.04 / 0.08           |
| 10,000  | Closed room        | 26.37 / 65.15      | 16.92 / 53.00 | 1.69 / 5.30        | 0.01 / 0.02    | 0.28 / 0.49        | 1.20 / 13.27      | 38.09 / 120.77      | 0.05 / 1.37           |
| 10,000  | Switch with `have` | 18.57 / 25.43      | 0.68 / 4.06   | 0.07 / 0.41        | 0.02 / 0.04    | 0.00 / 0.00        | 0.37 / 7.21       | 19.22 / 27.51       | 0.02 / 0.05           |

For every new tab, the light frame was **51,398 / 76,633 / 194,146 bytes** before compression at the three sizes (median Brotli bytes **4,588 / 8,542 / 23,170**). The 10,000-entry whole-tail update was **253,325 bytes** before compression, **30,859** compressed. At that size the browser got the complete light event at **554 / 628 ms** after restart, **85 / 131 ms** warm, and **286 / 353 ms** after room expiry. It got the complete whole-tail event at **697 / 775**, **189 / 243**, and **409 / 489 ms**, respectively. “Whole” here is the newest rows with full outputs, not fetched earlier history.

At 10,000 entries and with `have`, there were still 10,000 cached projection lookups, **9.8 / 13.9 ms** in `#kept` (validating the order prefix and marking kept entries), and **93,356** uncompressed first-view bytes. The frame still included authors and other fields; on the already primed Brotli stream it compressed to **59** bytes median. Shrinking the frame can reduce server and browser work, but would not save 93 KB on that connection.

### What to change, ranked by measured time available

1. **Read a display window and a small active-order index, not model context, to open the room.** [`Room.#open`](../src/server/room.ts) already gets a watch window, then reads `conversation.context()` again. In Pi Durable 1.6.0, this captures head/tail, scans active records in pages, decodes payloads and derives model context, although the room only takes `entries`. Read just IDs and row-selection metadata for the order, and bodies for the newest complete turns. Fetch earlier bodies only when requested. Preserve head/compaction rules, fork visibility, and watch replay of concurrent appends. **Budget: ~170 ms median (213–233 ms p95)** on a 10,000-entry restarted or expired open, before the cost of the smaller queries; **~36–37 ms median** at 2,000. A persisted order/tail snapshot can help after restart if indexed reads are still costly. Key it by durable revision and rebuild it when stale.
2. **Project the tail first; project earlier entries on demand.** `#projectedEntries` builds all projections on a cache miss before `firstEntries` chooses the window. Separate cheap visibility and row classification from projection, including kinds contributed by presentations. At 10,000 entries, only 135 of 10,000 needed bodies, so the budget for not projecting the rest is **~45 ms median after restart, ~17 ms after expiry**; on a warm room, the entire cached scan was already **0.63 ms** median. If needed, keep a size-bounded projection cache across room closes, keyed by immutable entry and presentation/attribution revision. A disk cache of every full projection would duplicate tool output; prefer a compact order and tail snapshot first. Do not count the same saved work again if a persisted snapshot supplies both the order and projections.
3. **Reuse the order proof for `have` and send only the changed fields.** Cache the order and current prefix proof with the room or snapshot, and use a kept range rather than inserting every kept ID. Keep build and visibility checks and fall back when a prefix no longer matches. **Budget: up to ~10 ms median** in `#kept` alone at 10,000 entries. Order bookkeeping and large unchanged fields can be reduced too. These changes will not directly speed up paint of rows that the tab already has.
4. **Flush the light view before preparing the whole-tail update.** `setImmediate` does not wait for the asynchronous Brotli stream to write. At 10,000 entries, whole-update preparation overlapped the light view's encode-to-write wait by **9.9 ms median after restart, 9.3 ms warm, and 4.1 ms after expiry**. That is the observed overlap, not a guaranteed gain. A flush barrier and sending only the partial entries are worth testing. The full wait was **37–54 ms median** on these fresh-tab paths and highly variable. Compare compression and scheduling separately before attributing that larger budget to Brotli or switching it off.
5. **Do not tune row selection or the socket call first.** At 10,000 entries, `firstEntries` was at most **0.11 ms median**, lightening **0.63 ms**, first-frame JSON/SSE encode **1.2–2.7 ms** for fresh tabs, and the synchronous write **≤0.07 ms**. Deferring nonessential docs or reusing a stats summary is a small follow-up (extra docs **0.4–2.3 ms**, stats about **0.2–1.3 ms** median for uncached 10,000-entry opens). Keep access checks and the fields the light rows need on the first path.

These are budgets from timing marks, not measured speedups. Read and projection budgets concern different stages, but moving work can change the compressed stream and its scheduling. Smaller server work also does not remove browser layout and paint time.

### Reproduce

In a throwaway checkout of `perf/open-measure`, install its pinned dependencies and use a working Chromium found by the repo's browser helper (or set `PI_POCKET_BROWSER`). The script archives exactly `8892071f`, links the checkout's dependencies, and inserts timing marks **only in the archive copy**. It uses an ephemeral loopback port and a temporary empty data folder. Give it a private `TMPDIR` under the throwaway checkout and substitute two allowed CPUs if needed:

```sh
mkdir -p .measure-tmp
systemd-run --user --scope -q --expand-environment=no -p CPUQuota=200% -- \
    taskset -c 0,1 env TMPDIR="$PWD/.measure-tmp" UV_THREADPOOL_SIZE=2 \
    node --experimental-strip-types scripts/perf/open-measure.mjs --runs=10
```

The printed `open.jsonl` is the per-sample record, including load, sizes, cache miss counts, and phase timings. `--runs=1` is a smoke check, not an estimate of p95. Remove the printed workspace when done; do not point it at real session data.
