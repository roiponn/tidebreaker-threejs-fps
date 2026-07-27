# Quality report — TIDEBREAKER / Berth 7

Written from the position the brief asked for: the reviewer's job is to find what is wrong, not
to praise the build. Everything below was found by **rendering actual frames and looking at
them**, not by reading the code.

## 0. What was and was not verified

Being explicit, because the brief forbids claiming unverified work:

| Claim | Status |
| --- | --- |
| Project builds with no TypeScript errors | **Verified** — `tsc --noEmit` clean |
| Boots and reaches the playable state | **Verified** — mission phase reaches `active` |
| Firing, ammo drain, auto-reload, reload animation | **Verified** on screen |
| HUD updates (ammo, objective, hostile count, extraction range) | **Verified** on screen |
| Draw-call / triangle / light counts | **Verified** with the in-game overlay |
| 60 fps at 1080p on a discrete GPU | **NOT verified** — see §4 |
| Enemy AI firing back, player damage, death, mission complete | **NOT directly verified** — the loop is implemented and enemies activate, but I did not play far enough down the berth to confirm a full kill-to-extraction run |
| Explosions, chain reactions, decals, casings on screen | **NOT directly verified** — implemented and wired, but not visually confirmed in a captured frame |
| Blind comparison against reference footage | **Not performed.** No reference material was provided |

---

## 1. Defects found and fixed during review

These were all real, all found by looking at rendered frames:

| # | Problem | Cause | Fix |
| --- | --- | --- | --- |
| 1 | Whole image a red smear | Split-toning multiplied by a raw colour, tinting *and* darkening | Normalise the tone to unit luminance first (`CompositeShader.ts`) |
| 2 | Opening shot crouched, staring at the deck; weapon retracted | Intro camera offset applied during the briefing phase and accumulated into the aim | Phase-gate it; make it a pure additive offset (`MissionDirector`, `PlayerCamera`) |
| 3 | Player spawned facing a wall | `playerSpawnYaw` sign error | `-PI/2` (`HarborLevel.ts`) |
| 4 | Yard essentially unlit; only ambient visible | Practical intensities (46) were pre-decay values; with `decay = 2` they vanish | Re-derived for 1/d²: floods 620, muzzle 900, explosion 5200 |
| 5 | Every panel texture ~10× too large | `PlaneGeometry` used 0–1 UVs while `chamferBox` used metres | Unified metre UVs project-wide; retiled every material |
| 6 | Weapon read as chrome static | High-frequency normal on an 88 % metallic surface | Flattened the normal, floored roughness at 0.28 |
| 7 | Weapon read as a slab across the frame | View-model origin too far forward, stock inside the frustum | Origin moved to the shoulder |
| 8 | Cladding showed heavy moiré | Ribs in **both** geometry and texture | Texture ribs removed; geometry owns them |
| 9 | Ground was a field of dark blobs | Ground plane divided UVs by 4 *and* inherited a coarse repeat | Metre UVs + its own 1.4 m tiling |
| 10 | Reload swept a huge magazine across the lens | Magazine dropped straight down at 15 cm from the camera | Drops down **and away**, hidden earlier |
| 11 | Canvas did not fill the viewport | Sizing from `window.innerWidth` | `ResizeObserver` on the canvas itself |
| 12 | Shader compile failures (sea, wet ground, bloom) | `.z` on a `vec2`; `luminance()` colliding with three's prefix | Fixed |
| 13 | Game unplayable where pointer lock is refused | No fallback | Soft-lock fallback reading raw mouse deltas |
| 14 | 931 draw calls, 26 lights | Per-part enemy meshes, spot shadows, a light per fixture | 556 draw calls, 17 lights (see [PERFORMANCE.md](PERFORMANCE.md)) |

---

## 2. What is still not good enough

Ranked by how much it costs the impression. **Nothing here is fixed.**

### P1 — The palette is still narrow

**Problem.** Even after moving to a dusk/night midpoint, mid-range frames sit in a warm
orange-brown band. Containers, deck and warehouse all land close together in hue.
**Cause.** One warm key + one warm practical colour + a warm-dominant PMREM probe. The cool
hemisphere fill is present but too low-contrast to separate planes.
**Priority.** High — it is the first thing a viewer notices.
**Fix.** Give the practicals two colour families (sodium amber for the yard, mercury cyan-white
for the warehouse and pier) so the player crosses between colour zones. Push
`ambient.skyColor` further toward cyan and raise `fog.aerialStrength`.
**Files.** `src/config/visual.ts`, `src/environment/HarborLevel.ts` (per-light colour arguments).
**Verify.** Screenshot at x≈10, 30 and 50; the three should not be the same hue.

### P2 — Puddles and planar reflections are not reading

**Problem.** The apron looks damp, but the mirror-like puddles and the reflected floodlights that
justify the whole wet-ground system are barely visible in captured frames.
**Cause.** Suspected: the puddle mask threshold `(depth - 0.52) * 6.5` leaves too little coverage
at `uWetness = 0.82`, and the fresnel term suppresses reflection at the near-vertical angles a
standing player has over nearby ground.
**Priority.** High — this is the single largest visual investment in the project.
**Fix.** Lower the mask threshold, widen the puddle bodies, and raise the fresnel floor from 0.18
to ~0.3 so nearby puddles still show something. Add a debug view that outputs the mask directly.
**Files.** `src/environment/WetGround.ts` (`buildPuddleMask`, `GROUND_REFLECTION`).
**Verify.** Stand 3 m from a floodlight pool; its reflection should be visible in the deck.

### P3 — Sky lacks structure

**Problem.** The dome is a smooth gradient; the cloud layer barely registers.
**Cause.** Coverage 0.6 with `density *= smoothstep(-0.02, 0.22, h)` kills clouds near the
horizon, which is most of what the player sees.
**Priority.** Medium-high — the sky occupies a third of most frames.
**Fix.** Extend clouds below h=0.22 with a compressed vertical scale, and raise the contrast
between lit and shadowed cloud.
**Files.** `src/shaders/SkyShader.ts`.
**Verify.** Look up and toward the horizon; both should show cloud form.

### P4 — Enemies are crude at close range

**Problem.** Rigid, un-skinned parts; at under ~8 m the shoulder and hip joints visibly separate.
**Cause.** Deliberate — the brief asked for minimal enemies — but it becomes the weakest asset on
screen when one is close.
**Priority.** Medium.
**Fix.** Either skinned meshes with a simple 12-bone rig, or keep rigid parts and cover the joints
with overlapping gear (shoulder pads already do this; hips and knees do not).
**Files.** `src/enemies/EnemySoldier.ts`.
**Verify.** Walk to 3 m from a hostile and orbit.

### P5 — Weapon materials are flat in shadow

**Problem.** Under the canopy the rifle is a near-black silhouette with little internal form.
**Cause.** Correct PBR behaviour (it *is* in shadow) but bad presentation — real games cheat this
with a dedicated view-model light.
**Priority.** Medium.
**Fix.** Add one low-intensity light on the `VIEWMODEL` layer only, keyed from the camera. It
costs one light and does not touch the world.
**Files.** `src/scene/Lighting.ts`, `src/core/Layers.ts`.
**Verify.** Compare the rifle under the canopy and in a floodlit pool; both should show form.

### P6 — Impact and explosion VFX not visually confirmed

**Problem.** Decals, sparks, casings and explosions are implemented and event-wired but I did not
capture a frame proving they look right.
**Priority.** Medium-high — these are explicitly required by the brief.
**Fix.** Fire at a container at 5 m and inspect; detonate a drum cluster and inspect.
**Files.** `src/effects/*`.

### P7 — No LOD and no occlusion culling

**Problem.** Merging per (zone, material) keeps draw calls low but defeats per-object frustum
culling; the whole zone draws if any part is visible.
**Priority.** Medium (it is a performance issue, see [PERFORMANCE.md](PERFORMANCE.md)).
**Fix.** Split the merge buckets by a coarse spatial grid rather than by authored zone.
**Files.** `src/environment/LevelBuilder.ts`.

### P8 — Emissive flicker has an accumulation bug

**Problem.** `Practicals.update()` reads `mat.userData.baseEmissive` *after* assigning
`emissiveIntensity`, so the baseline captures an already-modified value; flickering emissives can
drift toward zero over a long session.
**Priority.** Low-medium (only visible over minutes).
**Fix.** Capture the baseline when the fixture is created.
**Files.** `src/environment/Practicals.ts`.

---

## 3. Honest scoring

Self-assessment against a modern AAA military shooter. No reference material was supplied, so
this is judged from memory of the genre's standards, **not** from a side-by-side comparison.

| Criterion | /10 | Note |
| --- | --- | --- |
| Composition | 7 | Layout, sight lines and the framed opening work |
| Lighting | 6 | Motivated and readable; palette too narrow (P1) |
| Materials | 6 | Real roughness/metalness separation; texel density inconsistent up close |
| Environment density | 7 | Genuinely layered; nothing is a bare box |
| Sense of scale | 7 | Real container/crane/warehouse dimensions |
| Weapon presentation | 5.5 | Good silhouette and animation; flat in shadow (P5) |
| Effects | 5 | Systems are thorough but unproven on screen (P6) |
| Atmosphere | 7 | Height fog + aerial perspective carry it |
| Readability | 7 | IR strobes and the ambient floor do their job |
| Consistency | 6 | The view-model is noticeably higher-fidelity than the enemies |
| Motion quality | 6.5 | Movement and recoil have weight; enemy animation is crude |
| First impression | 6.5 | Reads as a real place; not yet as a real product |

**Overall: roughly 6.4/10 against the genre standard.** It is a credible vertical slice with
correct fundamentals and a defensible architecture. It is not mistakable for a shipped AAA title.

---

## 4. Limits I could not get past in this environment

Stated plainly rather than papered over:

1. **Frame rate could not be validated on target hardware.** The browser available here runs on a
   virtualised/software GPU and produced wildly inconsistent numbers (19→54 fps across
   near-identical configurations). The optimisations in
   [PERFORMANCE.md](PERFORMANCE.md) are justified by *relative* measurements and by draw-call and
   light counts, which are hardware-independent. **The 60 fps @ 1080p target is unproven.**

2. **The Performance preset measured slower than Cinematic here** despite a fifth of the pixels.
   I removed two plausible causes (odd-sized render targets, composite writing straight to the
   default framebuffer) and the inversion persisted, which points at the host GPU rather than the
   code. On real hardware the preset ordering should be normal, but I could not confirm it.

3. **Pointer lock is refused in this browser**, so the game had to be driven with synthetic
   events. Sustained play — enemy return fire, taking damage, dying, completing the mission — was
   not exercised end to end.

4. **No reference images were provided**, so no comparison was performed. Section 3 is a
   self-assessment from genre memory and is explicitly not a blind comparison.
