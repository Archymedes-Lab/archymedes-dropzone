# Mechanism research log

Use one entry per hypothesis. Do not overwrite earlier configurations; record version and seed so a result can be reproduced.

## Experiment 000 — baseline battle loop

- **Status:** Prototype baseline; not a validated player-experience result.
- **Build:** 0.1.0
- **Seed:** 20261029 by default; pass `?seed=731` to select another seed.
- **Question:** Can the local simulation produce repeatable runs with movement, combat, AI rivals, loot, progression and a shrinking zone?
- **Baseline mechanics:** 19 AI rivals; 60 Hz fixed-step simulation; 41 m starting zone radius; zone contraction starts after 22 s; XP pickups and eliminations increase level/weapon damage.
- **Existing tests:** Same-seed map generation; idle state before deployment; player movement; repeated seeded sequence reproducibility.
- **Not yet measured:** Real-player representativeness, frame-time budget, win-rate balance, fairness, pathfinding quality and any retention effect.
- **Next step:** Add frame/tick profiling and a headless batch runner before evaluating a new mechanism.

## Reusable experiment template

- **ID / build:**
- **Hypothesis:**
- **Mechanism change:**
- **Baseline configuration:**
- **Treatment configuration:**
- **Seeds and run count:**
- **Primary metric:**
- **Secondary metrics:**
- **Observed result and uncertainty:**
- **Regression checks:**
- **Limitations / confounders:**
- **Decision:** Keep / revise / reject / investigate further
