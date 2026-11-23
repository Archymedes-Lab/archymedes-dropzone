# Changelog

## 0.2.0 — Battle royale pass
- Dropship flight over a seeded flight line, jump, freefall and steerable glider landing; rivals drop with you.
- Four weapons (sidearm, SMG, shotgun, DMR) with magazines, reloads, spread and pellets; two weapon slots with swap/drop.
- Shields that absorb damage before health, death crates, rarity-coloured loot beams, building loot hot spots and supply-crate cover.
- Five-stage moving storm with announced next circle, hold/shrink timers and rising damage.
- Renderer rebuilt for very low draw counts: instanced operatives, trees, rocks, crates, loot, tracers; merged buildings; one particle pool.
- Shader water with real shoreline foam, storm tint and next-circle line drawn directly on terrain and water, swaying foliage, camera-following shadows.
- HUD: minimap with storm and gunfire pings, kill feed, damage numbers, hit markers, weapon slots, shield/health bars, placement screen.
- Adaptive resolution/shadow quality, a perf overlay on the backquote key and synthesised audio (no asset files).
- Simulation emits plain-data events for effects; bot-vs-bot damage is scaled so the lobby thins out across the whole storm.

## 0.1.0 — First playable slice
- Created a lightweight procedural island and stylized HUD.
- Added player movement, mouse aiming, shooting, AI rivals and projectile combat.
- Added loot, XP, level progression, safe-zone closure and win/loss states.
- Kept the simulation independent of Three.js for future headless runs.
