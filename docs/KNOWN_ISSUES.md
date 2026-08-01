# Known issues

| ID | 重要度 | 内容 | 所在 |
| --- | --- | --- | --- |
| G1 | High | 通常操作による8〜15分通しクリア、GATEKEEPER/各boss phaseの実撃破は未検証 | 全体 |
| G2 | Medium | Gatekeeperの移動collisionは初期spawn boxのまま。wreck blockerとしては働くが、前進中の接触が不正確 | `GatekeeperController.ts` |
| G3 | Medium | robot AIは固定strafe laneでcover/flank/navigationなし | `RobotEnemyManager.ts` |
| G4 | Medium | debug `ACCESS_MODULE_DROPPED` jumpはsoft-lock回避のため取得済みflagを持ち、実pickup検証には不向き | `Game.ts` |
| V1 | Medium | factory shellの大面積壁と天井はprop/material variationが少ない | `FactoryMission.ts` |
| V2 | Medium | rigid-part robot/bossにskinning、cloth、IKなし | `enemies/robots`, `bosses` |
| V3 | Low | decalsはprojectedではなくnormal-offset quad | `DecalSystem.ts` |
| V4 | Low | motion blurはcamera approximationでobject velocityなし | `CompositeShader.ts` |
| P1 | High unknown | 実GPU 1080p 55–60fps未検証。自動ブラウザ値は採用不可 | — |
| P2 | Medium | forward lightsが20、planar reflectionが追加scene pass | `Practicals.ts`, `WetGround.ts` |
| X1 | Low | WebGL2 desktop only。touch/gamepadなし | platform |
| X2 | Low | soft lockはcursorがwindow端へ達するとmouse lookが制限される | `Input.ts` |

修正済みの重大項目は `QUALITY_REPORT.md` に検証方法付きで残している。
