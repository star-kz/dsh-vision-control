# DSH-Vision-Control

**[中文](README.md) | English**

**Real-time visual perception + precise desktop control** — a [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) plugin that gives AI a pair of eyes and a pair of hands.

`@k-launcher/dsh-vision-control` · v1.0.0 · Windows · PolyForm Noncommercial 1.0.0

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

## Installation

Requires DeepSeek Harness ≥ 0.2.1-rc.2 (desktop profile, Windows).

Install from GitHub in the DSH plugin manager:

```
github:star-kz/dsh-vision-control
```

Or pin a release:

```
github:star-kz/dsh-vision-control#v1.0.0
```

> **Dependency**: real-time perception (`computer_watch`) needs an `ffmpeg` build with `ddagrab` support on the system.
> Put it on PATH, or set the environment variable `DSH_FFMPEG_PATH` to point at `ffmpeg.exe`.
> Without ffmpeg the other 15 control tools are unaffected.

## Quick Start

### 0. Give the AI its usage tutorial (recommended)

This plugin ships a **skill** ([skills/dsh-vision-control/SKILL.md](skills/dsh-vision-control/SKILL.md)) — a standard usage tutorial written for the AI: the tool family at a glance, the look → locate → act → confirm workflow, parameter recipes, and troubleshooting. With the skill installed, the AI drives this plugin by best practices instead of trial and error.

To install: copy the whole `skills/dsh-vision-control/` directory into the `.dsh\skills\` folder under your user directory (e.g. `C:\Users\<you>\.dsh\skills\dsh-vision-control\`). New sessions will list `dsh-vision-control` in the skill catalog.

### 1. Grant the capability (once per session)

Find the **computer icon button** (💻) in the composer toolbar and click it:

- Icon lit = granted. In this session the AI may screenshot, watch the screen, move mouse and keyboard, and operate windows.
- Click again = revoked. Every `computer_*` tool refuses immediately.
- Hovering shows the current state (on / off / running / stopping…).

The grant is **per-session**: new sessions start with it off. Subagents never hold this grant — only the main session can operate the computer.

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

## How It Works

Three layers: **grant gate → control layer → perception layer**.

**Grant gate (requireGrant)**: every `computer_*` tool passes the gate first — with the chip off, not a single pixel moves; subagents are always refused.

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
├── client.js           Browser side: composer computer-icon chip (icon + status dot)
├── cordis.patch.yml    Plugin row definition + tokenGuard/appLaunch config
├── backend/            PowerShell execution backend (worker.ps1)
├── internal/           Tool contracts, worker protocol, degraded-mode reports
├── browser/            Browser channel (browser_state / browser_actions)
├── see/                Real-time perception (capture → keep → pack → stitch → register)
└── skills/             AI usage-tutorial skill (dsh-vision-control)
```

## Measured Numbers

Capture first frame ~370ms (ddagrab) / 0.28 cores; cold-start first image ≤3s; blocking calls always return within 860s (ahead of the host's 900s tool timeout).

## License

Released as a whole under **PolyForm Noncommercial 1.0.0** (see [LICENSE](LICENSE)) — free for personal and non-commercial use; commercial use requires a license.

Credits / thanks
-  [dsh-computer-use](https://github.com/LJL454/dsh-computer-use) v1.40.3 (© LJL454, MIT, see [LICENSE-MIT](LICENSE-MIT))
-  [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) v0.0.3 (© SAOS-3624, PolyForm Noncommercial, used with the author's permission), with the floating chat / voice narration / background wake removed

See [NOTICE](NOTICE) for details.
