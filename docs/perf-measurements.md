# Runner and web performance on the owner's tailnet

**23 November 2026 · measurement branch only, not for the upstream PR.** This is the baseline for `62ded5ed` (the upstream runner branch) with diagnostic marks from `23188e86`. No performance changes were applied. The Windows setup is `be8c9625`.

**Main finding:** The Mac and Windows runner pings had medians of **1.6 ms and 1.7 ms**. The long waits were work done on either end, or dependent requests repeated many times. The largest runner-specific problem was the Windows context scan: **674 / 989 ms for 161 RPCs**, despite up to 80 in flight. The fork sheet and saved-session opens did not wait for runner RPCs on their critical path.

## Method

- One isolated copy of `node test/serve.ts 8898 100.102.233.84`. The signed-in headless Chromium 153.0.8010.12 ran on the Linux server itself at 1440×960. Only **browser-to-copy** traffic stayed local in every case. **Mac** is Macbook-perf (macOS ARM64) and **Win** is Monolith-perf (Windows x86-64), over the real tailnet. **Loop** is Loopback-perf (Linux x86-64) on the same machine as the copy; it still uses the runner protocol, gate, and daemon. **Server** runs natively without a linked runner. Do not interpret this as a benchmark of a browser on the Mac or Windows PC.
- The fixtures use the copy's scripted model. Seeded 20, 500, and 5,000 dialogue entries, with distinct text suffixes so they are not all duplicate bytes. Forked each history to each runner's Git fixture. Fork metadata can add one entry. Native and loopback use the same Linux fixture. Each folder has two child directories, one directory alias, a small text file, a 51,200-byte text file, and committed Git state. Switching computers lists the computer's **home**, not this fixture; actual home contents differ. Context scans also see the normal per-user skill locations on each computer; these were not made identical.
- **20 samples per host, size and cache state** (480 opens); **20 per host per sheet action** (400 samples). Rotated the order. Cold means a fresh browser context with no device/IndexedDB copy, **not** a restarted server or empty OS caches. Warm means the device copy was saved after leaving the session; then the page reloaded, so no in-memory view survived. Most opens were also session-to-session switches. The harness dispatched a click using the session row's `navigate` handler, and used the real sheet actions and folder buttons.
- First rows, intact recent tail, and full history are separate `window.__pocketPerf` marks. A paint mark uses two `requestAnimationFrame` callbacks: an upper bound for presentation, not a compositor trace. The app does not fetch all older rows on a normal open. The harness invoked `loadEarlier()` after the intact tail, as Find does, then checked that all entries were present. That interval includes the harness handoff, the history response, merge, and paint; **full history means loaded, not 5,000 DOM rows painted**. `session.view` is the browser's confirmed-view mark; the server measures request to first SSE write/compressor flush, not receipt at the browser.
- **12 complete rounds** of tools and panels (432 samples). Each action used the app route in the signed-in page, a fresh tool session in its fixture each round, and real `read`, `edit`, `write`, and `bash` execution triggered by the scripted model. The large command writes 131,584 bytes. Timings start at tool invocation; they omit thinking/completion and stop the scripted reply after large tool results. For non-streaming tools, the first output is the completed result. For Files and Changes, the recorded wall interval ends after the response and two frame callbacks; the file index is an HTTP fetch, not a paint. A later tool round timed out waiting for an edit; excluded the incomplete round and did not treat the timeout as a completed sample.
- **20 bursts per host at each of 1, 4 and 8 simultaneous listings** (240 bursts, 1,040 HTTP requests). Each burst is separate. Identical reads within a burst were not cached by the harness. Began the next burst only after all responses in the current burst finished. Matched the spans in send order by host and verified their counts and timestamps.
- Server and runners recorded JSONL with `PI_POCKET_PERF=1` and `PI_POCKET_PERF_FILE`. Joined **all 21,406** server request records to runner records on link session, frame ID, and operation. Bytes are the size of the instrumented runner frames, including control metadata and stream events where applicable; they are not packet capture totals. SSE sizes are JSON and observed compressed bytes at the flush boundary, not TCP sizes. Pings probe the runner WebSocket, including dispatch delay at both ends. Use within-process monotonic durations, never subtract the Mac or Win wall clock from the server clock to infer one-way delay. A clock-offset estimate was used only to select nearby ping samples. No simulated network delay.
- Report dates and times are UTC. Unless noted, all times in tables are **median / p95 in ms**; p95 is the nearest rank. At n=12 it is the maximum. Rows, operations, and lanes overlap; their percentiles do not add. This is a shared host with two-CPU quotas for the copy, loopback runner and benchmark scopes. Chromium and local commands contend with the copy. There was no exclusive-host run, no live-server profiling, and no measurement of the instrumentation's observer effect with the marks off.

## Where the time went

Ranked by the representative **measured median** on the affected path. The ranking compares different workload steps, not summed savings or estimates of how often a user hits each step.

| Rank | Waiting point                                      | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Windows context discovery                          | **674 / 989 ms** cold. 161 RPCs; usually 80 in flight. Windows falls back to walking candidates and reading files, unlike the one-exec POSIX scan. The per-session gate wait on this Windows scan was **59 / 385 ms** per RPC; gate work itself was **4.5 / 8.9 ms**. More parallel requests alone do not fix this.                                                                   |
| 2    | Large Bash command on the shared Linux host        | **219 / 381 ms** natively, **211 / 323 ms** over loopback; first output took **212 / 372** and **202 / 293 ms** respectively. Most time passed before output. Loopback daemon time was **209 / 321 ms**. Mac total was **46 / 77 ms**. This locates the wait before/in command execution on Linux, not in runner payload transfer. It does not isolate shell startup from scheduling. |
| 3    | Git and path work for Changes                      | Native handler **195 / 360 ms**; Win **137 / 165**, Mac **59 / 66**. Linked sessions have 6 execs plus 4 path RPCs. Repository lookup gates parallel Git queries; per-file stats and untracked counts follow. Individual Windows Changes execs spent **43 / 56 ms** in the daemon.                                                                                                    |
| 4    | Fetching and using older history                   | On the 5,000-entry history, intact tail → full history was **162 / 298 ms** cold and **187 / 309 ms** warm across hosts. The extra HTTP handler took **52 / 113** and **37 / 95 ms**. The rest includes client and harness time. There was no runner wait for the history body.                                                                                                       |
| 5    | Browser work and paint after a cold confirmed view | Confirmed view → first rows was **131 / 332 ms** (240 opens). View mark → row DOM mark was **67 / 181 ms**; DOM mark → paint probe **57 / 160 ms**. This includes frame scheduling, not just rendering CPU. A fast runner cannot remove it.                                                                                                                                           |
| 6    | Fork sheet mount, fetch, and paint                 | Native **97 / 181 ms**, Mac **92 / 164 ms**. One `copy-place` GET, **0 runner RPCs**. Handler **0.28 / 2.8** and **0.26 / 1.1 ms**; browser request → headers **6 / 104** and **8.5 / 36 ms**. All four row marks came together. Most median time was outside the handler.                                                                                                            |
| 7    | Native server work before the first cold view send | **79 / 269 ms** across sizes, vs **5.5–6.2 ms** median for the 3 linked paths; native click → confirmed view **143 / 384 ms**. The server owns room setup, projection, and SSE flush. The marks do not apportion the full difference among those steps.                                                                                                                               |
| 8    | Remote edit read/modify/write dependency           | Win **58 / 69 ms**, Mac **16 / 30 ms**. 13 RPCs; eight `pread`s already overlap. The open, data-dependent edit, and write cannot be reordered to remove the rest of the chain.                                                                                                                                                                                                        |
| 9    | Folder link resolution in Windows home             | Switch-computer handler **49 / 81 ms**, **91 / 164 ms** through paint. 23 RPCs: directory open/read/close and 10 sequential `realpath` → `lstat` pairs. The isolated fixture with one alias needed five RPCs, so directory contents matter.                                                                                                                                           |
| 10   | The 50 KiB read misses the one-RPC fast path       | Win **45 / 67 ms**, Mac **25 / 33 ms**, versus Win **4.3 / 20** and Mac **3.5 / 5.0 ms** for the small snapshot. Ten serial RPCs, including the unsuccessful snapshot attempt and the follow-on open/stat/line scan/read/close work.                                                                                                                                                  |

## Open and switch a session

| Host   | Size   | Cache       | n   | First rows | Intact tail | Full history | Server first SSE | Entries / light | SSE JSON → compressed (B) | Extra history HTTP |
| ------ | ------ | ----------- | --- | ---------- | ----------- | ------------ | ---------------- | --------------- | ------------------------- | ------------------ |
| Server | small  | cold        | 20  | 223 / 662  | 223 / 662   | 223 / 662    | 48.1 / 169       | 20.0 / 0.00     | 9301 → 1128               | 0                  |
| Server | medium | cold        | 20  | 328 / 455  | 328 / 455   | 429 / 560    | 87.3 / 269       | 82.0 / 0.00     | 37230 → 3127              | 1                  |
| Server | large  | cold        | 20  | 296 / 497  | 296 / 498   | 448 / 751    | 76.2 / 200       | 82.0 / 0.00     | 59973 → 13061             | 1                  |
| Mac    | small  | cold        | 20  | 159 / 357  | 159 / 357   | 159 / 357    | 2.2 / 9.0        | 21.0 / 0.00     | 9836 → 1217               | 0                  |
| Mac    | medium | cold        | 20  | 191 / 457  | 191 / 457   | 333 / 636    | 5.5 / 31.2       | 81.0 / 0.00     | 36980 → 3270              | 1                  |
| Mac    | large  | cold        | 20  | 193 / 595  | 193 / 595   | 388 / 775    | 15.2 / 255       | 81.0 / 0.00     | 59721 → 13227             | 1                  |
| Loop   | small  | cold        | 20  | 152 / 256  | 152 / 256   | 152 / 256    | 3.5 / 26.0       | 21.0 / 0.00     | 9712 → 1229               | 0                  |
| Loop   | medium | cold        | 20  | 204 / 431  | 204 / 431   | 336 / 800    | 5.5 / 18.4       | 81.0 / 0.00     | 36856 → 3221              | 1                  |
| Loop   | large  | cold        | 20  | 230 / 438  | 230 / 438   | 434 / 682    | 9.7 / 154        | 81.0 / 0.00     | 59597 → 13163             | 1                  |
| Win    | small  | cold        | 20  | 128 / 305  | 128 / 305   | 128 / 305    | 1.7 / 11.0       | 21.0 / 0.00     | 9790 → 1220               | 0                  |
| Win    | medium | cold        | 20  | 216 / 338  | 216 / 338   | 345 / 530    | 5.5 / 22.0       | 81.0 / 0.00     | 36934 → 3273              | 1                  |
| Win    | large  | cold        | 20  | 252 / 454  | 252 / 454   | 412 / 723    | 7.4 / 59.7       | 81.0 / 0.00     | 59675 → 13220             | 1                  |
| Server | small  | warm-device | 20  | 106 / 218  | 106 / 218   | 106 / 218    | 7.0 / 285        | 0.00 / 0.00     | 900 → 52                  | 0                  |
| Server | medium | warm-device | 20  | 136 / 359  | 136 / 359   | 136 / 361    | 17.5 / 252       | 0.00 / 0.00     | 903 → 31                  | 0                  |
| Server | large  | warm-device | 20  | 174 / 328  | 174 / 328   | 375 / 624    | 7.4 / 156        | 0.00 / 0.00     | 903 → 29                  | 1                  |
| Mac    | small  | warm-device | 20  | 92.9 / 242 | 94.7 / 242  | 94.7 / 242   | 1.9 / 7.9        | 0.00 / 0.00     | 1157 → 70                 | 0                  |
| Mac    | medium | warm-device | 20  | 146 / 289  | 146 / 289   | 146 / 289    | 1.5 / 18.8       | 0.00 / 0.00     | 1160 → 44                 | 0                  |
| Mac    | large  | warm-device | 20  | 186 / 341  | 186 / 341   | 314 / 632    | 4.6 / 14.7       | 0.00 / 0.00     | 1161 → 41                 | 1                  |
| Loop   | small  | warm-device | 20  | 117 / 183  | 117 / 183   | 117 / 183    | 1.8 / 9.6        | 0.00 / 0.00     | 1081 → 50                 | 0                  |
| Loop   | medium | warm-device | 20  | 183 / 303  | 183 / 303   | 183 / 303    | 2.2 / 14.9       | 0.00 / 0.00     | 1084 → 41                 | 0                  |
| Loop   | large  | warm-device | 20  | 150 / 308  | 151 / 308   | 314 / 507    | 4.9 / 17.1       | 0.00 / 0.00     | 1085 → 43                 | 1                  |
| Win    | small  | warm-device | 20  | 95.3 / 169 | 95.3 / 169  | 95.3 / 169   | 1.6 / 5.1        | 0.00 / 0.00     | 1137 → 50                 | 0                  |
| Win    | medium | warm-device | 20  | 135 / 248  | 135 / 248   | 135 / 248    | 1.7 / 5.8        | 0.00 / 0.00     | 1140 → 43                 | 0                  |
| Win    | large  | warm-device | 20  | 182 / 371  | 182 / 371   | 389 / 523    | 3.6 / 19.1       | 0.00 / 0.00     | 1141 → 43                 | 1                  |

- For cold rows, the confirmed SSE view gated the first paint in **240/240** opens. In **240/240** warm opens the first rows came from the kept device view, not a wait for the server's current entries. The warm first SSE normally sent **0 entries** as a confirmation/delta of the kept view; it was not an empty transcript. The previous-view switch subset was 220 visits in each state: click → first rows **201 / 438 ms cold**, **132 / 272 ms warm**. Confirmed-view marks were **64 / 266** and **104 / 282 ms** in those same subsets, independent of the cache paint.
- One `POST /api/switch` and one view on the existing SSE stream in every sample. The tab also started `/changes`, `/files`, and `/trust` reads; occasionally `/running/board` ran during the window. Those are side work, not a prerequisite to display the selected transcript. Their runner work overlaps room/background work. `/context` was one extra fetch for a cold medium, cold large, or warm large history, and zero for the other cases. Cold medium tail → full was **105 / 262 ms**, with a **4 / 24 ms** handler. `firstEntries` and the kept-view path did not send light entries in this fixture's first views; do not infer that real long tool histories never do.
- All transcript storage and history projection are on the server, including for remote sessions. The first-view path does not need to fetch the saved transcript from the runner. Large-history costs here are not model time or a runner bandwidth test. See [room projection and history](../src/server/room.ts), [SSE](../src/server/http/events.ts), and [device cache](../web/session-cache.js).

## Fork sheet and folder picker

| Action          | Host   | n   | Paint       | HTTP handler | RPCs/handler median (min–max) | Most frequent RPC mix                          |
| --------------- | ------ | --- | ----------- | ------------ | ----------------------------- | ---------------------------------------------- |
| fork            | Server | 20  | 97.4 / 181  | 0.28 / 2.8   | 0.00 (0–0)                    | none                                           |
| folder-open     | Server | 20  | 112 / 263   | 0.55 / 1.3   | 0.00 (0–0)                    | none                                           |
| folder-into     | Server | 20  | 34.1 / 50.4 | 0.44 / 5.6   | 0.00 (0–0)                    | none                                           |
| folder-up       | Server | 20  | 41.5 / 54.1 | 0.47 / 1.6   | 0.00 (0–0)                    | none                                           |
| switch-computer | Server | 20  | 41.5 / 86.3 | 0.49 / 1.5   | 0.00 (0–0)                    | none                                           |
| fork            | Mac    | 20  | 92.1 / 164  | 0.26 / 1.1   | 0.00 (0–0)                    | none                                           |
| folder-open     | Mac    | 20  | 113 / 196   | 14.0 / 83.6  | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| folder-into     | Mac    | 20  | 39.1 / 75.9 | 7.2 / 25.0   | 3.0 (3–3)                     | close, opendir, readdir                        |
| folder-up       | Mac    | 20  | 42.6 / 59.4 | 11.2 / 26.9  | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| switch-computer | Mac    | 20  | 53.2 / 133  | 18.6 / 44.4  | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| fork            | Loop   | 20  | 80.3 / 150  | 0.26 / 4.4   | 0.00 (0–0)                    | none                                           |
| folder-open     | Loop   | 20  | 110 / 253   | 9.8 / 28.7   | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| folder-into     | Loop   | 20  | 40.2 / 62.6 | 4.2 / 13.4   | 3.0 (3–3)                     | close, opendir, readdir                        |
| folder-up       | Loop   | 20  | 42.8 / 71.6 | 10.5 / 21.1  | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| switch-computer | Loop   | 20  | 84.2 / 199  | 16.6 / 79.9  | 3.0 (3–3)                     | close, opendir, readdir                        |
| fork            | Win    | 20  | 77.0 / 168  | 0.32 / 4.0   | 0.00 (0–0)                    | none                                           |
| folder-open     | Win    | 20  | 104 / 206   | 13.0 / 42.0  | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| folder-into     | Win    | 20  | 39.5 / 51.5 | 6.9 / 17.5   | 3.0 (3–3)                     | close, opendir, readdir                        |
| folder-up       | Win    | 20  | 43.1 / 52.1 | 10.2 / 20.3  | 5.0 (5–5)                     | close, lstat, opendir, readdir, realpath       |
| switch-computer | Win    | 20  | 90.7 / 164  | 49.2 / 80.7  | 23.0 (23–23)                  | close, lstat×10, opendir, readdir, realpath×10 |

- Every fork open issued **one** `GET /api/c/:id/copy-place`. Computer/model/folder/worktree marks were within the same frame; their medians were the reported sheet median to within 0.1 ms. On a runner, worktree controls resolve to **not offered**, not a remote Git lookup. The measured case was opening the sheet, not submitting a fork or selecting a new place. `copy-place` already uses server metadata; see [route](../src/server/http/conversation-routes.ts) and [sheet](../web/sheets/copy.js).
- Each picker action issued **one** folder-list HTTP request. `opendir` → `readdir` → `close` is a handle dependency. The current [server runner folder listing](../src/server/runners.ts) then awaits each visible alias's `realpath` → `lstat` in order. Completing alias A is not a prerequisite for alias B. The fixture's `child` has no alias; its parent has one. See [folder picker](../web/sheets/folder.js).

## Pi tools, Files, and Changes

| Action      | Host   | n   | First tool output | Total / panel | HTTP handler | RPCs median (min–max) | Most frequent RPC mix                                                 | Bytes to runner / from runner median |
| ----------- | ------ | --- | ----------------- | ------------- | ------------ | --------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| read-small  | Server | 12  | 2.2 / 21.9        | 2.2 / 21.9    | —            | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| read-50KiB  | Server | 12  | 2.2 / 18.3        | 2.2 / 18.3    | —            | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| edit        | Server | 12  | 3.3 / 49.8        | 3.3 / 49.8    | —            | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| write       | Server | 12  | 1.2 / 17.0        | 1.2 / 17.0    | —            | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| bash-echo   | Server | 12  | 13.5 / 36.7       | 15.9 / 48.5   | —            | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| bash-output | Server | 12  | 212 / 372         | 219 / 381     | —            | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| files-tree  | Server | 12  | —                 | 66.0 / 200    | — / —        | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| file-index  | Server | 12  | —                 | 12.0 / 27.0   | 0.30 / 15.4  | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| changes     | Server | 12  | —                 | 293 / 485     | 195 / 360    | 0.00 (0–0)            | none                                                                  | 0 / 0                                |
| read-small  | Mac    | 12  | 3.5 / 5.0         | 3.5 / 5.0     | —            | 1.0 (1–1)             | pocket-read-snapshot                                                  | 324 / 86                             |
| read-50KiB  | Mac    | 12  | 25.4 / 32.6       | 25.3 / 32.6   | —            | 10.0 (10–10)          | close, fstat×2, lstat, open, pocket-read-snapshot, pread×3, scanLines | 2566 / 52007                         |
| edit        | Mac    | 12  | 16.0 / 29.6       | 16.0 / 29.6   | —            | 13.0 (13–13)          | close, lstat, open, pread×8, realpath, write                          | 3451 / 579                           |
| write       | Mac    | 12  | 4.6 / 6.8         | 4.6 / 6.8     | —            | 2.0 (2–2)             | realpath, write                                                       | 679 / 140                            |
| bash-echo   | Mac    | 12  | 6.1 / 21.1        | 6.7 / 21.5    | —            | 1.0 (1–1)             | exec                                                                  | 488 / 87                             |
| bash-output | Mac    | 12  | 41.3 / 60.2       | 46.2 / 76.6   | —            | 1.0 (1–1)             | exec                                                                  | 561 / 131868                         |
| files-tree  | Mac    | 12  | —                 | 69.0 / 116    | — / —        | 4.0 (4–14)            | close, open, opendir, readdir                                         | 1063 / 1472                          |
| file-index  | Mac    | 12  | —                 | 27.0 / 76.0   | 17.1 / 63.3  | 1.0 (0–1)             | exec                                                                  | 509 / 139                            |
| changes     | Mac    | 12  | —                 | 144 / 267     | 59.1 / 66.1  | 10.0 (10–10)          | exec×6, lstat×2, realpath×2                                           | 4394 / 1174                          |
| read-small  | Loop   | 12  | 2.8 / 5.7         | 2.7 / 5.7     | —            | 1.0 (1–1)             | pocket-read-snapshot                                                  | 244 / 86                             |
| read-50KiB  | Loop   | 12  | 23.3 / 32.5       | 23.3 / 32.5   | —            | 10.0 (10–10)          | close, fstat×2, lstat, open, pocket-read-snapshot, pread×3, scanLines | 2046 / 51991                         |
| edit        | Loop   | 12  | 24.0 / 53.5       | 24.0 / 53.5   | —            | 13.0 (13–13)          | close, lstat, open, pread×8, realpath, write                          | 2771 / 531                           |
| write       | Loop   | 12  | 5.6 / 48.2        | 5.6 / 48.2    | —            | 2.0 (2–2)             | realpath, write                                                       | 519 / 100                            |
| bash-echo   | Loop   | 12  | 7.3 / 45.5        | 8.6 / 45.9    | —            | 1.0 (1–1)             | exec                                                                  | 408 / 87                             |
| bash-output | Loop   | 12  | 202 / 293         | 211 / 323     | —            | 1.0 (1–1)             | exec                                                                  | 481 / 131834                         |
| files-tree  | Loop   | 12  | —                 | 58.5 / 89.0   | — / —        | 4.0 (4–4)             | close, open, opendir, readdir                                         | 823 / 1238                           |
| file-index  | Loop   | 12  | —                 | 22.5 / 47.0   | 8.0 / 23.3   | 1.0 (1–1)             | exec                                                                  | 429 / 139                            |
| changes     | Loop   | 12  | —                 | 158 / 337     | 69.7 / 200   | 10.0 (10–10)          | exec×6, lstat×2, realpath×2                                           | 3594 / 1048                          |
| read-small  | Win    | 12  | 4.3 / 20.4        | 4.3 / 20.4    | —            | 1.0 (1–1)             | pocket-read-snapshot                                                  | 301 / 86                             |
| read-50KiB  | Win    | 12  | 44.6 / 67.0       | 44.6 / 67.0   | —            | 10.0 (10–10)          | close, fstat×2, lstat, open, pocket-read-snapshot, pread×3, scanLines | 2420 / 52016                         |
| edit        | Win    | 12  | 57.8 / 69.2       | 57.7 / 69.2   | —            | 13.0 (13–13)          | close, lstat, open, pread×8, realpath, write                          | 3260 / 573                           |
| write       | Win    | 12  | 4.9 / 7.6         | 4.9 / 7.6     | —            | 2.0 (2–2)             | realpath, write                                                       | 633 / 129                            |
| bash-echo   | Win    | 12  | 34.8 / 39.3       | 37.6 / 41.9   | —            | 1.0 (1–1)             | exec                                                                  | 464 / 87                             |
| bash-output | Win    | 12  | 61.8 / 71.2       | 68.6 / 82.4   | —            | 1.0 (1–1)             | exec                                                                  | 537 / 131858                         |
| files-tree  | Win    | 12  | —                 | 65.0 / 104    | — / —        | 4.0 (4–4)             | close, open, opendir, readdir                                         | 993 / 1476                           |
| file-index  | Win    | 12  | —                 | 55.0 / 58.0   | 41.6 / 44.3  | 1.0 (1–1)             | exec                                                                  | 485 / 133                            |
| changes     | Win    | 12  | —                 | 200 / 244     | 137 / 165    | 10.0 (10–10)          | exec×6, lstat×2, realpath×2                                           | 4158 / 1445                          |

- Each isolated tool sample was one submit HTTP request and streamed output/results on the existing SSE stream. The harness abort after the read-50KiB and bash-output did not gate tool completion. The read first-output and total marks can differ by a fraction of a millisecond when there is no streamed output. The small read uses `pocket-read-snapshot`; the 50 KiB case tries that fast path, then uses the dependent handle/line path. Mode for peak RPCs in flight: **1** for reads, write, and bash; **8** for edit. File writes follow permission/path checks. The large output passed in one `exec` with output frames; at most about 132 kB was returned, which did not saturate the runner outbox.
- Each Files tree, file index, and Changes action had **one** browser HTTP request (`/view`, `/files`, and `/changes`). Files tree is the root directory view. Browser request → headers for `/view` was Server **17.5 / 53**, Mac **20 / 32**, Loop **16.5 / 24**, Win **16.5 / 46 ms**. It has no dedicated handler span in this instrumentation. Tree RPC attribution uses host and a short time window; occasional extra RPCs (Mac max 14) can be concurrent room work. The usual linked tree count is **4**, versus **0** natively. The index commonly uses one Git `exec`; it can reuse a result. Windows index exec spent **38 / 40 ms** in the daemon.
- Changes reads transcript edit facts and resolves the workspace independently. Once the repo is known it already overlaps branch, HEAD, status, and numstat probes. Counts for untracked files depend on the listing and only follow file info. Peak observed in-flight RPCs had mode **6** on every runner. Use [changes computation](../src/server/changes.ts) and [file index](../src/server/files.ts) as the dependency map; counting the 10 RPCs as 10 sequential network trips would be wrong.

## Folder bursts, link, and context

| Host   | Parallel | n   | Burst wall  | Individual HTTP | RPCs per burst median (min–max) | Max RPCs in flight (mode) | Longest enqueue in burst |
| ------ | -------- | --- | ----------- | --------------- | ------------------------------- | ------------------------- | ------------------------ |
| Server | 1        | 20  | 2.3 / 9.1   | 2.3 / 9.1       | 0.00 (0–0)                      | 0                         | — / —                    |
| Server | 4        | 20  | 6.7 / 15.2  | 4.1 / 12.7      | 0.00 (0–0)                      | 0                         | — / —                    |
| Server | 8        | 20  | 12.0 / 29.9 | 7.3 / 21.0      | 0.00 (0–0)                      | 0                         | — / —                    |
| Mac    | 1        | 20  | 10.4 / 12.8 | 10.4 / 12.7     | 5.0 (5–5)                       | 1                         | 0.03 / 0.04              |
| Mac    | 4        | 20  | 19.2 / 29.0 | 16.9 / 25.2     | 20.0 (20–20)                    | 4                         | 0.59 / 2.8               |
| Mac    | 8        | 20  | 35.5 / 58.8 | 27.4 / 49.2     | 40.0 (40–40)                    | 8                         | 1.7 / 7.6                |
| Loop   | 1        | 20  | 8.5 / 31.3  | 8.5 / 31.3      | 5.0 (5–5)                       | 1                         | 0.03 / 0.04              |
| Loop   | 4        | 20  | 28.3 / 42.2 | 23.0 / 41.9     | 20.0 (20–20)                    | 4                         | 0.36 / 3.0               |
| Loop   | 8        | 20  | 43.1 / 63.6 | 37.2 / 61.3     | 40.0 (40–40)                    | 8                         | 0.49 / 6.7               |
| Win    | 1        | 20  | 11.3 / 18.1 | 11.3 / 18.1     | 5.0 (5–5)                       | 1                         | 0.03 / 0.30              |
| Win    | 4        | 20  | 18.5 / 34.0 | 14.5 / 30.5     | 20.0 (20–20)                    | 4                         | 0.45 / 2.4               |
| Win    | 8        | 20  | 34.1 / 59.7 | 26.3 / 58.6     | 40.0 (40–40)                    | 8                         | 2.4 / 6.6                |

A 1/4/8 burst is 1/4/8 browser-equivalent HTTP requests. On the linked fixture it produced exactly **5/20/40 RPCs**, respectively. All eight calls could be in flight; the request gate ordered checks, not entire folder listings. Mac and Win eight-way wall p95s were **59 and 60 ms**; loopback was **64 ms**. Individual requests slowed under load but there was no link-wide serialization or evidence of a sustained outbox stall at these sizes. This was not a reconnect/packet-loss test.

| Host | Pings n, RTT    | RPCs n, first-send queue | RPC reply  | Gate check  | Gate wait   | Daemon      | Snapshot    | Outbox (max per RPC) | Buffered bytes (max) |
| ---- | --------------- | ------------------------ | ---------- | ----------- | ----------- | ----------- | ----------- | -------------------- | -------------------- |
| Mac  | 60; 1.6 / 71.1  | 4479; 0.04 / 1.1         | 5.5 / 41.1 | 0.17 / 0.65 | 0.02 / 0.57 | 0.14 / 19.9 | 0.21 / 0.39 | 0.00 / 0.02          | 0                    |
| Loop | 63; 0.64 / 39.3 | 4460; 0.04 / 0.64        | 7.7 / 73.7 | 0.33 / 2.4  | 0.04 / 3.9  | 1.2 / 47.6  | 0.29 / 0.88 | 0.01 / 0.02          | 0                    |
| Win  | 61; 1.7 / 52.2  | 12467; 0.03 / 1.8        | 26.7 / 380 | 0.69 / 7.7  | 0.05 / 350  | 0.13 / 41.5 | 0.62 / 1.5  | 0.00 / 0.01          | 0                    |

- `Gate wait` starts when the runner accepts a frame and stops when its authorization starts. `Gate check` is the authorization span; `Daemon` and `Snapshot` are separate execution paths. `Outbox` is the longest queued response frame for each RPC, not socket acknowledgement time. Maximums observed: Mac **0.31 ms**, Loop **2.01 ms**, Win **0.13 ms**, and sampled socket buffered bytes were zero. One ping's tail can reflect a late event-loop turn; these RTTs are not ICMP or one-way propagation.
- Frame-level error replies: Mac **700**, Loop **692**, Win **692**. These include filesystem candidate misses such as `opendir`/`open` during normal probing; they are not counts of dropped connections. The tool sample rows are completed successful calls.

| Path | n   | Elapsed    | RPCs median (min–max) | Most frequent RPC mix                                         | Peak in flight median (min–max) |
| ---- | --- | ---------- | --------------------- | ------------------------------------------------------------- | ------------------------------- |
| Mac  | 49  | 93.0 / 249 | 1.0 (1–1)             | exec                                                          | 1.0 (1–1)                       |
| Loop | 48  | 297 / 655  | 1.0 (1–1)             | exec                                                          | 1.0 (1–1)                       |
| Win  | 48  | 674 / 989  | 161 (161–161)         | close×30, open×10, opendir×20, pread×80, readdir×20, realpath | 80.0 (72–80)                    |

The Mac and Loop scans use the existing single POSIX `exec`. In the Windows fallback, candidate directories/reads are already fanned out: 20 directory open/read pairs, 10 file opens, 80 `pread`s, 30 closes and a `realpath`. The individual file operations themselves are cheap; many wait to enter the same scope's [request check](../src/runner/request-gate.ts). Trust and skill selection are on the server. Cache hits and other overlapping work do not count as an invocation of this scan. [Context scan](../src/server/remote-context.ts) already coalesces in-flight requests and caches for 30 seconds. The separate `room-context` span is setup, not an independent measure of native filesystem scans; its median was about 0.03 ms on all four paths (18 per path), with p95s of Server 97, Mac 195, Loop 113, Win 145 ms.

<details>
<summary>Per-RPC frame bytes and reply duration (all selected windows, including background operations)</summary>

| Host:RPC                           | n    | Reply       | Sent B      | Received B   | Daemon      | Snapshot    |
| ---------------------------------- | ---- | ----------- | ----------- | ------------ | ----------- | ----------- |
| Loopback-perf:close                | 396  | 2.2 / 9.4   | 40.0 / 177  | 15.0 / 15.0  | 0.24 / 5.0  | — / —       |
| Loopback-perf:exec                 | 1632 | 18.7 / 176  | 416 / 512   | 89.0 / 235   | 10.2 / 135  | — / —       |
| Loopback-perf:fstat                | 24   | 1.8 / 2.7   | 177 / 177   | 131 / 131    | 0.22 / 0.86 | — / —       |
| Loopback-perf:lstat                | 384  | 3.1 / 12.8  | 88.0 / 235  | 131 / 134    | 0.31 / 3.5  | — / —       |
| Loopback-perf:open                 | 36   | 2.4 / 12.1  | 242 / 245   | 150 / 153    | 0.46 / 6.3  | — / —       |
| Loopback-perf:opendir              | 1052 | 6.6 / 36.2  | 279 / 279   | 324 / 324    | 0.41 / 4.7  | — / —       |
| Loopback-perf:pocket-read-snapshot | 24   | 2.1 / 5.4   | 244 / 244   | 49.0 / 86.0  | — / —       | 0.29 / 0.88 |
| Loopback-perf:pread                | 132  | 5.2 / 18.7  | 201 / 203   | 15.0 / 51215 | 0.28 / 1.3  | — / —       |
| Loopback-perf:readdir              | 372  | 3.3 / 11.1  | 53.0 / 53.0 | 1052 / 37258 | 0.77 / 7.3  | — / —       |
| Loopback-perf:realpath             | 360  | 3.4 / 13.8  | 91.0 / 238  | 75.0 / 85.0  | 0.33 / 3.7  | — / —       |
| Loopback-perf:scanLines            | 12   | 2.1 / 4.2   | 195 / 195   | 135 / 135    | 0.42 / 3.1  | — / —       |
| Loopback-perf:write                | 36   | 2.2 / 8.8   | 281 / 281   | 15.0 / 15.0  | 0.31 / 2.4  | — / —       |
| Macbook-perf:close                 | 377  | 1.8 / 6.2   | 40.0 / 217  | 15.0 / 15.0  | 0.05 / 0.15 | — / —       |
| Macbook-perf:exec                  | 1645 | 19.6 / 75.7 | 496 / 592   | 89.0 / 235   | 16.0 / 28.4 | — / —       |
| Macbook-perf:fstat                 | 26   | 1.7 / 2.6   | 217 / 217   | 135 / 135    | 0.06 / 0.10 | — / —       |
| Macbook-perf:lstat                 | 409  | 1.9 / 5.6   | 128 / 315   | 133 / 138    | 0.06 / 0.17 | — / —       |
| Macbook-perf:open                  | 37   | 2.2 / 4.1   | 322 / 325   | 157 / 184    | 0.12 / 0.19 | — / —       |
| Macbook-perf:opendir               | 1040 | 4.7 / 37.2  | 353 / 353   | 392 / 392    | 0.10 / 0.28 | — / —       |
| Macbook-perf:pocket-read-snapshot  | 26   | 2.9 / 4.4   | 324 / 324   | 50.0 / 86.0  | — / —       | 0.21 / 0.39 |
| Macbook-perf:pread                 | 135  | 3.2 / 7.8   | 241 / 243   | 15.0 / 51215 | 0.06 / 0.14 | — / —       |
| Macbook-perf:readdir               | 352  | 2.3 / 6.7   | 53.0 / 53.0 | 1244 / 36375 | 0.13 / 1.2  | — / —       |
| Macbook-perf:realpath              | 382  | 2.1 / 6.9   | 131 / 318   | 115 / 125    | 0.06 / 0.18 | — / —       |
| Macbook-perf:scanLines             | 13   | 1.8 / 2.1   | 235 / 235   | 135 / 135    | 0.09 / 0.15 | — / —       |
| Macbook-perf:write                 | 37   | 2.0 / 3.7   | 361 / 361   | 15.0 / 15.0  | 0.21 / 0.32 | — / —       |
| Monolith-perf:close                | 1816 | 4.4 / 372   | 205 / 206   | 15.0 / 15.0  | 0.08 / 0.48 | — / —       |
| Monolith-perf:exec                 | 1567 | 47.1 / 80.5 | 472 / 538   | 94.0 / 262   | 40.0 / 52.5 | — / —       |
| Monolith-perf:fstat                | 24   | 4.4 / 8.7   | 206 / 206   | 137 / 137    | 0.09 / 0.11 | — / —       |
| Monolith-perf:lstat                | 588  | 1.7 / 5.8   | 117 / 286   | 134 / 146    | 0.13 / 0.20 | — / —       |
| Monolith-perf:open                 | 516  | 23.2 / 114  | 272 / 291   | 157 / 159    | 0.15 / 3.6  | — / —       |
| Monolith-perf:opendir              | 1992 | 5.3 / 33.4  | 251 / 331   | 28.0 / 372   | 0.14 / 0.45 | — / —       |
| Monolith-perf:pocket-read-snapshot | 24   | 3.6 / 13.6  | 301 / 301   | 50.0 / 86.0  | — / —       | 0.62 / 1.5  |
| Monolith-perf:pread                | 3972 | 216 / 498   | 234 / 236   | 15.0 / 8034  | 0.08 / 0.26 | — / —       |
| Monolith-perf:readdir              | 1312 | 4.0 / 26.6  | 218 / 219   | 1112 / 16613 | 0.42 / 6.0  | — / —       |
| Monolith-perf:realpath             | 608  | 1.9 / 9.0   | 120 / 289   | 104 / 108    | 0.18 / 0.29 | — / —       |
| Monolith-perf:scanLines            | 12   | 4.8 / 8.1   | 224 / 224   | 135 / 135    | 0.12 / 0.19 | — / —       |
| Monolith-perf:write                | 36   | 3.1 / 5.5   | 338 / 338   | 15.0 / 15.0  | 0.40 / 0.64 | — / —       |

Windows `pread` in this aggregate is dominated by the context burst. Its 216 / 498 ms reply time is not the timing of an interactive standalone read. Small-file and tool-specific bytes are in the tool table above.

</details>

## Server event-loop delays over 50 ms

| Window   | Total | Delay median / p95 | Maximum | Compression ≥50% | GC ≥50% | Other timed phase ≥50% | Scheduler ≥60% nearby | Other phase overlap | Unresolved |
| -------- | ----- | ------------------ | ------- | ---------------- | ------- | ---------------------- | --------------------- | ------------------- | ---------- |
| web      | 311   | 76.8 / 211         | 379     | 21               | 4       | 0                      | 0                     | 54                  | 232        |
| web-15   | 101   | 79.4 / 249         | 538     | 8                | 3       | 0                      | 0                     | 17                  | 73         |
| tools    | 394   | 65.9 / 127         | 334     | 0                | 0       | 0                      | 95                    | 8                   | 291        |
| pressure | 3     | 66.1 / 67.3        | 67.3    | 0                | 0       | 0                      | 3                     | 0                   | 0          |

809 records in the selected windows. UTC windows: web 17:39:57–17:45:28, web continuation 17:46:31–17:48:18, tools 17:55:15–17:58:00, pressure 17:58:32–17:58:42. No trace drop marker in those windows. The maximum was **538 ms**. The timer drift and `perf_hooks` delay are each adjusted by the 10 ms sample interval; the ledger reports the larger estimate. It reports observed missing event-loop turns, **not 809 separate proven JavaScript blockers**.

- **29** records overlapped synchronous HTTP compression for at least half the estimated delay. The longest measured compression bracket was **171 ms**, on a history response. **7** similarly overlapped GC; the longest measured GC bracket was **224 ms**. A bracket uses elapsed time, so it can also contain time descheduled. Another **79** records overlapped a timed phase without a phase covering half the interval. `http.stringify`, `room.view` and `room.project` are named in the ledger where measured. Seeing an async handler in flight does not make it the cause.
- **98** records had evidence of scheduler delay: nearby cumulative wait for the copy's main thread rose by at least 60% of the lag, with samples close enough to bracket the event. The Linux scheduler sampler was not active for the web batches. It saw no increase in the copy's CPU-quota throttle counter in the sampled tool/pressure interval. It does not identify which other process used the CPU.
- **596** records have no attributable phase or scheduler evidence at the sampling resolution, including the longest. Marked **unresolved**, not guessed from the last HTTP request or attributed to Tailscale. Rerun a short web batch with the scheduler sampler and a bounded CPU/GC profile, on the copy only, to narrow these. The ledger preserves all records for the stated windows, including the end of the tools window with the incomplete sample.

## Next PR: ranked build plan (not implemented)

These are intended savings to validate, not changes measured in this run. They are **per affected action**, and must not be summed. Keep changes in the runner, shared `FolderAccess`/workspace code, and the session surfaces that use them. A native adapter should call the same bounded collector locally, without sending RPCs. Compare native and all three runner paths before shipping.

| Priority and target                                                        | Work and dependency order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Runner hello flag                                                                                                                                        | Touches the runner request check?                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. **Windows context scan: 450–600 ms** on cold misses.                    | Replace the 161-RPC fallback with one read-only collection of bounded candidate context and skill records. Use shared platform-native walking on local and linked hosts. Do independent searches concurrently with a fixed limit; maintain repository/ancestor ordering and existing caps. Reconstruct result order, parsing and trust on the server. Start a coalesced refresh when an authorized session selects a known folder, without blocking transcript paint; preserve invalidation after context edits.                                                                                                                          | **Yes**, `contextScanV1`. Absent: existing POSIX `exec` or Windows fallback.                                                                             | **Yes.** Add one typed op. Authenticate current scope and canonical roots; permit only existing context/skill exceptions and file caps. No arbitrary read outside the allowed roots, and no server decision about trust sent as permission. |
| 2. **Open/history: 75–130 ms** on large loads where older rows are needed. | Send first authorized metadata and intact recent rows without waiting for unrelated runners-list, trust, files, or Changes refreshes. Reuse room projection by entry watermark/build. Prepare bounded older pages asynchronously after the tail, or prefetch a page on history/Find intent; do not prefetch 5,000 entries on every click. Move large HTTP history compression off the main loop with bounded async jobs, preserve ordered SSE and cancellation. Stitch immutable entry ranges by ID and revision, not by arrival sequence. First profile native room startup and the cold view→DOM residual to validate what is in scope. | **No.** Server HTTP/SSE only. If adding browser fields, keep the current `/context` fallback and cache format compatibility.                             | **No.** Apply existing session visibility and cache invalidation on every read/serve. No runner RPC for stored entries.                                                                                                                     |
| 3. **Changes / file index: 40–100 ms** on the slow Git path.               | Batch a read-only Git/workspace snapshot rather than six independent remote process launches plus path probes. Pick the repo first; gather status/branch/HEAD and stats using as few Git processes as the existing semantics allow. Limit independent per-file work. Combine returned typed records with transcript edit facts on the server, and keep the separate full diff on demand. Coalesce a same-scope Files/Changes request and reuse a valid index. Native should share the collector and get the same reduction in launches.                                                                                                   | **Yes** for linked `workspaceSnapshotV1`. Absent: existing `FolderAccess` calls. Native consolidation and HTTP coalescing need **no** flag.              | **Yes** for the op. Enforce read-only Git operation and root/per-file checks. Never substitute an arbitrary command, change index/worktree state, or return paths outside the caller's existing visibility.                                 |
| 4. **50 KiB reads and edits: 25–45 ms** on Win.                            | Extend versioned snapshots to cover common medium reads with a capped body, identity and line count. For larger files, read only requested ranges. For edit, coalesce independent ranges from the same opened version, reconstruct and calculate the patch on the server, then do the dependent write only if the file version still matches. Keep the existing single small read fast path.                                                                                                                                                                                                                                              | **Yes**, `readSnapshotV2` / `readRangesV1`. Absent: current snapshot with the present fallback.                                                          | **Yes** for each new op or limit. Preserve read-only handles, canonical path/identity checks, cancellation and revocation. Check the write independently; reject a stale version rather than silently overwriting.                          |
| 5. **Alias-rich folders and repeated listings: 20–40 ms** on Windows home. | In the shared listing path, parallelize independent alias pairs with a limit after reading the directory. After that, combine open/read/close and metadata-only alias classification into a single cap-limited runner call. Sort/filter on the server. Coalesce only authorized, same-key bursts; cancel stale navigation. Test hidden entries, junctions, dangling aliases and symlink depth on Win as well as POSIX.                                                                                                                                                                                                                    | **No** for parallel checks/coalescing; **yes**, `folderListV1`, for the compound operation. Fallback keeps the current order dependencies.               | **No** for parallel caller changes. **Yes** for the compound op: exactly the current metadata-only browse capability; no file contents or unchecked expanded access.                                                                        |
| 6. **Fork/place and picker ready state: 5–25 ms** when prefetch hits.      | Put already-known copy metadata into the authorized session view or prime it on likely fork intent. Paint current computer, model and folder from that one record; do the independent local worktree probe asynchronously. Provide the initial folder list early only for the selected authorized computer/path; refresh stale data in parallel with painting the cache. Bind cache keys to user, build, runner, path, and permission generation. The fork sheet only has a 6–13 ms median browser GET-to-headers interval to hide; do not promise elimination of its 80–100 ms paint time.                                               | **No** new flag; uses item 5 when available.                                                                                                             | **No**; all cache misses use the usual gate. Invalidate a prefetched record when authority, target or backing revision changes.                                                                                                             |
| 7. **Application gaps and resume: no steady-state savings measured.**      | Do not add a retransmission layer for IP packets. TCP/WebSocket carry ordered reliable data. The runner link already retains and replays the unacknowledged suffix on reconnect. For new bounded range/manifest responses only, if needed, give chunks stable snapshot/version and range IDs; store the received set on the server, request only missing ranges, verify and assemble deterministically. If a revision expires or differs, restart that snapshot instead of merging old and new bytes. Keep acknowledgement memory bounded and never replay side-effecting exec/write as a fresh request.                                  | **None** for current stream resume. Optional `workspaceRangesV1` only for independently addressable application ranges, if the failure tests justify it. | **No** for current transport. **Yes** for new resumable workspace reads: retries must still belong to the same authorized scope/version (including after reconnect or revocation).                                                          |

**Order within the PR.** Implement the bounded collectors and native adapter first. Add negotiated compound ops with tested legacy fallbacks, then cache/prefetch and server-side assembly. Keep expensive parsing/compression off the event loop only where profiles show it matters, and do not change Bash's output contract based on a shared-host startup result. Limit simultaneous jobs and bytes, propagate aborts, release handles, and test reconnect at a range boundary, missing/duplicate application chunks, permission revocation and old-runner compatibility. No new flag may bypass the gate or loosen a folder approval. Repeat the same workloads on all four paths; check median/p95, RPC counts, gate wait, first output, fairness of the 8-list burst, and regressions with diagnostics off. Profile otherwise unexplained server stalls before claiming a cause or a gain.

**Primary references:** [runner link protocol and replay](../src/runner/protocol.ts), [request gate](../src/runner/request-gate.ts), [snapshot implementation](../src/runner/read-snapshot.ts), [FolderAccess](../src/server/folder-access.ts), [cache lifecycle](../web/session-cache.js), [Node zlib threadpool guidance](https://nodejs.org/docs/latest-v22.x/api/zlib.html#threadpool-usage-and-performance-considerations), [RFC 9293 §2.2 (TCP byte stream)](https://www.rfc-editor.org/rfc/rfc9293.html#section-2.2), and [RFC 6455 §5.4 (WebSocket fragmentation)](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.4). Earlier simulated-delay notes were used to choose workloads, not combined with the tailnet samples.

<details>
<summary>Per-block ledger: all 809 observed server delays over 50 ms</summary>

UTC denotes the end of the interval on 2026-11-23. Phase duration is the bracketing measurement, not necessarily CPU time. `sched_wait/PSI_ms` are increments in main-thread runqueue wait and cgroup full CPU pressure in the nearest bracket, or `-` when unsampled. `active_spans` are context, not attribution.

```text
UTC	window	lag_ms	evidence	timed_phases_ms	sched_wait/PSI_ms	active_spans
17:40:06.825	web	75	unresolved	-	-	changes
17:40:07.369	web	230	phase overlap	room.project:19(room-enter),room.view:73(room-enter),gc:5,gc:7,gc:8	-	room-context,room-enter,changes
17:40:07.510	web	132	unresolved	-	-	changes
17:40:07.769	web	75	phase overlap	http.stringify:26(history),http.compress:32(history)	-	history
17:40:08.170	web	64	unresolved	-	-	files,context-scan
17:40:08.437	web	73	phase overlap	room.project:12(room-enter),room.view:13(room-enter)	-	room-context,room-enter,changes
17:40:08.515	web	68	unresolved	-	-	changes
17:40:09.239	web	236	phase overlap	room.project:28(room-enter),room.view:54(room-enter),gc:6	-	room-context,room-enter,changes
17:40:09.812	web	74	http.compress	http.stringify:17(history),http.compress:51(history)	-	history
17:40:10.871	web	116	phase overlap	room.project:11(room-enter),room.view:29(room-enter)	-	room-context,room-enter
17:40:11.001	web	120	phase overlap	gc:5	-	changes
17:40:11.952	web	64	unresolved	-	-	files,context-scan
17:40:12.267	web	108	phase overlap	gc:26	-	context-scan,changes
17:40:12.779	web	68	unresolved	-	-	context-scan
17:40:15.787	web	141	unresolved	-	-	room-enter,changes
17:40:16.330	web	95	unresolved	-	-	changes,files
17:40:16.851	web	64	phase overlap	http.compress:18(history)	-	history
17:40:17.004	web	67	unresolved	-	-	files,changes
17:40:17.391	web	63	unresolved	-	-	files,changes
17:40:17.643	web	58	unresolved	-	-	changes,files
17:40:19.958	web	129	unresolved	-	-	changes
17:40:24.740	web	100	unresolved	-	-	changes
17:40:24.995	web	57	unresolved	-	-	idle/unmarked
17:40:25.443	web	123	unresolved	-	-	idle/unmarked
17:40:25.665	web	161	gc	gc:163	-	idle/unmarked
17:40:27.754	web	61	unresolved	-	-	idle/unmarked
17:40:28.355	web	55	unresolved	-	-	idle/unmarked
17:40:30.237	web	91	unresolved	-	-	room-enter,changes
17:40:30.907	web	82	unresolved	-	-	changes
17:40:31.992	web	71	http.compress	http.stringify:10(history),http.compress:64(history)	-	history
17:40:32.689	web	52	unresolved	-	-	files
17:40:33.065	web	57	unresolved	-	-	changes,files
17:40:33.442	web	62	unresolved	-	-	changes,files
17:40:33.720	web	53	unresolved	-	-	changes
17:40:33.897	web	117	unresolved	-	-	history,files
17:40:34.277	web	51	http.compress	http.stringify:18(history),http.compress:32(history)	-	history
17:40:36.049	web	74	unresolved	-	-	idle/unmarked
17:40:36.546	web	98	unresolved	-	-	changes
17:40:37.317	web	158	unresolved	-	-	room-enter,changes
17:40:37.515	web	56	phase overlap	http.stringify:16(history),http.compress:27(history)	-	history
17:40:40.205	web	86	phase overlap	http.stringify:17(history),http.compress:37(history)	-	history
17:40:40.590	web	289	unresolved	-	-	files,changes
17:40:40.702	web	78	unresolved	-	-	files,changes
17:40:42.587	web	160	unresolved	-	-	context-scan
17:40:49.950	web	61	unresolved	-	-	idle/unmarked
17:40:50.494	web	158	unresolved	-	-	changes
17:40:51.336	web	91	phase overlap	gc:20	-	files
17:40:53.921	web	68	unresolved	-	-	changes,context-scan
17:40:53.983	web	51	unresolved	-	-	changes,files,context-scan
17:40:55.948	web	114	unresolved	-	-	idle/unmarked
17:40:56.014	web	56	unresolved	-	-	idle/unmarked
17:40:56.124	web	100	unresolved	-	-	idle/unmarked
17:40:57.170	web	69	unresolved	-	-	files
17:40:57.904	web	90	unresolved	-	-	files
17:40:59.545	web	276	unresolved	-	-	changes,files
17:40:59.655	web	57	unresolved	-	-	files,changes
17:41:01.207	web	214	unresolved	-	-	changes
17:41:08.832	web	128	unresolved	-	-	idle/unmarked
17:41:11.362	web	77	http.compress	http.stringify:9(history),http.compress:39(history)	-	history
17:41:11.990	web	59	unresolved	-	-	history
17:41:12.447	web	58	unresolved	-	-	changes
17:41:12.669	web	68	unresolved	-	-	changes
17:41:12.858	web	150	unresolved	-	-	changes
17:41:13.236	web	83	unresolved	-	-	changes
17:41:15.138	web	60	unresolved	-	-	idle/unmarked
17:41:16.834	web	60	unresolved	-	-	files,context-scan
17:41:17.206	web	59	http.compress	http.stringify:5(history),http.compress:34(history)	-	history
17:41:18.197	web	62	unresolved	-	-	files,changes
17:41:18.766	web	60	unresolved	-	-	changes
17:41:18.876	web	100	unresolved	-	-	files,changes
17:41:20.574	web	53	unresolved	-	-	changes
17:41:23.506	web	79	unresolved	-	-	idle/unmarked
17:41:26.083	web	55	unresolved	-	-	folder-list
17:41:29.931	web	52	unresolved	-	-	idle/unmarked
17:41:30.055	web	72	unresolved	-	-	idle/unmarked
17:41:30.150	web	85	unresolved	-	-	idle/unmarked
17:41:31.419	web	51	http.compress	http.stringify:17(history),http.compress:29(history)	-	history
17:41:32.079	web	59	unresolved	-	-	files,context-scan
17:41:33.237	web	55	phase overlap	http.stringify:21(history),http.compress:24(history)	-	history,context-scan
17:41:33.447	web	66	unresolved	-	-	changes,context-scan
17:41:33.702	web	98	unresolved	-	-	room-enter,context-scan,changes
17:41:33.851	web	128	unresolved	-	-	context-scan,changes
17:41:34.240	web	73	unresolved	-	-	changes
17:41:34.568	web	66	phase overlap	http.stringify:13(history),http.compress:21(history)	-	history
17:41:36.769	web	127	unresolved	-	-	idle/unmarked
17:41:37.123	web	59	phase overlap	http.stringify:6(history),http.compress:11(history)	-	history
17:41:37.718	web	164	unresolved	-	-	files,changes
17:41:40.003	web	112	unresolved	-	-	files,changes
17:41:40.332	web	242	unresolved	-	-	files,changes
17:41:40.680	web	106	unresolved	-	-	files,changes
17:41:49.794	web	92	unresolved	-	-	idle/unmarked
17:41:49.935	web	111	unresolved	-	-	idle/unmarked
17:41:50.343	web	66	unresolved	-	-	idle/unmarked
17:41:50.428	web	75	unresolved	-	-	idle/unmarked
17:41:51.056	web	59	unresolved	-	-	idle/unmarked
17:41:51.212	web	134	unresolved	-	-	idle/unmarked
17:41:51.313	web	92	unresolved	-	-	idle/unmarked
17:41:52.071	web	54	unresolved	-	-	files,context-scan
17:41:52.418	web	92	phase overlap	gc:8	-	files,context-scan
17:41:52.739	web	94	phase overlap	gc:24	-	context-scan,files
17:41:52.952	web	158	phase overlap	http.stringify:16(history),http.compress:23(history)	-	history
17:41:53.215	web	62	phase overlap	gc:9	-	context-scan
17:41:54.182	web	172	unresolved	-	-	changes
17:41:54.282	web	64	unresolved	-	-	files
17:41:54.477	web	73	unresolved	-	-	room-enter,changes
17:41:54.867	web	58	unresolved	-	-	room-enter,changes
17:41:56.835	web	149	unresolved	-	-	idle/unmarked
17:41:56.972	web	127	unresolved	-	-	idle/unmarked
17:41:57.349	web	56	phase overlap	http.compress:11	-	idle/unmarked
17:41:58.276	web	68	http.compress	http.stringify:9(history),http.compress:61(history)	-	history
17:41:58.912	web	86	unresolved	-	-	files
17:42:00.812	web	85	unresolved	-	-	changes,files
17:42:01.010	web	189	unresolved	-	-	room-enter,changes,files
17:42:01.134	web	61	unresolved	-	-	changes,files
17:42:01.412	web	139	unresolved	-	-	files,changes
17:42:01.512	web	89	phase overlap	http.stringify:5(history),http.compress:32(history)	-	history,changes
17:42:02.066	web	114	unresolved	-	-	context-scan,changes,files
17:42:02.233	web	157	unresolved	-	-	context-scan,changes,files
17:42:02.350	web	56	unresolved	-	-	idle/unmarked
17:42:02.781	web	84	unresolved	-	-	idle/unmarked
17:42:03.509	web	92	unresolved	-	-	changes
17:42:11.808	web	90	unresolved	-	-	idle/unmarked
17:42:12.900	web	62	unresolved	-	-	idle/unmarked
17:42:14.497	web	83	unresolved	-	-	changes,files,context-scan
17:42:14.644	web	91	http.compress	http.stringify:17(history),http.compress:49(history)	-	history,context-scan
17:42:15.399	web	65	phase overlap	room.view:29(room-enter)	-	room-enter,changes,context-scan
17:42:16.150	web	106	unresolved	-	-	changes,context-scan
17:42:16.268	web	88	unresolved	-	-	context-scan,files
17:42:16.466	web	59	unresolved	-	-	changes
17:42:17.166	web	107	phase overlap	http.stringify:29(history),http.compress:31(history)	-	history
17:42:17.833	web	97	unresolved	-	-	changes,files,context-scan
17:42:17.985	web	99	phase overlap	http.stringify:15(history),http.compress:32(history)	-	history,context-scan
17:42:21.849	web	57	http.compress	http.stringify:8(history),http.compress:29(history)	-	history
17:42:22.106	web	74	unresolved	-	-	changes
17:42:22.178	web	62	unresolved	-	-	room-enter,files,changes
17:42:22.239	web	51	unresolved	-	-	files,changes
17:42:22.515	web	117	unresolved	-	-	files,changes
17:42:22.694	web	74	unresolved	-	-	changes
17:42:25.248	web	345	unresolved	-	-	folder-list,changes
17:42:25.332	web	74	phase overlap	http.compress:7(folder-list)	-	folder-list,changes
17:42:25.498	web	156	unresolved	-	-	changes
17:42:28.636	web	54	unresolved	-	-	idle/unmarked
17:42:30.346	web	57	unresolved	-	-	context-scan
17:42:31.983	web	128	unresolved	-	-	idle/unmarked
17:42:33.885	web	55	unresolved	-	-	idle/unmarked
17:42:34.131	web	68	unresolved	-	-	idle/unmarked
17:42:34.195	web	54	unresolved	-	-	idle/unmarked
17:42:35.797	web	312	phase overlap	http.stringify:30(history),http.compress:81(history)	-	history
17:42:35.865	web	57	unresolved	-	-	room-enter,changes
17:42:37.211	web	65	unresolved	-	-	changes
17:42:37.351	web	130	unresolved	-	-	room-enter,changes
17:42:37.746	web	133	unresolved	-	-	changes
17:42:37.821	web	65	unresolved	-	-	room-enter,changes
17:42:38.183	web	86	unresolved	-	-	room-enter,changes
17:42:38.424	web	86	phase overlap	http.stringify:18(history),http.compress:22(history)	-	history
17:42:40.162	web	217	gc	gc:224	-	idle/unmarked
17:42:41.489	web	60	unresolved	-	-	idle/unmarked
17:42:41.634	web	67	unresolved	-	-	idle/unmarked
17:42:43.383	web	93	unresolved	-	-	changes
17:42:43.585	web	63	unresolved	-	-	room-enter,changes
17:42:44.260	web	379	unresolved	-	-	changes
17:42:44.452	web	86	phase overlap	http.stringify:17(history),http.compress:14(history)	-	history
17:42:44.565	web	103	phase overlap	gc:7	-	room-enter,files,changes
17:42:44.965	web	55	unresolved	-	-	files,changes
17:42:46.751	web	88	unresolved	-	-	changes
17:42:55.916	web	53	unresolved	-	-	idle/unmarked
17:42:56.833	web	180	http.compress	http.stringify:7(history),http.compress:171(history)	-	history,context-scan
17:42:58.529	web	71	phase overlap	http.stringify:15(history),http.compress:32(history)	-	history,context-scan
17:42:58.889	web	138	unresolved	-	-	room-enter,changes
17:42:59.119	web	54	unresolved	-	-	room-enter,changes
17:42:59.524	web	57	phase overlap	room.view:5(room-enter)	-	room-enter,changes
17:43:00.358	web	57	unresolved	-	-	files
17:43:00.632	web	62	unresolved	-	-	files,context-scan
17:43:00.761	web	63	phase overlap	http.stringify:28(history),http.compress:30(history)	-	history,context-scan
17:43:01.158	web	75	unresolved	-	-	changes,files,context-scan
17:43:03.096	web	60	unresolved	-	-	idle/unmarked
17:43:04.179	web	79	unresolved	-	-	files,changes,context-scan
17:43:05.358	web	111	unresolved	-	-	changes
17:43:05.610	web	57	unresolved	-	-	changes
17:43:05.811	web	191	unresolved	-	-	files,changes
17:43:07.350	web	57	http.compress	http.stringify:25(history),http.compress:41(history)	-	history
17:43:09.296	web	76	unresolved	-	-	changes
17:43:13.453	web	62	unresolved	-	-	idle/unmarked
17:43:17.720	web	53	unresolved	-	-	idle/unmarked
17:43:19.168	web	54	unresolved	-	-	files
17:43:20.016	web	52	unresolved	-	-	changes
17:43:20.523	web	102	phase overlap	http.stringify:14(history),http.compress:34(history)	-	history
17:43:21.049	web	111	unresolved	-	-	idle/unmarked
17:43:21.640	web	54	phase overlap	http.stringify:6(history),http.compress:15(history)	-	history
17:43:22.560	web	74	phase overlap	http.stringify:14(history),http.compress:21(history)	-	history
17:43:24.613	web	110	unresolved	-	-	files
17:43:25.703	web	113	unresolved	-	-	changes
17:43:25.913	web	145	unresolved	-	-	changes,files
17:43:26.184	web	103	unresolved	-	-	files,changes
17:43:26.329	web	56	unresolved	-	-	files,changes
17:43:26.403	web	64	unresolved	-	-	changes
17:43:27.030	web	62	unresolved	-	-	files,changes
17:43:27.394	web	65	http.compress	http.stringify:13(history),http.compress:41(history)	-	history
17:43:29.833	web	211	unresolved	-	-	changes
17:43:34.909	web	60	unresolved	-	-	context-scan
17:43:35.743	web	121	unresolved	-	-	context-scan
17:43:36.886	web	121	unresolved	-	-	idle/unmarked
17:43:38.244	web	89	unresolved	-	-	idle/unmarked
17:43:38.700	web	70	unresolved	-	-	idle/unmarked
17:43:39.069	web	163	unresolved	-	-	idle/unmarked
17:43:39.207	web	57	unresolved	-	-	changes
17:43:39.942	web	93	unresolved	-	-	context-scan,changes,files
17:43:40.127	web	144	phase overlap	http.stringify:16(history),http.compress:32(history)	-	files,history,context-scan
17:43:40.264	web	56	unresolved	-	-	room-enter,changes,context-scan
17:43:40.362	web	88	unresolved	-	-	changes,context-scan
17:43:40.532	web	160	unresolved	-	-	changes,context-scan
17:43:40.908	web	89	unresolved	-	-	changes
17:43:41.377	web	108	unresolved	-	-	changes
17:43:42.733	web	53	http.compress	http.stringify:10(history),http.compress:43(history)	-	history
17:43:45.669	web	64	unresolved	-	-	idle/unmarked
17:43:46.770	web	55	http.compress	http.stringify:14(history),http.compress:37(history)	-	history
17:43:47.227	web	246	unresolved	-	-	room-enter,changes
17:43:47.577	web	169	unresolved	-	-	changes
17:43:47.868	web	54	unresolved	-	-	changes
17:43:49.088	web	113	unresolved	-	-	files,changes
17:43:49.479	web	174	phase overlap	http.stringify:14(history),http.compress:18(history)	-	files,history,changes
17:43:51.195	web	239	unresolved	-	-	changes
17:43:51.325	web	120	unresolved	-	-	changes
17:43:52.132	web	58	unresolved	-	-	folder-list
17:44:00.199	web	60	http.compress	http.stringify:15(history),http.compress:46(history)	-	history
17:44:00.727	web	70	unresolved	-	-	room-enter,changes
17:44:01.064	web	53	unresolved	-	-	room-enter,changes
17:44:01.158	web	84	unresolved	-	-	changes
17:44:01.425	web	93	http.compress	http.stringify:17(history),http.compress:50(history)	-	history
17:44:01.897	web	64	unresolved	-	-	files,context-scan
17:44:02.050	web	83	unresolved	-	-	context-scan,history
17:44:03.883	web	67	http.compress	http.stringify:16(history),http.compress:54(history)	-	history
17:44:07.065	web	79	phase overlap	http.stringify:14(history),http.compress:31(history)	-	history
17:44:07.282	web	110	unresolved	-	-	changes
17:44:07.345	web	53	phase overlap	room.view:20(room-enter)	-	room-enter,changes,files
17:44:08.164	web	92	phase overlap	http.stringify:19(history),http.compress:32(history)	-	history
17:44:11.731	web	59	unresolved	-	-	changes
17:44:14.917	web	120	unresolved	-	-	folder-list
17:44:20.205	web	131	unresolved	-	-	idle/unmarked
17:44:20.498	web	88	unresolved	-	-	changes
17:44:21.353	web	150	unresolved	-	-	changes
17:44:22.092	web	108	phase overlap	http.stringify:28(history),http.compress:34(history)	-	history
17:44:22.216	web	114	unresolved	-	-	idle/unmarked
17:44:23.312	web	176	phase overlap	http.stringify:18(history),http.compress:48(history)	-	history,context-scan
17:44:24.203	web	51	http.compress	http.stringify:11(history),http.compress:34(history)	-	history,changes,files
17:44:26.953	web	70	unresolved	-	-	idle/unmarked
17:44:27.588	web	288	unresolved	-	-	changes
17:44:27.785	web	50	unresolved	-	-	changes
17:44:27.913	web	78	unresolved	-	-	room-enter,changes
17:44:28.102	web	96	phase overlap	room.view:6(room-enter)	-	room-enter,changes
17:44:28.756	web	58	unresolved	-	-	files
17:44:29.727	web	74	phase overlap	http.compress:17(history)	-	history
17:44:30.304	web	54	unresolved	-	-	files,changes
17:44:30.489	web	74	phase overlap	http.compress:29(history)	-	history
17:44:31.030	web	77	unresolved	-	-	folder-list
17:44:31.096	web	56	unresolved	-	-	idle/unmarked
17:44:34.062	web	85	unresolved	-	-	changes
17:44:40.670	web	72	unresolved	-	-	changes
17:44:41.220	web	69	unresolved	-	-	changes
17:44:41.543	web	110	phase overlap	http.stringify:17(history),http.compress:31(history)	-	history
17:44:42.137	web	56	phase overlap	http.stringify:8(history),http.compress:21(history)	-	history
17:44:42.313	web	52	unresolved	-	-	changes,files,context-scan
17:44:43.111	web	64	phase overlap	http.stringify:8(history),http.compress:15(history)	-	history,changes,context-scan
17:44:45.664	web	93	unresolved	-	-	idle/unmarked
17:44:45.860	web	79	unresolved	-	-	idle/unmarked
17:44:46.070	web	127	unresolved	-	-	room-enter,changes
17:44:46.187	web	73	unresolved	-	-	changes
17:44:46.740	web	72	unresolved	-	-	changes
17:44:47.344	web	92	unresolved	-	-	files
17:44:47.848	web	57	http.compress	http.stringify:7(history),http.compress:30(history)	-	history
17:44:48.010	web	51	unresolved	-	-	changes,files
17:44:49.557	web	93	unresolved	-	-	files,changes
17:44:49.644	web	77	unresolved	-	-	files,changes
17:44:50.760	web	72	unresolved	-	-	changes
17:44:52.985	web	59	unresolved	-	-	idle/unmarked
17:44:59.353	web	95	unresolved	-	-	idle/unmarked
17:44:59.965	web	79	unresolved	-	-	files
17:45:00.734	web	51	unresolved	-	-	changes
17:45:01.020	web	56	phase overlap	http.stringify:14(history),http.compress:26(history)	-	history,context-scan
17:45:02.426	web	122	phase overlap	http.stringify:13(history),http.compress:20(history)	-	changes,history,files,context-scan
17:45:02.490	web	54	unresolved	-	-	files,context-scan
17:45:02.576	web	57	unresolved	-	-	files,changes,context-scan
17:45:05.180	web	61	unresolved	-	-	changes
17:45:06.226	web	71	unresolved	-	-	files
17:45:06.443	web	96	phase overlap	http.compress:21(history)	-	history
17:45:08.050	web	62	unresolved	-	-	changes,files
17:45:08.285	web	146	unresolved	-	-	files,changes
17:45:09.626	web	54	unresolved	-	-	changes
17:45:17.411	web	144	unresolved	-	-	idle/unmarked
17:45:17.728	web	274	unresolved	-	-	idle/unmarked
17:45:17.802	web	64	unresolved	-	-	idle/unmarked
17:45:18.348	web	77	unresolved	-	-	files
17:45:18.717	web	54	phase overlap	http.compress:26(history)	-	history,context-scan
17:45:18.940	web	87	gc	gc:95	-	changes
17:45:19.266	web	66	phase overlap	http.stringify:22(history),http.compress:30(history)	-	history
17:45:19.772	web	106	gc	gc:115	-	context-scan,changes
17:45:20.143	web	297	unresolved	-	-	history,files
17:45:20.293	web	61	unresolved	-	-	changes
17:45:20.391	web	62	unresolved	-	-	changes,files,context-scan
17:45:20.557	web	136	phase overlap	http.stringify:16(history),http.compress:50(history)	-	history,changes,files,context-scan
17:45:21.662	web	162	unresolved	-	-	changes
17:45:21.965	web	106	unresolved	-	-	changes
17:45:22.534	web	59	unresolved	-	-	room-enter,changes
17:45:22.923	web	97	http.compress	http.stringify:19(history),http.compress:49(history)	-	history
17:45:24.759	web	86	unresolved	-	-	idle/unmarked
17:45:24.883	web	66	unresolved	-	-	idle/unmarked
17:45:26.707	web	149	phase overlap	http.compress:16(history)	-	history
17:45:27.406	web	59	unresolved	-	-	files,changes
17:45:27.642	web	98	unresolved	-	-	files,changes
17:45:27.917	web	104	unresolved	-	-	files,changes
17:45:27.984	web	58	http.compress	http.stringify:17(history),http.compress:44(history)	-	history,changes
17:46:33.827	web-15	66	unresolved	-	-	idle/unmarked
17:46:34.508	web-15	88	unresolved	-	-	idle/unmarked
17:46:37.819	web-15	152	unresolved	-	-	idle/unmarked
17:46:37.921	web-15	67	unresolved	-	-	idle/unmarked
17:46:38.874	web-15	97	unresolved	-	-	context-scan,files
17:46:38.953	web-15	70	phase overlap	http.stringify:18(history)	-	history,files
17:46:39.097	web-15	79	unresolved	-	-	idle/unmarked
17:46:39.403	web-15	296	phase overlap	room.project:9(room-enter),room.view:15(room-enter),gc:24	-	room-context,room-enter,changes
17:46:39.674	web-15	113	phase overlap	http.stringify:16(history),http.compress:31(history)	-	context-scan,history
17:46:40.422	web-15	139	phase overlap	room.project:7(room-enter),room.view:12(room-enter)	-	room-context,room-enter,context-scan,changes
17:46:40.748	web-15	51	unresolved	-	-	files,context-scan
17:46:40.941	web-15	59	http.compress	http.stringify:14(history),http.compress:46(history)	-	history,context-scan
17:46:41.324	web-15	120	gc	gc:127	-	files,context-scan
17:46:42.070	web-15	185	phase overlap	room.project:13(room-enter),room.view:17(room-enter),gc:15	-	room-context,room-enter,context-scan,changes
17:46:42.473	web-15	61	http.compress	http.stringify:16(history),http.compress:35(history)	-	history,context-scan
17:46:42.558	web-15	75	unresolved	-	-	context-scan
17:46:42.807	web-15	93	unresolved	-	-	changes,context-scan
17:46:43.076	web-15	70	unresolved	-	-	changes
17:46:43.588	web-15	107	phase overlap	room.view:9(room-enter),gc:20	-	room-context,room-enter,changes
17:46:43.670	web-15	72	unresolved	-	-	changes
17:46:45.409	web-15	63	phase overlap	http.compress:5	-	idle/unmarked
17:46:45.543	web-15	124	unresolved	-	-	idle/unmarked
17:46:45.813	web-15	249	unresolved	-	-	idle/unmarked
17:46:46.960	web-15	135	unresolved	-	-	room-enter
17:46:47.624	web-15	61	unresolved	-	-	room-enter,changes
17:46:49.300	web-15	90	http.compress	http.stringify:6(history),http.compress:77(history)	-	history,changes
17:46:49.543	web-15	79	unresolved	-	-	changes,files
17:46:49.882	web-15	328	unresolved	-	-	room-enter,changes,files
17:46:50.110	web-15	161	unresolved	-	-	changes,files
17:46:50.411	web-15	69	unresolved	-	-	files,changes
17:46:50.705	web-15	275	unresolved	-	-	changes
17:46:50.816	web-15	100	phase overlap	http.stringify:11(history),http.compress:35(history)	-	history,changes
17:46:52.390	web-15	98	unresolved	-	-	changes
17:46:59.228	web-15	75	unresolved	-	-	changes
17:47:01.471	web-15	60	unresolved	-	-	idle/unmarked
17:47:01.674	web-15	77	unresolved	-	-	idle/unmarked
17:47:02.200	web-15	77	unresolved	-	-	files
17:47:02.728	web-15	180	unresolved	-	-	changes,files
17:47:03.929	web-15	102	unresolved	-	-	files
17:47:04.202	web-15	209	phase overlap	http.stringify:16(history),http.compress:48(history)	-	history
17:47:05.171	web-15	94	http.compress	http.stringify:13(history),http.compress:50(history)	-	history
17:47:05.390	web-15	79	unresolved	-	-	files,changes
17:47:05.579	web-15	110	unresolved	-	-	changes
17:47:05.883	web-15	75	unresolved	-	-	room-enter,changes
17:47:06.112	web-15	60	phase overlap	http.stringify:7(history),http.compress:15(history)	-	history
17:47:06.369	web-15	137	phase overlap	gc:17	-	changes,files
17:47:07.840	web-15	92	unresolved	-	-	idle/unmarked
17:47:09.242	web-15	263	unresolved	-	-	room-enter,files,changes
17:47:09.571	web-15	124	phase overlap	http.stringify:56(history),http.compress:20(history)	-	history,files,changes
17:47:11.083	web-15	101	unresolved	-	-	changes
17:47:11.394	web-15	93	unresolved	-	-	changes
17:47:11.732	web-15	113	unresolved	-	-	files,changes
17:47:11.871	web-15	92	phase overlap	http.stringify:11(history),http.compress:29(history)	-	history
17:47:12.089	web-15	104	unresolved	-	-	changes,files,context-scan
17:47:13.734	web-15	82	unresolved	-	-	changes
17:47:14.431	web-15	56	unresolved	-	-	idle/unmarked
17:47:22.313	web-15	76	unresolved	-	-	idle/unmarked
17:47:24.948	web-15	52	unresolved	-	-	context-scan,changes,files
17:47:25.091	web-15	133	unresolved	-	-	context-scan,changes,files
17:47:25.151	web-15	51	gc	gc:33	-	changes,files,context-scan
17:47:25.320	web-15	75	unresolved	-	-	context-scan
17:47:25.482	web-15	56	unresolved	-	-	changes
17:47:25.766	web-15	79	phase overlap	http.stringify:16(history),http.compress:26(history)	-	history
17:47:28.370	web-15	52	unresolved	-	-	files
17:47:30.380	web-15	73	http.compress	http.compress:50(history)	-	history
17:47:30.578	web-15	111	unresolved	-	-	files,changes
17:47:30.652	web-15	64	unresolved	-	-	room-enter,files,changes
17:47:30.748	web-15	68	unresolved	-	-	files,changes
17:47:30.982	web-15	87	unresolved	-	-	changes
17:47:32.853	web-15	87	unresolved	-	-	changes
17:47:41.167	web-15	75	unresolved	-	-	idle/unmarked
17:47:42.997	web-15	65	unresolved	-	-	changes,files
17:47:43.500	web-15	118	unresolved	-	-	files
17:47:43.731	web-15	222	phase overlap	http.stringify:15(history),http.compress:36(history)	-	history,files
17:47:43.918	web-15	151	unresolved	-	-	files,changes
17:47:44.163	web-15	71	unresolved	-	-	room-enter,changes
17:47:44.618	web-15	59	unresolved	-	-	changes
17:47:44.745	web-15	63	http.compress	http.stringify:23(history),http.compress:35(history)	-	history
17:47:45.156	web-15	83	unresolved	-	-	idle/unmarked
17:47:47.181	web-15	53	unresolved	-	-	idle/unmarked
17:47:49.704	web-15	72	unresolved	-	-	files,changes
17:47:49.853	web-15	55	unresolved	-	-	changes
17:47:52.012	web-15	142	unresolved	-	-	changes
17:47:53.071	web-15	72	unresolved	-	-	idle/unmarked
17:47:54.378	web-15	85	unresolved	-	-	idle/unmarked
17:47:56.960	web-15	86	gc	gc:88	-	copy-place
17:48:00.500	web-15	75	unresolved	-	-	idle/unmarked
17:48:01.829	web-15	56	phase overlap	http.stringify:22(history),http.compress:26(history)	-	history,context-scan
17:48:03.292	web-15	538	unresolved	-	-	context-scan,changes
17:48:03.375	web-15	55	unresolved	-	-	context-scan,changes
17:48:03.772	web-15	151	unresolved	-	-	changes
17:48:04.321	web-15	126	unresolved	-	-	changes
17:48:05.569	web-15	77	http.compress	http.stringify:13(history),http.compress:72(history)	-	history
17:48:07.250	web-15	58	unresolved	-	-	idle/unmarked
17:48:07.415	web-15	52	unresolved	-	-	idle/unmarked
17:48:08.236	web-15	93	phase overlap	http.stringify:6(history),http.compress:23(history)	-	history
17:48:08.692	web-15	77	unresolved	-	-	room-enter,files,changes
17:48:08.965	web-15	66	unresolved	-	-	changes
17:48:09.184	web-15	107	unresolved	-	-	room-enter,changes
17:48:09.545	web-15	64	http.compress	http.stringify:19(history),http.compress:49(history)	-	history
17:48:11.829	web-15	63	unresolved	-	-	changes
17:55:18.275	tools	84	scheduler nearby	-	94/92	idle/unmarked
17:55:18.722	tools	166	scheduler nearby	-	168/168	idle/unmarked
17:55:19.399	tools	81	scheduler nearby	-	96/96	idle/unmarked
17:55:21.534	tools	74	scheduler nearby	-	75/56	room-context,room-enter,changes
17:55:21.623	tools	80	scheduler nearby	-	54/50	changes
17:55:21.856	tools	82	unresolved	-	41/30	idle/unmarked
17:55:22.076	tools	89	unresolved	-	33/31	tool
17:55:22.448	tools	72	unresolved	-	34/31	tool
17:55:22.546	tools	66	scheduler nearby	-	53/40	idle/unmarked
17:55:22.805	tools	87	scheduler nearby	-	62/59	idle/unmarked
17:55:22.894	tools	79	scheduler nearby	gc:7	86/87	tool
17:55:23.127	tools	223	scheduler nearby	gc:20	186/140	tool
17:55:23.591	tools	54	unresolved	-	16/29	tool
17:55:23.834	tools	86	phase overlap	gc:8	22/22	idle/unmarked
17:55:24.335	tools	67	unresolved	-	28/21	tool
17:55:24.780	tools	59	scheduler nearby	-	41/40	changes
17:55:24.910	tools	120	unresolved	-	68/69	changes
17:55:25.076	tools	63	scheduler nearby	-	45/69	idle/unmarked
17:55:25.178	tools	92	scheduler nearby	-	65/60	idle/unmarked
17:55:25.565	tools	84	scheduler nearby	-	81/28	context-scan
17:55:25.686	tools	111	scheduler nearby	gc:12	125/35	idle/unmarked
17:55:25.859	tools	82	unresolved	-	30/23	tool
17:55:25.998	tools	59	unresolved	-	19/24	idle/unmarked
17:55:26.107	tools	59	unresolved	-	24/10	tool
17:55:26.356	tools	91	scheduler nearby	-	57/53	idle/unmarked
17:55:26.501	tools	68	unresolved	-	22/20	tool
17:55:26.658	tools	62	unresolved	-	20/32	idle/unmarked
17:55:26.787	tools	74	unresolved	-	32/39	tool
17:55:26.906	tools	61	unresolved	-	17/17	idle/unmarked
17:55:27.030	tools	71	unresolved	-	26/24	tool
17:55:27.262	tools	125	scheduler nearby	gc:12	98/79	idle/unmarked
17:55:27.387	tools	114	scheduler nearby	-	106/106	tool
17:55:27.571	tools	174	scheduler nearby	-	133/102	tool
17:55:27.830	tools	97	scheduler nearby	-	68/57	idle/unmarked
17:55:27.996	tools	72	unresolved	-	17/13	tool
17:55:29.346	tools	86	unresolved	-	31/28	tool
17:55:29.601	tools	127	scheduler nearby	-	93/77	idle/unmarked
17:55:29.750	tools	139	unresolved	-	78/72	tool
17:55:29.950	tools	66	scheduler nearby	-	44/43	idle/unmarked
17:55:30.079	tools	62	unresolved	-	17/29	tool
17:55:30.198	tools	54	unresolved	-	32/15	idle/unmarked
17:55:30.458	tools	169	scheduler nearby	-	129/125	tool
17:55:30.768	tools	182	scheduler nearby	-	147/157	idle/unmarked
17:55:30.881	tools	71	scheduler nearby	-	102/94	tool
17:55:30.972	tools	81	scheduler nearby	-	49/35	tool
17:55:31.276	tools	159	unresolved	-	95/86	idle/unmarked
17:55:31.348	tools	62	scheduler nearby	-	54/51	tool
17:55:31.464	tools	72	unresolved	-	24/20	tool
17:55:31.648	tools	109	scheduler nearby	-	74/73	idle/unmarked
17:55:32.142	tools	111	unresolved	-	58/47	tool
17:55:32.250	tools	58	unresolved	-	34/29	idle/unmarked
17:55:33.262	tools	55	scheduler nearby	-	58/51	tool,changes
17:55:33.384	tools	112	scheduler nearby	-	75/71	tool,changes
17:55:33.632	tools	85	scheduler nearby	-	64/58	idle/unmarked
17:55:33.731	tools	62	unresolved	-	17/10	tool
17:55:33.883	tools	58	unresolved	-	27/27	idle/unmarked
17:55:34.044	tools	76	unresolved	-	42/41	tool
17:55:34.316	tools	64	unresolved	-	20/16	tool
17:55:34.471	tools	87	unresolved	-	14/12	idle/unmarked
17:55:34.593	tools	76	unresolved	-	34/35	tool
17:55:34.730	tools	61	unresolved	-	27/19	idle/unmarked
17:55:34.896	tools	83	unresolved	-	35/28	tool
17:55:35.153	tools	66	unresolved	-	34/34	idle/unmarked
17:55:35.352	tools	61	unresolved	-	21/16	tool
17:55:36.144	tools	56	unresolved	-	26/19	context-scan
17:55:36.261	tools	64	unresolved	-	22/20	tool
17:55:36.487	tools	71	unresolved	-	24/23	idle/unmarked
17:55:36.593	tools	71	unresolved	-	24/20	tool
17:55:36.772	tools	56	unresolved	-	21/20	idle/unmarked
17:55:36.928	tools	97	unresolved	-	51/52	tool
17:55:37.157	tools	51	unresolved	-	19/18	idle/unmarked
17:55:37.325	tools	111	unresolved	-	20/19	tool
17:55:37.627	tools	64	unresolved	-	24/23	tool
17:55:37.895	tools	141	scheduler nearby	-	105/86	idle/unmarked
17:55:38.002	tools	63	unresolved	-	11/13	tool
17:55:38.261	tools	138	scheduler nearby	-	108/97	idle/unmarked
17:55:38.335	tools	54	scheduler nearby	-	38/38	tool
17:55:38.526	tools	151	scheduler nearby	-	98/91	tool
17:55:39.423	tools	71	phase overlap	gc:6	28/23	tool
17:55:39.628	tools	64	unresolved	-	30/25	idle/unmarked
17:55:39.714	tools	52	unresolved	-	11/10	tool
17:55:39.998	tools	51	unresolved	-	6/3	tool
17:55:40.290	tools	60	unresolved	-	26/27	idle/unmarked
17:55:40.396	tools	86	unresolved	-	43/34	tool
17:55:40.492	tools	61	unresolved	-	27/26	tool
17:55:40.642	tools	87	scheduler nearby	-	64/63	idle/unmarked
17:55:40.703	tools	50	scheduler nearby	-	39/37	tool
17:55:40.794	tools	82	unresolved	-	28/27	tool
17:55:41.065	tools	91	unresolved	-	47/45	tool
17:55:41.255	tools	61	unresolved	-	28/27	idle/unmarked
17:55:41.575	tools	59	unresolved	-	13/13	tool
17:55:42.970	tools	60	unresolved	-	19/18	tool
17:55:43.386	tools	50	unresolved	-	21/21	idle/unmarked
17:55:43.537	tools	70	unresolved	-	35/32	tool
17:55:43.628	tools	70	unresolved	-	14/18	idle/unmarked
17:55:43.700	tools	62	unresolved	-	31/30	idle/unmarked
17:55:43.896	tools	97	unresolved	-	50/36	tool
17:55:44.117	tools	97	scheduler nearby	-	71/65	idle/unmarked
17:55:44.250	tools	67	unresolved	-	34/33	tool
17:55:44.370	tools	59	scheduler nearby	-	39/35	idle/unmarked
17:55:44.500	tools	61	unresolved	-	25/22	tool
17:55:44.746	tools	67	unresolved	-	22/16	tool
17:55:45.864	tools	76	unresolved	-	5/4	tool
17:55:46.259	tools	51	unresolved	-	8/7	tool
17:55:47.062	tools	67	unresolved	-	23/16	changes
17:55:48.013	tools	80	unresolved	-	1/1	idle/unmarked
17:55:50.267	tools	77	unresolved	-	2/2	tool
17:55:52.188	tools	76	unresolved	-	7/6	tool
17:55:54.146	tools	60	unresolved	-	14/13	tool
17:55:54.322	tools	51	unresolved	-	15/14	idle/unmarked
17:55:54.412	tools	51	unresolved	-	9/9	tool
17:55:54.593	tools	52	unresolved	-	27/26	idle/unmarked
17:55:54.707	tools	50	unresolved	-	10/12	tool
17:55:54.931	tools	56	unresolved	-	14/13	tool
17:55:55.474	tools	53	unresolved	-	12/12	tool
17:55:56.339	tools	69	unresolved	-	17/16	files,changes,context-scan
17:55:57.413	tools	51	unresolved	-	19/18	tool
17:55:58.005	tools	53	unresolved	-	24/19	idle/unmarked
17:55:58.130	tools	55	unresolved	-	18/11	tool
17:55:58.385	tools	67	unresolved	-	25/23	tool
17:55:58.478	tools	73	unresolved	-	21/18	idle/unmarked
17:55:59.271	tools	140	scheduler nearby	-	126/116	idle/unmarked
17:56:00.136	tools	84	scheduler nearby	-	57/46	tool
17:56:00.722	tools	94	unresolved	-	25/18	tool
17:56:01.070	tools	61	scheduler nearby	-	38/34	changes
17:56:01.188	tools	108	unresolved	-	37/58	changes
17:56:01.364	tools	63	unresolved	-	33/26	idle/unmarked
17:56:01.482	tools	109	scheduler nearby	-	73/86	idle/unmarked
17:56:01.740	tools	61	scheduler nearby	-	45/38	context-scan,files
17:56:01.802	tools	52	scheduler nearby	gc:8	45/40	files,tool
17:56:01.863	tools	51	unresolved	-	15/14	tool
17:56:02.126	tools	113	scheduler nearby	-	78/78	idle/unmarked
17:56:02.301	tools	109	scheduler nearby	-	66/63	tool
17:56:02.498	tools	77	scheduler nearby	-	49/49	idle/unmarked
17:56:02.679	tools	119	scheduler nearby	-	73/71	tool
17:56:02.920	tools	54	unresolved	-	23/22	idle/unmarked
17:56:03.037	tools	66	unresolved	-	21/21	tool
17:56:03.267	tools	107	scheduler nearby	-	73/76	idle/unmarked
17:56:03.504	tools	157	scheduler nearby	-	124/118	tool
17:56:03.716	tools	68	scheduler nearby	-	43/30	idle/unmarked
17:56:03.858	tools	96	scheduler nearby	-	61/54	tool
17:56:04.102	tools	109	unresolved	-	44/40	idle/unmarked
17:56:04.321	tools	129	scheduler nearby	-	82/78	tool
17:56:04.405	tools	55	unresolved	-	31/30	idle/unmarked
17:56:05.409	tools	110	scheduler nearby	-	79/82	tool
17:56:05.671	tools	62	unresolved	-	34/22	idle/unmarked
17:56:05.767	tools	86	unresolved	-	38/37	tool
17:56:05.976	tools	72	phase overlap	gc:8	42/40	idle/unmarked
17:56:06.100	tools	70	unresolved	-	25/23	tool
17:56:06.485	tools	54	scheduler nearby	-	38/33	idle/unmarked
17:56:06.692	tools	115	scheduler nearby	-	75/74	tool
17:56:07.106	tools	113	unresolved	-	38/38	tool
17:56:07.316	tools	78	unresolved	-	46/46	idle/unmarked
17:56:07.636	tools	76	unresolved	-	35/33	tool
17:56:08.276	tools	88	scheduler nearby	-	72/56	room-context,room-enter,changes
17:56:08.631	tools	58	unresolved	-	22/21	tool
17:56:09.124	tools	96	scheduler nearby	-	68/92	tool
17:56:09.405	tools	52	unresolved	-	17/20	tool
17:56:09.508	tools	57	unresolved	-	2/1	tool
17:56:10.043	tools	74	unresolved	-	35/33	tool
17:56:10.311	tools	67	unresolved	-	24/17	changes
17:56:10.995	tools	61	unresolved	-	30/30	idle/unmarked
17:56:11.086	tools	53	unresolved	-	16/14	tool
17:56:11.561	tools	72	unresolved	-	26/25	idle/unmarked
17:56:11.669	tools	54	unresolved	-	18/17	tool
17:56:12.015	tools	128	unresolved	-	45/38	tool
17:56:12.329	tools	60	unresolved	-	11/9	tool
17:56:12.654	tools	56	unresolved	-	9/7	tool
17:56:13.350	tools	56	unresolved	-	15/15	tool
17:56:13.539	tools	70	unresolved	-	34/33	idle/unmarked
17:56:13.626	tools	50	unresolved	-	7/7	tool
17:56:14.117	tools	62	unresolved	-	29/23	idle/unmarked
17:56:14.459	tools	56	unresolved	-	3/3	tool
17:56:14.708	tools	53	unresolved	-	7/5	tool
17:56:15.129	tools	54	unresolved	-	6/6	tool
17:56:16.110	tools	85	unresolved	-	45/42	tool
17:56:16.298	tools	52	unresolved	-	27/23	idle/unmarked
17:56:16.394	tools	55	unresolved	-	18/14	tool
17:56:16.615	tools	64	scheduler nearby	-	42/41	idle/unmarked
17:56:16.760	tools	61	unresolved	-	28/17	tool
17:56:16.861	tools	69	scheduler nearby	-	41/16	idle/unmarked
17:56:17.079	tools	53	unresolved	-	17/8	tool
17:56:17.155	tools	66	unresolved	-	7/6	idle/unmarked
17:56:17.259	tools	64	unresolved	-	18/18	idle/unmarked
17:56:17.629	tools	53	unresolved	-	11/9	tool
17:56:17.957	tools	50	unresolved	-	9/10	tool
17:56:19.385	tools	60	unresolved	-	19/13	tool
17:56:19.665	tools	83	unresolved	-	21/27	tool
17:56:19.774	tools	86	unresolved	-	37/46	tool
17:56:20.374	tools	51	unresolved	-	17/15	idle/unmarked
17:56:20.529	tools	59	unresolved	-	21/17	tool
17:56:21.236	tools	61	unresolved	-	31/25	tool
17:56:21.501	tools	53	unresolved	-	5/3	tool
17:56:22.035	tools	108	unresolved	-	15/12	idle/unmarked
17:56:23.087	tools	54	unresolved	-	9/7	tool
17:56:24.025	tools	51	unresolved	-	15/11	tool
17:56:24.616	tools	91	unresolved	-	6/6	tool
17:56:26.806	tools	73	unresolved	-	5/2	tool
17:56:27.998	tools	52	unresolved	-	26/9	changes
17:56:28.704	tools	85	scheduler nearby	-	55/50	tool
17:56:28.909	tools	83	unresolved	-	6/6	idle/unmarked
17:56:29.749	tools	62	unresolved	-	25/19	idle/unmarked
17:56:29.855	tools	64	unresolved	-	28/38	tool
17:56:31.826	tools	334	unresolved	-	12/12	changes,tool
17:56:31.903	tools	67	unresolved	-	16/13	tool
17:56:32.172	tools	65	unresolved	-	25/23	tool
17:56:32.536	tools	55	unresolved	-	13/13	tool
17:56:33.972	tools	54	unresolved	-	22/21	tool
17:56:34.071	tools	79	unresolved	-	12/9	idle/unmarked
17:56:34.900	tools	67	unresolved	-	40/39	tool
17:56:35.633	tools	76	unresolved	-	34/54	tool
17:56:36.147	tools	155	unresolved	-	35/78	changes
17:56:36.786	tools	112	unresolved	-	36/29	tool
17:56:36.998	tools	69	unresolved	-	38/29	idle/unmarked
17:56:37.098	tools	55	unresolved	-	28/28	tool
17:56:37.224	tools	60	scheduler nearby	-	36/37	idle/unmarked
17:56:37.357	tools	123	scheduler nearby	-	112/112	tool
17:56:37.490	tools	102	unresolved	-	60/63	tool
17:56:37.722	tools	53	unresolved	-	23/21	idle/unmarked
17:56:37.876	tools	86	unresolved	-	43/50	tool
17:56:38.009	tools	59	unresolved	-	26/36	idle/unmarked
17:56:38.131	tools	81	unresolved	-	38/47	tool
17:56:38.377	tools	116	scheduler nearby	-	84/77	idle/unmarked
17:56:38.479	tools	62	unresolved	-	21/21	tool
17:56:38.765	tools	130	scheduler nearby	-	97/90	idle/unmarked
17:56:38.950	tools	83	unresolved	-	43/40	tool
17:56:39.022	tools	62	scheduler nearby	-	44/34	idle/unmarked
17:56:39.661	tools	75	unresolved	-	29/14	files,changes,context-scan
17:56:40.355	tools	52	unresolved	-	23/34	idle/unmarked
17:56:40.440	tools	51	unresolved	-	22/22	tool
17:56:40.667	tools	91	scheduler nearby	-	67/72	idle/unmarked
17:56:41.103	tools	51	unresolved	-	13/13	tool
17:56:41.320	tools	54	unresolved	-	32/36	tool
17:56:41.615	tools	64	unresolved	-	21/14	tool
17:56:41.976	tools	63	unresolved	-	22/18	tool
17:56:42.079	tools	83	unresolved	-	27/24	idle/unmarked
17:56:42.704	tools	52	unresolved	-	29/21	tool
17:56:43.503	tools	67	scheduler nearby	-	41/39	tool
17:56:44.118	tools	85	unresolved	-	13/13	tool
17:56:44.491	tools	62	unresolved	-	18/10	changes
17:56:44.662	tools	110	unresolved	-	53/51	idle/unmarked
17:56:44.961	tools	50	unresolved	-	11/11	tool
17:56:45.152	tools	59	unresolved	-	17/15	tool
17:56:45.332	tools	55	unresolved	-	22/20	idle/unmarked
17:56:45.486	tools	83	unresolved	-	42/52	tool
17:56:46.087	tools	98	unresolved	-	57/53	tool
17:56:46.393	tools	68	unresolved	-	27/24	tool
17:56:46.621	tools	92	unresolved	-	25/22	idle/unmarked
17:56:46.765	tools	56	unresolved	-	14/14	tool
17:56:47.599	tools	69	phase overlap	gc:24	38/37	tool
17:56:47.870	tools	79	unresolved	-	27/27	tool
17:56:48.159	tools	54	unresolved	-	20/21	tool
17:56:48.381	tools	66	unresolved	-	31/28	idle/unmarked
17:56:48.521	tools	69	unresolved	-	36/27	tool
17:56:48.721	tools	56	unresolved	-	12/17	tool
17:56:48.931	tools	80	scheduler nearby	-	58/57	idle/unmarked
17:56:49.098	tools	113	unresolved	-	39/33	tool
17:56:49.281	tools	52	unresolved	-	23/23	idle/unmarked
17:56:49.591	tools	61	unresolved	-	11/10	tool
17:56:49.661	tools	51	unresolved	-	27/24	idle/unmarked
17:56:50.320	tools	59	unresolved	-	31/28	room-context,room-enter,changes
17:56:50.871	tools	61	unresolved	-	35/39	tool
17:56:51.214	tools	53	unresolved	-	23/23	idle/unmarked
17:56:51.321	tools	69	unresolved	-	36/29	tool
17:56:51.400	tools	69	unresolved	-	13/13	idle/unmarked
17:56:51.570	tools	65	unresolved	-	33/33	tool
17:56:51.732	tools	114	scheduler nearby	-	85/85	idle/unmarked
17:56:51.812	tools	59	scheduler nearby	gc:6	54/51	tool
17:56:51.942	tools	91	scheduler nearby	-	87/61	tool
17:56:52.089	tools	51	unresolved	-	14/12	tool
17:56:52.334	tools	63	unresolved	-	14/21	changes
17:56:52.536	tools	100	unresolved	-	53/51	idle/unmarked
17:56:52.883	tools	63	unresolved	-	25/19	tool
17:56:53.137	tools	58	unresolved	-	32/32	idle/unmarked
17:56:53.229	tools	51	unresolved	-	14/15	tool
17:56:53.541	tools	73	unresolved	-	30/24	tool
17:56:53.858	tools	58	unresolved	-	21/18	tool
17:56:54.048	tools	52	unresolved	-	22/17	idle/unmarked
17:56:54.193	tools	103	unresolved	-	16/16	tool
17:56:54.375	tools	61	unresolved	-	27/27	idle/unmarked
17:56:54.483	tools	67	unresolved	-	25/23	tool
17:56:54.800	tools	64	unresolved	-	17/16	tool
17:56:55.715	tools	94	phase overlap	gc:15	25/35	tool
17:56:55.919	tools	52	unresolved	-	16/16	idle/unmarked
17:56:56.015	tools	55	unresolved	-	14/22	tool
17:56:56.340	tools	70	unresolved	-	30/28	tool
17:56:56.561	tools	57	unresolved	-	24/25	idle/unmarked
17:56:56.699	tools	70	unresolved	-	30/28	tool
17:56:56.827	tools	75	unresolved	-	16/16	idle/unmarked
17:56:56.963	tools	59	unresolved	-	21/19	tool
17:56:57.091	tools	64	unresolved	-	36/34	idle/unmarked
17:56:57.213	tools	75	unresolved	-	25/20	tool
17:56:58.544	tools	52	unresolved	-	18/20	tool
17:56:58.784	tools	53	unresolved	-	10/10	tool
17:56:59.396	tools	107	unresolved	-	29/26	tool
17:56:59.829	tools	51	unresolved	-	14/21	tool
17:57:00.087	tools	52	unresolved	-	14/6	tool
17:57:00.886	tools	59	unresolved	-	21/18	tool
17:57:01.015	tools	76	scheduler nearby	-	52/45	idle/unmarked
17:57:01.154	tools	100	unresolved	-	57/52	tool
17:57:01.350	tools	67	unresolved	-	37/37	idle/unmarked
17:57:01.445	tools	51	unresolved	-	5/4	tool
17:57:01.621	tools	106	unresolved	-	22/19	idle/unmarked
17:57:01.766	tools	66	unresolved	-	28/26	tool
17:57:02.014	tools	51	unresolved	-	19/18	tool
17:57:02.141	tools	55	unresolved	-	32/31	idle/unmarked
17:57:02.284	tools	61	scheduler nearby	-	50/37	tool
17:57:02.366	tools	71	scheduler nearby	-	71/71	idle/unmarked
17:57:02.612	tools	62	unresolved	-	37/26	tool
17:57:03.693	tools	70	unresolved	-	10/11	tool
17:57:04.053	tools	108	unresolved	-	32/33	tool
17:57:04.158	tools	75	scheduler nearby	-	66/59	idle/unmarked
17:57:04.312	tools	78	scheduler nearby	-	51/51	idle/unmarked
17:57:04.468	tools	65	scheduler nearby	-	52/34	tool
17:57:04.712	tools	67	unresolved	-	26/25	tool
17:57:04.908	tools	74	unresolved	-	39/27	idle/unmarked
17:57:05.013	tools	57	unresolved	-	14/13	tool
17:57:05.406	tools	53	unresolved	-	24/18	tool
17:57:05.508	tools	77	scheduler nearby	gc:11	59/21	idle/unmarked
17:57:06.528	tools	55	unresolved	-	29/26	tool,changes
17:57:06.996	tools	84	unresolved	-	40/39	idle/unmarked
17:57:07.138	tools	58	unresolved	-	21/19	tool
17:57:08.198	tools	101	scheduler nearby	-	82/82	tool
17:57:08.263	tools	55	scheduler nearby	-	56/50	idle/unmarked
17:57:09.306	tools	95	unresolved	-	15/13	tool
17:57:09.486	tools	50	scheduler nearby	-	32/29	idle/unmarked
17:57:09.659	tools	115	scheduler nearby	-	73/74	tool
17:57:09.822	tools	50	unresolved	-	15/14	tool
17:57:10.016	tools	54	scheduler nearby	-	42/27	idle/unmarked
17:57:10.967	tools	91	unresolved	-	51/70	changes
17:57:11.065	tools	87	unresolved	-	29/48	changes
17:57:11.661	tools	59	unresolved	-	17/16	tool
17:57:11.928	tools	122	unresolved	-	55/53	idle/unmarked
17:57:12.070	tools	53	unresolved	-	14/12	tool
17:57:12.286	tools	54	unresolved	-	10/10	tool
17:57:12.633	tools	61	scheduler nearby	-	38/36	tool
17:57:12.761	tools	55	unresolved	-	23/19	idle/unmarked
17:57:12.864	tools	53	unresolved	-	17/25	tool
17:57:13.158	tools	63	unresolved	-	17/13	tool
17:57:13.711	tools	107	scheduler nearby	-	66/63	tool
17:57:13.784	tools	54	scheduler nearby	-	39/36	idle/unmarked
17:57:14.997	tools	132	phase overlap	gc:20	33/46	tool
17:57:15.568	tools	52	unresolved	-	9/9	tool
17:57:15.848	tools	60	unresolved	-	22/22	tool
17:57:16.238	tools	51	unresolved	-	26/20	idle/unmarked
17:57:16.374	tools	59	unresolved	-	14/15	tool
17:57:16.642	tools	64	unresolved	-	24/19	tool
17:57:17.474	tools	94	unresolved	-	43/25	files
17:57:17.598	tools	53	unresolved	-	19/18	tool
17:57:19.064	tools	90	scheduler nearby	-	63/42	tool
17:57:19.139	tools	64	scheduler nearby	-	59/49	idle/unmarked
17:57:19.712	tools	76	unresolved	-	29/18	idle/unmarked
17:57:20.069	tools	65	unresolved	-	26/25	tool
17:57:20.312	tools	51	unresolved	-	17/13	idle/unmarked
17:57:20.677	tools	75	unresolved	-	27/28	tool
17:57:20.908	tools	63	unresolved	-	29/26	idle/unmarked
17:57:21.036	tools	53	unresolved	-	20/20	tool
17:57:21.261	tools	51	unresolved	-	14/30	tool
17:57:21.783	tools	53	unresolved	-	6/6	tool
17:57:21.927	tools	90	unresolved	-	45/39	tool
17:57:23.002	tools	63	unresolved	-	30/28	tool
17:57:23.435	tools	68	scheduler nearby	-	52/52	idle/unmarked
17:57:23.929	tools	116	scheduler nearby	-	73/83	tool
17:57:24.222	tools	51	unresolved	-	19/18	tool
17:57:24.412	tools	60	unresolved	-	34/26	idle/unmarked
17:57:24.549	tools	76	unresolved	-	34/28	tool
17:57:24.686	tools	75	unresolved	-	9/9	idle/unmarked
17:57:24.759	tools	51	scheduler nearby	-	40/36	tool
17:57:25.511	tools	75	unresolved	-	28/47	changes
17:57:25.599	tools	51	scheduler nearby	-	32/28	changes,files
17:57:26.183	tools	62	unresolved	-	35/55	idle/unmarked
17:57:26.324	tools	55	unresolved	-	17/16	tool
17:57:26.620	tools	63	phase overlap	gc:5	33/31	tool
17:57:26.838	tools	98	unresolved	-	27/29	tool
17:57:27.648	tools	128	scheduler nearby	-	107/89	changes
17:57:27.732	tools	73	unresolved	-	34/28	changes
17:57:27.937	tools	82	unresolved	-	28/25	idle/unmarked
17:57:28.283	tools	66	phase overlap	gc:9	26/22	tool
17:57:28.623	tools	56	unresolved	-	14/14	tool
17:57:28.812	tools	57	unresolved	-	24/14	idle/unmarked
17:57:29.154	tools	63	unresolved	-	20/18	tool
17:57:29.361	tools	72	scheduler nearby	-	49/37	idle/unmarked
17:57:29.603	tools	93	unresolved	-	9/6	idle/unmarked
17:57:29.696	tools	57	unresolved	-	16/13	tool
17:57:30.008	tools	51	unresolved	-	14/10	tool
17:57:30.943	tools	51	unresolved	-	8/8	tool
17:57:31.212	tools	54	unresolved	-	12/12	tool
17:57:31.541	tools	52	unresolved	-	12/10	tool
17:57:31.874	tools	118	unresolved	-	29/20	tool
17:57:35.122	tools	55	unresolved	-	10/13	tool
17:57:35.297	tools	51	unresolved	-	9/9	tool
17:57:35.492	tools	53	unresolved	-	24/20	idle/unmarked
17:57:35.636	tools	64	unresolved	-	27/17	tool
17:57:35.777	tools	77	unresolved	-	40/39	idle/unmarked
17:58:36.418	pressure	54	scheduler nearby	-	56/56	idle/unmarked
17:58:36.786	pressure	67	scheduler nearby	-	67/60	idle/unmarked
17:58:39.023	pressure	66	scheduler nearby	-	92/81	folder-list
```

</details>

## After perf/build (d70c0867)

23 November 2026. Compared the exact `perf/build` commit `d70c0867` against the baseline above (`be8c9625`, recorded at `4de21c0e`). This section is measurement only; the branch does not change the application or protocol.

**The clearest gains were Windows context discovery and remote file I/O.** The ordinary Windows context scan went from **674 / 989 to 346 / 407 ms**, with **161 → 1 runner RPCs**. The 50 KiB read went from 10 RPCs to 1 on all three runners; on Windows it went from **44.6 / 67.0 to 5.0 / 6.7 ms**. Edit used 4 RPCs instead of 13 and fell from **57.7 / 69.2 to 11.1 / 22.4 ms** on Windows. The request counts establish the shorter message chains; they do not separate each optimization's effect.

**Not everything got faster.** Windows Changes on the original small fixture went from **137 / 165 to 147 / 177 ms** in its handler and **200 / 244 to 226 / 273 ms** through the panel paint probe. Native Changes paint also rose, **293 / 485 to 340 / 609 ms**. Loopback Changes paint fell, **158 / 337 to 133 / 191 ms**. The large Mac Bash command rose from **46 / 77 to 72 / 81 ms**. Switching to the Mac in the picker rose from **53 / 133 to 74 / 147 ms** on the existing revalidation mark. Cold session switching improved overall (**201 / 438 → 140 / 256 ms** to first rows), but the saved transcript and fork metadata are server-side; that is not a runner link speedup.

### Repeat method and load

- Used the same Linux server, native Linux and loopback fixture, MacBook and Monolith, same Chromium 153.0.8010.12 at 1440×960, and the same real tailnet path. The copy server had a separate data directory and tailnet bind on port 8897. Read the exact 20, 500 and 5,000 dialogue-entry fixtures from the 8898 SQLite copy in a read transaction, then imported them and forked each history to newly linked fixtures. The code, dependencies and link file of each new remote runner were isolated. The loopback runner used the same address via the local route on Linux. The selected Mac and Windows sessions served only as controls to start and stop the isolated runners. The benchmark ran only on 8897 and did not change the 8898 dataset or either production runner.
- Kept the same 2-CPU limits, signed-in browser harness, same 20 rounds for opens and sheets (480 opens and 400 sheet actions), 12 rounds for tools and panels (432 outcomes), and 20 rounds per host and burst width (240 bursts, 1,040 HTTP requests). The new Windows runner disconnected during web round 13. It resumed with its same link. Kept 12 complete rounds, discarded the incomplete round, and re-ran the remaining 8. The first interrupted attempts at tools and bursts are not in their comparison windows. All 240 warm-device visits used the kept view before the confirmed view; larger histories still required the separate `loadEarlier()` request. Only the additional Windows controls restarted the 8897 server after the main runs.
- All intervals below are milliseconds, **median / p95**; _n_ is the run count, not the number of RPCs. p95 is nearest rank; for 12 samples it is the maximum. `Δ` is new minus old, computed before rounding. Joined 16,714 of 16,714 new runner RPCs by link session and request ID, compared with 21,406 of 21,406 old. Pings are round-trip measurements, not one-way clock differences. The Windows request mix changed, notably by eliminating the 161-RPC context scan, so the overall gate percentiles are not an isolated gate experiment. The folder paint mark still fires on the fresh result, not the first paint from the new in-tab cache. The fresh HTTP columns recalculate both sides on the same unambiguous match, which uses a smaller set than the baseline's handler table. Prefetch requests can start before the action window.
- To make the picker trade-off visible, all `folder-list` handler starts in the web windows (including the extra opens to switch computers and the interrupted Windows segment) were **403 old → 1,559 new**. **1,518** new spans ended without an error. This is total traffic, not requests on the click's critical path. Prefetch adds traffic; the stock paint mark alone cannot tell how much faster a cached list became visible.

**Load gate (1-, 5-, 15-minute averages):** ready 21:21 UTC: 12.10 / 10.27 / 11.70; retry-1 21:26 UTC: 17.25 / 13.40 / 12.63; retry-2 21:31 UTC: 15.94 / 18.32 / 15.22; retry-3 21:36 UTC: 16.28 / 17.28 / 15.61; proceeding 21:36 UTC: 16.28 / 17.28 / 15.61. The 1-minute average stayed above 8 at the last retry, so the timed suite proceeded. The old run did not record `/proc/loadavg`; it was also on a shared host. These are observed comparisons, not isolated effects of the code.

| Set                                  | UTC window        | Load at start (1 / 5 / 15 min) | At end                | 1-minute range (10-second samples + bounds) |
| ------------------------------------ | ----------------- | ------------------------------ | --------------------- | ------------------------------------------- |
| Web: opens and sheets, first segment | 21:36:34–21:40:35 | 16.28 / 17.28 / 15.61          | 15.89 / 16.85 / 15.81 | 14.85–18.18                                 |
| Web: opens and sheets, resumed       | 21:43:44–21:46:16 | 8.77 / 13.03 / 14.51           | 18.90 / 15.25 / 15.11 | 8.77–18.90                                  |
| Tools and panels                     | 21:46:16–21:48:31 | 18.90 / 15.25 / 15.11          | 13.56 / 14.65 / 14.92 | 13.56–18.99                                 |
| Folder bursts                        | 21:48:31–21:48:39 | 13.56 / 14.65 / 14.92          | 13.84 / 14.69 / 14.93 | 13.56–13.84                                 |
| Windows 60-file panel                | 21:48:41–21:49:06 | 14.25 / 14.77 / 14.95          | 15.16 / 14.94 / 15.01 | 14.25–15.27                                 |
| Windows scan and Git-cap controls    | 21:50:19–21:51:13 | 15.02 / 14.97 / 15.01          | 12.32 / 14.26 / 14.77 | 12.32–15.02                                 |

### Open and switch a session

| Host   | Size   | Device copy | n old/new | First rows: old → new (Δ)               | Intact tail: old → new (Δ)              | Full history: old → new (Δ)             | First SSE: old → new (Δ)                  |
| ------ | ------ | ----------- | --------- | --------------------------------------- | --------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Server | small  | cold        | 20/20     | 223 / 662 → 166 / 268 (-57.0 / -394)    | 223 / 662 → 166 / 268 (-57.0 / -394)    | 223 / 662 → 166 / 268 (-57.0 / -394)    | 48.1 / 169 → 52.0 / 82.6 (+3.94 / -86.5)  |
| Server | medium | cold        | 20/20     | 328 / 455 → 192 / 353 (-136 / -102)     | 328 / 455 → 192 / 353 (-136 / -102)     | 429 / 560 → 262 / 455 (-168 / -106)     | 87.3 / 269 → 43.7 / 72.6 (-43.7 / -196)   |
| Server | large  | cold        | 20/20     | 296 / 497 → 201 / 379 (-94.5 / -119)    | 296 / 498 → 201 / 379 (-94.5 / -119)    | 448 / 751 → 308 / 571 (-139 / -181)     | 76.2 / 200 → 52.2 / 120 (-24.0 / -79.3)   |
| Server | small  | warm-device | 20/20     | 106 / 218 → 76.9 / 159 (-28.6 / -59.1)  | 106 / 218 → 76.9 / 159 (-28.7 / -59.1)  | 106 / 218 → 76.9 / 159 (-28.6 / -59.0)  | 6.99 / 285 → 3.82 / 85.4 (-3.17 / -200)   |
| Server | medium | warm-device | 20/20     | 136 / 359 → 101 / 354 (-34.4 / -4.80)   | 136 / 359 → 101 / 356 (-34.4 / -3.10)   | 136 / 361 → 101 / 356 (-34.4 / -5.20)   | 17.5 / 252 → 5.14 / 59.9 (-12.4 / -192)   |
| Server | large  | warm-device | 20/20     | 174 / 328 → 127 / 315 (-47.7 / -13.2)   | 174 / 328 → 127 / 315 (-47.6 / -13.2)   | 375 / 624 → 270 / 509 (-105 / -115)     | 7.38 / 156 → 15.2 / 79.2 (+7.85 / -77.0)  |
| Mac    | small  | cold        | 20/20     | 159 / 357 → 97.2 / 237 (-61.8 / -121)   | 159 / 357 → 97.3 / 237 (-61.8 / -121)   | 159 / 357 → 97.3 / 237 (-61.8 / -121)   | 2.19 / 9.02 → 3.86 / 9.85 (+1.67 / +0.84) |
| Mac    | medium | cold        | 20/20     | 191 / 457 → 141 / 215 (-49.6 / -242)    | 191 / 457 → 142 / 215 (-49.1 / -242)    | 333 / 636 → 231 / 353 (-102 / -283)     | 5.53 / 31.2 → 3.39 / 10.8 (-2.14 / -20.5) |
| Mac    | large  | cold        | 20/20     | 193 / 595 → 171 / 420 (-21.7 / -175)    | 193 / 595 → 171 / 420 (-21.7 / -175)    | 388 / 775 → 315 / 808 (-72.3 / +32.6)   | 15.2 / 255 → 8.43 / 75.3 (-6.73 / -180)   |
| Mac    | small  | warm-device | 20/20     | 92.9 / 242 → 86.0 / 191 (-6.85 / -51.6) | 94.7 / 242 → 86.1 / 191 (-8.65 / -51.6) | 94.7 / 242 → 86.1 / 191 (-8.65 / -51.5) | 1.90 / 7.90 → 3.63 / 14.4 (+1.73 / +6.47) |
| Mac    | medium | warm-device | 20/20     | 146 / 289 → 121 / 221 (-25.5 / -68.7)   | 146 / 289 → 121 / 221 (-25.5 / -68.7)   | 146 / 289 → 121 / 221 (-25.5 / -68.7)   | 1.49 / 18.8 → 3.01 / 6.08 (+1.53 / -12.8) |
| Mac    | large  | warm-device | 20/20     | 186 / 341 → 133 / 223 (-52.5 / -119)    | 186 / 341 → 133 / 223 (-52.4 / -119)    | 314 / 632 → 287 / 402 (-26.5 / -230)    | 4.58 / 14.7 → 6.24 / 16.1 (+1.66 / +1.39) |
| Loop   | small  | cold        | 20/20     | 152 / 256 → 121 / 268 (-31.6 / +11.9)   | 152 / 256 → 121 / 268 (-31.6 / +11.9)   | 152 / 256 → 121 / 268 (-31.7 / +11.9)   | 3.49 / 26.0 → 4.47 / 10.9 (+0.98 / -15.1) |
| Loop   | medium | cold        | 20/20     | 204 / 431 → 168 / 356 (-35.8 / -75.0)   | 204 / 431 → 168 / 356 (-35.8 / -75.0)   | 336 / 800 → 249 / 480 (-87.0 / -320)    | 5.52 / 18.4 → 4.69 / 14.0 (-0.83 / -4.40) |
| Loop   | large  | cold        | 20/20     | 230 / 438 → 175 / 258 (-54.8 / -181)    | 230 / 438 → 176 / 258 (-54.7 / -181)    | 434 / 682 → 315 / 437 (-119 / -245)     | 9.68 / 154 → 11.9 / 54.9 (+2.17 / -99.2)  |
| Loop   | small  | warm-device | 20/20     | 117 / 183 → 121 / 174 (+4.05 / -8.60)   | 117 / 183 → 121 / 174 (+4.05 / -8.60)   | 117 / 183 → 121 / 174 (+4.05 / -8.60)   | 1.83 / 9.57 → 2.74 / 10.5 (+0.91 / +0.92) |
| Loop   | medium | warm-device | 20/20     | 183 / 303 → 135 / 215 (-48.0 / -88.7)   | 183 / 303 → 135 / 215 (-47.9 / -88.7)   | 183 / 303 → 135 / 215 (-47.9 / -88.6)   | 2.18 / 14.9 → 3.07 / 12.1 (+0.89 / -2.77) |
| Loop   | large  | warm-device | 20/20     | 150 / 308 → 129 / 240 (-21.1 / -68.2)   | 151 / 308 → 129 / 240 (-21.1 / -68.2)   | 314 / 507 → 281 / 426 (-32.8 / -80.6)   | 4.89 / 17.1 → 6.73 / 16.0 (+1.84 / -1.16) |
| Win    | small  | cold        | 20/20     | 128 / 305 → 105 / 193 (-23.6 / -112)    | 128 / 305 → 105 / 193 (-23.5 / -112)    | 128 / 305 → 105 / 193 (-23.5 / -112)    | 1.73 / 11.0 → 2.83 / 5.64 (+1.10 / -5.38) |
| Win    | medium | cold        | 20/20     | 216 / 338 → 149 / 256 (-67.5 / -82.7)   | 216 / 338 → 149 / 256 (-67.5 / -82.7)   | 345 / 530 → 232 / 379 (-114 / -151)     | 5.48 / 22.0 → 3.75 / 12.1 (-1.73 / -9.90) |
| Win    | large  | cold        | 20/20     | 252 / 454 → 139 / 219 (-112 / -235)     | 252 / 454 → 139 / 219 (-112 / -235)     | 412 / 723 → 277 / 427 (-135 / -296)     | 7.39 / 59.7 → 8.09 / 50.8 (+0.70 / -8.92) |
| Win    | small  | warm-device | 20/20     | 95.3 / 169 → 90.4 / 213 (-4.85 / +43.8) | 95.3 / 169 → 90.5 / 213 (-4.80 / +43.7) | 95.3 / 169 → 90.5 / 213 (-4.80 / +43.7) | 1.62 / 5.08 → 3.18 / 6.71 (+1.56 / +1.63) |
| Win    | medium | warm-device | 20/20     | 135 / 248 → 138 / 223 (+2.60 / -25.6)   | 135 / 248 → 138 / 223 (+2.65 / -25.7)   | 135 / 248 → 138 / 223 (+2.65 / -25.7)   | 1.69 / 5.78 → 3.12 / 7.60 (+1.43 / +1.82) |
| Win    | large  | warm-device | 20/20     | 182 / 371 → 108 / 262 (-73.4 / -108)    | 182 / 371 → 108 / 262 (-73.4 / -108)    | 389 / 523 → 241 / 512 (-148 / -11.2)    | 3.59 / 19.1 → 6.48 / 17.9 (+2.89 / -1.24) |

| Switch subset | n old/new | First rows old | New       | Δ             | Confirmed view old | New        | Δ            |
| ------------- | --------- | -------------- | --------- | ------------- | ------------------ | ---------- | ------------ |
| cold          | 220/220   | 201 / 438      | 140 / 256 | -61.1 / -183  | 63.6 / 266         | 47.3 / 123 | -16.3 / -143 |
| warm-device   | 220/220   | 132 / 272      | 108 / 217 | -23.9 / -54.4 | 104 / 282          | 85.2 / 176 | -19.1 / -106 |

### Fork sheet and folder picker

| Host   | Action          | n old/new | Paint old   | New         | Δ             | Fresh HTTP old → new (matched n)  | RPCs per matched handler old → new |
| ------ | --------------- | --------- | ----------- | ----------- | ------------- | --------------------------------- | ---------------------------------- |
| Server | fork            | 20/20     | 97.4 / 181  | 64.4 / 162  | -33.0 / -19.9 | 0.28 / 2.80 → 0.30 / 1.24 (20/20) | 0.00 → 0.00                        |
| Server | folder-open     | 20/20     | 112 / 263   | 79.8 / 149  | -31.7 / -114  | 0.49 / 1.81 → 0.57 / 9.03 (10/9)  | 0.00 → 0.00                        |
| Server | folder-into     | 20/20     | 34.1 / 50.4 | 37.9 / 48.7 | +3.70 / -1.70 | 0.44 / 5.56 → 0.59 / 5.71 (17/5)  | 0.00 → 0.00                        |
| Server | folder-up       | 20/20     | 41.5 / 54.1 | 41.3 / 50.3 | -0.30 / -3.80 | 0.45 / 1.59 → 1.11 / 4.27 (18/16) | 0.00 → 0.00                        |
| Server | switch-computer | 20/20     | 41.5 / 86.3 | 46.4 / 99.5 | +4.85 / +13.2 | 0.48 / 1.95 → 0.48 / 1.38 (16/7)  | 0.00 → 0.00                        |
| Mac    | fork            | 20/20     | 92.1 / 164  | 62.7 / 146  | -29.4 / -17.7 | 0.26 / 1.14 → 0.29 / 1.15 (20/20) | 0.00 → 0.00                        |
| Mac    | folder-open     | 20/20     | 113 / 196   | 61.1 / 142  | -51.9 / -53.4 | 14.0 / 83.6 → 16.1 / 40.1 (20/12) | 5.00 → 5.00                        |
| Mac    | folder-into     | 20/20     | 39.1 / 75.9 | 40.1 / 53.0 | +1.05 / -22.9 | 6.62 / 31.8 → 8.70 / 9.14 (17/2)  | 3.00 → 3.00                        |
| Mac    | folder-up       | 20/20     | 42.6 / 59.4 | 42.0 / 67.8 | -0.60 / +8.40 | 11.2 / 47.4 → 13.6 / 28.2 (18/17) | 5.00 → 5.00                        |
| Mac    | switch-computer | 20/20     | 53.2 / 133  | 73.9 / 147  | +20.6 / +13.9 | 18.9 / 52.8 → 7.70 / 72.0 (15/11) | 5.00 → 3.00                        |
| Loop   | fork            | 20/20     | 80.3 / 150  | 58.8 / 121  | -21.6 / -29.3 | 0.26 / 4.44 → 0.26 / 0.87 (20/19) | 0.00 → 0.00                        |
| Loop   | folder-open     | 20/20     | 110 / 253   | 67.8 / 122  | -42.4 / -131  | 9.48 / 137 → 11.5 / 53.7 (14/13)  | 5.00 → 5.00                        |
| Loop   | folder-into     | 20/20     | 40.2 / 62.6 | 45.5 / 59.4 | +5.25 / -3.20 | 4.47 / 22.9 → 6.57 / 11.8 (18/4)  | 3.00 → 3.00                        |
| Loop   | folder-up       | 20/20     | 42.8 / 71.6 | 47.3 / 56.9 | +4.45 / -14.7 | 10.5 / 21.1 → 12.6 / 28.4 (20/16) | 5.00 → 5.00                        |
| Loop   | switch-computer | 20/20     | 84.2 / 199  | 83.5 / 137  | -0.65 / -62.6 | 16.6 / 135 → 16.7 / 55.0 (18/5)   | 3.00 → 3.00                        |
| Win    | fork            | 20/20     | 77.0 / 168  | 61.3 / 119  | -15.7 / -49.1 | 0.32 / 3.96 → 0.26 / 1.57 (20/20) | 0.00 → 0.00                        |
| Win    | folder-open     | 20/20     | 104 / 206   | 89.5 / 170  | -14.8 / -36.7 | 12.4 / 130 → 9.93 / 18.6 (14/13)  | 5.00 → 5.00                        |
| Win    | folder-into     | 20/20     | 39.5 / 51.5 | 46.5 / 52.5 | +7.05 / +1.00 | 6.86 / 17.5 → 8.68 / 16.2 (20/5)  | 3.00 → 3.00                        |
| Win    | folder-up       | 20/20     | 43.1 / 52.1 | 46.8 / 61.3 | +3.60 / +9.20 | 9.96 / 32.7 → 10.5 / 27.8 (19/17) | 5.00 → 5.00                        |
| Win    | switch-computer | 20/20     | 90.7 / 164  | 73.0 / 130  | -17.7 / -34.1 | 48.2 / 80.7 → 12.3 / 17.8 (18/7)  | 23.0 → 7.00                        |

### Pi tools, Files and Changes

| Host   | Action      | n old/new | Total or paint old | New         | Δ             | First output old → new    | Handler old → new         | RPCs median old → new |
| ------ | ----------- | --------- | ------------------ | ----------- | ------------- | ------------------------- | ------------------------- | --------------------- |
| Server | read-small  | 12/12     | 2.15 / 21.9        | 1.63 / 6.06 | -0.52 / -15.8 | 2.16 / 21.9 → 1.64 / 6.07 | — → —                     | 0.00 → 0.00           |
| Server | read-50KiB  | 12/12     | 2.21 / 18.3        | 1.65 / 4.23 | -0.56 / -14.1 | 2.22 / 18.3 → 1.66 / 4.23 | — → —                     | 0.00 → 0.00           |
| Server | edit        | 12/12     | 3.31 / 49.8        | 1.77 / 13.6 | -1.54 / -36.2 | 3.31 / 49.8 → 1.78 / 13.6 | — → —                     | 0.00 → 0.00           |
| Server | write       | 12/12     | 1.22 / 17.0        | 1.98 / 13.9 | +0.76 / -3.17 | 1.22 / 17.0 → 1.98 / 13.9 | — → —                     | 0.00 → 0.00           |
| Server | bash-echo   | 12/12     | 15.9 / 48.5        | 15.4 / 31.2 | -0.54 / -17.3 | 13.5 / 36.7 → 14.3 / 30.4 | — → —                     | 0.00 → 0.00           |
| Server | bash-output | 12/12     | 219 / 381          | 233 / 404   | +13.5 / +23.1 | 212 / 372 → 219 / 384     | — → —                     | 0.00 → 0.00           |
| Server | files-tree  | 12/12     | 66.0 / 200         | 73.0 / 101  | +7.00 / -99.0 | — → —                     | — → —                     | — → —                 |
| Server | file-index  | 12/12     | 12.0 / 27.0        | 12.5 / 68.0 | +0.50 / +41.0 | — → —                     | 0.30 / 15.4 → 0.35 / 35.5 | 0.00 → 0.00           |
| Server | changes     | 12/12     | 293 / 485          | 340 / 609   | +47.0 / +124  | — → —                     | 195 / 360 → 216 / 371     | 0.00 → 0.00           |
| Mac    | read-small  | 12/12     | 3.46 / 5.00        | 4.61 / 6.98 | +1.15 / +1.99 | 3.46 / 5.00 → 4.62 / 6.99 | — → —                     | 1.00 → 1.00           |
| Mac    | read-50KiB  | 12/12     | 25.3 / 32.6        | 8.01 / 13.8 | -17.3 / -18.8 | 25.4 / 32.6 → 8.02 / 13.8 | — → —                     | 10.0 → 1.00           |
| Mac    | edit        | 12/12     | 16.0 / 29.6        | 12.3 / 17.3 | -3.69 / -12.2 | 16.0 / 29.6 → 12.3 / 17.3 | — → —                     | 13.0 → 4.00           |
| Mac    | write       | 12/12     | 4.58 / 6.78        | 6.78 / 8.77 | +2.21 / +1.99 | 4.58 / 6.78 → 6.79 / 8.77 | — → —                     | 2.00 → 2.00           |
| Mac    | bash-echo   | 12/12     | 6.67 / 21.5        | 12.9 / 23.0 | +6.23 / +1.54 | 6.09 / 21.1 → 11.0 / 22.6 | — → —                     | 1.00 → 1.00           |
| Mac    | bash-output | 12/12     | 46.2 / 76.6        | 71.8 / 80.7 | +25.7 / +4.09 | 41.3 / 60.2 → 65.9 / 75.2 | — → —                     | 1.00 → 1.00           |
| Mac    | files-tree  | 12/12     | 69.0 / 116         | 77.0 / 88.0 | +8.00 / -28.0 | — → —                     | — → —                     | — → —                 |
| Mac    | file-index  | 12/12     | 27.0 / 76.0        | 44.0 / 54.0 | +17.0 / -22.0 | — → —                     | 17.1 / 63.3 → 35.5 / 37.8 | 1.00 → 1.00           |
| Mac    | changes     | 12/12     | 144 / 267          | 168 / 232   | +23.5 / -35.0 | — → —                     | 59.1 / 66.1 → 80.2 / 139  | 10.0 → 10.0           |
| Loop   | read-small  | 12/12     | 2.75 / 5.68        | 2.74 / 5.29 | -0.01 / -0.39 | 2.75 / 5.68 → 2.76 / 5.29 | — → —                     | 1.00 → 1.00           |
| Loop   | read-50KiB  | 12/12     | 23.3 / 32.5        | 3.60 / 7.08 | -19.7 / -25.4 | 23.3 / 32.5 → 3.60 / 7.09 | — → —                     | 10.0 → 1.00           |
| Loop   | edit        | 12/12     | 24.0 / 53.5        | 8.24 / 49.6 | -15.8 / -3.92 | 24.0 / 53.5 → 8.25 / 49.6 | — → —                     | 13.0 → 4.00           |
| Loop   | write       | 12/12     | 5.56 / 48.2        | 4.56 / 7.25 | -1.00 / -41.0 | 5.58 / 48.2 → 4.57 / 7.25 | — → —                     | 2.00 → 2.00           |
| Loop   | bash-echo   | 12/12     | 8.57 / 45.9        | 7.20 / 16.4 | -1.37 / -29.5 | 7.31 / 45.5 → 6.22 / 14.1 | — → —                     | 1.00 → 1.00           |
| Loop   | bash-output | 12/12     | 211 / 323          | 198 / 313   | -12.9 / -9.91 | 202 / 293 → 188 / 308     | — → —                     | 1.00 → 1.00           |
| Loop   | files-tree  | 12/12     | 58.5 / 89.0        | 67.0 / 136  | +8.50 / +47.0 | — → —                     | — → —                     | — → —                 |
| Loop   | file-index  | 12/12     | 22.5 / 47.0        | 19.0 / 24.0 | -3.50 / -23.0 | — → —                     | 7.96 / 23.3 → 7.02 / 9.85 | 1.00 → 1.00           |
| Loop   | changes     | 12/12     | 158 / 337          | 133 / 191   | -24.5 / -146  | — → —                     | 69.7 / 200 → 56.0 / 114   | 10.0 → 10.0           |
| Win    | read-small  | 12/12     | 4.29 / 20.4        | 3.95 / 7.50 | -0.34 / -12.9 | 4.30 / 20.4 → 3.95 / 7.51 | — → —                     | 1.00 → 1.00           |
| Win    | read-50KiB  | 12/12     | 44.6 / 67.0        | 5.02 / 6.67 | -39.6 / -60.3 | 44.6 / 67.0 → 5.02 / 6.67 | — → —                     | 10.0 → 1.00           |
| Win    | edit        | 12/12     | 57.7 / 69.2        | 11.1 / 22.4 | -46.7 / -46.8 | 57.8 / 69.2 → 11.1 / 22.4 | — → —                     | 13.0 → 4.00           |
| Win    | write       | 12/12     | 4.93 / 7.64        | 4.67 / 7.93 | -0.27 / +0.29 | 4.94 / 7.65 → 4.67 / 7.94 | — → —                     | 2.00 → 2.00           |
| Win    | bash-echo   | 12/12     | 37.6 / 41.9        | 38.3 / 42.0 | +0.77 / +0.12 | 34.8 / 39.3 → 35.4 / 37.9 | — → —                     | 1.00 → 1.00           |
| Win    | bash-output | 12/12     | 68.6 / 82.4        | 68.1 / 72.2 | -0.58 / -10.2 | 61.8 / 71.2 → 61.1 / 64.5 | — → —                     | 1.00 → 1.00           |
| Win    | files-tree  | 12/12     | 65.0 / 104         | 73.0 / 97.0 | +8.00 / -7.00 | — → —                     | — → —                     | — → —                 |
| Win    | file-index  | 12/12     | 55.0 / 58.0        | 56.5 / 72.0 | +1.50 / +14.0 | — → —                     | 41.6 / 44.3 → 42.8 / 62.7 | 1.00 → 1.00           |
| Win    | changes     | 12/12     | 200 / 244          | 226 / 273   | +26.5 / +29.0 | — → —                     | 137 / 165 → 147 / 177     | 10.0 → 10.0           |

### Parallel folder listings and runner link

| Host   | Parallel | n old/new | Burst old   | New         | Δ             | Individual HTTP old → new | Runner RPCs / burst old → new |
| ------ | -------- | --------- | ----------- | ----------- | ------------- | ------------------------- | ----------------------------- |
| Server | 1        | 20/20     | 2.30 / 9.10 | 2.05 / 3.60 | -0.25 / -5.51 | 2.28 / 9.09 → 2.04 / 3.58 | 0.00 → 0.00                   |
| Server | 4        | 20/20     | 6.70 / 15.2 | 5.32 / 13.9 | -1.38 / -1.26 | 4.06 / 12.7 → 3.80 / 9.09 | 0.00 → 0.00                   |
| Server | 8        | 20/20     | 12.0 / 29.9 | 9.78 / 22.8 | -2.20 / -7.08 | 7.27 / 21.0 → 5.50 / 18.0 | 0.00 → 0.00                   |
| Mac    | 1        | 20/20     | 10.4 / 12.8 | 13.6 / 17.4 | +3.21 / +4.61 | 10.4 / 12.7 → 13.4 / 16.3 | 5.00 → 5.00                   |
| Mac    | 4        | 20/20     | 19.2 / 29.0 | 20.2 / 26.8 | +0.97 / -2.16 | 16.9 / 25.2 → 18.1 / 23.3 | 20.0 → 20.0                   |
| Mac    | 8        | 20/20     | 35.5 / 58.8 | 34.4 / 44.1 | -1.08 / -14.8 | 27.4 / 49.2 → 27.5 / 42.6 | 40.0 → 40.0                   |
| Loop   | 1        | 20/20     | 8.49 / 31.3 | 11.2 / 15.3 | +2.75 / -16.1 | 8.48 / 31.3 → 11.2 / 15.2 | 5.00 → 5.00                   |
| Loop   | 4        | 20/20     | 28.3 / 42.2 | 25.1 / 31.8 | -3.27 / -10.4 | 23.0 / 41.9 → 21.9 / 28.0 | 20.0 → 20.0                   |
| Loop   | 8        | 20/20     | 43.1 / 63.6 | 44.8 / 58.5 | +1.69 / -5.06 | 37.2 / 61.3 → 38.0 / 50.5 | 40.0 → 40.0                   |
| Win    | 1        | 20/20     | 11.3 / 18.1 | 11.3 / 13.8 | +0.01 / -4.31 | 11.3 / 18.1 → 11.3 / 13.8 | 5.00 → 5.00                   |
| Win    | 4        | 20/20     | 18.5 / 34.0 | 15.9 / 22.5 | -2.60 / -11.4 | 14.5 / 30.5 → 13.7 / 21.8 | 20.0 → 20.0                   |
| Win    | 8        | 20/20     | 34.1 / 59.7 | 28.8 / 39.7 | -5.25 / -20.0 | 26.3 / 58.6 → 20.6 / 31.4 | 40.0 → 40.0                   |

| Host | Pings n old/new | RTT old → new (Δ)                         | RPC matches old → new   | First-send queue old → new | Request check old → new   | Gate wait old → new       |
| ---- | --------------- | ----------------------------------------- | ----------------------- | -------------------------- | ------------------------- | ------------------------- |
| Mac  | 60/53           | 1.63 / 71.1 → 1.87 / 40.2 (+0.23 / -30.9) | 4479/4479 → 5302/5302   | 0.04 / 1.13 → 0.04 / 1.01  | 0.17 / 0.65 → 0.21 / 0.80 | 0.02 / 0.57 → 0.02 / 0.41 |
| Loop | 63/54           | 0.64 / 39.3 → 0.54 / 35.8 (-0.10 / -3.44) | 4460/4460 → 5338/5338   | 0.04 / 0.64 → 0.04 / 0.93  | 0.33 / 2.36 → 0.24 / 2.35 | 0.04 / 3.86 → 0.01 / 1.31 |
| Win  | 61/52           | 1.69 / 52.2 → 1.01 / 43.9 (-0.68 / -8.33) | 12467/12467 → 6074/6074 | 0.03 / 1.78 → 0.05 / 1.69  | 0.69 / 7.68 → 0.20 / 0.64 | 0.05 / 350 → 0.00 / 0.55  |

### Context discovery during the matched runs

| Host | Scan n old/new | Old        | New       | Δ             | RPCs per scan, median old → new | One-exec samples old → new |
| ---- | -------------- | ---------- | --------- | ------------- | ------------------------------- | -------------------------- |
| Mac  | 49/46          | 93.0 / 249 | 109 / 158 | +15.5 / -90.9 | 1.00 → 1.00                     | 49 → 46                    |
| Loop | 48/46          | 297 / 655  | 221 / 414 | -76.4 / -241  | 1.00 → 1.00                     | 48 → 46                    |
| Win  | 48/46          | 674 / 989  | 346 / 407 | -328 / -582   | 161 → 1.00                      | 0 → 46                     |

### Windows-only controls

**Context, same session and no scan-cache reuse.** The 8897 server called the ordinary remote scan twice per round, alternating order. The fallback control set the existing internal `scanSettings.shell` switch to `false` for the call, so its time does not include a failed PowerShell attempt. Both paths read the same directories. The trace identifies a successful fast-path run by one `exec` and no listing RPCs, and a forced fallback by no `exec`.

| Path       | n   | Elapsed   | RPCs (median, range) | Execs (median, range) | Verified path n | 1-min load range |
| ---------- | --- | --------- | -------------------- | --------------------- | --------------- | ---------------- |
| powershell | 12  | 328 / 374 | 1 (1–1)              | 1 (1–1)               | 12              | 14.62–15.05      |
| fallback   | 12  | 504 / 584 | 161 (161–161)        | 0 (0–0)               | 12              | 14.62–15.05      |

**Changes with 60 paths.** Each row used the normal panel in Chromium. A few panel requests joined a refresh already in flight; their handler measurements include that earlier start. On one repository all 60 files were tracked and modified; on the other all 60 were untracked. The tracked case uses a bulk Git diff. The untracked case permits a separate `git diff --no-index` per file. On this commit, the limit of 8 is for file stat and edit-path work; the remote untracked-diff limit is `8 × 4 = 32`.

| Windows repository | n   | Panel paint | HTTP handler | Git execs (median, range) | Peak Git RPCs in flight (median, range) | Counts reported (median, range) | 1-min load range |
| ------------------ | --- | ----------- | ------------ | ------------------------- | --------------------------------------- | ------------------------------- | ---------------- |
| tracked            | 12  | 276 / 439   | 162 / 178    | 5 (5–5)                   | 4 (4–4)                                 | 60 (60–60)                      | 14.25–15.27      |
| untracked          | 12  | 531 / 786   | 465 / 627    | 65 (65–65)                | 32 (32–32)                              | 60 (60–60)                      | 14.31–15.27      |

**Git concurrency control.** The same Windows untracked repository, the same `changesIn` code and stat limit, no browser. Only the untracked per-file Git concurrency cap changed. Caps ran in rotating order on Monolith. The peaks count overlapping calls at the server, not CPU cores or proven simultaneous Git execution. This test had no equivalent 60-file baseline row.

| Untracked Git cap | n   | Server operation | Peak per-file Git RPCs (median, range) | Git execs (median, range) | Counts reported (median, range) | 1-min load range |
| ----------------- | --- | ---------------- | -------------------------------------- | ------------------------- | ------------------------------- | ---------------- |
| 1                 | 12  | 2661 / 2771      | 1 (1–1)                                | 65 (65–65)                | 60 (60–60)                      | 12.32–14.89      |
| 8                 | 12  | 520 / 584        | 8 (8–8)                                | 65 (65–65)                | 60 (60–60)                      | 12.32–14.89      |
| 32 (stock)        | 12  | 446 / 473        | 32 (32–32)                             | 65 (65–65)                | 60 (60–60)                      | 12.61–14.89      |

On this Windows fixture, 8 at once did not hurt: it beat serial work, and the stock 32 was faster again at both percentiles. This does not establish an optimum on other hardware or for tracked files. The slower untracked panel used 65 Git commands, whereas the tracked panel used 5; comparing the two panels is not a test of concurrency alone.

**Request-check burst, real Windows runner.** These are gate spans from the same 20 folder bursts per width in the main table, joined by link session and request ID. Times show per-RPC duration pooled within a width, not an additive part of the end-to-end burst percentile.

| Parallel HTTP requests | RPC sample count old → new | Check old → new               | Wait to check old → new       | Peak RPCs in flight old → new |
| ---------------------- | -------------------------- | ----------------------------- | ----------------------------- | ----------------------------- |
| 1                      | 100 → 100                  | 0.154 / 0.280 → 0.154 / 0.233 | 0.007 / 0.017 → 0.003 / 0.008 | 1.0 / 1.0 → 1.0 / 1.0         |
| 4                      | 400 → 400                  | 0.149 / 0.268 → 0.150 / 0.247 | 0.006 / 0.032 → 0.003 / 0.006 | 4.0 / 4.0 → 4.0 / 4.0         |
| 8                      | 800 → 800                  | 0.148 / 0.263 → 0.150 / 0.270 | 0.006 / 0.089 → 0.003 / 0.007 | 8.0 / 8.0 → 8.0 / 8.0         |

### Server event-loop delays over 50 ms

| Set      | Blocks old → new | Per minute old → new | Median / p95 old → new | Max old → new | With nearby scheduler wait old → new | Dropped new trace records |
| -------- | ---------------- | -------------------- | ---------------------- | ------------- | ------------------------------------ | ------------------------- |
| web      | 412 → 140        | 56.5 → 21.4          | 78 / 217 → 69 / 165    | 538 → 372     | 0 → 85                               | 0                         |
| tools    | 394 → 378        | 142.8 → 168.0        | 66 / 127 → 62 / 117    | 334 → 311     | 95 → 62                              | 0                         |
| pressure | 3 → 0            | 17.7 → 0.0           | 66 / 67 → —            | 67 → —        | 3 → 0                                | 0                         |

The same 10 ms timer and threshold were used. “Nearby scheduler wait” means that the main-thread scheduler wait in a close sample window covered at least 60% of the delay, and no known timed synchronous phase covered at least half. This is corroboration, not an attribution of each delay to a cause. Rates normalize for the different window lengths.
