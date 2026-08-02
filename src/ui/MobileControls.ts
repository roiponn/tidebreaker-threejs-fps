import type { GameAction } from '@/config/input';
import type { Input } from '@/core/Input';

const MOVE_RADIUS = 46;
const MOVE_DEAD_ZONE = 0.18;
const LOOK_SCALE = 1.45;

/**
 * Two-thumb mobile FPS controls.
 *
 * The left stick maps to the existing digital movement actions. The clear
 * right half is a swipe surface for camera look, while the buttons are true
 * multi-pointer controls so moving, aiming and firing can happen together.
 */
export class MobileControls {
  readonly enabled: boolean;

  private readonly root: HTMLDivElement;
  private readonly movePad: HTMLDivElement;
  private readonly moveKnob: HTMLDivElement;
  private readonly lookPad: HTMLDivElement;
  private readonly crouchButton: HTMLButtonElement;
  private readonly cleanups: Array<() => void> = [];
  private readonly heldPointerReleases = new Map<number, () => void>();

  private movePointer: number | null = null;
  private lookPointer: number | null = null;
  private lastLookX = 0;
  private lastLookY = 0;
  private crouched = false;

  constructor(container: HTMLElement, private readonly input: Input) {
    this.enabled = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
    this.root = document.createElement('div');
    this.root.className = 'mobile-game-controls';
    this.root.innerHTML = TEMPLATE;
    container.appendChild(this.root);

    this.movePad = this.q('.mobile-move-pad');
    this.moveKnob = this.q('.mobile-move-knob');
    this.lookPad = this.q('.mobile-look-pad');
    this.crouchButton = this.q('.mobile-action-crouch');

    if (!this.enabled) return;

    this.root.classList.add('supported');
    this.input.enableTouchMode();
    this.bindMovement();
    this.bindLook();
    this.bindHeldButton('.mobile-action-fire', (down) => this.input.setVirtualFire(down), true);
    this.bindHeldButton('.mobile-action-aim', (down) => this.input.setVirtualAim(down), true);
    this.bindActionButton('.mobile-action-jump', 'jump');
    this.bindActionButton('.mobile-action-reload', 'reload');
    this.bindActionButton('.mobile-action-use', 'interact');
    this.bindCrouch();
    this.bindSafetyResets();
  }

  setActive(active: boolean): void {
    if (!this.enabled) return;
    this.root.classList.toggle('active', active);
    this.root.setAttribute('aria-hidden', String(!active));
    if (active) {
      this.input.requestLock();
    } else {
      this.resetControlState();
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.resetControlState();
    this.root.remove();
  }

  private bindMovement(): void {
    const down = (event: PointerEvent): void => {
      if (this.movePointer !== null) return;
      event.preventDefault();
      this.movePointer = event.pointerId;
      this.capture(this.movePad, event.pointerId);
      this.updateMovement(event.clientX, event.clientY);
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== this.movePointer) return;
      event.preventDefault();
      this.updateMovement(event.clientX, event.clientY);
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== this.movePointer) return;
      event.preventDefault();
      this.releaseMovement();
    };
    this.listen(this.movePad, 'pointerdown', down);
    this.listen(this.movePad, 'pointermove', move);
    this.listen(this.movePad, 'pointerup', up);
    this.listen(this.movePad, 'pointercancel', up);
    this.listen(this.movePad, 'lostpointercapture', up);
  }

  private updateMovement(clientX: number, clientY: number): void {
    const rect = this.movePad.getBoundingClientRect();
    const rawX = clientX - (rect.left + rect.width * 0.5);
    const rawY = clientY - (rect.top + rect.height * 0.5);
    const length = Math.hypot(rawX, rawY);
    const scale = length > MOVE_RADIUS ? MOVE_RADIUS / length : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    const nx = x / MOVE_RADIUS;
    const ny = y / MOVE_RADIUS;

    this.moveKnob.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.input.setVirtualAction('left', nx < -MOVE_DEAD_ZONE);
    this.input.setVirtualAction('right', nx > MOVE_DEAD_ZONE);
    this.input.setVirtualAction('forward', ny < -MOVE_DEAD_ZONE);
    this.input.setVirtualAction('back', ny > MOVE_DEAD_ZONE);
    this.input.setVirtualAction('sprint', length / MOVE_RADIUS > 0.84 && ny < -0.62);
  }

  private releaseMovement(): void {
    this.movePointer = null;
    this.moveKnob.style.transform = 'translate3d(0, 0, 0)';
    for (const action of ['left', 'right', 'forward', 'back', 'sprint'] as const) {
      this.input.setVirtualAction(action, false);
    }
  }

  private bindLook(): void {
    const down = (event: PointerEvent): void => {
      if (this.lookPointer !== null) return;
      event.preventDefault();
      this.lookPointer = event.pointerId;
      this.lastLookX = event.clientX;
      this.lastLookY = event.clientY;
      this.capture(this.lookPad, event.pointerId);
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== this.lookPointer) return;
      event.preventDefault();
      this.input.addVirtualLook(
        (event.clientX - this.lastLookX) * LOOK_SCALE,
        (event.clientY - this.lastLookY) * LOOK_SCALE,
      );
      this.lastLookX = event.clientX;
      this.lastLookY = event.clientY;
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== this.lookPointer) return;
      event.preventDefault();
      this.lookPointer = null;
    };
    this.listen(this.lookPad, 'pointerdown', down);
    this.listen(this.lookPad, 'pointermove', move);
    this.listen(this.lookPad, 'pointerup', up);
    this.listen(this.lookPad, 'pointercancel', up);
    this.listen(this.lookPad, 'lostpointercapture', up);
  }

  private bindHeldButton(
    selector: string,
    setDown: (down: boolean) => void,
    dragToLook = false,
  ): void {
    const button = this.q<HTMLButtonElement>(selector);
    let pointer: number | null = null;
    let lastX = 0;
    let lastY = 0;
    const finish = (pointerId: number): void => {
      if (pointerId !== pointer) return;
      this.heldPointerReleases.delete(pointerId);
      pointer = null;
      button.classList.remove('pressed');
      setDown(false);
    };
    const down = (event: PointerEvent): void => {
      event.preventDefault();
      if (pointer !== null) return;
      pointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      this.capture(button, event.pointerId);
      this.heldPointerReleases.set(event.pointerId, () => finish(event.pointerId));
      button.classList.add('pressed');
      setDown(true);
      if (selector.includes('fire')) navigator.vibrate?.(8);
    };
    const move = (event: PointerEvent): void => {
      if (!dragToLook || event.pointerId !== pointer) return;
      event.preventDefault();
      this.input.addVirtualLook(
        (event.clientX - lastX) * LOOK_SCALE,
        (event.clientY - lastY) * LOOK_SCALE,
      );
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== pointer) return;
      event.preventDefault();
      finish(event.pointerId);
    };
    this.listen(button, 'pointerdown', down);
    this.listen(button, 'pointermove', move);
    this.listen(button, 'pointerup', up);
    this.listen(button, 'pointercancel', up);
    this.listen(button, 'lostpointercapture', up);
  }

  private bindActionButton(selector: string, action: GameAction): void {
    this.bindHeldButton(selector, (down) => this.input.setVirtualAction(action, down));
  }

  private bindCrouch(): void {
    const down = (event: PointerEvent): void => {
      event.preventDefault();
      this.crouched = !this.crouched;
      this.crouchButton.classList.toggle('pressed', this.crouched);
      this.input.setVirtualAction('crouch', this.crouched);
    };
    this.listen(this.crouchButton, 'pointerdown', down);
  }

  /**
   * iOS can drop a pointerup while rotating, switching apps, or when pointer
   * capture is rejected. Global end events and lifecycle resets guarantee that
   * no movement/fire state survives after the finger is gone.
   */
  private bindSafetyResets(): void {
    const endPointer = (event: PointerEvent): void => {
      if (event.pointerId === this.movePointer) this.releaseMovement();
      if (event.pointerId === this.lookPointer) this.lookPointer = null;
      this.heldPointerReleases.get(event.pointerId)?.();
    };
    const reset = (): void => this.resetControlState();
    const resetWhenHidden = (): void => {
      if (document.hidden) reset();
    };

    document.addEventListener('pointerup', endPointer, { capture: true, passive: true });
    document.addEventListener('pointercancel', endPointer, { capture: true, passive: true });
    window.addEventListener('blur', reset);
    window.addEventListener('pagehide', reset);
    window.addEventListener('orientationchange', reset);
    document.addEventListener('visibilitychange', resetWhenHidden);

    this.cleanups.push(
      () => document.removeEventListener('pointerup', endPointer, true),
      () => document.removeEventListener('pointercancel', endPointer, true),
      () => window.removeEventListener('blur', reset),
      () => window.removeEventListener('pagehide', reset),
      () => window.removeEventListener('orientationchange', reset),
      () => document.removeEventListener('visibilitychange', resetWhenHidden),
    );
  }

  private resetControlState(): void {
    this.releaseMovement();
    this.lookPointer = null;
    for (const release of [...this.heldPointerReleases.values()]) release();
    this.heldPointerReleases.clear();
    this.crouched = false;
    this.crouchButton.classList.remove('pressed');
    this.input.resetVirtualControls();
  }

  private listen(
    target: HTMLElement,
    type: keyof HTMLElementEventMap,
    handler: (event: PointerEvent) => void,
  ): void {
    target.addEventListener(type, handler as EventListener, { passive: false });
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
  }

  private capture(target: HTMLElement, pointerId: number): void {
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Older iOS WebKit can reject capture while the page changes orientation.
    }
  }

  private q<T extends HTMLElement = HTMLDivElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`[MobileControls] missing element: ${selector}`);
    return element;
  }
}

const TEMPLATE = /* html */ `
  <div class="mobile-look-pad" aria-label="スワイプして視点移動"></div>

  <div class="mobile-move-pad" aria-label="移動">
    <span class="mobile-move-ring"></span>
    <span class="mobile-move-knob"></span>
    <small>移動 / ダッシュ</small>
  </div>

  <div class="mobile-actions" aria-label="ゲーム操作">
    <button class="mobile-action mobile-action-use" type="button" aria-label="拾う・端末を操作">操作</button>
    <button class="mobile-action mobile-action-reload" type="button" aria-label="リロード">装填</button>
    <button class="mobile-action mobile-action-crouch" type="button" aria-label="しゃがむ・立つ">しゃがむ</button>
    <button class="mobile-action mobile-action-jump" type="button" aria-label="ジャンプ">ジャンプ</button>
    <button class="mobile-action mobile-action-aim" type="button" aria-label="照準をのぞく">照準</button>
    <button class="mobile-action mobile-action-fire" type="button" aria-label="射撃">射撃</button>
  </div>

  <div class="mobile-look-hint">射撃中もドラッグで照準</div>

  <div class="rotate-device" role="status">
    <b>端末を横向きにしてください</b>
    <span>このゲームは横向き画面で操作します</span>
  </div>
`;
