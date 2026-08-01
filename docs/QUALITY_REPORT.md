# Strict quality report

完成を前提にしない評価。優先度はP0（進行不能）〜P3（磨き込み）。

| 問題箇所 | 原因 | 優先度 | 修正方法 | 対象ファイル | 検証方法 |
| --- | --- | --- | --- | --- | --- |
| 工場最深部でbossが黒く沈んだ | emissive fixtureだけで実照明が入口1灯のみ | P1→修正済 | 3区画に実strip lightを1灯ずつ追加 | `HarborLevel.ts` | phase 3 screenshot、lights=20 |
| Warden攻撃終了frameで例外 | attack logicが`this.attack=null`後にkindを再読 | P0→修正済 | committed attackをlocal保持 | `Warden03Controller.ts` | phase 3を16秒連続実行、以後console error 0 |
| checkpoint復帰で旧gate/hostage flagsが戻る | restart requestとworld restoreの間に1frameあった | P0→修正済 | retry click時にworldを先行復元 | `Game.ts` | exterior/boss retryでflags確認 |
| 工場の大面積壁が単純な箱に見える | procedural vertical sliceでprop密度とmaterial variationが限定 | P2 | 配管、標識、保守足場、汚れdecalをzone別追加 | `FactoryMission.ts` | 3方向の通常プレイcapture |
| SCOUT/SENTINELの動きがAI生成的に反復 | 2点strafe laneのみ、cover/coordinationなし | P2 | role別cover graphとsquad reservations | `RobotEnemyManager.ts` | 同一戦闘3回のstate trace比較 |
| 人質救出の身体的反応が弱い | 解放後は向きとdoorだけ変化 | P2 | 退避walk、声、個別反応を短く追加 | `FactoryMission.ts`, `AudioEngine.ts` | release後30秒を動画確認 |
| 真相UIが22秒固定 | 読書速度/言語差へ適応しない | P2 | 最低表示時間後Fで送れる段階UI | `TruthReveal.ts`, `MissionGraph.ts` | fast/slow reader test |
| Gatekeeper collisionがspawn位置固定 | dynamic collision boxの移動APIがない | P1 | CollisionWorldにbox bounds更新を追加 | `GatekeeperController.ts`, `CollisionWorld.ts` | advancing bossへ接触しwalk-throughしないか |
| boss/robot audio vocabularyが薄い | event hookはあるが専用音の多くが未接続 | P2 | shield/vent/relay/purge/foot専用procedural voice追加 | `AudioEngine.ts`, `Game.ts` | audio-only playtest |
| 弱点HUDとobjectiveが上部で密集 | boss bar、objective、counterが同じ帯域 | P2 | boss中objectiveをbar下へ統合 | `Hud.ts`, `styles.css` | 16:9/16:10 screenshot |
| 20 forward lights | 工場可読性を実照明で回復 | P1 unknown | 実GPU計測後、必要なら2灯をlight probe風materialへ | `HarborLevel.ts`, `Practicals.ts` | 1080p GPU capture |
| 通常8〜15分の通し完了が未検証 | 自動ブラウザでは長時間の照準戦闘が不適 | P1 | human playthrough checklist実施 | 全体 | `MANUAL_TEST_CHECKLIST.md` |

## 良くなった点と限界

外周/屋内/bossのsilhouette差、GATEKEEPERの時間窓、WARDENのphase別弱点、工場のsource-driven light、透明隔離区画によって読み分けは成立した。一方、procedural rigid-partモデル、合成音、固定lane AIはAAA最終品質ではない。次の効果が大きい投資はアセット量の増加より、専用音、cover AI、人質の演技、実GPU計測である。
