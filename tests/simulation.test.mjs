import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldSimulation } from '../src/sim/WorldSimulation.ts';

test('same seed creates the same initial world', () => {
  const a = new WorldSimulation(731);
  const b = new WorldSimulation(731);
  assert.deepEqual(a.state.obstacles, b.state.obstacles);
  assert.deepEqual(a.state.loot, b.state.loot);
  assert.deepEqual(a.state.agents, b.state.agents);
  assert.equal(a.state.agents.length, 20);
});

test('simulation stays idle until the player deploys', () => {
  const sim = new WorldSimulation(17);
  sim.step(0.5);
  assert.equal(sim.state.elapsed, 0);
  assert.equal(sim.state.phase, 'ready');
  sim.start();
  assert.equal(sim.state.phase, 'scavenge');
});

test('player movement advances through the fixed-step simulation', () => {
  const sim = new WorldSimulation(17);
  sim.start();
  const startZ = sim.player.z;
  sim.setInput({ moveX: 0, moveZ: -1, aimX: 10, aimZ: -10, shoot: false, sprint: false });
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  assert.ok(sim.state.elapsed > 0.98 && sim.state.elapsed < 1.02);
  assert.ok(sim.player.z < startZ);
});

test('a repeated seeded input sequence is reproducible', () => {
  const run = () => {
    const sim = new WorldSimulation(404);
    sim.start();
    for (let i = 0; i < 900 && !sim.isFinished(); i++) {
      sim.setInput({
        moveX: Math.sin(i / 90) * 0.6,
        moveZ: -0.4,
        aimX: 17,
        aimZ: -11,
        shoot: i % 3 === 0,
        sprint: i % 180 < 40,
      });
      sim.step(1 / 60);
    }
    return {
      elapsed: sim.state.elapsed,
      phase: sim.state.phase,
      alive: sim.snapshot().alive,
      kills: sim.player.kills,
      position: { x: sim.player.x, z: sim.player.z },
    };
  };
  assert.deepEqual(run(), run());
});

test('the storm runs through every stage and closes completely', () => {
  const sim = new WorldSimulation(88);
  sim.start();
  const radii = [];
  let lastStage = 0;
  for (let i = 0; i < 60 * 240 && !sim.isFinished(); i++) {
    // Keep everyone alive so only the storm schedule is exercised.
    for (const a of sim.state.agents) a.hp = a.maxHp;
    const z = sim.state.zone;
    sim.player.x = z.x;
    sim.player.z = z.z;
    if (z.stage !== lastStage) { radii.push(z.radius); lastStage = z.stage; }
    sim.step(1 / 60);
  }
  assert.deepEqual(radii.map((r) => Math.round(r * 10) / 10), [27, 17, 10, 4.5, 0]);
});

test('next circle always stays inside the current one', () => {
  for (const seed of [3, 41, 977, 20261029]) {
    const sim = new WorldSimulation(seed);
    sim.start();
    let stage = -1;
    for (let i = 0; i < 60 * 200 && !sim.isFinished(); i++) {
      sim.player.hp = sim.player.maxHp;
      const z = sim.state.zone;
      if (z.stage !== stage && !z.shrinking) {
        stage = z.stage;
        assert.ok(Math.hypot(z.nextX - z.x, z.nextZ - z.z) + z.nextRadius <= z.radius + 1e-6, `seed ${seed} stage ${stage}`);
      }
      sim.step(1 / 60);
    }
  }
});

test('shields absorb damage before health and the storm ignores shields', () => {
  const sim = new WorldSimulation(5);
  sim.start();
  const bot = sim.state.agents[1];
  bot.shield = 20;
  const hp = bot.hp;
  sim.state.bullets.push({ id: 9999, ownerId: 1, weapon: 'pistol', x: bot.x, z: bot.z, vx: 0, vz: 0, life: 1, damage: 30 });
  sim.step(1 / 60);
  assert.equal(bot.shield, 0);
  assert.equal(bot.hp, hp - 10);
  const hit = sim.drainEvents().find((e) => e.type === 'hit');
  assert.ok(hit && hit.shield);
});

test('walking over a weapon fills the empty slot, E swaps a full loadout', () => {
  const sim = new WorldSimulation(12);
  sim.start();
  const p = sim.player;
  sim.state.loot.push({ id: 5001, kind: 'weapon', weapon: 'shotgun', x: p.x, z: p.z, taken: false, pulse: 0 });
  sim.step(1 / 60);
  assert.equal(p.slots[1]?.weapon, 'shotgun');
  assert.equal(p.activeSlot, 1);
  sim.state.loot.push({ id: 5002, kind: 'weapon', weapon: 'rifle', x: p.x, z: p.z, taken: false, pulse: 0 });
  sim.step(1 / 60);
  assert.equal(p.slots[1]?.weapon, 'shotgun', 'a full loadout does not auto-swap');
  sim.setInput({ moveX: 0, moveZ: 0, aimX: p.x + 5, aimZ: p.z, shoot: false, sprint: false, interact: true });
  sim.step(1 / 60);
  assert.equal(p.slots[1]?.weapon, 'rifle');
  assert.ok(sim.state.loot.some((l) => !l.taken && l.kind === 'weapon' && l.weapon === 'shotgun'), 'old weapon is dropped');
});

test('firing spends ammo and an empty magazine reloads', () => {
  const sim = new WorldSimulation(12);
  sim.start();
  const p = sim.player;
  const slot = p.slots[0];
  for (let i = 0; i < 60 * 6; i++) {
    sim.player.hp = sim.player.maxHp;
    sim.setInput({ moveX: 0, moveZ: 0, aimX: p.x + 6, aimZ: p.z, shoot: true, sprint: false });
    sim.step(1 / 60);
  }
  assert.ok(sim.drainEvents().some((e) => e.type === 'reload' && e.agentId === 1));
  assert.ok(slot.ammo > 0);
});

test('deploying the player is deterministic and lands on open ground', () => {
  const a = new WorldSimulation(731);
  const b = new WorldSimulation(731);
  a.deployPlayer(-17, -13);
  b.deployPlayer(-17, -13);
  assert.deepEqual({ x: a.player.x, z: a.player.z }, { x: b.player.x, z: b.player.z });
  const blocked = a.state.obstacles.some((o) => Math.hypot(o.x - a.player.x, o.z - a.player.z) < o.radius * 0.94 + a.player.radius);
  assert.equal(blocked, false);
});
