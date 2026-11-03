---
type: guide
title: Sundown Run II online (Cloudflare)
description: How the internet copy of the game works, how to deploy it, and the one-time Cloudflare Access setup so Nathan and Josh can race from different houses.
created: 2026-11-03
---

# Sundown Run II online

The game page and the multiplayer relay run on Cloudflare, so two houses can race without either computer hosting or letting anything in. Both browsers connect out to `https://sundown.nathans-lab.fyi`.

| Piece | What it is |
|---|---|
| `worker.ts` | The Worker: serves `dist/` (the production build) as static files, hands `/relay` to the room, and answers `/api/report` and `/api/tracks` with "not set up" (reporting and track sharing only work in the game at home) |
| `room.ts` | The room: one Durable Object that every player's WebSocket joins. Its rules are `server/relayCore.ts`, the same code the LAN relay (`bun run mp`) runs |
| `memoryStore.ts` | What the room saves (next player id, the host's track, the round in progress), so a Cloudflare restart mid-game carries on |
| `wrangler.jsonc` | Config. No account id or secret: the repository is public |

Online, nobody is "this machine", so the host (whose track everyone drives) is whoever joined first. If the host leaves, the next longest-present player takes over.

## Try it locally (no Cloudflare account needed)

```bash
bun run cloud:dev        # builds, then serves https://127.0.0.1:5211 (self-signed certificate)
```

Open `https://127.0.0.1:5211/?mp=1&name=DAD` in two browsers (click through the certificate warning). Checks: `bun run test:cloud`, and with `cloud:dev` running, `SR2_RELAY_URL=wss://127.0.0.1:5211/relay NODE_TLS_REJECT_UNAUTHORIZED=0 bun test cloud/relay.remote.test.ts` and `bun run mp:check --cloud https://127.0.0.1:5211 --only client,game`.

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

Then each player opens `https://sundown.nathans-lab.fyi/?mp=1&name=JOSH&color=pink`.

## Gotchas

- **A lapsed Access login breaks multiplayer quietly.** When the month runs out, Access only asks you to log in again on a full page load. The game's WebSocket to `/relay` just fails and keeps retrying (the multiplayer status shows connecting). Fix: reload the page, log in, play.
- **Free plan budget.** The room counts every 20 incoming messages as one request, 100,000 a day, reset at 10:00 AEST / 11:00 AEDT (00:00 UTC). Two players driving send about 123 messages a second between them (measured: 59 car positions plus 2.5 status and ping messages a second each), which is about 4.5 hours of two-player driving a day. Sitting in menus or the editor costs a twentieth of that. Over the limit, the relay stops answering until the reset; the page and single player still work. The room logs its rate once a minute (`bunx wrangler tail sundown-run`).
- **Reporting and Share are home-only.** The online copy has no GitHub key; its Report a problem and Share screens say so instead of trying.
- **Protocol versions.** Everyone online gets the deployed build, so tabs left open across a deploy see "reload every tab" (the protocol version check); reloading fixes it.
