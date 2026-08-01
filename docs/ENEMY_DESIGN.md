# Enemy design

## SCOUT

小型浮遊監視機。48HP、反応と横移動が速く、2発バースト、弱点半径は小さい。ローター、警戒灯、上下動で遠距離でも役割を読む。高所と側面で視線を分散させる。

## SENTINEL

大型産業警備機。150HP、移動と旋回は遅いが4発バースト。車体への通常ダメージを抑え、頭部センサー弱点を狙わせる。遮蔽物を固定レーンで圧迫する。

## AI範囲

`RobotEnemyManager`はidle → alert → tracking/firing → dying/deadを管理する。各機はhome/patrolTo間だけを移動し、視線判定後に射撃する。外周と屋内のzoneを持ち、チェックポイント復帰時にzone単位で排除済み状態へできる。

これはnavmesh、動的カバー選択、分隊戦術を持たない意図的に軽い縦切りAIである。次の拡張は、役割別のカバー予約、GATEKEEPERとの連携、音への反応を優先する。

## 射撃統合

`Ballistics`はworld、robot、GATEKEEPER、WARDEN-03を同じrayで問い合わせ、最短1件だけを解決する。同距離ではworldを優先し、壁越し命中を防ぐ。弱点、hitmarker、tracer、命中統計は共通経路。

## 検証

`?enemytrace=1`で `data-enemies` を確認する。`?mission=EXTERIOR_COMBAT`、`FACTORY_ENTRY`で各zone、`?god=1`で被弾を無視してAIの発見・射撃を観察できる。
