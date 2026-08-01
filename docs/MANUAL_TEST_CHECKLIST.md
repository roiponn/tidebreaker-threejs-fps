# Manual test checklist

## 自動/決定論的に実施済み（2026-08-01）

- [x] node_modulesなしの作業コピーで`npm install`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] 新規session boot、briefing表示
- [x] briefing clickからEXTERIOR_ENTRY、EXTERIOR_COMBATへ遷移
- [x] pointer lock unavailable時のsoft-lockと再取得hint
- [x] trusted browser click後、forced ADSを経てammoが減ること
- [x] `?mission=GATEKEEPER_ACTIVE`
- [x] `?mission=BOSS_PHASE_1/2/3`でworld/weak-point phase一致
- [x] Warden phase 3を16秒連続更新
- [x] `TRUTH_REVEAL`がboss flags後にだけ表示されるdebug path
- [x] `EXTRACTION`と`MISSION_COMPLETE`のflags/end card
- [x] `PLAYER_DEAD`からEXTERIOR_ENTRY retry
- [x] `BOSS_PHASE_1&dead=1`からBOSS_INTRO retry
- [x] retry後にgate/hostage旧flagが残らない
- [x] complete end cardからreturn to briefingし、全主要flagが初期化される
- [x] 最終テスト区間でconsole error 0
- [x] draw calls / triangles / lights datasetの取得

上記boss/ending項目はdebug直接遷移または決定論的死亡注入であり、通常戦闘で撃破した証明ではない。

## 人間が通常ブラウザで確認する項目

- [ ] briefingから8〜15分の通しクリア
- [ ] real pointer lock取得、Esc、再取得
- [ ] WASD、jump、crouch、sprint、壁/ゲートcollision
- [ ] 右ADS、短い左click、hold fire、sprint中click、reload中click
- [ ] reload animation/audio/ammo
- [ ] SCOUT/SENTINEL発見、反撃、弱点、死亡
- [ ] player被弾方向、health regen、通常死亡
- [ ] 外周弾薬量とGATEKEEPERまでの戦闘密度
- [ ] GATEKEEPER shield/vent tell、実撃破、module落下/回収
- [ ] Fでgate terminal、opening中collision、factory entry
- [ ] loading/manufacturing hazardsのtelegraphとdamage
- [ ] 屋内robot全排除がboss進行条件になること
- [ ] 人質3名の視認、氏名/生命維持の読みやすさ
- [ ] Warden phase 1 relays実破壊
- [ ] phase 2 coolant/purge実破壊
- [ ] phase 3 core実破壊
- [ ] sweep crouch、slam jump、foam strafe、charge sidestep
- [ ] bossが人質方向へ攻撃しないこと
- [ ] 真相22秒の可読性と唐突さ
- [ ] Fで人質解放、door collision解除、帰路、通常complete
- [ ] 各checkpointで3回以上死亡し同じ状態へ戻ること
- [ ] return to briefing後、通常操作で2周目を通しクリア
- [ ] 30分連続でparticles/lights/memoryが増え続けないこと
- [ ] 1080p high/medium/lowのfps、frame time、GPU memory
- [ ] headphones/speakersでrobot/boss/audio mix

## 不具合記録テンプレート

`state / checkpoint / URL / 再現手順 / 期待 / 実際 / console / screenshot or video / quality preset / browser+GPU`を必ず残す。
