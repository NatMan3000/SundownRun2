# iOS Simulator rig

Real Mobile Safari on the iPhone 17 Pro simulator (iOS 27.2), driven from the shell. It is how the phone standard's 874x292 Safari window was measured (`spec/phone-landscape-standard.md`).

| Script | What it does |
|---|---|
| `rotate.sh landscape-left\|landscape-right\|portrait` | Sets the device orientation through XCUITest. |
| `shot.sh <url or ""> <out.png>` | Opens the URL in Safari, waits 4 s, screenshots. An empty URL shoots what is there. |
| `tap.sh x y`, `drag.sh x1 y1 x2 y2` | A tap or drag at points from the window's top-left. |
| `pinch.sh scale velocity [label]` | Two real fingers (XCUITest's `pinch`), centred on the page, or on the first element whose label contains `label`. Scale above 1 with a positive velocity spreads, below 1 with a negative one squeezes. |
| `sweep.sh [steps-file]` | One state per line (`name query [wait] [shots]`), Safari restarted between each. `shots` above 1 bursts that many screenshots `BURST_GAP` seconds apart, for states that fade. |
| `sweep-server.ts <dist> <port>` | Serves a build with a script added so a URL can open any screen (`sweep=`, `tab=`, `hud=`, `after=`). |
| `sheet.ts <out.png> <name>...` | Lays sweep shots out as 874x292 cells on one sheet. |

Shots, build output and logs go under `$IOS_SIM_OUT` (default `/tmp/sr2/ios-sim`). The device is found by looking up the booted "iPhone 17 Pro"; the XCUITest project in `proj/` is generated with `xcodegen` and built on first use.

- Run one script at a time. Overlapping `xcodebuild` runs on the same simulator fail or leave the orientation wrong.
- Rotate first: the simulator stays in whatever orientation it was left in.
- `tap.sh` and `drag.sh` take about 3 minutes on a live game page, because XCUITest waits for the app to go idle.
- Restart Safari between shots (`sweep.sh` does). With six game tabs open the map's road line vanished; the cause is unproven.
- This Xcode has no Simulator.app, so nothing shows on screen: read the screenshots.
- A wiped Safari has one tab and no tab strip: the page is 338 tall and window y = page y + 64, not the usual 110.
- `pinch.sh` spreading lands both fingers in the same millisecond, 8 px apart. A squeeze (`pinch.sh 0.6 -1`) starts them so far apart that in a 292 px tab one lands in Safari's bars, so only one finger reaches the page: it isn't a pinch.

## Known simulator behaviour

On the game, the first real touch freezes the page for about 9 s: `AudioContext.resume()` on the first `touchend` doesn't return until then, and the tap's click arrives afterwards and acts once. Measured with an event log on 5 Nov 2026 (one tap, no second tap needed); a plain page with no audio answers a tap in 4 ms, so it isn't the rig. Later taps are instant. On Nathan's real iPhone 17 Pro the stall is unnoticeable (his words, 5 Nov 2026), so don't chase it: it is the simulator's.
