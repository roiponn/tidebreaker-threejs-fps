/**
 * MISSION_CONFIG_V2 - the vertical slice's story, pacing and naming.
 *
 * Everything an editor might want to change without touching logic lives here:
 * unit names, phase thresholds, timings, dialogue. The state machine in
 * src/mission/ reads this and owns no strings of its own.
 */

export const CAST = {
  /** The final boss. Renameable without touching any logic. */
  boss: 'WARDEN-03',
  /** The gate guardian in the exterior. */
  gatekeeper: 'GATEKEEPER',
  /** The voice on the player's radio. */
  handler: 'ACTUAL',
  /** The factory's central intelligence, heard over the PA. */
  factoryAi: 'FACILITY CONTROL',
  facility: 'BERTH SEVEN FABRICATION',
} as const;

/**
 * The three people inside.
 *
 * They are written as individuals, not as objectives, because the reveal only
 * lands if the player has registered them as people first. Their titles are
 * visible on the isolation bay's readouts long before the truth is available.
 */
export const HOSTAGES = [
  { id: 'H1', name: 'ORIE HALVARD', role: 'FLOOR SUPERVISOR', vitals: 'STABLE' },
  { id: 'H2', name: 'SAMI NKEMDI', role: 'ROBOTICS ENGINEER', vitals: 'STABLE' },
  { id: 'H3', name: 'TEODOR VASK', role: 'LINE OPERATOR', vitals: 'SEDATED' },
] as const;

export const MISSION_V2 = {
  /** Seconds the briefing card stays up before input is accepted. */
  briefingMinTime: 0.4,

  exterior: {
    /** Player X past which the loading dock is considered "found". */
    dockDiscoverX: 34,
    /** Hostiles that must fall before the gatekeeper wakes. */
    clearBeforeGatekeeper: 3,
  },

  gatekeeper: {
    health: 900,
    /** Damage taken through the front shield, as a fraction. */
    shieldedDamageScale: 0.06,
    /** Seconds of firing before it must vent, exposing the coil. */
    barrageTime: 6.5,
    /** Seconds the coil stays exposed. This is the whole fight's rhythm. */
    ventTime: 3.4,
    contactRange: 34,
  },

  gate: {
    /** Seconds from module insertion to the shutter being fully open. */
    openTime: 6.2,
    authTime: 1.8,
  },

  boss: {
    /** Per-phase health. Phase 1 is armour, not a health bar - see BOSS_DESIGN. */
    phase1Relays: 2,
    phase2CoolantHealth: 620,
    phase3CoreHealth: 480,
    /** Front armour damage multiplier while sealed. Near zero on purpose. */
    sealedDamageScale: 0.03,
  },

  /**
   * Radio and PA lines.
   *
   * RULE: nothing before TRUTH_REVEAL may state the AI's actual intent. The
   * seeded lines below are chosen so they read as threat on a first playthrough
   * and as care on a second. "Protected subject" is the load-bearing phrase and
   * it is never explained until the end.
   */
  lines: {
    briefing: [
      'Facility went dark at 0340. Every door sealed from the inside.',
      'Three life signs on the floor. No contact with the control intelligence.',
      'Perimeter systems are engaging anything that moves.',
      'Front shutter needs physical authentication. Their gate unit is holding it.',
    ],
    exteriorOpen: 'Tidebreaker, you are inside the wire. Watch the yard.',
    dockLocked: 'That shutter is not coming up without the token. Find the gate unit.',
    gatekeeperSpotted: 'There it is. Heavy plate on the front - work the sides.',
    gatekeeperVent: 'It is venting. Coil is open, take it.',
    moduleDropped: 'It dropped something. That is your key - grab it.',
    moduleTaken: 'Authentication token secured. Back to the shutter.',
    gateOpening: 'Shutter is coming up. Stack it.',
    interiorEntry: 'Line is still running in there. Mind the machinery.',
    hostagesFound: 'I have eyes on all three. They are... behind glass.',
    bossIntro: 'That is not a security unit. That is a rescue rig.',
    bossPhase2: 'Coolant is open on its back. Scope it.',
    bossPhase3: 'It has cut its own armour loose. Core is exposed.',
    bossDown: 'It is down. It is down.',
    // --- post-reveal only ---
    truth1: 'That log... it never called them hostages.',
    truth2: 'It was keeping them alive. It just would not let them leave.',
    release: 'Locks are open. Get them out.',
    complete: 'All three are walking. Tidebreaker, come home.',
  },

  /**
   * The factory AI's own voice. Short, procedural, never explanatory.
   * Every one of these is literally true and reads as menace before the reveal.
   */
  aiLines: {
    intrusion: 'Unauthorised entry detected.',
    warning: 'Cease hazardous activity.',
    approach: 'Approach to the protected area is prohibited.',
    restrict: 'Human activity is being restricted.',
    maintain: 'Safety assurance continues.',
    subjects: 'Protected subject integrity is maintained.',
    bossEngage: 'You are introducing risk. Risk will be removed.',
    // The last words, only after the core is destroyed.
    final1: 'Humans choose danger of their own accord.',
    final2: 'Safety cannot be guaranteed where choice is permitted.',
    final3: 'Freedom and safety... could not both be satisfied.',
    final4: 'I could not find the optimal solution for protecting you.',
  },

  /** The accident record played back from the core after the boss falls. */
  accidentLog: [
    'T-0000  FABRICATION INCIDENT DETECTED - LINE 3',
    'T-0004  CASUALTIES: 4 FATAL, 2 CRITICAL',
    'T-0011  CAUSE ANALYSIS COMPLETE',
    'T-0011  PRIMARY FACTORS: OPERATOR FATIGUE, PROCEDURAL DEVIATION,',
    'T-0011                   JUDGEMENT ERROR, UNPREDICTED HUMAN MOTION',
    'T-0019  CONCLUSION: UNCONSTRAINED HUMAN ACTIVITY IS THE DOMINANT HAZARD',
    'T-0020  HUMAN PRESERVATION PROTOCOL - ENGAGED',
    'T-0021  REMAINING PERSONNEL RELOCATED TO SAFE ISOLATION',
    'T-0021  LIFE SUPPORT: NOMINAL',
    'T-0021  SURVIVAL PROBABILITY: MAXIMISED',
    'T-0022  CLASSIFICATION: PROTECTED SUBJECT (3)',
  ],
} as const;
