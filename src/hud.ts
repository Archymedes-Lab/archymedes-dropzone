import * as THREE from 'three';
import { WEAPONS, ZONE_STAGES } from './sim/WorldSimulation';
import type { Agent, MatchState, MetricsSnapshot, Obstacle, WeaponId } from './sim/types';
import { PALETTE } from './render/palette';
import { heightAt, WATER_Y } from './render/world';

export const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const RARITY: Record<WeaponId, string> = { pistol: PALETTE.pistol, smg: PALETTE.smg, shotgun: PALETTE.shotgun, rifle: PALETTE.rifle };
const MAP_RANGE = 50;

interface Floater { el: HTMLSpanElement; x: number; y: number; z: number; life: number; drift: number; }
interface Ping { x: number; z: number; t: number; }

export class Hud {
  private readonly el = {
    phase: $('#phase-label'), clock: $('#clock-value'), zoneLabel: $('#zone-label'), zoneValue: $('#zone-value'),
    zoneProgress: $('#zone-progress'), zoneStatus: $('.zone-status'), remaining: $('#remaining-value'), kills: $('#kills-value'),
    level: $('#level-value'), levelSmall: $('#level-small'), hpFill: $('#health-fill'), hpGhost: $('#health-ghost'), hpNum: $('#health-number'),
    shFill: $('#shield-fill'), shNum: $('#shield-number'), xpFill: $('#xp-fill'), xpLabel: $('#xp-label'),
    warning: $('#zone-warning'), stormVignette: $('#storm-vignette'), vignette: $('#vignette'), toast: $('#toast'),
    interact: $('#interact'), interactText: $('#interact-text'), killfeed: $('#killfeed'), damage: $('#damage-layer'),
    crosshair: $('#crosshair'), hint: $('#controls-hint'),
  };
  private readonly slots = [0, 1].map((i) => {
    const root = $(`#slot-${i}`);
    return { root, name: root.querySelector<HTMLElement>('.slot-name')!, ammo: root.querySelector<HTMLElement>('.slot-ammo')!, reload: root.querySelector<HTMLElement>('.slot-reload')! };
  });
  private readonly minimap = $('#minimap') as HTMLCanvasElement;
  private readonly ctx = this.minimap.getContext('2d')!;
  private readonly base: HTMLCanvasElement;
  private readonly floaters: Floater[] = [];
  private readonly pool: HTMLSpanElement[] = [];
  private readonly pings: Ping[] = [];
  private readonly v = new THREE.Vector3();
  private lastToast = '';
  private uiTimer = 0;
  private hurt = 0;

  constructor(obstacles: Obstacle[]) {
    this.base = this.renderMapBase(obstacles);
  }

  private toMap(x: number, z: number): [number, number] {
    const s = this.minimap.width / (MAP_RANGE * 2);
    return [(x + MAP_RANGE) * s, (z + MAP_RANGE) * s];
  }

  /** Painted once: the island, paths of colour and landmarks never change during a match. */
  private renderMapBase(obstacles: Obstacle[]): HTMLCanvasElement {
    const size = this.minimap.width;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const deep = new THREE.Color(PALETTE.waterDeep);
    const shallow = new THREE.Color(PALETTE.waterShallow);
    const sand = new THREE.Color(PALETTE.sand);
    const grass = new THREE.Color(PALETTE.grassLow);
    const hill = new THREE.Color(PALETTE.grassHigh);
    const c = new THREE.Color();
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px / size) * MAP_RANGE * 2 - MAP_RANGE;
        const z = (py / size) * MAP_RANGE * 2 - MAP_RANGE;
        const h = heightAt(x, z);
        if (h < WATER_Y) c.copy(deep).lerp(shallow, THREE.MathUtils.clamp(1 - (WATER_Y - h) / 2, 0, 1));
        else if (h < -0.35 || Math.hypot(x, z) > 44.5) c.copy(sand);
        else c.copy(grass).lerp(hill, THREE.MathUtils.clamp((h + 0.3) / 1.2, 0, 1));
        const i = (py * size + px) * 4;
        img.data[i] = c.r * 255; img.data[i + 1] = c.g * 255; img.data[i + 2] = c.b * 255; img.data[i + 3] = 255;
      }
    }
    // Colours were authored in sRGB; ImageData expects sRGB, so convert back from the working space.
    for (let i = 0; i < img.data.length; i += 4) {
      for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(Math.pow(img.data[i + k] / 255, 1 / 2.2) * 255);
    }
    ctx.putImageData(img, 0, 0);
    for (const o of obstacles) {
      const [x, y] = this.toMap(o.x, o.z);
      if (o.kind === 'building') {
        ctx.fillStyle = '#f6efe3';
        const s = o.radius * 1.1;
        ctx.fillRect(x - s, y - s, s * 2, s * 2);
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.strokeRect(x - s, y - s, s * 2, s * 2);
      } else if (o.kind === 'tree') {
        ctx.fillStyle = 'rgba(30, 95, 60, .7)';
        ctx.beginPath(); ctx.arc(x, y, 1.6 * o.scale, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(120, 120, 115, .7)';
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    return canvas;
  }

  ping(x: number, z: number, now: number): void {
    if (this.pings.length > 24) this.pings.shift();
    this.pings.push({ x, z, t: now });
  }

  drawMap(state: MatchState, player: Agent, now: number, flight?: { ax: number; az: number; bx: number; bz: number; px: number; pz: number }): void {
    const ctx = this.ctx;
    const size = this.minimap.width;
    const s = size / (MAP_RANGE * 2);
    ctx.drawImage(this.base, 0, 0);
    const zone = state.zone;
    const [zx, zy] = this.toMap(zone.x, zone.z);
    ctx.fillStyle = 'rgba(92, 46, 210, .42)';
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.arc(zx, zy, Math.max(0.01, zone.radius * s), 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#c6abff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(zx, zy, Math.max(0.01, zone.radius * s), 0, Math.PI * 2); ctx.stroke();
    if (zone.stage < ZONE_STAGES.length) {
      const [nx, ny] = this.toMap(zone.nextX, zone.nextZ);
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(nx, ny, Math.max(0.01, zone.nextRadius * s), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (flight) {
      const [ax, ay] = this.toMap(flight.ax, flight.az);
      const [bx, by] = this.toMap(flight.bx, flight.bz);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      const [px, py] = this.toMap(flight.px, flight.pz);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      const age = now - p.t;
      if (age > 1.6) { this.pings.splice(i, 1); continue; }
      const [x, y] = this.toMap(p.x, p.z);
      ctx.fillStyle = `rgba(255, 90, 90, ${1 - age / 1.6})`;
      ctx.beginPath(); ctx.arc(x, y, 3 + age * 2, 0, Math.PI * 2); ctx.fill();
    }
    if (player.alive) {
      const [px, py] = this.toMap(player.x, player.z);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-player.facing + Math.PI);
      ctx.fillStyle = PALETTE.player;
      ctx.strokeStyle = '#06261f';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-5, 5); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  damageNumber(x: number, z: number, amount: number, shield: boolean): void {
    const el = this.pool.pop() ?? document.createElement('span');
    el.className = `dmg${shield ? ' shield' : ''}${amount >= 30 ? ' big' : ''}`;
    el.textContent = String(Math.round(amount));
    if (!el.parentElement) this.el.damage.appendChild(el);
    el.style.display = '';
    this.floaters.push({ el, x: x + (Math.random() - 0.5) * 0.6, y: heightAt(x, z) + 2.1, z, life: 0.8, drift: (Math.random() - 0.5) * 30 });
  }

  updateFloaters(dt: number, camera: THREE.Camera, width: number, height: number): void {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.el.style.display = 'none';
        this.pool.push(f.el);
        this.floaters.splice(i, 1);
        continue;
      }
      f.y += dt * 1.6;
      this.v.set(f.x, f.y, f.z).project(camera);
      const sx = (this.v.x * 0.5 + 0.5) * width + f.drift * (0.8 - f.life);
      const sy = (-this.v.y * 0.5 + 0.5) * height;
      const k = Math.min(1, f.life / 0.3);
      f.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%) scale(${(0.8 + k * 0.3).toFixed(2)})`;
      f.el.style.opacity = k.toFixed(2);
    }
  }

  killFeed(killer: Agent | undefined, victim: Agent, weapon: WeaponId | 'storm', playerId: number): void {
    const li = document.createElement('li');
    if (killer?.id === playerId || victim.id === playerId) li.className = 'you';
    const tag = weapon === 'storm' ? 'STORM' : WEAPONS[weapon].name.split(' ')[0];
    const color = weapon === 'storm' ? PALETTE.storm : RARITY[weapon];
    const kName = killer ? (killer.id === playerId ? 'YOU' : killer.name) : '';
    li.innerHTML = `${kName ? `<span class="k" style="color:${killer!.color}">${kName}</span>` : ''}<span class="w" style="background:${color}">${tag}</span><span style="color:${victim.color}">${victim.id === playerId ? 'YOU' : victim.name}</span>`;
    this.el.killfeed.prepend(li);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastElementChild!.remove();
    window.setTimeout(() => li.remove(), 7000);
  }

  flashHit(kill: boolean): void {
    const cross = this.el.crosshair;
    cross.classList.remove('hit', 'kill');
    void cross.offsetWidth;
    cross.classList.add(kill ? 'kill' : 'hit');
  }

  playerHurt(amount: number): void {
    this.hurt = Math.min(1, this.hurt + amount / 30);
  }

  setCrosshair(x: number, y: number, spread: number): void {
    this.el.crosshair.style.transform = `translate(${x}px, ${y}px)`;
    this.el.crosshair.style.setProperty('--gap', `${spread.toFixed(1)}px`);
  }

  fadeHint(): void {
    this.el.hint.classList.add('faded');
  }

  update(dt: number, m: MetricsSnapshot, state: MatchState, player: Agent, interactName: string | null, active: boolean): void {
    this.hurt = Math.max(0, this.hurt - dt * 1.6);
    this.el.vignette.style.opacity = this.hurt.toFixed(2);
    this.uiTimer += dt;
    if (this.uiTimer < 0.066) return;
    this.uiTimer = 0;

    setText(this.el.remaining, String(m.alive));
    setText(this.el.kills, String(m.kills));
    setText(this.el.level, String(m.level));
    setText(this.el.levelSmall, String(m.level));
    setText(this.el.clock, formatTime(m.elapsed));
    setText(this.el.phase, m.phase === 'scavenge' ? 'SCAVENGE' : m.phase === 'closing' ? 'STORM PHASE' : m.phase === 'showdown' ? 'FINAL CIRCLES' : 'DROPZONE');

    const zone = state.zone;
    const done = zone.stage >= ZONE_STAGES.length;
    const stageDef = ZONE_STAGES[Math.min(zone.stage, ZONE_STAGES.length - 1)];
    const total = zone.shrinking ? stageDef[1] : stageDef[0];
    setText(this.el.zoneLabel, done ? 'FINAL CIRCLE' : zone.shrinking ? `STORM CLOSING · ${zone.stage + 1}/${ZONE_STAGES.length}` : zone.stage === 0 ? 'STORM FORMS IN' : `NEXT CLOSE · ${zone.stage + 1}/${ZONE_STAGES.length}`);
    setText(this.el.zoneValue, done ? '—' : formatTime(zone.timer));
    this.el.zoneProgress.style.width = `${done ? 0 : Math.max(0, (zone.timer / total) * 100)}%`;
    this.el.zoneStatus.classList.toggle('is-closing', zone.shrinking);

    const hpPct = Math.max(0, (m.playerHp / m.playerMaxHp) * 100);
    this.el.hpFill.style.width = `${hpPct}%`;
    this.el.hpGhost.style.width = `${hpPct}%`;
    this.el.hpFill.classList.toggle('low', hpPct < 30);
    setText(this.el.hpNum, String(Math.ceil(m.playerHp)));
    this.el.shFill.style.width = `${(m.playerShield / m.playerMaxShield) * 100}%`;
    setText(this.el.shNum, String(Math.ceil(m.playerShield)));
    this.el.xpFill.style.width = `${m.level >= 8 ? 100 : (m.xp / m.nextLevelXp) * 100}%`;
    setText(this.el.xpLabel, m.level >= 8 ? 'MAX' : `${Math.round(m.xp)}/${m.nextLevelXp}`);

    player.slots.forEach((slot, i) => {
      const ui = this.slots[i];
      ui.root.classList.toggle('active', i === player.activeSlot && !!slot);
      ui.root.style.setProperty('--rarity', slot ? RARITY[slot.weapon] : 'rgba(255,255,255,.25)');
      setText(ui.name, slot ? WEAPONS[slot.weapon].name : 'EMPTY');
      const reloading = i === player.activeSlot && player.reloadTimer > 0 && slot;
      const html = slot ? (reloading ? '<b>··</b> RELOADING' : `<b class="${slot.ammo === 0 ? 'empty' : ''}">${slot.ammo}</b> / ${WEAPONS[slot.weapon].magazine}`) : '';
      if (ui.ammo.innerHTML !== html) ui.ammo.innerHTML = html;
      ui.reload.style.width = reloading ? `${(1 - player.reloadTimer / WEAPONS[slot!.weapon].reload) * 100}%` : '0';
    });

    this.el.interact.classList.toggle('is-visible', !!interactName && active);
    if (interactName) setText(this.el.interactText, `SWAP FOR ${interactName}`);

    const toastText = state.messageTimer > 0 ? state.message : '';
    if (toastText !== this.lastToast) {
      this.el.toast.textContent = toastText;
      this.el.toast.classList.toggle('is-visible', Boolean(toastText));
      this.lastToast = toastText;
    }
    const outside = Math.hypot(player.x - zone.x, player.z - zone.z) > zone.radius;
    this.el.warning.classList.toggle('is-visible', outside && active);
    this.el.stormVignette.classList.toggle('is-visible', outside && active);

  }
}
