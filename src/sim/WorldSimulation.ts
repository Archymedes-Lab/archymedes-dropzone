import type {
  Agent, Bullet, Loot, LootKind, MatchPhase, MatchState, MetricsSnapshot, Obstacle, PlayerInput, SimEvent, Vec2, WeaponDef, WeaponId,
} from './types';

export const WORLD_RADIUS = 48;
export const ISLAND_RADIUS = 44;
const BOT_COUNT = 19;
const INITIAL_ZONE_RADIUS = 41;
const XP_PER_LEVEL = 65;
const MAX_LEVEL = 8;
const MAX_SHIELD = 50;
const PICKUP_REACH = 1.05;
const INTERACT_REACH = 1.9;
const MAX_EVENTS = 512;
/** Rivals hurt each other less than they hurt the player, so the lobby thins out over the whole storm, not the first minute. */
const BOT_VS_BOT_DAMAGE = 0.5;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: { id: 'pistol', name: 'SIDEARM', tier: 0, damage: 18, interval: 0.3, speed: 34, spread: 0.03, pellets: 1, life: 0.9, magazine: 12, reload: 1.1 },
  smg: { id: 'smg', name: 'VECTOR SMG', tier: 1, damage: 10, interval: 0.09, speed: 36, spread: 0.085, pellets: 1, life: 0.65, magazine: 30, reload: 1.6 },
  shotgun: { id: 'shotgun', name: 'BREACH-12', tier: 2, damage: 11, interval: 0.82, speed: 32, spread: 0.2, pellets: 7, life: 0.4, magazine: 5, reload: 2.0 },
  rifle: { id: 'rifle', name: 'LONGSHOT DMR', tier: 3, damage: 34, interval: 0.44, speed: 52, spread: 0.012, pellets: 1, life: 0.85, magazine: 8, reload: 1.9 },
};

/** [hold seconds, shrink seconds, target radius, storm damage per second] */
export const ZONE_STAGES: Array<[number, number, number, number]> = [
  [26, 22, 27, 3],
  [18, 20, 17, 5],
  [15, 16, 10, 8],
  [12, 14, 4.5, 12],
  [9, 12, 0, 18],
];

const BOT_RANGE: Record<WeaponId, number> = { pistol: 10, smg: 8, shotgun: 5, rifle: 15 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalize(x: number, z: number): Vec2 {
  const length = Math.hypot(x, z) || 1;
  return { x: x / length, z: z / length };
}

/** Small seeded PRNG: a run can be recreated from the same seed. */
class SeededRandom {
  private seed: number;

  constructor(seed = 20261029) {
    this.seed = seed >>> 0;
  }

  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

export class WorldSimulation {
  readonly state: MatchState;
  private readonly rng: SeededRandom;
  private readonly agentById = new Map<number, Agent>();
  private playerInput: PlayerInput = { moveX: 0, moveZ: 0, aimX: 0, aimZ: 1, shoot: false, sprint: false };
  // One-shot actions survive until a tick consumes them, so a fast render loop never drops a keypress.
  private pendingInteract = false;
  private pendingReload = false;
  private pendingSlot = -1;
  private secondAccumulator = 0;
  private readonly engaged = new Set<number>();

  constructor(seed = 20261029) {
    this.rng = new SeededRandom(seed);
    const obstacles = this.createObstacles();
    const player: Agent = this.createAgent(1, 'player', 'YOU', 0, 0, '#3ef0c8');
    player.maxHp = 120;
    player.hp = 120;

    const agents: Agent[] = [player];
    const colors = ['#ff8a5c', '#ff5f7e', '#c38bff', '#ffd25e', '#6fa8ff'];
    for (let i = 0; i < BOT_COUNT; i++) {
      const position = this.findOpenPosition(10, 41, obstacles, agents);
      const bot = this.createAgent(i + 2, 'bot', `RIVAL-${String(i + 1).padStart(2, '0')}`, position.x, position.z, colors[i % colors.length]);
      bot.aggression = this.rng.range(0.35, 0.92);
      bot.damage = this.rng.range(0.42, 0.55);
      bot.speed = this.rng.range(4.15, 5.2);
      bot.thinkCooldown = this.rng.range(0, 0.5);
      bot.strafeSign = this.rng.next() > 0.5 ? 1 : -1;
      agents.push(bot);
    }

    const loot = this.createLoot(obstacles);
    const [, , firstRadius] = ZONE_STAGES[0];
    this.state = {
      started: false,
      elapsed: 0,
      phase: 'ready',
      agents,
      loot,
      bullets: [],
      obstacles,
      zone: {
        x: 0, z: 0, radius: INITIAL_ZONE_RADIUS, startRadius: INITIAL_ZONE_RADIUS, targetRadius: firstRadius,
        nextX: 0, nextZ: 0, nextRadius: firstRadius, stage: 0, shrinking: false, timer: ZONE_STAGES[0][0], damage: ZONE_STAGES[0][3],
      },
      winnerId: null,
      nextId: 1000,
      playerId: 1,
      message: 'DROP IN WHEN READY',
      messageTimer: 0,
      events: [],
    };
    this.pickNextCircle(firstRadius);
    for (const agent of agents) this.agentById.set(agent.id, agent);
  }

  get player(): Agent {
    return this.agentById.get(this.state.playerId)!;
  }

  agent(id: number): Agent | undefined {
    return this.agentById.get(id);
  }

  /** Moves the player to the nearest open spot to a chosen landing point. Deterministic, uses no randomness. */
  deployPlayer(x: number, z: number): void {
    if (this.state.started) return;
    const player = this.player;
    const r = Math.hypot(x, z);
    if (r > ISLAND_RADIUS - 2) {
      x *= (ISLAND_RADIUS - 2) / r;
      z *= (ISLAND_RADIUS - 2) / r;
    }
    for (let ring = 0; ring < 30; ring++) {
      const steps = Math.max(1, ring * 6);
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * ring * 0.6;
        const pz = z + Math.sin(a) * ring * 0.6;
        if (Math.hypot(px, pz) > ISLAND_RADIUS - 1) continue;
        if (!this.collides(player, px, pz)) {
          player.x = px;
          player.z = pz;
          player.targetX = px;
          player.targetZ = pz;
          return;
        }
      }
    }
  }

  start(): void {
    if (this.state.phase === 'victory' || this.state.phase === 'eliminated') return;
    this.state.started = true;
    this.state.phase = 'scavenge';
    this.state.message = 'SCAVENGE. ADAPT. SURVIVE.';
    this.state.messageTimer = 2.2;
  }

  setInput(input: PlayerInput): void {
    this.playerInput = input;
    if (input.interact) this.pendingInteract = true;
    if (input.reload) this.pendingReload = true;
    if (input.slot !== undefined && input.slot >= 0) this.pendingSlot = input.slot;
  }

  drainEvents(): SimEvent[] {
    const events = this.state.events;
    this.state.events = [];
    return events;
  }

  snapshot(): MetricsSnapshot {
    const player = this.player;
    const zone = this.state.zone;
    return {
      alive: this.state.agents.filter((a) => a.alive).length,
      kills: player.kills,
      elapsed: this.state.elapsed,
      phase: this.state.phase,
      playerHp: player.hp,
      playerMaxHp: player.maxHp,
      playerShield: player.shield,
      playerMaxShield: player.maxShield,
      level: player.level,
      xp: player.xp,
      nextLevelXp: player.level * XP_PER_LEVEL,
      zoneRadius: zone.radius,
      zoneStage: zone.stage,
      zoneTimer: zone.timer,
      zoneShrinking: zone.shrinking,
      lootRemaining: this.state.loot.filter((item) => !item.taken).length,
    };
  }

  /** The weapon on the ground the player could swap to with the interact key, if any. */
  interactTarget(): Loot | undefined {
    const player = this.player;
    let best: Loot | undefined;
    let bestD = INTERACT_REACH;
    for (const loot of this.state.loot) {
      if (loot.taken || loot.kind !== 'weapon') continue;
      const d = distance(player, loot);
      if (d < bestD) { best = loot; bestD = d; }
    }
    return best;
  }

  step(rawDt: number): void {
    if (!this.state.started || this.isFinished()) return;
    // Fixed-step simulation makes experiment runs easier to compare across frame rates.
    this.secondAccumulator += Math.min(rawDt, 0.08);
    const fixedDt = 1 / 60;
    let steps = 0;
    while (this.secondAccumulator >= fixedDt && steps < 6 && !this.isFinished()) {
      this.tick(fixedDt);
      this.secondAccumulator -= fixedDt;
      steps++;
    }
  }

  private tick(dt: number): void {
    this.state.elapsed += dt;
    if (this.state.messageTimer > 0) this.state.messageTimer = Math.max(0, this.state.messageTimer - dt);
    this.updateZone(dt);
    this.updatePhase();

    for (const agent of this.state.agents) {
      if (!agent.alive) continue;
      agent.fireCooldown = Math.max(0, agent.fireCooldown - dt);
      if (agent.reloadTimer > 0) {
        agent.reloadTimer -= dt;
        if (agent.reloadTimer <= 0) {
          agent.reloadTimer = 0;
          const slot = agent.slots[agent.activeSlot];
          if (slot) slot.ammo = WEAPONS[slot.weapon].magazine;
        }
      }
      if (agent.kind === 'player') this.updatePlayer(agent, dt);
      else this.updateBot(agent, dt);
    }

    this.updateBullets(dt);
    this.updateLootPickups();
    this.applyZoneDamage(dt);
    this.checkEndState();
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
  }

  isFinished(): boolean {
    return this.state.phase === 'victory' || this.state.phase === 'eliminated';
  }

  private emit(event: SimEvent): void {
    this.state.events.push(event);
  }

  private createAgent(id: number, kind: 'player' | 'bot', name: string, x: number, z: number, color: string): Agent {
    return {
      id, kind, name, x, z, vx: 0, vz: 0, facing: 0, radius: kind === 'player' ? 0.68 : 0.62,
      hp: 100, maxHp: 100, shield: 0, maxShield: MAX_SHIELD, alive: true, level: 1, xp: 0, kills: 0, damage: 1,
      speed: kind === 'player' ? 6.4 : 4.6, fireCooldown: 0, reloadTimer: 0,
      slots: [{ weapon: 'pistol', ammo: WEAPONS.pistol.magazine }, null], activeSlot: 0, thinkCooldown: 0,
      aggression: kind === 'player' ? 1 : 0.62, targetX: x, targetZ: z,
      strafeSign: this.rng.next() > 0.5 ? 1 : -1, lastHitAt: -10, color,
    };
  }

  private createObstacles(): Obstacle[] {
    const obstacles: Obstacle[] = [];
    let id = 1;
    // Deliberately placed buildings make recognizable landmarks, loot hot spots and combat cover.
    const buildings: Array<[number, number, number]> = [
      [-17, -13, 1.15], [17, 5, 1.0], [-6, 23, 0.92], [27, -18, 1.0],
      [-27, 11, 0.9], [8, -29, 0.88], [29, 22, 0.8], [-29, -25, 0.9],
    ];
    for (const [x, z, scale] of buildings) {
      obstacles.push({ id: id++, kind: 'building', x, z, radius: 2.8 * scale, scale, variant: Math.floor(this.rng.next() * 3) });
    }

    // Supply crates give mid-field cover between landmarks.
    for (const [bx, bz] of buildings) {
      const count = 1 + Math.floor(this.rng.next() * 2);
      for (let c = 0; c < count; c++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const x = bx + Math.cos(angle) * this.rng.range(5, 7.5);
        const z = bz + Math.sin(angle) * this.rng.range(5, 7.5);
        if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + 1.8)) continue;
        obstacles.push({ id: id++, kind: 'crate', x, z, radius: 0.8, scale: 1, variant: Math.floor(this.rng.next() * 3) });
      }
    }

    let placed = 0;
    let attempts = 0;
    while (placed < 66 && attempts < 800) {
      attempts++;
      const angle = this.rng.range(0, Math.PI * 2);
      const radius = Math.sqrt(this.rng.next()) * 43;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (Math.hypot(x, z) < 7) continue;
      if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + 2.1)) continue;
      const kind = this.rng.next() < 0.74 ? 'tree' : 'rock';
      const scale = kind === 'tree' ? this.rng.range(0.78, 1.28) : this.rng.range(0.7, 1.35);
      obstacles.push({ id: id++, kind, x, z, radius: (kind === 'tree' ? 0.8 : 1.0) * scale, scale, variant: Math.floor(this.rng.next() * 3) });
      placed++;
    }
    return obstacles;
  }

  private rollLootKind(nearBuilding: boolean): { kind: LootKind; weapon?: WeaponId } {
    const roll = this.rng.next();
    const weaponChance = nearBuilding ? 0.42 : 0.24;
    if (roll < weaponChance) {
      const w = this.rng.next();
      return { kind: 'weapon', weapon: w < 0.4 ? 'smg' : w < 0.72 ? 'shotgun' : 'rifle' };
    }
    if (roll < weaponChance + 0.16) return { kind: 'shield' };
    if (roll < weaponChance + 0.36) return { kind: 'medkit' };
    return { kind: 'shard' };
  }

  private createLoot(obstacles: Obstacle[]): Loot[] {
    const result: Loot[] = [];
    let id = 200;
    const taken = () => result.map((l) => ({ x: l.x, z: l.z, radius: 1.4 }));
    for (const building of obstacles.filter((o) => o.kind === 'building')) {
      for (let i = 0; i < 4; i++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const r = building.radius + this.rng.range(1.2, 3.2);
        let x = building.x + Math.cos(angle) * r;
        let z = building.z + Math.sin(angle) * r;
        if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + 0.9) || Math.hypot(x, z) > ISLAND_RADIUS - 1) {
          const pos = this.findOpenPosition(5, 43, obstacles, taken());
          x = pos.x;
          z = pos.z;
        }
        const roll = this.rollLootKind(true);
        result.push({ id: id++, ...roll, x, z, taken: false, pulse: this.rng.range(0, Math.PI * 2) });
      }
    }
    for (let i = 0; i < 26; i++) {
      const pos = this.findOpenPosition(5, 43, obstacles, taken());
      const roll = this.rollLootKind(false);
      result.push({ id: id++, ...roll, x: pos.x, z: pos.z, taken: false, pulse: this.rng.range(0, Math.PI * 2) });
    }
    return result;
  }

  private findOpenPosition(minRadius: number, maxRadius: number, obstacles: Array<{ x: number; z: number; radius: number }>, agents: Array<{ x: number; z: number; radius?: number }>): Vec2 {
    for (let tries = 0; tries < 160; tries++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const radius = Math.sqrt(this.rng.range(minRadius * minRadius, maxRadius * maxRadius));
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const obstacleHit = obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + 1.15);
      const agentHit = agents.some((a) => Math.hypot(a.x - x, a.z - z) < (a.radius ?? 0.6) + 2.3);
      if (!obstacleHit && !agentHit) return { x, z };
    }
    return { x: this.rng.range(-25, 25), z: this.rng.range(-25, 25) };
  }

  private pickNextCircle(nextRadius: number): void {
    const zone = this.state.zone;
    const slack = Math.max(0, zone.radius - nextRadius);
    for (let tries = 0; tries < 12; tries++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * slack * 0.85;
      const x = zone.x + Math.cos(angle) * r;
      const z = zone.z + Math.sin(angle) * r;
      if (Math.hypot(x, z) + nextRadius <= ISLAND_RADIUS - 2 || tries === 11) {
        zone.nextX = x;
        zone.nextZ = z;
        break;
      }
    }
    zone.nextRadius = nextRadius;
    zone.targetRadius = nextRadius;
  }

  private updatePhase(): void {
    const zone = this.state.zone;
    const next: MatchPhase = zone.stage === 0 && !zone.shrinking ? 'scavenge' : zone.stage < 3 ? 'closing' : 'showdown';
    if (this.state.phase !== next) {
      this.state.phase = next;
      this.showMessage(next === 'closing' ? 'STORM MOVING — FIND YOUR ROUTE' : 'FINAL CIRCLES — STAY SHARP', 3.0);
    }
  }

  private updateZone(dt: number): void {
    const zone = this.state.zone;
    if (zone.stage >= ZONE_STAGES.length) return;
    zone.timer -= dt;
    const [, shrink, targetRadius, damage] = ZONE_STAGES[zone.stage];
    zone.damage = damage;
    if (zone.shrinking) {
      // Interpolate from where the stage started, so the circle lands exactly on the announced one.
      const k = dt / Math.max(1e-6, zone.timer + dt);
      zone.x += (zone.nextX - zone.x) * k;
      zone.z += (zone.nextZ - zone.z) * k;
      zone.radius += (targetRadius - zone.radius) * k;
      if (zone.timer <= 0) {
        zone.x = zone.nextX;
        zone.z = zone.nextZ;
        zone.radius = targetRadius;
        zone.stage++;
        zone.shrinking = false;
        if (zone.stage < ZONE_STAGES.length) {
          zone.timer = ZONE_STAGES[zone.stage][0];
          this.pickNextCircle(ZONE_STAGES[zone.stage][2]);
        } else {
          zone.timer = 0;
        }
        this.emit({ type: 'zone', stage: zone.stage, shrinking: false });
      }
    } else if (zone.timer <= 0) {
      zone.shrinking = true;
      zone.timer = shrink;
      if (zone.stage > 0) this.showMessage('STORM CLOSING IN', 2.4);
      this.emit({ type: 'zone', stage: zone.stage, shrinking: true });
    }
  }

  private activeWeapon(agent: Agent): WeaponId | null {
    return agent.slots[agent.activeSlot]?.weapon ?? null;
  }

  private startReload(agent: Agent): void {
    const slot = agent.slots[agent.activeSlot];
    if (!slot || agent.reloadTimer > 0) return;
    const def = WEAPONS[slot.weapon];
    if (slot.ammo >= def.magazine) return;
    agent.reloadTimer = def.reload;
    this.emit({ type: 'reload', agentId: agent.id });
  }

  /** Fires the active weapon if it is ready. Returns true when a shot left the barrel. */
  private tryFire(agent: Agent, dirX: number, dirZ: number, rateScale: number, aimError: number): boolean {
    const slot = agent.slots[agent.activeSlot];
    if (!slot || agent.fireCooldown > 0 || agent.reloadTimer > 0) return false;
    if (slot.ammo <= 0) {
      this.startReload(agent);
      return false;
    }
    const def = WEAPONS[slot.weapon];
    const base = Math.atan2(dirX, dirZ) + (aimError ? this.rng.range(-aimError, aimError) : 0);
    for (let p = 0; p < def.pellets; p++) {
      const angle = base + this.rng.range(-def.spread, def.spread);
      this.fire(agent, Math.sin(angle), Math.cos(angle), def.damage * agent.damage, def);
    }
    this.emit({ type: 'shot', ownerId: agent.id, weapon: def.id, x: agent.x, z: agent.z, dx: Math.sin(base), dz: Math.cos(base) });
    slot.ammo--;
    agent.fireCooldown = def.interval * rateScale;
    if (slot.ammo <= 0) this.startReload(agent);
    return true;
  }

  private giveWeapon(agent: Agent, loot: Loot): void {
    if (!loot.weapon) return;
    const def = WEAPONS[loot.weapon];
    let slotIndex = agent.slots.findIndex((s) => s === null);
    if (slotIndex < 0) {
      slotIndex = agent.activeSlot;
      const old = agent.slots[slotIndex];
      if (old) this.dropLoot('weapon', agent.x + 0.6, agent.z + 0.4, old.weapon);
    }
    agent.slots[slotIndex] = { weapon: def.id, ammo: def.magazine };
    agent.activeSlot = slotIndex;
    agent.reloadTimer = 0;
    agent.fireCooldown = Math.max(agent.fireCooldown, 0.25);
    loot.taken = true;
    this.emit({ type: 'pickup', agentId: agent.id, kind: 'weapon', x: loot.x, z: loot.z });
    if (agent.kind === 'player') this.showMessage(`${def.name} EQUIPPED`, 1.3);
  }

  private dropLoot(kind: LootKind, x: number, z: number, weapon?: WeaponId): void {
    const r = Math.hypot(x, z);
    if (r > ISLAND_RADIUS - 1) {
      x *= (ISLAND_RADIUS - 1) / r;
      z *= (ISLAND_RADIUS - 1) / r;
    }
    this.state.loot.push({ id: this.state.nextId++, kind, weapon, x, z, taken: false, pulse: this.rng.range(0, Math.PI * 2) });
  }

  private updatePlayer(player: Agent, dt: number): void {
    player.vx = 0;
    player.vz = 0;
    const input = this.playerInput;
    let dx = input.moveX;
    let dz = input.moveZ;
    if (dx !== 0 || dz !== 0) {
      const direction = normalize(dx, dz);
      const speed = player.speed * (input.sprint ? 1.38 : 1);
      dx = direction.x * speed * dt;
      dz = direction.z * speed * dt;
      this.moveAgent(player, dx, dz);
    }

    if (this.pendingSlot >= 0) {
      const slot = this.pendingSlot;
      this.pendingSlot = -1;
      if (slot !== player.activeSlot && player.slots[slot]) {
        player.activeSlot = slot;
        player.reloadTimer = 0;
        player.fireCooldown = Math.max(player.fireCooldown, 0.2);
      }
    }
    if (this.pendingReload) {
      this.pendingReload = false;
      this.startReload(player);
    }
    if (this.pendingInteract) {
      this.pendingInteract = false;
      const target = this.interactTarget();
      if (target) this.giveWeapon(player, target);
    }

    const aimDx = input.aimX - player.x;
    const aimDz = input.aimZ - player.z;
    player.facing = Math.atan2(aimDx, aimDz);
    if (input.shoot && Math.hypot(aimDx, aimDz) > 1.4) {
      const aim = normalize(aimDx, aimDz);
      this.tryFire(player, aim.x, aim.z, Math.max(0.6, 1 - (player.level - 1) * 0.05), 0);
    }
  }

  private updateBot(bot: Agent, dt: number): void {
    bot.vx = 0;
    bot.vz = 0;
    bot.thinkCooldown -= dt;
    const weapon = this.activeWeapon(bot) ?? 'pistol';
    const def = WEAPONS[weapon];
    const fireRange = Math.min(def.speed * def.life * 0.85, 17);
    if (bot.thinkCooldown <= 0) {
      bot.thinkCooldown = this.rng.range(0.19, 0.39);
      let nearest: Agent | undefined;
      let nearestD = 19;
      for (const agent of this.state.agents) {
        if (!agent.alive || agent.id === bot.id) continue;
        if (agent.kind === 'player' && this.state.elapsed < 10) continue;
        const d = distance(bot, agent);
        if (d < nearestD) { nearest = agent; nearestD = d; }
      }

      const zone = this.state.zone;
      const lowHp = bot.hp < 40;
      this.engaged.delete(bot.id);
      if (nearest && nearestD < 15.5 && !(lowHp && nearestD > 8)) {
        this.engaged.add(bot.id);
        const target = nearest;
        const towards = normalize(target.x - bot.x, target.z - bot.z);
        const d = nearestD;
        const preferred = BOT_RANGE[weapon];
        if (d > preferred + 3) {
          bot.targetX = target.x;
          bot.targetZ = target.z;
        } else if (d < preferred * 0.5) {
          bot.targetX = bot.x - towards.x * 6 + -towards.z * bot.strafeSign * 3;
          bot.targetZ = bot.z - towards.z * 6 + towards.x * bot.strafeSign * 3;
        } else {
          bot.targetX = target.x - towards.x * preferred + -towards.z * bot.strafeSign * 5;
          bot.targetZ = target.z - towards.z * preferred + towards.x * bot.strafeSign * 5;
        }
        bot.facing = Math.atan2(towards.x, towards.z);
        if (d < fireRange && this.hasLineOfSight(bot, target)) {
          // Aim error grows with distance; aggressive bots fire more often.
          this.tryFire(bot, towards.x, towards.z, 3.8 - bot.aggression * 1.6, 0.06 + d * 0.012);
        }
        if (this.rng.next() < 0.08) bot.strafeSign *= -1;
      } else {
        const lootTarget = this.findUsefulLoot(bot);
        const zoneDistance = Math.hypot(bot.x - zone.x, bot.z - zone.z);
        const nextDistance = Math.hypot(bot.x - zone.nextX, bot.z - zone.nextZ);
        const headForNext = (zone.shrinking || zone.timer < 9) && nextDistance > zone.nextRadius - 2;
        if (zoneDistance > zone.radius - 3.5 || headForNext) {
          const cx = headForNext ? zone.nextX : zone.x;
          const cz = headForNext ? zone.nextZ : zone.z;
          const cr = headForNext ? zone.nextRadius : zone.radius;
          const fromZone = normalize(bot.x - cx, bot.z - cz);
          bot.targetX = cx + fromZone.x * Math.max(0, cr * 0.6);
          bot.targetZ = cz + fromZone.z * Math.max(0, cr * 0.6);
        } else if (lootTarget) {
          bot.targetX = lootTarget.x;
          bot.targetZ = lootTarget.z;
        } else if (Math.hypot(bot.x - bot.targetX, bot.z - bot.targetZ) < 3 || this.rng.next() < 0.15) {
          const angle = this.rng.range(0, Math.PI * 2);
          const radius = this.rng.range(0, Math.max(1, zone.radius - 4));
          bot.targetX = zone.x + Math.cos(angle) * radius;
          bot.targetZ = zone.z + Math.sin(angle) * radius;
        }
        if (this.activeWeapon(bot) && bot.slots[0]!.ammo < def.magazine * 0.5) this.startReload(bot);
      }
    }

    const direction = normalize(bot.targetX - bot.x, bot.targetZ - bot.z);
    const distanceToTarget = Math.hypot(bot.targetX - bot.x, bot.targetZ - bot.z);
    if (distanceToTarget > 1.35) {
      const speed = bot.speed * (distanceToTarget < 4 ? 0.68 : 1);
      this.moveAgent(bot, direction.x * speed * dt, direction.z * speed * dt);
      if (!this.engaged.has(bot.id)) bot.facing = Math.atan2(bot.vx, bot.vz);
    }
  }

  private findUsefulLoot(agent: Agent): Loot | undefined {
    const tier = WEAPONS[this.activeWeapon(agent) ?? 'pistol'].tier;
    let best: Loot | undefined;
    let bestD = 17;
    for (const loot of this.state.loot) {
      if (loot.taken) continue;
      const useful = loot.kind === 'shard'
        || (loot.kind === 'medkit' && agent.hp < agent.maxHp - 22)
        || (loot.kind === 'shield' && agent.shield < agent.maxShield - 10)
        || (loot.kind === 'weapon' && WEAPONS[loot.weapon!].tier > tier);
      if (!useful) continue;
      const d = distance(agent, loot);
      if (d < bestD) { best = loot; bestD = d; }
    }
    return best;
  }

  private hasLineOfSight(from: Vec2, to: Vec2): boolean {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthSq = dx * dx + dz * dz || 1;
    for (const obstacle of this.state.obstacles) {
      const t = clamp(((obstacle.x - from.x) * dx + (obstacle.z - from.z) * dz) / lengthSq, 0.04, 0.96);
      const closestX = from.x + dx * t;
      const closestZ = from.z + dz * t;
      const blockingRadius = obstacle.radius * (obstacle.kind === 'building' ? 0.96 : 0.78);
      if (Math.hypot(obstacle.x - closestX, obstacle.z - closestZ) < blockingRadius) return false;
    }
    return true;
  }

  private moveAgent(agent: Agent, dx: number, dz: number): void {
    let nextX = agent.x + dx;
    let nextZ = agent.z;
    if (!this.collides(agent, nextX, nextZ)) agent.x = nextX;
    nextX = agent.x;
    nextZ = agent.z + dz;
    if (!this.collides(agent, nextX, nextZ)) agent.z = nextZ;

    const fromCenter = Math.hypot(agent.x, agent.z);
    const limit = WORLD_RADIUS - agent.radius - 0.2;
    if (fromCenter > limit) {
      const n = normalize(agent.x, agent.z);
      agent.x = n.x * limit;
      agent.z = n.z * limit;
    }
    agent.vx = dx;
    agent.vz = dz;
  }

  private collides(agent: Agent, x: number, z: number): boolean {
    for (const obstacle of this.state.obstacles) {
      if (Math.hypot(x - obstacle.x, z - obstacle.z) < agent.radius + obstacle.radius * (obstacle.kind === 'building' ? 0.94 : 0.92)) return true;
    }
    return false;
  }

  private fire(owner: Agent, dx: number, dz: number, damage: number, def: WeaponDef): void {
    const id = this.state.nextId++;
    this.state.bullets.push({
      id, ownerId: owner.id, weapon: def.id,
      x: owner.x + dx * (owner.radius + 0.42), z: owner.z + dz * (owner.radius + 0.42),
      vx: dx * def.speed, vz: dz * def.speed, life: def.life, damage,
    });
  }

  private damageAgent(agent: Agent, amount: number, ownerId: number, weapon: WeaponId | 'storm'): void {
    const absorbed = Math.min(agent.shield, amount);
    agent.shield -= absorbed;
    agent.hp -= amount - absorbed;
    agent.lastHitAt = this.state.elapsed;
    if (weapon !== 'storm') this.emit({ type: 'hit', targetId: agent.id, ownerId, amount, shield: absorbed > 0, x: agent.x, z: agent.z });
    if (agent.hp <= 0) this.eliminate(agent, ownerId, weapon);
  }

  private updateBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const bullet of this.state.bullets) {
      bullet.x += bullet.vx * dt;
      bullet.z += bullet.vz * dt;
      bullet.life -= dt;
      if (bullet.life <= 0 || Math.hypot(bullet.x, bullet.z) > WORLD_RADIUS + 2) continue;
      const hitsObstacle = this.state.obstacles.some((o) => Math.hypot(bullet.x - o.x, bullet.z - o.z) < o.radius * (o.kind === 'building' ? 0.9 : 0.75));
      if (hitsObstacle) {
        this.emit({ type: 'impact', x: bullet.x, z: bullet.z });
        continue;
      }
      let hit = false;
      for (const agent of this.state.agents) {
        if (!agent.alive || agent.id === bullet.ownerId) continue;
        if (Math.hypot(bullet.x - agent.x, bullet.z - agent.z) < agent.radius + 0.24) {
          hit = true;
          const botOnBot = agent.kind === 'bot' && this.agentById.get(bullet.ownerId)?.kind === 'bot';
          this.damageAgent(agent, bullet.damage * (botOnBot ? BOT_VS_BOT_DAMAGE : 1), bullet.ownerId, bullet.weapon);
          break;
        }
      }
      if (!hit) survivors.push(bullet);
    }
    this.state.bullets = survivors;
  }

  private eliminate(agent: Agent, killerId: number, weapon: WeaponId | 'storm'): void {
    if (!agent.alive) return;
    agent.alive = false;
    agent.hp = 0;
    this.emit({ type: 'elimination', victimId: agent.id, killerId, weapon, x: agent.x, z: agent.z });
    // Death crate: the victim's best weapon and a data shard stay on the field.
    const best = agent.slots
      .filter((slot): slot is NonNullable<typeof slot> => slot !== null && slot.weapon !== 'pistol')
      .sort((a, b) => WEAPONS[b.weapon].tier - WEAPONS[a.weapon].tier)[0];
    if (best) this.dropLoot('weapon', agent.x + 0.5, agent.z, best.weapon);
    this.dropLoot(agent.shield > 0 || this.rng.next() < 0.4 ? 'shield' : 'shard', agent.x - 0.5, agent.z + 0.3);
    const killer = this.agentById.get(killerId);
    if (killer) {
      killer.kills++;
      killer.xp += 18;
      if (killer.kind === 'player') this.showMessage(`ELIMINATED ${agent.name}  +18 XP`, 1.6);
      this.applyLevelUps(killer);
    }
    if (agent.kind === 'player') {
      this.state.phase = 'eliminated';
      this.state.message = 'RUN ENDED';
    }
  }

  private updateLootPickups(): void {
    for (const loot of this.state.loot) {
      if (loot.taken) continue;
      for (const agent of this.state.agents) {
        if (!agent.alive || distance(agent, loot) > agent.radius + PICKUP_REACH) continue;
        if (loot.kind === 'medkit') {
          if (agent.hp >= agent.maxHp - 5) continue;
          agent.hp = Math.min(agent.maxHp, agent.hp + 38);
          loot.taken = true;
          if (agent.kind === 'player') this.showMessage('FIELD KIT +38 HP', 1.4);
        } else if (loot.kind === 'shield') {
          if (agent.shield >= agent.maxShield - 2) continue;
          agent.shield = Math.min(agent.maxShield, agent.shield + 25);
          loot.taken = true;
          if (agent.kind === 'player') this.showMessage('SHIELD CELL +25', 1.3);
        } else if (loot.kind === 'weapon') {
          // Players pick up into an empty slot automatically; swapping a full loadout needs the interact key.
          const owned = agent.slots.some((s) => s?.weapon === loot.weapon);
          if (owned) continue;
          if (agent.kind === 'player') {
            if (agent.slots.some((s) => s === null)) this.giveWeapon(agent, loot);
            else continue;
          } else {
            if (WEAPONS[loot.weapon!].tier <= WEAPONS[this.activeWeapon(agent) ?? 'pistol'].tier) continue;
            agent.slots[0] = null;
            agent.activeSlot = 0;
            this.giveWeapon(agent, loot);
          }
        } else {
          loot.taken = true;
          agent.xp += 24;
          if (agent.kind === 'player') this.showMessage('DATA SHARD +24 XP', 1.3);
          this.applyLevelUps(agent);
        }
        if (loot.kind !== 'weapon') this.emit({ type: 'pickup', agentId: agent.id, kind: loot.kind, x: loot.x, z: loot.z });
        break;
      }
    }
  }

  private applyLevelUps(agent: Agent): void {
    while (agent.xp >= agent.level * XP_PER_LEVEL && agent.level < MAX_LEVEL) {
      agent.xp -= agent.level * XP_PER_LEVEL;
      agent.level++;
      agent.damage += agent.kind === 'player' ? 0.12 : 0.04;
      agent.maxHp += 8;
      agent.hp = Math.min(agent.maxHp, agent.hp + 22);
      if (agent.kind === 'player') this.showMessage(`LEVEL ${agent.level} — WEAPON OVERCLOCKED`, 2.0);
    }
    if (agent.level >= MAX_LEVEL) agent.xp = Math.min(agent.xp, XP_PER_LEVEL - 1);
  }

  private applyZoneDamage(dt: number): void {
    const zone = this.state.zone;
    for (const agent of this.state.agents) {
      if (!agent.alive) continue;
      if (Math.hypot(agent.x - zone.x, agent.z - zone.z) > zone.radius) {
        // The storm ignores shields, like most battle royales.
        agent.hp -= zone.damage * dt;
        if (agent.hp <= 0) this.eliminate(agent, -1, 'storm');
      }
    }
  }

  private checkEndState(): void {
    if (!this.player.alive) {
      this.state.phase = 'eliminated';
      this.state.winnerId = null;
      return;
    }
    const alive = this.state.agents.filter((agent) => agent.alive);
    if (alive.length === 1 && alive[0].id === this.state.playerId) {
      this.state.phase = 'victory';
      this.state.winnerId = this.player.id;
      this.state.message = 'ISLAND SECURED';
    }
  }

  private showMessage(message: string, seconds: number): void {
    this.state.message = message;
    this.state.messageTimer = seconds;
  }
}
