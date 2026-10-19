import { Application } from 'pixi.js';
import type { Live2DModel as Live2DModelInstance } from 'pixi-live2d-display';

import { loadCubismCore } from './core-loader';
import { rankMotionGroups } from './semantic-action';

interface InternalMotionManager {
  definitions?: Record<string, unknown[]>;
  startRandomMotion(group: string, priority?: number): Promise<boolean>;
}

interface InternalModel {
  motionManager?: InternalMotionManager;
}

export class Live2DHost {
  readonly #canvas: HTMLCanvasElement;
  #app: Application | null = null;
  #model: Live2DModelInstance | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  async load(coreUrl: string, modelUrl: string): Promise<void> {
    const parsedModelUrl = new URL(modelUrl);
    if (parsedModelUrl.protocol !== 'deskpet:' || parsedModelUrl.hostname !== 'managed' || !parsedModelUrl.pathname.startsWith('/models/')) {
      throw new Error('Live2D models must load from validated managed storage.');
    }
    await loadCubismCore(coreUrl);
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    await this.destroy();
    const app = new Application({ view: this.#canvas, resizeTo: this.#canvas.parentElement ?? window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
    const model = await Live2DModel.from(modelUrl, { autoInteract: false });
    app.stage.addChild(model);
    this.#app = app;
    this.#model = model;
    this.fit();
  }

  fit(): void {
    if (this.#app === null || this.#model === null) return;
    const width = this.#app.renderer.width / this.#app.renderer.resolution;
    const height = this.#app.renderer.height / this.#app.renderer.resolution;
    const bounds = this.#model.getLocalBounds();
    const scale = Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height));
    this.#model.scale.set(scale);
    this.#model.position.set((width - bounds.width * scale) / 2 - bounds.x * scale, height - (bounds.height + bounds.y) * scale);
  }

  async playSemanticAction(action: string): Promise<boolean> {
    if (this.#model === null) return false;
    const internal = this.#model.internalModel as InternalModel;
    const manager = internal.motionManager;
    if (manager?.definitions === undefined) return false;
    const candidate = rankMotionGroups(action, Object.keys(manager.definitions))[0];
    return candidate === undefined ? false : manager.startRandomMotion(candidate.group, 2);
  }

  setExpression(expression: string): Promise<boolean> {
    if (this.#model === null) return Promise.resolve(false);
    return this.#model.expression(expression);
  }

  setScale(scale: number): void {
    this.#model?.scale.set(this.#model.scale.x * scale);
  }

  containsPoint(x: number, y: number): boolean {
    if (this.#model === null) return false;
    const bounds = this.#model.getBounds();
    return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
  }

  async destroy(): Promise<void> {
    if (this.#model !== null) {
      this.#model.destroy({ children: true });
      this.#model = null;
    }
    if (this.#app !== null) {
      this.#app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.#app = null;
    }
  }
}
