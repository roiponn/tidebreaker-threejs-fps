# Mission state machine

`MissionStateMachine`だけがcurrent stateを書き換える。Game、敵、端末、ボスはflagsを更新するか、合法遷移をrequestするだけである。通常遷移、死亡、リスタートには優先度があり、死亡が同フレームの進行完了より優先される。

```text
BOOT -> BRIEFING -> EXTERIOR_ENTRY -> EXTERIOR_COMBAT
 -> GATEKEEPER_INTRO -> GATEKEEPER_ACTIVE -> GATEKEEPER_DEFEATED
 -> ACCESS_MODULE_DROPPED -> ACCESS_MODULE_ACQUIRED
 -> GATE_TERMINAL_ACTIVE -> GATE_OPENING -> FACTORY_ENTRY
 -> INTERIOR_APPROACH -> HOSTAGES_DISCOVERED -> BOSS_INTRO
 -> BOSS_PHASE_1 -> BOSS_PHASE_2 -> BOSS_PHASE_3 -> BOSS_DEFEATED
 -> TRUTH_REVEAL -> HOSTAGE_RELEASE -> EXTRACTION -> MISSION_COMPLETE

任意の生存中state -> PLAYER_DEAD -> RESTARTING -> 保存checkpoint
```

## 入力権限

各stateは `look / move / fire / interact` を個別に所有する。イントロとボス導入はlookのみ、TRUTH_REVEALもlookのみ、戦闘はfire可、操作物のないボス中はinteract不可。pointer lockはlookだけを制御し、mission timeやstate遷移のゲートにはしない。

## チェックポイント復元

- EXTERIOR_ENTRY: 全ロボット、ゲート、ボス、物資を初期化
- GATEKEEPER_DEFEATED: 外周排除済み、モジュール取得扱い、端末前へ
- FACTORY_ENTRY: 外周排除済み、モジュール取得/ゲート開放、屋内敵は復活
- BOSS_INTRO: 全雑魚排除済み、ゲート開放、WARDEN-03を完全再構築

Wardenはphase 3で装甲meshをreparentするため、数値だけでなくrigを再生成する。flags objectはidentityを維持してin-place restoreする。

## 診断

`?mission=<STATE>`は `CHECKPOINT_OF` に基づく世界復元後にdebug forceする。bodyの `data-mission-state`、`data-checkpoint`、`data-mission-flags` で孤立ブラウザからも確認できる。
