/** Key bindings. Physical `KeyboardEvent.code` values so layout does not matter. */

export type GameAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'reload'
  | 'interact'
  | 'toggleDebug'
  | 'toggleHud'
  | 'restart';

export const KEY_BINDINGS: Record<GameAction, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  reload: ['KeyR'],
  interact: ['KeyF'],
  toggleDebug: ['Backquote'],
  toggleHud: ['KeyH'],
  restart: ['KeyP'],
};

export const MOUSE_BUTTON = {
  fire: 0,
  ads: 2,
} as const;
