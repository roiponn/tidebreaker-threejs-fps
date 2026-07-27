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

### P4 — Enemies are crude at close range

**Problem.** Rigid, un-skinned parts; at under ~8 m the shoulder and hip joints visibly separate.
**Cause.** Deliberate — the brief asked for minimal enemies — but it becomes the weakest asset on
screen when one is close.
**Priority.** Medium.
**Fix.** Either skinned meshes with a simple 12-bone rig, or keep rigid parts and cover the joints
with overlapping gear (shoulder pads already do this; hips and knees do not).
**Files.** `src/enemies/EnemySoldier.ts`.
**Verify.** Walk to 3 m from a hostile and orbit.

### P5 — Weapon flat in shadow (FIXED)

**Was.** Under the canopy the rifle was a near-black silhouette with no internal form.
**Cause.** Correct PBR behaviour — it genuinely is in shadow — but bad presentation. Every
first-person game cheats this the same way.
**Fixed by.** One directional light confined to the `VIEWMODEL` layer, rigged up-and-left of the
lens. It cannot touch world lighting and costs one light over a few thousand pixels. Verified: the
receiver, rail and handguard now read as separate planes at the spawn point.

### P6 — Explosion readability, after the over-brightness fix

**Problem.** The blast light was reduced from 5200 to 1500 cd after a captured frame showed it
clipping the whole screen to white, but the corrected value has **not** been re-verified in a
capture. It may now be under-powered.
**Cause.** Tuned analytically (1/d² against the ACES shoulder), not visually.
**Priority.** Medium-high.
**Fix.** Detonate the canyon drum pair and the four-drum fuel dump and check both: the blast should
dominate the frame without erasing it, and the chain reaction should stagger visibly.
**Files.** `src/config/visual.ts` (`explosion.*`), `src/effects/VfxManager.ts` (`SPEC.fireball`).
**Verify.** The frame stays readable; the silhouette of nearby cover survives the flash.

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

## 3. Before/after comparison, same camera

Compared from the identical viewpoint (mission start, standing, looking east down the berth) with
the HUD hidden, before and after the P1/P2/P3 work.

| Criterion | Before | After | What actually changed |
| --- | --- | --- | --- |
| First impression | 6.5 | **7.5** | The frame now has a subject (warm lit yard) inside a cool frame, instead of one orange wash |
| Colour depth | 4 | **7.5** | Two light families + white balance + cool fill. Warm and cool now sit against each other in depth |
| Atmosphere | 7 | **8** | Haze band ties dome, skyline and sea together; the join is gone |
| Reflection presence | 3 | **7.5** | Pools are legible, mirror the containers and the sodium lamps, and distort with the ripples |
| Cloud / horizon naturalness | 3 | **7.5** | Two parallaxing decks, layered strata into the horizon, a directional storm mass |
| Composition | 7 | 7 | Unchanged — the layout was never the problem |
| Materials | 6 | **6.5** | Cooler ambient separates metal from concrete better; texel density unchanged |
| Environment density | 7 | 7 | Unchanged |
| Sense of scale | 7 | **7.5** | The cloud decks and haze band add a legible distance ladder |
| Weapon presentation | 5.5 | **7** | The view-model light restores form in shadow (P5) |
| Effects | 5 | **6** | Verified on screen this pass: impacts, decals, casings, explosions |
| Readability | 7 | **7.5** | Cool ambient reads shadow detail better than the old brown |
| Consistency | 6 | **6.5** | The view-model is still noticeably ahead of the enemies |
| Motion quality | 6.5 | 6.5 | Unchanged |
| Movement stability | — | **7** | Puddle coverage is now distance-stable, so the deck no longer changes character as the player walks |

**Overall: 6.4 → 7.2 / 10 against the genre standard.**

The score moved because the image measurably changed, not to record effort. Three of the four
largest complaints — no colour depth, no reflection presence, no sky structure — are resolved and
visible in a still frame. What holds it below ~8 is unchanged: the enemies are crude close up, the
texel density is inconsistent, and there is no LOD or occlusion strategy.

Caveats on this comparison, stated plainly:
- it was done by me from before/after captures at one viewpoint, not blind, and not against any
  reference material (none was provided);
- the captures are at 800x967 in the development browser, not at 1080p on target hardware.

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
