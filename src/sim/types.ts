export type AgentKind = 'player' | 'bot';
export type LootKind = 'medkit' | 'shard' | 'shield' | 'weapon';
export type MatchPhase = 'ready' | 'scavenge' | 'closing' | 'showdown' | 'victory' | 'eliminated';
export type ObstacleKind = 'tree' | 'rock' | 'building' | 'crate';
export type WeaponId = 'pistol' | 'smg' | 'shotgun' | 'rifle';

export interface Vec2 {
  x: number;
  z: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  tier: number;
  damage: number;
  interval: number;
  speed: number;
  spread: number;
  pellets: number;
  life: number;
  magazine: number;
  reload: number;
}

export interface WeaponSlot {
  weapon: WeaponId;
  ammo: number;
}

export interface Agent {
  id: number;
  kind: AgentKind;
  name: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  facing: number;
  radius: number;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  alive: boolean;
  level: number;
  xp: number;
  kills: number;
  /** Damage multiplier on top of the weapon's base damage. */
  damage: number;
  speed: number;
  fireCooldown: number;
  reloadTimer: number;
  slots: Array<WeaponSlot | null>;
  activeSlot: number;
  thinkCooldown: number;
  aggression: number;
  targetX: number;
  targetZ: number;
  strafeSign: number;
  lastHitAt: number;
  color: string;
}

export interface Loot {
  id: number;
  kind: LootKind;
  weapon?: WeaponId;
  x: number;
  z: number;
  taken: boolean;
  pulse: number;
}

export interface Bullet {
  id: number;
  ownerId: number;
  weapon: WeaponId;
  x: number;
  z: number;
  vx: number;
  vz: number;
  life: number;
  damage: number;
}

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  z: number;
  radius: number;
  scale: number;
  variant: number;
}

export interface Zone {
  x: number;
  z: number;
  radius: number;
  startRadius: number;
  targetRadius: number;
  /** Circle the storm is heading toward during the current stage. */
  nextX: number;
  nextZ: number;
  nextRadius: number;
  stage: number;
  shrinking: boolean;
  /** Seconds until the current hold/shrink step ends. */
  timer: number;
  damage: number;
}

export type SimEvent =
  | { type: 'shot'; ownerId: number; weapon: WeaponId; x: number; z: number; dx: number; dz: number }
  | { type: 'hit'; targetId: number; ownerId: number; amount: number; shield: boolean; x: number; z: number }
  | { type: 'impact'; x: number; z: number }
  | { type: 'elimination'; victimId: number; killerId: number; weapon: WeaponId | 'storm'; x: number; z: number }
  | { type: 'pickup'; agentId: number; kind: LootKind; x: number; z: number }
  | { type: 'reload'; agentId: number }
  | { type: 'zone'; stage: number; shrinking: boolean };

export interface MatchState {
  started: boolean;
  elapsed: number;
  phase: MatchPhase;
  agents: Agent[];
  loot: Loot[];
  bullets: Bullet[];
  obstacles: Obstacle[];
  zone: Zone;
  winnerId: number | null;
  nextId: number;
  playerId: number;
  message: string;
  messageTimer: number;
  /** Events produced since the renderer last drained them. Plain data, safe for headless runs. */
  events: SimEvent[];
}

export interface PlayerInput {
  moveX: number;
  moveZ: number;
  aimX: number;
  aimZ: number;
  shoot: boolean;
  sprint: boolean;
  /** Optional one-shot actions. */
  interact?: boolean;
  reload?: boolean;
  slot?: number;
}

export interface MetricsSnapshot {
  alive: number;
  kills: number;
  elapsed: number;
  phase: MatchPhase;
  playerHp: number;
  playerMaxHp: number;
  playerShield: number;
  playerMaxShield: number;
  level: number;
  xp: number;
  nextLevelXp: number;
  zoneRadius: number;
  zoneStage: number;
  zoneTimer: number;
  zoneShrinking: boolean;
  lootRemaining: number;
}
