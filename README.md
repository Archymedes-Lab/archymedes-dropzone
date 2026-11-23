# DROPZONE 01 — Archymedes Play Lab

A lightweight, browser-based battle royale prototype built with Three.js, TypeScript and Vite. It is both a small playable game and the first seed of a simulation environment for experimenting with new gameplay mechanisms.

## Current playable slice (v0.2.0)

- **Drop:** board the dropship, jump anywhere along its seeded flight line, freefall and steer your glider to a landing spot. Nineteen rivals drop with you.
- **Loot:** sidearm, SMG, shotgun and DMR (rarity-coloured beams), shield cells, field kits and XP shards; buildings are loot hot spots, eliminated operatives leave a death crate.
- **Combat:** two weapon slots, magazines and reloads, spread and pellets, shields before health, hit markers and damage numbers.
- **Storm:** five stages that each announce the next circle, hold, then close in and move, with rising damage.
- **Rivals:** utility-style bots that loot better weapons, keep weapon-appropriate range, strafe, retreat when hurt and rotate ahead of the storm.
- **Look:** a single stylised palette; faceted terrain with paths and building pads, shader water with real shoreline foam, swaying trees, a storm wall, tracers and a pooled particle system.
- **Lean by design:** no downloaded art, audio or fonts. Operatives, trees, rocks, crates, loot and tracers are instanced and the buildings are one merged mesh, so a busy frame is roughly 30 draw calls. Resolution and then shadows step down automatically if frames run long.
- Rendering and simulation stay separated: `src/sim/WorldSimulation.ts` has no Three.js dependency and reports effects as plain-data events.

## Run locally

Requires Node.js 20.19+ (Node 22 LTS recommended) and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5173`).

Run the simulation checks:

```bash
npm run test:sim
```

For a production build:

```bash
npm run typecheck
npm run build
npm run preview
```

The first run needs internet access to install the npm dependencies. After the dependencies are cached locally, the app itself makes no external API calls and downloads no external game assets.

## Controls

- **Space / click** — jump from the dropship; **W A S D** steers while falling
- **W A S D** or arrow keys — move; **Shift** — sprint
- **Mouse** — aim; **hold left mouse button** — fire; **mouse wheel** — zoom
- **R** — reload (replay after a finished run)
- **1 / 2 / Q** — switch weapon slot; **E** — swap the weapon you are standing on into your active slot
- **M** — mute; **`** (backquote) — performance overlay (FPS, draw calls, triangles, resolution)
- Health, shields, shards and a weapon for an empty slot are collected automatically.

## Architecture

```text
src/
  main.ts                  Game flow (intro, dropship, fall, match, results), input, camera, event -> effect wiring
  hud.ts                   DOM HUD, minimap, kill feed, damage numbers
  audio.ts                 Synthesised sound effects (WebAudio, no files)
  style.css                HUD and menu styling
  render/
    palette.ts             Every colour in one place
    world.ts               Terrain, water, foliage, rocks, crates, buildings, storm shader injection
    actors.ts              Instanced operatives, parachutes, health bars
    effects.ts             Tracers, particles, loot, storm wall, dropship, clouds
  sim/
    types.ts               Plain game-state contracts
    WorldSimulation.ts     Rules, AI, weapons, loot, storm stages, progression and events
```

### Design contracts

1. **Simulation state is plain data.** The simulation module should not import Three.js, browser rendering or UI code.
2. **Run logic at a fixed step.** The prototype advances the simulation at 60 ticks per second, independent of render frames.
3. **Randomness is seeded.** The default seed is `20261029`; use `?seed=731` in the browser URL to choose another reproducible seed. "Drop again" picks a fresh seed and writes it to the URL, so any run can be replayed.
4. **Mechanics remain configurable.** Map generation, bot count, safe-zone timing, XP thresholds and weapon parameters should be moved to explicit scenario configuration as experiments grow.
5. **Measure before optimizing.** The first build is a functional vertical slice. Profile on target hardware before making claims about frame rate, agent scale or download size.

## Deliberate simplifications in v0.2.0

- Local single-player simulation only; no accounts, server or multiplayer networking.
- Basic circle collision and simple projectile collision, not full rigid-body physics. Bots do not target the player during the first 10 seconds after landing.
- The drop is presentation only: the simulation starts when the player lands, and rivals are always shown landing before the player.
- Rivals deal half damage to each other (`BOT_VS_BOT_DAMAGE`) so the match does not empty out in the first minute. This is a pacing knob, not a validated balance.
- Lightweight bots are gameplay placeholders, not validated player-behavior models.
- The world is stylized and built from primitives; there are no animation rigs or expensive assets.
- Bots check line of sight before firing, but have no pathfinding; they can get briefly stuck on cover.

## Evolution roadmap

### v0.2 — Stability and observability
- Validate collision edge cases and aiming on different aspect ratios.
- Add a debug overlay: tick time, render time, agent count, bullet count and FPS.
- Add scenario configuration files and JSON/CSV match summaries.
- Add deterministic replay/action logs and unit tests for core rules.

### v0.3 — Research runner
- Execute headless matches without Three.js or a renderer.
- Batch experiments over seeds, loot layouts, safe-zone schedules and bot strategy profiles.
- Compare survival time, encounter rates, land/zone usage, elimination timing and win rates.
- Export reproducible experiment configs and outputs.

### v0.4 — First novel mechanism
- Prototype an adaptive encounter/world director or an alternative safe-zone mechanism.
- Compare it against the baseline using controlled, repeatable scenarios.
- Keep any claim about player experience provisional until validated in human playtests.

### Later
- Add Rapier only if richer collision/rigid-body behavior merits the dependency.
- Build a Unity or Unreal adapter only after a studio/customer validates the mechanism.
- Add Colyseus or another authoritative networking layer only if real multiplayer becomes a confirmed priority.

## Project status

Prototype, intentionally rough around the edges. Treat balance, bot intelligence, fairness and performance numbers as unvalidated until tested. Keep research logs and versioned experiment configs as mechanisms evolve.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
