# Codex handover

## 現在地

旧90秒港湾sliceを、外周→工場→WARDEN-03→真相→救出までの8〜15分story FPSへ拡張した。`npm run typecheck`と`npm run build`は成功。Codex browserで通常briefing開始、全主要debug state、forced ADS、真相表示、結果画面、exterior/boss checkpoint retry、長時間boss updateを確認済み。

## 最初に読む順

1. `README.md`
2. `docs/STATE_MACHINE.md`
3. `docs/MISSION_FLOW.md`
4. `docs/BOSS_DESIGN.md`
5. `docs/QUALITY_REPORT.md`
6. `docs/MANUAL_TEST_CHECKLIST.md`

## Authorityと所有

- `Game`はsystem lifecycleと固定frame orderを所有。
- `MissionStateMachine`だけがstateをcommit。
- `MissionGraph`は遷移条件とstory beatだけを所有。
- enemy/boss/factoryはEventBusとflagsで連携し、stateを直接書かない。
- `HarborLevel`は`FactoryMission`を所有し、update/disposeを二重に呼ばない。
- `Ballistics`だけがworld/robot/bossのnearest-hitを決定。

## 壊してはいけない要素

1. `installFogPatch()`をmaterial compileより先に呼ぶ。
2. `Game.renderFrame`の3 player → 4 weapon → 7 VFX順。
3. mission state updateはstep 9で1回。
4. pointer lockをmission progressの条件にしない。
5. forced ADSの`shotArmed`をsprint/reloadで捨てない。
6. Wardenのprotected volume constraintを削除しない。
7. checkpoint復帰要求時の先行world restoreを外さない。
8. boss resetではrigを再構築する。
9. 工場建物と既存港湾を別レベルへ置換しない。

## Debug

`?mission=<MissionState>`、`?god=1`、`?dead=1`、`?enemytrace=1`、`?weapontrace=1`を使用する。world state込みのjumpは `Game.debugJumpTo()`。`data-mission-state/checkpoint/mission-flags/boss-phase/stats`は自動ブラウザでも読める。

## 実装上の注意

- Gatekeeperはboot時に1回spawnし、通常はgroupをhide。CollisionWorldにremoveBoxがないためspawnを繰り返さない。
- GATEKEEPER_DEFEATED checkpointは再度pickupを要求せずmodule acquired扱いにする。
- BOSS_INTRO checkpointは外周/屋内robotをclearし、Wardenを完全reset。
- factory gate/hostage doorはcollision handleのsolidをanimation progressで切り替える。
- boss visual explosionは`damagesPlayer:false`。通常drumだけplayer blast damageを適用。
- factoryは実照明3灯を追加しscene合計20。追加前に実GPU計測。

## 次に行うべき作業

1. `MANUAL_TEST_CHECKLIST`の通常通しを実施し、敵HP/弾薬/所要時間を調整。
2. Gatekeeper dynamic collision boundsを実装。
3. dedicated boss/robot audio hooksを接続。
4. 人質解放後の短い退避演技を追加。
5. 実GPU 1080p profile後にfactory lights/planar reflectionを最適化。
6. DebugPanelへMissionState dropdownとgod toggleを追加（URL機能は既にある）。
7. Gameの長いevent wiringをbindings単位へ分割。

## Git/作業場所

引き継ぎ用の編集対象は `/Users/hataikosuke/Documents/New project/COD Opus`。元のDesktopコピーは変更していない。作業treeには本拡張の未commit差分があるため、次担当は最初に`git status --short`と`git diff --check`を確認する。
