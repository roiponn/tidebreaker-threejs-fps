/**
 * Frame clock with a hard delta cap.
 *
 * A tab-switch produces a multi-second delta which would teleport the player
 * through walls and dump the entire particle budget in one frame. Clamping to
 * 50ms (20fps) keeps every integrator stable.
 */
export class GameClock {
  private last = 0;
  private started = false;

  /** Seconds since the previous frame, clamped. */
  delta = 0;
  /** Unclamped wall-clock seconds since start; used for shader time uniforms. */
  elapsed = 0;
  /** Smoothed frame time in ms, for the perf HUD. */
  smoothedFrameMs = 16.6;

  constructor(private readonly maxDelta = 0.05) {}

  tick(now: number): number {
    if (!this.started) {
      this.started = true;
      this.last = now;
      this.delta = 1 / 60;
      return this.delta;
    }
    const raw = (now - this.last) / 1000;
    this.last = now;
    this.delta = Math.min(raw, this.maxDelta);
    this.elapsed += this.delta;
    this.smoothedFrameMs += (raw * 1000 - this.smoothedFrameMs) * 0.08;
    return this.delta;
  }

  get fps(): number {
    return 1000 / Math.max(this.smoothedFrameMs, 0.0001);
  }
}
