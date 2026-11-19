## Top 10 costs

**U = the cause also exists at `upstream/main` (`5eb3404`), checked in the same source file. Upstream was not benchmarked.**

1. **Chromium restarts — U, medium.** `src/server/design/render.ts:869` starts Chromium for every render. 52 checks took **173.8s**; design verification took **166.1s**. Keep a bounded browser pool; use fresh isolated contexts.
2. **An abandoned body-read timer — U, small.** `src/server/http/io.ts:73`, `src/server/http/link-routes.ts:109`: a slow-form race leaves a referenced **60s** deadline. `test/public-links.test.ts` took **66.4s**, versus **3.66s** inside tests. Timer stacks confirmed this after app shutdown. Cancel the losing read and its deadline.
3. **Fixed UI sleeps — U, small.** `test/extension-ui.test.ts:164` waits **450ms per navigation**; 18 tests took **88.9s**. `test/mobile-ui.test.ts:1315` includes a **4s** sleep; its file took **79.2s**. Prefer observable state/paint completion.
4. **Eager server imports — U, medium.** `src/server/app.ts:17` brings in the SDK and subsystem graph. Across 6 fresh processes, imports took **1.23–2.90s** of **1.89–4.66s** launch-to-ready. Defer optional subsystems.
5. **Cold-page module waterfall — U, medium.** Static imports in `web/app.js:9`, `:50`, `:76` load composer, sheets, and transcript before their use. Chromium fetched **115 JS modules, 3 CSS files, 2 fonts**, plus HTML/API requests: **0.93MB transferred/2.97MB decoded**. The list was available by **1.14s**. Reduce the critical import graph.
6. **Legacy SSE monolith — U, medium.** `src/server/room.ts:754` sends the full history to old protocols: **13,429,616 bytes** for 6,000 entries. Require paginated protocols or cap old-client payloads. Chromium hold-back was not reproduced.
7. **Full-history hydration — U, large.** `src/server/room.ts:419` reads complete context before showing its tail. Opening 6,000 entries took **632ms**, including **169ms sampled JSON parsing** and a **120ms browser long task**. Read history by page; avoid materializing invisible entries.
8. **Room heap peaks — U, medium.** The same retained history at `src/server/room.ts:417` raised heap from **130MB to 201MB** with 50 retained rooms, 51 resident. Share immutable history and apply a memory budget. This was **not a leak**: heap fell to **74.6MB** after release, 32s, and GC.
9. **Whole-list retransmission — U, medium.** `src/server/app.ts:3099` resends all session metadata. Five messages with a 501-row list caused **503,822 bytes** in list events. Send changed rows instead.
10. **Startup document fan-out — U, medium.** `src/server/app.ts:1204` recovers documents serially; startup made **4,004 snapshot calls**, taking **244–520ms** with 500 sessions. Batch document reads.

## Slowest test files

Seconds, 2 workers. Prefix every name below with `test/`; append `.test.ts`. C = Chromium/checks, W = UI waits/paint, P = process/model waits, T = timer above.

| File | Seconds | Cause |
|---|---:|---|
| design-lint | ≥180* | C |
| design-system-ui | 174.3 | C/W |
| design-lint-pages | 173.8 | C |
| design-verify | 166.1 | C |
| extension-ui | 88.9 | W |
| mobile-ui | 79.2 | W |
| session-open-ui | 77.5 | W/failure |
| pip-board-ui | 71.1 | W |
| public-links | 66.4 | T |
| design-semantics | 62.8 | C |
| background | 60.9 | P |
| design-render | 49.1 | C/failure |
| extensions-hub-ui | 45.5 | W |
| session-row-ui | 45.2 | W |
| updates | 43.7 | git/npm processes |
| launcher-ui | 43.1 | W |
| pip-chat-ui | 42.9 | W |
| font-ui | 42.4 | W |
| pip | 41.3 | scripted long answers |
| design-ui | 41.0 | C/W/failure |

223 files accumulated **56.8 worker-minutes**, **32.3 recorded wall-minutes**, excluding an interrupted earlier batch. Five files failed; one hit the 180s cap. *A focused lint rerun passed 34/34 in **92.3s**; its rank is load-sensitive. Browser reuse and condition-based waits offer the largest suite-wide savings.

## Fast enough

Unprofiled idle CPU: **0.091s/minute** for 50 stored sessions, **0.327s/minute** with one session tab. Twenty HEAD checks cost **1.84ms/minute**; no repeated config saves or room pushes occurred. Hello JSON: **3,429 bytes**; modern large-view JSON maximum: **226,791 bytes**. List refresh plus 2 frames: **12–33ms** for 501 rows. Cached switches: **60–63ms**. Warm submit→model: **7–15ms**; model-end→SSE: **71–78ms**; short replies appeared in **111–124ms** total.

## Scope and artifacts

Fixture: 500 seeded sessions (+1 copy example), 65,880 entries, 300.7MB SQLite. Live counts/sizes alone guided it: 376 sessions, 165,621 entries, 1.3GiB SQLite. No live calls, application changes, commits, runners, or linked computers. All started processes stopped. Large-image decoding, real-provider/drop-in/guard costs, and production-size history remain unmeasured; shared-host load affected timings.

Scripts: `/home/nohj/pi-pocket-perf-core/test/perf-core-{setup,driver,startup,startup-driver,tests,handles}.ts`; `/tmp/perf-core/{profile-summary,test-analysis}.py`. Results, TAP logs, and `*.cpuprofile`: `/tmp/perf-core/`. Use `run-idle.json` for idle CPU, not profiled `run-50.json`; methodology is in `/tmp/perf-core/NOTES.md`.
