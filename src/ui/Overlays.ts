import { MISSION_V2 } from '@/config/mission';
import type { TruthRevealFrame } from '@/story/TruthReveal';

/**
 * Full-screen UI: loading, briefing, intro chatter, end card and the fatal
 * error fallback.
 *
 * These are plain DOM so the game can show something useful even if WebGL
 * itself failed - the brief explicitly requires the screen not to go dead on
 * an error.
 */
export class Overlays {
  private root: HTMLDivElement;
  private loader: HTMLDivElement;
  private loaderFill: HTMLElement;
  private loaderStep: HTMLDivElement;
  private briefing: HTMLDivElement;
  private mouseHint: HTMLDivElement;
  private endCard: HTMLDivElement;
  private endTitle: HTMLElement;
  private endSubtitle: HTMLElement;
  private endStats: HTMLDivElement;
  private chatter: HTMLDivElement;
  private letterboxTop: HTMLDivElement;
  private letterboxBottom: HTMLDivElement;
  private fatal: HTMLDivElement;
  private truth: HTMLDivElement;

  /** Set by the game; fired when the player clicks the briefing screen. */
  onStart: (() => void) | null = null;
  /** Fired when the player clicks the pointer-lock prompt. */
  onRecaptureMouse: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onTitle: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);

    this.loader = this.q('.loader');
    this.loaderFill = this.q('.loader .track i');
    this.loaderStep = this.q('.loader .step');
    this.briefing = this.q('.overlay.briefing');
    this.mouseHint = this.q('.mouse-hint');
    this.endCard = this.q('.overlay.endcard');
    this.endTitle = this.q('.overlay.endcard h1');
    this.endSubtitle = this.q('.overlay.endcard h2');
    this.endStats = this.q('.overlay.endcard .stats');
    this.chatter = this.q('.chatter');
    this.letterboxTop = this.q('.letterbox.top');
    this.letterboxBottom = this.q('.letterbox.bottom');
    this.fatal = this.q('.fatal');
    this.truth = this.q('.truth-reveal');

    this.q<HTMLElement>('.briefing .body').innerHTML = MISSION_V2.lines.briefing
      .map((line) => `<span>${line}</span>`)
      .join('');

    this.briefing.addEventListener('click', () => this.onStart?.());
    this.mouseHint.addEventListener('click', () => this.onRecaptureMouse?.());
    this.q<HTMLButtonElement>('.endcard .retry').addEventListener('click', () => this.onRestart?.());
    this.q<HTMLButtonElement>('.endcard .title-return').addEventListener('click', () => this.onTitle?.());
  }

  private q<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector(selector);
    if (!el) throw new Error(`[Overlays] missing element: ${selector}`);
    return el as T;
  }

  // --- loading ---

  setLoadProgress(fraction: number, step: string): void {
    this.loaderFill.style.width = `${Math.round(fraction * 100)}%`;
    this.loaderStep.textContent = step;
  }

  hideLoader(): void {
    this.loader.classList.add('done');
    // Remove from the layout after the fade so it cannot swallow clicks.
    window.setTimeout(() => {
      this.loader.style.display = 'none';
    }, 700);
  }

  // --- briefing / pause ---

  showBriefing(paused: boolean): void {
    this.briefing.classList.add('show');
    this.q<HTMLElement>('.briefing h2').textContent = paused
      ? '一時停止中 // クリックで再開'
      : 'TIDEBREAKER作戦 // 製造施設封鎖';
  }

  hideBriefing(): void {
    this.briefing.classList.remove('show');
  }

  /**
   * Non-blocking prompt shown when pointer lock is unavailable or lost.
   *
   * Deliberately NOT the briefing screen: losing the mouse must not read as
   * losing the run. The mission keeps running behind it and a click anywhere
   * asks for the lock back.
   */
  showMouseHint(): void {
    this.mouseHint.classList.add('show');
  }

  hideMouseHint(): void {
    this.mouseHint.classList.remove('show');
  }

  // --- intro cinematics ---

  setLetterbox(show: boolean): void {
    this.letterboxTop.classList.toggle('show', show);
    this.letterboxBottom.classList.toggle('show', show);
  }

  setChatter(speaker: string | null, line: string | null): void {
    if (!speaker || !line) {
      this.chatter.classList.remove('show');
      return;
    }
    this.chatter.innerHTML = `<b>${speaker}</b>${line}`;
    this.chatter.classList.add('show');
  }

  showTruth(frame: TruthRevealFrame): void {
    this.q<HTMLElement>('.truth-reveal h2').textContent = frame.heading;
    this.q<HTMLElement>('.truth-reveal .log').innerHTML = frame.lines
      .map((line) => `<span>${line}</span>`)
      .join('');
    this.q<HTMLElement>('.truth-reveal .subjects').innerHTML = frame.subjectStatus
      .map((subject) => `<span><b>${subject.id}</b>${subject.name}<i>${subject.vitals}</i></span>`)
      .join('');
    this.truth.classList.add('show');
  }

  hideTruth(): void {
    this.truth.classList.remove('show');
  }

  // --- end card ---

  showEnd(success: boolean, stats: Array<[string, string]>): void {
    this.endTitle.textContent = success ? '任務完了' : '作戦失敗';
    this.endTitle.style.color = success ? '' : '#ff5a44';
    this.endSubtitle.textContent = success
      ? '生存者3名を救出 // WARDEN-03 停止'
      : 'TIDEBREAKER // 隊員戦闘不能';
    this.endStats.innerHTML = stats
      .map(([label, value]) => `<span>${label}</span><span>${value}</span>`)
      .join('');
    this.endCard.classList.add('show');
  }

  hideEnd(): void {
    this.endCard.classList.remove('show');
  }

  /** Last-resort error card. Keeps the page alive and tells the user why. */
  showFatal(message: string): void {
    this.q<HTMLElement>('.fatal pre').textContent = message;
    this.fatal.classList.add('show');
    this.loader.style.display = 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}

const TEMPLATE = /* html */ `
  <div class="letterbox top"></div>
  <div class="letterbox bottom"></div>
  <div class="chatter"></div>
  <div class="mouse-hint"><span>クリックしてマウス操作を再開</span></div>

  <div class="overlay briefing">
    <h1>TIDEBREAKER</h1>
    <h2>TIDEBREAKER作戦 // 製造施設封鎖</h2>
    <div class="rule"></div>
    <div class="body"></div>
    <div class="controls desktop-brief-controls">
      <b>W A S D</b><span>移動</span>
      <b>マウス</b><span>視点移動</span>
      <b>左クリック</b><span>射撃</span>
      <b>右クリック</b><span>照準をのぞく</span>
      <b>SHIFT</b><span>ダッシュ</span>
      <b>CTRL / C</b><span>しゃがむ</span>
      <b>SPACE</b><span>ジャンプ</span>
      <b>R</b><span>リロード</span>
      <b>F</b><span>拾う・端末を操作</span>
      <b>ESC</b><span>マウス操作を解除</span>
      <b>P</b><span>チェックポイントから再開</span>
    </div>
    <div class="controls mobile-brief-controls">
      <b>左スティック</b><span>移動 / 大きく倒すとダッシュ</span>
      <b>右側をスワイプ</b><span>視点移動</span>
      <b>射撃 / 照準</b><span>撃つ / 照準をのぞく</span>
      <b>操作ボタン</b><span>ジャンプ / 装填 / 拾う / しゃがむ</span>
    </div>
    <div class="tutorial-note">画面上部の「任務」とひし形マーカーを追って進んでください。</div>
    <div class="prompt"><span class="desktop-start-copy">クリック</span><span class="mobile-start-copy">タップ</span>して作戦開始</div>
  </div>

  <div class="truth-reveal">
    <div class="eyebrow">コア記録を再生中</div>
    <h2>事故記録</h2>
    <div class="log"></div>
    <div class="subjects"></div>
  </div>

  <div class="overlay endcard">
    <h1>任務完了</h1>
    <h2>生存者3名を救出 // WARDEN-03 停止</h2>
    <div class="rule"></div>
    <div class="stats"></div>
    <div class="end-actions">
      <button class="retry" type="button">チェックポイントから再開</button>
      <button class="title-return" type="button">作戦説明へ戻る</button>
    </div>
  </div>

  <div class="loader">
    <div class="title">TIDEBREAKER</div>
    <div class="track"><i></i></div>
    <div class="step">初期化中</div>
  </div>

  <div class="fatal">
    <h1>ゲーム画面を起動できませんでした</h1>
    <pre></pre>
  </div>
`;
