# Rendering

既存レンダリング基盤は全面変更していない。`Game.renderFrame()`の順序が契約である。

```text
1 input
2 mission presentation / look
3 player movement -> camera
4 weapon animation
5 robots + Gatekeeper + Warden AI
6 explosives / wind / level / practicals / lighting / sky
7 VFX
8 audio listener
9 mission flags + state + HUD
10 planar reflection -> world/post -> view-model
```

step 4を3より前へ動かすとview-modelが1フレーム遅れ、step 7を4より前へ動かすとmuzzle VFXが遅れる。mission stateはstep 9で更新し、systemsは次フレームに反応する。

## レイヤーと見た目

- worldとview-modelは別camera/layer。武器用key lightはworldへ影響しない。
- 既存のfog patch、height fog、aerial perspective、ACES、bloom、SSAO、FXAA、gradeを維持。
- 水面反射はmain pass前。soft particleは直前frameのdepth textureを使う。
- 工場は既存warehouseを破棄せず、正面を5.4×5.2mに分割し、床/屋根/側壁/背面壁を持つ50m奥行きのshellへ変更。
- 工場の実照明は3 combat zoneに3灯だけ。その他はemissive fixture。現在の観測は20 lights。

## 壊してはいけないもの

`installFogPatch()`の先行、world/view-model camera near/farの一致、metre-scale UV、wet-ground reflection順、camera shakeがyaw/pitch authorityを奪わないこと、frame 3→4→7の順序。

## 既知の技術的負債

forward rendererのためlight追加は全lit fragmentの負担。planar reflectionは追加scene traversal。motion blurはvelocity bufferなし。decalはprojected decalではない。大規模なEffectComposer移行は、現行depth/VFX/view-model契約を壊すため未実施。
