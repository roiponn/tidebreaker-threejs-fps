# Boss design

## GATEKEEPER

単なる高HP敵ではなく、6.5秒のshielded barrageと3.4秒のvent windowを繰り返す。正面shieldは6%、側背面hullは15%だけ通り、hull命中は排熱を早める。vent中の発光coilは100%ダメージ。シールドの輪郭変化、cyan発光、beacon反転、蒸気、event audio hookで窓を伝える。

撃破途中にアクセスモジュールを物理的に落とす。回収後だけ工場端末を操作できる。

## WARDEN-03

救助機を戦闘機械として読ませる3段階戦。

| Phase | 弱点 | 攻撃/変化 | 意味 |
| --- | --- | --- | --- |
| 1 SEALED | 2基のpower relay | sweep、slam、foam | 封鎖と排除 |
| 2 OVERHEAT | coolant stack | slam、foam、torch、周期purge | 熱予算を使い切る |
| 3 EMERGENCY POWER | exposed core | sweep、slam、直線charge、装甲投棄 | 自分を消耗して保護継続 |

各攻撃は0.75秒以上のwind-up、実攻撃、punish recoveryを持つ。slamはjump可能な可視shock ring、foamはcone外へ、sweepはcrouch、chargeは横回避。

## 物語制約

人質区画は `protectedVolume`。WARDEN-03は攻撃体積がそこへ触れる選択を拒否し、人質をplayer射線のbackstopにしない。これは見た目だけの設定ではなくattack selectionとstand positionの制約。

## 強制ADS

MK-7にはhip fireがない。短い左クリックも `shotArmed` に保持し、ADS完了後に1発出る。スプリント/リロード中も入力を捨てず、可能になった時点で発射する。ボス弱点のサイズとpurge punish windowはこの制約を前提にしている。

## リセット/デバッグ

`Warden03Controller.reset()`はrig、relay、coolant、core、投棄装甲、particle、attackを再構築する。`?mission=BOSS_PHASE_1|2|3`は対応する外装と弱点へ直接復元する。`?mission=BOSS_DEFEATED`は真相直前。
