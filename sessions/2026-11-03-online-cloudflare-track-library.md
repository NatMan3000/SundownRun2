---
type: auto
session_id: 5292b294-905b-4297-9b5f-bcdd79888910
project: SundownRun2
date: 2026-11-03
topic: Online play on Cloudflare and the cloud track library
duration: 5 hours
events: 592
events_unit: turns
---

# Online play on Cloudflare and the cloud track library

**Project:** SundownRun2
**Purpose:** Let Nathan and Josh race from different houses, then make the online copy the main game
**Duration:** about 5 hours (12:12 to 17:00 AEDT)
**Participants:** Nathan, Kai (Opus 5.5 lead; workers `cloud-relay`, `cloud-share`, `same-track`, `track-library`)
**Session Restart ID:** `claude -r 5292b294-905b-4297-9b5f-bcdd79888910`

## Summary

Nathan asked whether he and Josh could play multiplayer from different houses. Kai first suggested Tailscale or a Cloudflare tunnel to the Mac, then withdrew it once Nathan pointed at the Joshinator security plan (the Mac never hosts for Josh's PC). A neutral server off the home network won: a Cloudflare Worker plus a Durable Object relay sharing one relay brain with the LAN relay. It went live at sundown.nathans-lab.fyi behind Cloudflare Access and a phone-hotspot race showed no noticeable lag. Track sharing was then carried online, a same-track bug from a downloaded shared track was fixed, and the online copy became the main game with a cloud track library keyed to the verified Access login. Hunt Turns scoring got Nathan's ruling. Five feature commits, each deployed.

## What We Did

1. **Where to host (D1, D2):** compared Cloudflare Durable Object, Fly.io Sydney and an Australian VPS; picked the Durable Object (free tier, no box to run, Access in front).
2. **Online relay** (`8467003`, worker `cloud-relay`): `cloud/` holds a Worker serving `dist/` and the relay room as a Durable Object; relay logic extracted to `server/relayCore.ts`, used by both the Bun LAN relay and the DO. https pages connect to `wss://<host>/relay`; LAN unchanged; Report a problem and Share said "home only" online; `workers_dev` and preview URLs off.
3. **Deploy (D3):** the first deploy failed with code 10063 (no workers.dev subdomain on the account); opening Workers & Pages in the dashboard created it. Nathan created the Access app "Sundown Run" (policy "Sundown Players", Google plus One-time PIN, 1-month session) and the custom domain. Every path, the `/relay` WebSocket upgrade included, 302s to Access [live]. Phone hotspot against the home network: works, no noticeable lag.
4. **Sharing online (D4)** (`d762380`, worker `cloud-share`): `server/trackShare.ts` made transport-free with a Node shell `server/trackShareNode.ts`; the Worker ran the same share brain with a `GITHUB_TOKEN` secret.
5. **Same-track bug** (`eec364e`, worker `same-track`): on a track Nathan shared and Josh downloaded, Josh was left out of the race. Share rewrites `author`, so the joiner's copy has the same id but a different file; trackSync held it as `<id>-host`, and the track key `${id}@${hash}` then failed every same-track check (race grid, remote cars, inspector), and also gave a different stunt park and, for seedless files, a different world. Fix: `TrackRuntime.keyId` keeps the host's id in the key, park seed and world seed; one `onOurTrack()` helper; `mp:check` sametrack section; CONSTITUTION section 7 amendment. `mp:check` 142/0. Deployed (D5).
6. **Cloud track library (D6)** (`bd34906`, worker `track-library`): a second SQLite Durable Object `Library` (migration v2); identity from a verified Access JWT (`cloud/access.ts`), owner key a hashed email; Everyone's tracks replaces Share online; first-visit upload, outbox, version check, unique ids, caps; `scripts/library-import.ts` admin import of the GitHub-shared tracks (`LIBRARY_ADMINS` secret). Real logins proven (DAD and JOSH tracks appeared). GitHub track #10 imported to Josh's login; #12 skipped (already uploaded). The `GITHUB_TOKEN` secret was deleted from the Worker: the online copy no longer posts to GitHub.
7. **Hunt Turns scoring** (`a5340fc`): Nathan ruled drifts count for runners, crash props do not. `turns.ts` gameScore is trickScore only; ModeSelect help text updated; `mp:check` turns 44/0; deployed.
8. **Standing deploy yes (D7):** checked, committed SR2 changes deploy online without asking; Access, domain and secret changes still ask (SundownRun2 project memory).

## Key Decisions

| Decision | Rationale |
|---|---|
| Host online play on a Cloudflare Durable Object, not the Mac | The Joshinator security plan forbids the Mac hosting for Josh's untrusted PC; a DO is free, needs no box, and sits behind Access |
| One relay brain (`server/relayCore.ts`) for LAN and cloud | Behaviour can't drift between the two; `cloud/relay.remote.test.ts` runs the same checks on both |
| Track key uses the host's id (`keyId`), not the local renamed id | A renamed `-host` copy must still count as the same track for grid, cars, park and world |
| Online game becomes the main one, with a cloud library under the Access login | Tracks in localStorage are per origin, so the online copy needs its own store; Access gives a verified identity for ownership |
| Online drops GitHub posting (secret deleted) | The library replaces Share online; fewer secrets in the Worker |
| Hunt Turns runners score drifts, not crash props | Nathan's playtest ruling |

## Files Created

- `cloud/` (Worker, relay room DO, `library.ts`, `libraryStore.ts`, `libraryApi.ts`, `access.ts`, `README.md`)
- `server/relayCore.ts`, `server/trackShareNode.ts`
- `src/editor/library/` (browser side of the online library)
- `scripts/library-import.ts`

## Files Modified

- `server/relay.ts`, `server/trackShare.ts`, `src/net/protocol.ts`, `src/net/turns.ts`, `src/ui/screens/ModeSelect.tsx`, `src/editor/Library.tsx`, `src/editor/share/ShareUi.tsx`
- `CONSTITUTION.md` (section 7 amendment for keyId), `CLAUDE.md` (cloud commands, library and relay brains)

## Lessons

- A new Cloudflare account can't deploy a Worker (code 10063) until a workers.dev subdomain exists, even with `workers_dev: false`; opening Workers & Pages in the dashboard creates it.
- Drawn tracks live in localStorage per origin, so the home (localhost or LAN) and online copies keep separate track lists.
- Two players at 60 Hz send about 123 messages a second; WebSocket messages bill 20:1, so the DO free plan's 100k requests a day is about 4.5 hours of two-player driving.
- Any network plan that touches Josh's PC starts from the Joshinator security plan.

## Next Steps

- Nothing open in SundownRun2. The reports token (Joshinator thread) still needs regenerating before 31 Dec 2026 for the home copy.

## Git Status

All committed and pushed: `8467003`, `d762380`, `eec364e`, `bd34906`, `a5340fc`, plus thread and timeline commits. Each feature commit deployed online.

## Related Sessions

- Previous: [2026-11-02 multiplayer fixes and Hunt Turns](2026-11-02-multiplayer-fixes-hunt-turns.md)
- Same day, other repos: Joshinator `docs/security-plan.md` (online route) and `docs/device.md` (Josh's login); HomeLab `docs/cloudflare.md` (the Sundown Run Access app); Kai knowledge-index Joshinator triggers.
