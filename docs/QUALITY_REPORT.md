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
| Explosions fire (drum shot, blast light, screen response) | **Verified** — explosion frames captured at three points on the light curve (see P10) |
| Explosion light falls off with distance; sky not brightened | **Verified** — `?boomhold=` captures at life 0.08 / 0.30 / 0.75 |
| Repeated explosions do not accumulate lights, particles or emissive state | **Verified** — 10 consecutive detonations sampled; lights 17→18→17, particles peak ~90 and drain to 0, blast light resets to 0 |
| Enemy secondary motion (torso twist, pelvis, lean, recoil, hit reactions) | **Implemented and inspected in still frames at 2/4/8/15/30 m.** *Motion* was sampled at roughly 4 fps in this browser, not watched at frame rate — see §4.6 |
| Pass-3 frames from three gameplay camera positions | **NOT done** — the briefing phase would not advance in this browser, so all pass-3 frames are from spawn. See §4.3 |
| Clean production build, fresh session, no console errors | **Verified** — `vite build` clean, chain test re-run on the built bundle, console shows only Vite messages |
| Draw-call / triangle / light cost of the enemy motion work | **Verified** — 638 / 301,643 / 17 identical before and after, same viewpoint |
| Chain reactions between drums | **Verified** — deterministic harness, 5 runs across two clusters, dev and production builds (see P9) |
| Player death and the mission-failed card | **Verified** — died at 0:33 under fire from the new bay-mouth pair; the K.I.A. card showed correct stats |
| Mission completion (reaching extraction) | **NOT verified** |
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
fix cost roughly 100 draw calls and 40k triangles across the 11 hostiles the level had at the
time (now 9 - see the encounter note below).

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

### P9 — Drum chain reactions (VERIFIED, and the propagation rule changed)

Previously "implemented, not isolated in a capture". A chain is a ~2 second event that fires once
per playthrough and can only be started by hitting a 0.6 m target with a bullet — and several of
the properties that matter (single-trigger protection, termination, out-of-range survival, pool
recycling across repeats) are invisible on screen even when you do catch it.

So it is now driven and read from the simulation rather than from the picture:
[`src/debug/ChainTest.ts`](../src/debug/ChainTest.ts), reached with `?chaintest=N`
(`&chainseed=I` picks the drum). Each run records pre-state, triggers exactly one drum, immediately
re-triggers it, lets the chain settle, re-triggers the destroyed drum, then records the propagation
trace, final states and pool occupancy — and repeats. Results land on
`document.body.dataset.chain` as JSON, because a scripted console runs in an isolated world and
cannot read module state.

**Propagation was also made honest.** A detonating drum used to set its neighbours to `venting`
directly. It now deals blast **damage** with the same quadratic falloff as everything else, and the
neighbour lights its own fuse only if that pushes it below zero health — so propagation obeys the
same distance and threshold rules as gunfire, and a drum near the edge of the radius survives.
Fuse length now scales with distance, so closer drums cook off sooner.

Measured, 3 runs on the 4-drum fuel dump plus 2 runs on the 2-drum pair, repeated on the production
build:

```
1: iiiiii->iigggg [2@1.50:manual | 2@2.30:BLEW | 3@2.30:by2d0.7 | 4@2.30:by2d0.7
                 | 5@2.30:by2d1.4 | 4@2.56:BLEW | 3@2.60:BLEW | 5@2.60:BLEW] ex=4 p=0 L=0
2: ... 5@9.20:BLEW | 3@9.28:BLEW | 4@9.31:BLEW ... ex=4 p=0 L=0
3: ... 3@16.13:BLEW | 4@16.16:BLEW | 5@16.16:BLEW ... ex=4 p=0 L=0
seed 0: iiiiii->ggiiii [0@1.50:manual | 0@2.28:BLEW | 1@2.28:by0d0.8 | 1@2.58:BLEW] ex=2
```

| Property | Result |
| --- | --- |
| Propagation by distance and damage | Drums at 0.7/0.7/1.4 m all took lethal blast damage and lit |
| Out-of-range drums unaffected | Drums 0 and 1 (14 m away) stayed `intact` in every fuel-dump run; drums 2–5 stayed intact in every pair run |
| Timing stagger | Secondary detonations landed 0.18–0.30 s after the primary, in a **different order each run** |
| Duplicate-trigger protection | Re-triggering a burning drum returned `false` in 5/5 runs |
| Destroyed drums inert | Re-triggering a `gone` drum returned `false` in 5/5 runs |
| Out-of-range index | `debugTrigger(999)` returned `false` in 5/5 runs |
| Termination | Exactly 4 explosions for 4 drums (2 for 2). No drum blew twice; no infinite chain |
| Pool / light cleanup | `restParticles = 0`, `restLights = 0` after every run |
| Repeat consistency | Identical outcome across runs and between dev and production builds |
| Particles, sound, light flash, decals, impulses | All ride the same `explosion` bus event as a single detonation, so they are triggered per drum by construction |

Not covered: player or enemy damage *from a chain specifically* (blast damage is shared code and is
verified for single detonations), and the chain has only one hop in this level — no drum sits in the
partial-damage band where it would survive one blast and die to the next, so the threshold rule is
verified by the survivors rather than by a two-stage cascade.

### P10 — Explosion light falloff and local illumination (FIXED)

The blast used to be a constant-radius, constant-colour point light, which lights everything in the
level by the same proportion — the reason it read as a screen tint rather than as something
happening at a place. Three things now change together over its life
([`VfxManager.updateExplosionLight`](../src/effects/VfxManager.ts)):

| | Behaviour |
| --- | --- |
| Intensity | ~25 ms attack, then `exp(-5.2·life)` decay |
| Radius | 34% of full at ignition, expanding to 100% as it decays |
| Colour | `#fff0cc` hot core → `#ff4a12` ember, on `pow(life, 0.6)` |

The radius is the part that actually produces the near/far contrast. three windows a point light's
falloff toward its `distance`, so a *small* radius means distant geometry receives almost nothing
while nearby surfaces are hammered.

The emitter was also lifted from 0.6 m to 1.45 m above the charge. At 0.6 m the `1/d²` singularity
sits almost on the ground plane, so the few square metres underneath clip to white and all the
falloff happens *inside* the blown-out region where it cannot be seen. Peak intensity came down
2400 → 430 cd accordingly.

Smoke now catches the flash ([`ParticleShader.ts`](../src/shaders/ParticleShader.ts)) with the same
`1/d²` term and the spherical billboard normal — weighted by particle *youth*, because only compact
young smoke is dense enough to scatter that much light.

Verified with `?boomhold=L`, which pins the light at a chosen point on its curve so each moment can
be captured instead of chased across a sub-second window:

| life | Measured | Frame |
| --- | --- | --- |
| 0.08 (peak) | 284 cd / 15.7 m | Near ground brightly lit with pebble texture still readable; hostile at 8 m fully lit near-white; hostile at 15 m dimmer; containers at 30 m barely affected; **sky unchanged** |
| 0.30 | 90 cd / 21.5 m | Warm pool with a clear falloff gradient; far end of the canyon dark |
| 0.75 (ember) | 9 cd / 33.4 m | Faint warm wash on the near deck only |

**Occlusion was deliberately not implemented.** A cube shadow map for a 0.6 s light would change
the renderer's shadow-caster count on every detonation, which forces a material recompile and a
guaranteed hitch — precisely the "highly expensive solution that destabilises the frame" to avoid.
The reduced radius mitigates it in practice: the light now rarely reaches far enough to be seen
past an occluder. Light does still bleed through thin geometry near the blast.

### P11 — The full-frame red wash was the damage vignette, not the explosion (FIXED)

Worth recording because I chased it in the wrong place twice. Every explosion near the player
washed the entire frame — sky included — with a flat red, which looked exactly like a blown-out
blast light. It was neither the light nor the smoke nor bloom: `uDamageFlash` in the composite was
added as `uDamageColor · flash · (0.35 + radial)`, and that **0.35 constant** applied the same red
to every pixel in the image.

Three faults, all fixed:
1. the term is now a true vignette (`pow(r, 2.6)·1.7 + 0.03`), zero in the centre, strong at the
   corners;
2. the blast pulse was a fixed 0.9 regardless of damage taken — a 0.4-damage graze at the edge of
   the radius produced the same full-strength red as a lethal hit. It is now proportional;
3. the explosion handler pulsed the screen *and* called `player.damage()`, which emits
   `player:damaged`, which pulsed it again — 0.9 + 0.5, clamped at the 1.4 maximum. The duplicate
   is gone.

Two changes made while the diagnosis was still wrong were kept on their own merits, and are stated
as such rather than as fixes for this bug:

- **Bloom is now local.** The 6-level upsample chain added every mip at full weight, so a large
  bright area could reach the 1/128-resolution mip and tint the whole frame. Per-level weights
  (effective `1.00 / 0.92 / 0.75 / 0.53 / 0.29`) leave the near-source glow untouched and damp the
  frame-wide mip. Strength raised 0.42 → 0.48 to compensate. This does not fix P11 but it is the
  right behaviour and it is what "local bloom near the blast" requires.
- **Smoke opacity is now tied to expansion.** Alpha fell as `(1-t)^1.6` while the sprite grew 4×,
  which manufactures smoke out of nothing. Now `(1-t)^2.4` with a smaller growth curve.

### P13 — The view-model was mis-framed and window-shape dependent (FIXED)

Reported from a player recording: the rifle appeared rotated, sprawled across the frame, and moved
around wildly. Two compounding causes, and the reason **I did not catch it myself** is the second
one.

1. **The root sat 11.5 cm in front of the eye but 13.2 cm to the right.** Screen position is an
   *angle*, and the angle to a point beside the camera depends entirely on how far forward it is.
   At that z the pistol grip was **49° off the view axis** while the muzzle was at 13° — so the
   rifle fanned diagonally across the frame instead of receding into it. It also meant the rifle,
   0.29 m tall, sat 0.38 m from the eye and subtended more than the entire frame height.

2. **The view-model camera was locked to a VERTICAL field of view.** three's `fov` is vertical, so
   horizontal coverage changes with the window shape. Every frame I captured during development was
   in a *portrait* browser pane (673×814), whose narrow horizontal frustum cropped the near end of
   the weapon away entirely — I was looking at a sliver of it and reading that as the whole. At the
   player's 16:9 window the same rifle was fully visible and obviously wrong.

Fixes:

- `PlayerCamera.applyWeaponFov()` derives the view-model camera's vertical FOV from a **horizontal**
  target each time the aspect or ADS blend changes, so the weapon occupies the same fraction of the
  screen *width* at any window shape. `weaponFov` / `weaponFovAds` are now horizontal degrees
  (90 / 65). Capped at 76° vertical so a very tall window cannot produce a fisheye view-model.
- `HIP_POSITION` moved to (0.196, −0.178, −0.500): grip ~21° off axis, muzzle ~12°, rifle height
  about half the frame. `SPRINT_POSITION` and `RETRACT_POSITION` scaled to match, `ADS_POSITION`
  pushed to z −0.30 (its y must stay −0.1005 to keep the optic on the screen centre).
- `HIP_ROTATION` yaw raised to 0.15 rad so the stock — which is no longer hidden behind the near
  plane — swings out through the bottom-right corner rather than lying across the frame.

**Method note.** Every capture in this pass and the two before it was taken in a portrait pane. That
is why the defect survived three review passes that all claimed to have "looked at actual frames".
Looking at a frame is not enough if the frame is the wrong shape.

Not verified: ADS and firing poses. The briefing phase will not advance in this browser, so the
weapon could only be inspected in its hip pose. The ADS alignment is correct by construction (the
optic's sight point lands on the view axis) but has not been seen.

### P14 — The weapon swung through most of a right angle in play (FIXED)

Reported from a second player recording. The static hip pose from P13 was correct; what moved was
the pose blending on top of it. Three layers rotated the weapon, and one of them had been made much
worse by P13 itself:

| Layer | Was | Now |
| --- | --- | --- |
| Wall retract | 50° yaw, probe 1.35 m | 13° yaw, probe 1.05 m |
| Sprint | 38° yaw, 17° pitch, −21° roll | 15° / 8° / −7° |
| Look sway | ±5.9° yaw and pitch, ±3.8° roll | ±3° / ±3° / ±1.9° |
| Reload body swing | 9° / 15° / −17° | 6° / 9° / −10° |

The wall retract was the main offender. The probe is a ray from the eye along the aim, and P13 moved
the muzzle from 0.56 m to 0.96 m in front of the camera — so a 1.35 m probe now fired constantly:
at containers in a canyon barely wider than that, at the deck whenever the player looked down while
walking, and at any enemy inside the probe range. The pose was partially blended in almost all the
time, so the rifle was being swung through most of a right angle and back as a matter of course.

`?weaponpose=hip|ads|sprint|retract` was added to pin each blend, because these poses only occur
transiently in play and that is exactly how their magnitudes went unchecked for three passes.
`weaponpose=ads` drives the real `adsBlend`, not just the pose, so the FOV, reticle brightness and
sway suppression are all faithful — pinning only the pose would show a state nobody ever sees.

### P15 — The optic was a closed box (FIXED)

Found immediately by the new ADS pin, and it had been there since the weapon was built. The sight's
hood was two solid 48×52 mm plates, so aiming down the sight put an opaque block over the centre of
the screen: neither the glass nor the emissive reticle behind it could be seen. **ADS was
unusable.** The plates are now four thin bars each, leaving a 32×36 mm aperture, and they use the
matte polymer material rather than bare metal — a metal frame threw a specular highlight straight
into the middle of the sight picture.

`ADS_POSITION.z` also had to go back to −0.16. P13 had pushed it to −0.30, which put the butt pad
(stock +0.302 behind the grip) level with the eye; at ADS the weapon is centred, so that read as a
slab across the bottom half of the screen instead of something tucked into a corner.

Cost: +8 boxes, merged into the existing view-model batches. Draw calls unchanged.

**Still open:** the emissive reticle is not clearly visible through the aperture in the captures.
The sight picture is usable — a hostile at 15 m is plainly visible through it — but the red dot does
not read. Not chased further; it is a small, self-contained follow-up.

### Encounter rebalance (player request)

The garrison was 11 and weighted toward the far end - 6 of the 11 were in the yard alone - so the
fight got denser exactly as the player ran low on the ammunition to handle it, while the first two
thirds of the walk was quiet. Now 9:

| Zone | Was | Now |
| --- | --- | --- |
| Bay mouth | 0 | **2** (new; first contact before the opening shot is over) |
| Canyon | 3 | 2 |
| Yard | 6 (4 ground + 2 catwalk) | 3 (2 ground + 1 catwalk) |
| Pier head | 2 | 2 |

The catwalk hostile is kept so the "look up mid-fight" beat survives, and both pier-head hostiles
are kept so the finale still has a shape.

`MISSION_CONFIG.totalHostiles` was deleted while doing this. It was a second source of truth for a
number the level already owns, and it had silently gone stale - the HUD read "HOSTILES 09 / 11"
straight after the change. The counter and the end card now both read `EnemyManager.totalCount`.

**Verified in play:** the HUD reads 09 / 09, both new hostiles stand clear of geometry in the open
lane ~13 m from spawn and are visible in the opening shot, and they engage. This run also produced
the **first genuine confirmation of player death and the mission-failed flow** - the K.I.A. card
appeared with TIME 0:33 and HOSTILES DOWN 0 / 9, correctly derived. Mission *completion* is still
unverified.

### Combat feel pass (player request)

Five changes, all requested after playing:

1. **The opening three no longer stand together.** They held one spot at the bay mouth, which read
   as a firing squad and left both sides of the lane unwatched. Now one holds each way east - north
   side, south side behind the jersey barriers, and one deeper at the jog where the lane narrows -
   spread in depth so they are met one at a time.

2. **Hostiles engage on sight.** Activation was purely `playerEye.x >= activationX`, so a soldier
   the player had walked into full view of would stand inert until an invisible line was crossed.
   Line of sight now wakes one as well, wherever the player is.

3. **Repositioning is much smaller.** `strafeSpeed` 2.4 → 1.15 m/s, `strafeInterval` 2.1 → 3.2 s,
   and every `patrolTo` pulled to about a metre from `home` (the catwalk hostile keeps its long lane
   - it is the only one whose movement the player is meant to track). These are holding positions,
   not patrols.

4. **Hostiles reload, visibly.** They had no magazine at all: a 4-round burst then a 1.25 s pause
   that from the player's side is indistinguishable from losing interest. Now 12 rounds, then a
   2.1 s reload during which the soldier holds position, the weapon comes off the shoulder, the
   support hand drops to the magazine well and returns, and the head glances down at the work.
   Player reload time halved, 2.35 s → 1.18 s.

5. **The metallic tick after every shot is gone.** `playWeaponFire` had a fourth layer - a 3.4 kHz
   bandpassed noise burst 12 ms behind the shot, meant to read as the action cycling. At 720 rpm it
   was a continuous rattle rather than a mechanism. The impact ring on metal was also part of it:
   every container in the level is `thinMetal` and the ring ran 2.2x the impact duration at near
   full level, so consecutive hits stacked into a drone. Kept but cut to a tick (0.7x duration,
   ~third of the level) so the player can still hear what they hit.

**Verified in play** with `?enemytrace=1`, which mirrors each hostile's state and magazine. The full
cycle was observed twice on both opening hostiles:

```
f1 → r0 → r0 → a12 → f12 → f11 … f1 → r0 → r0 → f12
```

- reload enters at zero rounds, holds, refills to 12, and firing resumes — it does not soft-lock;
- both hostiles cycle independently rather than in lockstep;
- all four states are reached, including engagement from the attract view before any activation line
  is crossed, which is change 2 working.

The reload *pose* was inspected at 2 m with `?posetest=reload`. It reads as intended for a rigid rig;
it is not a hand-animated magazine change and there is no magazine prop that actually leaves the
weapon.

### P16 — The view-model responded to window resizes differently from the world (FIXED)

Third report of the weapon rotating in play. This time it was instrumented rather than guessed at:
`?weapontrace=1` mirrors the composed view-model transform, the camera FOV and aspect, and every
contributing layer onto `document.body.dataset.weapon` each frame.

**What the measurements ruled out.** Playing the mission with the trace running:

| Layer | Measured peak |
| --- | --- |
| Look sway | 0.0° — a single 337 px mouse flick moves it ~0.2°, because the target only holds for one frame |
| Wall retract | 1.6° |
| Sprint | 0° (never engaged in the runs) |
| Recoil | 8.8° |
| Reload swing | 9.7° |
| **Composed total** | **17.2° peak, base 8.6°** |

And critically: the composed transform in the briefing view and in active play is **bit-identical** —
`pos 0.196,-0.178,-0.500 | rot 3.0,8.6,1.5`. The weapon was not moving.

**What was actually different was the projection.** The same trace showed `cam fov 65.2 asp 1.565`
in one capture and `cam fov 76.0 asp 0.827` in another. P13 had locked the view-model camera to a
*horizontal* FOV while the world camera uses a *vertical* one — so the two respond to a change in
window shape differently. Any mid-session resize (a window drag, entering or leaving fullscreen, a
browser chrome bar appearing when pointer lock engages) changes the view-model's FOV but not the
world's, and the weapon swings relative to the scene. That is the "starts rotating" symptom, and it
starts at exactly the moment the window changes — which for a browser game is usually the moment
play begins.

The horizontal lock was my own fix for P13 and it was the wrong shape of solution: it solved the
static framing and introduced a dynamic failure. The view-model camera now uses a fixed vertical FOV
exactly like the world camera (58° hip / 40° ADS), so a wider window shows more world *and* more
weapon and their relationship never changes. Verified: `fov 58.0` at aspect 1.565 and at 2.243, with
the world and weapon scaling together. Under the previous build the same change would have moved it
65.2° → 51.2°.

Two further hardenings, since the request was that the weapon stay put:

- **Every additive layer is now clamped** to ±3.4° and ±2.2 cm per axis *in sum*. Individually each
  layer was modest, but four independent systems peaking together is not something tuning can
  guarantee. On an object 50 cm from the eye a couple of centimetres of translation changes the
  projected angle of the barrel more than the same number of degrees of rotation does, so the
  position is bounded as well as the rotation.
- The reload body swing dropped again (9.7° → ~5°).

**Honest limitation:** I could not open either of the last two recordings — macOS blocks the
screen-capture temp directory (`Operation not permitted`), so this was diagnosed from
instrumentation of my own session, not from watching the reported failure. The mechanism found does
produce the reported symptom, but I have not confirmed it is the one the player saw.

### P12 — Enemy rigid-part appearance (IMPROVED, not eliminated)

See §5.

## 3. Before/after comparison, same camera

Compared from the identical viewpoint (mission start, standing, looking east down the berth) with
the HUD hidden. "Pass 1" is the palette/puddle/sky work; "Pass 2" is enemies, the kerb, colour
rebalance, explosion, flicker and LOD.

"Pass 3" is enemy secondary motion, explosion light falloff, the damage-vignette fix and the
chain-reaction verification.

| Criterion | Original | Pass 1 | Pass 2 | Pass 3 | What changed in pass 3 |
| --- | --- | --- | --- | --- | --- |
| First impression | 6.5 | 7.5 | 8 | 8 | Unchanged |
| Colour depth | 4 | 7.5 | 8 | 8 | Unchanged |
| Atmosphere | 7 | 8 | 8 | 8 | Unchanged |
| Reflection presence | 3 | 7.5 | 8 | 8 | Unchanged |
| Cloud / horizon | 3 | 7.5 | 7.5 | 7.5 | Unchanged |
| Composition | 7 | 7 | 7.5 | 7.5 | Unchanged |
| Materials | 6 | 6.5 | 7 | 7 | Unchanged |
| Environment density | 7 | 7 | 7 | 7 | Unchanged |
| Sense of scale | 7 | 7.5 | 7.5 | 7.5 | Unchanged |
| Weapon presentation | 5.5 | 7 | 7 | **7.5** | The view-model was mis-framed at any normal window shape; see P13. Not scored higher because ADS and firing poses are still unseen |
| Effects | 5 | 6 | 7 | **7.5** | The blast now falls off with distance instead of tinting the frame; the flat red damage wash is gone |
| Readability | 7 | 7.5 | 7.5 | **8** | Removing the constant term from the damage vignette recovered the whole image during combat |
| Consistency | 6 | 6.5 | 7.5 | 7.5 | Unchanged |
| Motion quality | 6.5 | 6.5 | 7 | **7.5** | Hips lag the aim, the torso twists, the pelvis carries weight, recoil travels through the body. Scored conservatively: see §4.6 |
| Movement stability | - | 7 | 7.5 | 7.5 | Unchanged |

**Overall: 6.4 → 7.2 → 7.6 → 7.7 / 10** against the genre standard.

The score moved because the rendered result changed, not because tasks were completed. Pass 3 moves
it very little, and that is the honest number: two of its three items (chain reactions, explosion
falloff) are correctness rather than beauty, and the third — enemy motion — cannot be scored from
stills, so it is scored conservatively.

The recurring lesson across all three passes is the same one: **every large visual defect in this
project turned out to be a different thing from what it looked like.** The "puddle step" was a
kerb. The featureless soldiers were wearing gun metal. And the explosion that appeared to blow out
the whole frame was a damage vignette with a constant term in it. In each case the value-tweaking
hypothesis was wrong and only looking at an actual frame, then bisecting, found the cause.

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

   In this pass the briefing phase would not advance at all: neither a synthetic click nor a real
   one moved `data-phase` off `briefing`, so the player never moved. **Every frame in this pass was
   therefore captured from the spawn position**, varying only what happens in front of it (the
   pose-test subjects, the blast, the light's life fraction) and the small displacement of camera
   shake. I am *not* claiming three gameplay-relevant camera positions for pass 3 — I could not
   reach them. The pass-2 captures from other positions remain valid but are not evidence for these
   changes.

4. **No reference images were provided**, so no comparison was performed. Section 3 is a
   self-assessment from genre memory and is explicitly not a blind comparison.

5. **The browser throttles this page to roughly 4 fps whenever it is being scripted**, and reports
   `document.hidden === true` at the same time. Simulation time therefore advances at about a fifth
   of wall-clock during any automated capture. Everything time-sensitive had to be given a
   deterministic hook rather than being caught by hand — which is why `?boomhold=`, `?chaintest=`
   and the `document.body.dataset` mirrors exist at all.

6. **Enemy motion was inspected, not watched.** Poses were captured at 2/4/8/15/30 m across idle,
   walking, running, aiming, firing, hit reaction and death, and consecutive frames differ in the
   ways the new system predicts (limb phase, torso yaw relative to hips, arm swing gated by aim).
   But at ~4 fps that is a sparse sample of the animation, not a viewing of it. **I have not
   watched these soldiers move at frame rate, and I am not claiming the result reads correctly in
   motion on target hardware.** That is the single biggest open question in this pass.

## 5. The remaining enemy limitation, stated plainly

The soldiers are rigid capsules parented into a hierarchy. Pass 2 closed the joint *gaps*
geometrically (end-cap hemisphere centres sit exactly on the pivots, so rotation cannot open a
seam). Pass 3 attacked the other half of the problem — that a rigid-part character reads as a
puppet when every part moves as one block — without adding a single mesh:

| Layer | What it does |
| --- | --- |
| Decoupled yaw chain | Hips lag the aim (and only break past a 0.55 rad threshold), torso twists to make up the difference, head leads. `facing` is now purely the aim direction and no longer snaps the body |
| Displacement-driven stride | Gait phase advances from *measured* ground displacement, so foot speed matches ground speed and sliding is bounded by frame rate rather than by a guessed constant |
| Pelvis | Vertical bob, lateral weight shift, drop on the unloaded side, and yaw opposed by the torso |
| Acceleration lean | Critically damped pitch/roll springs driven by change in ground speed |
| Recoil chain | A per-shot impulse with random variation travels weapon → arms → shoulders → torso and is partly absorbed, so repeats are never identical |
| Hit reaction | The hit direction is resolved into the soldier's own frame, seeding directional pitch/roll springs; a sharp local response is followed by a slower whole-body follow-through |
| Head stabilisation | The head counters the body's lean and bob so the eyeline stays level, damped so it never snaps |
| Idle breathing | Low-amplitude torso motion so a stationary soldier is not frozen |

**Cost: zero.** Draw calls, triangles and lights measured at the same viewpoint before and after
this work: **638 / 301,643 / 17 → 638 / 301,643 / 17.** Every change is a transform or a spring;
no geometry, no materials, no meshes were added. This was a hard constraint of the brief and it
was met exactly.

**What this cannot fix.** The remaining rigidity is geometric, not animative:

- limb segments are rigid capsules, so nothing deforms at a joint — an elbow is a hinge between two
  solids, not skin over bone;
- shoulders and hips cannot compress or shear, so the silhouette at extreme angles is a mechanism;
- there is no cloth, no gear sway, no secondary motion on straps or pouches;
- fingers do not exist, so the grip on the weapon is implied by arm placement.

**These require skinned meshes with vertex weights, and authored or IK-solved animation. The
procedural rig cannot produce them, and I recommend deferring that to a later pass rather than
attempting a skeletal-mesh migration inside this one** — it would replace the character pipeline,
the material setup and the animation system at once, which is a larger change than everything in
this pass combined and is not a "visual polish" task.
