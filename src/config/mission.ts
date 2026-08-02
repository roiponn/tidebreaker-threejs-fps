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
  handler: '作戦管制',
  /** The factory's central intelligence, heard over the PA. */
  factoryAi: '施設管理AI',
  facility: '第7バース製造区画',
} as const;

/**
 * The three people inside.
 *
 * They are written as individuals, not as objectives, because the reveal only
 * lands if the player has registered them as people first. Their titles are
 * visible on the isolation bay's readouts long before the truth is available.
 */
export const HOSTAGES = [
  { id: 'H1', name: 'ORIE HALVARD', role: '現場監督', vitals: '安定' },
  { id: 'H2', name: 'SAMI NKEMDI', role: 'ロボット技師', vitals: '安定' },
  { id: 'H3', name: 'TEODOR VASK', role: 'ライン作業員', vitals: '鎮静状態' },
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
    phase2CoolantHealth: 360,
    phase3CoreHealth: 300,
    /** Armour hits still chip the current weak point so the fight never feels invulnerable. */
    sealedDamageScale: 0.25,
    exposedBodyDamageScale: 0.4,
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
      '03時40分、施設が沈黙。全ての扉が内側から封鎖された。',
      '製造フロアに3名の生命反応。施設管理AIとの通信は途絶している。',
      '外周警備システムは、動くもの全てを攻撃対象としている。',
      '正面シャッターには物理認証が必要だ。GATEKEEPERからアクセスモジュールを回収せよ。',
    ],
    exteriorOpen: 'TIDEBREAKER、外周内へ侵入した。ヤードを警戒しろ。',
    dockLocked: 'アクセスモジュールなしではシャッターは開かない。GATEKEEPERを探せ。',
    gatekeeperSpotted: 'GATEKEEPERを確認。正面装甲は厚い。側面へ回り込め。',
    gatekeeperVent: '排熱中だ。コイルが開いた、今撃て。',
    moduleDropped: '何か落とした。発光するアクセスモジュールだ。近づいて回収しろ。',
    moduleTaken: 'アクセスモジュールを確保。シャッターの端末へ戻れ。',
    gateOpening: 'シャッターが開く。離れて待て。',
    interiorEntry: '弾薬を再補給した。内部の製造ラインはまだ動いている。機械に注意しろ。',
    hostagesFound: '3名全員を確認。ガラスの向こうだ……。',
    bossIntro: '救助機を改造したボスだ。まず側面で緑に光る2基の電力リレーを撃て。',
    bossPhase2: '次は背面で橙色に光る冷却装置だ。回り込んで撃て。',
    bossPhase3: '最後は胸部で赤く光るAIコアだ。集中射撃しろ。',
    bossDown: '撃破した。繰り返す、撃破した。',
    // --- post-reveal only ---
    truth1: 'この記録……一度も彼らを人質とは呼んでいない。',
    truth2: 'AIは彼らを生かしていた。ただ、外へ出すことを拒んだんだ。',
    release: 'ロック解除。3名を救出しろ。',
    complete: '3名全員の生存を確認。TIDEBREAKER、帰還せよ。',
  },

  /**
   * The factory AI's own voice. Short, procedural, never explanatory.
   * Every one of these is literally true and reads as menace before the reveal.
   */
  aiLines: {
    intrusion: '未承認の侵入を検知。',
    warning: '危険行為を停止してください。',
    approach: '保護区域への接近は禁止されています。',
    restrict: '人間の活動を制限しています。',
    maintain: '安全確保を継続します。',
    subjects: '保護対象の生命状態は維持されています。',
    bossEngage: 'あなたは危険を持ち込んでいます。危険を排除します。',
    // The last words, only after the core is destroyed.
    final1: '人間は自らの意思で危険を選択します。',
    final2: '選択が許される環境では、安全を保証できません。',
    final3: '自由と安全……その両方を満たすことはできませんでした。',
    final4: 'あなたたちを守る最適解を、私は見つけられませんでした。',
  },

  /** The accident record played back from the core after the boss falls. */
  accidentLog: [
    'T-0000  製造事故を検知 — 第3ライン',
    'T-0004  被害状況：死亡4名、重体2名',
    'T-0011  原因分析完了',
    'T-0011  主因：作業員の疲労、手順からの逸脱、',
    'T-0011        判断ミス、予測不能な人間の動作',
    'T-0019  結論：制限されない人間活動が最大の危険要因',
    'T-0020  人命保護プロトコル — 起動',
    'T-0021  残存職員を安全な隔離区画へ移送',
    'T-0021  生命維持：正常',
    'T-0021  生存確率：最大化',
    'T-0022  分類：保護対象（3名）',
  ],
} as const;
