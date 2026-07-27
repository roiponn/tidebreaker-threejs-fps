# Known issues

Ordered by severity. Nothing here is fixed; this is the honest defect list.

## Visual

| # | Issue | Severity | Where |
| --- | --- | --- | --- |
| V1 | FIXED. Palette now leans slightly cool overall; the white balance carries more of the correction than the practical mix does | Low | `config/visual.ts` |
| V2 | FIXED. Remaining: the spawn point sits in one large pool whose far edge reads as a soft horizontal step | Medium | `environment/WetGround.ts` |
| V3 | FIXED. Two parallaxing cloud decks plus a fog-coloured haze band | — | `shaders/SkyShader.ts` |
| V4 | FIXED (capsule bones with cap centres on the pivots + torso-parented coverage). Residual: still visibly rigid-part on close inspection - no skinning or cloth deformation | Low-medium | `enemies/EnemySoldier.ts` |
| V5 | FIXED. Dedicated VIEWMODEL-layer key light | — | `scene/Lighting.ts` |
| V6 | Decals are offset quads, not projected. Corrugated cladding needs a 3.8cm offset to stay visible above the ribs, which makes holes float slightly when viewed edge-on | Medium | `effects/DecalSystem.ts` |
| V7 | Motion blur has no velocity buffer; moving objects do not blur, only the camera | Low | `shaders/CompositeShader.ts` |
| V8 | FIXED. Per-fixture cloned materials with an immutable base value; one writer for light intensity | - | `environment/Practicals.ts` |
| V9 | Texel density is inconsistent between large surfaces and small props at close range | Low | `materials/MaterialLibrary.ts` |

## Performance

| # | Issue | Severity | Where |
| --- | --- | --- | --- |
| P1 | **60 fps @ 1080p is unverified.** Only a virtualised GPU was available, and it reported 1 fps and 29 fps for the identical build minutes apart | High (unknown) | — |
| P1b | The visual pass added real fragment cost (two cloud decks, an extra mask fetch). Mitigated by drawing the sky last and halving its octaves, but the net effect is unmeasured | Medium (unknown) | `shaders/SkyShader.ts`, `environment/WetGround.ts` |
| P2 | The Performance preset measured *slower* than Cinematic on the dev machine; cause not isolated | High (unknown) | `config/quality.ts` |
| P3 | Zone-based geometry merging still defeats per-object frustum culling (shadow-caster and animation LOD added, but buckets are not spatial) | Medium | `environment/LevelBuilder.ts` |
| P4 | 17 forward lights is still high for a forward renderer | Medium | `environment/Practicals.ts` |
| P5 | Planar reflection is a full extra scene traversal with no object filtering | Medium | `environment/WetGround.ts` |
| P6 | Shadow maps re-render every frame in a nearly static scene | Low-medium | `core/RenderSystem.ts` |
| P7 | No GEOMETRIC LODs; only shadow-caster and animation LOD exist | Low | — |

## Gameplay / systems

| # | Issue | Severity | Where |
| --- | --- | --- | --- |
| G1 | Enemy fire and player damage were confirmed, but death and mission completion were never reached; pointer lock was unavailable so play was driven with synthetic events | High | — |
| G2 | Explosion brightness re-verified on screen (does not clip; see QUALITY_REPORT P6). Residual: the flash is fairly uniform rather than falling off with distance, and smoke is not prominent during it. Drum CHAIN reactions still unconfirmed | Medium | `config/visual.ts`, `environment/Explosives.ts` |
| G3 | Enemy AI has no cover use, no flanking, no reaction to being shot at from behind | Medium (by design) | `enemies/EnemyManager.ts` |
| G4 | Mission completion requires hostiles ≤ 2 *and* proximity; a player who kills nobody can never finish | Medium | `app/MissionDirector.ts` |
| G5 | Collision is AABB-only; diagonal surfaces (stair stringers, the leaning container) collide as boxes | Low-medium | `physics/CollisionWorld.ts` |
| G6 | Enemies on the catwalk are placed at a hard-coded Y and do not path down | Low (by design) | `environment/HarborLevel.ts` |
| G7 | No pause menu; `Esc` releases the mouse and shows the briefing card | Low | `ui/Overlays.ts` |
| G8 | Audio is synthesised and does not sound like recorded firearms | Low (by design) | `audio/AudioEngine.ts` |

## Platform

| # | Issue | Severity |
| --- | --- | --- |
| X1 | Requires WebGL 2. A clear error card is shown otherwise, but there is no fallback renderer |
| X2 | Pointer lock refusal falls back to a soft lock, which loses the mouse at screen edges |
| X3 | Desktop only; no touch or gamepad input |
| X4 | Boot spends ~0.4 s generating textures on the main thread. A Web Worker would remove the hitch |
| X5 | `body[data-phase]` / `body[data-tick]` diagnostics are always written; harmless but should be dev-gated before shipping |
