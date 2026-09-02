# Rocket Arena

Rocket-powered car soccer for the browser — a Rocket League–style game that runs on a phone.
Everything lives in a single self-contained `index.html`: no build step, no dependencies, no
network requests at runtime.

## Play

Open `index.html` in any browser, or serve the folder:

```bash
npx serve .          # then open the printed URL
```

## Online multiplayer

Two players, peer to peer over WebRTC — the game has no backend, so nothing to run and
nothing to pay for. One player hosts (they run the simulation and the bots); the other joins.
Remaining slots on both teams fill with bots, so you can play 1v1, 2v2 or 3v3 together.

**Without any server**: host presses *Host a game*, copies the invite code and sends it over
any chat app. The other player pastes it, copies the reply code back, host presses *Connect*.

**With room codes** (optional): deploy the included `worker.js` to a Cloudflare Worker and
paste its URL into Settings → Online → Relay URL. Hosting then gives a four-letter room code
and the other player just types it in.

```bash
npx wrangler deploy worker.js --name rocket-arena-relay --compatibility-date 2024-01-01
```

The relay only passes the two connection handshakes; all gameplay traffic goes directly
between the players and never touches it.

Netcode is host authoritative: the host simulates everything and sends ~25 snapshots a second;
the guest sends inputs, predicts its own car locally and interpolates everyone else, correcting
softly toward the host. Expect it to feel right on any normal connection between friends.

## Deploy to Cloudflare

The whole game is one static file, so any Cloudflare static host works.

**Pages — dashboard (no tooling):**
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. Drag in `index.html` (or the whole folder), name the project, **Deploy**.

**Pages — Wrangler:**
```bash
npx wrangler pages deploy . --project-name rocket-arena
```

**Git integration:** connect this repo in Pages and use build command *(none)* with output
directory `/`. Every push redeploys.

Because it is a single file with no imports, there is nothing to configure — no framework
preset, no build command, no environment variables.

## Controls

| Action | Touch | Keyboard | Gamepad |
| --- | --- | --- | --- |
| Drive / reverse / steer | Left thumb, anywhere on the left half | `W` `S` `A` `D` | Left stick / triggers |
| Boost | **BOOST** | `Shift` | B |
| Jump, double jump, flip | **JUMP** | `Space` | A |
| Powerslide / air roll | **AIR ROLL** | `Q` | X |
| Ball cam | **BALL CAM** | `C` | Y |
| Pause | HUD button | `Esc` | Start |
| Reset ball (free play) | **RESET BALL** | `R` | Back |
| Air roll left / right | — | — | LB / RB |

On a controller, **RT** is throttle and **LT** is reverse, so the left stick is free to aim.
Every menu is playable on the pad — stick or d-pad to move, **A** to choose, **B** to go back —
rumble follows the action, and the touch buttons hide themselves once a pad is in use.

Tap jump a second time while airborne with the stick pushed to **flip** — a flip into the ball
is the hardest shot in the game. Hold jump for a higher launch; tap it for a quick hop. Hold
boost into a wall to drive up it.

Jumping has three assists so it behaves on a touchscreen: **coyote time** (a jump still fires
for a moment after the wheels leave a surface), **input buffering** (a press just before you
land fires on touchdown, so you can chain hops), and **tap assist** (a short tap still gets a
useful launch instead of a feeble hop).

## What's in it

- **Renderer** — a WebGL engine written from scratch: real-time shadow maps (depth packed
  into RGBA8, PCF-filtered, so no extensions are required), bloom, ACES tonemapping, FXAA,
  vignette, chromatic aberration and radial speed streaks, plus glossy car materials with a
  cheap environment reflection and Fresnel rim. Quality adapts to your frame rate with
  hysteresis so nothing flickers on and off.
- **Match play** — 1v1 / 2v2 / 3v3, 3/5/8 minute clocks, kickoff countdowns, goal replays,
  overtime golden goal, end-of-match scoreboard, saved career stats.
- **Physics** — Rocket League units and constants (2300 uu/s top speed, 650 gravity, 991 boost
  acceleration, the real throttle and steering curves). Wall and ceiling driving, jumps,
  directional flips, flip cancels, wave dashes, aerials, supersonic demolitions, boost pads
  (6 big / 28 small) with respawn timers, ball spin and post/crossbar collisions.
- **Bots** — three skill levels with intercept prediction, role rotation (first man / second
  striker / keeper), saves, clears, boost management and aerials.
- **Cars** — six chassis built from lofted superellipse cross-sections with smooth normals:
  sculpted shells, canopies, splitters, skirts, spoilers, rocket nozzles, emissive head and
  tail lights, spoked rims, wing mirrors, roof fins, grille slats, brake calipers. Ten paints,
  seven liveries painted in your team colour, five wheel finishes, six boost trails.
- **Stadium** — the octagonal 8192 × 10240 × 2044 pitch with rounded floor-to-wall transitions
  and goal tunnels, wrapped in a real seating bowl: twelve stepped rows of spectators with
  stairways between blocks, home ends in team colours, a front rail and a closed back wall.
  Above it, an exposed roof truss carrying floodlight banks, a hanging four-sided jumbotron
  mirroring the live score and clock, animated LED ribbon boards, safety-glass mullions,
  corner pylons, lit concourse arches and team-coloured wash inside each goal.
- **Feel** — hit-stop on your heavy strikes, screen flash on goals, FOV that widens under
  boost, camera bank into corners, impact shockwave rings, tyre smoke while powersliding,
  a comet trail on a fast ball, landing dust, sparks, and haptics.
- **Audio** — layered synthesised engine (sub, saw, square, turbine whine) that tracks speed
  and load, boost hiss plus rumble, multi-layer ball strikes, crowd ambience and reactions,
  a stadium goal horn, and save cues. No audio files — it is all generated at runtime.
- **Presentation** — procedural textures, batched textured particles, minimap, goal replays
  with a cinematic orbit camera.
- **Controller** — full standard-gamepad mapping with a radial deadzone and expo curve,
  trigger throttle, air roll left/right, gamepad-driven menus with a focus ring, dual-rumble
  haptics, and hot plug/unplug detection.
- **Options** — camera (FOV, distance, height, stiffness, ball cam), controls (left/right hand
  layout, button size, sensitivity, stick deadzone, auto throttle, invert air pitch,
  vibration), audio, and quality with adaptive resolution.

## Notes

- Online play needs WebRTC. It works from the deployed site; some sandboxed previews block
  peer connections, and a relay URL needs the page to be able to reach it.

- Requires WebGL; the page shows a plain message if it is unavailable.
- Settings, car build and career stats persist in `localStorage`.
- Landscape orientation is prompted on phones.
