import './ui/styles.css';
import { Game } from './app/Game';

/**
 * Entry point. Deliberately tiny: it finds the DOM nodes, checks WebGL2, and
 * hands everything to Game. All lifecycle, all systems and all teardown live
 * in src/app/Game.ts.
 */

function fail(message: string): void {
  const root = document.getElementById('ui-root');
  if (!root) return;
  root.innerHTML = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
                flex-direction:column;background:#05070b;color:#e8eef5;font-family:sans-serif;
                text-align:center;padding:40px;">
      <h1 style="font-size:16px;letter-spacing:0.3em;color:#ff5a44;margin:0 0 16px;">CANNOT START</h1>
      <p style="font-size:13px;color:rgba(232,238,245,0.55);max-width:520px;line-height:1.7;">${message}</p>
    </div>`;
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');

if (!canvas || !uiRoot) {
  fail('The page did not load correctly: #viewport or #ui-root is missing.');
} else if (!document.createElement('canvas').getContext('webgl2')) {
  // three r16x+ is WebGL2-only; say so plainly instead of throwing.
  fail(
    'This demo needs WebGL 2, which this browser or GPU does not provide.<br>' +
      'Try a recent Chrome, Edge or Firefox with hardware acceleration enabled.',
  );
} else {
  const game = new Game(canvas, uiRoot);
  void game.boot();

  // Dev-only handle for the browser console and automated screenshots.
  // Typed loosely because vite/client types are not pulled into tsconfig.
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  if (meta.env?.DEV) {
    (window as unknown as { tidebreaker: Game }).tidebreaker = game;
  }

  // Clean teardown on navigation keeps GPU memory from leaking during HMR.
  window.addEventListener('beforeunload', () => game.dispose());
  // Vite HMR: dispose the previous instance so GPU memory is not leaked while
  // developing. Typed loosely because vite/client types are not in tsconfig.
  const hot = (import.meta as unknown as { hot?: { dispose(cb: () => void): void } }).hot;
  hot?.dispose(() => game.dispose());
}
