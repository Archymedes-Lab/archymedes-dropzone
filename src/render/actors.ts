import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../sim/types';
import { PALETTE } from './palette';
import { part, tr } from './world';

export interface ActorPose {
  visible: boolean;
  x: number;
  y: number;
  z: number;
  facing: number;
  stride: number;
  /** Forward tilt; freefall uses a steep dive. */
  pitch: number;
  chute: number;
  color: THREE.Color;
  flash: number;
  weapon: WeaponId | null;
  bar: number;
  hp: number;
  shield: number;
}

const GUN_LENGTH: Record<WeaponId, number> = { pistol: 0.38, smg: 0.62, shotgun: 0.82, rifle: 1.05 };

/**
 * Every operative is drawn by six instanced meshes in total, however many are alive:
 * tinted shell, neutral gear, two legs, gun and parachute. Bars add two more.
 */
export class Actors {
  private readonly shell: THREE.InstancedMesh;
  private readonly gear: THREE.InstancedMesh;
  private readonly legL: THREE.InstancedMesh;
  private readonly legR: THREE.InstancedMesh;
  private readonly gun: THREE.InstancedMesh;
  private readonly chute: THREE.InstancedMesh;
  private readonly barBack: THREE.InstancedMesh;
  private readonly barFill: THREE.InstancedMesh;
  private readonly root = new THREE.Object3D();
  private readonly local = new THREE.Matrix4();
  private readonly out = new THREE.Matrix4();
  private readonly tmpColor = new THREE.Color();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene, count: number) {
    const lambert = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const shellGeometry = mergeGeometries([
      part(new THREE.CylinderGeometry(0.27, 0.31, 0.64, 8), '#d9d9d9', tr(0, 0.92, 0)),
      part(new THREE.BoxGeometry(0.58, 0.16, 0.36), '#ffffff', tr(0, 1.18, 0)),
      part(new THREE.BoxGeometry(0.34, 0.1, 0.09), '#ffffff', tr(0, 1.43, 0.215)),
    ]);
    const gearGeometry = mergeGeometries([
      part(new THREE.SphereGeometry(0.235, 8, 6), PALETTE.skin, tr(0, 1.42, 0)),
      part(new THREE.SphereGeometry(0.255, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), PALETTE.gear, tr(0, 1.45, -0.01)),
      part(new THREE.BoxGeometry(0.38, 0.46, 0.22), PALETTE.gear, tr(0, 0.95, -0.3)),
      part(new THREE.BoxGeometry(0.6, 0.11, 0.42), PALETTE.gear, tr(0, 0.63, 0)),
      part(new THREE.BoxGeometry(0.12, 0.12, 0.5), PALETTE.suit, tr(0.26, 1.04, 0.2, 0, -0.35, 0)),
      part(new THREE.BoxGeometry(0.12, 0.12, 0.5), PALETTE.suit, tr(-0.24, 1.04, 0.22, 0, 0.5, 0)),
      part(new THREE.BoxGeometry(0.11, 0.11, 0.11), PALETTE.skin, tr(0.1, 1.0, 0.45)),
    ]);
    const legGeometry = part(new THREE.BoxGeometry(0.17, 0.58, 0.2), PALETTE.suit, tr(0, -0.29, 0));
    const gunGeometry = mergeGeometries([
      part(new THREE.BoxGeometry(0.09, 0.13, 1), '#ffffff', tr(0, 0, 0.5)),
      part(new THREE.BoxGeometry(0.07, 0.18, 0.1), PALETTE.gear, tr(0, -0.12, 0.22)),
    ]);
    // Striped canopy plus four cords, all in one geometry.
    const canopy = new THREE.SphereGeometry(1.5, 10, 4, 0, Math.PI * 2, 0, Math.PI * 0.34).toNonIndexed();
    canopy.deleteAttribute('uv');
    const cc = new Float32Array(canopy.attributes.position.count * 3);
    for (let i = 0; i < cc.length / 3; i += 3) {
      const x = (canopy.attributes.position.getX(i) + canopy.attributes.position.getX(i + 1) + canopy.attributes.position.getX(i + 2)) / 3;
      const z = (canopy.attributes.position.getZ(i) + canopy.attributes.position.getZ(i + 1) + canopy.attributes.position.getZ(i + 2)) / 3;
      const band = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 10) % 2 ? 1 : 0.35;
      for (let k = 0; k < 3; k++) cc.set([band + 0.5 * (1 - band), band + 0.5 * (1 - band), band + 0.5 * (1 - band)], (i + k) * 3);
    }
    canopy.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    canopy.applyMatrix4(tr(0, 2.6, 0, 0, 0, 0, 1, 0.55, 1));
    const cords: THREE.BufferGeometry[] = [canopy];
    const rimR = 1.5 * Math.sin(Math.PI * 0.34);
    const rimY = 2.6 + 1.5 * Math.cos(Math.PI * 0.34) * 0.55;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const from = new THREE.Vector3(Math.cos(a) * rimR, rimY, Math.sin(a) * rimR);
      const to = new THREE.Vector3(0, 1.25, 0);
      const len = from.distanceTo(to);
      const mid = from.clone().add(to).multiplyScalar(0.5);
      const g = part(new THREE.BoxGeometry(0.025, 0.025, len), PALETTE.gear);
      g.applyMatrix4(new THREE.Matrix4().lookAt(from, to, new THREE.Vector3(0, 1, 0)).setPosition(mid));
      cords.push(g);
    }
    const chuteGeometry = mergeGeometries(cords);

    this.shell = new THREE.InstancedMesh(shellGeometry, lambert(), count);
    this.gear = new THREE.InstancedMesh(gearGeometry, lambert(), count);
    this.legL = new THREE.InstancedMesh(legGeometry, lambert(), count);
    this.legR = new THREE.InstancedMesh(legGeometry, lambert(), count);
    this.gun = new THREE.InstancedMesh(gunGeometry, lambert(), count);
    const chuteMaterial = lambert();
    chuteMaterial.side = THREE.DoubleSide;
    this.chute = new THREE.InstancedMesh(chuteGeometry, chuteMaterial, count);
    const bar = new THREE.PlaneGeometry(1, 0.11).translate(0.5, 0, 0);
    this.barBack = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({ color: '#10181d', transparent: true, opacity: 0.7, depthTest: false }), count);
    this.barFill = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false }), count * 2);
    this.barBack.renderOrder = 10;
    this.barFill.renderOrder = 11;
    for (const mesh of [this.shell, this.gear, this.legL, this.legR, this.gun, this.chute]) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }
    for (const mesh of [this.barBack, this.barFill]) {
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    for (let i = 0; i < count; i++) {
      this.gear.setColorAt(i, this.tmpColor.set('#ffffff'));
      this.legL.setColorAt(i, this.tmpColor);
      this.legR.setColorAt(i, this.tmpColor);
    }
  }

  update(poses: ActorPose[], camera: THREE.Camera): void {
    let bars = 0;
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      if (!p.visible) {
        for (const mesh of [this.shell, this.gear, this.legL, this.legR, this.gun, this.chute]) mesh.setMatrixAt(i, this.zero);
        this.barBack.setMatrixAt(i, this.zero);
        continue;
      }
      this.root.position.set(p.x, p.y, p.z);
      this.root.rotation.set(p.pitch, p.facing, 0, 'YXZ');
      this.root.updateMatrix();
      const m = this.root.matrix;
      this.shell.setMatrixAt(i, m);
      this.gear.setMatrixAt(i, m);
      this.shell.setColorAt(i, this.tmpColor.copy(p.color).lerp(WHITE, p.flash));
      this.legL.setMatrixAt(i, this.out.multiplyMatrices(m, this.local.compose(V(-0.12, 0.62, 0), Q(p.stride, 0, 0), ONE)));
      this.legR.setMatrixAt(i, this.out.multiplyMatrices(m, this.local.compose(V(0.12, 0.62, 0), Q(-p.stride, 0, 0), ONE)));
      if (p.weapon && p.chute <= 0) {
        this.gun.setMatrixAt(i, this.out.multiplyMatrices(m, this.local.compose(V(0.1, 1.02, 0.28), Q(0, 0, 0), S(1, 1, GUN_LENGTH[p.weapon]))));
        this.gun.setColorAt(i, this.tmpColor.set(GUN_COLOR[p.weapon]));
      } else this.gun.setMatrixAt(i, this.zero);
      if (p.chute > 0) {
        const s = p.chute;
        this.root.rotation.set(0, p.facing, 0);
        this.root.updateMatrix();
        this.chute.setMatrixAt(i, this.out.multiplyMatrices(this.root.matrix, this.local.compose(V(0, 0, 0), Q(0, 0, 0), S(s, s, s))));
        this.chute.setColorAt(i, p.color);
      } else this.chute.setMatrixAt(i, this.zero);

      if (p.bar > 0) {
        const a = Math.min(1, p.bar);
        const width = 1.1;
        this.local.compose(V(p.x - width / 2, p.y + 2.05, p.z), camera.quaternion, S(width, a, 1));
        this.barBack.setMatrixAt(i, this.local);
        this.local.compose(V(p.x - width / 2, p.y + 2.05, p.z), camera.quaternion, S(width * Math.max(0.001, p.hp), a * 0.7, 1));
        this.barFill.setMatrixAt(bars, this.local);
        this.barFill.setColorAt(bars, this.tmpColor.set(p.hp > 0.5 ? '#f4fff9' : p.hp > 0.25 ? '#ffc96b' : '#ff6b6b'));
        bars++;
        if (p.shield > 0) {
          this.local.compose(V(p.x - width / 2, p.y + 2.16, p.z), camera.quaternion, S(width * p.shield, a * 0.45, 1));
          this.barFill.setMatrixAt(bars, this.local);
          this.barFill.setColorAt(bars, this.tmpColor.set(PALETTE.shield));
          bars++;
        }
      } else this.barBack.setMatrixAt(i, this.zero);
    }
    this.barFill.count = bars;
    for (const mesh of [this.shell, this.gear, this.legL, this.legR, this.gun, this.chute, this.barBack, this.barFill]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

const WHITE = new THREE.Color('#ffffff');
const GUN_COLOR: Record<WeaponId, string> = { pistol: '#3a4148', smg: '#2f5d8c', shotgun: '#5e3f8a', rifle: '#8a6a1f' };
const ONE = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
function V(x: number, y: number, z: number): THREE.Vector3 { return _v.set(x, y, z); }
function S(x: number, y: number, z: number): THREE.Vector3 { return _s.set(x, y, z); }
function Q(x: number, y: number, z: number): THREE.Quaternion { return _q.setFromEuler(_e.set(x, y, z)); }
