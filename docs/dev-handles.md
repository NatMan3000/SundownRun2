---
type: reference
title: "Sundown Run II dev handles and URL switches"
description: "The window.__game, __dev, __perf and __events handles, the URL switches, and the report, library and share API endpoints used to inspect a running game."
created: 2026-11-15
---
# Sundown Run II dev handles

Moved verbatim from `CLAUDE.md` "Inspecting a running game" on 15 Nov 2026 (lean-rules P3-19). `src/core/devHandles.ts` is the contract; `CLAUDE.md` keeps the fake-GitHub rule.

`src/core/devHandles.ts` is the contract. Every build, dev and production, exposes:

- `window.__game`: read-only getters (telemetry, cars, frame stats, `renderInfo()`, settings, `get('<inspector>')`, `inspectors()`).
- `window.__dev`: commands each system registers; `__dev.help()` lists them (teleport, camera bookmarks, finish a race, hide a look layer, and so on).
- `window.__perf`: the frame report from the last `?demo=1` recording. `window.__events`: recent game events.
- URL switches: `?track=`, `?mode=free|timetrial|race|stunt|tag|turns`, `?tagSeconds=` / `?turnSeconds=` (shorter tag rounds and Hunt Turns turns for checks, read by whoever presses G), `?demo=1`, `?time=0..1`, `?quality=low|medium|high`, `?cam=<bookmark>`, `?ai=<n>`, `?nomusic=1`, `?mp=1&name=&color=` (the relay is `ws://<host>:5202` on LAN; an https page, the online copy, uses `wss://<host>/relay`; `?relay=<port>` overrides either), `?editor=1`, `?engine=muscle|rally|hover`, `?motor=nodes`, `?touch=1` (boot on the phone controls; a mouse can drive them), `?nancheck=1` (on-screen broken-pixel counts), `?hide=<layer>,<layer>`.
- `/api/report` on the dev and preview servers (`server/issues.ts`, the Report a problem screen's post office): `GET` says whether a GitHub key is set up, the version and commit, and how many reports wait in `reports/pending/`; `POST` files one. `__dev.ui('report')` opens the screen. Test only against a fake GitHub (`SR2_ISSUES_API=http://127.0.0.1:<port>`, plus `SR2_REPORTS_DIR` to keep saved reports out of the folder); never the real repository, which is public.
- `/api/library` (online copy only, `cloud/libraryApi.ts`): the online track library. Every drawn track saves itself there under the player's Cloudflare Access login, and the Library's Everyone's tracks lists every player's. `__dev.library('help')` lists checker commands (sync, status, list, state). Who you are is the Access JWT (`cloud/access.ts`), never a bare header; local tests sign their own tokens against a pretend team (`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `cloud/.dev.vars`) or use `SR2_DEV_PLAYER` with `ACCESS_AUD` empty. The game at home never calls it.
- `/api/tracks` on the same servers (`server/trackShare.ts`): the editor Library's Share and Shared tracks. `GET` lists `track`-labelled issues, `POST` shares one. `__dev.share('help')` lists checker commands (list, download, can, share, mine). One brain for both the home server and the online Worker (`cloud/worker.ts`); change sharing in `server/trackShare.ts`. Test only against the fake GitHub (`bun run test:share`, or `bun server/fakeGithub.ts --port <p> --token <fake-key>[:nopush]` with `SR2_ISSUES_API` and `SR2_REPORTS_DIR` as for reports, from an export with no `github-token.txt`); never the real repository.
