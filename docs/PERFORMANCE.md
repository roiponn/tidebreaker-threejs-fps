# Performance

## 2026-08-01観測

Codex内ブラウザ、1280×720相当、開発サーバーでbody datasetから取得。仮想/自動ブラウザはthrottleされるためfps値は採用していない。

| 場面 | draw calls | triangles | lights | particles |
| --- | ---: | ---: | ---: | ---: |
| Briefing / exterior attract | 約477 | 約281k | 20 | 0 |
| GATEKEEPER debug | 約403 | 約255k | 20 | 0 |
| WARDEN-03 phase 3 | 約282 | 約149k | 20 | 0 |

本番buildは76 modules、JS 930.33kB（gzip 257.19kB）、CSS 10.37kB（gzip 2.76kB）。source mapを除く。

## 予算戦略

- static geometryはzone/material単位でmerge。
- robot hit testとboss hit testはmesh raycastでなくsphere。
- particles、decals、boss emittersは固定容量でrecycle。
- factory fixtureの大半はemissive-only。実照明は3区画に3灯追加し合計20。
- shadow casterはcamera距離でcull。
- planar reflectionはmain pass前に1回。distant rain等を除外。
- boss VFXは2 draw-call point batches。

## 未検証

実GPUでの1080p 55–60fps、長時間プレイのGPU memory plateau、low/medium/highの相対性能、熱/電力制約のあるMacでの挙動。自動ブラウザのfpsは変動が大きく、出荷指標に使えない。

## 次の最適化順

1. Chrome Performance + Spector.jsで実GPU capture。
2. authored-zone mergeを空間セルmergeへ変更しfrustum cullingを回復。
3. planar reflectionの更新頻度/解像度をquality別に計測。
4. 20 forward lightsの影響を測り、control zone以外をbaked/emissive proxyへ。
5. texture generationをWorker化してboot hitchを除去。
