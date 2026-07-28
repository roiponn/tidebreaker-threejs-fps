/**
 * The mission's explicit state set.
 *
 * Every beat of the slice is one of these, and there is exactly one authority
 * for which one is current (MissionStateMachine). Nothing else may assign a
 * state; systems request a transition and the machine decides.
 *
 * The ordering here is the ordering of the slice, and `CHECKPOINT_OF` maps each
 * state back to the checkpoint a death should restore.
 */
export type MissionState =
  | 'BOOT'
  | 'BRIEFING'
  | 'EXTERIOR_ENTRY'
  | 'EXTERIOR_COMBAT'
  | 'GATEKEEPER_INTRO'
  | 'GATEKEEPER_ACTIVE'
  | 'GATEKEEPER_DEFEATED'
  | 'ACCESS_MODULE_DROPPED'
  | 'ACCESS_MODULE_ACQUIRED'
  | 'GATE_TERMINAL_ACTIVE'
  | 'GATE_OPENING'
  | 'FACTORY_ENTRY'
  | 'INTERIOR_APPROACH'
  | 'HOSTAGES_DISCOVERED'
  | 'BOSS_INTRO'
  | 'BOSS_PHASE_1'
  | 'BOSS_PHASE_2'
  | 'BOSS_PHASE_3'
  | 'BOSS_DEFEATED'
  | 'TRUTH_REVEAL'
  | 'HOSTAGE_RELEASE'
  | 'EXTRACTION'
  | 'MISSION_COMPLETE'
  | 'PLAYER_DEAD'
  | 'RESTARTING';

/** Declaration order, used for ordering comparisons and the debug menu. */
export const MISSION_ORDER: readonly MissionState[] = [
  'BOOT',
  'BRIEFING',
  'EXTERIOR_ENTRY',
  'EXTERIOR_COMBAT',
  'GATEKEEPER_INTRO',
  'GATEKEEPER_ACTIVE',
  'GATEKEEPER_DEFEATED',
  'ACCESS_MODULE_DROPPED',
  'ACCESS_MODULE_ACQUIRED',
  'GATE_TERMINAL_ACTIVE',
  'GATE_OPENING',
  'FACTORY_ENTRY',
  'INTERIOR_APPROACH',
  'HOSTAGES_DISCOVERED',
  'BOSS_INTRO',
  'BOSS_PHASE_1',
  'BOSS_PHASE_2',
  'BOSS_PHASE_3',
  'BOSS_DEFEATED',
  'TRUTH_REVEAL',
  'HOSTAGE_RELEASE',
  'EXTRACTION',
  'MISSION_COMPLETE',
  'PLAYER_DEAD',
  'RESTARTING',
];

/** Checkpoints the player can be returned to after a death. */
export type Checkpoint =
  | 'EXTERIOR_ENTRY'
  | 'GATEKEEPER_DEFEATED'
  | 'FACTORY_ENTRY'
  | 'BOSS_INTRO';

/**
 * Which checkpoint each state rolls back to.
 *
 * Deliberately coarse - four points across an 8-15 minute slice. A checkpoint
 * every beat would remove all tension from the boss; a single one at the start
 * would make a phase-3 death infuriating.
 */
export const CHECKPOINT_OF: Record<MissionState, Checkpoint> = {
  BOOT: 'EXTERIOR_ENTRY',
  BRIEFING: 'EXTERIOR_ENTRY',
  EXTERIOR_ENTRY: 'EXTERIOR_ENTRY',
  EXTERIOR_COMBAT: 'EXTERIOR_ENTRY',
  GATEKEEPER_INTRO: 'EXTERIOR_ENTRY',
  GATEKEEPER_ACTIVE: 'EXTERIOR_ENTRY',
  GATEKEEPER_DEFEATED: 'GATEKEEPER_DEFEATED',
  ACCESS_MODULE_DROPPED: 'GATEKEEPER_DEFEATED',
  ACCESS_MODULE_ACQUIRED: 'GATEKEEPER_DEFEATED',
  GATE_TERMINAL_ACTIVE: 'GATEKEEPER_DEFEATED',
  GATE_OPENING: 'GATEKEEPER_DEFEATED',
  FACTORY_ENTRY: 'FACTORY_ENTRY',
  INTERIOR_APPROACH: 'FACTORY_ENTRY',
  HOSTAGES_DISCOVERED: 'FACTORY_ENTRY',
  BOSS_INTRO: 'BOSS_INTRO',
  BOSS_PHASE_1: 'BOSS_INTRO',
  BOSS_PHASE_2: 'BOSS_INTRO',
  BOSS_PHASE_3: 'BOSS_INTRO',
  BOSS_DEFEATED: 'BOSS_INTRO',
  TRUTH_REVEAL: 'BOSS_INTRO',
  HOSTAGE_RELEASE: 'BOSS_INTRO',
  EXTRACTION: 'BOSS_INTRO',
  MISSION_COMPLETE: 'BOSS_INTRO',
  PLAYER_DEAD: 'EXTERIOR_ENTRY',
  RESTARTING: 'EXTERIOR_ENTRY',
};

/**
 * States in which the player has full control.
 *
 * Everything else either has no player yet (BOOT/BRIEFING), is a scripted beat
 * that still allows looking around (the reveal), or is an end card. There is no
 * state in this slice that removes control for more than a few seconds - the
 * brief forbids long uncontrollable cutscenes and this is where that is
 * enforced rather than remembered.
 */
export const PLAYABLE: ReadonlySet<MissionState> = new Set<MissionState>([
  'EXTERIOR_ENTRY',
  'EXTERIOR_COMBAT',
  'GATEKEEPER_INTRO',
  'GATEKEEPER_ACTIVE',
  'GATEKEEPER_DEFEATED',
  'ACCESS_MODULE_DROPPED',
  'ACCESS_MODULE_ACQUIRED',
  'GATE_TERMINAL_ACTIVE',
  'GATE_OPENING',
  'FACTORY_ENTRY',
  'INTERIOR_APPROACH',
  'HOSTAGES_DISCOVERED',
  'BOSS_PHASE_1',
  'BOSS_PHASE_2',
  'BOSS_PHASE_3',
  'HOSTAGE_RELEASE',
  'EXTRACTION',
]);

/** States during which hostiles may engage. */
export const COMBAT_ACTIVE: ReadonlySet<MissionState> = new Set<MissionState>([
  'EXTERIOR_COMBAT',
  'GATEKEEPER_INTRO',
  'GATEKEEPER_ACTIVE',
  'ACCESS_MODULE_DROPPED',
  'ACCESS_MODULE_ACQUIRED',
  'GATE_TERMINAL_ACTIVE',
  'GATE_OPENING',
  'INTERIOR_APPROACH',
  'HOSTAGES_DISCOVERED',
  'BOSS_PHASE_1',
  'BOSS_PHASE_2',
  'BOSS_PHASE_3',
]);

/** HUD objective text per state. Empty means "leave the previous objective". */
export const OBJECTIVE_OF: Partial<Record<MissionState, string>> = {
  EXTERIOR_ENTRY: 'BREACH THE PERIMETER',
  EXTERIOR_COMBAT: 'CLEAR THE YARD',
  GATEKEEPER_INTRO: 'DESTROY THE GATE UNIT',
  GATEKEEPER_ACTIVE: 'DESTROY THE GATE UNIT',
  ACCESS_MODULE_DROPPED: 'RECOVER THE ACCESS MODULE',
  ACCESS_MODULE_ACQUIRED: 'RETURN TO THE LOADING SHUTTER',
  GATE_TERMINAL_ACTIVE: 'INSERT THE ACCESS MODULE',
  GATE_OPENING: 'STAND CLEAR',
  FACTORY_ENTRY: 'ENTER THE FABRICATION FLOOR',
  INTERIOR_APPROACH: 'ADVANCE TO CENTRAL CONTROL',
  HOSTAGES_DISCOVERED: 'REACH CENTRAL CONTROL',
  BOSS_INTRO: 'SURVIVE',
  BOSS_PHASE_1: 'DESTROY THE POWER RELAYS',
  BOSS_PHASE_2: 'DESTROY THE COOLANT STACK',
  BOSS_PHASE_3: 'DESTROY THE AI CORE',
  TRUTH_REVEAL: '',
  HOSTAGE_RELEASE: 'RELEASE THE SURVIVORS',
  EXTRACTION: 'RETURN TO THE SHUTTER',
  MISSION_COMPLETE: 'MISSION COMPLETE',
};
