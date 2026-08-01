import { KEY_BINDINGS, MOUSE_BUTTON, type GameAction } from '@/config/input';
import { listen } from './Disposal';

/**
 * Pointer-lock input.
 *
 * Mouse deltas accumulate between frames and are drained by the player
 * controller, so a 1000Hz mouse does not lose motion on a 60Hz display.
 * Held state is edge-tracked (`pressed` = this frame only) for actions like
 * jump and reload that must not repeat.
 */
export class Input {
  private held = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  private mouseButtons = new Set<number>();
  private mousePressed = new Set<number>();
  private virtualHeld = new Set<GameAction>();
  private virtualPressed = new Set<GameAction>();
  private virtualReleased = new Set<GameAction>();
  private virtualFiring = false;
  private virtualFirePressed = false;
  private virtualAiming = false;
  private teardowns: Array<() => void> = [];

  mouseDeltaX = 0;
  mouseDeltaY = 0;
  wheelDelta = 0;
  locked = false;
  /**
   * True when we are running WITHOUT real pointer lock.
   *
   * Some embedding contexts (sandboxed iframes, some remote-desktop and
   * automation setups) refuse requestPointerLock. Rather than leaving the game
   * permanently stuck on the briefing screen, we fall back to reading raw
   * movementX/movementY, which browsers still report for ordinary mousemove.
   * Aiming is slightly worse because the cursor can leave the window, but the
   * demo stays playable instead of dead.
   */
  softLock = false;
  touchMode = false;

  /** Notified whenever capture mode changes (drives the non-modal retry hint). */
  onLockChange: ((locked: boolean, mode: 'real' | 'soft' | 'touch' | 'none') => void) | null = null;

  constructor(private readonly element: HTMLElement) {
    this.teardowns.push(
      listen(window, 'keydown', this.handleKeyDown),
      listen(window, 'keyup', this.handleKeyUp),
      listen(window, 'blur', this.handleBlur),
      listen(document, 'pointerlockchange', this.handlePointerLockChange),
      listen(document, 'mousemove', this.handleMouseMove),
      listen(document, 'mousedown', this.handleMouseDown),
      listen(document, 'mouseup', this.handleMouseUp),
      listen(document, 'wheel', this.handleWheel, { passive: true }),
      listen(document, 'contextmenu', this.handleContextMenu),
    );
  }

  private softLockTimer = 0;

  requestLock(): void {
    if (this.touchMode) {
      this.locked = true;
      this.onLockChange?.(true, 'touch');
      return;
    }
    // A soft lock is a fallback, not a terminal state. Clicking the hint must
    // still be allowed to upgrade it to real pointer lock.
    if (document.pointerLockElement === this.element) return;
    try {
      // Chrome throws if lock is requested too soon after an exit; swallow it.
      void Promise.resolve(this.element.requestPointerLock()).catch(() => this.enableSoftLock());
    } catch {
      this.enableSoftLock();
    }
    // Some browsers neither resolve nor reject and simply never fire
    // pointerlockchange. Fall back after a short grace period.
    window.clearTimeout(this.softLockTimer);
    this.softLockTimer = window.setTimeout(() => this.enableSoftLock(), 700);
  }

  private enableSoftLock(): void {
    if (this.locked) return;
    this.softLock = true;
    this.locked = true;
    this.onLockChange?.(true, 'soft');
  }

  exitLock(): void {
    window.clearTimeout(this.softLockTimer);
    if (this.touchMode) {
      this.locked = false;
      this.resetVirtualControls();
      this.onLockChange?.(false, 'none');
      return;
    }
    if (document.pointerLockElement === this.element) {
      document.exitPointerLock();
      return;
    }
    if (this.softLock) {
      this.softLock = false;
      this.locked = false;
      this.held.clear();
      this.mouseButtons.clear();
      this.onLockChange?.(false, 'none');
    }
  }

  isDown(action: GameAction): boolean {
    if (this.virtualHeld.has(action)) return true;
    for (const code of KEY_BINDINGS[action]) if (this.held.has(code)) return true;
    return false;
  }

  wasPressed(action: GameAction): boolean {
    if (this.virtualPressed.has(action)) return true;
    for (const code of KEY_BINDINGS[action]) if (this.pressedThisFrame.has(code)) return true;
    return false;
  }

  wasReleased(action: GameAction): boolean {
    if (this.virtualReleased.has(action)) return true;
    for (const code of KEY_BINDINGS[action]) if (this.releasedThisFrame.has(code)) return true;
    return false;
  }

  get firing(): boolean {
    return this.virtualFiring || this.mouseButtons.has(MOUSE_BUTTON.fire);
  }

  get firePressed(): boolean {
    return this.virtualFirePressed || this.mousePressed.has(MOUSE_BUTTON.fire);
  }

  get aiming(): boolean {
    return this.virtualAiming || this.mouseButtons.has(MOUSE_BUTTON.ads);
  }

  /** Switches input capture from pointer lock to the on-screen touch controls. */
  enableTouchMode(): void {
    this.touchMode = true;
    this.softLock = false;
  }

  /** Held + edge-tracked virtual button used by the mobile control surface. */
  setVirtualAction(action: GameAction, down: boolean): void {
    const wasDown = this.virtualHeld.has(action);
    if (down === wasDown) return;
    if (down) {
      this.virtualHeld.add(action);
      this.virtualPressed.add(action);
    } else {
      this.virtualHeld.delete(action);
      this.virtualReleased.add(action);
    }
  }

  setVirtualFire(down: boolean): void {
    if (down && !this.virtualFiring) this.virtualFirePressed = true;
    this.virtualFiring = down;
  }

  setVirtualAim(down: boolean): void {
    this.virtualAiming = down;
  }

  /** Touch-look deltas join mouse deltas so the frame pipeline stays unchanged. */
  addVirtualLook(deltaX: number, deltaY: number): void {
    if (!this.locked) return;
    this.mouseDeltaX += deltaX;
    this.mouseDeltaY += deltaY;
  }

  resetVirtualControls(): void {
    for (const action of this.virtualHeld) this.virtualReleased.add(action);
    this.virtualHeld.clear();
    this.virtualPressed.clear();
    this.virtualFiring = false;
    this.virtualFirePressed = false;
    this.virtualAiming = false;
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed.clear();
    this.virtualPressed.clear();
    this.virtualReleased.clear();
    this.virtualFirePressed = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }

  dispose(): void {
    window.clearTimeout(this.softLockTimer);
    for (const off of this.teardowns) off();
    this.teardowns.length = 0;
    this.held.clear();
    this.mouseButtons.clear();
    this.virtualHeld.clear();
    this.virtualPressed.clear();
    this.virtualReleased.clear();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape' && this.softLock) {
      this.exitLock();
      return;
    }
    if (event.repeat) return;
    this.held.add(event.code);
    this.pressedThisFrame.add(event.code);
    // Space would scroll the page and F would trigger browser search shortcuts.
    if (event.code === 'Space' || event.code === 'Tab') event.preventDefault();
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
    this.releasedThisFrame.add(event.code);
  };

  private handleBlur = (): void => {
    this.held.clear();
    this.mouseButtons.clear();
    this.resetVirtualControls();
  };

  private handlePointerLockChange = (): void => {
    const real = document.pointerLockElement === this.element;
    if (real) {
      window.clearTimeout(this.softLockTimer);
      this.softLock = false;
    }
    this.locked = real || this.softLock;
    if (!this.locked) {
      this.held.clear();
      this.mouseButtons.clear();
    }
    this.onLockChange?.(this.locked, real ? 'real' : this.softLock ? 'soft' : 'none');
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseButtons.add(event.button);
    this.mousePressed.add(event.button);
  };

  private handleMouseUp = (event: MouseEvent): void => {
    this.mouseButtons.delete(event.button);
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.locked) return;
    this.wheelDelta += event.deltaY;
  };

  private handleContextMenu = (event: MouseEvent): void => {
    // Right mouse is ADS - the browser menu must never appear mid-fight.
    event.preventDefault();
  };
}
