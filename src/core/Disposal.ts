import * as THREE from 'three';

/**
 * GPU resource lifetime helpers.
 *
 * WebGL leaks are silent: the frame rate just decays. Every system in this
 * project owns a `Disposer` and calls `dispose()` in its own `dispose()`.
 */
export class Disposer {
  private items: Array<{ dispose(): void }> = [];
  private teardowns: Array<() => void> = [];

  track<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  trackMany<T extends { dispose(): void }>(...items: T[]): void {
    this.items.push(...items);
  }

  /** Register an arbitrary teardown (event listeners, RAF handles, timers). */
  onDispose(fn: () => void): void {
    this.teardowns.push(fn);
  }

  dispose(): void {
    for (const fn of this.teardowns) {
      try {
        fn();
      } catch (err) {
        console.error('[Disposer] teardown failed', err);
      }
    }
    for (const item of this.items) {
      try {
        item.dispose();
      } catch (err) {
        console.error('[Disposer] dispose failed', err);
      }
    }
    this.items.length = 0;
    this.teardowns.length = 0;
  }
}

/** Recursively dispose every geometry/material/texture under an Object3D. */
export function disposeObject(root: THREE.Object3D): void {
  const seenMaterials = new Set<THREE.Material>();
  root.traverse((node) => {
    const mesh = node as Partial<THREE.Mesh>;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      if (seenMaterials.has(m)) continue;
      seenMaterials.add(m);
      disposeMaterial(m);
    }
  });
  root.removeFromParent();
}

export function disposeMaterial(material: THREE.Material): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value && (value as THREE.Texture).isTexture) {
      (value as THREE.Texture).dispose();
    }
  }
  material.dispose();
}

/** Adds a `.dispose()`-able wrapper around a DOM event listener. */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (ev: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  handler: (ev: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}
