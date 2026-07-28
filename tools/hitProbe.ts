/**
 * Where on a hostile do rounds actually register?
 *
 * Fires horizontal rays at a soldier from 12m at 5cm height intervals and
 * reports which zone each one strikes. The lower body used to be a dead zone
 * and this is the cheapest way to prove it no longer is.
 */
import * as THREE from 'three';
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) }),
};
import { EnemyManager } from '@/enemies/EnemyManager';
import { EventBus } from '@/core/EventBus';
import { WEAPON_CONFIG, ENEMY_CONFIG } from '@/config/gameplay';

const mats = new Proxy({}, { get: () => () => new THREE.MeshStandardMaterial() }) as never;
const enemies = new EnemyManager(mats, new EventBus(), { hasLineOfSight: () => true } as never);
enemies.spawnAll([
  { position: new THREE.Vector3(0, 0, 0), patrolTo: new THREE.Vector3(0, 0, 0), activationX: -99, elevated: false },
]);

const dir = new THREE.Vector3(0, 0, -1);
console.log('shots-to-kill: body', Math.ceil(ENEMY_CONFIG.health / WEAPON_CONFIG.damage),
  ' head', Math.ceil(ENEMY_CONFIG.health / (WEAPON_CONFIG.damage * WEAPON_CONFIG.headshotMultiplier)),
  ' legs', Math.ceil(ENEMY_CONFIG.health / (WEAPON_CONFIG.damage * WEAPON_CONFIG.limbMultiplier)));
console.log('\nheight(m)  zone');
for (let h = 0.05; h <= 1.85; h += 0.1) {
  const hit = enemies.raycast(new THREE.Vector3(0, h, 12), dir, 40);
  console.log(`  ${h.toFixed(2)}     ${hit ? hit.zone : '-- MISS --'}`);
}
