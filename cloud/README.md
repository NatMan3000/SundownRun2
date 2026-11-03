---
type: guide
title: Sundown Run II online (Cloudflare)
description: How the internet copy of the game works, how to deploy it, the one-time Cloudflare Access setup so Nathan and Josh can race from different houses, and the online track library.
created: 2026-11-03
---

# Sundown Run II online

The game page and the multiplayer relay run on Cloudflare, so two houses can race without either computer hosting or letting anything in. Both browsers connect out to `https://sundown.nathans-lab.fyi`.

| Piece | What it is |
|---|---|
| `worker.ts` | The Worker: serves `dist/` (the production build) as static files, hands `/relay` to the room, `/api/library` to the track library, reads the old Shared tracks list on `/api/tracks` (the same `server/trackShare.ts` the game at home runs; a share is refused online), and answers `/api/report` with "not set up" (reporting only works in the game at home) |
| `library.ts`, `libraryStore.ts`, `libraryApi.ts` | The track library: one SQLite Durable Object (the `v2` migration) holding every player's drawn tracks. `libraryApi.ts` checks the caller and the track file, `libraryStore.ts` is the rules (ids unique across players, only the owner changes or deletes, versions, caps) |
| `access.ts` | Who the player is: the Cloudflare Access login, from the signed `Cf-Access-Jwt-Assertion` token, checked against the team's keys and the app's AUD tag |
| `room.ts` | The room: one Durable Object that every player's WebSocket joins. Its rules are `server/relayCore.ts`, the same code the LAN relay (`bun run mp`) runs |
| `memoryStore.ts` | What the room saves (next player id, the host's track, the round in progress), so a Cloudflare restart mid-game carries on |
| `wrangler.jsonc` | Config. No account id or secret: the repository is public |

Online, nobody is "this machine", so the host (whose track everyone drives) is whoever joined first. If the host leaves, the next longest-present player takes over.

## Try it locally (no Cloudflare account needed)

```bash
bun run cloud:dev        # builds, then serves https://127.0.0.1:5211 (self-signed certificate)
```

Open `https://127.0.0.1:5211/?mp=1&name=DAD` in two browsers (click through the certificate warning). The track library needs a player: `wrangler.jsonc` carries the real `ACCESS_AUD`, so locally put `ACCESS_AUD=` (empty) and `SR2_DEV_PLAYER=you@example.com` in `cloud/.dev.vars` (git-ignored; the pretend player is only used while `ACCESS_AUD` is empty and only on 127.0.0.1 / localhost). Without that override every library request asks for a login, since wrangler dev has no Access in front. To test two players, or the real token check, sign your own test tokens: point `ACCESS_TEAM_DOMAIN` at a local stand-in that serves `/cdn-cgi/access/certs`, set `ACCESS_AUD` to the AUD you sign with, and send each browser's token in `Cf-Access-Jwt-Assertion` (puppeteer `page.setExtraHTTPHeaders`). `bun test cloud/library.test.ts` checks the library rules and the token rules without a server. Checks: `bun run test:cloud`, and with `cloud:dev` running, `SR2_RELAY_URL=wss://127.0.0.1:5211/relay NODE_TLS_REJECT_UNAUTHORIZED=0 bun test cloud/relay.remote.test.ts` and `bun run mp:check --cloud https://127.0.0.1:5211 --only client,game`.

## One-time setup

1. **Log in wrangler** to your Cloudflare account: `bunx wrangler login` (opens the browser once).
2. **Deploy:** `bun run cloud:deploy` (builds, typechecks the Worker, uploads). Re-run it whenever the game changes. The first deploy creates the room (the `v1` migration).
3. **Attach the address.** Dashboard: Workers & Pages > `sundown-run` > Settings > Domains & Routes > Add > Custom domain > `sundown.nathans-lab.fyi`. Cloudflare makes the DNS record and certificate. The Worker has no `workers.dev` address on purpose (`workers_dev: false`): the custom domain, behind Access, is the only way in.
4. **Put Cloudflare Access in front** (Zero Trust > Access controls > Applications > Add an application > Self-hosted):
   - Application domain: `sundown.nathans-lab.fyi` (the whole host: the page and `/relay` both need it).
   - Session duration: 1 month.
   - Policy "Sundown players", action Allow, Include: Emails `<your Google address>` and `<Josh's email>`.
   - Login methods: Google (already set up for the other apps) and One-time PIN (Josh gets a code by email).
   - Check the policy's own Session Duration says "Same as application session timeout". A policy duration overrides the app's (the Admin Login policy once forced a daily login on Nexus: `~/Dev/HomeLab/docs/cloudflare.md` § Session Duration Precedence).

5. **Switch on the track library.** Online, every track a player draws saves itself to the library under their login, and the editor Library's Everyone's tracks lists everyone's (by player name; emails are never shown or stored). It is off, and says so, until the Worker knows the Access app's AUD tag:
   - Zero Trust > Access controls > Applications > the `sundown.nathans-lab.fyi` app > Overview (or Edit > Basic information) > copy **Application Audience (AUD) Tag**.
   - It lives in `cloud/wrangler.jsonc` `vars.ACCESS_AUD` (set 3 Nov 2026; it isn't a secret: every login token carries it). If the Access app is ever re-created, paste the new tag there and redeploy. `ACCESS_TEAM_DOMAIN` there is `https://natman3000.cloudflareaccess.com`.
   - Deploy (`bun run cloud:deploy`). The first deploy after this change runs the `v2` migration, which creates the `Library` Durable Object (SQLite, free plan). Never edit or remove a migration tag that has been deployed.
   - For the one-time import: `bunx wrangler secret put LIBRARY_ADMINS -c cloud/wrangler.jsonc` and type your login email (a secret, not a var, so no email lands in this public repository).
6. **Each player opens the online game once** (`https://sundown.nathans-lab.fyi/?name=DAD`, then the editor Library). The tracks already drawn in that browser upload to their library, once. Do this before the import, so a track that is both in someone's browser and on GitHub keeps its id and isn't imported a second time.
7. **One-time import of the old GitHub Shared tracks** (needs `LIBRARY_ADMINS`): `cloudflared access login https://sundown.nathans-lab.fyi` once, then `bun scripts/library-import.ts --map "JJ=<Josh's email>,DAD=<your email>" --token "$(cloudflared access token -app=https://sundown.nathans-lab.fyi)" --dry-run`, check the list, and run it again without `--dry-run`. Each Made by name goes to the login you map it to (an unmapped name is skipped unless you pass `--default-owner`). A track changed on GitHub after it was shared is skipped, and so is a track whose id is already in the library, so a second run imports nothing twice.

The old step "switch on track sharing" (`GITHUB_TOKEN`) is no longer needed online: the online game doesn't post to GitHub any more, and the Shared tracks list it still reads for the import is public. The secret can stay or go (`bunx wrangler secret delete GITHUB_TOKEN -c cloud/wrangler.jsonc`).

Then each player opens `https://sundown.nathans-lab.fyi/?mp=1&name=JOSH&color=pink`.

## Gotchas

- **A lapsed Access login breaks multiplayer quietly.** When the month runs out, Access only asks you to log in again on a full page load. The game's WebSocket to `/relay` just fails and keeps retrying (the multiplayer status shows connecting). Fix: reload the page, log in, play.
- **Free plan budget.** The room counts every 20 incoming messages as one request, 100,000 a day, reset at 10:00 AEST / 11:00 AEDT (00:00 UTC). Two players driving send about 123 messages a second between them (measured: 59 car positions plus 2.5 status and ping messages a second each), which is about 4.5 hours of two-player driving a day. Sitting in menus or the editor costs a twentieth of that. Over the limit, the relay stops answering until the reset; the page and single player still work. The room logs its rate once a minute (`bunx wrangler tail sundown-run`).
- **Report a problem and Share are home-only.** Report a problem queues on the home computer's disk, so online it says so instead of trying. Online, tracks go to the library instead of GitHub: the Library has no Share button, and a share sent to `/api/tracks` is refused.
- **The library and the relay share one budget.** Every library request (the Library opening, each save, a sync when you come back to the tab) is one Durable Object request, counted in the same free 100,000 a day as the relay. A sync is one list plus one request per changed track, so it is a rounding error next to driving.
- **One browser, one player.** Tracks live in the browser too (the working copy, and it works offline). If two people log in on one browser, tracks already uploaded under the first login stay out of the second's library ("Not on this login"); tracks drawn after the switch go to whoever is logged in. A track downloaded from the old Shared tracks and never changed stays in the browser as its maker's ("Not yours"); change it and it becomes yours and uploads.
- **Deleting is everywhere.** Delete in the Library deletes from the online library, so the next time another of your computers syncs, that track goes there too (unless it was changed there and not uploaded yet: then it uploads again as a new track).
- **A track changed on two computers keeps both.** A save made from an older version is refused (`changed`); the browser then takes the newer version and keeps its own as "<name> (this computer)".
- **Ids.** A track keeps the id it was drawn with unless another player already has it (or it is a built-in's): then the library gives it a new one (`my-track-k3x9`) and the browser moves it to that id. Records and ghosts are keyed by id, so a moved track starts with fresh records. In multiplayer, a joiner who has the host's library track builds the identical file under the same id.
- **Testing the Shared tracks list locally** (what the import reads): put a made-up key and the fake GitHub's address in `cloud/.dev.vars` (git-ignored): `GITHUB_TOKEN=fakekey_owner_0123456789abcdef` and `SR2_ISSUES_API=http://127.0.0.1:<port>`, run `bun server/fakeGithub.ts --port <port> --token fakekey_owner_0123456789abcdef`, then `bun run cloud:dev`. Never the real key or repository.
- **Protocol versions.** Everyone online gets the deployed build, so tabs left open across a deploy see "reload every tab" (the protocol version check); reloading fixes it.
