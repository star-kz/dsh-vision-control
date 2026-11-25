# DSH-Vision-Control

**[中文](README.md) | English**

**Real-time visual perception + precise desktop control** — a [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) plugin that gives AI a pair of eyes and a pair of hands.

`@k-launcher/dsh-vision-control` · v3.0.1 · Windows · PolyForm Noncommercial 1.0.0

---
## Core Purpose
   To solve the two problems most AIs suffer from today: slow reactions and heavy token consumption.
---
## What It Does

| Capability | Description |
|---|---|
| 👁 **Real-time screen watch** | `computer_watch` blocks and returns stitched frames the moment the screen changes; an idle screen costs almost zero tokens |
| 🔍 **Precision reading** | `quality:"high"` delivers a 1280×720 sharp frame in ~0.5s — readable down to file names |
| 🖱 **Screenshot-free control** | UIA reads the control tree directly (coordinates/names/state) — clicking a button costs no image at all |
| ⚡ **Batched actions** | `computer_actions` fires a whole sequence — click → type → Enter → screenshot — in one call |
| ⏳ **Conditional waits** | `wait_for` polls backend-side for "window appeared / text appeared / frame stable" at zero token cost |
| 🛑 **Safety brake** | A chip in the composer toolbar revokes the grant in one click; `computer_stop` releases stuck input and can disable the capability |
| 🚀 **Clean launch** | `app_launch` starts GUI apps stripped of Electron/Node environment pollution |
| 📦 **Output compression** | token-guard compacts oversized shell output into summaries, originals saved to disk |
| 🎯 **Region watch** | `computer_watch` accepts `region` to watch just one screen area — smaller frames, fewer tokens |
| #️⃣ **Frame digest** | `computer_digest` hashes a region; no change, no wake — polling without image cost |
| 🧪 **Dry-run rehearsal** | `computer_actions` with `dry_run:true` rehearses faithfully without dispatching input |
| 🔤 **OCR observation** | Watch can attach Windows OCR text — read screens without guessing glyphs |
| 📜 **Action audit** | Operations can append to a redacted JSONL audit log (off by default) |

## Native Low-Latency Runtime (this branch)

`computer_watch` remains the model’s peripheral vision; the new .NET 8 Worker owns continuous capture, latest-frame buffering, pluggable scene skills, QPC scheduling, and safe stopping in a native fast loop. See [REALTIME.md](REALTIME.md) for builds, the nine `realtime_*` tools, shadow/active boundaries, and measured limitations. Shadow is the default; real input is restricted to an independently verified, dedicated HIL window.

## Installation

Requires DeepSeek Harness ≥ 0.2.1-rc.2 (desktop profile, Windows).

Install from GitHub in the DSH plugin manager:

```
github:star-kz/dsh-vision-control
```

Or pin a release:

```
github:star-kz/dsh-vision-control#v3.0.1
```

> **Dependency**: real-time perception (`computer_watch`) needs an `ffmpeg` build with `ddagrab` support on the system.
> Put it on PATH, or set the environment variable `DSH_FFMPEG_PATH` to point at `ffmpeg.exe`.
> Without ffmpeg the other 15 control tools are unaffected.

## Quick Start

### 0. Give the AI its usage tutorial (recommended)

No manual skill installation is needed. Mode-specific workflows are injected through the host's dynamic system-prompt context. The bundled [SKILL.md](skills/dsh-vision-control/SKILL.md) remains a user-invokable reference, deliberately excluded from automatic model invocation so a disabled session does not even see the computer tools or tutorial.

### 1. Choose one of three modes (per session)

Click the **computer icon** in the composer toolbar, then choose:

- **Disabled (forbidden linear SVG)**: stop watching/realtime runs, revoke access and release input. No computer tool schemas, skill-catalog entry, or computer prompt is injected; a direct stale call still fails with `[NOT_AUTHORIZED]`.
- **Watch only (eye linear SVG)**: screenshots, window/UIA reads, digest/watch, status, shadow/replay and safe cleanup. Writes and realtime active fail with `[CONTROL_REQUIRED]`.
- **Watch + control (computer linear SVG)**: the complete observation and desktop-control workflow.

The collapsed button shows only the current linear SVG. The three choices open vertically in a portal overlay above the composer, without reflowing the conversation. Transitions wait for the authoritative backend response; incomplete stop/release remains visibly warned instead of being reported as success.

Permissions are **per-session**: new sessions start disabled. Subagents can neither observe nor control the desktop. Schema visibility, dynamic prompts and backend execution checks all enforce the mode independently.

### 2. Just say what you want

- "Open the browser to xxx and click login for me"
- "Watch my screen and tell me when my program throws an error"
- "Screenshot this window and read the table on it"

The AI picks the right "eye" and "hand" itself:

| Need | It uses | Cost |
|---|---|---|
| Real-time watch (wait for change, babysit progress) | `computer_watch` (peripheral vision) | ~0 tokens while idle |
| Precision reading (small text, verify details) | `computer_screenshot` (focused gaze) | one image |
| Operate UI elements (buttons / inputs / menus) | `computer_ui` (UIA control tree) | **0 images** |

### 3. Common `computer_watch` parameters

- `watch` (default) / `peek` / `status` / `stop`
- `quality`: `low` (800×450, ≈218 tokens/frame) → `standard` → `high` (file names readable) → `ultra` (near-native). **If you can't read it, step up.**
- `pace`: `calm` (thrifty) / `normal` (default) / `dense` (responsive, recommended while operating)
- `minFrames`: don't return until N frames have accumulated (raise it on idle screens to save tokens)
- `region`: watch only `{x, y, w, h}` (new in 1.1); switching source or region reopens capture
- `ocr`: attach Windows OCR text observation (new in 1.1, gated by the worker capability `ocr.observe`)

## How It Works

Three layers: **grant gate → control layer → perception layer**.

**Three-mode gates**: `disabled` hides schemas and prompts and refuses direct calls; `watch` permits observation and cleanup only; writes and realtime active require `control`. Shared commands use `movesDesktop` to distinguish reads from writes, so bypassing the UI cannot bypass authorization.

**Control layer**: 16 tools registered independently (one failure never sinks the plugin); the execution backend is a PowerShell worker process (UIA control tree, SendInput key/mouse synthesis, screenshots, window enumeration) exchanging JSON with the Node host over pipes. UIA first: a control that can be `Invoke`d never gets a synthesized mouse event.

**Perception layer** (`see/` directory) real-time pipeline:

```
ffmpeg ddagrab screen capture (800×450@12fps, single pipe)
   ↓  per-frame HSV change score → spike detection keeps "worthwhile" frames
   ↓  keep-density drives 8 pacing tiers, deciding grid size
   ↓  single-bin DP packing → burned-in frame numbers → pure-JS PNG encoding (zero deps)
   ↓  scheduling: cold-start eager frame, blocking watch queue, idle throttling
computer_watch returns the stitched image as an attachment
```

**Why it saves tokens**: an idle screen keeps no frames and produces no image; the more the picture moves, the more frames you get. One low-tier stitched image ≈ 218 tokens — about a paragraph of text.

## Directory Layout

```
├── index.js            Host entry: tool registration, grant gate, worker management
├── client.js           Browser side: composer computer-icon chip (icon only + status dot)
├── cordis.patch.yml    Plugin row definition + tokenGuard/appLaunch config
├── backend/            PowerShell execution backend (worker.ps1 + parts/ sources)
├── internal/           Tool contracts, worker protocol, audit, lease, degraded-mode reports
├── browser/            Browser channel (browser_state / browser_actions)
├── see/                Real-time perception (capture → keep → pack → stitch → register)
├── tools/              Build & gate scripts (concat-worker.mjs, check-encoding.mjs)
├── tests/              node:test suites (85 cases)
├── docs/               Worker protocol and other docs
└── skills/             AI usage-tutorial skill (dsh-vision-control)
```

## Measured Numbers

Capture first frame ~370ms (ddagrab) / 0.28 cores; cold-start first image ≤3s; blocking calls always return within 860s (ahead of the host's 900s tool timeout).

## Changelog

### v3.0.1 (2026-11-25)

- Publish the current local 2.0.1 version to GitHub with a 1.0 version increase.
- Includes three permission modes, mode-specific tools and prompts, and the native low-latency runtime with build sources.

### v2.0.1 (2026-11-08)

- **Startup hotfix**: declare `systemPrompt` in the real Cordis `inject` contract, fixing host startup rejection with `cannot get property "systemPrompt" without inject`; add real-host and installed-release regressions.

### v2.0.0 (2026-11-08)

- Three-state linear SVG menu in a vertical portal overlay, with mode-scoped schemas/prompts, authoritative transitions and legacy boolean-state compatibility.
- Mode-aware tool schemas and dynamic prompts; disabled sessions do not receive the computer skill catalog entry.
- Independent backend observation/control gates, including realtime active rejection in watch mode.
- Native .NET 8 realtime runtime, bounded trace, heartbeat/deadline and safe-stop integration.

### v1.1.0 (2026-11-04)

- **New**: `computer_digest` region frame-digest tool; `computer_watch` gains `region` subscription and OCR text observation; `computer_actions` gains `dry_run` faithful rehearsal (zero input dispatch, three-way verdict receipts); redacted JSONL action audit (off by default).
- **Improved**: watch `pace` tiers actually wired; invalid regions are now rejected instead of silently returning stale frames; drag gains dwell, click supports hold; per-cell coordinate mapping annotated; chip state machine refined (observing/ready/busy/watching/stopping — icon only + status dot).
- **Fixed**: inherited upstream bug where batch drag never forwarded `fromLast/continueFrom`; rehearsal now matches real-run semantics (modifier chords, clipboard op enum, continuation handles).
- **Internal**: index.js split into tools/ modules; worker.ps1 now built from parts/ sources (concat-worker.mjs); 85 node:test cases; pure-ASCII ps1 discipline with a gate script.

### v1.0.0 (2026-11-03)

First public release: real-time watch + precise control in one plugin, forked from dsh-see-now and dsh-computer-use and heavily rewritten.

## License

Released as a whole under **PolyForm Noncommercial 1.0.0** (see [LICENSE](LICENSE)) — free for personal and non-commercial use; commercial use requires a license.

Credits / thanks
-  [dsh-computer-use](https://github.com/LJL454/dsh-computer-use) v1.40.3 (© LJL454, MIT, see [LICENSE-MIT](LICENSE-MIT))
-  [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) v0.0.3 (© SAOS-3624, PolyForm Noncommercial, used with the author's permission), with the floating chat / voice narration / background wake removed

See [NOTICE](NOTICE) for details.
