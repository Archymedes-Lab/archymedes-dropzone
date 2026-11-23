import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Bullet, Loot, LootKind, WeaponId } from '../sim/types';
import { PALETTE } from './palette';
import { heightAt, part, tr, zoneUniforms } from './world';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** Bullet tracers: one instanced, additive draw for every projectile in flight. */
export class Tracers {
  private readonly mesh: THREE.InstancedMesh;
  private readonly player = new THREE.Color(PALETTE.playerTracer);
  private readonly bot = new THREE.Color(PALETTE.botTracer);

  constructor(scene: THREE.Scene, private readonly max = 400) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5),
      new THREE.MeshBasicMaterial({ color: '#ffffff', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }),
      max,
    );
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.player);
    scene.add(this.mesh);
  }

  update(bullets: Bullet[], playerId: number): void {
    const n = Math.min(bullets.length, this.max);
    for (let i = 0; i < n; i++) {
      const b = bullets[i];
      const speed = Math.hypot(b.vx, b.vz) || 1;
      const len = Math.min(speed * 0.045, 2.2);
      _p.set(b.x, heightAt(b.x, b.z) + 1.05, b.z);
      _q.setFromAxisAngle(UP, Math.atan2(b.vx, b.vz) + Math.PI);
      const thick = b.weapon === 'rifle' ? 0.09 : 0.06;
      _s.set(thick, thick, len);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      this.mesh.setColorAt(i, b.ownerId === playerId ? this.player : this.bot);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** A fixed pool of additive point sprites for sparks, dust, bursts and confetti. */
export class Particles {
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly gravity: Float32Array;
  private readonly baseColor: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;

  constructor(scene: THREE.Scene, private readonly max = 900) {
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.velocity = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.gravity = new Float32Array(max);
    this.baseColor = new Float32Array(max * 3);
    this.baseSize = new Float32Array(max);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    const material = this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        attribute float size;
        varying vec3 vColor;
        uniform float uScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vColor * (1.0 - d * 1.6), 1.0);
        }`,
      vertexColors: true,
    });
    const points = new THREE.Points(this.geometry, material);
    points.frustumCulled = false;
    scene.add(points);
  }

  /** Point sizes are in world units; this converts them for the current canvas height. */
  setViewportHeight(px: number): void {
    this.material.uniforms.uScale.value = px * 0.9;
  }

  emit(x: number, y: number, z: number, count: number, color: THREE.ColorRepresentation, opts: { speed?: number; up?: number; size?: number; life?: number; gravity?: number; spread?: number } = {}): void {
    const { speed = 4, up = 2, size = 0.25, life = 0.5, gravity = 9, spread = 0.1 } = opts;
    _c.set(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.positions[i * 3] = x + (Math.random() - 0.5) * spread;
      this.positions[i * 3 + 1] = y + (Math.random() - 0.5) * spread;
      this.positions[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      this.velocity[i * 3] = Math.cos(a) * v;
      this.velocity[i * 3 + 1] = up * (0.4 + Math.random() * 0.8);
      this.velocity[i * 3 + 2] = Math.sin(a) * v;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.gravity[i] = gravity;
      this.baseColor.set([_c.r, _c.g, _c.b], i * 3);
      this.baseSize[i] = size * (0.7 + Math.random() * 0.6);
    }
  }

  /** A directional spray, used for muzzle flashes. */
  spray(x: number, y: number, z: number, dx: number, dz: number, count: number, color: THREE.ColorRepresentation, size = 0.3): void {
    _c.set(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const v = 6 + Math.random() * 8;
      const j = (Math.random() - 0.5) * 0.5;
      this.positions.set([x, y, z], i * 3);
      this.velocity.set([(dx + j * dz) * v, Math.random() * 0.8, (dz - j * dx) * v], i * 3);
      this.life[i] = this.maxLife[i] = 0.06 + Math.random() * 0.06;
      this.gravity[i] = 0;
      this.baseColor.set([_c.r, _c.g, _c.b], i * 3);
      this.baseSize[i] = size * (0.6 + Math.random() * 0.8);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.sizes[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.velocity[i * 3 + 1] -= this.gravity[i] * dt;
      const drag = 1 - Math.min(1, dt * 2.5);
      this.velocity[i * 3] *= drag;
      this.velocity[i * 3 + 2] *= drag;
      this.positions[i * 3] += this.velocity[i * 3] * dt;
      this.positions[i * 3 + 1] = Math.max(0.05 + heightAt(this.positions[i * 3], this.positions[i * 3 + 2]), this.positions[i * 3 + 1] + this.velocity[i * 3 + 1] * dt);
      this.positions[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;
      this.sizes[i] = this.baseSize[i] * (0.4 + 0.6 * k);
      this.colors[i * 3] = this.baseColor[i * 3] * k;
      this.colors[i * 3 + 1] = this.baseColor[i * 3 + 1] * k;
      this.colors[i * 3 + 2] = this.baseColor[i * 3 + 2] * k;
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

export const LOOT_COLOR: Record<string, string> = {
  shard: PALETTE.shard, medkit: PALETTE.medkit, shield: PALETTE.shield,
  smg: PALETTE.smg, shotgun: PALETTE.shotgun, rifle: PALETTE.rifle, pistol: PALETTE.pistol,
};

export function lootColor(kind: LootKind, weapon?: WeaponId): string {
  return kind === 'weapon' ? LOOT_COLOR[weapon ?? 'pistol'] : LOOT_COLOR[kind];
}

/** Loot is drawn as a handful of instanced meshes: one per shape, plus glow discs and rarity beams. */
export class LootField {
  private readonly shard: THREE.InstancedMesh;
  private readonly medkit: THREE.InstancedMesh;
  private readonly shield: THREE.InstancedMesh;
  private readonly weapon: THREE.InstancedMesh;
  private readonly glow: THREE.InstancedMesh;
  private readonly beam: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, private readonly max = 160) {
    const lit = (emissive: string) => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive, emissiveIntensity: 0.35 });
    this.shard = new THREE.InstancedMesh(part(new THREE.OctahedronGeometry(0.36, 0), PALETTE.shard), lit(PALETTE.shard), max);
    this.medkit = new THREE.InstancedMesh(mergeGeometries([
      part(new THREE.BoxGeometry(0.7, 0.5, 0.5), '#fbfbf7'),
      part(new THREE.BoxGeometry(0.14, 0.34, 0.06), PALETTE.medkit, tr(0, 0, 0.27)),
      part(new THREE.BoxGeometry(0.34, 0.14, 0.06), PALETTE.medkit, tr(0, 0, 0.27)),
      part(new THREE.BoxGeometry(0.14, 0.34, 0.06), PALETTE.medkit, tr(0, 0, -0.27)),
      part(new THREE.BoxGeometry(0.34, 0.14, 0.06), PALETTE.medkit, tr(0, 0, -0.27)),
    ]), lit('#000000'), max);
    this.shield = new THREE.InstancedMesh(mergeGeometries([
      part(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 6), PALETTE.shield),
      part(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 6), '#e9f4ff', tr(0, 0.22, 0)),
      part(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 6), '#e9f4ff', tr(0, -0.22, 0)),
    ]), lit(PALETTE.shield), max);
    this.weapon = new THREE.InstancedMesh(mergeGeometries([
      part(new THREE.BoxGeometry(0.16, 0.2, 0.9), '#ffffff'),
      part(new THREE.BoxGeometry(0.1, 0.26, 0.14), '#30363c', tr(0, -0.2, -0.08, -0.3)),
      part(new THREE.BoxGeometry(0.08, 0.08, 0.35), '#30363c', tr(0, 0.04, 0.6)),
      part(new THREE.BoxGeometry(0.12, 0.16, 0.3), '#30363c', tr(0, -0.02, -0.55)),
    ]), lit('#202020'), max);
    this.glow = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.85, 20).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
      max,
    );
    const beamGeometry = new THREE.CylinderGeometry(0.16, 0.24, 6, 6, 1, true).translate(0, 3, 0);
    const bc = new Float32Array(beamGeometry.attributes.position.count * 3);
    for (let i = 0; i < beamGeometry.attributes.position.count; i++) {
      const k = 1 - beamGeometry.attributes.position.getY(i) / 6;
      bc.set([k, k, k], i * 3);
    }
    beamGeometry.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    this.beam = new THREE.InstancedMesh(beamGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }), max);
    for (const mesh of [this.shard, this.medkit, this.shield, this.weapon, this.glow, this.beam]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }
    for (const mesh of [this.shard, this.medkit, this.shield, this.weapon]) mesh.castShadow = true;
  }

  update(loot: Loot[], time: number): void {
    const counts = { shard: 0, medkit: 0, shield: 0, weapon: 0, glow: 0, beam: 0 };
    for (const item of loot) {
      if (item.taken) continue;
      const ground = heightAt(item.x, item.z);
      const bob = Math.sin(time * 2.2 + item.pulse) * 0.1;
      const spin = time * (item.kind === 'shard' ? 1.3 : 0.7) + item.pulse;
      const mesh = this[item.kind];
      const idx = counts[item.kind]++;
      if (idx >= this.max) continue;
      _p.set(item.x, ground + 0.72 + bob, item.z);
      _q.setFromAxisAngle(UP, spin);
      _s.set(1, 1, 1);
      mesh.setMatrixAt(idx, _m.compose(_p, _q, _s));
      const color = lootColor(item.kind, item.weapon);
      if (item.kind === 'weapon') mesh.setColorAt(idx, _c.set(color));
      const g = counts.glow++;
      _p.set(item.x, ground + 0.06, item.z);
      _q.identity();
      const pulse = 0.85 + Math.sin(time * 3 + item.pulse) * 0.12;
      _s.set(pulse, 1, pulse);
      this.glow.setMatrixAt(g, _m.compose(_p, _q, _s));
      this.glow.setColorAt(g, _c.set(color).multiplyScalar(0.7));
      if (item.kind === 'weapon' && item.weapon !== 'pistol') {
        const b = counts.beam++;
        _s.set(1, 0.9 + Math.sin(time * 2 + item.pulse) * 0.1, 1);
        this.beam.setMatrixAt(b, _m.compose(_p, _q, _s));
        this.beam.setColorAt(b, _c.set(color).multiplyScalar(0.8));
      }
    }
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      const mesh = this[key];
      mesh.count = Math.min(counts[key], this.max);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Translucent storm wall with scrolling bands; one draw call. */
export function createStormWall(scene: THREE.Scene): THREE.Mesh {
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 128, 1, true).translate(0, 0.5, 0),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: zoneUniforms.uTime, uColor: { value: new THREE.Color(PALETTE.storm) }, uDeep: { value: new THREE.Color(PALETTE.stormDeep) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor, uDeep;
        varying vec2 vUv;
        void main() {
          float fade = pow(1.0 - vUv.y, 1.6);
          float bands = smoothstep(0.35, 0.5, fract(vUv.x * 90.0 + vUv.y * 2.5 - uTime * 0.6)) * 0.35;
          float base = 0.62 * fade + bands * fade + smoothstep(0.03, 0.0, vUv.y) * 0.4;
          vec3 col = mix(uDeep, uColor, vUv.y * 0.6 + bands);
          gl_FragColor = vec4(col, clamp(base, 0.0, 0.85));
          #include <colorspace_fragment>
        }`,
    }),
  );
  wall.position.y = -1.2;
  wall.renderOrder = 5;
  scene.add(wall);
  return wall;
}

export function createPlane(scene: THREE.Scene): THREE.Group {
  const geometry = mergeGeometries([
    part(new THREE.CylinderGeometry(0.9, 0.75, 7.5, 10), PALETTE.plane, tr(0, 0, 0, Math.PI / 2)),
    part(new THREE.ConeGeometry(0.9, 1.6, 10), PALETTE.plane, tr(0, 0, 4.5, Math.PI / 2)),
    part(new THREE.ConeGeometry(0.75, 2.2, 10), PALETTE.plane, tr(0, 0.15, -4.85, -Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.93, 0.93, 0.5, 10), PALETTE.planeStripe, tr(0, 0, 1.6, Math.PI / 2)),
    part(new THREE.BoxGeometry(11, 0.16, 1.7), PALETTE.plane, tr(0, -0.15, 0.6)),
    part(new THREE.BoxGeometry(1.2, 0.17, 1.72), PALETTE.planeStripe, tr(4.9, -0.15, 0.6)),
    part(new THREE.BoxGeometry(1.2, 0.17, 1.72), PALETTE.planeStripe, tr(-4.9, -0.15, 0.6)),
    part(new THREE.BoxGeometry(3.8, 0.12, 1.0), PALETTE.plane, tr(0, 0.3, -5.1)),
    part(new THREE.BoxGeometry(0.14, 1.6, 1.2), PALETTE.planeStripe, tr(0, 1.05, -5.2)),
    part(new THREE.BoxGeometry(1.1, 0.35, 1.2), PALETTE.window, tr(0, 0.55, 3.6)),
    part(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 8), PALETTE.gear, tr(2.6, -0.5, 1.0, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 8), PALETTE.gear, tr(-2.6, -0.5, 1.0, Math.PI / 2)),
  ]);
  const group = new THREE.Group();
  const body = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  body.castShadow = true;
  group.add(body);
  group.scale.setScalar(1.3);
  group.visible = false;
  scene.add(group);
  return group;
}

export function createClouds(scene: THREE.Scene): THREE.InstancedMesh {
  const puffs: THREE.BufferGeometry[] = [];
  const offsets: Array<[number, number, number, number]> = [[0, 0, 0, 2.4], [2.3, -0.3, 0.4, 1.8], [-2.1, -0.4, -0.2, 1.7], [0.8, 0.9, -0.5, 1.5], [-0.9, 0.6, 0.8, 1.3]];
  for (const [x, y, z, r] of offsets) puffs.push(part(new THREE.IcosahedronGeometry(r, 0), PALETTE.cloud, tr(x, y, z, 0, x, 0, 1, 0.7, 1)));
  const mesh = new THREE.InstancedMesh(mergeGeometries(puffs), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: '#c9e6f2', emissiveIntensity: 0.4 }), 18);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + i * 0.7;
    const r = 20 + ((i * 37) % 55);
    const s = 1 + ((i * 13) % 7) / 4;
    mesh.setMatrixAt(i, tr(Math.cos(a) * r, 40 + ((i * 7) % 12), Math.sin(a) * r, 0, a, 0, s * 1.4, s, s));
  }
  scene.add(mesh);
  return mesh;
}
