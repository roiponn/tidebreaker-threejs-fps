# TIDEBREAKER — Berth 7 Fabrication Lockdown

Three.js + TypeScript + Viteで作られた、オリジナルの一人称ストーリーFPS縦切りです。
雨の港湾外周から長い既存工場へ侵入し、3人の生存者と彼らを「保護」していた物理AIの真相に到達します。想定プレイ時間は8〜15分です。

**プレイ:** <https://tidebreaker-fps.vercel.app>

既存港湾、レンダリング、武器感触を維持しつつ、外周のヒューマノイド警備ロボット戦、工場内ロボット戦、GATEKEEPER、アクセスモジュール、3区画の工場、人質区画、WARDEN-03三段階戦、真相開示、チェックポイントを追加しています。特定の市販FPS作品の著作物は使用していません。

## 実行

```bash
npm install
npm run dev
```

<http://localhost:5173> を開き、`CLICK TO BEGIN INSERTION`を押します。

```bash
npm run typecheck
npm run build
npm run preview
```

WebGL 2対応ブラウザが必要です。PCではpointer lockが拒否された場合にsoft lockへ移り、ミッション進行は停止しません。スマートフォン／タブレットではタッチ操作が自動表示され、負荷を抑えた品質設定で開始します。横向きプレイを推奨します。

## 操作

| 入力 | 操作 |
| --- | --- |
| WASD | 移動 |
| Mouse | 視点 |
| 左クリック | 射撃。照準していなくても自動的にADSし、照準完了後に発射 |
| 右クリック | ADS |
| Shift | 前方スプリント |
| Ctrl / C | しゃがみ |
| Space | ジャンプ |
| R | リロード |
| F | モジュール回収 / 端末操作 / 人質解放 |
| H | HUD表示切替 |
| ` | デバッグパネル |
| P | リスタート |
| Esc | マウス解放 |

### スマートフォン／タブレット

| タッチ入力 | 操作 |
| --- | --- |
| 左スティック | 移動。前方へ深く倒すとスプリント |
| 右画面スワイプ | 視点操作 |
| FIRE / ADS | 射撃 / 照準 |
| JUMP / RLD / USE | ジャンプ / リロード / 操作 |
| C | しゃがみ切替 |

GATEKEEPER撃破後のアクセスモジュールは、画面マーカーを追い、発光している部品へ近づいて取得します。PCでは近距離で`F`、スマホでは`USE`。真上まで歩けば自動取得されます。

## ミッション

`BRIEFING → EXTERIOR_COMBAT → GATEKEEPER → ACCESS_MODULE → GATE_OPENING → FACTORY_ENTRY → INTERIOR_APPROACH → HOSTAGES_DISCOVERED → WARDEN-03 PHASE 1/2/3 → TRUTH_REVEAL → HOSTAGE_RELEASE → EXTRACTION → MISSION_COMPLETE`

死亡時は `EXTERIOR_ENTRY`、`GATEKEEPER_DEFEATED`、`FACTORY_ENTRY`、`BOSS_INTRO` の最新地点へ復帰します。

## デバッグURL

| URLパラメータ | 用途 |
| --- | --- |
| `?mission=BOSS_PHASE_1` | 任意のMissionStateへ世界状態込みで直接遷移 |
| `?mission=BOSS_PHASE_2` / `BOSS_PHASE_3` | ボスの該当弱点・外装状態を復元 |
| `?mission=TRUTH_REVEAL` | 真相開示を直接再生 |
| `?mission=HOSTAGE_RELEASE` | 解放端末直前へ移動 |
| `?mission=MISSION_COMPLETE` | 結果画面を確認 |
| `?mission=BOSS_PHASE_1&dead=1` | ボスチェックポイント死亡復帰の検証 |
| `?god=1` | 無敵 |
| `?enemytrace=1` | ロボット/GATEKEEPER状態をbody datasetへ出力 |
| `?weapontrace=1` | ADS・武器姿勢をbody datasetへ出力 |
| `?skipintro=1` | 導入演出をスキップ |
| `?boom=N`, `?boomhold=L`, `?chaintest=N` | 爆発/連鎖の決定論的検証 |
| `?quality=low\|medium\|high` | 品質プリセット固定 |

常時診断値: `data-mission-state`、`data-checkpoint`、`data-mission-flags`、`data-boss-phase`、`data-stats`。開発ビルドでは `window.tidebreaker.debugJumpTo(state)` も利用できます。

## 構成

- `src/app/Game.ts`: 全システム所有、固定フレーム順、状態と世界の統合
- `src/mission/`: 唯一のMissionStateMachine、遷移表、チェックポイント
- `src/enemies/RobotEnemyManager.ts`: SCOUT/SENTINELのAI、命中、リセット
- `src/bosses/`: GATEKEEPERとWARDEN-03
- `src/environment/HarborLevel.ts`: 既存港湾と工場シェル
- `src/environment/FactoryMission.ts`: ゲート、工場3区画、危険設備、人質区画
- `src/story/TruthReveal.ts`: ボス後の事故記録再生
- `src/weapons/`: 強制ADS武器と統合Ballistics
- `src/core/RenderSystem.ts`: 既存のworld/view-model/post-process描画

## 文書

- [MISSION_FLOW](docs/MISSION_FLOW.md) / [STATE_MACHINE](docs/STATE_MACHINE.md)
- [STORY](docs/STORY.md) / [ENEMY_DESIGN](docs/ENEMY_DESIGN.md) / [BOSS_DESIGN](docs/BOSS_DESIGN.md)
- [RENDERING](docs/RENDERING.md) / [PERFORMANCE](docs/PERFORMANCE.md)
- [QUALITY_REPORT](docs/QUALITY_REPORT.md) / [MANUAL_TEST_CHECKLIST](docs/MANUAL_TEST_CHECKLIST.md)
- [HANDOVER](docs/HANDOVER.md) / [KNOWN_ISSUES](docs/KNOWN_ISSUES.md)

すべてのモデル、テクスチャ、音はコード生成です。依存ライブラリはthree、lil-gui、Vite、TypeScriptで、アート/音声の外部バイナリアセットはありません。
