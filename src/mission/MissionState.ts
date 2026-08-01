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

/**
 * Input capabilities are authored per mission state rather than collapsed into
 * a single "playable" boolean. Story beats such as the truth reveal still let
 * the player look around, while death and restart suppress every action.
 */
export interface MissionInputPermissions {
  readonly look: boolean;
  readonly move: boolean;
  readonly fire: boolean;
  readonly interact: boolean;
}

const NO_INPUT: MissionInputPermissions = Object.freeze({
  look: false,
  move: false,
  fire: false,
  interact: false,
});

const LOOK_ONLY: MissionInputPermissions = Object.freeze({
  look: true,
  move: false,
  fire: false,
  interact: false,
});

const FULL_CONTROL: MissionInputPermissions = Object.freeze({
  look: true,
  move: true,
  fire: true,
  interact: true,
});

const CONTROL_NO_INTERACT: MissionInputPermissions = Object.freeze({
  look: true,
  move: true,
  fire: true,
  interact: false,
});

/** The only source of truth for which input families a state permits. */
export const INPUT_OF: Readonly<Record<MissionState, MissionInputPermissions>> = {
  BOOT: NO_INPUT,
  BRIEFING: NO_INPUT,
  EXTERIOR_ENTRY: LOOK_ONLY,
  EXTERIOR_COMBAT: FULL_CONTROL,
  GATEKEEPER_INTRO: CONTROL_NO_INTERACT,
  GATEKEEPER_ACTIVE: CONTROL_NO_INTERACT,
  GATEKEEPER_DEFEATED: FULL_CONTROL,
  ACCESS_MODULE_DROPPED: FULL_CONTROL,
  ACCESS_MODULE_ACQUIRED: FULL_CONTROL,
  GATE_TERMINAL_ACTIVE: FULL_CONTROL,
  GATE_OPENING: CONTROL_NO_INTERACT,
  FACTORY_ENTRY: FULL_CONTROL,
  INTERIOR_APPROACH: FULL_CONTROL,
  HOSTAGES_DISCOVERED: FULL_CONTROL,
  BOSS_INTRO: LOOK_ONLY,
  BOSS_PHASE_1: CONTROL_NO_INTERACT,
  BOSS_PHASE_2: CONTROL_NO_INTERACT,
  BOSS_PHASE_3: CONTROL_NO_INTERACT,
  BOSS_DEFEATED: LOOK_ONLY,
  TRUTH_REVEAL: LOOK_ONLY,
  HOSTAGE_RELEASE: FULL_CONTROL,
  EXTRACTION: FULL_CONTROL,
  MISSION_COMPLETE: NO_INPUT,
  PLAYER_DEAD: NO_INPUT,
  RESTARTING: NO_INPUT,
};

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
  ...MISSION_ORDER.filter((state) => INPUT_OF[state].move),
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
  EXTERIOR_ENTRY: '外周を突破せよ',
  EXTERIOR_COMBAT: '港湾ヤードの敵を排除せよ',
  GATEKEEPER_INTRO: 'GATEKEEPERを撃破せよ',
  GATEKEEPER_ACTIVE: 'GATEKEEPERを撃破せよ',
  ACCESS_MODULE_DROPPED: '発光するアクセスモジュールを回収せよ',
  ACCESS_MODULE_ACQUIRED: '搬入口シャッターへ戻れ',
  GATE_TERMINAL_ACTIVE: 'アクセスモジュールを端末へ挿入せよ',
  GATE_OPENING: 'シャッターから離れろ',
  FACTORY_ENTRY: '製造フロアへ進入せよ',
  INTERIOR_APPROACH: '中央制御室へ進め',
  HOSTAGES_DISCOVERED: '中央制御室へ到達せよ',
  BOSS_INTRO: '攻撃を生き延びろ',
  BOSS_PHASE_1: '電力リレーを破壊せよ',
  BOSS_PHASE_2: '冷却装置を破壊せよ',
  BOSS_PHASE_3: 'AIコアを破壊せよ',
  TRUTH_REVEAL: '',
  HOSTAGE_RELEASE: '生存者を解放せよ',
  EXTRACTION: 'シャッターへ戻れ',
  MISSION_COMPLETE: '任務完了',
};
