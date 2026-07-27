# Handover

For whoever picks this up next. Read [VISUAL_DESIGN.md](VISUAL_DESIGN.md) §7 before changing
anything that affects the look, and [QUALITY_REPORT.md](QUALITY_REPORT.md) §2 for the ranked list
of what is still wrong.

---

## 1. Design philosophy

Four rules the codebase is built around. Breaking them will make things worse, not faster.

1. **Configuration is data, code is behaviour.** Every number that affects the look lives in
   `src/config/visual.ts`; every number that affects feel lives in `src/config/gameplay.ts`. No
   system hardcodes a colour, an intensity or a timing. The debug panel writes to those same
   objects and calls the same `refresh()` paths used at boot — there is no second rendering path
   that can drift.

2. **Events, not references.** `src/core/EventBus.ts` is the spine. The weapon does not know the
   HUD, the audio engine or the VFX system exist; it emits `weapon:fired` and everyone reacts on
   the same frame. This is *why* the flash, the light, the smoke, the casing, the tracer, the
   impact and the report are synchronised — not by scheduling, but structurally.

3. **Fixed budgets, no per-frame allocation.** Every pool is allocated at construction and never
   grows. Nothing in an update loop calls `new`. When a pool is full the oldest entry is recycled.

4. **Every light has a fixture; every fixture is chamfered.** Free-floating light and sharp 90°
   edges are the two fastest ways to make a 3D scene look untextured.

---

## 2. Where the game loop is

**`src/app/Game.ts` → `renderFrame(now)`.** One function, ten commented steps. The order is a
contract:

```
1  input drain
2  mission director (owns the camera only during the intro)
3  player movement -> camera transform
4  weapon animation        <- MUST follow 3, or the view-model lags a frame
5  enemies + AI fire
6  world reactions (explosives, wind, practicals, level, lighting, sky)
7  VFX                     <- MUST follow 4, or the muzzle flash lags a frame
8  audio listener
9  mission state + HUD
10 planar reflection, then the main render
```

Steps 4 and 7 following 3 is not stylistic. Move them and the weapon visibly "swims".

---

## 3. Scene construction flow

`Game.boot()` runs six awaited stages so the loader keeps painting:

```
installFogPatch()          <- MUST be first: it overrides three's ShaderChunks
  -> RenderSystem          (renderer + all post targets)
  -> TextureFactory        (procedural PBR sets)  -> MaterialLibrary
  -> SkyDome -> Lighting   (Lighting reads sunDirection from SkyDome)
  -> HarborLevel           (PropKit -> LevelBuilder -> merged static batches
                            + Practicals + WetGround + DistantScenery)
  -> PlayerCamera, Player, EnemyManager, Explosives
  -> VfxManager, WeaponController, Ballistics
  -> Hud, MissionDirector, DebugPanel, Input
```

`HarborLevel`'s constructor calls `buildBay/Canyon/Yard/Warehouse/Quay/PierHead`, each of which
queues geometry into `LevelBuilder`; `builder.build(collision)` merges it and registers collision.

---

## 4. Asset management

There are no asset files. Everything is generated:

- **Textures** — `TextureFactory` memoises every set by key. `dispose()` releases them.
- **Geometry** — `PropKit` caches by key so a container built ten times shares one buffer.
- **Audio** — `AudioEngine` builds one noise buffer and one procedural impulse response at first
  user gesture; every sound is assembled from oscillators and filters at play time.

Every system owns a `Disposer` (`src/core/Disposal.ts`) and `Game.dispose()` unwinds all of it,
including event listeners and the `ResizeObserver`. This is wired to `beforeunload` and to Vite's
HMR dispose hook.

---

## 5. Weapon pipeline

```
Input.firing
  -> WeaponController.setTrigger
  -> updateFiring() rate-limits, checks state, applies spread
  -> fire()  : decrement ammo, sample the ANIMATED muzzle position,
               apply cone spread, kick camera + weapon springs,
               emit weapon:fired
        |
        +-- VfxManager.onWeaponFired : flash quad + world light + smoke + casing
        +-- AudioEngine.playWeaponFire : crack + body + thump + mech + reverb
        +-- Ballistics.firePlayerShot : hitscan world & enemies, spawn tracer,
                                        emit impact:surface / impact:enemy
                |
                +-- VfxManager.onImpact : per-material sparks/dust/chunks/decal
                +-- AudioEngine.playImpact : per-material filter + panel ring-out
                +-- Explosives.registerImpact : proximity damage to drums
```

The muzzle position is read from the animated model, so recoil, sway and bob all move the flash
and the tracer origin with the gun.

The pose is composed additively in `composePose()` from six independent layers. To debug the
feel, zero one layer at a time — they cannot fight each other.

---

## 6. VFX management

`VfxManager` owns everything and subscribes to the bus in `bindEvents()`. It exposes three
callbacks the game wires to world systems, which is how VFX reach out without importing them:

```ts
vfx.onGroundRipple = (x, z, s) => level.wetGround.addRipple(x, z, s);
vfx.onLampShock    = (p, power) => level.practicals.applyShock(p, power);
vfx.onCameraShake  = (amp, freq) => view.addShake(amp, freq);
```

`ParticleSystem` has two instanced batches (additive, lit). Adding a new effect means adding a
`ParticleSpec` to the `SPEC` table at the bottom of `VfxManager.ts` — not a new class.

**The blast light is animated, and the animation is the point.** `updateExplosionLight()` moves
intensity, radius *and* colour together over the light's life. The radius is the load-bearing part:
three windows a point light's falloff toward its `distance`, so starting small (34% of full) and
expanding during decay is what makes near surfaces receive far more than distant ones. Raising
`lightIntensity` without shrinking `lightDistance` will take you straight back to a flat screen
tint. The emitter also sits 1.45 m above the charge (`UP_HALF`) so the `1/d²` singularity is not
sitting on the ground plane.

Smoke receives the blast through `ParticleSystem.setFlashLight()`, fed from the same update, and
the shader weights it by particle *youth* — old smoke has expanded into a thin wide veil, and
letting that catch the flash tints the whole frame.

**If the screen ever washes a flat colour during combat, look at `uDamageFlash` in
`CompositeShader` before you look at the explosion.** It is a vignette now; it used to have a
constant term, and that constant cost a lot of time to find.

---

## 7. Config file map

| File | Owns |
| --- | --- |
| `src/config/visual.ts` | Everything that affects the look |
| `src/config/gameplay.ts` | Player, weapon, enemy, mission tuning |
| `src/config/quality.ts` | The three presets + auto-detect + URL override |
| `src/config/input.ts` | Key bindings |
| `src/effects/ImpactPresets.ts` | Per-material impact response |
| `src/effects/VfxManager.ts` (`SPEC`) | Particle presets |

---

## 8. Performance notes

See [PERFORMANCE.md](PERFORMANCE.md). The three things most likely to bite you:

1. **Adding a light is a per-pixel cost across the whole screen.** Forward rendering evaluates
   every light for every lit fragment. Prefer an emissive fixture.
2. **Adding a shadow-casting light is a whole extra scene render.**
3. **Adding an unmerged mesh multiplies by the number of scene traversals** (currently four).

---

## 9. Placeholder / provisional implementations

Honestly labelled, because these look finished but are not:

| Area | What is provisional |
| --- | --- |
| Enemy AI | Two-point strafe lane + burst fire. No navmesh, no cover selection, no reaction to being flanked. Intentional per the brief, but it is a stub |
| Enemy animation | Rigid parts driven by sines. No skinning, no IK, no blending |
| Physics | Custom AABB resolve + per-system integrators. No rigid-body solver; casings, debris and lamps each run their own tiny integrator |
| Destruction | Only the fuel drums. They hide rather than fracture |
| Audio | Fully synthesised. Structurally correct but does not sound like recorded firearms |
| Death / fail state | Camera settles, end card appears. No death animation |
| Mission completion | Distance to pad + hostiles ≤ 2. No extraction vehicle or sequence |
| Decals | Camera-agnostic quads offset along the normal, not projected. Fine on planar surfaces, wrong on curved ones |
| Motion blur | Camera-rotation approximation, no velocity buffer. Moving objects do not blur |
| DoF | Single-pass poisson gather in the composite; no separate near/far fields or bokeh shaping |

---

## 10. Refactoring candidates

1. **`HarborLevel.ts` is ~700 lines** of authored layout. Split per zone into
   `environment/zones/*.ts` with a shared context object.
2. **`VfxManager.ts` does orchestration *and* owns tracers, casings and shockwaves.** Extract
   those into `effects/Tracers.ts`, `effects/Casings.ts`, `effects/Shockwaves.ts`.
3. **`Game.ts` wiring** — `wireEvents()` is a long list of subscriptions. A small
   `systems/AudioBindings.ts` and `systems/WorldReactionBindings.ts` would shorten it.
4. **`LevelBuilder` merge buckets** should be spatial, not authored-zone based (restores culling).
5. **`Game.weaponReloadFraction`** reaches into `WeaponController` private state through a cast.
   Expose a real `reloadProgress` getter.
6. **`Practicals`** conflates fixtures, flicker, beacons and pendulum lamps. Split into
   `FixtureRegistry` + `FlickerController` + `PendulumLamps`.

---

## 11. Do not break these

1. `installFogPatch()` runs before any material compiles.
2. Metre-scale UVs on all new geometry.
3. The roughness floors (wet 0.32, gun metal 0.28).
4. `ambient.intensity` ≥ ~1.0.
5. The view-model camera shares near/far with the world camera.
6. Luminance-normalised split-toning in the composite.
7. Camera shake never touches yaw or pitch — position and roll only.
8. `chamferBox`, never `BoxGeometry`, for hard surfaces.

---

## 12. Testing hooks you should keep

Three of these exist because the properties they check are *invisible on screen* — do not delete
them as debug cruft:

| Hook | Why it cannot be done by hand |
| --- | --- |
| `?chaintest=N` ([`src/debug/ChainTest.ts`](../src/debug/ChainTest.ts)) | Single-trigger protection, chain termination, destroyed-drum inertness and pool recycling across repeats produce no visible difference even if you catch the 2 s event |
| `?boomhold=L` | The blast light's whole life is 0.62 s; pinning it is the only way to compare the same viewpoint at ignition, peak and ember |
| `?posetest=1` | Freezes the AI and holds five hostiles at fixed distances so pose quality is repeatable rather than whatever the fight happens to produce |
| `document.body.dataset.*` | A scripted console runs in an isolated world and cannot reach module state |

`ChainTest` writes its whole result set as JSON to `document.body.dataset.chain`. If you change
drum placement, re-run it — the "out-of-range drums survive" assertion depends on the 14 m gap
between the two clusters.

---

## 13. Suggested next work, in order

Items 1–5, 8 and 10 of the original list are done (QUALITY_REPORT P1–P6, P8–P11). What remains:

1. **Play the full 90 seconds on real hardware with real pointer lock.** Enemy fire, taking damage,
   dying, and reaching extraction have never been exercised end to end — this environment refuses
   pointer lock and throttles the page to ~4 fps whenever it is scripted. This is the largest
   unverified area in the project and it is a *gameplay* risk, not a visual one.
2. **Validate frame rate and re-tune the presets.** Everything in PERFORMANCE.md about absolute
   frame times is unproven; the host here reported 1 fps and 54 fps for near-identical builds, and
   the Performance preset measured *slower* than Cinematic. Draw calls (638), triangles (302k) and
   lights (17) are the only hardware-independent numbers available.
3. **Watch the enemies move at frame rate.** The secondary-motion system (QUALITY_REPORT §5) was
   inspected in still frames at five distances, not viewed in motion. If anything reads as drunk or
   rubbery, the first suspects are the hip-yaw break threshold (0.55 rad) and the lean spring rates
   in `EnemyManager.animate()` — both are documented in place.
4. **Skinned character meshes.** This is the only route to fixing the remaining rigidity: rigid
   capsules cannot deform at a joint, shoulders cannot compress, and there is no cloth or gear
   sway. It replaces the character pipeline, its materials and its animation system at once, so it
   is a project of its own — not a polish pass. See QUALITY_REPORT §5.
5. **Spatial merge buckets** in `LevelBuilder` (P7). Buckets are authored-zone based, so a whole
   zone draws if any part of it is visible. Geometric LODs are also absent.
6. **A cheap blast occlusion approximation** (P10). Deliberately skipped: a cube shadow map for a
   0.6 s light forces a material recompile per detonation. If it is wanted, a few shadow rays
   against the collision world modulating intensity per-frame would be the cheap route.
