---
type: research
title: Ponytail audit of Sundown Run II, 5 Nov 2026, with Kai's spot-check
description: A read-only code audit of main at 3c6b1cd over src, server, cloud and scripts (18 findings, 4 must-fix), every must-fix checked against the code or run live, plus five findings of Kai's own
created: 2026-11-05
---

# Ponytail audit of Sundown Run II, 5 Nov 2026

Run by `~/.claude/skills/PonytailAudit/scripts/run.sh` over a detached worktree of `origin/main` at 3c6b1cd (the game before the time-of-day and final-lap fixes), scope `src/ server/ cloud/ scripts/`, focus on the online login and library rules, GitHub posting, the relay, the NaN firewall, the frozen contracts, the deploy gates, Josh's knob file, the editor's saves and the new crash guard. Ponytail read only; nothing ran inside the audit. Kai's checks follow the report.

The reading is finished, and here is the full report.

**What this repo does:** Sundown Run II is a browser driving game with a road editor, built for Josh and his family. It runs at home from a local server, which can post problem reports and shared tracks to a public GitHub repository. It also runs online on Cloudflare, with a login, a multiplayer relay and a shared track library.

**Load I assumed:** a family, so 2 to 5 players in one room, one browser each, and tens to a few hundred tracks.

**How far this was tested:** `bun` and `curl` were blocked in this session and this copy has no installed packages. Every finding comes from reading the code, and nothing was run. Findings 1 and 11 are the ones most worth confirming by running them first.

## Must fix

1. **Anyone on the wifi can download the GitHub key** (`vite.config.ts:26-31`, `server/mp.ts:69-72`)
   - **What this is:** `bun run mp` starts Vite's dev server with `--host` so friends can load the game. The GitHub key sits in the same folder as `github-token.txt`.
   - **Problem:** Vite's dev server serves files under its root folder, except the few it blocks by default, and this key file is not one of them. So `http://<host-ip>:5201/github-token.txt` should return the key to anyone on that network. This comes from what I know of Vite; I didn't run it or read its source.
   - **Fix:** Add `fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', 'github-token*', 'reports/**'] }` under `server`. Then try `curl -i http://localhost:5201/github-token.txt`, and the same with `?raw`, and expect a refusal. If the first curl returns the key, replace the key if `bun run mp` has ever run on a network you don't trust.
   - **If we skip it:** A guest on the wifi can act on the public repository as Nathan, with whatever rights the key has.

2. **Old ghost laps fill the browser, then tracks stop saving** (`src/vehicle/ghost.ts:96-107`, `src/track/build.ts:492,518`, `src/track/registry.ts:81-89`, `src/editor/draft.ts:253-259`)
   - **What this is:** A best lap is saved as a "ghost" (a replay of the lap) under a key that includes a hash of the road. A two-minute ghost is about 135 KB.
   - **Problem:** Any road edit, slider change or builder version bump creates a new key, and I found no code that ever deletes old ghosts. Browsers commonly allow about 5 MB, so about 40 ghosts fill it. After that, Save says "out of storage". The working copy also stops saving with only a console warning, although the crash screen promises "a road you're drawing is kept".
   - **Fix:** In `saveGhost`, first delete other `sr2.ghost.<same track id>@*` keys. In `writeDrawn`, if a write fails, delete all ghosts and try once more. About 10 lines, plus one check that fills storage first.
   - **If we skip it:** Josh's drawing eventually stops saving. At home there is no online copy to fall back on.

3. **A track changed on two computers can lose this computer's version** (`src/editor/library/sync.ts:393-400`)
   - **What this is:** When both computers changed a track, sync should keep this computer's version as a copy, then take the other version.
   - **Problem:** The result of `saveDrawnTrack(copy)` is ignored. With storage full the copy fails, but the other version still overwrites the track. The log still says the copy was made.
   - **Fix:** If saving the copy returns false, stop and leave the track alone: `if (!saved) continue`.
   - **If we skip it:** Work is lost for good, and finding 2 makes full storage more likely.

4. **An empty library answer deletes the browser's own tracks** (`src/editor/library/sync.ts:374-381`)
   - **What this is:** A track uploaded earlier that is now missing online is treated as deleted on another computer, so it is deleted here too.
   - **Problem:** If the library is reset, or a server bug answers "ok" with an empty list, every unchanged track in every browser is deleted without asking. The browser was the last copy.
   - **Fix:** Before the loop, if the list shows none of your tracks but this browser remembers more than one uploaded under this login, stop the sync and say so. About 4 lines.
   - **If we skip it:** One bad server answer wipes the players' tracks with no undo.

## Should fix

5. **The relay passes on messages only the relay should send, and accepts any website** (`server/relayCore.ts:217-253`, `src/net/client.ts:280-293,323-330`, `src/net/trackSync.ts:150-152`, `cloud/worker.ts:128-132`, `server/relay.ts:599-603`)
   - **What this is:** The relay forwards any JSON message type to all other players, and the browser acts on `welcome`, `host` and `leave` without checking who sent them.
   - **Problem:** One peer sending `{t:'welcome', v:0}` stops everyone else's multiplayer until they reload. A forged `welcome` can also carry a track, which skips the "only the host decides the track" rule (the joiner's validator still checks the file). Neither relay checks the page's origin, so any website open on the host's computer can connect to `ws://localhost:5202`.
   - **Fix:** In the core's switch, add `case 'welcome': case 'host': case 'join': case 'leave': case 'pong': return 'ok'`. Add `callerProblem` in the Worker before `room.fetch`, and an origin hostname check in `relay.ts`. Add one test to `server/relay.test.ts`.
   - **If we skip it:** Any player, or a web page on the host's machine, can knock everyone out of a race.

6. **The phone gate can pass while the game is on the crash screen** (`scripts/phone-gate.ts:1516,1642-1680`, `scripts/touch-check.ts:29`)
   - **What this is:** The gate walks the HUD and editor states and measures what is on screen.
   - **Problem:** CrashGuard now catches render errors, so a crash shows a tidy, well-laid-out screen. A crash in a HUD or editor state skips the "screen did not open" check, and the crash screen itself passes the layout rules. Page errors are only printed in both scripts and never count as failures.
   - **Fix:** After `step.setup`, fail if `[data-testid=crash-screen]` is present, and make `pageerror` a failure. `editor-touch-check.ts:226` already treats page errors this way.
   - **If we skip it:** A build that crashes on phones can get "ALL PASS".

7. **A gate that runs nothing still says ALL PASS** (`scripts/phone-gate.ts:1491,1722`, `scripts/editor-touch-check.ts:4245`)
   - **What this is:** `--only` picks which steps to run.
   - **Problem:** A typo or a renamed step (`--only editro`) matches nothing, runs nothing and exits 0.
   - **Fix:** Count the steps that ran, and exit 2 if the count is zero. Two lines in each script.
   - **If we skip it:** Someone trusts a green result where nothing was checked.

8. **Deploying runs no tests** (`package.json`, the `cloud:deploy` script)
   - **What this is:** Deploy is build, typecheck, upload, and the repo has no automatic test system (CI).
   - **Problem:** Breaking the owner-only rule in `libraryStore.ts` still typechecks, so it deploys. The relay, library, sharing and track checks are never run on the way out.
   - **Fix:** Put `bun test cloud/ server/relay.test.ts && bun run tracks:check &&` in front of the deploy command.
   - **If we skip it:** A broken login or ownership rule goes live with nothing to stop it.

9. **A slow GitHub can post the same public report twice** (`server/issues.ts:278`, `src/ui/report/send.ts:21,91-100`)
   - **What this is:** After posting a report, the server sends up to 10 waiting items before it answers the browser.
   - **Problem:** The browser gives up after 30 s, while each waiting share can take three GitHub calls. The report is already posted, but the browser keeps it and sends it again later.
   - **Fix:** Answer first, then call `sendWaiting` in the background, as sharing already does. Remove `alsoSent` (`issues.ts:278-279`, `protocol.ts:71`, `Report.tsx:696-698`). This deletes code.
   - **If we skip it:** Duplicate issues appear on the public repository after an offline spell.

10. **The "secret" share key is public** (`src/editor/share/protocol.ts:314`, `server/trackShare.ts:264,465`)
    - **What this is:** A track's issue can only be edited by a request holding its share key. The comment promises this protects "somebody else's track".
    - **Problem:** The key is written inside the public issue. Anyone who can reach the home server, including on the wifi during `bun run mp`, can copy it and overwrite Josh's track under the real account.
    - **Fix:** Write `fingerprint(shareKey)` in the issue, and compare hashes. Old issues stay exposed until they are shared again.
    - **If we skip it:** Anyone on the same wifi can overwrite a shared track.

11. **Saving a big track may run out of the Worker's CPU time, and it would never recover** (`cloud/libraryApi.ts:66`, `src/track/validate.ts:554-572`, `src/editor/library/sync.ts:228-235`)
    - **What this is:** The Worker runs the full track validator on each save, including warnings it then throws away. On the free plan a request gets very little CPU time, about 10 ms.
    - **Problem:** The self-crossing check is O(n²). An 8 km road means about 2 million checks, and I didn't measure the time. If the Worker is killed, the answer isn't JSON, so the browser says "offline" and retries forever without telling anyone why.
    - **Fix:** Split the warnings out of `validateTrack`, because the Worker only needs the errors. Then confirm with `wrangler tail` during a big save.
    - **If we skip it:** The biggest tracks may never upload, and nobody is told.

12. **The riskiest sync paths have no test** (`src/editor/library/sync.ts:374-404,412-428`)
    - **What this is:** Sync handles deletes, conflicts and id moves, and any of them can lose a track.
    - **Problem:** I found no test of these paths, only rules tested on the server side. Findings 3 and 4 would both pass today.
    - **Fix:** Add one online scenario to `editor-touch-check.ts` using its fake backend (`editor-backends.ts`): conflict with full storage, plus an empty list. `bun test` can't load `registry.ts` because of `import.meta.glob`, so it has to be a browser check.
    - **If we skip it:** The next change to sync can lose tracks without anyone noticing.

13. **The online game still carries a GitHub path it can't use** (`cloud/worker.ts:53-123`, `server/trackShare.ts:107,232-243`, `cloud/room.ts:43-46`)
    - **What this is:** Online, a share is refused before it reaches the shared code, and the track list is only needed for the one-time import.
    - **Problem:** About 90 lines can't do anything useful once the import is done, and a write-capable `GITHUB_TOKEN` may still sit in the Worker. I couldn't tell from the repo whether the import has run.
    - **Fix:** After the import, delete this path and keep a one-line refusal. `library-import.ts --from-file` can use a saved list from the home game. Run `wrangler secret delete GITHUB_TOKEN`, and update `cloud/README.md`.
    - **If we skip it:** Extra code to maintain, and a key sitting somewhere it isn't needed.

14. **Near-copies that must change together** (`server/issues.ts:437-481,555-557,625-627,674-684,756-759`, `server/trackShare.ts:382-`, `cloud/worker.ts:76-92`, `src/editor/share/protocol.ts`)
    - **What this is:** There are two GitHub callers, two `cleanToken`, two address checks (`apiBase`, `githubApi`), and two copies each of `oneLine` and `noMentions`.
    - **Problem:** They already differ: only sharing reads GitHub's rate-limit header, so reports rely on matching words in the message. A fix to one copy can miss the other.
    - **Fix:** Build `postOnce` on `githubCall`, and keep one copy of each helper.
    - **If we skip it:** Reports and sharing keep drifting apart.

## Nice to have

15. **A short Cloudflare outage looks like a lost login** (`cloud/access.ts:111-117`)
    - **What this is:** Login keys are fetched again after an hour.
    - **Problem:** If that fetch fails, the key already held isn't used. Players are told to log in again, and sync stops retrying.
    - **Fix:** If the fetch fails and the cached key has this `kid`, use it. About 3 lines. The old key stays valid for days after a change.
    - **If we skip it:** Odd login messages during a short outage.

16. **A failed room rebuild leaves players connected but unheard** (`cloud/room.ts:84-105`)
    - **What this is:** After waking, the room rebuilds itself from its sockets and its saved memory.
    - **Problem:** If reading the memory fails, the rebuild is skipped. Connected players aren't listed, and new ids start again at 1 and can clash with theirs.
    - **Fix:** In the `catch`, call `this.core.restore(connections, null)`, and move `connections` outside the `try`.
    - **If we skip it:** A rare storage failure breaks the room until everyone reconnects.

17. **One damaged save wipes all drawn tracks** (`src/track/registry.ts:71-79,145-148`)
    - **What this is:** If the saved tracks can't be read, `readDrawn` returns an empty list.
    - **Problem:** The next save then writes that empty list plus one track, replacing the damaged data for good.
    - **Fix:** On a read failure, copy the raw text to `sr2.tracks.drawn.broken` and refuse the save.
    - **If we skip it:** Rare, but it is total and can't be recovered at home.

18. **Saving during an id move can drop the newest edit** (`src/editor/library/sync.ts:414-420`)
    - **What this is:** When the library gives a track a new id, sync moves its copy of the file there.
    - **Problem:** It uses the copy from before the upload. A Save during that moment is replaced in the Library, while the editor shows it as saved.
    - **Fix:** Re-read the track from the registry just before the move. One line.
    - **If we skip it:** The newest edit can go missing in rare cases.

I left out 3 smaller ones: unknown track fields going public, a set in the room that only grows, and a bad URL answering 500.

**What held up:**
- The login token check and the library's owner rules are sound.
- Admin import is checked properly, with no bare-header trust.
- The NaN firewall covers poses, bumps and rewind on every path I read, and I found no gap.
- Josh's knob file holds its promise: out-of-range values were clamped or guarded everywhere I checked.
- The crash guard and WebGL loss path read as correct.
- The GitHub key is ignored by git, and no history of that file turned up.

**Verdict:** Fix 1 first, today. Then 2 to 4, because they protect Josh's tracks.

**Lean:** -145 lines, -0 dependencies possible.

**Not checked:**
- **Not run:** the tests, gates, `tsc`, Vite and the Worker. The CPU cost in 11 is calculated, not measured. Vite's behaviour in 1 is from what I know of it, not checked on the installed version 8.
- **Not read:** `server/mp-check*.ts`, `src/track/gates.ts`, `selftest.ts`, `build.ts` beyond the track key, and `schema.ts` and `types.ts`.
- **Read in part:** `draft.ts` (save paths only), `carSim.ts` (searched for what reaches rapier), and the two big gate scripts (their setup and how they decide pass or fail).
- **Not checked at all:** the live Cloudflare and Access settings, such as whether the login cookie is sent on cross-site connections, and the iPhone simulator scripts.

## Kai spot-check (5 Nov 2026, 23:28 AEDT)

Every Must fix checked against the code at 3c6b1cd, finding 1 run live.

| # | Verdict | How |
|---|---|---|
| 1 | ✅ confirmed, live | A Vite dev server started from a clean copy of main with a fake `github-token.txt` answered `GET /github-token.txt` with `200 text/plain` and the file's contents. `vite.config.ts` sets no `server.fs.deny`. The real key is in the game folder on this Mac, gitignored, never committed. `/.env` and `/reports/` also answered 200, but that is the single-page fallback (index.html), not those files. |
| 2 | ✅ confirmed by reading | `src/vehicle/ghost.ts` has `setItem` and no `removeItem`; `writeWorking` in `draft.ts` only warns when storage is full. Not measured: how many ghosts fit. |
| 3 | ✅ confirmed by reading | `sync.ts:395` `quietly(() => saveDrawnTrack(copy))` ignores the result, then `saveDrawnTrack(got.file)` overwrites. |
| 4 | ✅ confirmed by reading | `sync.ts:374-381`: an uploaded track missing from the list and unchanged here is deleted here, with no check that the list is plausible. |

Should-fix items read, not run: 5 (the relay's switch and the client's `welcome` case are where the report says), 6 and 7 (`pageerror` is only logged in `phone-gate.ts:1516` and `touch-check.ts:29`; `ALL PASS` prints whenever no failure was recorded), 8 (`package.json` confirms deploy is build, typecheck, upload), 10 (`protocol.ts:314` writes `share=<key>` into the public issue body). 9 and 11 to 18 not checked.

### Kai's own findings, outside Ponytail's scope

- **`TASKS.md` is a dead ledger.** 108 ⬜ and 28 ⚠️ rows for systems that were built weeks ago (input, the car sim, the camera, ramps, terrain), and `CLAUDE.md` tells every fresh session to read it for "what is done". Its "Found along the way" list still holds real unfixed items worth a look: a pad's first d-pad press firing twice, a live switch to Neutral tone mapping rendering black, clean landings scored as crashes.
- **`bun run test:share` is red on this Mac only.** `bun test server/trackShare.test.ts` matches the file name anywhere, and `data/worktree-patches-2026-10-21/` (untracked, gitignored, 2.5 MB, a leftover from 21 Oct) holds a stale copy. Trashing that folder fixes it.
- **Report a problem posts device details to the public repository under the child's login**: GPU, browser, screen, changed settings (#11). Not secrets, but a fingerprint of the family's machines in public. A call for Nathan: keep, or trim the public part and keep the detail in `reports/`.
- **Deploying runs no gate** (Ponytail's 8, confirmed): the lead runs the checks by hand before `bun run cloud:deploy`. A `cloud:check` script that `cloud:deploy` runs first would make that a rule.
- **Open GitHub issues:** #9 (Josh's elevation control idea, 3 Oct: banked curves digging in, road height, which road goes over), #11 (editor "glitchy, music buggy", 5 Oct, build 80170a3, long superseded), #10 and #12 (shared tracks, as designed).

### Not done

The share and track checks were run (`tracks:check` clean, 5 track files); `test:cloud` and `test:relay` pass on main. Nothing was fixed. The audit's report was kept out of the public mirror until finding 1 is fixed.
