import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { chamferBox, mergeGeometries, trs } from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';

/**
 * MK-7 "VESPER" - the slice's only weapon. Fully original design.
 *
 * Local axes: the muzzle points down -Z, up is +Y, the ejection port is on +X.
 * The origin sits at the pistol grip so rotations (recoil roll, ADS pivot)
 * happen around a point that feels like the shooter's wrist.
 *
 * WHY IT IS BUILT THIS WAY
 *  - Everything is a chamferBox or a lathe/cylinder, never a raw box: at 35cm
 *    from the camera the chamfers are 2-4 pixels wide and they catch a bright
 *    specular line from every practical light in the level. That edge highlight
 *    is the single strongest cue that an object is metal and not a grey solid.
 *  - Four distinct materials (anodised aluminium, glass-filled polymer,
 *    rubber, bare steel) with genuinely different roughness/metalness, plus a
 *    separate barrel material that can glow with heat.
 *  - The handguard is built from six separate slats around a hex profile, so
 *    it is *actually* vented - you can see the barrel through the gaps. Faking
 *    that with a texture falls apart at this distance.
 *  - Static parts are merged per material (6 draw calls); only the parts that
 *    must animate - bolt carrier, charging handle, magazine, trigger, dust
 *    cover - stay as separate objects.
 */
export interface RifleParts {
  root: THREE.Group;
  /** Recoiling group: everything that moves back on firing. */
  body: THREE.Group;
  bolt: THREE.Object3D;
  chargingHandle: THREE.Object3D;
  magazine: THREE.Object3D;
  trigger: THREE.Object3D;
  dustCover: THREE.Object3D;
  /** Empty markers used by the VFX systems. */
  muzzlePoint: THREE.Object3D;
  ejectPoint: THREE.Object3D;
  magWell: THREE.Object3D;
  sightPoint: THREE.Object3D;
  /** Material whose emissive is driven by sustained-fire heat. */
  barrelMaterial: THREE.MeshStandardMaterial;
  reticleMaterial: THREE.MeshStandardMaterial;
  dispose(): void;
}

interface Part {
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

export function buildRifle(mats: MaterialLibrary): RifleParts {
  const owned: THREE.BufferGeometry[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => {
    owned.push(g);
    return g;
  };

  const metalParts: Part[] = [];
  const polymerParts: Part[] = [];
  const rubberParts: Part[] = [];
  const steelParts: Part[] = [];
  const add = (list: Part[], geo: THREE.BufferGeometry, matrix: THREE.Matrix4): void => {
    list.push({ geo, matrix });
  };

  // ==================================================================
  // Receiver - the structural spine of the weapon
  // ==================================================================
  add(metalParts, keep(chamferBox(0.072, 0.086, 0.30, 0.005, 2)), trs(0, 0.012, -0.02));
  // Upper/lower split line: a thin raised strip reads as two machined halves.
  add(metalParts, keep(chamferBox(0.076, 0.006, 0.29, 0.002, 1)), trs(0, -0.014, -0.02));
  // Magazine well, flared at the mouth for fast reloads.
  add(metalParts, keep(chamferBox(0.052, 0.075, 0.10, 0.006, 2)), trs(0, -0.068, -0.035));
  add(metalParts, keep(chamferBox(0.060, 0.016, 0.112, 0.007, 2)), trs(0, -0.104, -0.035));

  // Ejection port surround (right side) - a recessed rectangular frame.
  add(metalParts, keep(chamferBox(0.010, 0.050, 0.088, 0.003, 1)), trs(0.038, 0.026, -0.052));
  // Brass deflector behind the port.
  add(metalParts, keep(chamferBox(0.014, 0.028, 0.022, 0.004, 1)), trs(0.040, 0.030, -0.004));

  // Top rail: 15 teeth. Individually tiny, collectively the most
  // recognisable "this is a modern firearm" silhouette detail.
  // 13 teeth at 2.1cm pitch. The original 20-at-1.4cm pitch was sub-pixel at
  // view-model distance and aliased into white speckle rather than reading as
  // a rail - detail below the pixel grid costs performance and looks worse.
  const railTooth = keep(chamferBox(0.023, 0.009, 0.013, 0.0018, 1));
  const railBase = keep(chamferBox(0.023, 0.007, 0.30, 0.0016, 1));
  add(metalParts, railBase, trs(0, 0.058, -0.06));
  for (let i = 0; i < 13; i++) {
    add(metalParts, railTooth, trs(0, 0.066, 0.055 - i * 0.021));
  }

  // ==================================================================
  // Handguard - six slats around a hexagonal profile, genuinely vented
  // ==================================================================
  const slat = keep(chamferBox(0.016, 0.010, 0.212, 0.002, 1));
  for (let i = 0; i < 6; i++) {
    // Skip the top: the rail continues over the handguard instead.
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const r = 0.031;
    add(
      metalParts,
      slat,
      trs(Math.cos(angle) * r, Math.sin(angle) * r + 0.012, -0.245, 0, 0, angle + Math.PI / 2),
    );
  }
  // Front and rear handguard rings that the slats bolt into.
  const ring = keep(new THREE.TorusGeometry(0.031, 0.007, 6, 14));
  add(metalParts, ring, trs(0, 0.012, -0.142));
  add(metalParts, ring, trs(0, 0.012, -0.348));
  // M-LOK style accessory slots along the lower slats.
  const slot = keep(chamferBox(0.006, 0.004, 0.026, 0.001, 1));
  for (let i = 0; i < 4; i++) {
    add(polymerParts, slot, trs(-0.030, -0.014, -0.185 - i * 0.045));
    add(polymerParts, slot, trs(0.030, -0.014, -0.185 - i * 0.045));
  }

  // ==================================================================
  // Barrel, gas system and muzzle device
  // ==================================================================
  // A dedicated material instance so heat can glow without affecting the rest
  // of the receiver, which shares the pooled gunMetal material.
  const barrelMaterial = mats.gunMetal().clone() as THREE.MeshStandardMaterial;
  barrelMaterial.name = 'rifleBarrel';
  barrelMaterial.emissive = new THREE.Color(0xff2e00);
  barrelMaterial.emissiveIntensity = 0;
  barrelMaterial.userData = { surface: 'metal' };
  const barrelGeo = keep(new THREE.CylinderGeometry(0.0115, 0.0125, 0.30, 14));
  const barrel = new THREE.Mesh(barrelGeo, barrelMaterial);
  barrel.position.set(0, 0.012, -0.29);
  barrel.rotation.x = Math.PI / 2;
  barrel.castShadow = false;

  // Gas block with a low-profile front sight base.
  add(steelParts, keep(chamferBox(0.026, 0.030, 0.040, 0.004, 1)), trs(0, 0.020, -0.322));
  add(steelParts, keep(new THREE.CylinderGeometry(0.005, 0.005, 0.155, 8)), trs(0, 0.030, -0.262, Math.PI / 2, 0, 0));

  // Muzzle brake: a stepped cylinder with three cut ports per side. The ports
  // are what make the flash read as coming from a real device.
  add(steelParts, keep(new THREE.CylinderGeometry(0.0175, 0.0175, 0.052, 12)), trs(0, 0.012, -0.462, Math.PI / 2, 0, 0));
  add(steelParts, keep(new THREE.CylinderGeometry(0.0135, 0.0175, 0.016, 12)), trs(0, 0.012, -0.432, Math.PI / 2, 0, 0));
  const port = keep(chamferBox(0.040, 0.006, 0.009, 0.001, 1));
  for (let i = 0; i < 3; i++) {
    add(steelParts, port, trs(0, 0.024, -0.448 - i * 0.014));
    add(steelParts, port, trs(0, 0.000, -0.448 - i * 0.014));
  }

  // ==================================================================
  // Pistol grip, trigger guard, stock
  // ==================================================================
  const gripAngle = -0.34;
  add(rubberParts, keep(chamferBox(0.032, 0.115, 0.048, 0.008, 2)), trs(0, -0.088, 0.052, gripAngle, 0, 0));
  add(polymerParts, keep(chamferBox(0.036, 0.026, 0.052, 0.008, 2)), trs(0, -0.150, 0.074, gripAngle, 0, 0));
  // Trigger guard: a partial torus, flattened, so it is a loop and not a bar.
  const guard = keep(new THREE.TorusGeometry(0.030, 0.0045, 5, 12, Math.PI * 1.15));
  add(metalParts, guard, trs(0, -0.046, 0.012, 0, Math.PI / 2, -0.35));

  // Skeleton stock: two rails, a cheek riser and a rubber butt pad. Hollow
  // stocks are a signature of modern carbines and give the silhouette air.
  add(polymerParts, keep(chamferBox(0.052, 0.030, 0.075, 0.006, 2)), trs(0, 0.010, 0.150));
  const stockRail = keep(chamferBox(0.011, 0.014, 0.145, 0.003, 1));
  add(polymerParts, stockRail, trs(-0.019, 0.036, 0.222));
  add(polymerParts, stockRail, trs(0.019, 0.036, 0.222));
  add(polymerParts, stockRail, trs(0, -0.024, 0.215, 0.12, 0, 0));
  add(polymerParts, keep(chamferBox(0.048, 0.020, 0.088, 0.006, 2)), trs(0, 0.052, 0.220));
  add(rubberParts, keep(chamferBox(0.050, 0.098, 0.020, 0.006, 2)), trs(0, 0.016, 0.292, 0.14, 0, 0));

  // ==================================================================
  // Optic: housing, hood, glass, and an emissive reticle
  // ==================================================================
  add(metalParts, keep(chamferBox(0.044, 0.020, 0.086, 0.004, 2)), trs(0, 0.076, -0.052));
  // Hood end plates, built as FRAMES around an aperture.
  //
  // These were solid slabs, which made the optic a closed box: aiming down the
  // sight put an opaque block over the screen centre and neither the glass nor
  // the reticle behind it could be seen. A sight you cannot see through is not
  // a sight. Four thin bars per end leave a 32 x 36mm opening, which is what
  // the 38 x 40mm glass sits behind.
  const hoodH = keep(chamferBox(0.048, 0.008, 0.010, 0.003, 1));
  const hoodV = keep(chamferBox(0.008, 0.036, 0.010, 0.003, 1));
  // Matte polymer, not metal: a bare-metal frame throws a specular highlight
  // straight into the middle of the sight picture. Real optic hoods are
  // deliberately non-reflective for exactly this reason.
  for (const z of [-0.092, -0.014]) {
    add(polymerParts, hoodH, trs(0, 0.122, z));
    add(polymerParts, hoodH, trs(0, 0.078, z));
    add(polymerParts, hoodV, trs(-0.020, 0.100, z));
    add(polymerParts, hoodV, trs(0.020, 0.100, z));
  }
  add(metalParts, keep(chamferBox(0.010, 0.050, 0.082, 0.003, 1)), trs(-0.021, 0.100, -0.052));
  add(metalParts, keep(chamferBox(0.010, 0.050, 0.082, 0.003, 1)), trs(0.021, 0.100, -0.052));
  // Adjustment turrets - small, but they break the housing's flat top.
  add(metalParts, keep(new THREE.CylinderGeometry(0.008, 0.009, 0.010, 8)), trs(0.021, 0.122, -0.052, 0, 0, Math.PI / 2));
  add(metalParts, keep(new THREE.CylinderGeometry(0.008, 0.009, 0.010, 8)), trs(0, 0.126, -0.052));

  // Backup iron sights, folded down beside the optic.
  add(steelParts, keep(chamferBox(0.014, 0.016, 0.004, 0.001, 1)), trs(0, 0.068, 0.030, 0.9, 0, 0));

  const glassGeo = keep(new THREE.PlaneGeometry(0.038, 0.040));
  const glass = new THREE.Mesh(glassGeo, mats.glass());
  glass.position.set(0, 0.100, -0.030);
  glass.renderOrder = 2;

  const reticleGeo = keep(new THREE.PlaneGeometry(0.030, 0.030));
  /** The dot's colour, in one place. */
  const RETICLE_COLOR = 0xff2418;
  const reticleMaterial = mats.emissive('reticle', RETICLE_COLOR, 6, { toneMapped: true }).clone();
  reticleMaterial.name = 'rifleReticle';
  reticleMaterial.transparent = true;
  reticleMaterial.opacity = 1;
  // Additive: an illuminated reticle adds light to the sight picture, it does
  // not paint over it. This is also what stops the dot going muddy against a
  // bright background.
  reticleMaterial.blending = THREE.AdditiveBlending;
  reticleMaterial.depthWrite = false;
  reticleMaterial.map = buildReticleTexture();
  reticleMaterial.alphaMap = reticleMaterial.map;
  reticleMaterial.emissiveMap = reticleMaterial.map;
  const reticle = new THREE.Mesh(reticleGeo, reticleMaterial);
  // IN FRONT OF THE GLASS, AND UNCONDITIONALLY DRAWN.
  //
  // It sat at -0.034, behind the glass at -0.030. The glass is transparent but
  // still writes depth, and it renders first, so the dot failed the depth test
  // and was never drawn at all - which is why the sight picture had no reticle
  // in it despite the material being lit and mapped correctly.
  //
  // A red dot is a collimated image projected for the eye, not an object
  // sitting inside the tube, so drawing it over the sight picture regardless
  // of depth is also the physically honest thing to do.
  reticle.position.set(0, 0.100, -0.026);
  reticle.renderOrder = 5;
  reticleMaterial.depthTest = false;

  // ==================================================================
  // Small controls - selector, mag release, bolt catch, sling loop
  // ==================================================================
  add(steelParts, keep(chamferBox(0.020, 0.008, 0.012, 0.002, 1)), trs(-0.040, -0.006, 0.030, 0, 0, 0.5));
  add(steelParts, keep(chamferBox(0.012, 0.014, 0.008, 0.002, 1)), trs(0.040, -0.026, -0.010));
  add(steelParts, keep(chamferBox(0.010, 0.022, 0.014, 0.002, 1)), trs(-0.040, -0.024, -0.010));
  add(steelParts, keep(new THREE.TorusGeometry(0.010, 0.0025, 5, 10)), trs(-0.036, 0.026, 0.118, 0, Math.PI / 2, 0));

  // ==================================================================
  // Merge statics
  // ==================================================================
  const body = new THREE.Group();
  body.name = 'RifleBody';
  const mergeInto = (parts: Part[], material: THREE.Material, name: string): void => {
    if (parts.length === 0) return;
    const merged = mergeGeometries(
      parts.map((p) => p.geo),
      parts.map((p) => p.matrix),
    );
    owned.push(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    body.add(mesh);
  };
  mergeInto(metalParts, mats.gunMetal(), 'rifleReceiver');
  mergeInto(polymerParts, mats.gunPolymer(), 'riflePolymer');
  mergeInto(rubberParts, mats.gunRubber(), 'rifleRubber');
  mergeInto(steelParts, mats.steelBare(), 'rifleSteel');
  body.add(barrel, glass, reticle);

  // ==================================================================
  // Animated parts
  // ==================================================================
  const bolt = new THREE.Group();
  bolt.name = 'BoltCarrier';
  const boltGeo = keep(chamferBox(0.030, 0.030, 0.070, 0.004, 1));
  const boltMesh = new THREE.Mesh(boltGeo, mats.steelBare());
  boltMesh.position.set(0.016, 0.030, -0.030);
  bolt.add(boltMesh);
  body.add(bolt);

  const chargingHandle = new THREE.Group();
  chargingHandle.name = 'ChargingHandle';
  const chGeo = keep(chamferBox(0.030, 0.012, 0.014, 0.003, 1));
  const chMesh = new THREE.Mesh(chGeo, mats.steelBare());
  chMesh.position.set(0.050, 0.034, -0.020);
  chargingHandle.add(chMesh);
  body.add(chargingHandle);

  // Dust cover flips open on the first shot and stays open.
  const dustCover = new THREE.Group();
  dustCover.name = 'DustCover';
  const dcGeo = keep(chamferBox(0.008, 0.044, 0.082, 0.002, 1));
  const dcMesh = new THREE.Mesh(dcGeo, mats.gunMetal());
  dcMesh.position.set(0.004, -0.022, 0);
  dustCover.add(dcMesh);
  dustCover.position.set(0.041, 0.048, -0.052);
  body.add(dustCover);

  const trigger = new THREE.Group();
  trigger.name = 'Trigger';
  const trGeo = keep(chamferBox(0.008, 0.030, 0.010, 0.002, 1));
  const trMesh = new THREE.Mesh(trGeo, mats.steelBare());
  trMesh.position.set(0, -0.014, 0);
  trigger.add(trMesh);
  trigger.position.set(0, -0.040, 0.024);
  body.add(trigger);

  // Magazine: three stacked, progressively rotated sections make a curved
  // box magazine without a bespoke lathe.
  const magazine = new THREE.Group();
  magazine.name = 'Magazine';
  const magSections: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [
    [keep(chamferBox(0.048, 0.075, 0.032, 0.005, 1)), trs(0, -0.036, 0.000)],
    [keep(chamferBox(0.046, 0.070, 0.031, 0.005, 1)), trs(0, -0.102, 0.010, 0.16, 0, 0)],
    [keep(chamferBox(0.044, 0.055, 0.030, 0.005, 1)), trs(0, -0.164, 0.030, 0.32, 0, 0)],
  ];
  const magMerged = mergeGeometries(
    magSections.map((s) => s[0]),
    magSections.map((s) => s[1]),
  );
  owned.push(magMerged);
  const magMesh = new THREE.Mesh(magMerged, mats.gunPolymer());
  magMesh.castShadow = false;
  magazine.add(magMesh);
  // Witness holes and a rubber floor plate.
  const floorGeo = keep(chamferBox(0.050, 0.014, 0.036, 0.004, 1));
  const floorMesh = new THREE.Mesh(floorGeo, mats.gunRubber());
  floorMesh.position.set(0, -0.196, 0.038);
  floorMesh.rotation.x = 0.32;
  magazine.add(floorMesh);
  magazine.position.set(0, -0.068, -0.035);
  body.add(magazine);

  // ==================================================================
  // Markers
  // ==================================================================
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.name = 'MuzzlePoint';
  muzzlePoint.position.set(0, 0.012, -0.492);
  body.add(muzzlePoint);

  const ejectPoint = new THREE.Object3D();
  ejectPoint.name = 'EjectPoint';
  ejectPoint.position.set(0.048, 0.030, -0.040);
  body.add(ejectPoint);

  const magWell = new THREE.Object3D();
  magWell.name = 'MagWell';
  magWell.position.set(0, -0.100, -0.035);
  body.add(magWell);

  const sightPoint = new THREE.Object3D();
  sightPoint.name = 'SightPoint';
  sightPoint.position.set(0, 0.100, -0.052);
  body.add(sightPoint);

  const root = new THREE.Group();
  root.name = 'Rifle';
  root.add(body);
  root.traverse((node) => {
    node.layers.set(LAYER.VIEWMODEL);
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    }
  });

  return {
    root,
    body,
    bolt,
    chargingHandle,
    magazine,
    trigger,
    dustCover,
    muzzlePoint,
    ejectPoint,
    magWell,
    sightPoint,
    barrelMaterial,
    reticleMaterial,
    dispose(): void {
      for (const g of owned) g.dispose();
      owned.length = 0;
      barrelMaterial.dispose();
      reticleMaterial.map?.dispose();
      reticleMaterial.dispose();
    },
  };
}

/**
 * Holographic reticle: a fine centre dot inside a segmented ring.
 * Drawn to a canvas because a texture is far cheaper than the ~200 triangles
 * a modelled reticle would need, and it can be alpha-masked cleanly.
 */
function buildReticleTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  ctx.clearRect(0, 0, size, size);
  // Ring and chevrons are drawn at reduced alpha: they frame the dot, they are
  // not the aiming mark. At full strength they pulled the eye off centre.
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  const c = size / 2;

  // Segmented ring - four arcs with gaps at the cardinals.
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const start = (i * Math.PI) / 2 + 0.22;
    ctx.beginPath();
    ctx.arc(c, c, size * 0.33, start, start + Math.PI / 2 - 0.44);
    ctx.stroke();
  }
  // Chevron tips at 3, 6 and 9 o'clock.
  ctx.lineWidth = 3;
  for (const [dx, dy] of [
    [0, 1],
    [1, 0],
    [-1, 0],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(c + dx * size * 0.44, c + dy * size * 0.44);
    ctx.lineTo(c + dx * size * 0.38, c + dy * size * 0.38);
    ctx.stroke();
  }
  // CENTRE DOT.
  //
  // This was a 4.2px dot on a 128px texture mapped to a 30mm plane - about
  // 0.6 degrees on screen, which is below what reads as an aiming mark. A red
  // dot sight IS the dot; the ring around it is decoration. So the dot is now
  // large enough to see and carries a soft bloom halo, which is what makes a
  // real illuminated reticle look like light rather than like a painted spot.
  //
  // Drawn white here: the material's emissive colour tints it, so the dot's
  // hue lives in one place (RETICLE_COLOR below) instead of being split
  // between a texture and a material.
  // Radii are small because the dot's apparent size is dominated by the GLOW
  // and then by bloom, not by the core. A 128px texture on a 30mm plane viewed
  // from ~190mm means 1px of texture is roughly 0.07 degrees, so a glow radius
  // of 18 was painting a 2.5 degree blob before bloom even touched it.
  const glow = ctx.createRadialGradient(c, c, 0, c, c, 7);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.34, 'rgba(255,255,255,0.85)');
  glow.addColorStop(0.62, 'rgba(255,255,255,0.22)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(c, c, 7, 0, Math.PI * 2);
  ctx.fill();
  // Hard core on top, so the centre stays a crisp point rather than a smudge.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(c, c, 2.4, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
