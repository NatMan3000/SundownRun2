---
type: reference
title: "Sundown Run II command table"
description: "Every bun script for running, checking, deploying and proving Sundown Run II: tracks, physics, multiplayer, online copy, phone gates, iOS simulator, icons."
created: 2026-11-15
---
# Sundown Run II commands

Moved verbatim from the `CLAUDE.md` command table on 15 Nov 2026 (lean-rules P3-19). The Play, Typecheck, track-check, headless probe, physics, Learn To Code and standing deploy rows stay in `CLAUDE.md`.

| What | Command |
|---|---|
| Multiplayer host / relay alone | `bun run mp` / `bun run relay` |
| Two-client multiplayer proof / relay tests | `bun run mp:check` / `bun run test:relay` |
| Online copy (Cloudflare Worker + Durable Object relay), locally | `bun run cloud:dev` -> https://127.0.0.1:5211 (self-signed); setup and deploy: `cloud/README.md` |
| Online track library: one-time import of the GitHub shared tracks (lead, after deploy) | `bun scripts/library-import.ts --map "JJ=<email>,DAD=<email>" --token "$(cloudflared access token -app=https://sundown.nathans-lab.fyi)" --dry-run` (`cloud/README.md`) |
| Online checks | `bun run test:cloud`; with cloud:dev up, `bun run mp:check --cloud https://127.0.0.1:5211 --only client,game` |
| Phone controls proof (real touch events, needs a preview running) | `bun run touch:check 5220` |
| Phone gate: every screen and HUD state at the phone windows, and the Road Editor's with `--only editor` (`--port`, `--window pwa\|safari\|small`, `--only <step>`, `--out`, `--list`) | `bun run phone:check -- --port 5220` (`scripts/phone-gate.ts`; the standard is `spec/phone-landscape-standard.md`) |
| Road Editor's map with real fingers: arm, pinch, two-finger drag, twist, cancels, the tool button and its tray, a real mouse at 1920x1080 (`--window pwa\|safari`, `--only 1,2`, `--out`; needs a preview running) | `bun run editor:touch -- --port 5220` (`scripts/editor-touch-check.ts`) |
| Real Mobile Safari on the iPhone 17 Pro simulator (rotate, shot, tap, drag, pinch, sweep; one script at a time). The simulator never gates a deploy: Chrome at the phone windows plus the diff read is enough (Nathan, 5 Nov 2026) | `bash scripts/ios-sim/shot.sh "http://localhost:5220/?nomusic=1" /tmp/a.png` (`scripts/ios-sim/README.md`) |
| Regenerate the Home Screen icons from `public/icons/icon.svg` | `bun run icons` |
