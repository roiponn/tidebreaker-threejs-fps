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
  private endCard: HTMLDivElement;
  private endTitle: HTMLElement;
  private endSubtitle: HTMLElement;
  private endStats: HTMLDivElement;
  private chatter: HTMLDivElement;
  private letterboxTop: HTMLDivElement;
  private letterboxBottom: HTMLDivElement;
  private fatal: HTMLDivElement;

  /** Set by the game; fired when the player clicks the briefing screen. */
  onStart: (() => void) | null = null;
  onRestart: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);

    this.loader = this.q('.loader');
    this.loaderFill = this.q('.loader .track i');
    this.loaderStep = this.q('.loader .step');
    this.briefing = this.q('.overlay.briefing');
    this.endCard = this.q('.overlay.endcard');
    this.endTitle = this.q('.overlay.endcard h1');
    this.endSubtitle = this.q('.overlay.endcard h2');
    this.endStats = this.q('.overlay.endcard .stats');
    this.chatter = this.q('.chatter');
    this.letterboxTop = this.q('.letterbox.top');
    this.letterboxBottom = this.q('.letterbox.bottom');
    this.fatal = this.q('.fatal');

    this.briefing.addEventListener('click', () => this.onStart?.());
    this.endCard.addEventListener('click', () => this.onRestart?.());
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
      : 'OPERATION TIDEBREAKER // BERTH 7';
  }

  hideBriefing(): void {
    this.briefing.classList.remove('show');
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

  // --- end card ---

  showEnd(success: boolean, stats: Array<[string, string]>): void {
    this.endTitle.textContent = success ? 'EXTRACTED' : 'K.I.A.';
    this.endTitle.style.color = success ? '' : '#ff5a44';
    this.endSubtitle.textContent = success ? 'BERTH 7 // SECURED' : 'BERTH 7 // MISSION FAILED';
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

  <div class="overlay briefing">
    <h1>TIDEBREAKER</h1>
    <h2>OPERATION TIDEBREAKER // BERTH 7</h2>
    <div class="rule"></div>
    <div class="body">
      Storm has passed. The yard is still lit and still held.<br>
      Push east along the berth, clear the hostiles and reach the pier head
      before the window closes.
    </div>
    <div class="controls">
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
    <div class="prompt">CLICK TO DEPLOY</div>
  </div>

  <div class="overlay endcard">
    <h1>EXTRACTED</h1>
    <h2>BERTH 7 // SECURED</h2>
    <div class="rule"></div>
    <div class="stats"></div>
    <div class="prompt">CLICK TO REDEPLOY</div>
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
