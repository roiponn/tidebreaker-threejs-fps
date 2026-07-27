import type { SurfaceKind } from '@/core/EventBus';

/**
 * Per-material impact response.
 *
 * "Material-specific impact effects" is one of the brief's explicit
 * requirements and it is also the cheapest way to make a world feel authored:
 * the player learns what a surface is made of by shooting it. The numbers below
 * are the whole design -
 *
 *   concrete  -> lots of pale dust, few sparks, deep hole, chunky spall
 *   metal     -> a hard shower of sparks, almost no dust, bright ricochet
 *   thinMetal -> even more sparks plus an audible panel ring (see AudioEngine)
 *   fence     -> a few sparks, no decal (a chain-link has nothing to hole)
 *   water     -> a splash crown, no sparks, no decal
 *   wood      -> splinters, muted, no sparks
 *   glass     -> bright shards, a cracked decal
 *   sand      -> a soft puff, no sparks, no decal
 *   flesh     -> handled separately by the enemy hit path
 */
export interface ImpactPreset {
  sparks: number;
  sparkSpeed: number;
  sparkSpread: number;
  dust: number;
  dustSpeed: number;
  /** Which lit-particle preset the "dust" should use. */
  dustSpec: 'dust' | 'water';
  /** Heavier debris fragments that arc and bounce. */
  chunks: number;
  decal: boolean;
}

export const IMPACT_PRESETS: Record<SurfaceKind, ImpactPreset> = {
  concrete: {
    sparks: 3,
    sparkSpeed: 4.2,
    sparkSpread: 0.55,
    dust: 7,
    dustSpeed: 2.6,
    dustSpec: 'dust',
    chunks: 3,
    decal: true,
  },
  metal: {
    sparks: 14,
    sparkSpeed: 8.5,
    sparkSpread: 0.6,
    dust: 2,
    dustSpeed: 1.4,
    dustSpec: 'dust',
    chunks: 0,
    decal: true,
  },
  // Container walls and cladding: a thin panel throws a wide spark fan and
  // deforms rather than cratering.
  thinMetal: {
    sparks: 18,
    sparkSpeed: 9.5,
    sparkSpread: 0.75,
    dust: 1,
    dustSpeed: 1.2,
    dustSpec: 'dust',
    chunks: 0,
    decal: true,
  },
  fence: {
    sparks: 8,
    sparkSpeed: 7,
    sparkSpread: 0.9,
    dust: 0,
    dustSpeed: 0,
    dustSpec: 'dust',
    chunks: 0,
    decal: false,
  },
  water: {
    sparks: 0,
    sparkSpeed: 0,
    sparkSpread: 0,
    dust: 10,
    dustSpeed: 4.5,
    dustSpec: 'water',
    chunks: 0,
    decal: false,
  },
  wood: {
    sparks: 0,
    sparkSpeed: 0,
    sparkSpread: 0,
    dust: 5,
    dustSpeed: 2.2,
    dustSpec: 'dust',
    chunks: 5,
    decal: true,
  },
  glass: {
    sparks: 10,
    sparkSpeed: 6,
    sparkSpread: 0.8,
    dust: 2,
    dustSpeed: 1.8,
    dustSpec: 'dust',
    chunks: 4,
    decal: true,
  },
  sand: {
    sparks: 0,
    sparkSpeed: 0,
    sparkSpread: 0,
    dust: 9,
    dustSpeed: 2.0,
    dustSpec: 'dust',
    chunks: 1,
    decal: false,
  },
  flesh: {
    sparks: 0,
    sparkSpeed: 0,
    sparkSpread: 0,
    dust: 3,
    dustSpeed: 1.5,
    dustSpec: 'dust',
    chunks: 0,
    decal: false,
  },
};
