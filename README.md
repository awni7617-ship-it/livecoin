# Rocket Arena

Rocket-powered car soccer for the browser — a Rocket League–style game that runs on a phone.
Everything lives in a single self-contained `index.html`: no build step, no dependencies, no
network requests at runtime.

## Play

Open `index.html` in any browser, or serve the folder:

```bash
npx serve .          # then open the printed URL
```

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
| Pause | HUD button | `Esc` | — |
| Reset ball (free play) | **RESET BALL** | `R` | — |

Tap jump a second time while airborne with the stick pushed to **flip** — a flip into the ball
is the hardest shot in the game. Hold boost into a wall to drive up it.

## What's in it

- **Match play** — 1v1 / 2v2 / 3v3, 3/5/8 minute clocks, kickoff countdowns, goal replays,
  overtime golden goal, end-of-match scoreboard, saved career stats.
- **Physics** — Rocket League units and constants (2300 uu/s top speed, 650 gravity, 991 boost
  acceleration, the real throttle and steering curves). Wall and ceiling driving, jumps,
  directional flips, flip cancels, wave dashes, aerials, supersonic demolitions, boost pads
  (6 big / 28 small) with respawn timers, ball spin and post/crossbar collisions.
- **Arena** — the octagonal 8192 × 10240 × 2044 pitch with rounded floor-to-wall transitions,
  goal tunnels and netting, crowd, floodlights.
- **Bots** — three skill levels with intercept prediction, role rotation (first man / second
  striker / keeper), saves, clears, boost management and aerials.
- **Presentation** — WebGL renderer written from scratch, procedural textures, particles,
  synthesised audio (engine, boost, impacts, crowd, goal horn), haptics, minimap, replays.
- **Options** — camera (FOV, distance, height, stiffness, ball cam), controls (left/right hand
  layout, button size, sensitivity, auto throttle, invert air pitch, vibration), audio, and
  quality with adaptive resolution.

## Notes

- Requires WebGL; the page shows a plain message if it is unavailable.
- Settings, car build and career stats persist in `localStorage`.
- Landscape orientation is prompted on phones.
