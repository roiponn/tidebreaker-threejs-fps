/**
 * Where does the sight actually land on screen, at each window shape?
 *
 * The view-model is a child of the weapon camera, so its screen position is a
 * pure function of its local pose and that camera's projection. This projects
 * the optic's sight point and the weapon's bounding box without a browser.
 */
import * as THREE from 'three';
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {} }) }),
};
import { WeaponController } from '@/weapons/WeaponController';
import { PlayerCamera } from '@/player/PlayerCamera';
import { EventBus } from '@/core/EventBus';
import { cloneVisualConfig } from '@/config/visual';

const visual = cloneVisualConfig();
const view = new PlayerCamera(visual);
const mats = new Proxy({}, { get: () => () => new THREE.MeshStandardMaterial() }) as never;
const weapon = new WeaponController(mats, view, { raycast: () => null } as never, new EventBus(), visual);
const eye = new THREE.Vector3(0, 1.7, 0);

const box = new THREE.Box3();
const v = new THREE.Vector3();

function settle(ads: boolean, aspect: number): void {
  view.setAspect(aspect);
  for (let i = 0; i < 200; i++) {
    weapon.setTrigger(false);
    view.update(1 / 60, i / 60, eye, 0, true, weapon.adsBlend, false);
    weapon.update(1 / 60, i / 60, ads, false, 0, true, false, 0, 0);
  }
}

console.log('aspect  mode  sightNDC(x,y)     opticH%  opticW%');
for (const aspect of [1.33, 1.54, 1.78, 2.33]) {
  for (const ads of [false, true]) {
    settle(ads, aspect);
    view.weaponCamera.updateMatrixWorld(true);
    // Optic sight point, rifle-local (0, 0.100, -0.052).
    v.set(0, 0.1, -0.052).applyMatrix4(weapon.parts.root.matrixWorld);
    const ndc = v.clone().project(view.weaponCamera);
    // Optic hood only. The full rifle bounding box is useless here because the
    // stock sits behind the camera and projects to garbage.
    const top = new THREE.Vector3(0, 0.126, -0.052).applyMatrix4(weapon.parts.root.matrixWorld);
    const bot = new THREE.Vector3(0, 0.074, -0.052).applyMatrix4(weapon.parts.root.matrixWorld);
    const lft = new THREE.Vector3(-0.026, 0.1, -0.052).applyMatrix4(weapon.parts.root.matrixWorld);
    const rgt = new THREE.Vector3(0.026, 0.1, -0.052).applyMatrix4(weapon.parts.root.matrixWorld);
    const h = Math.abs(top.project(view.weaponCamera).y - bot.project(view.weaponCamera).y) * 50;
    const w = Math.abs(rgt.project(view.weaponCamera).x - lft.project(view.weaponCamera).x) * 50;
    void box;
    console.log(
      `${aspect.toFixed(2)}   ${ads ? 'ADS ' : 'hip '}  ` +
        `(${ndc.x.toFixed(3)}, ${ndc.y.toFixed(3)})   ${h.toFixed(0)}%          ${w.toFixed(0)}%`,
    );
  }
}
