import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Obstacle } from '../sim/types';
import { PALETTE } from './palette';

export const WATER_Y = -0.85;

export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const raw = Math.sin(x * 0.105) * Math.cos(z * 0.087) * 0.66
    + Math.sin((x + z) * 0.17) * 0.22
    + Math.cos(z * 0.22 - x * 0.06) * 0.13;
  const edge = THREE.MathUtils.clamp((51.5 - r) / 7.4, 0, 1);
  return raw * edge - 3.0 * (1 - edge);
}

// Same function on the GPU, so the shoreline foam follows the real coastline exactly.
const HEIGHT_GLSL = /* glsl */ `
float islandHeight(vec2 p) {
  float r = length(p);
  float raw = sin(p.x * 0.105) * cos(p.y * 0.087) * 0.66
    + sin((p.x + p.y) * 0.17) * 0.22
    + cos(p.y * 0.22 - p.x * 0.06) * 0.13;
  float edge = clamp((51.5 - r) / 7.4, 0.0, 1.0);
  return raw * edge - 3.0 * (1.0 - edge);
}`;

/** Storm state shared by every material that tints itself outside the safe zone. */
export const zoneUniforms = {
  uZone: { value: new THREE.Vector3(0, 0, 41) },
  uNext: { value: new THREE.Vector4(0, 0, 27, 0) },
  uTime: { value: 0 },
};

const STORM_GLSL = /* glsl */ `
{
  float dz = distance(vWorldXZ, uZone.xy);
  float outside = smoothstep(uZone.z - 0.15, uZone.z + 0.9, dz);
  #ifdef STORM_FADE
    outside *= 1.0 - smoothstep(50.0, 72.0, length(vWorldXZ));
  #endif
  vec3 stormTint = gl_FragColor.rgb * vec3(0.40, 0.34, 0.80) + vec3(0.05, 0.015, 0.14);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, stormTint, outside * 0.85);
  float rim = 1.0 - smoothstep(0.0, 0.35, abs(dz - uZone.z));
  gl_FragColor.rgb += vec3(0.55, 0.32, 1.0) * rim * 0.8;
  if (uNext.w > 0.5) {
    vec2 rel = vWorldXZ - uNext.xy;
    float dn = length(rel);
    float dash = step(0.42, fract(atan(rel.y, rel.x) / 6.2831853 * max(8.0, uNext.z * 1.3) - uTime * 0.15));
    float ln = (1.0 - smoothstep(0.05, 0.15, abs(dn - uNext.z))) * dash;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), ln * 0.9);
  }
}`;

function injectStorm(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, zoneUniforms);
    shader.vertexShader = 'varying vec2 vWorldXZ;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
    );
    shader.fragmentShader = 'varying vec2 vWorldXZ;\nuniform vec3 uZone;\nuniform vec4 uNext;\nuniform float uTime;\n'
      + shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${STORM_GLSL}`);
  };
}

/** Deterministic hash so decoration is stable across reloads without touching the sim RNG. */
function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = THREE.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Gives a primitive a flat vertex colour and a transform, ready for merging. */
function part(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix?: THREE.Matrix4): THREE.BufferGeometry {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  if (matrix) g.applyMatrix4(matrix);
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
function tr(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return m4.clone().compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
}

export { part, tr, injectStorm };

export function buildWorld(scene: THREE.Scene, obstacles: Obstacle[]): { treeMaterial: THREE.Material } {
  const buildings = obstacles.filter((o) => o.kind === 'building');

  // Dirt paths link each landmark to its two nearest neighbours.
  const paths: Array<[number, number, number, number]> = [];
  for (const b of buildings) {
    const near = buildings.filter((o) => o !== b).sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z)).slice(0, 2);
    for (const n of near) if (!paths.some((p) => p[0] === n.x && p[1] === n.z && p[2] === b.x)) paths.push([b.x, b.z, n.x, n.z]);
  }

  // --- Terrain: faceted, coloured per face. ---
  const divisions = 100;
  const span = 112;
  const grid = new THREE.PlaneGeometry(span, span, divisions, divisions);
  grid.rotateX(-Math.PI / 2);
  const pos = grid.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + (hash(pos.getX(i), pos.getZ(i)) - 0.5) * 0.35;
    const z = pos.getZ(i) + (hash(pos.getZ(i), pos.getX(i)) - 0.5) * 0.35;
    pos.setXYZ(i, x, heightAt(x, z), z);
  }
  const terrainGeometry = grid.toNonIndexed();
  terrainGeometry.deleteAttribute('uv');
  const tp = terrainGeometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(tp.count * 3);
  const col = new THREE.Color();
  const c = {
    sand: new THREE.Color(PALETTE.sand), wet: new THREE.Color(PALETTE.wetSand), low: new THREE.Color(PALETTE.grassLow),
    high: new THREE.Color(PALETTE.grassHigh), meadow: new THREE.Color(PALETTE.meadow), dry: new THREE.Color(PALETTE.dryGrass),
    dirt: new THREE.Color(PALETTE.dirt), concrete: new THREE.Color(PALETTE.concrete),
  };
  for (let i = 0; i < tp.count; i += 3) {
    const cx = (tp.getX(i) + tp.getX(i + 1) + tp.getX(i + 2)) / 3;
    const cy = (tp.getY(i) + tp.getY(i + 1) + tp.getY(i + 2)) / 3;
    const cz = (tp.getZ(i) + tp.getZ(i + 1) + tp.getZ(i + 2)) / 3;
    const r = Math.hypot(cx, cz);
    const coast = 44.2 + Math.sin(Math.atan2(cz, cx) * 7) * 0.9;
    if (cy < WATER_Y + 0.1) col.copy(c.wet);
    else if (r > coast || cy < -0.35) col.copy(c.sand);
    else {
      col.copy(c.low).lerp(c.high, THREE.MathUtils.clamp((cy + 0.3) / 1.2, 0, 1));
      const n = Math.sin(cx * 0.21 + Math.cos(cz * 0.17) * 2.2) * Math.cos(cz * 0.19 - cx * 0.05);
      if (n > 0.55) col.lerp(c.meadow, 0.7);
      else if (n < -0.62) col.lerp(c.dry, 0.55);
      let pathD = 99;
      for (const p of paths) pathD = Math.min(pathD, segmentDistance(cx, cz, p[0], p[1], p[2], p[3]));
      if (pathD < 1.0) col.copy(c.dirt);
      else if (pathD < 1.5) col.lerp(c.dirt, 0.45);
      for (const b of buildings) if (Math.hypot(cx - b.x, cz - b.z) < b.radius + 0.9) col.copy(c.concrete);
      if (r > coast - 1.2) col.lerp(c.sand, 0.5);
    }
    col.multiplyScalar(0.95 + hash(cx, cz) * 0.09);
    for (let k = 0; k < 3; k++) { colors[(i + k) * 3] = col.r; colors[(i + k) * 3 + 1] = col.g; colors[(i + k) * 3 + 2] = col.b; }
  }
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainGeometry.computeVertexNormals();
  const terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  injectStorm(terrainMaterial);
  const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.receiveShadow = true;
  scene.add(terrain);

  // --- Water: one shader, shallow-to-deep gradient, coastline foam, storm tint. ---
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(320, 48).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
        uShallow: { value: new THREE.Color(PALETTE.waterShallow) },
        uFoam: { value: new THREE.Color(PALETTE.waterFoam) },
      }]),
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec2 vWorldXZ;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldXZ = world.xz;
          vec4 mvPosition = viewMatrix * world;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #define STORM_FADE
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uDeep, uShallow, uFoam;
        uniform vec3 uZone;
        uniform vec4 uNext;
        uniform float uTime;
        varying vec2 vWorldXZ;
        ${HEIGHT_GLSL}
        void main() {
          vec2 p = vWorldXZ;
          float depth = ${WATER_Y.toFixed(2)} - islandHeight(p);
          float shallow = 1.0 - smoothstep(0.0, 2.2, depth);
          vec3 col = mix(uDeep, uShallow, shallow);
          col = mix(col, uDeep * 0.8, smoothstep(60.0, 150.0, length(p)));
          col += 0.025 * sin(p.x * 0.35 + uTime * 0.9) * sin(p.y * 0.31 - uTime * 0.7);
          float edgeFoam = 1.0 - smoothstep(0.0, 0.2 + 0.07 * sin(uTime * 1.8 + p.x * 0.7 + p.y * 0.5), depth);
          float bands = step(0.93, fract(depth * 0.8 - uTime * 0.22)) * (1.0 - smoothstep(0.3, 1.7, depth));
          col = mix(col, uFoam, clamp(edgeFoam + bands * 0.55, 0.0, 1.0));
          float sp = sin(p.x * 2.1 + uTime * 2.0) * sin(p.y * 2.3 - uTime * 1.6);
          col += vec3(0.22) * smoothstep(0.965, 1.0, sp) * (1.0 - shallow * 0.6);
          gl_FragColor = vec4(col, 1.0);
          ${STORM_GLSL}
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    }),
  );
  Object.assign((water.material as THREE.ShaderMaterial).uniforms, zoneUniforms);
  water.position.y = WATER_Y;
  scene.add(water);

  // Distant islets give the horizon depth during the drop.
  const islets: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2 + 0.3;
    const r = 78 + (i % 3) * 14;
    islets.push(part(new THREE.ConeGeometry(6 + (i % 3) * 3, 5 + (i % 2) * 4, 7), i % 2 ? PALETTE.grassHigh : PALETTE.pine, tr(Math.cos(a) * r, 0.6, Math.sin(a) * r, 0, a, 0, 1.6, 1, 1.2)));
    islets.push(part(new THREE.CylinderGeometry(9 + (i % 3) * 3.5, 10 + (i % 3) * 3.5, 1.2, 9), PALETTE.sand, tr(Math.cos(a) * r, -0.7, Math.sin(a) * r, 0, a, 0, 1.6, 1, 1.2)));
  }
  scene.add(new THREE.Mesh(mergeGeometries(islets), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));

  // --- Trees: two silhouettes, each one instanced draw with a vertex-shader sway. ---
  const treeMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  treeMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = zoneUniforms.uTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float sway = max(0.0, transformed.y - 1.0) * 0.05;
        vec4 ip = instanceMatrix[3];
        transformed.x += sin(uTime * 1.7 + ip.x * 0.4 + ip.z * 0.3) * sway;
        transformed.z += cos(uTime * 1.3 + ip.z * 0.4) * sway * 0.6;
      #endif`);
  };
  const pineGeometry = mergeGeometries([
    part(new THREE.CylinderGeometry(0.14, 0.2, 1.1, 5), PALETTE.trunk, tr(0, 0.55, 0)),
    part(new THREE.ConeGeometry(1.05, 1.6, 7), PALETTE.pine, tr(0, 1.55, 0)),
    part(new THREE.ConeGeometry(0.8, 1.35, 7), PALETTE.pine, tr(0, 2.3, 0, 0, 0.4)),
    part(new THREE.ConeGeometry(0.5, 1.05, 7), PALETTE.pineLight, tr(0, 2.95, 0, 0, 0.9)),
  ]);
  const roundGeometry = mergeGeometries([
    part(new THREE.CylinderGeometry(0.15, 0.22, 1.2, 5), PALETTE.trunk, tr(0, 0.6, 0)),
    part(new THREE.IcosahedronGeometry(1.0, 0), PALETTE.leaf, tr(0, 1.85, 0, 0, 0, 0, 1, 0.9, 1)),
    part(new THREE.IcosahedronGeometry(0.62, 0), PALETTE.leaf, tr(0.38, 2.5, 0.12)),
  ]);
  const trees = obstacles.filter((o) => o.kind === 'tree');
  const pines = trees.filter((t) => t.variant !== 1);
  const rounds = trees.filter((t) => t.variant === 1);
  const tint = new THREE.Color();
  for (const [list, geometry] of [[pines, pineGeometry], [rounds, roundGeometry]] as const) {
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(geometry, treeMaterial, list.length);
    list.forEach((t, i) => {
      mesh.setMatrixAt(i, tr(t.x, heightAt(t.x, t.z) - 0.05, t.z, 0, t.id * 1.3, 0, t.scale, t.scale * (0.9 + hash(t.x, t.z) * 0.25), t.scale));
      const h = hash(t.z, t.x);
      // A few warm autumn crowns break up the green.
      if (list === rounds && h > 0.72) tint.set(PALETTE.leafWarm).multiplyScalar(1.25);
      else tint.setRGB(0.9 + h * 0.15, 0.95 + h * 0.08, 0.9 + h * 0.1);
      mesh.setColorAt(i, tint);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // --- Rocks: jittered icosahedra, one draw. ---
  const rockBase = mergeVertices(new THREE.IcosahedronGeometry(1, 0).deleteAttribute('normal').deleteAttribute('uv'));
  const rp = rockBase.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < rp.count; i++) {
    const k = 0.8 + hash(rp.getX(i) * 3, rp.getZ(i) * 3) * 0.35;
    rp.setXYZ(i, rp.getX(i) * k, rp.getY(i) * k, rp.getZ(i) * k);
  }
  const rockGeometry = part(rockBase.toNonIndexed(), '#ffffff');
  rockGeometry.computeVertexNormals();
  const rocks = obstacles.filter((o) => o.kind === 'rock');
  if (rocks.length) {
    const mesh = new THREE.InstancedMesh(rockGeometry, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), rocks.length);
    rocks.forEach((r, i) => {
      mesh.setMatrixAt(i, tr(r.x, heightAt(r.x, r.z) + r.scale * 0.3, r.z, r.variant * 0.3, r.id, r.variant * 0.2, r.scale * 1.15, r.scale * 0.7, r.scale * 0.95));
      mesh.setColorAt(i, tint.set(r.variant === 2 ? PALETTE.rockDark : PALETTE.rock));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // --- Supply crates. ---
  const crates = obstacles.filter((o) => o.kind === 'crate');
  if (crates.length) {
    const crateGeometry = mergeGeometries([
      part(new THREE.BoxGeometry(1.3, 1.0, 1.3), '#ffffff', tr(0, 0.5, 0)),
      part(new THREE.BoxGeometry(1.0, 0.06, 1.0), '#f4f1e8', tr(0, 1.02, 0)),
      part(new THREE.BoxGeometry(1.36, 0.1, 1.36), PALETTE.crateFrame, tr(0, 0.12, 0)),
      part(new THREE.BoxGeometry(1.34, 0.14, 1.34), '#f4f1e8', tr(0, 0.62, 0)),
    ]);
    const mesh = new THREE.InstancedMesh(crateGeometry, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), crates.length);
    const crateColors = [PALETTE.crateA, PALETTE.crateB, PALETTE.crateC];
    crates.forEach((cr, i) => {
      mesh.setMatrixAt(i, tr(cr.x, heightAt(cr.x, cr.z) - 0.05, cr.z, 0, cr.id * 0.7, 0));
      mesh.setColorAt(i, tint.set(crateColors[cr.variant]));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // --- Buildings: every landmark merged into a single static draw. ---
  const walls = [PALETTE.wallA, PALETTE.wallB, PALETTE.wallC];
  const roofs = [PALETTE.roofA, PALETTE.roofB, PALETTE.roofC];
  const parts: THREE.BufferGeometry[] = [];
  for (const b of buildings) {
    const s = b.scale;
    const w = 3.5 * s;
    const d = 3.1 * s;
    const h = 2.45 * s;
    const base = new THREE.Matrix4().compose(new THREE.Vector3(b.x, heightAt(b.x, b.z), b.z), q.setFromEuler(e.set(0, b.variant * 0.67, 0)), new THREE.Vector3(1, 1, 1));
    const add = (g: THREE.BufferGeometry, color: THREE.ColorRepresentation, local: THREE.Matrix4) => parts.push(part(g, color, base.clone().multiply(local)));
    add(new THREE.BoxGeometry(w, h + 0.6, d), walls[b.variant], tr(0, h / 2 - 0.3, 0));
    add(new THREE.BoxGeometry(w + 0.08, 0.32, d + 0.08), PALETTE.rockDark, tr(0, 0.0, 0));
    if (b.variant === 1) {
      add(new THREE.ConeGeometry(w * 0.82, 1.3 * s, 4), roofs[b.variant], tr(0, h + 0.65 * s, 0, 0, Math.PI / 4, 0, 1, 1, d / w));
    } else {
      add(new THREE.BoxGeometry(w + 0.3, 0.24, d + 0.3), roofs[b.variant], tr(0, h + 0.12, 0));
      add(new THREE.BoxGeometry(0.9 * s, 0.5 * s, 0.7 * s), PALETTE.concrete, tr(w * 0.2, h + 0.48, -d * 0.15));
      add(new THREE.BoxGeometry(0.35 * s, 0.35 * s, 0.35 * s), PALETTE.rockDark, tr(-w * 0.25, h + 0.4, d * 0.2));
    }
    add(new THREE.BoxGeometry(0.75 * s, 1.3 * s, 0.08), PALETTE.door, tr(0, 0.65 * s, d / 2 + 0.03));
    add(new THREE.BoxGeometry(1.5 * s, 0.08, 0.7), roofs[b.variant], tr(0, 1.45 * s, d / 2 + 0.33));
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.62 * s, 0.55 * s, 0.07), PALETTE.window, tr(side * w * 0.3, 1.45 * s, -d / 2 - 0.03));
      add(new THREE.BoxGeometry(0.07, 0.55 * s, 0.62 * s), PALETTE.window, tr(side * (w / 2 + 0.03), 1.45 * s, 0));
      add(new THREE.BoxGeometry(0.6 * s, 0.5 * s, 0.07), PALETTE.window, tr(side * w * 0.32, 1.5 * s, d / 2 + 0.03));
    }
  }
  if (parts.length) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // --- Ground cover: grass tufts and flowers, instanced, no shadows. ---
  const tuft = mergeGeometries([
    part(new THREE.ConeGeometry(0.07, 0.42, 3), '#ffffff', tr(0, 0.18, 0, 0.25, 0, 0.1)),
    part(new THREE.ConeGeometry(0.07, 0.36, 3), '#ffffff', tr(0.08, 0.15, 0.05, -0.2, 0, -0.3)),
    part(new THREE.ConeGeometry(0.06, 0.3, 3), '#ffffff', tr(-0.08, 0.13, -0.03, 0.1, 0, 0.35)),
  ]);
  const flower = part(new THREE.OctahedronGeometry(0.1, 0), '#ffffff', tr(0, 0.28, 0));
  const blocked = (x: number, z: number) => obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + 0.4)
    || paths.some((p) => segmentDistance(x, z, p[0], p[1], p[2], p[3]) < 1.3);
  const grassMesh = new THREE.InstancedMesh(tuft, new THREE.MeshLambertMaterial({ vertexColors: true }), 900);
  const flowerMesh = new THREE.InstancedMesh(flower, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), 260);
  const grassColor = new THREE.Color(PALETTE.grassHigh);
  const flowerColors = ['#ffffff', '#ff9ac1', '#ffd85e', '#c9a3ff'];
  let g = 0;
  let f = 0;
  for (let i = 0; i < 4000 && (g < 900 || f < 260); i++) {
    const a = hash(i, 1.7) * Math.PI * 2;
    const r = Math.sqrt(hash(2.3, i)) * 42;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (blocked(x, z)) continue;
    const y = heightAt(x, z);
    if (y < -0.3) continue;
    if (g < 900) {
      grassMesh.setMatrixAt(g, tr(x, y, z, 0, a * 5, 0, 1, 0.8 + hash(x, z) * 0.6, 1));
      grassMesh.setColorAt(g, tint.copy(grassColor).multiplyScalar(0.85 + hash(z, x) * 0.35));
      g++;
    } else if (f < 260) {
      flowerMesh.setMatrixAt(f, tr(x, y, z));
      flowerMesh.setColorAt(f, tint.set(flowerColors[f % flowerColors.length]));
      f++;
    }
  }
  grassMesh.count = g;
  flowerMesh.count = f;
  scene.add(grassMesh, flowerMesh);

  return { treeMaterial };
}
