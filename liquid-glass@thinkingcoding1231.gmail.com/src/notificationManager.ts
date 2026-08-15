// src/notificationManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { GlassLayer, tightFbo } from './glassSurface.js';
import { AdaptiveTextController, AdaptiveGroup, findTextActors } from './adaptiveText.js';
import Gio from 'gi://Gio';
import {
  UnpickableActor,
  UILayerSampler,
  WindowCloneManager,
} from './utils.js';

import { Logger } from './logger.js';


// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;
const HIDE_SAFETY_MARGIN = 7;

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
}

export class NotificationManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private tray: St.Widget;

  private currentBanner: St.Widget | null = null;

  // Full-screen FBO actor hierarchy (matches dockManager pattern)
  //   bgActor (full monitor, no effect)
  //     └─ liquidBox  ← LiquidEffect with built-in dual-Kawase blur
  //          ├─ _cloneContainer ← WindowCloneManager + UILayerSampler deposits here
  //          └─ dummyBreaker (prevents BMS black-screen optimization bug)
  private bgActor: Clutter.Actor | null = null;
  private liquidBox: Clutter.Actor | null = null;
  private _cloneContainer: Clutter.Actor | null = null;
  private effect: LiquidEffect | null = null;

  private _windowCloneManager: WindowCloneManager | null = null;
  private _uiSampler: UILayerSampler | null = null;
  private layer: GlassLayer | null = null;

  private _signals: number[];
  private _settingsSignals: number[];
  private _frameSyncId: number;
  private _isEffectActive: boolean;

  private _stableBaseW: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  // The render target: a box around the banner rather than the whole monitor.
  private _lastFboX: number | undefined;
  private _lastFboY: number | undefined;
  private _lastFboW: number | undefined;
  private _lastFboH: number | undefined;

  // Sized inputs to the render target; refreshed from their 'changed::'.
  private _blurRadius: number = 0;
  private _shadowRadius: number = 0;

  private _adaptiveText: AdaptiveTextController | null = null;

  private _glassExpand: number;
  private _baseTint: number;
  private _currentTint: number;
  private _notificationYOffset: number;


  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
    this.tray = Main.messageTray;

    this._signals = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._isEffectActive = false;


    this._glassExpand = 12;
    this._baseTint = 0.08;
    this._currentTint = 0.08;
    this._notificationYOffset = 10;
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    if (this._settings.get_boolean('enable-notification-glass')) {
      this._applyEffect();
    }
  }

  // Utility: Convert HEX color string to normalized RGB array
  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
      return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting('enable-notification-glass', () => {
      let enabled = this._settings.get_boolean('enable-notification-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('popup-tint-color', () => {
      if (this.effect && this._isEffectActive) {
        let colorArray = this._hexToColorArray(this._settings.get_string('popup-tint-color'));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting('popup-tint-strength', () => {
      if (this.effect && this._isEffectActive) {
        this._baseTint = this._settings.get_double('popup-tint-strength');
    this._blurRadius = this._settings.get_int('popup-blur-radius');
    this._shadowRadius = this._settings.get_double('shadow-radius');
        this._currentTint = this._baseTint;
        this.effect.setTintStrength(this._baseTint);
      }
    });

    connectSetting('shadow-radius', () => {
      // Not a popup-prefixed key, but the shadow's decay distance helps size
      // the render target, so it is tracked here too.
      this._shadowRadius = this._settings.get_double('shadow-radius');
    });

    connectSetting('popup-blur-radius', () => {
      this._blurRadius = this._settings.get_int('popup-blur-radius');
      if (this.effect && this._isEffectActive) {
        this.effect.setBlurRadius(this._blurRadius);
      }
    });

    connectSetting('popup-corner-radius', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setCornerRadius(this._settings.get_double('popup-corner-radius'));
      }
    });

    connectSetting('popup-glass-expand', () => {
      if (this._isEffectActive) {
        this._glassExpand = this._settings.get_int('popup-glass-expand');
      }
    });

    // Brightness / Saturation / Contrast — dynamic application from settings
    connectSetting('popup-brightness', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setBrightness(this._settings.get_double('popup-brightness'));
      }
    });

    connectSetting('popup-saturation', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setSaturation(this._settings.get_double('popup-saturation'));
      }
    });

    connectSetting('popup-contrast', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setContrast(this._settings.get_double('popup-contrast'));
      }
    });

    connectSetting('popup-enable-adaptive-text-color', () => {
      this._adaptiveText?.syncSettings();
    });

    connectSetting('popup-sample-interval-ms', () => {
      this._adaptiveText?.syncSettings();
    });

    connectSetting('notification-y-offset', () => {
      this._notificationYOffset = this._settings.get_int('notification-y-offset');
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    // Adaptive text colouring — shared implementation, see src/adaptiveText.ts
    this._createAdaptiveText();

    // @ts-expect-error: _bannerBin is an internal property
    let bannerBin = this.tray._bannerBin;
    if (!bannerBin) {
      this._logger.error('[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.');
      return;
    }

    // Apply settings initially
      this._adaptiveText?.syncSettings();
    this._glassExpand = this._settings.get_int('popup-glass-expand');
    this._baseTint = this._settings.get_double('popup-tint-strength');
    this._currentTint = this._baseTint;
    this._notificationYOffset = this._settings.get_int('notification-y-offset');

    // Listen for new notifications
    this._signals.push(bannerBin.connect('child-added', (container, actor: St.Widget) => {
      if (actor === this.bgActor || actor.get_name?.() === 'liquid-glass-bg-actor') return;

      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        // @ts-expect-error: _banner is an internal property
        let banner = this.tray._banner || actor;
        if (banner && banner !== this.currentBanner) {
          this._cleanupCurrentBanner();
          this.currentBanner = banner;
          this._setupBannerEffect(banner);
        }
        return GLib.SOURCE_REMOVE;
      });
    }));

    this._signals.push(bannerBin.connect('child-removed', (container, actor: St.Widget) => {
      if (actor === this.bgActor || actor.get_name?.() === 'liquid-glass-bg-actor') return;
      this._cleanupCurrentBanner();
    }));

    // @ts-expect-error
    if (this.tray._banner) {
      // @ts-expect-error
      this.currentBanner = this.tray._banner;
      // @ts-expect-error
      this._setupBannerEffect(this.tray._banner);
    }
  }

  _setupBannerEffect(targetActor: St.Widget) {
    targetActor.add_style_class_name('liquid-glass-transparent');

    // @ts-expect-error
    if (this.tray._bannerBin) {
      // @ts-expect-error
      this.tray._bannerBin.translation_y = this._settings.get_int('notification-y-offset');
    }

    // ── Find the bannerBin's ancestor that is a direct child of uiGroup ──────
    // @ts-expect-error
    let bannerBin = this.tray._bannerBin;
    let bannerRoot: Clutter.Actor = bannerBin ?? targetActor;
    while (bannerRoot.get_parent() && bannerRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = bannerRoot.get_parent();
      if (!p) break;
      bannerRoot = p;
    }

    // Actor tree, shader and clone samplers — all shared, see glassSurface.ts.
    this._baseTint = this._settings.get_double('popup-tint-strength');
    this.layer = new GlassLayer({
      extensionPath: this.extensionPath,
      settings: this._settings,
      logger: this._logger,
      keyPrefix: 'popup',
      root: bannerRoot,
    });
    this.bgActor = this.layer.bgActor;
    this.liquidBox = this.layer.liquidBox;
    this._cloneContainer = this.layer.cloneContainer;
    this.effect = this.layer.effect;
    this._windowCloneManager = this.layer.windowClones;
    this._uiSampler = this.layer.uiSampler;

    this.layer.show();

    // Initial clone build (also applies liquid-glass mutual exclusions)
    this._buildClones();

    // ── 7. Frame-render loop ──────────────────────────────────────────────────
    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
    const frameTick = () => {
      this._frameSyncId = 0;
      if (!this.bgActor || !this.currentBanner) return GLib.SOURCE_REMOVE;

      this._syncGeometry();

      // Hover tint animation (notification-specific behaviour preserved)
      let isHovered = this.currentBanner.hover;
      let targetTint = isHovered ? (this._baseTint + 0.1) : this._baseTint;
      if (Math.abs(this._currentTint - targetTint) > 0.001) {
        this._currentTint += (targetTint - this._currentTint) * 0.1;
        this.effect?.setTintStrength(this._currentTint);
      }

      this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
    this._adaptiveText?.start();
  }

  // ── Geometry synchronisation ────────────────────────────────────────────────
  // Called every frame. Uses full-screen FBO architecture so that BMS coordinate
  // assumptions are satisfied (all actors cover the entire monitor).
  _syncGeometry() {
    if (!this.bgActor || !this.currentBanner) return;

    let [w, h] = this.currentBanner.get_size();
    let [absX, absY] = this.currentBanner.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return;

    this.bgActor.opacity = this.currentBanner.opacity;

    let themeNode = this.currentBanner.get_theme_node();
    let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
    let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
    let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
    let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

    // Hide when the notification banner has slid completely off-screen
    if (absY + h <= mB + HIDE_SAFETY_MARGIN) {
      this.bgActor.hide();
      return;
    } else if (!this.bgActor.visible) {
      this.bgActor.show();
    }

    // Margin-bloat compensation (same logic as before, now used only for shader geometry)
    let marginW = mL + mR;
    let marginH = mT + mB;

    if (this._stableBaseW === undefined) {
      this._stableBaseW = w;
    }
    if (Math.abs(this._stableBaseW - (w + marginW)) <= 1) {
      this._stableBaseW = w;
    }

    let isBloated = Math.abs(w - (this._stableBaseW + marginW)) <= 1;
    let visualW = isBloated ? w - marginW : w;
    let visualH = isBloated ? h - marginH : h;
    if (!isBloated) this._stableBaseW = w;

    let visualX = absX;
    let visualY = absY;

    let bgW = visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgH = visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgX_abs = visualX - this._glassExpand - SHADER_PADDING;
    let bgY_abs = visualY - this._glassExpand - SHADER_PADDING;

    // ── Monitor geometry ─────────────────────────────────────────────────────
    let monitorIndex = Main.layoutManager.findIndexForActor(this.tray);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    let monitorX = monitor?.x ?? 0;
    let monitorY = monitor?.y ?? 0;
    let screenW = Math.max(1, monitor?.width ?? 1);
    let screenH = Math.max(1, monitor?.height ?? 1);

    // Monitor-local coordinates (shader uses these)
    let localBgX = bgX_abs - monitorX;
    let localBgY = bgY_abs - monitorY;

    // A banner is a small box near the top of the screen, so rendering it into
    // a monitor-sized target meant running the blur chain and the composite
    // pass over the whole display for it. Narrow the target to the banner plus
    // the reach of the blur and shadow.
    const fbo = tightFbo({ x: bgX_abs, y: bgY_abs, width: bgW, height: bgH },
      { x: monitorX, y: monitorY, width: screenW, height: screenH },
      this._blurRadius, this._shadowRadius);

    // ── Update actors only when geometry actually changed ────────────────────
    if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
      this._lastBgX !== bgX_abs || this._lastBgY !== bgY_abs ||
      this._lastScreenW !== screenW || this._lastScreenH !== screenH ||
      this._lastFboX !== fbo.x || this._lastFboY !== fbo.y ||
      this._lastFboW !== fbo.width || this._lastFboH !== fbo.height) {

      // bgActor: the render target, at its own origin
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');
      this.bgActor.set_position(fbo.x, fbo.y);
      this.bgActor.set_size(fbo.width, fbo.height);
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');

      // liquidBox fills the entire bgActor
      this.liquidBox?.set_position(0, 0);
      this.liquidBox?.set_size(fbo.width, fbo.height);

      // No soft clip: the target is already bounded to the region that can
      // contribute, and liquidBox clips to its allocation.
      this.liquidBox?.remove_clip();
      this.bgActor.remove_clip();

      const SHADOW_MAX_RADIUS = 180;
      this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);

      // Resolution follows the target; the optical constants stay pinned to the
      // monitor size, so narrowing the target does not change the look.
      this.effect?.setResolution(fbo.width, fbo.height);
      this.effect?.setReferenceResolution(screenW, screenH);
      this.effect?.setGlassGeometry(bgX_abs - fbo.x, bgY_abs - fbo.y, bgW, bgH);

      this._lastBgW = bgW; this._lastBgH = bgH;
      this._lastBgX = bgX_abs; this._lastBgY = bgY_abs;
      this._lastScreenW = screenW; this._lastScreenH = screenH;
      this._lastFboX = fbo.x; this._lastFboY = fbo.y;
      this._lastFboW = fbo.width; this._lastFboH = fbo.height;
    }

    // ── Sync clones every frame (dockManager pattern) ────────────────────────
    // Clones are positioned relative to the render target's origin.
    this._windowCloneManager?.setOffset(-fbo.x, -fbo.y);
    // Only rescans when uiGroup's children or their visibility actually
    // changed; see UILayerSampler.refreshIfDirty().
    this._uiSampler?.refreshIfDirty();
    this._uiSampler?.sync(fbo.x, fbo.y, fbo.width, fbo.height);
    this._windowCloneManager?.sync();
  }

  // Called once when the banner effect is first set up (and after monitor changes).
  // Applies mutual exclusions between multiple Liquid Glass bgActors, then
  // delegates clone construction to WindowCloneManager + UILayerSampler.
  _buildClones() {
    if (!this.bgActor) return;

    if (this._uiSampler) {
      for (let child of Main.layoutManager.uiGroup.get_children()) {
        if (child === this.bgActor) continue;
        let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
          (typeof child.get_children === 'function' &&
            child.get_children().some((c: Clutter.Actor) => c.get_name?.() === 'liquid-box'));
        if (isLiquidBg) this._uiSampler.addExclusion(child);
      }
    }

    this._windowCloneManager?.rebuildClones();
    this._uiSampler?.rebindSelf();
    this._uiSampler?.refresh();
  }

  // ── Per-banner cleanup ──────────────────────────────────────────────────────
  _cleanupCurrentBanner() {
    this._adaptiveText?.stop();
    this._adaptiveText?.clear();

    // @ts-expect-error
    if (this.tray._bannerBin) {
      // @ts-expect-error
      this.tray._bannerBin.translation_y = 0;
    }

    if (this.currentBanner) {
      this.currentBanner.remove_style_class_name('liquid-glass-transparent');
      this.currentBanner.translation_y = 0;
      this.currentBanner = null;
    }

    if (this._frameSyncId !== 0) {
      if (global.compositor?.get_laters) global.compositor.get_laters().remove(this._frameSyncId);
      this._frameSyncId = 0;
    }

    // Teardown order (effect before actor) is handled by GlassLayer.
    this.layer?.destroy();
    this.layer = null;
    this.effect = null;
    this.bgActor = null;
    this.liquidBox = null;
    this._cloneContainer = null;
    this._uiSampler = null;
    this._windowCloneManager = null;

    // Reset cached geometry state
    this._lastBgW = undefined;
    this._lastBgH = undefined;
    this._lastBgX = undefined;
    this._lastBgY = undefined;
    this._lastScreenW = undefined;
    this._lastScreenH = undefined;
    this._stableBaseW = undefined;

  }

  // ── Effect remove / cleanup ─────────────────────────────────────────────────
  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    // @ts-expect-error
    let bannerBin = this.tray._bannerBin;
    for (let sigId of this._signals) {
      try { bannerBin.disconnect(sigId); } catch (e) { }
    }
    this._signals = [];

    this._cleanupCurrentBanner();
  }

  cleanup() {
    for (let sigId of this._settingsSignals) {
      this._settings.disconnect(sigId);
    }
    this._settingsSignals = [];
    this._removeEffect();
  }

  // ── Adaptive text colour helpers (unchanged logic) ──────────────────────────

  _hasStyleClass(actor: St.Widget, className: string) {
    return typeof actor?.has_style_class_name === 'function' &&
      actor.has_style_class_name(className);
  }

  _laterAdd(laterType: Meta.LaterType, callback: GLib.SourceFunc) {
    return global.compositor?.get_laters?.().add(laterType, callback);
  }
  /** The banner is one region; its own body/title share a backdrop. */
  _buildAdaptiveGroups(): AdaptiveGroup[] {
    const banner = this.currentBanner as Clutter.Actor | null;
    if (!banner || !banner.mapped) return [];
    const targets = findTextActors(banner);
    return targets.length > 0 ? [{ key: banner, targets }] : [];
  }

  _createAdaptiveText() {
    this._adaptiveText?.destroy();
    this._adaptiveText = new AdaptiveTextController({
      settings: this._settings,
      logger: this._logger,
      enabledKey: 'popup-enable-adaptive-text-color',
      intervalKey: 'popup-sample-interval-ms',
      collectGroups: () => this._buildAdaptiveGroups(),
      shouldSample: () => !!this.currentBanner?.mapped,
    });
  }

}
