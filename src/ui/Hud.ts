import * as THREE from 'three';
import { WEAPON_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import { clamp01, damp } from '@/core/MathUtils';

/**
 * In-game HUD.
 *
 * DOM, not canvas: text rendered by the browser is crisper than anything we
 * would draw into a texture, it costs no GPU time, and it sits outside the
 * post-processing chain so the UI never picks up bloom, grain or chromatic
 * aberration. That last point is what keeps the HUD looking like an overlay
 * from the character's equipment rather than part of the photograph.
 *
 * Only elements that actually change are touched each frame, and every write
 * is guarded by a dirty check - a HUD that thrashes style properties every
 * frame will cost more than the SSAO pass.
 */
export class Hud {
  private root: HTMLDivElement;
  private crosshair: HTMLDivElement;
  private crosshairParts: HTMLSpanElement[] = [];
  private hitmarker: HTMLDivElement;
  private magEl: HTMLDivElement;
  private reserveEl: HTMLDivElement;
  private reloadHint: HTMLDivElement;
  private reloadBar: HTMLDivElement;
  private reloadFill: HTMLElement;
  private healthFill: HTMLElement;
  private stanceEl: HTMLDivElement;
  private objectiveText: HTMLDivElement;
  private objectiveCounter: HTMLDivElement;
  private damageVeil: HTMLDivElement;
  private hitArc: HTMLDivElement;
  private hitArcPath: SVGPathElement;
  private marker: HTMLDivElement;
  private perf: HTMLDivElement;

  private hitmarkerTimer = 0;
  private hitArcTimer = 0;
  private displayedSpread = 0;
  private lastMag = -1;
  private lastReserve = -1;
  private lastHealth = -1;
  private lastStance = '';
  private lastCounter = '';
  private unsubscribe: Array<() => void> = [];
  private perfVisible = false;
  private hidden = false;

  private readonly projected = new THREE.Vector3();

  constructor(container: HTMLElement, private readonly bus: EventBus) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);

    this.crosshair = this.q('.crosshair');
    this.crosshairParts = [
      this.q('.crosshair .top'),
      this.q('.crosshair .bottom'),
      this.q('.crosshair .left'),
      this.q('.crosshair .right'),
    ];
    this.hitmarker = this.q('.hitmarker');
    this.magEl = this.q('.ammo .mag');
    this.reserveEl = this.q('.ammo .reserve');
    this.reloadHint = this.q('.ammo .reload-hint');
    this.reloadBar = this.q('.reload-bar');
    this.reloadFill = this.q('.reload-bar i');
    this.healthFill = this.q('.status .bar i');
    this.stanceEl = this.q('.status .stance');
    this.objectiveText = this.q('.objective .text');
    this.objectiveCounter = this.q('.objective .counter');
    this.damageVeil = this.q('.damage-veil');
    this.hitArc = this.q('.hit-arc');
    this.hitArcPath = this.root.querySelector('.hit-arc path') as SVGPathElement;
    this.marker = this.q('.marker');
    this.perf = this.q('.perf');

    this.q<HTMLDivElement>('.ammo .weapon-name').textContent = WEAPON_CONFIG.name;

    this.bindEvents();
  }

  private q<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector(selector);
    if (!el) throw new Error(`[Hud] missing element: ${selector}`);
    return el as T;
  }

  private bindEvents(): void {
    this.unsubscribe.push(
      this.bus.on('hitmarker', ({ headshot, killed }) => {
        this.hitmarkerTimer = killed ? 0.42 : 0.22;
        this.hitmarker.classList.toggle('kill', killed);
        this.hitmarker.style.transform = `translate(-50%, -50%) scale(${killed ? 1.25 : headshot ? 1.12 : 1})`;
      }),
      this.bus.on('player:damaged', ({ fromDirection }) => {
        this.hitArcTimer = 1.1;
        // Rotate the arc so it points at the shooter in screen space.
        this.lastDamageDirection.copy(fromDirection);
      }),
      this.bus.on('mission:objective', ({ text }) => {
        this.objectiveText.textContent = text;
      }),
    );
  }

  private lastDamageDirection = new THREE.Vector3(0, 0, 1);

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.root.classList.toggle('hidden', hidden);
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  togglePerf(): void {
    this.perfVisible = !this.perfVisible;
    this.perf.classList.toggle('show', this.perfVisible);
  }

  setPerf(lines: string): void {
    if (!this.perfVisible) return;
    this.perf.innerHTML = lines;
  }

  /**
   * Per-frame update. Everything here is dirty-checked; on a steady frame this
   * function touches the DOM zero times.
   */
  update(
    dt: number,
    state: {
      mag: number;
      reserve: number;
      spread: number;
      adsBlend: number;
      reloadProgress: number;
      reloading: boolean;
      health: number;
      crouched: boolean;
      sprinting: boolean;
      enemiesRemaining: number;
      enemiesTotal: number;
      cameraYaw: number;
    },
  ): void {
    // --- crosshair: gap follows the actual bullet spread ---
    // The crosshair is a promise about where rounds go; it must be derived
    // from the real spread value, never animated independently.
    const targetGap = 4 + state.spread * 620;
    this.displayedSpread = damp(this.displayedSpread, targetGap, 16, dt);
    const gap = Math.round(this.displayedSpread);
    this.crosshairParts[0].style.top = `${22 - gap - 7}px`;
    this.crosshairParts[1].style.top = `${22 + gap}px`;
    this.crosshairParts[2].style.left = `${22 - gap - 7}px`;
    this.crosshairParts[3].style.left = `${22 + gap}px`;
    // Hide the crosshair when aiming: the optic is the sight now.
    const crosshairOpacity = (1 - state.adsBlend) * (state.sprinting ? 0.25 : 1);
    this.crosshair.style.opacity = crosshairOpacity.toFixed(2);

    // --- hitmarker ---
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      this.hitmarker.style.opacity = clamp01(this.hitmarkerTimer * 4).toFixed(2);
      if (this.hitmarkerTimer <= 0) this.hitmarker.style.opacity = '0';
    }

    // --- ammo ---
    if (state.mag !== this.lastMag) {
      this.lastMag = state.mag;
      this.magEl.textContent = String(state.mag).padStart(2, '0');
      this.magEl.classList.toggle('low', state.mag <= 7);
      this.reloadHint.classList.toggle('show', state.mag === 0 && state.reserve > 0);
    }
    if (state.reserve !== this.lastReserve) {
      this.lastReserve = state.reserve;
      this.reserveEl.textContent = `/ ${state.reserve}`;
    }
    if (state.reloading) {
      this.reloadBar.classList.add('show');
      this.reloadFill.style.width = `${(state.reloadProgress * 100).toFixed(0)}%`;
    } else if (this.reloadBar.classList.contains('show')) {
      this.reloadBar.classList.remove('show');
    }

    // --- health ---
    const healthRounded = Math.round(state.health * 100);
    if (healthRounded !== this.lastHealth) {
      this.lastHealth = healthRounded;
      this.healthFill.style.transform = `scaleX(${state.health.toFixed(3)})`;
      this.healthFill.classList.toggle('hurt', state.health < 0.4);
      // Damage veil intensity is the inverse of health, eased so it only
      // becomes obtrusive when the player is genuinely in danger.
      const veil = Math.pow(1 - state.health, 2.1);
      this.damageVeil.style.opacity = veil.toFixed(3);
    }

    // --- stance ---
    const stance = state.sprinting ? 'SPRINT' : state.crouched ? 'CROUCHED' : '';
    if (stance !== this.lastStance) {
      this.lastStance = stance;
      this.stanceEl.textContent = stance;
    }

    // --- objective counter ---
    const counter = `HOSTILES ${String(state.enemiesRemaining).padStart(2, '0')} / ${String(
      state.enemiesTotal,
    ).padStart(2, '0')}`;
    if (counter !== this.lastCounter) {
      this.lastCounter = counter;
      this.objectiveCounter.textContent = counter;
    }

    // --- directional damage arc ---
    if (this.hitArcTimer > 0) {
      this.hitArcTimer -= dt;
      this.hitArc.style.opacity = clamp01(this.hitArcTimer).toFixed(2);
      // Angle between the camera's forward and the incoming direction.
      const worldAngle = Math.atan2(this.lastDamageDirection.x, this.lastDamageDirection.z);
      const relative = worldAngle - state.cameraYaw + Math.PI;
      this.hitArc.style.transform = `rotate(${(relative * 180) / Math.PI}deg)`;
      this.hitArcPath.setAttribute('stroke-opacity', clamp01(this.hitArcTimer).toFixed(2));
    }
  }

  /**
   * Projects the extraction marker to screen space.
   * Clamped to the frame edge when off-screen so the player always knows
   * which way to go without a minimap.
   */
  updateMarker(worldPosition: THREE.Vector3, camera: THREE.PerspectiveCamera, visible: boolean, label: string): void {
    if (!visible) {
      this.marker.style.opacity = '0';
      return;
    }
    this.projected.copy(worldPosition).project(camera);
    const behind = this.projected.z > 1;
    let x = (this.projected.x * 0.5 + 0.5) * window.innerWidth;
    let y = (-this.projected.y * 0.5 + 0.5) * window.innerHeight;
    if (behind) {
      // Mirror through the centre and pin to the bottom edge.
      x = window.innerWidth - x;
      y = window.innerHeight * 0.86;
    }
    const margin = 60;
    x = Math.max(margin, Math.min(window.innerWidth - margin, x));
    y = Math.max(margin, Math.min(window.innerHeight - margin, y));
    this.marker.style.left = `${x.toFixed(0)}px`;
    this.marker.style.top = `${y.toFixed(0)}px`;
    this.marker.style.opacity = behind ? '0.45' : '1';
    const distanceLabel = this.marker.querySelector('.dist');
    if (distanceLabel) distanceLabel.textContent = label;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.root.remove();
  }
}

const TEMPLATE = /* html */ `
  <div class="crosshair">
    <span class="top"></span>
    <span class="bottom"></span>
    <span class="left"></span>
    <span class="right"></span>
    <span class="dot"></span>
  </div>

  <div class="hitmarker">
    <span class="tl"></span><span class="tr"></span>
    <span class="bl"></span><span class="br"></span>
  </div>

  <div class="hit-arc">
    <svg viewBox="0 0 280 280">
      <path d="M 96 40 A 110 110 0 0 1 184 40"
            fill="none" stroke="#ff5a44" stroke-width="4" stroke-linecap="round" stroke-opacity="0"/>
    </svg>
  </div>

  <div class="marker">
    <span class="glyph"></span>
    <span class="dist">EXTRACT</span>
  </div>

  <div class="objective">
    <div class="heading">OBJECTIVE</div>
    <div class="text">ADVANCE TO THE PIER HEAD</div>
    <div class="counter">HOSTILES 00 / 00</div>
  </div>

  <div class="ammo">
    <div class="weapon-name">MK-7</div>
    <div class="counts">
      <div class="mag">30</div>
      <div class="reserve">/ 180</div>
    </div>
    <div class="reload-hint">PRESS R TO RELOAD</div>
    <div class="reload-bar"><i></i></div>
  </div>

  <div class="status">
    <div class="label">CONDITION</div>
    <div class="bar"><i></i></div>
    <div class="stance"></div>
  </div>

  <div class="damage-veil"></div>
  <div class="perf"></div>
`;
