// src/panelManager.ts
//
// Applies the liquid glass effect to the GNOME top panel bar.
//
// This is the dockManager pattern (permanent, always-visible glass) crossed
// with the osdManager pattern (one state per monitor, a single shared frame
// loop, full rebuild on monitors-changed).
//
// Two shapes are supported, selected by the `panel-floating` key:
//
//   Floating   the panel is inset with a CSS margin and the glass is drawn as
//              a fully rounded pill inside that inset.
//   Full width the panel stays edge-to-edge and the glass box is stretched to
//              the monitor, with its top edge pushed above the screen so only
//              the bottom two corners are visibly rounded.
//
// Unlike every other target here the panel is on screen permanently, so the
// per-frame clone sync would otherwise run forever. It is stopped whenever the
// Overview is up (GNOME styles the panel transparent itself there) and whenever
// panelBox is unmapped (which is what happens under a fullscreen window).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { GlassLayer } from './glassSurface.js';
import { AdaptiveTextController, AdaptiveGroup, findTextActors } from './adaptiveText.js';
import { UnpickableActor, UILayerSampler, WindowCloneManager } from './utils.js';
import { Logger } from './logger.js';

// Padding that lets the shader draw refraction/blur outside the strict bounds.
const SHADER_PADDING = 20;

// Slack added around the glass when sizing the FBO band, on top of the blur and
// shadow reach, so neither gets clipped into a visible seam.
const BAND_SLACK = 24;

// Matches GNOME's own overview animation so the glass fades in step with it.
const OVERVIEW_FADE_MS = 250;

// Deadband around the light/dark text threshold. The sampler measures the
// composited screen, so our own glyphs are part of the reading, and a bare
// threshold oscillates forever whenever the backdrop sits near it. Measured
// self-feedback with the padded sample rect below is ~0.008, so this is a ~7x
// margin: wide enough that we can never flip ourselves, narrow enough to still
// react when the backdrop genuinely changes.
const HYSTERESIS = 0.06;

interface CustomTextActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
}

interface PanelState {
  panel: St.Widget;              // the #panel widget itself
  root: Clutter.Actor;           // its uiGroup-direct ancestor (panelBox)

  bgActor: Clutter.Actor | null;
  liquidBox: Clutter.Actor | null;
  _cloneContainer: Clutter.Actor | null;
  effect: LiquidEffect | null;

  _windowCloneManager: WindowCloneManager | null;
  _uiSampler: UILayerSampler | null;

  // Geometry caches, so the actor tree is only touched when something moved.
  _lastBgW?: number;
  _lastBgH?: number;
  _lastBgX?: number;
  _lastBgY?: number;
  _lastScreenW?: number;
  _lastScreenH?: number;
  _lastRadius?: number;

  // Set whenever uiGroup's child list changes, so the (relatively expensive)
  // clone refresh + z-order exclusion pass runs then rather than every frame.
  _uiDirty: boolean;

  layer: GlassLayer | null;
  _originalStyle: string | undefined;
  // The exact string we last handed to set_style, so the style-changed watcher
  // can tell our own write apart from someone else's.
  _appliedStyle: string | null;
  _styleGuard: boolean;

  _mappedId: number;
  _destroyId: number;
  _styleChangedId: number;
}

function hexToColorArray(hex: string): [number, number, number] {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
    return [1.0, 1.0, 1.0];
  let r = parseInt(hex.slice(1, 3), 16) / 255.0;
  let g = parseInt(hex.slice(3, 5), 16) / 255.0;
  let b = parseInt(hex.slice(5, 7), 16) / 255.0;
  return [r, g, b];
}

export class PanelManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;

  private _states: PanelState[];
  private _settingsSignals: number[];
  private _frameSyncId: number;
  private _monitorsChangedId: number;
  private _overviewShowingId: number;
  private _overviewHidingId: number;
  private _rescanTimeoutId: number;
  private _uiGroupChildAddedId: number;
  private _uiGroupChildRemovedId: number;
  private _isEffectActive: boolean;

  private _glassExpand: number;
  private _floating: boolean;
  private _sideMargin: number;
  private _topMargin: number;
  private _panelHeight: number;
  private _transparent: boolean;

  // Read by _syncGeometry on every frame, so they are cached here and
  // refreshed from their 'changed::' handlers rather than fetched per frame.
  private _cornerRadiusSetting: number;
  private _blurRadius: number;
  private _shadowRadius: number;

  // Overview state. _inOverview stops the frame loop entirely;
  // _overviewTransition suppresses the per-frame opacity write so the fade
  // tween is not overwritten on the very next frame.
  private _inOverview: boolean;
  private _overviewTransition: boolean;

  private _adaptiveText: AdaptiveTextController | null = null;
  // Last light/dark decision per panel box, so the deadband has a previous
  // state to hold on to.

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;

    this._states = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._monitorsChangedId = 0;
    this._overviewShowingId = 0;
    this._overviewHidingId = 0;
    this._rescanTimeoutId = 0;
    this._uiGroupChildAddedId = 0;
    this._uiGroupChildRemovedId = 0;
    this._isEffectActive = false;

    this._glassExpand = 0;
    this._floating = true;
    this._sideMargin = 8;
    this._topMargin = 4;
    this._panelHeight = 0;
    this._transparent = false;
    this._cornerRadiusSetting = 0;
    this._blurRadius = 0;
    this._shadowRadius = 0;

    this._inOverview = false;
    this._overviewTransition = false;

  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    if (this._settings.get_boolean('enable-panel-glass'))
      this._applyEffect();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting('enable-panel-glass', () => {
      let enabled = this._settings.get_boolean('enable-panel-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    // Live shader parameters.
    const forEachEffect = (fn: (e: LiquidEffect) => void) => {
      if (!this._isEffectActive) return;
      for (let state of this._states)
        if (state.effect) fn(state.effect);
    };

    connectSetting('panel-tint-color', () => {
      let c = hexToColorArray(this._settings.get_string('panel-tint-color'));
      forEachEffect(e => e.setTintColor(...c));
    });
    connectSetting('panel-tint-strength', () => {
      let v = this._settings.get_double('panel-tint-strength');
      forEachEffect(e => e.setTintStrength(v));
    });
    connectSetting('panel-blur-radius', () => {
      let v = this._settings.get_int('panel-blur-radius');
      this._blurRadius = v;
      // The blur reach sets how far the FBO band must extend past the glass.
      this._resetGeometryCaches();
      forEachEffect(e => e.setBlurRadius(v));
    });
    connectSetting('panel-corner-radius', () => {
      // Deliberately not pushed straight to the effect: the usable radius is
      // capped at half the panel height, and _syncGeometry owns that clamp.
      this._cornerRadiusSetting = this._settings.get_double('panel-corner-radius');
      this._resetGeometryCaches();
    });
    // Not a panel-prefixed key — the shadow is a global glass setting, pushed
    // to the effect by LiquidEffect's own binding. It is tracked here only
    // because the shadow's decay distance also sizes the FBO band.
    connectSetting('shadow-radius', () => {
      this._shadowRadius = this._settings.get_double('shadow-radius');
      this._resetGeometryCaches();
    });
    connectSetting('panel-brightness', () => {
      let v = this._settings.get_double('panel-brightness');
      forEachEffect(e => e.setBrightness(v));
    });
    connectSetting('panel-contrast', () => {
      let v = this._settings.get_double('panel-contrast');
      forEachEffect(e => e.setContrast(v));
    });
    connectSetting('panel-saturation', () => {
      let v = this._settings.get_double('panel-saturation');
      forEachEffect(e => e.setSaturation(v));
    });

    connectSetting('panel-glass-expand', () => {
      this._glassExpand = this._settings.get_int('panel-glass-expand');
      this._resetGeometryCaches();
    });

    // Shape. Changing any of these restyles the panel and invalidates geometry.
    const reshape = () => {
      this._floating = this._settings.get_boolean('panel-floating');
      this._sideMargin = this._settings.get_int('panel-side-margin');
      this._topMargin = this._settings.get_int('panel-top-margin');
      this._panelHeight = this._settings.get_int('panel-height');
      this._transparent = this._settings.get_boolean('panel-transparent');
      if (!this._isEffectActive) return;
      for (let state of this._states) this._applyPanelStyle(state);
      this._resetGeometryCaches();
    };
    connectSetting('panel-floating', reshape);
    connectSetting('panel-side-margin', reshape);
    connectSetting('panel-top-margin', reshape);
    connectSetting('panel-height', reshape);
    connectSetting('panel-transparent', reshape);

    connectSetting('panel-enable-adaptive-text-color', () => {
      this._adaptiveText?.syncSettings();
      if (!this._isEffectActive) return;
      if (this._adaptiveText?.enabled) {
        this._adaptiveText?.start();
      } else {
        this._adaptiveText?.stop();
        this._adaptiveText?.clear();
      }
    });

    connectSetting('panel-sample-interval-ms', () => {
      this._adaptiveText?.syncSettings();
      // Restart the timer so the new interval takes effect immediately.
      if (this._isEffectActive && this._adaptiveText?.enabled) {
        this._adaptiveText?.stop();
        this._adaptiveText?.start();
      }
    });
  }

  _resetGeometryCaches() {
    for (let state of this._states) {
      state._lastBgW = undefined;
      state._lastBgH = undefined;
      state._lastBgX = undefined;
      state._lastBgY = undefined;
      state._lastScreenW = undefined;
      state._lastScreenH = undefined;
      state._lastRadius = undefined;
    }
  }

  // ── Panel discovery ────────────────────────────────────────────────────────

  /**
   * Finds every panel bar currently in uiGroup: GNOME's own `Main.panel`, plus
   * any extra panels a third-party extension (e.g. Dash to Panel) has created
   * on secondary monitors. Each is paired with its uiGroup-direct ancestor,
   * which is what has to be excluded from the clone tree and used for z-order.
   */
  _discoverPanels(): { panel: St.Widget, root: Clutter.Actor }[] {
    const uiGroup = Main.layoutManager.uiGroup;
    const found: { panel: St.Widget, root: Clutter.Actor }[] = [];
    const seen = new Set<Clutter.Actor>();

    const addPanel = (panel: St.Widget | null) => {
      if (!panel || seen.has(panel)) return;
      if (typeof panel.add_style_class_name !== 'function') return;

      let root: Clutter.Actor = panel;
      while (root.get_parent() && root.get_parent() !== uiGroup) {
        const p = root.get_parent();
        if (!p) break;
        root = p;
      }
      if (root.get_parent() !== uiGroup) return;

      seen.add(panel);
      found.push({ panel, root });
    };

    addPanel(Main.panel as unknown as St.Widget);

    // Shallow scan for third-party panels. They live one or two levels under
    // uiGroup; going deeper would mean walking the whole scene graph for no
    // gain. Our own glass subtrees are skipped explicitly.
    const isPanelLike = (actor: Clutter.Actor): boolean => {
      const w = actor as St.Widget;
      if (typeof w.has_style_class_name !== 'function') return false;
      try {
        return w.get_name() === 'panel' || w.has_style_class_name('panel');
      } catch (_) {
        return false;
      }
    };

    const scan = (actor: Clutter.Actor, depth: number) => {
      if (depth > 2) return;
      let children: Clutter.Actor[];
      try {
        children = actor.get_children();
      } catch (_) {
        return;
      }
      for (const child of children) {
        const name = child.get_name?.();
        if (name === 'liquid-glass-bg-actor' || name === 'liquid-box') continue;
        if (child === global.window_group || child === (global as any).windowGroup) continue;
        if (child.mapped && isPanelLike(child)) addPanel(child as St.Widget);
        scan(child, depth + 1);
      }
    };
    scan(uiGroup, 0);

    return found;
  }

  // ── Effect setup ───────────────────────────────────────────────────────────

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    // Adaptive text colouring — shared implementation, see src/adaptiveText.ts
    this._createAdaptiveText();

    this._glassExpand = this._settings.get_int('panel-glass-expand');
    this._floating = this._settings.get_boolean('panel-floating');
    this._sideMargin = this._settings.get_int('panel-side-margin');
    this._topMargin = this._settings.get_int('panel-top-margin');
    this._panelHeight = this._settings.get_int('panel-height');
    this._transparent = this._settings.get_boolean('panel-transparent');
    this._cornerRadiusSetting = this._settings.get_double('panel-corner-radius');
    this._blurRadius = this._settings.get_int('panel-blur-radius');
    this._shadowRadius = this._settings.get_double('shadow-radius');
    this._adaptiveText?.syncSettings();
    this._inOverview = Main.overview?.visible ?? false;

    this._warnIfBlurMyShellPanelBlur();

    for (const { panel, root } of this._discoverPanels())
      this._setupPanelEffect(panel, root);

    if (this._states.length === 0) {
      this._logger.warn('[Liquid Glass] No top panel found.');
    }

    this._applyMutualExclusions();

    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
      this._rebuild();
    });

    if (Main.overview) {
      this._overviewShowingId = Main.overview.connect('showing', () => this._onOverviewShowing());
      this._overviewHidingId = Main.overview.connect('hiding', () => this._onOverviewHiding());
    }

    // Refreshing clones and recomputing exclusions only matters when uiGroup's
    // child list actually changes — doing it every frame is pure waste.
    const markDirty = () => {
      for (let state of this._states) state._uiDirty = true;
    };
    this._uiGroupChildAddedId = Main.layoutManager.uiGroup.connect('child-added', markDirty);
    this._uiGroupChildRemovedId = Main.layoutManager.uiGroup.connect('child-removed', markDirty);

    // Third-party panels can appear after we do. Re-scan once, the same way
    // extension.js waits for Dash to Dock.
    this._rescanTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
      this._rescanTimeoutId = 0;
      if (this._isEffectActive) {
        const known = new Set(this._states.map(s => s.panel));
        let added = false;
        for (const { panel, root } of this._discoverPanels()) {
          if (known.has(panel)) continue;
          this._setupPanelEffect(panel, root);
          added = true;
        }
        if (added) {
          this._applyMutualExclusions();
          this._startFrameSync();
        }
      }
      return GLib.SOURCE_REMOVE;
    });

    this._startFrameSync();
    this._adaptiveText?.start();
  }

  _rebuild() {
    this._removeEffect();
    if (this._settings.get_boolean('enable-panel-glass'))
      this._applyEffect();
  }

  /**
   * Blur My Shell's panel blur lives inside panelBox, i.e. above our bgActor,
   * so it paints over the glass. We deliberately do not touch another
   * extension's settings — just say so in the log.
   */
  _warnIfBlurMyShellPanelBlur() {
    try {
      const ext = (Main as any).extensionManager?.lookup?.('blur-my-shell@aunetx');
      const panelBlur = ext?.stateObj?._panel_blur;
      if (panelBlur?.actors_list?.length) {
        this._logger.warn(
          '[Liquid Glass] Blur My Shell panel blur is active. It renders inside panelBox, ' +
          'above the liquid glass, so the panel will look doubly blurred. ' +
          'Turn off "Panel" blur in Blur My Shell for the intended look.'
        );
      }
    } catch (_) { /* BMS absent or restructured — nothing to warn about */ }
  }

  _setupPanelEffect(panel: St.Widget, root: Clutter.Actor) {
    const uiGroup = Main.layoutManager.uiGroup;

    const state: PanelState = {
      panel,
      root,
      bgActor: null,
      liquidBox: null,
      _cloneContainer: null,
      effect: null,
      _windowCloneManager: null,
      _uiSampler: null,
      layer: null,
      _uiDirty: true,
      _originalStyle: undefined,
      _appliedStyle: null,
      _styleGuard: false,
      _mappedId: 0,
      _destroyId: 0,
      _styleChangedId: 0,
    };

    // Make the real panel transparent. The `.liquid-glass-transparent` rule
    // uses !important, which beats #panel's id specificity.
    panel.add_style_class_name('liquid-glass-transparent');
    this._applyPanelStyle(state);

    // Actor tree, shader and clone samplers — all shared, see glassSurface.ts.
    // The panel sits ON TOP of its own glass, so its root must never be cloned
    // into it; other panels' roots are added by _applyMutualExclusions().
    const layer = new GlassLayer({
      extensionPath: this.extensionPath,
      settings: this._settings,
      logger: this._logger,
      keyPrefix: 'panel',
      root,
    });
    state.layer = layer;
    state.bgActor = layer.bgActor;
    state.liquidBox = layer.liquidBox;
    state._cloneContainer = layer.cloneContainer;
    state.effect = layer.effect;
    state._windowCloneManager = layer.windowClones;
    state._uiSampler = layer.uiSampler;

    layer.rebuildClones();
    this._excludeActorsAboveTarget(state);

    if (this._inOverview || this._transparent) layer.hide();
    else layer.show();

    // panelBox is unmapped under a fullscreen window; that is our cue to stop
    // doing per-frame work entirely.
    state._mappedId = root.connect('notify::mapped', () => {
      if (root.mapped) this._startFrameSync();
      else this._stopFrameSyncIfIdle();
    });

    state._styleChangedId = panel.connect('style-changed', () => {
      this._onPanelStyleChanged(state);
    });

    state._destroyId = panel.connect('destroy', () => {
      state._destroyId = 0;
      this._states = this._states.filter(s => s !== state);
      this._cleanupState(state, /* targetGone */ true);
    });

    this._states.push(state);
  }

  /**
   * Excludes every uiGroup child stacked *above* this panel from its backdrop.
   *
   * Anything above the panel in z-order is painted over it, so by definition it
   * is not behind the glass. Without this, an open panel menu — which GNOME
   * appends straight to uiGroup, above panelBox — gets cloned into the very
   * panel it hangs from and appears refracted inside it.
   *
   * This also sweeps up top_window_group, modal dialogs, the OSK, the
   * screenshot UI and any other extension's top-level chrome. In the steady
   * state it leaves the panel sampler cloning nothing at all from uiGroup, so
   * the backdrop is purely wallpaper plus window clones.
   */
  _excludeActorsAboveTarget(state: PanelState) {
    if (!state._uiSampler) return;
    const children = Main.layoutManager.uiGroup.get_children();
    const idx = children.indexOf(state.root);
    if (idx < 0) return;
    for (let i = idx + 1; i < children.length; i++) {
      if (children[i] === state.bgActor) continue;
      state._uiSampler.addExclusion(children[i]);
    }
  }

  /** Cross-excludes every glass root so no instance clones another. */
  _applyMutualExclusions() {
    const uiGroup = Main.layoutManager.uiGroup;

    for (let state of this._states) {
      if (!state._uiSampler) continue;

      for (let other of this._states) {
        if (other === state) continue;
        if (other.bgActor) state._uiSampler.addExclusion(other.bgActor);
        // Another monitor's panel must not be cloned into this one's glass.
        state._uiSampler.addExclusion(other.root);
      }

      for (let child of uiGroup.get_children()) {
        if (child === state.bgActor) continue;
        let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
          (typeof child.get_children === 'function' &&
            child.get_children().some((c: Clutter.Actor) => c.get_name?.() === 'liquid-box'));
        if (isLiquidBg) state._uiSampler.addExclusion(child);
      }
    }
  }

  /**
   * Floating mode is implemented purely as a CSS margin on the panel widget.
   * panelBox derives its preferred height from the panel including margins, so
   * GNOME's LayoutManager keeps owning panelBox's allocation and the strut
   * follows automatically — we never fight it, and the hot corner and menu
   * anchoring keep working off an unchanged actor hierarchy.
   */
  _applyPanelStyle(state: PanelState) {
    if (state._originalStyle === undefined)
      state._originalStyle = state.panel.get_style() || '';

    const parts: string[] = [];

    if (this._floating) {
      const side = Math.max(0, this._sideMargin);
      const top = Math.max(0, this._topMargin);
      parts.push(`margin: ${top}px ${side}px 0 ${side}px;`);
    }

    // Overrides the theme's `#panel { height: 2.2em }`. panelBox takes its
    // height from the panel, so the strut and the hot-corner barrier follow on
    // their own. 0 means "leave the theme alone".
    if (this._panelHeight > 0)
      parts.push(`height: ${this._panelHeight}px;`);

    let next: string | null;
    if (parts.length === 0)
      next = state._originalStyle === '' ? null : state._originalStyle;
    else
      next = `${state._originalStyle} ${parts.join(' ')}`;

    state._styleGuard = true;
    try {
      state.panel.set_style(next);
      state._appliedStyle = next;
    } finally {
      state._styleGuard = false;
    }
  }

  /**
   * Puts the floating margin back when something else overwrites the panel's
   * inline style.
   *
   * Blur My Shell's panel component drives `Main.panel.set_style()` itself, so
   * with it installed our margin gets cleared moments after we set it and the
   * panel silently snaps back to full width. Theme reloads can do the same.
   * Whatever the other writer left behind becomes the new base, so we layer on
   * top of it rather than clobbering it.
   */
  _onPanelStyleChanged(state: PanelState) {
    if (state._styleGuard || !this._isEffectActive) return;
    const current = state.panel.get_style();
    if (current === state._appliedStyle) return;

    state._originalStyle = current ?? '';
    this._applyPanelStyle(state);
    this._resetGeometryCaches();
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────

  _laterAdd(laterType: Meta.LaterType, callback: GLib.SourceFunc) {
    return global.compositor?.get_laters?.().add(laterType, callback) ?? 0;
  }

  _laterRemove(id: number) {
    if (!id) return;
    if (global.compositor?.get_laters) global.compositor.get_laters().remove(id);
  }

  _shouldRunFrameSync(): boolean {
    if (!this._isEffectActive || this._inOverview) return false;
    return this._states.some(s => s.root.mapped);
  }

  _startFrameSync() {
    if (this._frameSyncId !== 0) return;
    if (!this._shouldRunFrameSync()) return;

    // Fresh clones whenever we resume — the scene behind us may have changed
    // completely while we were stopped.
    for (let state of this._states) {
      state._windowCloneManager?.rebuildClones();
      state._uiSampler?.rebindSelf();
      state._uiSampler?.refresh();
      this._excludeActorsAboveTarget(state);
      state._uiDirty = false;
    }
    this._applyMutualExclusions();

    const frameTick = () => {
      this._frameSyncId = 0;
      if (!this._shouldRunFrameSync()) return GLib.SOURCE_REMOVE;

      for (let state of this._states)
        this._syncGeometry(state);

      this._frameSyncId = this._laterAdd(Meta.LaterType.BEFORE_REDRAW, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    this._frameSyncId = this._laterAdd(Meta.LaterType.BEFORE_REDRAW, frameTick);
  }

  _stopFrameSync() {
    if (this._frameSyncId !== 0) {
      this._laterRemove(this._frameSyncId);
      this._frameSyncId = 0;
    }
  }

  _stopFrameSyncIfIdle() {
    if (!this._shouldRunFrameSync()) this._stopFrameSync();
  }

  // ── Overview ───────────────────────────────────────────────────────────────

  _onOverviewShowing() {
    if (!this._isEffectActive) return;
    this._overviewTransition = true;
    this._adaptiveText?.stop();

    let pending = this._states.length;
    if (pending === 0) {
      this._inOverview = true;
      this._overviewTransition = false;
      this._stopFrameSync();
      return;
    }

    const finish = () => {
      if (--pending > 0) return;
      this._inOverview = true;
      this._overviewTransition = false;
      this._stopFrameSync();
      for (let s of this._states) s.bgActor?.hide();
    };

    for (let state of this._states) {
      const bg = state.bgActor as any;
      if (!bg) { finish(); continue; }
      if (typeof bg.ease === 'function') {
        bg.remove_all_transitions();
        bg.ease({
          opacity: 0,
          duration: OVERVIEW_FADE_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: finish,
        });
      } else {
        bg.opacity = 0;
        finish();
      }
    }
  }

  _onOverviewHiding() {
    if (!this._isEffectActive) return;
    this._inOverview = false;
    this._overviewTransition = true;

    for (let state of this._states) {
      const bg = state.bgActor as any;
      if (!bg) continue;
      bg.opacity = 0;
      bg.show();
    }

    // Resume the loop first so the glass has correct geometry as it fades in.
    this._startFrameSync();

    let pending = this._states.length;
    const finish = () => {
      if (--pending > 0) return;
      this._overviewTransition = false;
    };
    if (pending === 0) {
      this._overviewTransition = false;
    } else {
      for (let state of this._states) {
        const bg = state.bgActor as any;
        if (!bg) { finish(); continue; }
        if (typeof bg.ease === 'function') {
          bg.remove_all_transitions();
          bg.ease({
            opacity: state.panel.opacity,
            duration: OVERVIEW_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: finish,
          });
        } else {
          bg.opacity = state.panel.opacity;
          finish();
        }
      }
    }

    this._adaptiveText?.start();
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  _syncGeometry(state: PanelState) {
    if (!state.bgActor || !state.panel) return;
    if (!state.root.mapped || !state.panel.mapped) {
      state.bgActor.hide();
      return;
    }

    // St maps CSS `margin` onto Clutter actor margins, and the parent layout
    // (panelBox, an StBoxLayout) subtracts those from the child's allocation.
    // So in floating mode get_size()/get_transformed_position() already return
    // the inset pill — subtracting theme-node margins here would inset twice.
    const [pw, ph] = state.panel.get_size();
    const [pax, pay] = state.panel.get_transformed_position();
    if (Number.isNaN(pax) || Number.isNaN(pay) || pw <= 0 || ph <= 0) return;

    let monitorIndex = Main.layoutManager.findIndexForActor(state.panel);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    const monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    let expand = this._glassExpand;
    let vx = pax, vy = pay, vw = pw, vh = ph;

    // sdRoundRect() does not clamp its radius: anything larger than half the
    // shorter side produces a degenerate shape. A panel is only ~30px tall, so
    // the raw setting almost always needs clamping. Clamped to exactly half it
    // becomes a capsule, which is the intended floating-pill look.
    const cornerRadius = Math.max(0, Math.min(
      this._cornerRadiusSetting,
      (vh + 2 * expand) / 2
    ));

    if (!this._floating) {
      // Full width: span the monitor and push the top edge off-screen by the
      // corner radius, so the top corners round out of sight and only the
      // bottom two are visible.
      const bottom = pay + ph;
      vx = monitor.x;
      vw = monitor.width;
      vy = monitor.y - cornerRadius;
      vh = bottom - vy;
      expand = 0;
    }

    // Fully transparent panel: the panel keeps its transparent style class and
    // adaptive text, but no glass is drawn and none of the clone/FBO work runs.
    if (this._transparent) {
      state.layer?.hide();
      return;
    }

    if (vw <= 1 || vh <= 1) {
      state.bgActor.hide();
      return;
    }
    if (!state.bgActor.visible && !this._inOverview) state.bgActor.show();

    if (!this._overviewTransition)
      state.bgActor.opacity = state.panel.opacity;

    const bgW = vw + 2 * (SHADER_PADDING + expand);
    const bgH = vh + 2 * (SHADER_PADDING + expand);
    const bgX = vx - SHADER_PADDING - expand;
    const bgY = vy - SHADER_PADDING - expand;

    // The FBO is a horizontal band around the panel rather than the whole
    // monitor. The blur chain and composite pass run over the entire FBO, so on
    // a permanent target this is the difference between blurring ~180 rows and
    // ~1080 every frame. The band must clear the glass by the blur reach and
    // the shadow decay, or a bright seam appears along the edge.
    const blurReach = this._blurRadius * 2;
    const shadowReach = this._shadowRadius;
    const pad = Math.ceil(Math.max(blurReach, shadowReach)) + BAND_SLACK;

    const bandTop = Math.max(monitor.y, bgY - pad);
    const bandBottom = Math.min(monitor.y + monitor.height, bgY + bgH + pad);
    const fboY = bandTop;
    const fboW = Math.max(1, monitor.width);
    const fboH = Math.max(1, bandBottom - bandTop);

    const localBgX = bgX - monitor.x;
    const localBgY = bgY - fboY;

    if (state._lastBgW !== bgW || state._lastBgH !== bgH ||
      state._lastBgX !== bgX || state._lastBgY !== bgY ||
      state._lastScreenW !== fboW || state._lastScreenH !== fboH ||
      state._lastRadius !== cornerRadius) {

      state.bgActor.remove_transition('size');
      state.bgActor.remove_transition('position');
      state.bgActor.set_position(monitor.x, fboY);
      state.bgActor.set_size(fboW, fboH);
      state.bgActor.remove_transition('size');
      state.bgActor.remove_transition('position');

      // liquidBox has clip_to_allocation, so the band itself is the clip.
      state.liquidBox?.set_position(0, 0);
      state.liquidBox?.set_size(fboW, fboH);
      state.bgActor.remove_clip();

      state.effect?.setCornerRadius(cornerRadius);
      state.effect?.setShadowMaxRadius(Math.max(0, pad - BAND_SLACK));
      state.effect?.setResolution(fboW, fboH);
      state.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

      state._lastBgW = bgW; state._lastBgH = bgH;
      state._lastBgX = bgX; state._lastBgY = bgY;
      state._lastScreenW = fboW; state._lastScreenH = fboH;
      state._lastRadius = cornerRadius;
    }

    state._windowCloneManager?.setOffset(-monitor.x, -fboY);
    if (state._uiDirty) {
      state._uiDirty = false;
      state._uiSampler?.refresh();
      this._excludeActorsAboveTarget(state);
    }
    state._uiSampler?.sync(monitor.x, fboY, fboW, fboH);
    state._windowCloneManager?.sync();
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._adaptiveText?.stop();
    this._adaptiveText?.clear();

    if (this._rescanTimeoutId !== 0) {
      GLib.Source.remove(this._rescanTimeoutId);
      this._rescanTimeoutId = 0;
    }

    if (this._monitorsChangedId !== 0) {
      Main.layoutManager.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = 0;
    }

    if (this._overviewShowingId !== 0) {
      Main.overview.disconnect(this._overviewShowingId);
      this._overviewShowingId = 0;
    }
    if (this._overviewHidingId !== 0) {
      Main.overview.disconnect(this._overviewHidingId);
      this._overviewHidingId = 0;
    }

    if (this._uiGroupChildAddedId !== 0) {
      Main.layoutManager.uiGroup.disconnect(this._uiGroupChildAddedId);
      this._uiGroupChildAddedId = 0;
    }
    if (this._uiGroupChildRemovedId !== 0) {
      Main.layoutManager.uiGroup.disconnect(this._uiGroupChildRemovedId);
      this._uiGroupChildRemovedId = 0;
    }

    this._stopFrameSync();

    for (let state of this._states)
      this._cleanupState(state, /* targetGone */ false);
    this._states = [];

    this._overviewTransition = false;
  }

  _cleanupState(state: PanelState, targetGone: boolean) {
    if (state._mappedId !== 0) {
      try { state.root.disconnect(state._mappedId); } catch (_) { }
      state._mappedId = 0;
    }
    if (state._destroyId !== 0) {
      try { state.panel.disconnect(state._destroyId); } catch (_) { }
      state._destroyId = 0;
    }
    if (state._styleChangedId !== 0) {
      try { state.panel.disconnect(state._styleChangedId); } catch (_) { }
      state._styleChangedId = 0;
    }

    if (!targetGone) {
      try {
        state.panel.remove_style_class_name('liquid-glass-transparent');
        if (state._originalStyle !== undefined) {
          state._styleGuard = true;
          state.panel.set_style(state._originalStyle === '' ? null : state._originalStyle);
          state._styleGuard = false;
          state._originalStyle = undefined;
          state._appliedStyle = null;
        }
        state.panel.opacity = 255;
      } catch (_) { /* panel already destroyed */ }
    }

    // Teardown order (effect before actor) is handled by GlassLayer.
    state.layer?.destroy();
    state.layer = null;
    state.effect = null;
    state.bgActor = null;
    state.liquidBox = null;
    state._cloneContainer = null;
    state._uiSampler = null;
    state._windowCloneManager = null;
  }

  cleanup() {
    for (let sigId of this._settingsSignals) {
      try { this._settings.disconnect(sigId); } catch (_) { }
    }
    this._settingsSignals = [];
    this._removeEffect();
  }

  // ── Adaptive text colour ───────────────────────────────────────────────────

  /**
   * One region per panel box (left / centre / right).
   *
   * A single region spanning the whole bar would average the entire display
   * width into one number, which says nothing useful about what sits behind any
   * particular button — the clock can be over a white window while the status
   * icons are over a dark one.
   */
  _buildAdaptiveGroups(): AdaptiveGroup[] {
    const groups: AdaptiveGroup[] = [];
    for (const state of this._states) {
      const panel = state.panel as any;
      if (!panel?.mapped || panel.opacity === 0) continue;

      const boxes: St.Widget[] = [panel._leftBox, panel._centerBox, panel._rightBox]
        .filter(b => b && b.mapped && b.visible);
      const roots: St.Widget[] = boxes.length > 0 ? boxes : [state.panel];

      for (const box of roots) {
        const targets = findTextActors(box);
        if (targets.length > 0) groups.push({ key: box, targets });
      }
    }
    return groups;
  }

  _createAdaptiveText() {
    this._adaptiveText?.destroy();
    this._adaptiveText = new AdaptiveTextController({
      settings: this._settings,
      logger: this._logger,
      enabledKey: 'panel-enable-adaptive-text-color',
      intervalKey: 'panel-sample-interval-ms',
      collectGroups: () => this._buildAdaptiveGroups(),
      shouldSample: () => !this._inOverview && this._states.some(s => s.root.mapped),
    });
  }

}
