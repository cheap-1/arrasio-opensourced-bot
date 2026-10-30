# Arras Server — Codex Context Handoff

Updated 2026-10-30 UTC. Use this file to resume work in another Codex session or on another PC.

## Project and repository

- Project: Node.js Arras.io server with bundled browser client.
- GitHub repository: `https://github.com/cheap-1/arrasio-opensourced-bot`
- Branch: `main`. The code update before this context file was pushed as `b97547a` (`Remove bot and player spawn caps`).
- The working folder used on the original PC was `C:\Users\RDP\Downloads\arrasio-opensourced-bot-main\arrasio-opensourced-bot-main`. That folder had no `.git`; changes were pushed from a temporary clone. A fresh clone from GitHub will have the repository metadata.
- Do not put real operator/API/developer keys in this file or in GitHub.

## What the conversation requested

The user asked for these changes over the course of the thread:

1. Fix server errors when spawning feed bots; add instant spawn and operator invincibility.
2. Support large feed-bot counts, including 1,000+ and later 4,000; make bots progress to level 42 with 0.45-second delays between skill and tank upgrades.
3. Add Growth Siege Classic on port 3006.
4. Fix bullets from feed bots assigned to another team so they use that team's color/ownership and do not kill the bots as friendly fire.
5. Fix chat submission with Enter on the bundled client.
6. Add a mobile cursor option: left side remains movement joystick; right side controls a visible cursor. Add adjustable, hold-to-fire LMB/RMB buttons and a cursor icon.
7. Remove rocks from Growth 4TDM.
8. Remove feed-bot count caps and player caps after a 4,000-bot request produced only about 300 bots.
9. Push the work to the GitHub repository.

## Current implementation

- Feed bots spawn at level 42. Their skill allocation and tank upgrades are scheduled with 450 ms delays.
- Instant feed-bot mode loops synchronously through the requested count and creates all bots in that request before returning. Natural-rate mode keeps its randomized one-at-a-time queue.
- `feed_bot_cap: 0` means there is no configured live-plus-queued feed-bot cap. The spawn handler only truncates requests when a positive cap is configured.
- All configured `player_cap` values are `0`, which disables player caps and displays unlimited capacity in the server selector.
- A previous 2,000-bot cap counted both live bots and queued spawns. Reaching about 300 additional bots is consistent with about 1,700 slots already occupied at the time; the exact live/queued count from that attempt was not recorded.
- Bot bullets use their assigned team's color and team identity.
- Mobile Cursor Mode is stored in browser settings. The left touch area moves; right-side touch sets aim and shows a pointer. Hold LMB/RMB buttons fire and alt-fire. Button size and horizontal/vertical placement are adjustable in settings.
- Growth 4TDM on port 3005 has `disable_rocks: true`; the rock tile initializer skips asteroid creation for that server.
- Growth Siege Classic is server id `lf` on port 3006.
- Chat accepts Enter and Numpad Enter.
- The main web server on port 3000 proxies game WebSocket paths such as `/la` to the game workers and forwards host/client-IP headers for remote tunnel joins.

## Ports

| Port | Mode |
| --- | --- |
| 3000 | Web server and Sandbox |
| 3001 | FFA |
| 3002 | Maze |
| 3003 | 2TDM |
| 3004 | 3-team Mothership |
| 3005 | Growth 4TDM, rock spawning disabled |
| 3006 | Growth Siege Classic |

## Running locally

From the project root on Windows:

```powershell
npm install
node server/server.js
```

`server/.env` is required and gitignored. It must be created/configured locally with `ARRAS_PUBLIC_HOST`, `API_KEY`, `DEVELOPER`, and `SUKONOE_OPERATOR`; optional per-port host variables are `ARRAS_SERVER_HOST_3001` through `ARRAS_SERVER_HOST_3006`. Keep the secret values private.

For a temporary Cloudflare quick tunnel, run:

```powershell
cloudflared tunnel --url http://localhost:3000
```

The old test tunnel hostname is expired; start a new tunnel to get a current hostname.

## Last known state and verification

- On the original PC, the server was restarted after the uncapped-spawn change. All ports 3000–3006 were listening under Node PID 14256 at the last check; the PID may differ after another restart.
- The updated server files passed `node --check`, the config reported `feed_bot_cap: 0` and `player_cap: 0` for all configured servers, and all game workers booted.
- Code changes through commit `b97547a` were pushed to `main`; this handoff file is an additional context-only commit.
- A 4,000-feed-bot load was not run after removing the cap or changing instant mode to synchronous spawning. Uncapped counts are enabled, but performance at 1,000–4,000 bots is unverified. Earlier measurements found 100 bots comfortable and a 200-bot scene overloaded the tick loop (about 54 ms/tick and 2.2 snapshots/s for the tested client).
- Mobile cursor controls were syntax-checked but not tested on a physical phone.

## Key files

- `server/config.js` — server list, feed-bot cap, player caps, ports.
- `server/game/network/sockets.js` — feed-bot spawn validation, queueing, and player spawn checks.
- `server/game/index.js` — bot lifecycle and delayed progression.
- `server/game/entities/gun.js` — feed-bot projectile team/color.
- `server/game/roomSetup/tiles/rocks.js` — optional rock suppression.
- `public/client/app.js`, `public/client/canvas.js`, `public/client/global.js` — mobile cursor, chat, settings, touch controls.
- `public/index.html`, `public/style.css` — feed-bot UI, mobile settings and layout.
- `server/server.js`, `server/game.js` — web server, proxy, WebSocket compression, public routing.

