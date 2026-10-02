# Sundown Run II

A neon synthwave driving game for the browser. A giant striped sun sinks into a magenta sky, the city lights up window by window, and you drive a glowing car down a wet neon road: through loops, along wall rides, off ramps and over the big-air hill. Race Ai cars, beat your own ghost, smash crash props for points, hunt energy cores, draw your own tracks, and play with friends on the same wifi.

Everything you see and hear is made by the code: no downloaded models, textures, fonts or music.

![The Sundown Run II title screen: the striped sun setting behind a neon city, and a glowing car on the start line](docs/title-screen.jpg)

## Play it

You need [Bun](https://bun.sh) (or Node.js) installed once.

```
bun install
bun run dev
```

Then open **http://localhost:5201**. On Windows, just double-click **`Sundown Run II.bat`** instead (see [Windows](#windows) below).

## Controls

| Action | Keyboard | Xbox controller |
|---|---|---|
| Throttle / brake and reverse | W / S or Up / Down | RT / LT |
| Steer | A / D or Left / Right | Left stick |
| Handbrake (drift) | Space | A |
| Tricks in the air | hold Space, then W/S to flip, A/D to roll | hold A, then the left stick |
| Camera (chase, close, bonnet) | C | RB |
| Back to the road | R | Y |
| Restart at the start line | Shift + R | View |
| Menu | Esc | Menu |
| Start a race or tag round (multiplayer) | G | X |

Whichever you touched last is in charge: you can swap between keyboard and controller at any time. In menus, the arrows or d-pad move, Enter or A picks, Esc or B goes back, and Q/E or LB/RB switch tabs.

Sound starts after your first key press or click (that's the browser's rule; a controller press doesn't count). The game shows a reminder until it does.

## What's in it

- **Three tracks.** *Afterglow Valley*: a figure-eight through an open neon valley with a loop into the sun, a wall ride, ramps, a crossover bridge and the big-air hill. *The Hyperdrome*: an enclosed stadium oval for top speed, with a speed trap and banked ends you can tilt from flat to steep with a live slider (pause menu or Settings > Track). *Neon Pocket*: a twisty little circuit, written as a single file to prove that a track is just a file.
- **Modes.** Free Roam (tricks, crash props, smashable posts and the energy-core hunt), Time Trial against your ghost, Race against 0 to 5 Ai racers, and Stunt Attack (90 seconds for the biggest trick score). In multiplayer: Race, Free Roam and Tag.
- **The garage.** Five cars (Dart, Blade, Brick, Manta, Pulse), with your own paint, underglow and light-trail colours.
- **The road editor.** Draw a road with the mouse like a pencil and the game turns it into a proper track: it smooths it, opens up corners that are too tight, banks the corners, closes the loop and turns crossings into bridges. Then place boost pads, ramps, loops, wall rides, crash props, energy cores and the start line, and press Test drive. Or try *drive to draw*: the car lays road behind it as you drive. Your tracks save in the browser, and Export / Import moves them between computers as the same `.json` file the built-in tracks use.
- **The world map.** Pause, then Map, for a top-down view of the track you're on.
- **Settings** for everything you can feel: car and colours, handling, camera, sound, time of day, Ai racers, the Hyperdrome's bank angle and graphics quality.

## Josh: this bit is for you

- **`src/core/config.ts`** is your file. Every number in it is something you can feel in the game: grip, power, top speed, camera, colours, how fast the sun sets, how many Ai cars race you. Change one, save, and the game changes straight away. If you change something in the Settings menu and later edit the same thing in `config.ts`, your edit in the file wins.
- **`tracks/`** holds every track. Each one is a single file. `tracks/README.md` explains every line, and you can write your own: copy `neon-pocket.json`, change it, check it with `bun run tracks:check tracks/your-track.json`, then drive it at `http://localhost:5201/?track=your-track`.
- **`bun run learn`** makes **`Learn To Code.html`**: a workshop written for you, with little programs you can run right in the page and missions in the real game files.
- **`src/core/palette.ts`** holds every colour in the game.

## Report a problem

Something broken, or got an idea? Pick **Report a problem** on the title screen (just under the main menu) or in the pause menu. Choose what kind it is, give it a short title, say what happened (what you were doing, what went wrong, what you expected), and press **Send**.

- It goes on the game's **public** GitHub page, where anyone can read it. So use a first name or a nickname only, and never put your address, school or anything private.
- The game adds the details that help fix it: the track, your car, where you were and how fast, how smoothly the game was running and your graphics chip. **See what gets sent** shows every one before you send.
- To type, press **Enter** on a box or click it. While you type, your keys only go into the box, so nothing drives the car. **Esc** stops typing, **Tab** jumps to the next box, **Ctrl+Enter** sends. The controller does everything else, but typing needs a keyboard.
- If it says **Saved on this computer**, nothing is lost: it sends by itself with a later report, once reporting is switched on and the internet works.

### Turn on reporting (for Dad)

The game's own server posts the reports with a GitHub key that lives only on this computer (GitHub accounts start at 13, so Josh can't use one of his own). Until there's a key, reports wait in `reports/pending/`.

1. On github.com, signed in as NatMan3000, open https://github.com/settings/personal-access-tokens and click **Generate new token** (a fine-grained token).
2. Name it something like "Sundown Run II reports", set **Resource owner** to NatMan3000, and pick an **Expiration** date.
3. **Repository access:** Only select repositories, then **SundownRun2**.
4. **Permissions:** Repository permissions, **Issues: Read and write**. Nothing else.
5. Generate it and copy it (it starts with `github_pat_`).
6. In the game folder on Josh's computer, save the key as the only line of a file called **`github-token.txt`**.

No restart needed: **Report a problem** now says "Reporting is on", and anything waiting goes out with the next report. The file is gitignored, so it's never uploaded, and the Update .bat leaves it alone. Reports arrive as issues labelled `from the game` plus `bug` or `idea`. When the key expires, reports save again and the game's black window says GitHub turned the key down: make a new one the same way. (The key can also come from the `SR2_GITHUB_TOKEN` environment variable instead of the file.)

## Multiplayer: race, tag and smash on the same wifi

ONE computer is the **host**. Everyone needs to be on the same wifi.

- **Windows:** double-click **`Sundown Run II Multiplayer.bat`**. The first time, it asks for an admin YES: that adds the Windows Firewall rule that lets friends connect (ports 5201-5202). Without it, Windows silently blocks them. Don't type `bun run mp` into PowerShell; the .bat file is the way.
- **Mac or Linux:** run `bun run mp` in a terminal. If macOS asks whether "bun" may accept incoming connections, click **Allow**.

It prints two links. Open the first one on the host. Open the second one on every other computer: they need **nothing installed**, because the game loads straight from the host. Change `name=` in the link to your own name (that's your name tag), and set `color=` to `orange`, `yellow`, `mint`, `pink`, `purple`, `cyan`, `red` or `white` so every car looks different.

**The host picks the track**, and everyone else gets it sent over automatically, even one you drew yourself in the editor. Ai racers sit multiplayer out; it's just you lot.

- **Press G (X on a controller) to start a race:** everyone lines up on the grid, 3-2-1, engines locked until GO, and the first one home wins. Every race deals a fresh set of crash props, and when your mate smashes one you see it burst too.
- **Tag:** pick Tag mode and press G. One player is "it" and glows; bump someone to pass it on (no tag-backs for 2 seconds). After 3 minutes, whoever spent the least time as "it" wins.
- **Ramming is real:** hit someone and they get shoved. Prefer driving through each other like ghosts? Set `multiplayerRam: false` in `src/core/config.ts`.

**Something not working?**

- The other computer's link won't load: check both are on the same wifi (not a guest network) and that the firewall rule was added (run the .bat again and click YES). If the printed address doesn't work, `bun run mp` lists other addresses to try.
- You can see the game but not each other: the relay (port 5202) is blocked. Same firewall fix.
- Someone's wifi blinks: they reconnect by themselves, and keep their place in a race or a tag round if they're back within 15 seconds.
- More than two players works: every extra person who opens the link joins the same world.

## Windows

### First time

1. Get the game folder onto the laptop (a `git clone`, or download the ZIP and unzip it somewhere easy like `Documents\SundownRun2`).
2. Double-click **`Sundown Run II.bat`**. It looks for Bun (or Node.js), installs the game's parts the first time (that takes a minute), and opens the game in your browser. If it says it can't find Bun or Node.js, install Bun from https://bun.sh (or Node.js LTS from https://nodejs.org) and run it again.
3. Keep the black window open while you play. Closing it stops the game.

### Make it fast: give the browser the real graphics card

Gaming laptops have two graphics chips: a small one built into the processor and the big one (on Josh's laptop, an NVIDIA RTX 4060). Windows often hands the browser the small one, and then the game crawls. Fix it once:

1. Open **Settings**, then **System**, then **Display**, then **Graphics** (near the bottom).
2. Find your browser in the list (Chrome or Edge). If it isn't there, click **Browse** (or "Add desktop app") and pick it.
3. Click the browser, then **Options** (or open its drop-down), choose **High performance**, and **Save**.
4. Close the browser completely and open the game again.

**How to check which chip the game is using:** in the game, open **Settings > Graphics**: the "Graphics chip" row should name the NVIDIA card. You can also type `chrome://gpu` (or `edge://gpu`) into the address bar and look for "GL_RENDERER": it should mention NVIDIA. While you play, **Task Manager > Performance** shows which GPU is busy.

If it's still slow, set **Settings > Graphics > Quality** to Medium or Low.

### Updating

Double-click **`Sundown Run II Update.bat`**. It downloads the latest version and makes the folder an exact copy of it, so any changes you made to the game's files are thrown away (that's on purpose: it's the do-over button). Tracks you drew in the editor live in the browser, so they're safe. Track files you dropped into `tracks/` yourself are removed, so export or copy them somewhere else first.

### Xbox controller

Pair it with Windows over Bluetooth (Settings > Bluetooth & devices > Add device), open the game, and press any button once so the browser notices it. It works straight away; no setup.

## For developers

| Command | What it does |
|---|---|
| `bun run dev` | Dev server on http://localhost:5201 (strict port) |
| `bun run build` / `bun run typecheck` | Production build / TypeScript check |
| `bun run tracks:check [file] [--physics] [--bench]` | Validate and build every track (or one), with physics proofs |
| `bun run mp` / `bun run relay` | Host multiplayer (relay on 5202 + LAN dev server) / relay alone |
| `bun run mp:check` / `bun run test:relay` | Two-client multiplayer proof / relay unit tests |
| `bun run probe -- --url <u> ...` | Drive the game in a private headless Chrome: screenshots, evals, perf |
| `bun run learn` | Generate `Learn To Code.html` |

Report a problem (`server/issues.ts`, served at `/api/report` by the dev and preview servers): test it against a fake GitHub with `SR2_ISSUES_API=http://127.0.0.1:<port>` and keep waiting reports out of the folder with `SR2_REPORTS_DIR=<dir>`. Never test against the real repository.

URL switches for testing: `?track=<id>`, `?mode=free|timetrial|race|stunt`, `?ai=<n>`, `?demo=1` (autopilot plus a frame-time recording in `window.__perf`), `?time=<0..1>`, `?quality=low|medium|high`, `?cam=<bookmark>`, `?editor=1`, `?nomusic=1`, `?mp=1&name=&color=`.

Start with [`CLAUDE.md`](CLAUDE.md) (how the code is organised) and [`CONSTITUTION.md`](CONSTITUTION.md) (the art direction, the 60fps budget and the feel standard every change is judged against).
