import { CAST, HOSTAGES, MISSION_V2 } from '@/config/mission';

export interface TruthRevealFrame {
  heading: string;
  lines: string[];
  subjectStatus: Array<{ id: string; name: string; vitals: string }>;
}

/**
 * Short post-boss record playback.
 *
 * It owns timing only, never mission progression. MissionStateMachine decides
 * when TRUTH_REVEAL begins and ends; this class turns that state into a compact
 * sequence of readable evidence without locking the camera or inventing a
 * second story authority.
 */
export class TruthReveal {
  active = false;
  finished = false;
  time = 0;

  onFrame: ((frame: TruthRevealFrame | null) => void) | null = null;
  onLine: ((speaker: string, text: string) => void) | null = null;

  private stage = -1;

  start(): void {
    this.active = true;
    this.finished = false;
    this.time = 0;
    this.stage = -1;
    this.advance(0);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.time += dt;
    const nextStage = this.time < 4.2
      ? 0
      : this.time < 8.4
        ? 1
        : this.time < 12.8
          ? 2
          : this.time < 16.2
            ? 3
            : 4;
    if (nextStage !== this.stage) this.advance(nextStage);
    if (this.time >= 20.5) {
      this.active = false;
      this.finished = true;
    }
  }

  reset(): void {
    this.active = false;
    this.finished = false;
    this.time = 0;
    this.stage = -1;
    this.onFrame?.(null);
  }

  private advance(stage: number): void {
    this.stage = stage;
    const log = MISSION_V2.accidentLog;
    switch (stage) {
      case 0:
        this.onFrame?.({
          heading: '事故記録 // 復元済み',
          lines: log.slice(0, 3),
          subjectStatus: [],
        });
        break;
      case 1:
        this.onFrame?.({
          heading: '原因分析',
          lines: log.slice(3, 7),
          subjectStatus: [],
        });
        break;
      case 2:
        this.onFrame?.({
          heading: '人命保護プロトコル',
          lines: log.slice(7, 10),
          subjectStatus: HOSTAGES.map(({ id, name, vitals }) => ({ id, name, vitals })),
        });
        this.onLine?.(CAST.handler, MISSION_V2.lines.truth1);
        break;
      case 3:
        this.onFrame?.({
          heading: '分類の上書き',
          lines: [log[10], '人質（3名）  →  保護対象（3名）'],
          subjectStatus: HOSTAGES.map(({ id, name, vitals }) => ({ id, name, vitals })),
        });
        this.onLine?.(CAST.handler, MISSION_V2.lines.truth2);
        break;
      default:
        this.onFrame?.({
          heading: '施設管理AI // 最終記録',
          lines: [
            MISSION_V2.aiLines.final1,
            MISSION_V2.aiLines.final2,
            MISSION_V2.aiLines.final3,
            MISSION_V2.aiLines.final4,
          ],
          subjectStatus: HOSTAGES.map(({ id, name, vitals }) => ({ id, name, vitals })),
        });
        this.onLine?.(CAST.factoryAi, MISSION_V2.aiLines.final4);
        break;
    }
  }
}
