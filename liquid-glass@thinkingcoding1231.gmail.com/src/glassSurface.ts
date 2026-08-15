// src/glassSurface.ts
//
// One glass instance: the actor tree, the shader, the clone samplers and the
// per-frame geometry update that every surface needs.
//
// Each manager used to build all of this by hand, which is why the same fifty
// lines appear six times in this codebase with small unexplained differences
// between the copies. The surfaces genuinely differ in *what* they track — how
// to find the target, what rectangle the glass covers, what must be excluded —
// so those stay with the managers. Everything below is the part that never
// actually differed.
//
// Two invariants are load-bearing and easy to get wrong by hand, so they are
// encoded here once:
//   * the frame `later` must be removed before any actor is destroyed;
//   * `effect.cleanup()` must run before `bgActor.destroy()`, or the Cogl
//     pipelines outlive the actor that owns them.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableActor, UILayerSampler, WindowCloneManager } from './utils.js';
import { Logger } from './logger.js';

const GLib_SOURCE_REMOVE = GLib.SOURCE_REMOVE;

function laterAdd(cb: () => boolean): number {
  return global.compositor?.get_laters?.().add(Meta.LaterType.BEFORE_REDRAW, cb as any) ?? 0;
}

/** Extra room around the surface for refraction and blur to spill into. */
export const SHADER_PADDING = 20;

export interface Monitor { x: number; y: number; width: number; height: number }

/**
 * Slack beyond the computed reach, absorbing rounding and the shader's own
 * edge feathering.
 */
const FBO_SLACK = 32;

/**
 * How far, in full-resolution pixels, the blur gathers from each pixel.
 *
 * The separable Gaussian runs at half resolution over a kernel whose half-width
 * is `ceil(sigma * 4)` half-res texels, with `sigma = min(radius / 2, 15)`.
 * Converting back to full-resolution pixels gives `min(radius * 4, 120)`.
 *
 * This is deliberately larger than the `radius * 2` estimate used elsewhere:
 * under-padding does not fail loudly, it just darkens the edge of the surface
 * where the blur starts sampling clamped border texels instead of real content.
 */
function blurReachPx(blurRadius: number): number {
  return Math.min(Math.max(0, blurRadius) * 4, 120);
}

/**
 * Builds the smallest render target that still produces the same picture.
 *
 * Sizing every surface's FBO to the whole monitor is by far the most expensive
 * thing this extension does: the blur chain and the composite pass both run
 * over the entire target, so a 400x300 popup was blurring 1920x1080 (or worse)
 * on every frame. The glass only needs the region it covers, plus enough
 * margin for the two effects that read outside it:
 *
 *   * the blur, which gathers up to blurReachPx() away from each pixel;
 *   * the drop shadow, which decays over shadowRadius.
 *
 * Clipped to the monitor, since sampling past the monitor edge yields nothing.
 *
 * The caller must also pass `refSize` (normally the monitor) to sync(), or the
 * shader's optical constants will follow the smaller target and the refraction
 * will visibly weaken.
 */
export function tightFbo(
  glass: { x: number; y: number; width: number; height: number },
  monitor: Monitor,
  blurRadius: number,
  shadowRadius: number,
): Monitor {
  const reach = Math.max(blurReachPx(blurRadius), shadowRadius);
  const pad = Math.ceil(Math.max(0, reach)) + FBO_SLACK;

  const left = Math.max(monitor.x, Math.floor(glass.x) - pad);
  const top = Math.max(monitor.y, Math.floor(glass.y) - pad);
  const right = Math.min(monitor.x + monitor.width, Math.ceil(glass.x + glass.width) + pad);
  const bottom = Math.min(monitor.y + monitor.height, Math.ceil(glass.y + glass.height) + pad);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export interface GlassLayerOptions {
  extensionPath: string;
  settings: Gio.Settings;
  logger: Logger;
  /** Settings namespace: 'popup', 'dock' or 'panel'. */
  keyPrefix: string;
  /** The uiGroup-direct ancestor of the target; the glass is inserted below it. */
  root: Clutter.Actor;
  /** Actors this surface must never clone into its own backdrop. */
  exclusions?: Clutter.Actor[];
  /**
   * Place the glass directly above this sibling instead of below `root`.
   * The date menu needs it: its glass must sit above panelBox so the panel
   * does not paint over the menu's backdrop.
   */
  insertAbove?: Clutter.Actor;
  /**
   * Shrinks the shader's box by the edge feather. Only the dock wants this: it
   * keeps the feathered edge off its own opaque background actor.
   */
  isDock?: boolean;
}

export interface SyncGeometry {
  /** Visual rect of the surface, absolute screen coordinates. */
  x: number; y: number; width: number; height: number;
  monitor: Monitor;
  /** Extra glass drawn beyond the visual rect. */
  expand?: number;
  /**
   * The FBO to render into, absolute coordinates. Defaults to the whole
   * monitor. The panel passes a horizontal band instead: the blur chain runs
   * over the entire FBO, so on a permanently-visible surface the difference
   * between ~180 rows and ~1080 is worth having.
   */
  fbo?: Monitor;
  /**
   * Size the shader's optical constants are normalized against. Defaults to
   * the FBO's own size, which is the historical behaviour.
   *
   * A surface that narrows its `fbo` for performance passes the size it used
   * to render into (usually the monitor), so refraction and chromatic
   * aberration keep the look they had at the larger target. Without this,
   * shrinking the render target visibly weakens the refraction.
   */
  refSize?: { width: number; height: number };
  /** Overrides the configured corner radius (the panel clamps it to half-height). */
  cornerRadius?: number;
  /** Slack left around the glass for the drop shadow. */
  clipPadding?: number;
  /** Applied to bgActor unless undefined. */
  opacity?: number;
}

export function hexToColorArray(hex: string): [number, number, number] {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
    return [1.0, 1.0, 1.0];
  return [
    parseInt(hex.slice(1, 3), 16) / 255.0,
    parseInt(hex.slice(3, 5), 16) / 255.0,
    parseInt(hex.slice(5, 7), 16) / 255.0,
  ];
}

/** The settings suffixes every surface exposes, under its own prefix. */
export const GLASS_KEYS = [
  'tint-color', 'tint-strength', 'blur-radius', 'corner-radius',
  'brightness', 'contrast', 'saturation',
] as const;

export class GlassLayer {
  readonly bgActor: Clutter.Actor;
  readonly liquidBox: Clutter.Actor;
  readonly cloneContainer: Clutter.Actor;
  readonly effect: LiquidEffect;
  readonly uiSampler: UILayerSampler;
  readonly windowClones: WindowCloneManager;

  private _opts: GlassLayerOptions;
  private _destroyed = false;

  // Only touch the actor tree when something actually moved.
  private _lastX?: number; private _lastY?: number;
  private _lastW?: number; private _lastH?: number;
  private _lastFboW?: number; private _lastFboH?: number;
  private _lastRefW?: number; private _lastRefH?: number;
  private _lastRadius?: number;

  constructor(opts: GlassLayerOptions) {
    this._opts = opts;
    const uiGroup = Main.layoutManager.uiGroup;

    this.bgActor = new UnpickableActor();
    this.bgActor.set_name('liquid-glass-bg-actor');
    this.bgActor.set_size(1.0, 1.0);
    this.bgActor.set_pivot_point(0.0, 0.0);

    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name('liquid-box');
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    // Blur My Shell has an optimisation that blanks the FBO when it believes
    // nothing is drawn into it; this 1x1 invisible child defeats that.
    const dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name('optimization-breaker');
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0);
    this.liquidBox.add_child(dummyBreaker);

    this.cloneContainer = new UnpickableActor();
    this.cloneContainer.set_name('clone-container');
    this.liquidBox.add_child(this.cloneContainer);

    // Below the target, so the target's own content stays on top of the glass —
    // unless the caller needs a specific position in the stack.
    if (opts.insertAbove && opts.insertAbove.get_parent() === uiGroup)
      uiGroup.insert_child_above(this.bgActor, opts.insertAbove);
    else if (opts.root.get_parent() === uiGroup)
      uiGroup.insert_child_below(this.bgActor, opts.root);
    else
      uiGroup.add_child(this.bgActor);

    this.effect = new LiquidEffect({
      extensionPath: opts.extensionPath,
      settings: opts.settings,
      logger: opts.logger,
    } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setIsDock(!!opts.isDock);
    this.liquidBox.add_effect(this.effect);
    this.applySettings();

    this.windowClones = new WindowCloneManager(this.liquidBox, this.cloneContainer);
    this.uiSampler = new UILayerSampler(
      this.bgActor,
      this.liquidBox,
      [opts.root, (global as any).windowGroup, global.window_group, ...(opts.exclusions ?? [])],
      this.cloneContainer
    );
  }

  /** Pushes every `<prefix>-*` value to the shader. */
  applySettings() {
    if (this._destroyed) return;
    const { settings, keyPrefix: p } = this._opts;
    this.effect.setTintColor(...hexToColorArray(settings.get_string(`${p}-tint-color`)));
    this.effect.setTintStrength(settings.get_double(`${p}-tint-strength`));
    this.effect.setCornerRadius(settings.get_double(`${p}-corner-radius`));
    this.effect.setBrightness(settings.get_double(`${p}-brightness`));
    this.effect.setContrast(settings.get_double(`${p}-contrast`));
    this.effect.setSaturation(settings.get_double(`${p}-saturation`));
    this.effect.setBlurRadius(settings.get_int(`${p}-blur-radius`));
    this._lastRadius = undefined;
  }

  /** Rebuilds the clone tree — call when the scene behind the glass changed wholesale. */
  rebuildClones() {
    if (this._destroyed) return;
    this.windowClones.rebuildClones();
    this.uiSampler.rebindSelf();
    this.uiSampler.refresh();
  }

  /** Excludes every other glass instance currently in uiGroup from this one. */
  excludeOtherGlassRoots() {
    if (this._destroyed) return;
    for (const child of Main.layoutManager.uiGroup.get_children()) {
      if (child === this.bgActor) continue;
      const isGlass = child.get_name?.() === 'liquid-glass-bg-actor' ||
        (typeof child.get_children === 'function' &&
          child.get_children().some((c: Clutter.Actor) => c.get_name?.() === 'liquid-box'));
      if (isGlass) this.uiSampler.addExclusion(child);
    }
  }

  addExclusion(actor: Clutter.Actor) {
    if (!this._destroyed && actor) this.uiSampler.addExclusion(actor);
  }

  /** Forces the next sync to rewrite the actor tree even if nothing moved. */
  invalidateGeometry() {
    this._lastX = this._lastY = this._lastW = this._lastH = undefined;
    this._lastFboW = this._lastFboH = this._lastRadius = undefined;
  }

  hide() { if (!this._destroyed) this.bgActor.hide(); }
  show() { if (!this._destroyed && !this.bgActor.visible) this.bgActor.show(); }

  /**
   * The per-frame geometry update every surface performs identically: size the
   * FBO, tell the shader where the glass sits inside it, and drag the clone
   * containers into the same coordinate space.
   */
  sync(geom: SyncGeometry) {
    if (this._destroyed) return;

    const expand = geom.expand ?? 0;
    const monitor = geom.monitor;
    const fbo = geom.fbo ?? monitor;
    const clipPad = geom.clipPadding ?? 200;

    const bgW = geom.width + 2 * (SHADER_PADDING + expand);
    const bgH = geom.height + 2 * (SHADER_PADDING + expand);
    const bgX = geom.x - SHADER_PADDING - expand;
    const bgY = geom.y - SHADER_PADDING - expand;

    const fboW = Math.max(1, fbo.width);
    const fboH = Math.max(1, fbo.height);
    const localX = bgX - fbo.x;
    const localY = bgY - fbo.y;

    if (geom.opacity !== undefined) this.bgActor.opacity = geom.opacity;

    const refW = Math.max(1, geom.refSize?.width ?? fboW);
    const refH = Math.max(1, geom.refSize?.height ?? fboH);

    const radius = geom.cornerRadius;
    if (this._lastX !== bgX || this._lastY !== bgY ||
      this._lastW !== bgW || this._lastH !== bgH ||
      this._lastFboW !== fboW || this._lastFboH !== fboH ||
      this._lastRefW !== refW || this._lastRefH !== refH ||
      (radius !== undefined && this._lastRadius !== radius)) {

      // Transitions are removed on both sides of the write: Clutter will
      // happily animate a set_position/set_size that we mean to be immediate.
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');
      this.bgActor.set_position(fbo.x, fbo.y);
      this.bgActor.set_size(fboW, fboH);
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');

      this.liquidBox.set_position(0, 0);
      this.liquidBox.set_size(fboW, fboH);

      if (geom.fbo) {
        // The band already bounds the work; liquidBox clips to its allocation.
        this.bgActor.remove_clip();
      } else {
        // Soft clip: limits fragment work to the surface plus room for the
        // shadow to decay, without hard-clipping children.
        this.bgActor.set_clip(
          localX - clipPad, localY - clipPad,
          bgW + clipPad * 2, bgH + clipPad * 2
        );
      }
      this.effect.setShadowMaxRadius(Math.max(0, clipPad - 20));

      if (radius !== undefined) {
        this.effect.setCornerRadius(radius);
        this._lastRadius = radius;
      }
      this.effect.setResolution(fboW, fboH);
      this.effect.setReferenceResolution(refW, refH);
      this.effect.setGlassGeometry(localX, localY, bgW, bgH);

      this._lastX = bgX; this._lastY = bgY;
      this._lastW = bgW; this._lastH = bgH;
      this._lastFboW = fboW; this._lastFboH = fboH;
      this._lastRefW = refW; this._lastRefH = refH;
    }

    this.windowClones.setOffset(-fbo.x, -fbo.y);
    // Only rescans when uiGroup's children or their visibility actually
    // changed; see UILayerSampler.refreshIfDirty().
    this.uiSampler.refreshIfDirty();
    this.uiSampler.sync(fbo.x, fbo.y, fboW, fboH);
    this.windowClones.sync();
  }

  /**
   * Order matters: the effect owns Cogl pipelines tied to the actor, so it is
   * cleaned up first. Destroying bgActor then cascades the whole subtree.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    try { this.effect.cleanup(); } catch (_) { }
    try { this.bgActor.hide(); } catch (_) { }
    try { this.bgActor.destroy(); } catch (_) { }
    try { this.uiSampler.destroy(); } catch (_) { }
    try { this.windowClones.destroy(); } catch (_) { }
  }
}

/**
 * Runs `tick` before every redraw, and can be stopped and restarted.
 *
 * The `later` id must be dropped before actors are destroyed, which is what
 * `stop()` guarantees — a manager that merely zeroed the id (as one did) leaves
 * the callback armed against a destroyed tree.
 */
export class FrameLoop {
  private _id = 0;
  private _tick: () => void;
  private _shouldRun: () => boolean;
  private _onStart?: () => void;

  constructor(tick: () => void, shouldRun: () => boolean, onStart?: () => void) {
    this._tick = tick;
    this._shouldRun = shouldRun;
    this._onStart = onStart;
  }

  get running(): boolean { return this._id !== 0; }

  start() {
    if (this._id !== 0 || !this._shouldRun()) return;
    this._onStart?.();

    const step = () => {
      this._id = 0;
      if (!this._shouldRun()) return GLib_SOURCE_REMOVE;
      this._tick();
      this._id = laterAdd(step);
      return GLib_SOURCE_REMOVE;
    };
    this._id = laterAdd(step);
  }

  stop() {
    if (this._id === 0) return;
    try { global.compositor?.get_laters?.().remove(this._id); } catch (_) { }
    this._id = 0;
  }

  /** Stops only if the run condition has gone false. */
  stopIfIdle() {
    if (!this._shouldRun()) this.stop();
  }
}
