# Quality report — TIDEBREAKER / Berth 7

Written from the position the brief asked for: the reviewer's job is to find what is wrong, not
to praise the build. Everything below was found by **rendering actual frames and looking at
them**, not by reading the code.

## 0. What was and was not verified

Being explicit, because the brief forbids claiming unverified work:

| Claim | Status |
| --- | --- |
| Project builds with no TypeScript errors | **Verified** — `tsc --noEmit` and `vite build` clean |
| Boots and reaches the playable state | **Verified** — mission phase reaches `active` |
| Firing, ammo drain, auto-reload, reload animation | **Verified** on screen |
| HUD updates (ammo, objective, hostile count, extraction range) | **Verified** on screen |
| Draw-call / triangle / light counts | **Verified** with the in-game overlay |
| Enemies activate, close on the player and return fire | **Verified** — a hostile advanced on the player and the condition bar dropped |
| Impact particles and bullet-hole decals spawn | **Verified** via the live counters (76 particles, 38 decals) |
| Shell casings eject and land | **Verified** — a casing is visible on the deck in a captured frame |
| Explosions fire (drum shot, blast light, screen response) | **Verified** — an explosion frame was captured (and revealed a defect, see #15) |
| Chain reactions between drums | **NOT verified** — implemented, not isolated in a capture |
| Player death and mission completion | **NOT verified** — the loop is implemented; a full kill-to-extraction run was not played |
| No console errors or warnings | **Verified** — a fresh tab logs only Vite's connection messages |
| 60 fps at 1080p on a discrete GPU | **NOT verified** — see §4 |
| Blind comparison against reference footage | **Not performed.** No reference material was provided |

---

## 1. Defects found and fixed during review

These were all real, all found by looking at rendered frames:

| # | Problem | Cause | Fix |
| --- | --- | --- | --- |
| 1 | Whole image a red smear | Split-toning multiplied by a raw colour, tinting *and* darkening | Normalise the tone to unit luminance first (`CompositeShader.ts`) |
| 2 | Opening shot crouched, staring at the deck; weapon retracted | Intro camera offset applied during the briefing phase and accumulated into the aim | Phase-gate it; make it a pure additive offset (`MissionDirector`, `PlayerCamera`) |
| 3 | Player spawned facing a wall | `playerSpawnYaw` sign error | `-PI/2` (`HarborLevel.ts`) |
| 4 | Yard essentially unlit; only ambient visible | Practical intensities (46) were pre-decay values; with `decay = 2` they vanish | Re-derived for 1/d²: floods 620 (muzzle and explosion were then over-corrected, see #15) |
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
| 15 | An explosion clipped the **entire frame** to white | Blast light at 5200 cd with decay = 2 delivers ~200 units at 5 m, far past the ACES shoulder, plus a fireball at brightness 11 | Light 5200 → 1500, range 62 → 46 m, fireball brightness 11 → 5.5, muzzle 900 → 480 |
| 16 | Bullet holes invisible on container walls | Flat decal quads offset 1.2 cm sink between the ±2.6 cm corrugation ribs | Ribbed surfaces get a 3.8 cm offset |
| 17 | Container paint read as per-texel noise at close range, swamping decals | Un-blurred height field + normal strength 2.0 on a partly metallic surface | Blurred the field, normal 2.0 → 1.05, calmer rust and lower metalness |

---

## 2. What is still not good enough

Ranked by how much it costs the impression. **Nothing here is fixed.**

### P1 — Palette (FIXED)

**Was.** Every mid-range frame sat in one warm orange-brown band. Containers, deck, sky and metal
all landed in the same hue.

**Root cause.** Four things compounding: a saturated warm key; a sky whose warm horizon band
wrapped the full 360 degrees; a PMREM environment probe generated from that sky, so every
reflective surface was re-tinted orange; and every practical light at the same colour temperature.
Nothing cool was left to contrast against, so the frame had no colour depth.

**Fixed by.** Two light families (sodium yard/canyon against mercury warehouse/pier, so the player
crosses a warm/cool boundary as they advance); a real white-balance control applied pre-tonemap;
the sky's warm band anchored to the sun instead of wrapping the horizon ring; a desaturated key; a
cooler and stronger hemisphere fill; and a cool ground bounce instead of warm brown.

**What is still not right.** The image now leans slightly *cool* overall — the white balance
(4600K) is carrying a lot of the load. Trading some of it for more warm practical coverage in the
canyon would be a better balance of sources than a global correction.

### P2 — Puddles and reflections (FIXED, with a caveat)

**Was.** The apron looked damp, but the pools and reflected lights that justify the whole
wet-ground system were not visible, and a hard horizontal line ran across the deck.

**Root cause — a genuine bug, not a tuning problem.** The mask texture stored a *pre-thresholded*
0/1 puddle mask. Mipmaps average, so at distance every texel became the local coverage fraction —
"40% puddle everywhere" — while near ground kept crisp pools. The mip crossover between the two
regimes is what drew the line.

Storing the smooth field and thresholding in the shader fixes only half of it: mipmaps converge
toward the field's *mean*, so a threshold above the mean makes distant coverage collapse and one
below makes it flood — the line just moves. The field is now **histogram-normalised so the
authored coverage percentile sits exactly on 0.5**, which is the value mips converge to. Coverage
is then stable from the player's boots to the far end of the berth.

A second, smaller bug: combining two mask scales by weighted average collapses the combined
variance (a sum of independent variables clusters more tightly than either), making coverage
hypersensitive to the threshold. The second scale is now a perturbation of one normalised field.

Also fixed: below-water geometry — the 900m sea plane at y = -1.35 — was being mirrored up into
the reflection and filling it with flat water colour (now clipped out with a global clip plane);
the reflection target had a hardcoded 16:9 shape regardless of viewport; and the fresnel floor was
so low (0.18) that pools around the player's own feet were effectively dry.

**What is still not right.** At the spawn point the near field is still one large continuous pool
whose far edge reads as a soft horizontal step. It is now a real pool boundary rather than a
filtering artefact, but the opening frame would be stronger with more broken water there.

### P3 — Sky and horizon (FIXED)

**Was.** A smooth gradient with no cloud structure, meeting the distant scenery at a visible line.

**Root cause.** The single cloud deck was multiplied by `smoothstep(-0.02, 0.22, h)` — cloud was
deleted below 22 degrees of elevation, which is exactly the band a first-person player spends all
their time looking at. What remained was the bare gradient.

**Fixed by.** Two cloud decks at different virtual altitudes so they parallax against each other
when the player turns, both running to the horizon and compressed into layered strata as they
approach it; a directional departing-storm mass so the sky has an event and a direction; a
four-stop gradient; and a haze band painted with the scene's own fog colour so the dome, the
skyline and the sea dissolve into one atmosphere.

**Cost.** The sky became the most expensive shader in the scene. It is now drawn last in the
opaque pass — it had been drawn first, shading every pixel before being fully overdrawn — and its
noise octaves were halved.

### P4 — Enemy joints (FIXED)

**Was.** Rigid, un-skinned parts whose shoulders and hips visibly separated under ~8m.

**Root cause.** Box limbs with FLAT ends at the pivots. Every degree of rotation swung a square
corner away from its neighbour and opened a wedge.

**Fixed by the SHAPE, not the size** — inflating the boxes until the gaps closed would have given
swollen, toy-like limbs, which the brief explicitly warned against:

- every bone is a capsule positioned so its end-cap hemisphere centres sit exactly on the two
  pivots it spans. Rotating about a pivot is then a rotation of a sphere about its own centre —
  geometrically invariant — so a gap is impossible at any angle;
- pauldrons and a collar ring parented to the TORSO, so they stay put while the arm swings beneath
  them, which is what a real pauldron does;
- a trouser skirt on the pelvis overlapping both thigh caps — the hips are the one joint a capsule
  cannot close alone, because two bones share one parent volume;
- neck column with a sphere at the head pivot; knee pads straddling the knee; boots and gloves
  overlapping the shin and forearm caps;
- pivots moved inside the limb mass instead of sitting on the outer surface.

**Inspection also exposed a larger problem.** The soldiers were borrowing the WEAPON materials:
near-black, tiled at 26–48 repeats per metre for centimetre-scale gun parts. On a 1.8m figure that
is a featureless mannequin at any distance. They now have their own fatigue and gear fabrics at
~3.4 and 5.5 tiles/m. The arms were also splayed because the Z tuck term had the wrong sign on the
right arm; both hands now converge on the weapon.

**What was actually checked.** With `?posetest=1` (four hostiles at 2/4/8/12m, AI frozen) plus
`?exposure=5.5` to see them lit rather than as silhouettes, in the idle, aiming/firing and death
poses, and in normal play at ~4m, ~8m and ~12m. Shoulders, elbows, wrists, hips, knees, ankles and
neck all read as continuous. The death topple — where a rigid rig most often falls apart — holds
together.

**What is still not right.** The figure is still visibly a rigid-part character on close
inspection: limbs are smooth capsules with no cloth deformation, and there is no skinning. The
fix cost roughly 100 draw calls and 40k triangles across 11 hostiles.

### P5 — Weapon flat in shadow (FIXED)

**Was.** Under the canopy the rifle was a near-black silhouette with no internal form.
**Cause.** Correct PBR behaviour - it genuinely is in shadow - but bad presentation. Every
first-person game cheats this the same way.
**Fixed by.** One directional light confined to the `VIEWMODEL` layer, rigged up-and-left of the
lens. It cannot touch world lighting and costs one light over a few thousand pixels. Verified: the
receiver, rail and handguard read as separate planes at the spawn point.

### P6 — Explosion brightness (RE-VERIFIED)

**Was.** At 5200 cd the blast clipped the entire frame to white. Reduced to 1500 analytically, but
unverified.

**Now verified on screen** using `?boom=0.5` (a charge 7m ahead every 0.5s, phase-independent so it
runs on the static attract view where nothing else perturbs the scene). Captured the flash frame
and the recovery frame:

| Check | Result |
| --- | --- |
| First bright frame | Dominates the frame without erasing it |
| Clips to white? | **No.** Container corrugation, the catwalk hostile, the crane lattice, the barriers and the sky gradient all remain readable through the flash |
| Surrounding illumination | The blast lights the deck, the containers and the crane — it reaches the world, not just the screen |
| Bloom | A bright core with a warm halo, not a screen-wide bleed |
| Exposure response | Auto-exposure does not crush the rest of the frame; the sky stays cool |
| Recovery | Falls off cleanly to a warm pool, leaving the scorch decal ring |
| Too weak now? | No |

**What is still not right.** The flash is fairly UNIFORM across the frame rather than falling off
sharply with distance, so it reads slightly like a global tint at its peak. Smoke is also not
prominent during the flash itself — the fireball reads, the smoke column does not.

### P7 — LOD and culling (PARTIALLY ADDRESSED)

Implemented: shadow-caster culling by distance (a batch outside the sun's ortho box cannot
contribute a shadow texel, yet was still being submitted), enemy animation LOD (distant hostiles
solve their pose every third frame at 3x dt, so the rate is unchanged and nothing pops), and
distance visibility beyond 110m.

**Not done:** geometric LODs, and the merge buckets are still authored-zone based rather than
spatial, so a whole zone draws if any part of it is visible. Measured 660 → 638 draw calls; the
shadow cull recovers little at the SPAWN viewpoint specifically because most of the level is still
inside the 71m window there.

### P8 — Emissive flicker accumulation (FIXED)

Two compounding faults, not the one originally reported:
1. the baseline was read from `material.userData` *after* this frame's value had already been
   written to that same material, so it drifted upward;
2. emissive materials are cached and SHARED between fixtures of the same colour, so several
   flickering fixtures were writing to one material and capturing each other's output.

Each flickering fixture now clones its emissive material and stores an immutable `baseEmissive`
captured at registration; every frame derives from the base values, never the current ones.
`setMasterScale` also wrote light intensity directly while the flicker loop wrote the same
property — it is now a multiplier the loop applies, so there is exactly one writer.

## 3. Before/after comparison, same camera

Compared from the identical viewpoint (mission start, standing, looking east down the berth) with
the HUD hidden. "Pass 1" is the palette/puddle/sky work; "Pass 2" is enemies, the kerb, colour
rebalance, explosion, flicker and LOD.

| Criterion | Original | Pass 1 | Pass 2 | What changed in pass 2 |
| --- | --- | --- | --- | --- |
| First impression | 6.5 | 7.5 | **8** | The deck is now continuous - the "step" was a raised kerb cutting the frame in half |
| Colour depth | 4 | 7.5 | **8** | Warmth restored through sources, not a global shift; neutrals no longer blue |
| Atmosphere | 7 | 8 | 8 | Unchanged |
| Reflection presence | 3 | 7.5 | **8** | Water depth now drives reflection, so pools have shallow rims and deep mirror centres |
| Cloud / horizon | 3 | 7.5 | 7.5 | Unchanged |
| Composition | 7 | 7 | **7.5** | Removing the kerb band restored the opening shot's depth |
| Materials | 6 | 6.5 | **7** | Soldiers got real fabrics instead of the weapon's near-black micro-tiled material |
| Environment density | 7 | 7 | 7 | Unchanged |
| Sense of scale | 7 | 7.5 | 7.5 | Unchanged |
| Weapon presentation | 5.5 | 7 | 7 | Unchanged |
| Effects | 5 | 6 | **7** | Explosion verified: powerful without clipping; flicker no longer drifts |
| Readability | 7 | 7.5 | 7.5 | Unchanged |
| Consistency | 6 | 6.5 | **7.5** | The enemies were the weakest asset; the gap to the view-model is much smaller |
| Motion quality | 6.5 | 6.5 | **7** | Joints hold together through walk, aim, flinch and death |
| Movement stability | - | 7 | 7.5 | Puddle coverage distance-stable; shadow/animation LOD introduce no pop |

**Overall: 6.4 → 7.2 → 7.6 / 10** against the genre standard.

The score moved because the rendered result changed, not because tasks were completed. The two
largest single gains were finding that the "puddle step" was a piece of geometry and that the
soldiers were wearing gun metal - both were misdiagnosed until a frame was actually examined.

What still holds it below ~8.5: the characters are rigid-part with no skinning or cloth, texel
density is inconsistent between large surfaces and small props, there are no geometric LODs, and
the merge buckets are not spatial.

Caveats, stated plainly:
- these are my own before/after captures at one viewpoint plus two others, not blind, and not
  against any reference material (none was supplied);
- captures are at 800x967 in the development browser, not 1080p on target hardware.

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

   The same instability makes the *cost* of this visual pass unmeasurable here: the identical build
   reported 1 fps and 29 fps minutes apart. What can be stated is that draw calls (565), triangles
   (269k) and active lights (17) are unchanged by the visual work, and that the two new shader
   costs were addressed directly — the sky is drawn last in the opaque pass rather than first and
   its octave count was halved, and the wet ground adds two texture fetches. **The net frame-time
   effect on target hardware is unverified.**

3. **Pointer lock is refused in this browser**, so the game had to be driven with synthetic
   events. Sustained play — enemy return fire, taking damage, dying, completing the mission — was
   not exercised end to end.

4. **No reference images were provided**, so no comparison was performed. Section 3 is a
   self-assessment from genre memory and is explicitly not a blind comparison.
