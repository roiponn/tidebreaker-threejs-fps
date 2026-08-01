# Mission flow

| 区間 | 主な行動 | 完了条件 | チェックポイント |
| --- | --- | --- | --- |
| Briefing / insertion | 作戦確認、短い一人称導入 | 導入タイマー終了 | EXTERIOR_ENTRY |
| Exterior combat | SCOUT/SENTINELを排除 | 外周残存数が3以下 | EXTERIOR_ENTRY |
| GATEKEEPER | 側面を取り、排熱時にコイル攻撃 | GATEKEEPER撃破 | GATEKEEPER_DEFEATED |
| Access module / gate | Fで回収、外部端末へ挿入 | シャッター開放 | GATEKEEPER_DEFEATED |
| Loading / manufacturing | 工場侵入、設備危険とロボット戦 | 屋内ロボット全排除、中央制御到達 | FACTORY_ENTRY |
| Hostage discovery | 透明隔離区画と3名確認 | ボスアリーナ到達 | FACTORY_ENTRY |
| WARDEN-03 | relay → coolant → core | 3段階弱点破壊 | BOSS_INTRO |
| Truth reveal | 事故記録を読む。lookのみ可能 | 22秒の再生終了 | BOSS_INTRO |
| Release / extraction | Fで人質解放、シャッターへ戻る | 工場入口へ到達 | BOSS_INTRO |

`Game.renderFrame()`のstep 9で世界からフラグを採取し、MissionDirectorを1回だけ更新する。状態変更を同フレームに多重評価せず、次状態の条件は次フレームで読む。

重要な操作物:

- アクセスモジュール: GATEKEEPER死亡途中に物理オブジェクトとして落下。2.6m以内でF。
- ゲート端末: モジュール取得後のみready。Fでシャッターのsolid collisionを徐々に解除。
- 人質解放端末: WARDEN-03撃破後のみready。
- 危険設備: ロボットアーム、蒸気、コンベア。予備動作とactive contactを分離。
