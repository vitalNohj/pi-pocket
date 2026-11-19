# Keep-warm prior art for Pi Pocket

Research date: 2026-11-03. This is research only. No application change or live API experiment was made.

## 1. The 5 most useful ideas

1. **Make the control describe a break, not a cache.** Offer a finite idle window and show its end time. OpenCode uses a 30-minute window. Aider uses a finite ping count. A new real request starts a new window. Keep the advanced controls separate. Sources: [OpenCode warming](https://opencode.ai/v2/docs/warming), [Aider caching](https://aider.chat/docs/usage/caching.html).
2. **Select the refresh interval from the actual request.** OpenCode's `interval: "auto"` uses 90% of `cache.ttl`. `pi-keepwarm` reads Anthropic and OpenAI retention fields. This can remove most manual model-lifetime boxes. Show an override only when detection is not possible. Sources: [OpenCode warming](https://opencode.ai/v2/docs/warming), [pi-keepwarm](https://github.com/cminn10/pi-keepwarm).
3. **Put the state and spend beside the conversation.** Show the next refresh, the stop time, the refresh count, and the spend against the cap. SillyTavern shows a countdown and remaining refreshes. `pi-keepwarm` shows spend in its status bar. Moa includes refresh spend in session totals and a separate Usage row. Sources: [SillyTavern extension](https://github.com/OneinfinityN7/Cache-Refresh-SillyTavern), [pi-keepwarm](https://github.com/cminn10/pi-keepwarm), [Moa PR 91](https://github.com/e-aleixandre/moa/pull/91).
4. **Explain Auto as a bounded cost policy.** Show the estimated refresh price and the budget that remains. The `@vikrant82/opencode-cache-keepalive` plugin limits refreshes to a break-even count per idle gap. It subtracts the resumed request's cache-read cost. Do not label gross avoided writes as net savings. Source: [plugin README](https://github.com/vikrant82/opencode-cache-keepalive).
5. **Offer native long retention before repeated requests.** Claude Code exposes `promptCacheTtl`, separate from any keep-warm mechanism. Anthropic recommends its 1-hour tier for longer gaps. OpenAI and Google also have native retention controls. Show these as alternatives, with their actual prices and limits. Sources: [Claude Code caching](https://code.claude.com/docs/en/prompt-caching), [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Google cache expiration](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-update).

These are design recommendations, not claims that Pi Pocket lacks each protection.

## 2. Evidence rules and search limits

- **Yes** means that a primary source describes periodic requests or expiration updates that preserve an LLM prompt cache.
- **No†** means that no periodic keep-warm control was confirmed in the primary sources examined. It does not prove that the feature is absent.
- Cache annotations, a long TTL, response caching, sticky routing, SSE heartbeats, and keeping local model weights loaded are different features.
- A repository README is a primary source for that project's design. It does not prove that its cost estimate or provider assumption is correct.
- An issue is primary evidence of a user's report. It is not proof of the proposed cause.
- Source branches and provider documentation can change. Most repository links below refer to the branch examined, not a fixed release.

Search used the requested SearXNG endpoint, GitHub repositories and API pages, official documentation, and npm metadata. Results were partial. `unresponsive_engines` reported Google `access denied`, Yep `HTTP error`, and Brave `too many requests`. Later results used the same messages with `Suspended:` prefixes. Some searches returned unrelated results. Negative findings therefore have limited strength.

## 3. Tool summary

| Tool | Has keep warm? | User controls | Default |
| --- | --- | --- | --- |
| Aider | Yes, built in | `--cache-prompts`; `--cache-keepalive-pings N` | Caching off; 0 pings |
| OpenCode v2 | Yes, built in | `warming`; `prompt`; `interval`; `duration` | Off; when enabled: 4-minute interval, 30-minute window |
| `@vikrant82/opencode-cache-keepalive` | Yes, plugin | Session on/off commands; model intervals; host list; replay cap | Enabled after install; 9 successful replays per gap at default prices |
| `aaronpiipponen/opencode-keepalive` | Yes, plugin | Model rules; interval; `maxPrompts`; session class; viewed-idle timeout | Explicit valid config required; unmatched models never warmed |
| Claude Code | No† periodic idle replay confirmed | Native `promptCacheTtl` and `subagentPromptCacheTtl` | Main subscription conversation: 1 hour within included usage; API/credits/cloud: 5 minutes |
| `claude-code-cache-keepalive` | Yes, third-party Claude Code plugin | `interval_seconds`; `max_loops_per_turn`; message | 240 seconds; 7 loops after install |
| `claude-cache-keepalive` | Yes, third-party proxy/patch | Learned policy; enable/disable; horizon and size rules | Policy-dependent; cold-start fallback: chats over 40k tokens for up to 4 hours |
| Moa | Yes, built in | Settings → Cache keep-alive; role switches; `cache_keepalive` config | All roles off |
| `pi-keepwarm` | Yes, extension | `/keepwarm`; duration; USD cap; `autoStart`; retries | Off; activation uses 2 hours, no USD cap, 2 consecutive failures |
| Cline | No† built-in timer confirmed | Ordinary provider configuration; community request exists | No keep-warm default confirmed |
| `valk/cline-keep-alive` | Claimed; implementation does not establish Cline cache reuse | `register_cache_keepalive(context_hash)` | 260-second timer after registration; no finite budget confirmed |
| Roo Code | No† | Cache annotations on real requests | Examined Anthropic adapter omits TTL, thus uses provider default |
| Kilo Code | No† | Request cache policy and optional `ttlSeconds` | Examined LLM policy defaults to `auto`; this is annotation, not a timer |
| Continue | No† | `defaultCompletionOptions.promptCaching: true` | Keep-warm default not confirmed |
| Cursor | No† | Model and usage controls; no keep-warm setting confirmed | Not confirmed |
| Zed | No† | Provider capability `prompt_caching` for compatible APIs | Compatible-provider example uses `false`; not a global claim |
| LibreChat | No† | Native prompt-cache controls on supported Anthropic models | Keep-warm default not confirmed |
| Open WebUI | No† | Stable prompt/context configuration | Keep-warm default not confirmed |
| SillyTavern | Yes, third-party Cache Refresher | Enable; interval; maximum refreshes/output; notifications; indicator | Off; 4.5 minutes; 3 refreshes; 1 output token |
| LiteLLM | No† generic idle refresh loop confirmed | Provider cache parameters; injection; routing affinity | Provider-specific; not one keep-warm default |
| OpenRouter | No† idle ping service confirmed | `cache_control`; TTL; `session_id`; routing | Automatic sticky routing when eligible; stickiness expires after 10 minutes idle |

The Claude Code row describes native retention, not a periodic keep-warm feature. The Cline MCP row is not a verified working implementation.

## 4. Confirmed implementations

### 4.1 Aider: a small, finite ping control

Primary sources:

- [Caching documentation](https://aider.chat/docs/usage/caching.html)
- [`aider/args.py`](https://github.com/Aider-AI/aider/blob/main/aider/args.py)
- [`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py)

**Controls and defaults**

`--cache-prompts` defaults to `False`. `--cache-keepalive-pings` is an integer and defaults to `0`. The same settings can appear in `.aider.conf.yml` as `cache-prompts` and `cache-keepalive-pings`.

The documentation says that N pings cover approximately N × 5 minutes after each user message. The source uses `delay = 5 * 60 - 5`, or 295 seconds. `AIDER_CACHE_KEEPALIVE_DELAY` can override the delay.

**Start and stop**

`warm_cache` requires cache headers, a nonzero ping count, and `ok_to_warm_cache`. It saves the cacheable messages and resets the remaining count. The background worker sends at most N requests before it waits for another reset. Each request uses `max_tokens = 1`. This path does not show a 1-hour TTL selector.

**State and cost**

The startup model line identifies prompt caching. With verbose output, a refresh prints `Warmed ... cached tokens.` Errors print `Cache warming error: ...`. The examined worker does not add a dedicated refresh-dollar total or countdown.

The documentation warns that cache statistics and costs are not available with streaming in the described implementation. It recommends `--no-stream`. This documentation may lag current provider capabilities.

**User reports**

- [Issue 4372](https://github.com/Aider-AI/aider/issues/4372): a Sonnet 4 user enabled caching and 5 pings, but saw no idle pings in Anthropic logs. The issue names Aider 0.84.0. The report does not establish current behavior.
- [Issue 3548](https://github.com/Aider-AI/aider/issues/3548): an OpenRouter Sonnet 3.7 user expected approximately `$0.0042894` per refresh but reported `$0.0378`. The issue names Aider 0.77.0. This is a cost-surprise report, not a verified current billing defect.
- [Issue 4676](https://github.com/Aider-AI/aider/issues/4676): a user expected cache information in the model line and token-cost output but did not see it.

**Lesson:** a finite count is understandable. A silent timer is not sufficient evidence that the cache is warm.

### 4.2 OpenCode v2: one switch, optional advanced timing

Primary source: [official Warming documentation](https://opencode.ai/v2/docs/warming).

**Controls and defaults**

`"warming": true` enables the feature. Omitting it, or setting it to `false`, leaves it off.

The object form accepts:

- `prompt`: a transient instruction to do no work, use no tools, and reply `OK`.
- `interval`: default `"4 minutes"`; accepts `"auto"`.
- `duration`: default `"30 minutes"`.

With `"auto"`, the interval is 90% of the model's `cache.ttl`. A 5-minute TTL therefore gives 4.5 minutes. A model without `cache.ttl` is not warmed in automatic mode.

The documentation gives an Anthropic 1-hour example under `providers.anthropic.settings.cache.ttl: "1h"`. The active window must exceed the refresh interval. Otherwise, OpenCode skips warming and logs a warning.

**Start and stop**

A non-warming model request starts the timers. A later real request resets both timers. A warming request restarts only the interval, not the active window. Default timing permits up to 7 attempts, at minutes 4 through 28.

The warming call uses the current model, agent, instructions, and context. It appends a transient user message and discards the reply. It does not dispatch local tools, continue a tool loop, or add history.

**State, errors, and cost**

The page describes logged failures and warnings. It does not describe a dedicated live cost indicator or USD cap. Failure waits for the next interval while the original window continues. The documentation explicitly warns about tokens, cost, rate limits, and request volume.

No useful primary complaint thread was confirmed in this research.

**Lesson:** `Off / On` can be the main control. Automatic interval and a finite window can do most of the work.

### 4.3 `@vikrant82/opencode-cache-keepalive`: replay plus a cost boundary

Primary sources:

- [Repository README](https://github.com/vikrant82/opencode-cache-keepalive)
- [npm metadata](https://registry.npmjs.org/@vikrant82%2fopencode-cache-keepalive/latest)

npm reported version `0.2.0` during this research. The README describes OpenCode v1.18.33 integration. This is not the same API as the other v2 plugin below.

**Controls and defaults**

- `enabled: true` after the plugin is installed.
- `intervals: { claude: 285000, gpt: 1680000 }`, in milliseconds.
- `hosts: ["githubcopilot.com"]`.
- `cacheReadFactor: 0.1`; `missFactor: 1.0`.
- `maxReplaysPerGap: "auto"`, which gives 9 at those prices.
- `includeChildSessions: false`.
- `replayTimeoutMs: 60000`.
- `maxStoredBytes: 67108864`, or 64 MiB.
- `debug: false`.

Each option also has an `OPENCODE_KEEPALIVE_*` environment variable. The README lists the exact mapping.

`/keepalive-toggle`, `/keepalive-on`, and `/keepalive-off` change the current session. They do not change every session.

**Start and stop**

The plugin captures an eligible real request without modifying it. It replays during idle or tool-busy gaps, without conversation turns. The allowed host, API path, model match, session identity, and child-session policy limit capture.

A real request resets the gap counter. Successful replays stop at the cap. Most transient failures get 1 retry after 10 seconds. HTTP 400, 401, and 403 stop immediately. For Anthropic Messages, zero cache reads with positive cache creation ends warming for that session.

Turning off aborts work and discards the request payload. Turning on requires a fresh eligible request. Request bodies and credentials remain in memory, not telemetry files.

**State and cost**

The TUI footer reports state, time to next refresh, refresh count, resume hit ratio, and gross avoided write tokens. The README explicitly says that `saved` is **gross**, not net of refresh cost. Read usage is recorded separately in logs.

The automatic cap is:

`floor((missFactor - cacheReadFactor) / cacheReadFactor)`

This reserves the resumed request's read cost. It is a price model, not a billing guarantee. The default miss factor is not Anthropic's 1.25× write rate.

The README identifies incomplete live integration verification as a release risk. No independent cost-savings claim was verified here. No useful complaint thread was confirmed.

**Lesson:** show measured usage separately from estimated avoided cost. A break-even label must state its baseline.

### 4.4 `aaronpiipponen/opencode-keepalive`: selective warming

Primary source: [repository README](https://github.com/aaronpiipponen/opencode-keepalive).

This plugin targets OpenCode v2.0.20. It requires a valid configuration. A model without a matching `provider/model` glob is never warmed. The author says not to enable this plugin and built-in warming together.

**Controls and defaults**

Top-level settings include `prompt`, `maxSessions`, `idleTimeout`, `autoTune`, and `logFile`.

- `maxSessions: 0` means no simultaneous-session cap.
- `idleTimeout: 0` disables the viewed-idle cutoff.
- `autoTune: false` is the default.
- No `logFile` means no per-refresh reports.

Each model rule has `enabled`, `maxPrompts`, `interval`, `sessions`, optional `prompt`, and optional `wake`.

- `enabled` defaults to `true` within a configured rule.
- `sessions` defaults to `"top"`; alternatives are `"subagents"` and `"all"`.
- `wake` defaults to `false`.
- `maxPrompts` and interval are explicit rule values, not universal defaults.

The example uses 50 minutes for Claude and 5 prompts. These are example settings, not detected TTLs.

**Lifecycle and visibility**

A real agent-loop request arms the timer. A genuine user prompt begins a new idle spell. Each warm or wake counts toward `maxPrompts` without resetting its own budget.

The plugin stops for archived or removed sessions, the idle-view timeout, or the prompt cap. If `maxSessions` is reached, it drops the least recently active warmed session. Saving config applies it without restart. Invalid config preserves the previous valid configuration.

Normal warming is transient. `wake: true` instead admits a real turn. A log line records `cache read=N write=M`. `autoTune` shortens the interval after a miss, but never below 1/4 of its configured value.

The author states that Anthropic needs its 1-hour tier for a 50-minute interval. The README also limits its validation claim: one compatible provider was tested live. The Anthropic system-prefix correction had offline tests, not a live Anthropic test.

No useful complaint thread was confirmed.

**Lesson:** warm only the model and session that the user expects to resume. A viewed-idle cutoff can prevent abandoned-session spend.

### 4.5 `pi-keepwarm`: the direct local baseline

Primary sources:

- [Repository](https://github.com/cminn10/pi-keepwarm)
- [npm metadata](https://registry.npmjs.org/pi-keepwarm)
- Local `/home/nohj/.pi/agent/npm/node_modules/pi-keepwarm/README.md`
- Local `/home/nohj/.pi/agent/npm/node_modules/pi-keepwarm/extensions/keepwarm/index.ts`
- Local `/home/nohj/.pi/agent/npm/node_modules/pi-keepwarm/extensions/keepwarm/payload.ts`
- Local `/home/nohj/.pi/agent/npm/node_modules/pi-keepwarm/extensions/keepwarm/config.ts`

The local README and all 3 TypeScript files were read. npm search reported version `0.1.1`.

**Controls and defaults**

`/keepwarm` toggles the session. Other commands are `on`, `off`, `status`, and `config`. Activation accepts a duration such as `5h`, `forever`, a USD cap such as `$20`, and `nocap`.

`keepwarm.json` defaults to:

```json
{
  "autoStart": false,
  "duration": "2h",
  "maxCost": null,
  "maxRetries": 2
}
```

A cost cap includes the session's previous keep-warm spend before an off/on cycle. Editing limits while enabled changes only the specified limits. A new duration starts from that change.

**Lifecycle**

The extension captures the real provider payload. It refreshes only while the agent is idle. `agent_start` pauses it; `agent_settled` rearms it. Its README says Pi's built-in streaming warmer covers long in-run gaps.

It detects TTL from Anthropic `cache_control.ttl` and OpenAI retention fields. Model `promptCache` metadata can override that detection. The schedule uses 90% of TTL and at least 15 seconds before expiration. It measures from request start, not response end.

Model changes, compaction, tree navigation, or a timer that fires after expiration invalidate the captured request. A fresh real request rearms warming. It does not deliberately rewrite an already expired cache.

Time, spend, failure count, shutdown, or an explicit off command can stop it. A failure can retry after 15 seconds while time remains. A cache write without a cache read counts as a failed refresh. Runtime state resets when the extension/session reloads.

**State and cost**

The status bar shows active/paused state, next refresh, count, spend, cap, and stop time. `/keepwarm status` adds TTL, last touch, failures, and misses. Refresh entries include provider usage and cost in the session file.

Important limitation: the README says this spend is **not included in Pi's own session cost totals**. The cost cap is checked before a refresh, using spend already incurred. A single unexpected cold write can exceed it.

Anthropic uses a 1-token output cap. OpenAI Responses uses 16. Nothing is added to conversation history.

**Lesson:** preserve the detailed status, but avoid making users understand retention fields before they can choose a short break.

### 4.6 Moa: visible accounting and role-specific policy

Primary sources:

- [Merged PR 91](https://github.com/e-aleixandre/moa/pull/91), merged 2026-10-18
- [`pkg/core/keepalive.go`](https://github.com/e-aleixandre/moa/blob/main/pkg/core/keepalive.go)
- [`pkg/agent/keepalive.go`](https://github.com/e-aleixandre/moa/blob/main/pkg/agent/keepalive.go)
- [Settings UI model](https://github.com/e-aleixandre/moa/blob/main/pkg/serve/frontend/src/components/GlobalSettings/keepalive-model.js)

**Controls and defaults**

Settings → Cache keep-alive has separate switches for owners, sessions, and subagents. `cache_keepalive` is the underlying config. Every role is off by default.

Default periods, once a role is enabled:

- `ping_every_1h`: 55 minutes.
- `ping_every_5m`: 4 minutes 30 seconds.
- `large_context_tokens`: 200,000.
- Owner/session minimum context: 100,000 tokens.

The default horizons are below. Each cell is normal/large context.

| Role | Idle | Waiting for user | Waiting for tool/background work |
| --- | --- | --- | --- |
| Owner | 3 h / 16 h | 12 h / 24 h | 3 h / 3 h |
| Session | 1 h / 3 h | 6 h / 6 h | 3 h / 3 h |
| Subagent | 0 / 0 | 1 h / 1 h | 1 h / 1 h |

These are policy presets, not proof that long warming saves money for every user. A `0` horizon disables that segment.

**Lifecycle and safety**

The PR limits warming to the same Anthropic plan sign-in that served the last request. It excludes API keys, API backup, and OpenAI. Thus its authentication policy differs from API-only Claude plugins.

It replays the last request as a zero-output prewarm. A real request cancels a ping. The clock starts at send time. It does not refresh during a model request. It checks the prefix, model, tools, context revision, compaction, trim state, and deadline before sending.

A ping must be sent before expiration minus a 15-second margin. A stale or changed snapshot stops until a new real request. A failed ping also suspends warming until a new request. Restart forgets snapshots.

**State and cost**

The PR puts ping spend in session totals and Usage → Keep-alive. Settings shows today's spend and estimated savings. The UI model has `spent_today_usd` and `saved_today_usd`. A trace supplies individual events.

No useful complaint thread was confirmed.

**Lesson:** accounting must include background spend. Simple role switches can hide a complex policy, but users still need its effective end time.

## 5. Claude Code and its third-party tools

### 5.1 Native Claude Code: TTL and cache state, not confirmed periodic replay

Primary source: [official prompt-caching documentation](https://code.claude.com/docs/en/prompt-caching).

Claude Code manages ordinary prompt caching. The examined official page does not document a periodic idle keep-warm switch. It documents native lifetime controls instead.

For the main conversation, use `promptCacheTtl` or `CLAUDE_CODE_PROMPT_CACHE_TTL`. For other requests, use `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`. Values are `5m` or `1h`. These controls require v2.1.242 or later.

The documented default is 1 hour for the main conversation within a subscription's included usage. API keys, usage credits, and cloud-provider billing use 5 minutes. Other requests usually use 5 minutes. Some subscription helper requests have a server-selected 1-hour TTL.

`FORCE_PROMPT_CACHING_5M=1` has highest precedence. Bucket environment variables precede bucket settings. `ENABLE_PROMPT_CACHING_1H=1` remains a lower-precedence global request for 1 hour. Gateways must preserve the relevant headers.

`/usage` shows `Prompt cache (main)`: hit ratio, misses, and current warm state. This requires v2.1.251 or later. A likely miss reason requires v2.1.260 or later. Status-line scripts can use `prompt_cache`. These are strong UI examples for Pi Pocket.

A separate `idleCompaction` setting can change a long idle conversation. This is not a keep-warm request.

### 5.2 The important Claude Code issue correction

Primary sources:

- [Issue 46829](https://github.com/anthropics/claude-code/issues/46829)
- [Author's correction](https://github.com/anthropics/claude-code/issues/46829#issuecomment-4233120483)
- [Maintainer explanation](https://github.com/anthropics/claude-code/issues/46829#issuecomment-4237689126)

The issue reports confusion after a change from widespread 1-hour writes to more 5-minute writes. Users describe quota exhaustion, unexpected spend, and a lack of controls.

Do **not** repeat the original dollar-loss estimate as a fact. The author corrected it. The initial analysis treated subagent 5-minute writes as waste. After separating request types, it estimated approximately `$539.63` saved on subagents and at most `$121.64` lost on main sessions. It estimated about `$418` net saved in that dataset. The original `$949` figure was wrong.

The maintainer explains that 1-hour writes cost more. They are wasted when a one-shot request is never resumed. The thread also discusses telemetry-dependent experiment defaults and TTL bugs. Current official documentation now gives explicit controls and billing-dependent defaults.

**Lesson:** users need the selected TTL and the reason for it. Neither “1 hour always saves” nor “every 5-minute write is waste” is sound.

### 5.3 `yujiachen-y/claude-code-cache-keepalive`

Primary source: [repository README](https://github.com/yujiachen-y/claude-code-cache-keepalive).

This plugin uses Claude Code's `Stop` hook. It sleeps and then blocks stopping with an instruction that causes another real turn.

Defaults:

- `interval_seconds: 240`.
- `max_loops_per_turn: 7`, approximately 28 minutes.
- `keepalive_message`: `got it, i need some time to think about the next move`.

`/plugin` can reconfigure it. Environment overrides are `CCKA_INTERVAL`, `CCKA_MESSAGE`, and `CCKA_MAX_LOOPS`. It starts after a completed turn. A real user submission resets the counter. `Esc` interrupts the sleeping hook. Session end cleans up.

Each ping and reply remains in the transcript. The author warns that an unsuitable message can cause tools or long output. The terminal can look stuck while the hook sleeps. The README offers a log file, not a live USD budget display.

The project targets a 5-minute cache. Its README warns that wrong use can cost more. It also claims subscriptions are request-count-gated and therefore always unsuitable. **That precise subscription accounting claim was not confirmed from provider documentation.** Other prior art uses different quota assumptions.

The README repeats the original large billing claim from Claude Code issue 46829. The author of that issue later corrected the math. Therefore the plugin's introductory savings narrative is not reliable evidence.

**Lesson:** do not use ordinary conversation turns or a blocking hook when a transient provider replay is possible.

### 5.4 `brunoqgalvao/claude-cache-keepalive`

Primary source: [repository README](https://github.com/brunoqgalvao/claude-cache-keepalive).

This project provides an opencodex patch and a Claude Code pass-through proxy. It uses 1-hour caching. It replays a captured request with `max_tokens: 16` and drops the connection at the first event.

Installation enables or trains a policy. It can select a probability rule or a fixed duration/context-size rule. With fewer than 200 requests, it keeps contexts over 40k tokens warm for up to 4 hours. With history, it uses observed return intervals and chat sizes. Daily retuning can disable a policy that is not expected to pay.

A separate daily monitor examines 72 hours of results. A measured loss writes a disabled marker. Re-enabling then requires `install.py --enable`.

The dashboard shows warm chats, expiration, next decision, refresh cost, avoided rewrites, and estimated net savings. It also labels outcomes as paid off, wasted, missed, or not needed. A macOS menu item shows savings.

The author reports a 2-week, 61k-request backtest: about 15% less consumption than 1-hour retention without keepalives. **This is one author's modeled result. It was not independently reproduced.** The README explicitly says Anthropic does not publish exact subscription cache-token weighting.

The proxy introduces an availability dependency: Claude Code cannot reach Anthropic if it is down. The patch also changes installed source. Neither installation was run here.

**Lesson:** show whether a refresh helped when the user returns. Do not treat a counterfactual savings estimate as an invoice credit.

## 6. SillyTavern and the questionable Cline MCP implementation

### 6.1 SillyTavern Cache Refresher

Primary sources:

- [README](https://github.com/OneinfinityN7/Cache-Refresh-SillyTavern/blob/master/README.md)
- [`index.js`](https://github.com/OneinfinityN7/Cache-Refresh-SillyTavern/blob/master/index.js)

This is a third-party extension, not a confirmed core SillyTavern feature.

`defaultSettings` contains:

```javascript
{
  enabled: false,
  refreshInterval: 270000,
  maxRefreshes: 3,
  maxTokens: 1,
  showNotifications: true,
  showStatusIndicator: true,
  disableMaxTokens: false
}
```

The UI exposes these settings. The interval input is in minutes. A normal generation captures prompt data. Completion starts a bounded refresh series. A new generation stops it and later restarts it. Changing or leaving the conversation stops the timer.

Refreshes are quiet requests. A floating indicator shows remaining refreshes and the countdown. Successful refreshes can show a toast. The extension does not show a measured running USD total in the examined source.

Its default interval targets a 5-minute lifetime. No automatic native 1-hour selector was confirmed in this extension.

The README warns about other extensions, unstable system prompts, wrong cache depth, history truncation, and refresh intervals above the provider TTL. It supplies cost examples from OpenRouter logs, not a controlled general savings guarantee.

The GitHub issue search found no issue threads for this repository at the research time. This is not evidence of no defects.

**Lesson:** countdown and remaining count communicate useful state without requiring token-price knowledge.

### 6.2 `valk/cline-keep-alive`: do not treat existence as proof

Primary sources:

- [README](https://github.com/valk/cline-keep-alive)
- [`server.py`](https://github.com/valk/cline-keep-alive/blob/main/server.py)
- [Anthropic cache identity requirements](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

The README claims a 260-second idle ping, started by `register_cache_keepalive(context_hash)`. It uses `ANTHROPIC_API_KEY`, coordinates multiple instances with a file lock, and logs to stderr. It describes no finite time or USD limit.

The source fixes `PING_MODEL` to `claude-haiku-3-5-20241022`. It uses the registered hash text as a system prefix and pads it with `ljust(512)`. It does not replay Cline's complete original request.

**Inference from source:** a hash is not the original prefix. Another model also does not share the original model's cache. Therefore this implementation does not establish that it preserves a normal Cline Sonnet/Opus conversation cache. Its successful HTTP response and read-token log are not sufficient proof of that claim.

Do not copy this mechanism. A keep-warm request must address the original cache identity and prefix.

## 7. Other requested tools: what was and was not confirmed

### Cline

Primary sources: [Discussion 414](https://github.com/cline/cline/discussions/414), [current repository](https://github.com/cline/cline), [provider documentation](https://docs.cline.bot/provider-config/anthropic).

Discussion 414 requests prolonged prompt caching. Users describe reviewing diffs, making manual edits, and short interruptions. A commenter explains ping economics and unused cache writes. It is a feature request, not evidence that Cline shipped a timer.

[Issue 190](https://github.com/cline/cline/issues/190) reports unexpected growth in cache-write tokens. This is a separate cache-accounting complaint.

The current repository tree did not reveal a named prompt keepalive/warming module. No built-in timer setting or default was confirmed. The MCP project above is separate.

### Roo Code

Primary source: [`src/api/providers/anthropic.ts`](https://github.com/RooCodeInc/Roo-Code/blob/main/src/api/providers/anthropic.ts).

The examined adapter uses `const cacheControl = { type: "ephemeral" }` on the system prompt and recent user messages. It omits `ttl`. It reports cache reads, writes, and total cost from real requests.

No idle timer, finite warm window, or keep-warm UI control was confirmed. This source supports ordinary 5-minute provider-default caching, not a claim about every Roo provider.

### Kilo Code

Primary sources: [`packages/llm/src/cache-policy.ts`](https://github.com/Kilo-Org/kilocode/blob/main/packages/llm/src/cache-policy.ts), [repository](https://github.com/Kilo-Org/kilocode).

The request policy defaults to `auto`: tools, system, and latest user message get cache hints for protocols that use them. `none` disables automatic placement. An optional `ttlSeconds` enters the hint. These are request-compilation controls.

No periodic prompt-cache warm setting or timer was confirmed. The repository also has MCP and speech-to-text warmup code. Those names do not establish prompt-cache keepalive.

### Continue

Primary source: [Anthropic configuration](https://docs.continue.dev/customize/model-providers/top-level/anthropic).

The documented opt-in is `defaultCompletionOptions.promptCaching: true`. It caches system messages and conversation history between real requests. No periodic keep-warm control was confirmed.

### Cursor

Primary source: [Models documentation](https://cursor.com/docs/models).

The page discusses model usage and cached tokens. No keep-warm switch, interval, cap, or idle-window default was confirmed. Cursor's server-side implementation was not available for inspection. Mark a stronger absence claim as unconfirmed.

### Zed

Primary source: [Use API Access](https://zed.dev/docs/ai/use-api-access).

For Anthropic-compatible custom providers, `prompt_caching` enables explicit `cache_control` breakpoints. The example has `prompt_caching: false` for a compatibility configuration. This is not proof that native Anthropic caching is globally off.

No periodic idle warm control was confirmed.

### LibreChat

Primary source: [Anthropic configuration](https://www.librechat.ai/docs/configuration/pre_configured_ai/anthropic).

The page confirms native prompt-cache controls for supported models and says unsupported models hide those controls in Agent Builder. No background refresh timer or keep-warm default was confirmed.

### Open WebUI

Primary source: [Prompt Caching Optimization](https://docs.openwebui.com/features/chat-conversations/prompt-caching/).

The guide focuses on stable prefixes. It explains how retrieval, citations, memory, tool changes, and terminal context can invalidate caching. It recommends append-only context and provider usage checks.

No periodic hosted-API keep-warm feature was confirmed. Ollama `keep_alive` keeps a local model loaded; it is not proof of hosted prompt-cache refresh.

### LiteLLM

Primary sources: [Prompt Caching](https://docs.litellm.ai/docs/completion/prompt_caching), [Auto Router caching](https://docs.litellm.ai/docs/auto_router/prompt_caching).

LiteLLM passes or translates cache directives. It exposes cached-token usage and cache-aware cost calculations. It supports OpenAI retention fields and current breakpoint options. It can create Google's explicit cache objects from cache annotations.

The router docs discuss model/deployment affinity. The phrase “keep it warm” in that context describes reuse and routing, not a confirmed generic idle ping service. No periodic timer default was confirmed.

The docs warn that explicit Gemini caching incurs storage fees and replaces implicit caching for the moved prefix. Automatic cache injection is therefore not always a free optimization.

### OpenRouter

Primary source: [Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

OpenRouter performs provider sticky routing. Eligible successful requests keep subsequent requests on the same provider. Stickiness expires after 10 minutes of inactivity. A stable `session_id`, `x-session-id`, or fallback `prompt_cache_key` can identify the session.

This does **not** mean OpenRouter sends requests while the client is idle. No such service or default was confirmed.

Anthropic callers can set `cache_control.ttl: "1h"`. Activity details and response usage show cache reads/writes and costs. A stable route helps a keep-warm client avoid refreshing the wrong backend.

## 8. Provider features and recommendations

### 8.1 Anthropic

Primary source: [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), especially Pricing, 1-hour cache duration, and Pre-warming.

**Retention and pricing**

The default is 5 minutes. A successful read refreshes the TTL. Time starts at request start, not response completion.

Set `cache_control: { "type": "ephemeral", "ttl": "1h" }` for 1 hour.

- 5-minute write: 1.25× base input price.
- 1-hour write: 2× base input price.
- Most model reads: 0.1× base input price.
- Current documented exceptions include Opus/Sonnet 5.5 at 0.05× and Fable/Mythos 5.1 at 0.025×.

Therefore, one universal read-price multiplier is not robust.

**Provider recommendation**

Use the 5-minute tier for context already reused more frequently than every 5 minutes. Use 1 hour for likely 5-to-60-minute gaps, long side-agent waits, or latency-sensitive resumptions.

The long tier avoids periodic refresh requests within its lifetime. It is not always cheaper: every new cached token has the higher write rate, even if never reused.

**Zero-output prewarming**

Current documentation supports `max_tokens: 0`. The response has empty content and usage. Anthropic explicitly prefers it over the older 1-token workaround.

Limitations matter. A zero-token request rejects streaming, explicitly enabled extended thinking, structured output format, and forced `tool_choice` of `any` or a named tool. It is also rejected in Message Batches. An implementation must preserve cache identity and respect these restrictions.

A cold prewarm still incurs a write. Zero output does not mean zero cost. The provider recommends the 1-hour tier for longer gaps rather than repeated 5-minute prewarms.

### 8.2 OpenAI: distinguish current and earlier model families

Primary source: [Prompt Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

**Earlier models: `prompt_cache_retention`**

- `in_memory`: typically 5–10 minutes idle, up to 1 hour.
- `24h`: typically around 30 minutes, with possible retention up to 24 hours.
- Support varies by model. GPT-5.5 and GPT-5.5 Pro have `24h` only in the current comparison table.
- For models with both choices, the current guide says non-ZDR organizations default to `24h`; ZDR organizations default to `in_memory`.
- These earlier families do not have an additional cache-write charge in the current comparison table.

The guide recommends `24h` when the model and data-retention requirements allow it.

**Important:** `24h` is not a guaranteed 24-hour idle TTL. A UI must not promise that no miss is possible for that entire period.

**GPT-5.6 and later: new controls**

The current guide distinguishes these models from the earlier retention API:

- `prompt_cache_options.ttl: "30m"` is the default minimum lifetime.
- `"12h"` is an extended minimum lifetime in Responses.
- Writes cost 1.25× and 2.5× ordinary input respectively.
- Reads usually cost 0.1×. GPT-6.1 Sol/Terra use 0.05× in the current guide.
- `prompt_cache_breakpoint.ttl` can override a breakpoint.
- `prompt_cache_options.prewarm: true` prepares a cache without generating output.

A 30-minute read extends coverage by at least 30 minutes. Reading existing 12-hour coverage with a 30-minute request does **not** restart a 12-hour clock. An upgrade from 30 minutes to 12 hours can incur a new write.

**Lesson:** do not implement one generic “every hit restarts the full selected TTL” rule across OpenAI modes. The old `24h` and new `12h` controls are not synonyms.

### 8.3 Google Gemini: explicit cache management can replace pings

Primary sources:

- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
- [CachedContent API](https://ai.google.dev/api/caching)
- [Google Gen AI Python SDK cache examples](https://github.com/googleapis/python-genai/blob/main/README.md#caches)
- [SDK cache update implementation](https://github.com/googleapis/python-genai/blob/main/google/genai/caches.py)
- [Vertex cache creation](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-create)
- [Vertex cache expiration update](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-update)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

**Explicit cache, where supported**

Create a cache object, then reference its name. Set `ttl` or `expire_time`. The SDK has `client.caches.create`, `get`, `update`, and `delete`. Updating `ttl` or absolute expiration does not require a generation ping.

Vertex documentation gives a 60-minute default expiration. It permits changing an unexpired cache's expiration. Once expired, the cache cannot be used or updated and must be recreated. This default is confirmed for Vertex; do not assume identical defaults for every Google endpoint without checking it.

Storage is billed by cached token volume and time. Generation reads have their own price. A TTL update avoids artificial output and repeated generation calls, but retained storage is not free.

**Current model/API limitation**

The current Gemini guide says that Interactions supports implicit caching only. It says explicit cache objects are not supported for Gemini 4 Argon and onward. Explicit caching remains applicable to supported Gemini 3 and 2.5 models through `generateContent`.

Implicit caching is enabled by default for Gemini 2.5 and newer models. The guide recommends stable common prefixes and requests close together. It does not provide a universal keepalive TTL guarantee.

**Lesson:** use a control-plane expiry update when an explicit cache exists. Otherwise, do not invent a guaranteed TTL for implicit caching.

### 8.4 xAI

Primary sources: [Prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching), [Best practices and FAQ](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices).

Caching is automatic. xAI recommends `x-grok-conv-id`, or `prompt_cache_key` for Responses, to route repeated requests to the same server. Keep earlier messages unchanged and append new messages.

The FAQ says entries can be evicted at any time because of load or server restarts. No guaranteed TTL, selectable extended tier, or official idle-ping control was confirmed.

**Lesson:** show retention as unknown or best effort. A heartbeat cannot guarantee a hit on the next real request.

## 9. Cost and usability conclusions for Pi Pocket

These are deductions from the sources, not provider promises.

### 9.1 Name the two clocks separately

**Cache lifetime** is a provider retention property. **Keep-warm duration** is how long the application sends paid refreshes. Mixing them makes `1 h` ambiguous.

A compact UI can say:

- `Keep ready for: Off / 30 min / 1 h / Custom`.
- `Cache retention: 5 min, detected`.
- `Next refresh: 3:45 · Stops: 14:30`.
- `Refresh spend: $0.03 / $0.10`.

These labels are recommendations, not existing controls in another product.

### 9.2 Make the idle gap the normal budget unit

Aider, OpenCode, and both OpenCode plugins tie their normal windows or counts to real activity. A real request can begin a fresh idle allowance. A session-wide absolute cap can remain as a separate safeguard.

A one-time “for this break” action avoids accidental permanent background spend. An optional remembered preference can serve repeat users.

### 9.3 Show spend before claimed savings

Every refresh costs money or quota. A user who never returns gets no avoided rewrite. Gross avoided writes, measured read tokens, and estimated net savings must have different labels.

Moa includes spend in the session total. The local Pi extension explicitly does not. That distinction should be visible when comparing implementations.

### 9.4 Reserve the final read in break-even math

For one fixed prefix, let `W` be the next cold-write cost and `R` the read cost. Ignore output and changing tail tokens for this illustration.

- Without warming: the resumed request costs `W`.
- With N refreshes: refreshes plus resumed read cost `(N + 1) × R`.
- Positive saving requires `(N + 1) × R < W`.

A budget of `W / R` refreshes is a **spend ceiling**, not a guarantee of net savings. It omits the resumed read. The distinction matters when naming Auto.

For the common Anthropic multipliers `W = 1.25`, `R = 0.1`, at most 11 full refreshes still leave positive modeled input savings against one cold rewrite. Other models and tiers differ.

### 9.5 Compare native long retention with the refresh plan

For a fixed prefix, a 1-hour Anthropic write costs `2`. A 5-minute write plus 8 reads costs `1.25 + 8 × 0.1 = 2.05`. In this narrow comparison, native 1-hour retention is already cheaper and sends fewer requests.

That comparison excludes changed tail tokens and the chance that no return occurs. It also assumes the retention choice is made when writing the prefix. It does not prove that switching an existing cache to a longer tier is free.

### 9.6 Stop instead of accidentally warming a cold cache

Useful stop reasons include:

- The deadline or cost limit was reached.
- The last request is already outside its safe retention window.
- The model, tools, or context prefix changed.
- A refresh reported a cache miss.
- Repeated failures occurred.
- The session is archived or no longer viewed.

Show the reason and say when a new real request will rearm the feature. Do not keep a green “warm” indicator after merely successful HTTP requests.

## 10. Unconfirmed claims and exclusions

- No periodic built-in feature was confirmed for Cline, Roo Code, Kilo Code, Continue, Cursor, Zed, LibreChat, Open WebUI, LiteLLM, or OpenRouter. This is not proof of absence.
- Claude Code's native TTL controls are confirmed. Its periodic idle replay was not confirmed.
- The Cline MCP project's claimed preservation of an ordinary Cline conversation cache is not established by its code.
- Third-party savings percentages, proxy backtests, and subscription-quota assumptions were not independently tested.
- The full original loss narrative in Claude Code issue 46829 was corrected by its author. It must not be used as an established overbilling total.
- No useful user complaint thread was confirmed for several small plugins. README caveats were used instead of invented user reports.
- npm results such as `dsh-session-keepwarm`, generic `keep-warm`, and Lambda warmers were excluded. They concern browser residency, general data caches, or server cold starts, not LLM prompt-cache retention.
- Search hits for additional Claude Code mods and other prompt-cache projects were not treated as confirmed features without examining their primary implementation or documentation.
