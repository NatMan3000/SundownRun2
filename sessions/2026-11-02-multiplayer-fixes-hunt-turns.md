---
type: auto
session_id: a996ef9c-a141-42fb-a3b0-9a4afab22353
project: SundownRun2
date: 2026-11-02
topic: Multiplayer playtest fixes and the Hunt Turns mode
duration: 5 hours
events: 650
events_unit: turns
---

# Multiplayer playtest fixes and the Hunt Turns mode

**Project:** SundownRun2
**Purpose:** Fix what a live two-computer multiplayer playtest turned up, then find a chase mode that is actually fun
**Duration:** about 5 hours (16:48 to 22:00 AEDT)
**Participants:** Nathan, Josh, Kai
**Session Restart ID:** `claude -r a996ef9c-a141-42fb-a3b0-9a4afab22353`

## Summary

Nathan and Josh played two-computer multiplayer live: Josh's PC ("Joshinator") hosted and Nathan's Mac joined in a browser, so both ran Josh's copy of the game until Josh ran `Sundown Run II Update.bat`. Three multiplayer flow bugs were fixed (results wait, laps disagreement, a stuck round blocking G), the Xbox pad passed so the build thread was closed, and tag got a hunter boost. A four-agent design council then recommended Crown Rush, which Nathan rejected on first principles; Hunt Turns (take turns hunting in a new walled arena, Thunder Bowl) was built instead and, after his playtest, turned into a points game. Six commits, all verified and pushed.

## What We Did

1. **D1 results on finish** (`f49de83`): a multiplayer race only ended when everyone had finished or 45 s after the first finisher, so a finisher sat on a waiting screen. Results now open the moment you cross the line; other players' times fill in as they finish (a "Racing" label until then), and Again / G waits for everyone, capped at 45 s.
2. **Build thread closed:** "Finish Sundown Run II build" resolved, the Xbox pad tested in play and two-computer multiplayer passed.
3. **D2 host decides laps** (`a6f3a39`): the stats message carries `raceLaps`; whoever presses G, the host's Laps setting applies, and a joiner's Laps slider is locked to the host's number.
4. **D3 leaving a round** (`12c6f7f`): tag would not start ("Waiting", G and X did nothing) because an earlier race nobody finished never ended, so `requestStart` refused (F5 was the workaround). Leaving a round (mode or track change, title, editor) now sends a `quit`; the others stop waiting for you, and a start made meanwhile picks you up. New `mp:check` leave section.
5. **D4 tag hunter boost** (`a44cb35`): the hunter gets up to +20% top speed, scaling from +5% up close to the full boost at 150 m (Josh's `tagHunterBoost` knob), plus a Nearest arrow on the tag panel; speed trap records are skipped while boosted.
6. **Design council** (AgentTeam Council, four sonnet agents: arena advocate, points advocate, track advocate, kid-fun critic; notes in `/tmp/sr2-tag-team/`, copied to `/tmp/sr2-crown/`): recommended Crown Rush in a walled stunt bowl, and Nathan said yes (D5). He then rejected it: holding a crown and keeping away is the same game as tag. The real problem is that a car driving away is physically hard to hit, and running away should not earn much.
7. **D6 Hunt Turns** (`f8ff09c`, opus engineer worker): players take turns hunting for 60 s; a catch is contact, a 6 m reach, or a tag pulse (F / right-stick click, 15 m cone, 4 s cooldown); the caught runner is thrown at least 100 m clear; players start spread round a new 540 m walled arena, Thunder Bowl (`tracks/thunder-bowl.json`); protocol v4. Nathan kept the right-stick click for the pulse (D7, LB was the alternative).
8. **D8 points version** (`36d52cc`, sonnet engineer worker): Nathan found Hunt Turns "better than tag but still not great, usually going to end in a draw", because the runner just drives away. Now the runner scores tricks, rings and stunts (drifts and crash props count too) while running; a catch pays the hunter 500 and wipes the runner's last 15 s of points; most points wins; protocol v5.
9. Every commit was verified by the lead before it went in: typecheck, build, `tracks:check`, and the `mp:check` sections (race 20/20, tag and leave 27/27, client and robust 34/34, turns 44/44).

## Key Decisions

| Decision | Rationale |
|---|---|
| D1: results open on finish, Again waits for everyone (45 s cap) | A finisher should see their result straight away; a slow player should not hold everyone on a blank screen |
| D2: the host's Laps setting decides every multiplayer race | Two machines with different Laps settings raced different lengths depending on who pressed G |
| D3: leaving a round sends `quit` | A round left mid-race stayed open forever and refused every new start |
| D4: catch-up speed for the tag hunter | Equal cars meant the hunter could rarely close the gap |
| D5 then rejected: Crown Rush | Nathan: holding a crown and staying away is tag again; the physical problem (hitting a fleeing car) was untouched |
| D6: Hunt Turns with reach and a tag pulse | Catching must not need exact contact; turns give everyone a go as hunter |
| D7: tag pulse on the right-stick click | Nathan's choice over LB |
| D8: runner scores tricks, a catch pays 500 and wipes 15 s | Running away alone should earn little; the runner must take risks (jumps make landings predictable) to score |
| Chase modes start spread round the arena | Nathan: "the cars shouldn't start together next to each other" |

## Files Created

- `src/net/turns.ts` - Hunt Turns round logic (turn order, catches, pulse, scoring)
- `src/play/arenaSpots.ts` - spread start spots round an arena
- `src/play/turnsFx.ts` - tag pulse and catch effects
- `src/vehicle/hunter.ts` - tag hunter boost
- `tracks/thunder-bowl.json` - the 540 m walled Thunder Bowl arena

## Files Modified

- `src/net/rounds.ts`, `src/net/protocol.ts`, `src/net/index.tsx`, `src/net/client.ts`, `src/net/netStore.ts` - round end on finish, host laps, `quit`, protocol v4 then v5
- `src/ui/screens/Results.tsx`, `src/ui/screens/Settings.tsx`, `src/ui/hud/Hud.tsx`, `src/ui/hud/Panels.tsx` - live results, locked Laps slider, Nearest arrow, Hunt Turns panels
- `src/core/config.ts`, `src/core/settings.ts`, `src/ui/settingsSchema.ts` - `tagHunterBoost` and Hunt Turns knobs
- `server/mp-check-game.ts`, `server/mp-check.ts` - new leave and turns check sections
- `CONSTITUTION.md`, `Learn To Code.html` - knob and contract notes

## Lessons

- LAN guests load the game from the host's Vite server, so a fix only reaches a two-computer session once the host PC updates; a protocol version bump means both machines must update together.
- A council's consensus on what is fun is a hypothesis: Nathan rejected Crown Rush by checking it against the physical play problem (catching a fleeing car), not the scoring maths.
- In a chase with equal cars, rules that reward evading (least time as it, crown holding) feel flat; the runner has to be paid for risk, and catching cannot depend on exact contact.

## Next Steps

- Nathan and Josh playtest the Hunt Turns points version; tune from what they find.

## Open Questions

- Should drifts and crash props count toward the runner's score, or only tricks, rings and stunts? Nathan to say after the playtest.

## Git Status

All six commits (`f49de83`, `a6f3a39`, `12c6f7f`, `a44cb35`, `f8ff09c`, `36d52cc`) pushed to origin main, verified with `git ls-remote`. This session's worktrees (crown-rush, hunt-points) were removed and their branches deleted. Two older agent worktrees under `.claude/worktrees/` predate the session and were left alone.
