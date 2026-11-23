import * as THREE from 'three';
import { Sfx } from './audio';
import { $, formatTime, Hud } from './hud';
import { Actors, type ActorPose } from './render/actors';
import { createClouds, createPlane, createStormWall, lootColor, LootField, Particles, Tracers } from './render/effects';
import { PALETTE } from './render/palette';
import { buildWorld, heightAt, zoneUniforms } from './render/world';
import { ISLAND_RADIUS, WEAPONS, WorldSimulation, ZONE_STAGES } from './sim/WorldSimulation';
import type { PlayerInput } from './sim/types';
import './style.css';

type Flow = 'intro' | 'flight' | 'falling' | 'match' | 'over';

const app = $('#app');
const canvas = $('#game-canvas') as HTMLCanvasElement;
const intro = $('#intro');
const gameover = $('#gameover');
const hudRoot = $('#hud');
const dropHud = $('#drop-hud');
const crosshair = $('#crosshair');
const perf = $('#perf');

// --- Renderer: one sun with a tight, camera-following shadow map; everything else is cheap Lambert. ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
let pixelRatio = maxPixelRatio;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.fog);
scene.fog = new THREE.Fog(PALETTE.fog, 70, 190);
const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.5, 320);

scene.add(new THREE.HemisphereLight('#e4f6ff', '#7a9a6c', 1.55));
const sun = new THREE.DirectionalLight('#fff1d8', 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.03;
const shadowCam = sun.shadow.camera;
shadowCam.near = 1;
shadowCam.far = 120;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(-20, 38, 16);

function setShadowExtent(extent: number): void {
  if (shadowCam.right === extent) return;
  shadowCam.left = -extent; shadowCam.right = extent; shadowCam.top = extent; shadowCam.bottom = -extent;
  shadowCam.updateProjectionMatrix();
}
setShadowExtent(26);

// --- Simulation ---
const params = new URLSearchParams(window.location.search);
const seedParameter = Number(params.get('seed'));
const gameSeed = Number.isFinite(seedParameter) && seedParameter > 0 ? seedParameter : 20261029;
const simulation = new WorldSimulation(gameSeed);
const state = simulation.state;
const player = simulation.player;

// --- World ---
buildWorld(scene, state.obstacles);
const actors = new Actors(scene, state.agents.length);
const tracers = new Tracers(scene);
const particles = new Particles(scene);
const lootField = new LootField(scene);
const stormWall = createStormWall(scene);
const plane = createPlane(scene);
const clouds = createClouds(scene);
const sfx = new Sfx();
const hud = new Hud(state.obstacles);

const playerRing = new THREE.Mesh(
  new THREE.RingGeometry(0.78, 0.95, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: PALETTE.player, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
);
playerRing.visible = false;
scene.add(playerRing);

// --- Drop: a flight line over the island, chosen from the seed so a run stays reproducible. ---
const PLANE_ALT = 55;
const PLANE_SPEED = 15;
const CHUTE_ALT = 15;
const FREEFALL_RATE = 11;
const CHUTE_RATE = 4.6;
const PLAYER_FALL_TIME = (PLANE_ALT - CHUTE_ALT) / FREEFALL_RATE + CHUTE_ALT / CHUTE_RATE;
const flightAngle = ((gameSeed * 2654435761) % 6283) / 1000;
const flightOffset = (((gameSeed * 40503) % 2000) / 1000 - 1) * 12;
const flightDir = new THREE.Vector2(Math.cos(flightAngle), Math.sin(flightAngle));
const flightNormal = new THREE.Vector2(-flightDir.y, flightDir.x);
const FLIGHT_HALF = 78;
const flightStart = flightDir.clone().multiplyScalar(-FLIGHT_HALF).addScaledVector(flightNormal, flightOffset);
const flightEnd = flightDir.clone().multiplyScalar(FLIGHT_HALF).addScaledVector(flightNormal, flightOffset);
const FLIGHT_TIME = (FLIGHT_HALF * 2) / PLANE_SPEED;

interface Drop { jumpT: number; landT: number; fromX: number; fromZ: number; }
const drops = new Map<number, Drop>();
const jitter = (id: number, k: number) => { const s = Math.sin(id * 91.7 + k * 13.1) * 43758.5; return s - Math.floor(s); };
for (const agent of state.agents) {
  if (agent.kind === 'player') continue;
  const rel = new THREE.Vector2(agent.x, agent.z).sub(flightStart);
  const along = THREE.MathUtils.clamp(rel.dot(flightDir), 20, FLIGHT_HALF * 2 - 20);
  const jumpT = along / PLANE_SPEED - 1.2 + jitter(agent.id, 1) * 1.5;
  const from = flightStart.clone().addScaledVector(flightDir, jumpT * PLANE_SPEED);
  drops.set(agent.id, { jumpT, landT: jumpT + 6.5 + jitter(agent.id, 2) * 2.5, fromX: from.x, fromZ: from.y });
}

let flow: Flow = 'intro';
let flowTime = 0;
let planeTime = 0;
const fall = { x: 0, z: 0, alt: PLANE_ALT, vx: 0, vz: 0, chute: 0, landT: 0 };

function planePosition(t: number, out: THREE.Vector2): THREE.Vector2 {
  return out.copy(flightStart).addScaledVector(flightDir, Math.min(t, FLIGHT_TIME + 4) * PLANE_SPEED);
}

function boardPlane(): void {
  sfx.unlock();
  flow = 'flight';
  flowTime = 0;
  planeTime = 0;
  intro.classList.add('is-hidden');
  dropHud.classList.remove('is-hidden');
  plane.visible = true;
  crosshair.classList.add('is-hidden');
}

function jump(): void {
  if (flow !== 'flight') return;
  const p = planePosition(planeTime, new THREE.Vector2());
  if (p.length() > ISLAND_RADIUS + 4) return;
  flow = 'falling';
  fall.x = p.x; fall.z = p.y; fall.alt = PLANE_ALT - 2; fall.vx = flightDir.x * PLANE_SPEED * 0.6; fall.vz = flightDir.y * PLANE_SPEED * 0.6; fall.chute = 0;
  fall.landT = flowTime + PLAYER_FALL_TIME;
  // Everyone still aboard follows the player out, and every rival is on the ground first.
  for (const [id, d] of drops) {
    if (d.jumpT > flowTime) {
      d.jumpT = flowTime + jitter(id, 3) * 1.2;
      const from = planePosition(d.jumpT, new THREE.Vector2());
      d.fromX = from.x; d.fromZ = from.y;
    }
    d.landT = Math.max(d.jumpT + 2.5, Math.min(d.landT, fall.landT - 0.4 - jitter(id, 4) * 2));
  }
  sfx.jump();
  $('#drop-title').textContent = 'FREEFALL — STEER TO YOUR LANDING';
  setDropPrompt('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> STEER');
}

let dropPrompt = '';
function setDropPrompt(html: string): void {
  if (html === dropPrompt) return;
  dropPrompt = html;
  $('#drop-prompt').innerHTML = html;
}

function land(): void {
  simulation.deployPlayer(fall.x, fall.z);
  simulation.start();
  flow = 'match';
  flowTime = 0;
  dropHud.classList.add('is-hidden');
  hudRoot.classList.remove('is-hidden');
  crosshair.classList.remove('is-hidden');
  particles.emit(player.x, heightAt(player.x, player.z) + 0.2, player.z, 22, '#fff4dc', { speed: 5, up: 1.2, size: 0.45, life: 0.7, gravity: 2 });
  window.setTimeout(() => hud.fadeHint(), 14000);
}

// --- Input ---
const keys = new Set<string>();
const mouseNdc = new THREE.Vector2(0, 0);
const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1);
const aimHit = new THREE.Vector3();
let currentAim = { x: 0, z: 8 };
let mouseDown = false;
let zoom = 1;
const oneShot: { interact: boolean; reload: boolean; slot: number } = { interact: false, reload: false, slot: -1 };

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  keys.add(key);
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
  if (event.repeat) return;
  if (key === ' ' && flow === 'flight') jump();
  if (key === 'e') oneShot.interact = true;
  if (key === 'r') {
    if (simulation.isFinished()) restart();
    else oneShot.reload = true;
  }
  if (key === '1') oneShot.slot = 0;
  if (key === '2') oneShot.slot = 1;
  if (key === 'q') oneShot.slot = player.activeSlot === 0 ? 1 : 0;
  if (key === 'm') sfx.toggleMute();
  if (key === '`') perf.classList.toggle('is-hidden');
  if (key === 'enter' && flow === 'intro') boardPlane();
});
window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => { keys.clear(); mouseDown = false; });
window.addEventListener('pointermove', (event) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  mouseNdc.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
});
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  sfx.unlock();
  if (flow === 'flight') { jump(); return; }
  mouseDown = true;
});
window.addEventListener('pointerup', () => { mouseDown = false; });
canvas.addEventListener('wheel', (event) => {
  zoom = THREE.MathUtils.clamp(zoom + Math.sign(event.deltaY) * 0.08, 0.75, 1.35);
}, { passive: true });
$('#play-button').addEventListener('click', boardPlane);
$('#replay-button').addEventListener('click', restart);
app.addEventListener('contextmenu', (event) => event.preventDefault());

function restart(): void {
  // Each new run gets a fresh seed in the URL, so any run can still be replayed exactly.
  const next = new URL(window.location.href);
  next.searchParams.set('seed', String(1 + Math.floor(Math.random() * 999999)));
  window.location.href = next.toString();
}

function readInput(): PlayerInput {
  const moveX = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const moveZ = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
  aimPlane.constant = -(heightAt(player.x, player.z) + 1.05);
  raycaster.setFromCamera(mouseNdc, camera);
  if (raycaster.ray.intersectPlane(aimPlane, aimHit)) currentAim = { x: aimHit.x, z: aimHit.z };
  const input: PlayerInput = {
    moveX, moveZ, aimX: currentAim.x, aimZ: currentAim.z, shoot: mouseDown, sprint: keys.has('shift'),
    interact: oneShot.interact, reload: oneShot.reload, slot: oneShot.slot,
  };
  oneShot.interact = false;
  oneShot.reload = false;
  oneShot.slot = -1;
  return input;
}

// --- Events from the simulation drive every effect and sound. ---
let shake = 0;
let recoil = 0;
function handleEvents(): void {
  for (const e of simulation.drainEvents()) {
    switch (e.type) {
      case 'shot': {
        const isPlayer = e.ownerId === player.id;
        const y = heightAt(e.x, e.z) + 1.05;
        particles.spray(e.x + e.dx * 1.0, y, e.z + e.dz * 1.0, e.dx, e.dz, e.weapon === 'shotgun' ? 7 : 3, isPlayer ? '#d9fff4' : '#ffd0a0', e.weapon === 'shotgun' ? 0.42 : 0.3);
        const d = Math.hypot(e.x - player.x, e.z - player.z);
        sfx.shot(e.weapon, isPlayer ? 0 : d);
        if (isPlayer) {
          shake = Math.min(1, shake + (e.weapon === 'shotgun' ? 0.35 : e.weapon === 'rifle' ? 0.22 : 0.08));
          recoil = Math.min(1, recoil + (e.weapon === 'shotgun' ? 1 : 0.45));
        } else if (d < 40) hud.ping(e.x, e.z, state.elapsed);
        break;
      }
      case 'hit': {
        const target = simulation.agent(e.targetId);
        const y = heightAt(e.x, e.z) + 1.1;
        particles.emit(e.x, y, e.z, 6, e.shield ? PALETTE.shield : '#ffffff', { speed: 5, up: 3, size: 0.22, life: 0.35 });
        if (e.ownerId === player.id) {
          hud.damageNumber(e.x, e.z, e.amount, e.shield);
          if (target?.alive) hud.flashHit(false);
          sfx.hit(e.shield);
        }
        if (e.targetId === player.id) {
          hud.playerHurt(e.amount);
          shake = Math.min(1, shake + 0.3);
          sfx.hurt();
        }
        break;
      }
      case 'impact':
        particles.emit(e.x, heightAt(e.x, e.z) + 1.05, e.z, 4, '#e8dcc0', { speed: 2.5, up: 2, size: 0.2, life: 0.4 });
        break;
      case 'elimination': {
        const victim = simulation.agent(e.victimId)!;
        const killer = simulation.agent(e.killerId);
        const y = heightAt(e.x, e.z) + 0.9;
        particles.emit(e.x, y, e.z, 34, victim.color, { speed: 7, up: 5, size: 0.38, life: 0.9, gravity: 8 });
        particles.emit(e.x, y, e.z, 14, '#ffffff', { speed: 3, up: 7, size: 0.3, life: 0.7, gravity: 4 });
        hud.killFeed(killer, victim, e.weapon, player.id);
        if (e.killerId === player.id) { hud.flashHit(true); sfx.kill(); shake = Math.min(1, shake + 0.2); }
        break;
      }
      case 'pickup': {
        const color = e.kind === 'weapon' ? '#ffffff' : lootColor(e.kind);
        particles.emit(e.x, heightAt(e.x, e.z) + 0.8, e.z, 12, color, { speed: 2, up: 4, size: 0.25, life: 0.6, gravity: -1 });
        if (e.agentId === player.id) sfx.pickup();
        break;
      }
      case 'reload':
        if (e.agentId === player.id) sfx.reload();
        break;
      case 'zone':
        if (e.shrinking) sfx.zone();
        break;
    }
  }
}

// --- Per-frame views ---
const poses: ActorPose[] = state.agents.map((agent) => ({
  visible: false, x: agent.x, y: 0, z: agent.z, facing: 0, stride: 0, pitch: 0, chute: 0,
  color: new THREE.Color(agent.color), flash: 0, weapon: null, bar: 0, hp: 1, shield: 0,
}));
const strideDistance = new Float32Array(state.agents.length);

function easeOut(t: number): number { return 1 - (1 - t) * (1 - t); }

function updatePoses(dt: number): void {
  const smoothing = 1 - Math.exp(-dt * 28);
  state.agents.forEach((agent, i) => {
    const pose = poses[i];
    pose.flash = 0;
    pose.bar = 0;
    pose.pitch = 0;
    pose.chute = 0;
    if (flow === 'intro') { pose.visible = false; return; }

    if (flow === 'flight' || flow === 'falling') {
      if (agent.kind === 'player') {
        pose.visible = flow === 'falling';
        pose.x = fall.x; pose.z = fall.z; pose.y = fall.alt;
        pose.facing = Math.atan2(fall.vx, fall.vz) || pose.facing;
        pose.pitch = fall.chute > 0 ? 0.1 : 1.15;
        pose.chute = fall.chute;
        pose.stride = fall.chute > 0 ? 0.25 : 0.6;
        pose.weapon = null;
        return;
      }
      const drop = drops.get(agent.id)!;
      if (flowTime < drop.jumpT) { pose.visible = false; return; }
      const f = THREE.MathUtils.clamp((flowTime - drop.jumpT) / (drop.landT - drop.jumpT), 0, 1);
      pose.visible = true;
      const h = easeOut(f);
      pose.x = drop.fromX + (agent.x - drop.fromX) * h;
      pose.z = drop.fromZ + (agent.z - drop.fromZ) * h;
      const ground = heightAt(pose.x, pose.z);
      pose.y = f < 0.45 ? PLANE_ALT - (PLANE_ALT - CHUTE_ALT) * (f / 0.45) : ground + (CHUTE_ALT - ground) * (1 - (f - 0.45) / 0.55);
      pose.facing = Math.atan2(agent.x - drop.fromX, agent.z - drop.fromZ);
      if (f >= 1) { pose.y = ground; pose.weapon = 'pistol'; return; }
      pose.chute = f > 0.45 ? Math.min(1, (f - 0.45) * 10) : 0;
      pose.pitch = pose.chute > 0 ? 0.1 : 1.15;
      pose.stride = 0.4;
      pose.weapon = null;
      return;
    }

    pose.visible = agent.alive;
    if (!agent.alive) return;
    const wasX = pose.x;
    const wasZ = pose.z;
    const snap = Math.hypot(agent.x - pose.x, agent.z - pose.z) > 3;
    pose.x = snap ? agent.x : pose.x + (agent.x - pose.x) * smoothing;
    pose.z = snap ? agent.z : pose.z + (agent.z - pose.z) * smoothing;
    pose.y = heightAt(pose.x, pose.z);
    const moved = snap ? 0 : Math.hypot(pose.x - wasX, pose.z - wasZ);
    strideDistance[i] += moved * 2.6;
    const moving = moved > dt * 0.6;
    pose.stride = moving ? Math.sin(strideDistance[i]) * 0.65 : pose.stride * 0.8;
    if (moving) pose.y += Math.abs(Math.cos(strideDistance[i])) * 0.06;
    let dAngle = agent.facing - pose.facing;
    dAngle = Math.atan2(Math.sin(dAngle), Math.cos(dAngle));
    pose.facing += dAngle * Math.min(1, dt * (agent.kind === 'player' ? 30 : 12));
    pose.weapon = agent.slots[agent.activeSlot]?.weapon ?? null;
    const sinceHit = state.elapsed - agent.lastHitAt;
    pose.flash = sinceHit < 0.1 ? 0.85 : 0;
    if (agent.kind === 'bot' && sinceHit < 3) {
      pose.bar = Math.min(1, (3 - sinceHit) / 0.5);
      pose.hp = Math.max(0, agent.hp / agent.maxHp);
      pose.shield = agent.shield / agent.maxShield;
    }
  });
}

// --- Camera ---
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const tmp2 = new THREE.Vector2();
let introAngle = 0.6;

function updateCamera(dt: number): void {
  const k = 1 - Math.exp(-dt * 4.5);
  if (flow === 'intro') {
    introAngle += dt * 0.05;
    camPos.set(Math.cos(introAngle) * 62, 46, Math.sin(introAngle) * 62);
    camera.position.copy(camPos);
    lookAt.set(Math.cos(introAngle + 1.2) * 8, 0, Math.sin(introAngle + 1.2) * 8);
    camera.lookAt(lookAt);
    camTarget.copy(lookAt);
    setShadowExtent(46);
    return;
  }
  if (flow === 'flight') {
    planePosition(planeTime, tmp2);
    camTarget.set(tmp2.x * 0.55, 0, tmp2.y * 0.55);
    camPos.set(camTarget.x - flightDir.x * 10, 92, camTarget.z - flightDir.y * 10 + 44);
    camera.position.lerp(camPos, flowTime < 0.05 ? 1 : k);
    lookAt.lerp(camTarget, flowTime < 0.05 ? 1 : k);
    camera.lookAt(lookAt);
    setShadowExtent(46);
    return;
  }
  if (flow === 'falling') {
    const height = 22 + fall.alt * 0.9;
    camTarget.set(fall.x, Math.max(0, fall.alt * 0.5), fall.z);
    camPos.set(fall.x, camTarget.y + height, fall.z + height * 0.62);
    camera.position.lerp(camPos, k * 1.4);
    lookAt.lerp(camTarget, k * 2);
    camera.lookAt(lookAt);
    setShadowExtent(34);
    return;
  }
  const ground = heightAt(player.x, player.z);
  const ax = THREE.MathUtils.clamp((currentAim.x - player.x) * 0.22, -6, 6);
  const az = THREE.MathUtils.clamp((currentAim.z - player.z) * 0.22, -5, 5);
  const over = flow === 'over';
  camTarget.set(player.x + (over ? 0 : ax), ground + 0.6, player.z + (over ? 0 : az));
  camPos.set(camTarget.x, camTarget.y + 23.5 * zoom * (over ? 0.8 : 1), camTarget.z + 17 * zoom * (over ? 0.8 : 1));
  camera.position.lerp(camPos, k);
  lookAt.lerp(camTarget, k * 1.5);
  shake = Math.max(0, shake - dt * 2.8);
  const s = shake * shake * 0.6;
  camera.position.x += (Math.random() - 0.5) * s;
  camera.position.z += (Math.random() - 0.5) * s;
  camera.lookAt(lookAt);
  setShadowExtent(30 * zoom);
}

function updateSun(): void {
  sun.target.position.copy(camTarget);
  sun.position.copy(camTarget).add(SUN_OFFSET);
}

// --- Adaptive quality: hold frame time by trading resolution first, shadows last. ---
let frameEma = 16;
let cpuEma = 1;
let renderEma = 2;
let qualityTimer = 0;
let fpsFrames = 0;
let fpsTime = 0;
let fps = 60;
function adaptQuality(dt: number, frameMs: number): void {
  frameEma += (frameMs - frameEma) * 0.05;
  qualityTimer += dt;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) { fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0; }
  if (qualityTimer < 2) return;
  qualityTimer = 0;
  if (frameEma > 21) {
    if (pixelRatio > 0.75) setPixelRatio(pixelRatio - 0.25);
    else if (renderer.shadowMap.enabled) { renderer.shadowMap.enabled = false; sun.castShadow = false; }
  } else if (frameEma < 11 && pixelRatio < maxPixelRatio) setPixelRatio(Math.min(maxPixelRatio, pixelRatio + 0.25));
}
function setPixelRatio(value: number): void {
  pixelRatio = value;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  particles.setViewportHeight(renderer.domElement.height);
}

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  particles.setViewportHeight(renderer.domElement.height);
}
window.addEventListener('resize', onResize);
particles.setViewportHeight(renderer.domElement.height);

// --- Game over ---
let overShown = false;
let confettiTimer = 0;
function showGameOver(): void {
  overShown = true;
  const m = simulation.snapshot();
  const won = state.phase === 'victory';
  gameover.classList.toggle('won', won);
  gameover.classList.remove('is-hidden');
  hudRoot.classList.add('is-hidden');
  crosshair.classList.add('is-hidden');
  $('#gameover-place').textContent = won ? '1' : String(m.alive + 1);
  $('#gameover-eyebrow').textContent = won ? 'ISLAND SECURED' : 'SIGNAL LOST';
  $('#gameover-title').textContent = won ? 'LAST ONE STANDING.' : 'ELIMINATED.';
  $('#gameover-copy').textContent = won ? 'You outlasted nineteen rivals and the storm.' : `You placed #${m.alive + 1} of ${state.agents.length}. The island got you this time.`;
  $('#go-kills').textContent = String(m.kills);
  $('#go-time').textContent = formatTime(m.elapsed);
  $('#go-level').textContent = String(m.level);
}

// --- Main loop ---
let lastTime = performance.now();
let mapTimer = 0;
function animate(now: number): void {
  requestAnimationFrame(animate);
  const frameStart = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.08);
  lastTime = now;
  flowTime += dt;
  zoneUniforms.uTime.value += dt;

  if (flow === 'flight') {
    planePosition(planeTime, tmp2);
    const overIsland = tmp2.length() <= ISLAND_RADIUS + 4;
    setDropPrompt(overIsland ? '<kbd>SPACE</kbd> or <kbd>CLICK</kbd> JUMP' : 'APPROACHING THE ISLAND…');
    // Last call: the dropship ejects anyone still aboard before it leaves the island.
    const past = tmp2.clone().sub(flightStart).dot(flightDir) > FLIGHT_HALF + 28;
    if (past) jump();
  }
  if (flow === 'falling') {
    const steerX = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const steerZ = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
    const len = Math.hypot(steerX, steerZ) || 1;
    const speed = fall.chute > 0 ? 6.5 : 11;
    const kk = 1 - Math.exp(-dt * 2.5);
    fall.vx += ((steerX / len) * speed - fall.vx) * kk;
    fall.vz += ((steerZ / len) * speed - fall.vz) * kk;
    fall.x += fall.vx * dt;
    fall.z += fall.vz * dt;
    const r = Math.hypot(fall.x, fall.z);
    if (r > ISLAND_RADIUS - 2) { fall.x *= (ISLAND_RADIUS - 2) / r; fall.z *= (ISLAND_RADIUS - 2) / r; }
    const ground = heightAt(fall.x, fall.z);
    if (fall.alt > CHUTE_ALT) {
      fall.alt -= FREEFALL_RATE * dt;
      if (fall.alt <= CHUTE_ALT) sfx.chute();
    } else {
      fall.alt -= CHUTE_RATE * dt;
      fall.chute = Math.min(1, fall.chute + dt * 4);
    }
    $('#drop-alt').innerHTML = `${Math.max(0, Math.round(fall.alt - ground))}m<small>${fall.alt > CHUTE_ALT ? 'FREEFALL' : 'GLIDER DEPLOYED'}</small>`;
    if (fall.alt <= ground) land();
  }

  if (flow === 'match') {
    simulation.setInput(readInput());
    simulation.step(dt);
    if (simulation.isFinished()) { flow = 'over'; flowTime = 0; }
  }
  if (flow === 'over' && !overShown && flowTime > 1.3) showGameOver();
  if (flow === 'over' && state.phase === 'victory') {
    confettiTimer -= dt;
    if (confettiTimer <= 0) {
      confettiTimer = 0.12;
      const colors = [PALETTE.player, PALETTE.rifle, PALETTE.roofA, PALETTE.shotgun, PALETTE.smg];
      particles.emit(player.x + (Math.random() - 0.5) * 6, heightAt(player.x, player.z) + 5, player.z + (Math.random() - 0.5) * 6, 8, colors[Math.floor(Math.random() * colors.length)], { speed: 3, up: 2, size: 0.3, life: 1.6, gravity: 3 });
    }
  }
  handleEvents();

  // Zone visuals follow the simulation.
  const zone = state.zone;
  zoneUniforms.uZone.value.set(zone.x, zone.z, zone.radius);
  zoneUniforms.uNext.value.set(zone.nextX, zone.nextZ, zone.nextRadius, zone.stage < ZONE_STAGES.length && Math.abs(zone.radius - zone.nextRadius) > 0.2 ? 1 : 0);
  const wallR = Math.max(0.01, zone.radius);
  stormWall.scale.set(wallR, 18, wallR);
  stormWall.position.set(zone.x, -1.2, zone.z);

  // Plane and clouds: the dropship keeps flying out after the player jumps.
  if (plane.visible) {
    planeTime += dt;
    planePosition(planeTime, tmp2);
    plane.position.set(tmp2.x, PLANE_ALT + Math.sin(planeTime * 1.3) * 0.3, tmp2.y);
    plane.rotation.set(0, Math.atan2(flightDir.x, flightDir.y), Math.sin(planeTime * 0.9) * 0.05);
    if (planeTime > FLIGHT_TIME + 3) plane.visible = false;
  }
  clouds.visible = flow !== 'match' && flow !== 'over';
  clouds.rotation.y += dt * 0.004;

  updateCamera(dt);
  updateSun();
  updatePoses(dt);
  actors.update(poses, camera);
  tracers.update(state.bullets, player.id);
  lootField.update(state.loot, zoneUniforms.uTime.value);
  particles.update(dt);

  playerRing.visible = flow === 'match' && player.alive;
  if (playerRing.visible) {
    playerRing.position.set(poses[0].x, poses[0].y + 0.06, poses[0].z);
    const pulse = 1 + Math.sin(zoneUniforms.uTime.value * 4) * 0.04;
    playerRing.scale.set(pulse, 1, pulse);
  }

  if (flow === 'match' || flow === 'over') {
    const interact = flow === 'match' ? simulation.interactTarget() : undefined;
    hud.update(dt, simulation.snapshot(), state, player, interact?.weapon ? WEAPONS[interact.weapon].name : null, flow === 'match');
    recoil = Math.max(0, recoil - dt * 6);
    const active = player.slots[player.activeSlot];
    const spread = (active ? WEAPONS[active.weapon].spread * 40 : 2) + recoil * 6;
    hud.setCrosshair(pointer.x, pointer.y, spread);
  }
  hud.updateFloaters(dt, camera, window.innerWidth, window.innerHeight);
  mapTimer += dt;
  if (mapTimer > 0.1 && flow !== 'intro') {
    mapTimer = 0;
    const p = planePosition(planeTime, new THREE.Vector2());
    const flight = flow === 'flight' || flow === 'falling'
      ? { ax: flightStart.x, az: flightStart.y, bx: flightEnd.x, bz: flightEnd.y, px: flow === 'falling' ? fall.x : p.x, pz: flow === 'falling' ? fall.z : p.y }
      : undefined;
    hud.drawMap(state, player, state.elapsed, flight);
  }

  const renderStart = performance.now();
  cpuEma += (renderStart - frameStart - cpuEma) * 0.05;
  renderer.render(scene, camera);
  renderEma += (performance.now() - renderStart - renderEma) * 0.05;
  // Frame interval, not CPU time, so a GPU-bound frame also lowers quality.
  adaptQuality(dt, dt * 1000);
  if (!perf.classList.contains('is-hidden')) {
    const info = renderer.info.render;
    perf.textContent = `FPS     ${fps.toFixed(0)}\nFRAME   ${frameEma.toFixed(1)}ms\nJS      ${cpuEma.toFixed(2)}ms\nRENDER  ${renderEma.toFixed(2)}ms\nDRAWS   ${info.calls}\nTRIS    ${(info.triangles / 1000).toFixed(1)}k\nDPR     ${pixelRatio.toFixed(2)}\nSHADOWS ${renderer.shadowMap.enabled ? 'on' : 'off'}\nBULLETS ${state.bullets.length}\nSEED    ${gameSeed}`;
  }
}

camera.position.set(62, 46, 0);
camera.lookAt(0, 0, 0);
requestAnimationFrame(animate);
hud.drawMap(state, player, 0);
