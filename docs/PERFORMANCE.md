# Performance

## 1. How to measure

Press `F` in game for the overlay: fps, frame time, draw calls, triangles, textures, live
particles, live decals, active lights, collision boxes and the current preset.

Force a preset with `?quality=low|medium|high`.

## 2. Measured results

All figures from the same viewpoint (mission start, looking down the berth) in the browser
available during development. **That browser runs on a virtualised GPU and its absolute frame
times are not representative of a desktop.** The draw-call, triangle and light counts *are*
hardware-independent and are the numbers to trust.

| | Before optimisation | After |
| --- | --- | --- |
| Draw calls / frame | 931 | **556** |
| Triangles / frame | 423 k | **262 k** |
| Active lights | 26 | **17** |
| Frame time (this machine, Cinematic) | 53 ms | **18.6 ms** |

The frame-time figure is included because the *relative* change was measured back to back on the
same machine within minutes. The absolute value should not be quoted as a target-hardware result.

### Where the wins came from

1. **Practical spot-light shadows → 0 on all presets.** Each shadow-casting spot light is a
   complete extra scene traversal. Two of them were ~⅓ of all draw calls.
2. **Light count 26 → 17.** three's forward renderer evaluates *every* light for *every* lit
   fragment, so light count is a per-pixel cost across the whole screen. Removing six lights alone
   took frame time from 48 ms to 28 ms here. Fixtures whose light was removed are still modelled
   and still glow (emissive + bloom), so the scene did not lose a single visible source.
3. **Soldier rig merged** from ~23 meshes to ~12. Eleven hostiles × 11 meshes saved ≈ 120 draw
   calls per scene traversal, multiplied by every traversal in the frame.

## 3. Where the frame goes

Scene traversals per frame (Cinematic):

| Pass | Cost |
| --- | --- |
| Directional shadow map (2048²) | 1 full traversal |
| Planar reflection (wet ground) | 1 full traversal |
| World | 1 full traversal |
| View-model | 1 tiny traversal |
| SSAO + 2 blurs | 3 half-res full-screen passes |
| Auto-exposure | 4 tiny passes (64² → 1²) |
| Bloom | 11 passes, halving each time |
| Composite | 1 full-res pass (the expensive one) |
| FXAA | 1 full-res pass |

The composite deliberately folds DoF, motion blur, AO application, bloom combine, exposure,
tonemap, grade, vignette, grain and chromatic aberration into **one** pass. Splitting them would
cost five more full-resolution passes.

## 4. Budgets (enforced in code)

| Resource | Low | Medium | High | Enforced by |
| --- | --- | --- | --- | --- |
| Particles | 900 | 1800 | 3200 | `ParticleSystem` fixed pools, oldest recycled |
| Decals | 40 | 80 | 140 | `DecalSystem` + `Pool` |
| Tracers | 28 | 28 | 28 | `VfxManager` pool |
| Casings | 18 | 18 | 18 | `VfxManager` pool |
| Shockwaves | 6 | 6 | 6 | `VfxManager` pool |
| Shadow map | 1024² | 2048² | 2048² | `quality.shadowMapSize` |
| Reflection scale | off | 0.4 | 0.5 | `quality.reflectionScale` |
| Pixel ratio cap | 1.0 | 1.5 | 2.0 | `quality.maxPixelRatio` |
| Render scale | 0.85 | 1.0 | 1.0 | `quality.renderScale` |

No pool ever grows. When one is exhausted the oldest entry is recycled, so a chain of explosions
degrades visually instead of spiking frame time.

## 5. Textures

All procedural, generated once at boot (≈0.4 s of CPU, spread across boot stages so the loader
keeps animating).

| Set | Resolution | Maps |
| --- | --- | --- |
| Concrete, asphalt, container paint, steel, tread, cladding, gun metal | 512² | albedo + normal + ORM |
| Gun polymer, rubber, fabric | 256² | albedo + normal + ORM |
| Sprites, decals, chain-link, grating, hazard | 128–256² | single |

Roughly 84 textures live. The ORM packing means AO, roughness and metalness share one upload and
one bind per material.

## 6. Known performance issues

1. **Merging defeats per-object culling.** `LevelBuilder` merges by (zone, material), so a whole
   zone draws if any part of it is visible. Splitting by a spatial grid instead of by authored
   zone would restore culling while keeping draw calls low.
2. **The planar reflection is a full extra scene render.** It is the single most expensive optional
   feature. It could render a reduced object set via layers.
3. **No LODs.** Distant containers draw at full density; the skyline is already a single merged
   silhouette, but the playable set is not simplified with distance.
4. **17 forward lights is still high.** A clustered/deferred approach, or distance-based light
   culling with a fixed active count, would be the next structural win.
5. **The Performance preset measured slower than Cinematic on the development machine.** Two
   plausible causes were removed (odd-sized render targets; the composite writing straight to the
   default framebuffer) without changing the result, which points at the host GPU. Unverified on
   real hardware.
6. **Shadow maps re-render every frame.** The scene is nearly static; a dirty-flag scheme that
   only re-renders when the sun or a large object moves would save a full traversal.
