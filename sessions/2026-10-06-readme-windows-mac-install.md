---
type: auto
session_id: aaf541cc-b1f7-4a56-aeba-d380bd0bdac9
project: SundownRun2
date: 2026-10-06
topic: README step-by-step install for Windows and Mac + Bun PATH fix
duration: 45 minutes
events: 42
events_unit: turns
---

# README step-by-step install for Windows and Mac

**Project:** SundownRun2
**Purpose:** Make the GitHub README good enough for a non-developer to install and run the game on Windows or Mac
**Duration:** 45 minutes
**Participants:** Nathan, Kai
**Session Restart ID:** `claude -r aaf541cc-b1f7-4a56-aeba-d380bd0bdac9`

## Summary

Rewrote the README "Play it" section into step-by-step setup for Windows and Mac, checked against the actual .bat scripts, package.json and Vite config, then fixed the Mac Bun step after Nathan hit Bun's "Manually add the directory" message on a fresh Mac. Both commits pushed to GitHub.

## What We Did

1. Rewrote "Play it": Windows (Git, Bun via one PowerShell line, clone to Documents, double-click `Sundown Run II.bat`, desktop shortcut, graphics-card fix link) and Mac (Terminal, Git, Bun via curl, clone, `bun install`, `bun run start`, Ctrl+C to stop, updating with `git pull`). Pushed as `09e6b35`.
2. Added a short version for people who already have Git and Bun, and a "Something went wrong?" table (Bun/Git not found, port 5201 in use, dependency install failing, Node too old, slow game, no sound).
3. Corrected gaps in the old README found in the scripts: a ZIP download cannot use the Update .bat (needs a `git clone` folder); Node works for solo play but multiplayer hosting needs Bun; Vite needs Node 20.19+ or 22.12+. Confirmed the public clone URL responds.
4. Diagnosed "Manually add the directory": Bun's installer only edits `~/.zshrc` if it already exists, and a fresh Mac has none. Added `touch ~/.zshrc` before the install line and a troubleshooting row. Pushed as `0670874`. Nathan confirmed `bun --version` prints 1.4.2.

## Key Decisions

| Decision | Rationale |
|---|---|
| Mac setup creates `~/.zshrc` before installing Bun | Bun's installer (read from bun.sh/install) skips PATH setup when the file is missing |
| Say plainly that ZIP copies can't update | The Update .bat relies on a git checkout |

## Files Modified

| File | Change |
|---|---|
| `README.md` | Step-by-step Windows/Mac install, short version, troubleshooting table, zshrc fix |

## Next Steps

- ⬜ Try the steps on a clean Windows PC and a clean Mac (not yet tested end to end)

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- GOTCHA: Bun's macOS install script only adds itself to PATH if `~/.zshrc` already exists; on a fresh Mac it prints "Manually add the directory" and `bun` is not found, so run `touch ~/.zshrc` before `curl -fsSL https://bun.sh/install | bash`, then reopen Terminal.
<!-- /KAI-ATOMS-VERBATIM -->
