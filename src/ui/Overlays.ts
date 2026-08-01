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
      ? 'PAUSED // CLICK TO RESUME'
      : 'OPERATION TIDEBREAKER // FABRICATION LOCKDOWN';
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
    this.endTitle.textContent = success ? 'MISSION COMPLETE' : 'K.I.A.';
    this.endTitle.style.color = success ? '' : '#ff5a44';
    this.endSubtitle.textContent = success
      ? '3 SURVIVORS RECOVERED // WARDEN-03 OFFLINE'
      : 'TIDEBREAKER // MISSION FAILED';
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
  <div class="mouse-hint"><span>CLICK TO RECAPTURE MOUSE</span></div>

  <div class="overlay briefing">
    <h1>TIDEBREAKER</h1>
    <h2>OPERATION TIDEBREAKER // FABRICATION LOCKDOWN</h2>
    <div class="rule"></div>
    <div class="body"></div>
    <div class="controls desktop-brief-controls">
      <b>W A S D</b><span>Move</span>
      <b>MOUSE</b><span>Look</span>
      <b>LEFT MOUSE</b><span>Fire</span>
      <b>RIGHT MOUSE</b><span>Aim down sight</span>
      <b>SHIFT</b><span>Sprint</span>
      <b>CTRL / C</b><span>Crouch</span>
      <b>SPACE</b><span>Jump</span>
      <b>R</b><span>Reload</span>
      <b>H</b><span>Toggle HUD</span>
      <b>&#96;</b><span>Debug panel</span>
      <b>P</b><span>Restart</span>
    </div>
    <div class="controls mobile-brief-controls">
      <b>LEFT STICK</b><span>Move / push fully to sprint</span>
      <b>RIGHT SWIPE</b><span>Look</span>
      <b>FIRE / ADS</b><span>Shoot / aim</span>
      <b>ACTION KEYS</b><span>Jump / reload / use / crouch</span>
    </div>
    <div class="prompt"><span class="desktop-start-copy">CLICK</span><span class="mobile-start-copy">TAP</span> TO BEGIN INSERTION</div>
  </div>

  <div class="truth-reveal">
    <div class="eyebrow">CORE RECORD PLAYBACK</div>
    <h2>INCIDENT ARCHIVE</h2>
    <div class="log"></div>
    <div class="subjects"></div>
  </div>

  <div class="overlay endcard">
    <h1>MISSION COMPLETE</h1>
    <h2>3 SURVIVORS RECOVERED // WARDEN-03 OFFLINE</h2>
    <div class="rule"></div>
    <div class="stats"></div>
    <div class="end-actions">
      <button class="retry" type="button">RETRY FROM CHECKPOINT</button>
      <button class="title-return" type="button">RETURN TO BRIEFING</button>
    </div>
  </div>

  <div class="loader">
    <div class="title">TIDEBREAKER</div>
    <div class="track"><i></i></div>
    <div class="step">INITIALISING</div>
  </div>

  <div class="fatal">
    <h1>RENDERER FAILED TO START</h1>
    <pre></pre>
  </div>
`;
