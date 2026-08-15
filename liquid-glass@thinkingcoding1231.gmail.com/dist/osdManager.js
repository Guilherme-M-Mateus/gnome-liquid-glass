// src/osdManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { GlassLayer } from './glassSurface.js';
import { AdaptiveTextController, findTextActors } from './adaptiveText.js';
// ========== Configuration Parameters (Defaults, overridden by settings) ==========
export class OsdManager {
    extensionPath;
    _settings;
    _logger;
    _settingsSignals;
    _frameSyncId;
    _isEffectActive;
    _osdYOffset;
    _osdStates;
    _baseTint;
    _glassExpand;
    _monitorsChangedId;
    _adaptiveText = null;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._osdStates = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._monitorsChangedId = 0;
        this._isEffectActive = false;
        this._glassExpand = 12;
        this._baseTint = 0.08;
        this._osdYOffset = 0;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-osd-glass')) {
            this._applyEffect();
        }
    }
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
            return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        connectSetting('enable-osd-glass', () => {
            let enabled = this._settings.get_boolean('enable-osd-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('popup-tint-color', () => {
            if (this._isEffectActive) {
                let colorArray = this._hexToColorArray(this._settings.get_string('popup-tint-color'));
                for (let state of this._osdStates) {
                    state.layer?.effect.setTintColor(...colorArray);
                }
            }
        });
        connectSetting('popup-tint-strength', () => {
            if (this._isEffectActive) {
                this._baseTint = this._settings.get_double('popup-tint-strength');
                for (let state of this._osdStates) {
                    state._currentTint = this._baseTint;
                    state.layer?.effect.setTintStrength(this._baseTint);
                }
            }
        });
        connectSetting('popup-blur-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_int('popup-blur-radius');
                for (let state of this._osdStates) {
                    state.layer?.effect.setBlurRadius(radius);
                }
            }
        });
        connectSetting('popup-corner-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_double('popup-corner-radius');
                for (let state of this._osdStates) {
                    state.layer?.effect.setCornerRadius(radius);
                }
            }
        });
        connectSetting('popup-glass-expand', () => {
            if (this._isEffectActive) {
                this._glassExpand = this._settings.get_int('popup-glass-expand');
            }
        });
        // ----------  Brightness / Saturation / Contrast  ----------
        connectSetting('popup-brightness', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('popup-brightness');
                for (let state of this._osdStates) {
                    state.layer?.effect.setBrightness(v);
                }
            }
        });
        connectSetting('popup-saturation', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('popup-saturation');
                for (let state of this._osdStates) {
                    state.layer?.effect.setSaturation(v);
                }
            }
        });
        connectSetting('popup-contrast', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('popup-contrast');
                for (let state of this._osdStates) {
                    state.layer?.effect.setContrast(v);
                }
            }
        });
        connectSetting('popup-enable-adaptive-text-color', () => {
            this._adaptiveText?.syncSettings();
            if (this._adaptiveText?.enabled) {
                this._adaptiveText.start();
            }
            else {
                this._adaptiveText?.stop();
                this._adaptiveText?.clear();
            }
        });
        connectSetting('popup-sample-interval-ms', () => {
            this._adaptiveText?.syncSettings();
        });
        connectSetting('osd-y-offset', () => {
            this._osdYOffset = this._settings.get_int('osd-y-offset');
            for (let state of this._osdStates) {
                if (state.targetBox) {
                    state.targetBox.translation_y = -this._osdYOffset;
                }
            }
        });
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        // Adaptive text colouring — shared implementation, see src/adaptiveText.ts
        this._createAdaptiveText();
        this._adaptiveText?.syncSettings();
        this._glassExpand = this._settings.get_int('popup-glass-expand');
        this._baseTint = this._settings.get_double('popup-tint-strength');
        this._osdYOffset = this._settings.get_int('osd-y-offset');
        let osdWindows = Main.osdWindowManager._osdWindows;
        if (!osdWindows)
            return;
        // Set up each monitor's OSD independently
        for (let osdWindow of osdWindows) {
            this._setupOsdEffect(osdWindow);
        }
        // After all states exist, apply mutual exclusions so each UILayerSampler
        // does not clone the other monitors' liquid-glass bgActors
        for (let state of this._osdStates) {
            if (!state.layer)
                continue;
            state.layer.excludeOtherGlassRoots();
        }
        // Global frame-render loop (covers all OSD states)
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        const frameTick = () => {
            this._frameSyncId = 0;
            if (!this._isEffectActive)
                return GLib.SOURCE_REMOVE;
            for (let state of this._osdStates) {
                this._syncGeometry(state);
            }
            this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };
        this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
        this._adaptiveText?.start();
        // Rebuild everything if monitor configuration changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._removeEffect();
            if (this._settings.get_boolean('enable-osd-glass')) {
                this._applyEffect();
            }
        });
    }
    _setupOsdEffect(osdWindow) {
        // ── Find the OSD's targetBox (the St.Widget with style methods) ───────────
        let targetBox = null;
        if (osdWindow._icon && osdWindow._icon.get_parent) {
            targetBox = osdWindow._icon.get_parent();
        }
        else if (typeof osdWindow.get_first_child === 'function') {
            targetBox = osdWindow.get_first_child();
        }
        if (targetBox && typeof targetBox.add_style_class_name !== 'function') {
            let children = osdWindow.get_children();
            for (let child of children) {
                if (typeof child.add_style_class_name === 'function') {
                    targetBox = child;
                    break;
                }
            }
        }
        if (!targetBox || typeof targetBox.add_style_class_name !== 'function') {
            this._logger.warn('[Liquid Glass] OSD UI container not found.');
            return;
        }
        targetBox.add_style_class_name('liquid-glass-transparent');
        targetBox.translation_y = -this._osdYOffset;
        // ── Determine which monitor this OSD belongs to ───────────────────────────
        let monitorIndex = Main.layoutManager.findIndexForActor(osdWindow);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        // ── Find the OSD's ancestor that is a direct child of uiGroup ────────────
        let osdRoot = osdWindow;
        while (osdRoot.get_parent() && osdRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = osdRoot.get_parent();
            if (!p)
                break;
            osdRoot = p;
        }
        // Actor tree, shader and clone samplers — all shared, see glassSurface.ts.
        const layer = new GlassLayer({
            extensionPath: this.extensionPath,
            settings: this._settings,
            logger: this._logger,
            keyPrefix: 'popup',
            root: osdRoot,
        });
        // The OSD's own tint is animated separately from the configured value.
        layer.effect.setTintStrength(this._baseTint);
        layer.hide();
        layer.rebuildClones();
        // ── 6. Compose the state object ───────────────────────────────────────────
        let state = {
            osdWindow,
            targetBox,
            layer,
            _stableBaseH: undefined,
            _currentTint: this._baseTint,
            _wasVisible: false,
            _isFirstAdaptiveRun: true,
            _destroyId: 0,
        };
        this._osdStates.push(state);
        // When the OSD window itself is destroyed, clean up our matching state
        state._destroyId = osdWindow.connect('destroy', () => {
            this._osdStates = this._osdStates.filter(s => s !== state);
            state.layer?.destroy();
            state.layer = null;
        });
    }
    // ── Per-state geometry synchronisation ─────────────────────────────────────
    // Full-screen FBO approach: bgActor covers the full monitor, shader is told
    // where the OSD lives within that FBO via setGlassGeometry().
    _syncGeometry(state) {
        if (!state.layer || !state.targetBox)
            return;
        let [w, h] = state.targetBox.get_size();
        let [absX, absY] = state.targetBox.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        // Respect GNOME's OSD fade animation.
        //
        // Check visible, mapped, opacity states of the OSD window and targetBox.
        let osdWindowVisible = state.osdWindow.visible && state.osdWindow.mapped;
        let targetBoxVisible = state.targetBox.visible && state.targetBox.mapped;
        let currentOpacity = (osdWindowVisible && targetBoxVisible)
            ? Math.min(state.osdWindow.opacity, state.targetBox.opacity)
            : 0;
        let isVisible = currentOpacity > 0;
        if (isVisible && !state._wasVisible) {
            state._wasVisible = true;
            this._adaptiveText?.update();
        }
        else if (!isVisible && state._wasVisible) {
            state._wasVisible = false;
        }
        state.layer.bgActor.opacity = currentOpacity;
        if (!isVisible) {
            state.layer.hide();
            return;
        }
        state.layer.show();
        // OSD-specific margin-bottom bloat compensation (icon switch glitch)
        let themeNode = state.targetBox.get_theme_node();
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        if (state._stableBaseH === undefined) {
            let initH = h;
            try {
                let [_, naturalH] = state.targetBox.get_preferred_height(-1);
                if (naturalH > 0) {
                    initH = naturalH;
                }
            }
            catch (e) {
                this._logger.warn(`[Liquid Glass] Failed to get preferred height for OSD initialization: ${e}`);
            }
            state._stableBaseH = initH;
        }
        let isHeightBloated = Math.abs(h - (state._stableBaseH + mB)) <= 1;
        let visualW = w;
        let visualH = isHeightBloated ? h - mB : h;
        if (!isHeightBloated)
            state._stableBaseH = h;
        let visualX = absX;
        let visualY = absY;
        // ── Monitor geometry ─────────────────────────────────────────────────────
        let monitorIndex = Main.layoutManager.findIndexForActor(state.osdWindow);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        state.layer.sync({
            x: visualX, y: visualY, width: visualW, height: visualH,
            monitor,
            expand: this._glassExpand,
        });
    }
    // ── Effect remove / cleanup ─────────────────────────────────────────────────
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._adaptiveText?.stop();
        this._adaptiveText?.clear();
        if (this._monitorsChangedId !== 0) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        for (let state of this._osdStates) {
            this._cleanupOsdState(state);
        }
        this._osdStates = [];
    }
    _cleanupOsdState(state) {
        // Disconnect destroy watcher
        if (state.osdWindow && state._destroyId) {
            try {
                state.osdWindow.disconnect(state._destroyId);
            }
            catch (e) { }
            state._destroyId = 0;
        }
        // Restore target box
        if (state.targetBox) {
            try {
                state.targetBox.remove_style_class_name('liquid-glass-transparent');
                state.targetBox.translation_y = 0;
            }
            catch (e) { }
        }
        state.layer?.destroy();
        state.layer = null;
    }
    cleanup() {
        for (let sigId of this._settingsSignals) {
            this._settings.disconnect(sigId);
        }
        this._settingsSignals = [];
        this._removeEffect();
    }
    // ── Adaptive text colour helpers ────────────────────────────────────────────
    _laterAdd(laterType, callback) {
        return global.compositor?.get_laters?.().add(laterType, callback);
    }
    /** One region per visible OSD; each is a single small box, so no cards. */
    _buildAdaptiveGroups() {
        const groups = [];
        for (const state of this._osdStates) {
            if (!state.osdWindow?.visible || state.osdWindow.opacity === 0)
                continue;
            const targets = findTextActors(state.targetBox);
            if (targets.length > 0)
                groups.push({ key: state.targetBox, targets });
        }
        return groups;
    }
    _createAdaptiveText() {
        this._adaptiveText?.destroy();
        this._adaptiveText = new AdaptiveTextController({
            settings: this._settings,
            logger: this._logger,
            enabledKey: 'popup-enable-adaptive-text-color',
            intervalKey: 'popup-sample-interval-ms',
            collectGroups: () => this._buildAdaptiveGroups(),
            shouldSample: () => this._osdStates.some(s => s.osdWindow?.visible),
        });
    }
}
