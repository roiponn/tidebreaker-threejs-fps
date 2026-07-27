# TIDEBREAKER — Berth 7

A vertical slice of an original modern-military FPS, built with **Three.js + TypeScript + Vite**.
Roughly 60–90 seconds of play: push east along a wet container berth at dusk, clear the hostiles,
reach the pier head.

Everything in this repository is original. There are **no binary art assets at all** — every
texture, every model, every sound is generated procedurally at load time from code in `src/`.
See [Assets and licences](#assets-and-licences).

---

## 1. Running it

```bash
npm install
```

```bash
npm run dev
```

Then open <http://localhost:5173>. Click **CLICK TO DEPLOY** to capture the mouse and start.

Other scripts:

```bash
npm run build
```

```bash
npm run preview
```

`npm run build` runs `tsc --noEmit` first, so a type error fails the build.

**Requirements:** a browser with WebGL 2 (Chrome, Edge or Firefox, hardware acceleration on).
Three.js dropped WebGL 1 in r163; if WebGL 2 is missing the game shows an explanatory card
instead of a blank page.

**Useful URL flags**

| Flag | Effect |
| --- | --- |
| `?quality=low` | Force the Performance preset |
| `?quality=medium` | Force the Balanced preset |
| `?quality=high` | Force the Cinematic preset |

Without a flag the preset is auto-detected from core count and GPU string.

---

## 2. Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| Left mouse | Fire (full auto) |
| Right mouse | Aim down sight |
| `Shift` | Sprint (forward only, weapon lowered) |
| `Ctrl` / `C` | Crouch |
| `Space` | Jump |
| `R` | Reload |
| `F` | Toggle the performance overlay |
| `H` | Toggle the HUD (for clean screenshots) |
| `` ` `` | Toggle the debug panel (releases the mouse) |
| `P` | Restart the mission |
| `Esc` | Release the mouse |

If the browser refuses pointer lock (sandboxed iframes, some remote setups) the game falls back
to a "soft lock" that reads raw mouse deltas, so it stays playable. `Esc` releases it.

---

## 3. Project layout

```
src/
  main.ts                  entry point only: DOM lookup, WebGL2 check, hand off to Game
  app/
    Game.ts                owns every system, the frame order and teardown
    MissionDirector.ts     intro sequence, objectives, win/lose
  core/
    RenderSystem.ts        the whole render + post pipeline
    Input.ts               pointer lock (+ soft-lock fallback), edge-tracked keys
    EventBus.ts            typed pub/sub; the spine that keeps VFX/audio/UI in sync
    Clock.ts  Pool.ts  MathUtils.ts  Disposal.ts  Rng.ts  Layers.ts
  config/
    visual.ts              EVERY look-affecting number
    gameplay.ts            movement, weapon, enemy, mission tuning
    quality.ts             the three presets
    input.ts               key bindings
  scene/
    SkyDome.ts             analytic dusk sky; authoritative sun direction
    Lighting.ts            key light, hemisphere fill, fog, PMREM probe
  environment/
    HarborLevel.ts         the authored level: layout, composition, encounter placement
    LevelBuilder.ts        merges static geometry per (zone, material)
    GeometryKit.ts         chamfered boxes, corrugated panels, I-beams, catenaries
    Props.ts               containers, barriers, drums, catwalks, fences, masts…
    Practicals.ts          floodlights, beacons, strip lights, swinging lamps, flicker
    WetGround.ts           puddle mask + planar reflection + ripples
    DistantScenery.ts      sea, skyline, aviation lights, drizzle, distant battle
    Explosives.ts          shootable fuel drums with fuses and chain reactions
  player/
    Player.ts              movement, stance, health
    PlayerCamera.ts        aim, recoil, shake, bob, FOV, motion vector
  weapons/
    RifleModel.ts          the MK-7 "VESPER" geometry
    WeaponController.ts    pose layers, firing, reload, heat
    Ballistics.ts          hitscan resolution for player and AI
  enemies/
    EnemySoldier.ts        soldier rig
    EnemyManager.ts        activation, strafing, burst fire, hit reactions, death
  effects/
    VfxManager.ts          orchestrates and synchronises everything visual
    ParticleSystem.ts      two fixed-budget instanced batches
    DecalSystem.ts         bullet holes and scorch marks
    ImpactPresets.ts       per-material impact response tables
  materials/
    TextureFactory.ts      procedural PBR texture generation
    ProceduralNoise.ts     tileable value/fbm/worley noise + normal/AO derivation
    MaterialLibrary.ts     one shared material per surface type
    FogPatch.ts            global height-fog + aerial perspective shader override
    WindMaterial.ts        GPU sway for cables and cloth
  shaders/                 all GLSL, as tagged template strings
  physics/CollisionWorld.ts grid-accelerated AABB resolve + mesh raycast
  ui/                      HUD, overlays, stylesheet
  debug/DebugPanel.ts      lil-gui panel (hidden by default)
docs/                      design, QA and handover documents
```

There is no `assets/` directory because there are no asset files.

### Why no React

The game is a `requestAnimationFrame` loop that mutates a scene graph 60 times a second. React's
value is declarative reconciliation of a component tree, which is the wrong model for that: every
frame would either bypass React entirely (making it decorative) or force reconciliation work into
the frame budget. The HUD is plain DOM, updated with dirty-checked writes from
[`src/ui/Hud.ts`](src/ui/Hud.ts) — on a steady frame it touches the DOM zero times.

---

## 4. Assets and licences

**No third-party art, audio or model assets are used.** Nothing from Call of Duty or any other
game is present in this repository in any form.

| Item | Source | Licence |
| --- | --- | --- |
| three (r0.180) | npm `three` | MIT |
| lil-gui (0.20) | npm `lil-gui` | MIT |
| vite, typescript, @types/three | npm | MIT / Apache-2.0 |
| All textures | generated at runtime by `src/materials/TextureFactory.ts` | original, this repo |
| All models | generated at runtime by `src/environment/*`, `src/weapons/RifleModel.ts` | original, this repo |
| All sounds | synthesised at runtime by `src/audio/AudioEngine.ts` | original, this repo |
| Reticle texture | drawn to a canvas in `RifleModel.ts` | original, this repo |
| Fonts | CSS system font stack only; nothing bundled | n/a |

No post-processing code was copied from the three.js examples. The bloom, SSAO, FXAA, composite
and utility passes in `src/shaders/` are written for this project. FXAA implements the
well-known Lottes algorithm; the code is an original implementation, not a copy.

---

## 5. Documents

| Document | Contents |
| --- | --- |
| [docs/VISUAL_DESIGN.md](docs/VISUAL_DESIGN.md) | Art direction, lighting model, material system, key parameters |
| [docs/QUALITY_REPORT.md](docs/QUALITY_REPORT.md) | Honest critique: what works, what does not, what was measured |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Measurements, budgets, known costs |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Architecture and next steps for whoever picks this up |
| [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) | Defects and limitations |

---

## 6. Status

This is a **vertical slice**, not a finished game. It boots, plays end to end, and has no build
errors or console errors. It is not at shipping AAA fidelity, and
[docs/QUALITY_REPORT.md](docs/QUALITY_REPORT.md) says exactly where it falls short and why.
