# Folder picker performance (2026-11-23, branch perf/picker; not for upstream)

## 1. Why the live server was busy

The live server (pid 2199815, `/home/nohj/pi-pocket/src/server/main.ts`, port 8787) was measured read-only at 11:07–11:11 UTC.

- `top -H`: the main thread was at 88–90 % CPU, with 3.4 GB RSS. Machine load was 7–12 on 6 cores (other jobs: test suites, a Postgres CI, a runner benchmark).
- CPU profile: `kill -USR1`, then the inspector on 127.0.0.1:9229, `Profiler.start/stop` for 31.3 s, then the inspector closed and 9229 verified closed. The profile is `.perf/live-1.cpuprofile` (scripts: `.perf/profile.mjs`, `summarize.mjs`, `stalls.mjs`).

Of the 31.3 s, 15.8 % was idle, so the main thread was busy for 84 %. Total time by owner:

| Total  | What                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 31.4 % | `branchEntries` (drop-in `extensions/billion-context-pi-pocket/identity.mjs:25`). For **every message of the context, on every model request**, it does `JSON.stringify(normalize(message))` plus SHA-256. Self time: anon `identity.mjs:27` 15.4 %, `normalize` 3.7 %, `stripRef` 2.6 %, `crypto Hash.update` 11.9 % |
| 22.4 % | `selectContext` (`billion-context-pi-pocket/selection.mjs:37`), which calls `branchEntries`, `compatibleState` (9.5 %), and `contextInstances` (6.0 %)                                                                                                                                                                |
| 15.2 % | `beforeRequest` (`extensions/billion-context-pi-pocket.ts:322`) → `bridge.prepare`                                                                                                                                                                                                                                    |
| 11.6 % | `stateFor` → `mergeLiveEntries` (billion-context runtime `dist/index.js:13655/13265`), with `messageIdentity` at 6.9 %                                                                                                                                                                                                |
| 11.7 % | `trustedWriter` (drop-in `extensions/firstmate.ts:2034`). It spawns `ps -o ppid= -p <pid>` once per parent hop (up to 32 hops) for **each bridge request**. The synchronous `child_process.spawn` was 3.6 s of the 31 s (spawn self time 13.8 %)                                                                      |
| ~2 %   | Pi Pocket's own code: `compaction.ts:100` 1.6 %, `room.ts:790 push` 0.5 %, model registry merge 0.4 %                                                                                                                                                                                                                 |

Event-loop blocks: 26 busy stretches were longer than 100 ms, and 7 were longer than 500 ms. The longest were 2.9 s (`stateFor`/`selectContext`), 2.2 s (`beforeRequest`), and 2.1 s and 1.4 s (`selectContext`). All of these are drop-in extension code in `~/.pi-pocket/extensions/` (billion-context-pi-pocket, firstmate), not Pi Pocket's `src/`. The cost grows with the size of each conversation's context, and it is paid on every model request of every running session.

What a client saw (`.perf/probe.mjs`, 60 s, GET only):

| Request                     | median  | p95    | max     |
| --------------------------- | ------- | ------ | ------- |
| `GET /api/runners`          | 4.8 ms  | 611 ms | 2092 ms |
| `GET /api/fs?path=~`        | 13.8 ms | 71 ms  | 438 ms  |
| `GET /api/fs?path=<deeper>` | 11.9 ms | 396 ms | 1099 ms |

The SSE stream to an open page was light: 8 events in 60 s (0.13/s), 123 KiB in total, of which 84 KiB was `sessions` and 39 KiB was `hello`. That is about 2 KiB/s, so the stream is not the cause.

Conclusion: the lag spikes on the server (p95 400–600 ms, max 2 s) are event-loop blocks from the two drop-in extensions. They are not caused by the picker's listing, which takes 1–5 ms in the server. Fixes for this belong to those extensions (see "Not done").

## 2. Picker measurement method

- Copy server: `node test/serve.ts 8961 127.0.0.61` from this worktree. A runner "Laptop" was linked on this machine (`runner link` with `PI_POCKET_RUNNER_CONFIG` in a temp folder) through `.perf/delay-proxy.mjs`, a TCP proxy that delays each chunk by 0, 20 or 80 ms each way.
- Test tree: `/var/tmp/picker-perf-tree` with `a/b/c/d`, 30 subfolders, and `big/` with 1500 folders (the server lists 1000).
- `.perf/picker-bench.mjs`: headless Chromium (Playwright build) over CDP. It wraps `fetch` to log every `/api/` request (start, duration). It opens New session and walks `/` → var → tmp → tree → a → b → up → up → big (plus a store change and a row selection) → up → up. It does this on This server, then on Laptop, 1 or 2 rounds each. Time = click to the first animation frame after the new list is in the DOM, plus long-animation-frame entries. CPU ×4 throttling was used for a slow device.
- Each number is from a single run under machine load 7–12, so expect ±30 % noise. Raw JSON is in `.perf/results/` (`b0*` = before, `c1*` = after commit 1, `final-*` = after both commits). Summarize with `python3 .perf/results/sum.py <file>`.

Raw API (curl, 5 runs each): this server 1–5 ms. Linked runner 15–25 ms (big folder 55–130 ms) at 0 delay, 130–180 ms at 20 ms, 490–620 ms at 80 ms (big folder 700–790 ms). A runner listing costs about 3 round trips (`#resolve` → `infoNow`, `absolutePath`, `listDir`, and `realPath` for given folders). With 4–8 listings in parallel at 80 ms, some batches took 2.2–2.9 s instead of 0.55 s: the link sometimes stalls.

### What the numbers showed before

- Every click made exactly 1 request, sequential, with nothing cached: a folder just left was fetched again in full. On a runner, each click cost a full runner round trip (147 ms at 20 ms, 500 ms at 80 ms, 1.8 s for `/`).
- Rendering: a folder of 1000 rows took 165–175 ms to show (511–830 ms at CPU ×4). The profile showed Preact building 1000 rows, each with an SVG icon.
- Every store change (each SSE event: a message, presence) re-rendered all 1000 rows: 10–25 ms, 43–51 ms at ×4. A row selection did the same: 15–19 ms, 78 ms at ×4.

## 3. Fixes

| Commit     | Fix                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d1e3109a` | `web/folder-rows.js`: memoized rows (a row re-renders only when its folder or its selection changes; the list skips store changes). It draws the first 80 rows at once and 150 more after each painted frame. `.fp-row { content-visibility: auto }`                                                                                                                              |
| `c20b749c` | `web/folder-cache.js` + `web/folder-listings.js`: stale-while-revalidate cache per computer, path and hidden flag. Read-ahead runs one request at a time (parent, first 8 children, favorites, the folder under the pointer, other computers' start folders). The start folder of each computer is read ahead once the app is idle. A click joins a read-ahead already on its way |

Cache safety: entries are owned by a scope token. The token changes when `store.state.me` changes (person or rights). For people other than the owner, it also changes when the rules of `runners`/`thisServer` change (online, lastSeen and version are ignored). The cache is also emptied on `pocket:signedOut`. A response that arrives after the person changed is not kept. Nothing is written to disk. The cache holds at most 400 entries, and an entry can show for at most 10 minutes.

### After (click → painted, median per step kind; round 1 = first walk, round 2 = walk again)

| Step                     | Before               | After d1e3109a      | After both                              |
| ------------------------ | -------------------- | ------------------- | --------------------------------------- |
| Big folder (1000 rows)   | 175 ms (×4: 511–830) | 71 ms (×4: 222–332) | 33–60 ms, 28–36 ms again                |
| Store change, big shown  | 10–25 ms (×4: 43–51) | 1 ms (×4: 11–21)    | 1–2 ms                                  |
| Select a row, big shown  | 15–19 ms (×4: 78)    | 13 ms (×4: 60–72)   | 10–20 ms                                |
| This server, into/up     | 28 / 19 ms           | ~same               | 16–25 / 16–25 ms                        |
| Runner 0 ms, into/up     | 32 / 24 ms           | ~same               | 45 / 17 ms first, 15 / 14 ms again      |
| Runner 20 ms, into/up    | 166 / 147 ms         | ~same               | 150 / 16 ms first, **14 / 15 ms again** |
| Runner 80 ms, into/up    | 508 / 503 ms         | ~same               | 560 / 15 ms first, **15 / 16 ms again** |
| Runs on → Laptop (80 ms) | 521 ms               | ~same               | **44 ms** (start folder prefetched)     |
| Runner 80 ms, big again  | 879 ms               | ~same               | **28 ms**                               |

The first visit of a folder that was not prefetched still costs one runner round trip. It is shown at once afterwards.

## 4. Not done and why

- Server-side load: the event-loop blocks come from drop-ins, not from Pi Pocket's code. In `billion-context-pi-pocket`, `branchEntries`/`selectContext` re-hash the whole context per request, so a memo by message identity (WeakMap) would remove most of it. In `firstmate.ts` `trustedWriter`, one `ps` spawn per parent hop could become a single read of `/proc/<pid>/stat` (or one `ps -o pid,ppid -e`). I did not edit these: they are outside this repo and run live.
- Runner link (runner-perf's files, left alone): `Runners.folders` costs about 3 sequential round trips (`#resolve`: `infoNow` + `absolutePath`, then `listDir`, plus one `canonicalPath` + `fileInfo` per symlink entry, sequentially; and `realPath` first for people given folders). A single "list folder" RPC on the runner that resolves, lists and stats the links in one round trip would cut a first visit from about 3 RTT to 1. The parallel-request stall seen (2.2–2.9 s for 4–8 listings at 80 ms) also belongs to runner-perf.
- Server listing `GET /api/fs` uses `readdirSync`/`statSync` on the event loop. It is 1–5 ms here, but it can block on a slow or network disk. I left it alone because the numbers did not show it.
- No caching on the device (IndexedDB): it would need its own clearing at sign-out and per person. Memory is enough for "instant" within a page.
