/**
 * Headless probe: does the sight actually hold still while firing in ADS?
 *
 * Five attempts at the scope shake were shipped without ever being observed,
 * because the embedded browser throttles the page too hard to reach sustained
 * firing. This runs the REAL WeaponController and PlayerCamera against stubs
 * and prints the view-model's pose per frame, which is the thing the player is
 * looking through. The weapon is a child of the weapon camera, so if
 * parts.root holds still, the sight holds still.
 */
import * as THREE from 'three';
import { WeaponController } from '@/weapons/WeaponController';
import { PlayerCamera } from '@/player/PlayerCamera';
import { EventBus } from '@/core/EventBus';
import { cloneVisualConfig } from '@/config/visual';

// Minimal DOM shim: RifleModel paints its reticle onto a 2D canvas, which is
// the only browser API anywhere in the pose path.
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, moveTo() {},
      lineTo() {}, stroke() {}, fill() {}, closePath() {},
      set fillStyle(_v: string) {}, set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {}, set globalAlpha(_v: number) {},
    }),
  }),
};

const visual = cloneVisualConfig();
const bus = new EventBus();
const view = new PlayerCamera(visual);
view.setAspect(16 / 9);

// Stubs: the probe only exercises pose maths, not rendering or collision.
const mats = new Proxy({}, { get: () => () => new THREE.MeshStandardMaterial() }) as never;
const collision = { raycast: () => null } as never;

const weapon = new WeaponController(mats, view, collision, bus, visual);

const eye = new THREE.Vector3(0, 1.7, 0);
const fps = Number(process.argv[2] ?? 60);
const dt = 1 / fps;
let t = 0;

console.log(`fps=${fps}  dt=${dt.toFixed(4)}`);
console.log('frame   ads   root.x   root.y   root.z   rotX     camPitch  ammo');
for (let i = 0; i < Math.round(fps * 1.6); i++) {
  weapon.setTrigger(true, i === 0);
  view.update(dt, t, eye, 0, true, weapon.adsBlend, false);
  weapon.update(dt, t, false, false, 0, true, false, 0, 0);
  t += dt;
  if (i % Math.max(1, Math.round(fps / 20)) === 0) {
    const p = weapon.parts.root.position;
    const r = weapon.parts.root.rotation;
    console.log(
      `${String(i).padStart(4)}  ${weapon.adsBlend.toFixed(2)}  ` +
        `${p.x.toFixed(4)}  ${p.y.toFixed(4)}  ${p.z.toFixed(4)}  ` +
        `${r.x.toFixed(4)}  ${view.debugRecoilPitch.toFixed(4)}   ${weapon.magAmmo}`,
    );
  }
}
