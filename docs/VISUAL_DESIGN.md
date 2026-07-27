# Visual design document — TIDEBREAKER / Berth 7

## 1. The premise, in one sentence

A working container berth twenty minutes after a storm, at the exact moment dusk hands over to
night: the sky has gone cold, the floodlights have taken over, and every horizontal surface is
still wet enough to double the lighting.

That sentence drives every decision below. If a change makes the scene stop reading as *wet*,
*industrial* or *transitional*, it is the wrong change.

---

## 2. Lighting model

### 2.1 One key light

A single shadow-casting `DirectionalLight` (`src/scene/Lighting.ts`). Its direction comes from
`SkyDome.sunDirection`, which is derived from `VISUAL_CONFIG.sun.azimuth/elevation` — the same
values the sky shader uses to draw the sun. **The sun in the sky and the shadows on the ground
can never disagree**, because there is only one source of truth.

The shadow frustum is a 46 m box that follows the camera and is *snapped to texel-sized steps*.
Without the snap, shadow edges crawl visibly as the player walks; this is the single most common
"cheap 3D" tell in a moving shot.

### 2.2 Fill that keeps the game readable

`HemisphereLight`, sky colour `#4f74a3`, intensity `1.3`. This is deliberately generous.

The brief's instruction not to fake quality with darkness is also a gameplay requirement: an
enemy in the shadow of a container has to be findable. Three mechanisms guarantee that:

1. the hemisphere fill never goes below ~1.0;
2. the tonemap is ACES, whose shadow toe preserves separation instead of crushing to black;
3. every hostile carries a blinking amber IR strobe (`EnemySoldier.strobe`).

If you darken the scene, you must not break all three.

### 2.3 Two light families

The practicals are split into **two colour temperatures on purpose**:

- **High-pressure sodium** (`practicals.floodColorWarm`) lights the container canyon and the yard.
- **Mercury / LED** (`practicals.floodColorCool`) lights the warehouse facade, the pier head and
  the interior strips.

The player physically crosses between them as they advance up the berth. This is what produces
warm/cool contrast *in depth* rather than a single colour cast, and it is the main reason the
frame has colour separation at all. Making every practical the same temperature is what flattened
the earlier palette.

### 2.4 White balance

`grade.whiteBalanceK` is the temperature the virtual camera is balanced FOR, applied in
scene-referred linear space before the tonemap. Balancing for a warm illuminant (4600K) tells the
camera "the light here is orange", so it cools the world — and anything genuinely warm, the sodium
lamps and the muzzle flash, then reads as warm against it. This is the standard night-exterior
trick and it is the single most powerful control over the warm/cool balance.

### 2.5 Practicals are the real light source

At `timeOfDay = 0.42` the sun is a weak cool rim and the **floodlights do most of the work**.
Seven spot lights, all with a modelled fixture — mast, arm, brace, housing, cowl — so every pool
of light on the deck has a visible cause. Beacons, strip lights and most hanging lamps are
emissive-only fixtures: they read as sources through bloom without costing a per-pixel light.

Volume is faked with an additive cone mesh (`src/shaders/LightConeShader.ts`) that brightens
edge-on, fades along its length, and fades near the camera so you can walk through a beam.

### 2.4 Atmosphere

`src/materials/FogPatch.ts` overrides three's fog ShaderChunks **globally**, so every lit material
gets the same atmosphere for free:

- exponential-squared distance extinction,
- a ground mist layer whose density decays with altitude,
- aerial perspective — distant geometry shifts toward the sky colour,
- forward scattering toward the sun.

This is where most of the scene's depth comes from. Distance fog alone makes a harbour look like
it is inside a grey ball.

---

## 3. Materials

### 3.1 Everything is procedural

`src/materials/TextureFactory.ts` synthesises full PBR sets (albedo, tangent-space normal, and an
ORM pack where R = AO, G = roughness, B = metalness). All noise is **periodic**, so every texture
tiles seamlessly — non-tiling noise is the clearest sign of procedural texturing.

### 3.2 The UV contract

**Every surface in the project uses world-scale UVs measured in metres.** `applyBoxUv()` projects
box faces by their dominant axis; `corrugatedPanel()` and the ground plane write metre UVs
explicitly. Therefore `texture.repeat` means **tiles per metre**, everywhere.

This matters more than it sounds. Before this was unified, `PlaneGeometry` panels carried 0–1 UVs
while `chamferBox` carried metres, so a 12 m container wall showed a single enormous rust blotch
while a crate looked correct. If you add geometry, give it metre UVs.

### 3.3 Material separation

Roughness and metalness are what separate materials, not colour:

| Surface | Roughness | Metalness | Notes |
| --- | --- | --- | --- |
| Concrete | 0.42–0.94 | 0 | Aggregate, cracks, water staining |
| Wet apron | 0.32 floor → 0.035 in puddles | 0 | Puddle mask drives it |
| Container paint | 0.52–0.94 | 0–0.85 | Metal shows only where paint has gone |
| Bare steel | 0.4–1.0 | 0.9 → 0.3 with rust | |
| Tread plate | 0.42–1.0 | 0.35–0.85 | Studs polish, valleys stay dirty |
| Gun aluminium | 0.28 floor | 0.88 | Floor exists to stop specular aliasing |
| Gun polymer | 0.66–0.78 | 0.02 | |
| Rubber | 0.82–0.92 | 0 | |

**The roughness floors are load-bearing.** A tiled normal map on a very smooth surface at a
grazing angle aliases into coloured specular fireflies. That was a real defect during development;
`MaterialLibrary.setWetness()` now floors wet roughness at 0.32 and `gunMetal` at 0.28.

### 3.4 Nothing is a raw box

`chamferBox()` puts a 1–3 cm bevel on every edge of every hard-surface prop. A perfect 90°
edge catches zero specular; a chamfer draws a bright line along it under every practical. That
single function is responsible for most of the perceived material quality.

---

## 4. The wet ground

`src/environment/WetGround.ts` is the highest-value single feature. It extends
`MeshStandardMaterial` through `onBeforeCompile` (rather than replacing it, which would mean
re-implementing shadows and IBL) and adds:

- a procedural puddle mask (thresholded fbm — puddles have waterlines, not gradients);
- roughness driven to 0.035 and the concrete normal replaced by a water normal inside puddles;
- **planar reflection**: the scene re-rendered from the camera mirrored through `y = 0`, sampled
  in screen space (exact for a flat mirror) and distorted by the ripple normal;
- Schlick fresnel, so reflections strengthen at grazing angles — which is what makes a wet apron
  read as wet from standing eye height;
- rain rings spawned from a hashed grid inside the shader (zero CPU cost);
- gameplay ripple rings pushed by footsteps, impacts and explosions.

---

## 5. Composition of the level

```
        +Z (inland)
         |   [ WAREHOUSE 12..46 ]      [ PIER BLOCKHOUSE ]
         |        catwalk over x=36
     ----+--------------------------------------------->  +X
         |  BAY        CONTAINER CANYON     YARD    PIER HEAD
         |  -6..8        8..30              30..46   46..58
         |   [ QUAY EDGE / SEA  z < -13 ]
        -Z (seaward)
```

- **The opening frame** is shot from under a dark canopy: foreground silhouette, midground lit
  yard, background sky. Depth on frame one.
- **The sun sits low to the east**, straight down the player's path, so every container is
  back-lit and rim-lit through haze. The player always sees shadowed faces with bright edges.
- **The canyon is not a corridor.** A container stacked across the lane at x=19 forces a jog, and
  a leaning rust container beside it signals "this is a place, not a grid".
- **Verticality three times:** stacked containers (5 m), catwalk (5.2 m), crane (22 m).
- **The extraction strobe is visible from spawn**, 55 m down the berth. It is the only green light
  in a warm-and-cold scene, so it reads instantly as "go there".

Density comes from layering, not from more boxes: frame rails and corner castings on every
container, locking bars and hinges on the doors, pipe runs with brackets, cable catenaries,
kerbs, cones, pallets, sandbags, and scattered rubble at the base of every large object so
nothing meets the ground in a clean line.

---

## 6. Post-processing chain

`src/core/RenderSystem.ts`, in order:

1. world → `sceneRT` (HDR half-float + depth texture)
2. view-model → same target, depth cleared, second camera
3. SSAO (half-res, depth-only normals) + separable bilateral blur
4. auto-exposure: log-luminance reduced 64→1 and temporally adapted in a 1×1 ping-pong
5. bloom: 6-level down/up-sample chain with a Karis-averaged downsample
6. **composite** — one full-res pass doing DoF + motion blur + AO + bloom + exposure + ACES
   tonemap + grade + vignette + grain + chromatic aberration
7. FXAA (or a plain copy) to the canvas

Folding step 6 into a single pass instead of six separate ones is a large frame-time saving.

The ordering inside the composite is deliberate and matches a film pipeline: optical effects
happen in scene-referred linear space, then exposure, then tonemap, then the creative grade, then
sensor artefacts. **Grading before the tonemap is the classic mistake that makes a scene muddy.**

### The view-model shares one depth space

The weapon is rendered by a second camera with the **same near/far** and a different FOV, on its
own layer, into the same target with depth cleared. That gives a gun that never clips into
geometry while still producing depth values consistent with the world, so SSAO and DoF need no
special case for it.

---

## 7. Key parameters

All in [`src/config/visual.ts`](../src/config/visual.ts). The ones that change the look most:

| Parameter | Value | What it does |
| --- | --- | --- |
| `sky.timeOfDay` | `0.42` | Master dusk→night blend. Drives sky, sun colour/intensity, fog scatter, stars |
| `exposure.base` | `1.62` | Primary brightness control |
| `sun.azimuth / elevation` | `108° / 3.4°` | Back-lighting direction. Changing this re-lights the whole level |
| `sun.intensityDay/Night` | `2.6 / 0.85` | Key light |
| `ambient.intensity` | `1.3` | **Shadow readability. Do not reduce below ~1.0** |
| `ambient.envIntensity` | `1.15` | PMREM probe contribution |
| `fog.density` | `0.0138` | Distance haze |
| `fog.mistHeight / mistDensity` | `3.2 / 0.55` | Ground mist |
| `fog.aerialStrength` | `0.45` | Depth separation of distant geometry |
| `wetness.global` | `0.82` | Roughness reduction + puddle coverage |
| `wetness.puddleReflectivity` | `0.92` | Planar reflection strength |
| `practicals.floodIntensity` | `620` | With decay = 2 this is candela-ish; ~1/d² |
| `bloom.threshold / strength` | `0.92 / 0.42` | Only genuine emitters should bloom |
| `grade.splitToneBalance` | `0.22` | Teal shadows / amber highlights |
| `grade.vignette / grain` | `0.26 / 0.014` | Restrained on purpose |
| `muzzle.lightIntensity` | `900` | The flash lighting the *world*, not just the screen |

### Things that break the look if changed

1. **`ambient.intensity` below ~1.0** — shadowed enemies become invisible.
2. **The roughness floors** in `MaterialLibrary.setWetness()` (0.32) and `gunMetal` (0.28) —
   removing them brings back coloured specular fireflies.
3. **Metre UVs** on any new geometry — see §3.2.
4. **`installFogPatch()` must run before any material compiles** (it is the first boot stage).
   Materials compiled earlier will not get the atmosphere.
5. **Split-tone normalisation** in the composite — multiplying by a raw tone colour instead of a
   luminance-normalised one tints *and* darkens, turning dusk into a red smear.
6. **`chamferBox` instead of `BoxGeometry`** for anything hard-surface.
7. **Practical fixtures** — if you add a light, model its housing too.
