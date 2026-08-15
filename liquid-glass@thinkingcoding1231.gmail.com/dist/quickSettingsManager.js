// src/quickSettingsManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { GlassLayer, tightFbo } from './glassSurface.js';
import { AdaptiveTextController, groupByCard } from './adaptiveText.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area.
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Tiles and sliders Quick Settings paints over the glass.
const QS_CARD_CLASSES = ['quick-slider', 'quick-toggle', 'quick-menu-toggle', 'quick-settings-system-item'];
// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;
// ==============================================
export class QuickSettingsManager {
    extensionPath;
    _settings;
    _logger;
    targetActor;
    menu;
    animActor;
    bgActor;
    liquidBox = null;
    _cloneContainer = null;
    effect;
    _windowCloneManager = null;
    _uiSampler = null;
    layer = null;
    // Cached monitor dimensions for change detection
    _lastScreenW;
    _lastScreenH;
    // The render target: a box around the menu rather than the whole monitor.
    _lastFboX;
    _lastFboY;
    _lastFboW;
    _lastFboH;
    // Sized inputs to the render target; refreshed from their 'changed::'.
    _blurRadius = 0;
    _shadowRadius = 0;
    _isEffectActive;
    buttonAlpha;
    _buttonTimerId;
    _styledButtons;
    _buttonSignalIds;
    _signals;
    _animSignalId = 0;
    _frameSyncId;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    _adaptiveText = null;
    _hasAutoRefreshed;
    _settingsSignals;
    // Used in _syncGeometry
    _stableBaseW;
    _stableBaseH;
    _lastValidAnimAbsX;
    _lastValidAnimAbsY;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _cornerRadius = 0;
    // Flag to forcefully move submenus using translation_x, translation_y
    _enableSubmenuFix = false;
    _cachedSubmenus = null; // Cache of submenus
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        // Target the main container of the Quick Settings menu
        this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
        this.menu = Main.panel.statusArea.quickSettings.menu;
        // Target for animations and visual offsets (The inner content)
        this.animActor = Main.panel.statusArea.quickSettings.menu.box;
        this.bgActor = null;
        this.effect = null;
        this._signals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
        this._hasAutoRefreshed = false;
        this._glassExpand = 0;
        this._menuXoffset = 0;
        this._menuYoffset = 0;
        this._settingsSignals = [];
        this.buttonAlpha = 0.8;
        this._buttonTimerId = 0;
        this._styledButtons = new Map();
        this._buttonSignalIds = new Map();
        this._enableSubmenuFix = true;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-quick-settings-glass')) {
            this._applyEffect();
        }
    }
    // Utility: Convert HEX color string to normalized RGB array
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
            return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
    }
    _getMenuMonitorGeometry() {
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    }
    _applyMenuOffsets() {
        if (!this.targetActor)
            return;
        this.targetActor.translation_y = this._menuYoffset;
        this.targetActor.translation_x = this._menuXoffset;
    }
    // Dynamically apply settings changes
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFF toggle
        connectSetting('enable-quick-settings-glass', () => {
            let enabled = this._settings.get_boolean('enable-quick-settings-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('popup-tint-color', () => {
            if (this.effect) {
                let colorArray = this._hexToColorArray(this._settings.get_string('popup-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting('popup-tint-strength', () => {
            if (this.effect) {
                this.effect.setTintStrength(this._settings.get_double('popup-tint-strength'));
            }
        });
        connectSetting('shadow-radius', () => {
            // Not a popup-prefixed key, but the shadow's decay distance helps size
            // the render target, so it is tracked here too.
            this._shadowRadius = this._settings.get_double('shadow-radius');
        });
        connectSetting('popup-blur-radius', () => {
            this._blurRadius = this._settings.get_int('popup-blur-radius');
            if (this.effect) {
                this.effect.setBlurRadius(this._blurRadius);
            }
        });
        connectSetting('popup-corner-radius', () => {
            if (this.effect) {
                this._cornerRadius = this._settings.get_double('popup-corner-radius');
                this.effect.setCornerRadius(this._cornerRadius);
            }
        });
        connectSetting('popup-glass-expand', () => {
            if (this.effect) {
                this._glassExpand = this._settings.get_int('popup-glass-expand');
            }
        });
        connectSetting('quick-settings-y-offset', () => {
            if (this.targetActor) {
                this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
                this._applyMenuOffsets();
            }
        });
        connectSetting('quick-settings-x-offset', () => {
            if (this.targetActor) {
                this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
                this._applyMenuOffsets();
            }
        });
        connectSetting('popup-enable-adaptive-text-color', () => {
            this._adaptiveText?.syncSettings();
        });
        connectSetting('popup-sample-interval-ms', () => {
            this._adaptiveText?.syncSettings();
        });
        // Brightness / Saturation / Contrast — dynamic application from settings
        connectSetting('popup-brightness', () => {
            if (this.effect) {
                this.effect.setBrightness(this._settings.get_double('popup-brightness'));
            }
        });
        connectSetting('popup-saturation', () => {
            if (this.effect) {
                this.effect.setSaturation(this._settings.get_double('popup-saturation'));
            }
        });
        connectSetting('popup-contrast', () => {
            if (this.effect) {
                this.effect.setContrast(this._settings.get_double('popup-contrast'));
            }
        });
    }
    _applyClassStyles() {
        if (!this.targetActor)
            return;
        if (!this._hasStyleClass(this.targetActor, 'liquid-glass-transparent'))
            this.targetActor.add_style_class_name('liquid-glass-transparent');
        if (!this._hasStyleClass(this.animActor, 'liquid-glass-transparent'))
            this.animActor.add_style_class_name('liquid-glass-transparent');
        if (!this._hasStyleClass(this.animActor, 'liquid-glass-qs-root'))
            this.animActor.add_style_class_name('liquid-glass-qs-root');
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        // Adaptive text colouring — shared implementation, see src/adaptiveText.ts
        this._createAdaptiveText();
        if (!this.targetActor)
            return;
        // Shift the menu down to prevent it from clipping into the top bar
        this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
        this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
        this._glassExpand = this._settings.get_int('popup-glass-expand');
        // The menu scales from top-centre; our glass from top-left, since we sync
        // its exact coordinates each frame.
        this.animActor.set_pivot_point(0.5, 0.0);
        // ── Find the menuActor's ancestor that is a direct child of uiGroup ───────
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        this._cornerRadius = this._settings.get_double('popup-corner-radius');
        this._blurRadius = this._settings.get_int('popup-blur-radius');
        this._shadowRadius = this._settings.get_double('shadow-radius');
        // Actor tree, shader and clone samplers — all shared, see glassSurface.ts.
        this.layer = new GlassLayer({
            extensionPath: this.extensionPath,
            settings: this._settings,
            logger: this._logger,
            keyPrefix: 'popup',
            root: menuRoot,
        });
        this.bgActor = this.layer.bgActor;
        this.liquidBox = this.layer.liquidBox;
        this._cloneContainer = this.layer.cloneContainer;
        this.effect = this.layer.effect;
        this._windowCloneManager = this.layer.windowClones;
        this._uiSampler = this.layer.uiSampler;
        this.layer.hide();
        // ── Helper functions for GNOME's render pipeline ──────────────────────────
        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback);
        };
        const laterRemove = (id) => {
            if (!id)
                return;
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(id);
        };
        // Hook into the frame right before it is painted to the screen
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        // Clone build: applies mutual liquid-glass exclusions, then delegates to managers
        let buildClones = () => {
            if (!this.bgActor)
                return;
            if (this._uiSampler) {
                for (let child of Main.layoutManager.uiGroup.get_children()) {
                    if (child === this.bgActor)
                        continue;
                    let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
                        (typeof child.get_children === 'function' &&
                            child.get_children().some((c) => c.get_name?.() === 'liquid-box'));
                    if (isLiquidBg)
                        this._uiSampler.addExclusion(child);
                }
            }
            this._windowCloneManager?.rebuildClones();
            this._uiSampler?.rebindSelf();
            this._uiSampler?.refresh();
        };
        // Frame render loop (runs every frame while the menu is mapped)
        let frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.targetActor.mapped)
                return GLib.SOURCE_REMOVE;
            this._syncGeometry();
            this._frameSyncId = laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };
        // Starts the render loop and builds fresh clones when the menu is opened
        let startFrameSync = () => {
            if (this._frameSyncId === 0) {
                buildClones();
                this._frameSyncId = laterAdd(frameLaterType, frameTick);
            }
        };
        let stopFrameSync = () => {
            if (this._frameSyncId !== 0) {
                laterRemove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };
        if (this._hasAutoRefreshed === undefined)
            this._hasAutoRefreshed = false;
        this._signals = [];
        // Handle the first open as a plain GNOME quick settings open; apply custom behavior only afterwards.
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._cachedSubmenus = null; // Reset submenu cache
                if (!this._hasAutoRefreshed)
                    this._hasAutoRefreshed = true;
                this._applyClassStyles();
                this._applyMenuOffsets();
                this._stableBaseW = undefined;
                this._stableBaseH = undefined;
                startFrameSync();
                // Skip animations on the first open for instant feedback
                this._adaptiveText?.start();
                this._startButtonAlphaSampling();
                return;
            }
            this._applyClassStyles();
            this._applyMenuOffsets();
            this._adaptiveText?.stop();
            this._stopButtonAlphaSampling();
        });
        // Monitor the signal when the menu's mapped state changes
        // Stop the render loop when the menu unmaps (fully hidden)
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                // When the menu is completely hidden from the screen
                if (!this.menu.actor.mapped) {
                    // Stop the render/sync loop here for the first time
                    stopFrameSync();
                    // Only our own actor is reset here. The menu's opacity belongs to
                    // GNOME's open/close transition now — zeroing it used to be undone by
                    // the custom spring on the next open, so with that gone it would stay
                    // at 0 and the panel would open empty.
                    if (this.bgActor) {
                        this.bgActor.hide();
                        this.bgActor.opacity = 0;
                    }
                }
            })
        });
        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // ── Geometry synchronisation ────────────────────────────────────────────────
    // Calculates and synchronizes the position/size of the glass background every frame
    // Full-screen FBO approach: bgActor covers the entire monitor, shader is told
    // where the menu lives within that FBO via setGlassGeometry().
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
            if (this.bgActor && this.bgActor.visible)
                this.bgActor.hide();
            return;
        }
        if (!this.bgActor.visible)
            this.bgActor.show();
        // GNOME animates the wrapper directly under the BoxPointer; the glass
        // mirrors its opacity.
        if (this.targetActor !== null)
            this.bgActor.opacity = this.targetActor.get_first_child()?.opacity ?? 255;
        let [inW, inH] = this.animActor.get_size();
        let [outW, outH] = this.targetActor.get_size();
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        let [scaleX, scaleY] = this.animActor.get_scale();
        // Same wrapper carries GNOME's open/close scale.
        {
            let gnomeAnimContainer = this.targetActor.get_first_child();
            if (gnomeAnimContainer) {
                scaleX *= gnomeAnimContainer.scale_x;
                scaleY *= gnomeAnimContainer.scale_y;
            }
        }
        let themeNode = this.animActor.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        let marginW = mL + mR;
        let marginH = mT + mB;
        let targetW = Math.round(inW);
        let targetH = Math.round(inH);
        // GNOME Shell Hover Bug Compensation
        // Detects when the menu tries to unexpectedly shrink by a few pixels
        if (Math.abs(inW - outW) <= 2 && marginW > 0) {
            targetW = Math.round(inW - marginW);
            targetH = Math.round(inH - marginH);
        }
        this._stableBaseW = targetW;
        this._stableBaseH = targetH;
        // Multiply by the current animation scale. 
        // Math.max guarantees the size never drops below 1px (prevents Cogl crashes).
        let w = Math.max(1, this._stableBaseW * scaleX);
        let h = Math.max(1, this._stableBaseH * scaleY);
        // Get correct coordinates directly from animActor, which is the actual UI content area
        let [animAbsX, animAbsY] = this.animActor.get_transformed_position();
        // --------------------------------------------------------
        // Advanced Fallback Logic for NaN Coordinates
        // GNOME sometimes fails to report actor positions during the very first frame
        // of an animation. This logic predicts where the menu should be.
        // --------------------------------------------------------
        if (Number.isNaN(animAbsX) || Number.isNaN(animAbsY)) {
            if (this._lastValidAnimAbsX !== undefined && this._lastValidAnimAbsY !== undefined) {
                // Use the last known good coordinates if available
                animAbsX = this._lastValidAnimAbsX;
                animAbsY = this._lastValidAnimAbsY;
            }
            else {
                // Ultimate fallback: Just place it in the top-center of the primary monitor
                let monitor = Main.layoutManager.primaryMonitor;
                if (monitor) {
                    animAbsX = (monitor.width / 2) - (w / 2);
                    animAbsY = (Main.panel.height || 27) + (this._menuYoffset ?? 0);
                }
                else {
                    animAbsX = 0;
                    animAbsY = 0;
                }
            }
        }
        else {
            // Save successful coordinates for future fallbacks
            this._lastValidAnimAbsX = animAbsX;
            this._lastValidAnimAbsY = animAbsY;
        }
        // The background needs to be larger than the UI to account for the glass expansion
        // and the extra padding required by the shader for edge refraction.
        let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        // Cover the background by purely subtracting the padding from the exact UI coordinates
        let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
        let bgY = animAbsY - this._glassExpand - SHADER_PADDING;
        if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
            // ── Monitor geometry ───────────────────────────────────────────────────
            let monitor = this._getMenuMonitorGeometry();
            let monitorX = monitor?.x ?? 0;
            let monitorY = monitor?.y ?? 0;
            let screenW = Math.max(1, monitor?.width ?? 1);
            let screenH = Math.max(1, monitor?.height ?? 1);
            // Monitor-local coordinates (shader uses these)
            let localBgX = bgX - monitorX;
            let localBgY = bgY - monitorY;
            // The render target is a box around the menu plus the reach of the blur
            // and shadow, rather than the whole monitor. Both the blur chain and the
            // composite pass cover the entire target, so this is most of the
            // per-frame GPU cost for a menu that occupies a fraction of the screen.
            const fbo = tightFbo({ x: bgX, y: bgY, width: bgW, height: bgH }, { x: monitorX, y: monitorY, width: screenW, height: screenH }, this._blurRadius, this._shadowRadius);
            // ── Update actors only when geometry changed ───────────────────────────
            // Only update positions/sizes if they actually changed to save CPU cycles
            if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
                this._lastBgX !== bgX || this._lastBgY !== bgY ||
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
                // Resolution follows the target; the optical constants stay pinned to
                // the monitor size, so narrowing the target does not change the look.
                this.effect?.setResolution(fbo.width, fbo.height);
                this.effect?.setReferenceResolution(screenW, screenH);
                this.effect?.setGlassGeometry(bgX - fbo.x, bgY - fbo.y, bgW, bgH);
                this._lastBgW = bgW;
                this._lastBgH = bgH;
                this._lastBgX = bgX;
                this._lastBgY = bgY;
                this._lastScreenW = screenW;
                this._lastScreenH = screenH;
                this._lastFboX = fbo.x;
                this._lastFboY = fbo.y;
                this._lastFboW = fbo.width;
                this._lastFboH = fbo.height;
            }
            // ── Sync clones every frame (dockManager pattern) ──────────────────────
            // Clones are positioned relative to the render target's origin.
            this._windowCloneManager?.setOffset(-fbo.x, -fbo.y);
            // Only rescans when uiGroup's children or their visibility actually
            // changed; see UILayerSampler.refreshIfDirty().
            this._uiSampler?.refreshIfDirty();
            this._uiSampler?.sync(fbo.x, fbo.y, fbo.width, fbo.height);
            this._windowCloneManager?.sync();
        }
        // Scale-aware corner radius
        // Use the smaller of the X/Y scales to prevent corners from squishing incorrectly
        if (this.effect && typeof this.effect.setCornerRadius === 'function') {
            let currentScale = Math.min(scaleX, scaleY);
            this.effect.setCornerRadius(this._cornerRadius * currentScale);
            if (typeof this.effect.setAnimationScale === 'function') {
                this.effect.setAnimationScale(currentScale);
            }
        }
        this._adjustSubmenuPositions();
    }
    // Updates the shader resolution based on the current background actor size
    _updateResolution() {
        if (!this.bgActor || !this.effect)
            return;
        let [width, height] = this.bgActor.get_size();
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            this.effect.setResolution(width, height);
        }
    }
    // Utility function to safely check if an actor has a specific style class
    _hasStyleClass(actor, className) {
        return actor instanceof St.Widget && actor.has_style_class_name(className);
    }
    // ── Button alpha sampling (QuickSettings-specific) ─────────────────────────
    _findAllButtons(actor, foundButtons = []) {
        if (!actor)
            return foundButtons;
        let isQuickSlider = false;
        let isToggleContainer = false;
        let isButton = actor instanceof St.Button;
        if (actor instanceof St.Widget) {
            isQuickSlider = actor.has_style_class_name('quick-slider');
            isToggleContainer = actor.has_style_class_name('quick-toggle');
        }
        if (actor.visible && !isQuickSlider) {
            if (isButton || isToggleContainer)
                foundButtons.push(actor);
        }
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let i = 0; i < children.length; i++) {
            this._findAllButtons(children[i], foundButtons);
        }
        return foundButtons;
    }
    _updateSingleButtonAlpha(button, targetAlpha) {
        if (!button || button._isUpdatingAlpha)
            return;
        button._isUpdatingAlpha = true;
        let origStyle = this._styledButtons.get(button) || '';
        button.set_style(origStyle || null);
        button.ensure_style();
        let themeNode = button.get_theme_node();
        if (themeNode) {
            let bgColor = themeNode.get_background_color();
            if (bgColor) {
                let isToggleContainer = button instanceof St.Widget && button.has_style_class_name('quick-toggle');
                // FIX 1: If this is a parent toggle container, hide its background if any child is active/colored.
                // This prevents the dark pod background from muddying the semi-transparent orange child button.
                if (isToggleContainer) {
                    let hasColoredChild = false;
                    let children = typeof button.get_children === 'function' ? button.get_children() : [];
                    for (let i = 0; i < children.length; i++) {
                        let child = children[i];
                        if (child instanceof St.Widget) {
                            let childTheme = child.get_theme_node();
                            if (childTheme) {
                                let childBg = childTheme.get_background_color();
                                if (childBg && childBg.alpha > 0) {
                                    hasColoredChild = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (hasColoredChild) {
                        let newStyle = origStyle
                            ? `${origStyle} background-color: transparent !important;`
                            : `background-color: transparent !important;`;
                        button.set_style(newStyle);
                        button._isUpdatingAlpha = false;
                        return;
                    }
                }
                // FIX 2: If the button is completely transparent by default (like power/lock buttons), keep it transparent.
                if (bgColor.alpha === 0) {
                    // Keep transparent buttons transparent
                }
                else {
                    // Apply target alpha for normally visible buttons
                    let rgbaStr = `rgba(${bgColor.red}, ${bgColor.green}, ${bgColor.blue}, ${targetAlpha})`;
                    let newStyle = origStyle ? `${origStyle} background-color: ${rgbaStr};` : `background-color: ${rgbaStr};`;
                    button.set_style(newStyle);
                    // Ensure the parent toggle container is also updated dynamically.
                    // If a child button changes state, we must force the parent to re-evaluate its transparency.
                    let parent = typeof button.get_parent === 'function' ? button.get_parent() : null;
                    if (parent && parent instanceof St.Widget && parent.has_style_class_name('quick-toggle')) {
                        this._updateSingleButtonAlpha(parent, targetAlpha);
                    }
                }
            }
        }
        button._isUpdatingAlpha = false;
    }
    _updateButtonAlpha() {
        if (!this.menu?.isOpen)
            return;
        const buttons = this._findAllButtons(this.menu?.actor);
        if (buttons.length === 0)
            return;
        let targetAlpha = this.buttonAlpha !== undefined ? this.buttonAlpha : 0.5;
        for (let button of buttons) {
            if (!this._styledButtons.has(button)) {
                if (button instanceof St.Widget) {
                    let origStyle = typeof button.get_style === 'function' ? button.get_style() : null;
                    this._styledButtons.set(button, origStyle || '');
                }
                const updateHandler = () => {
                    if (!this.menu?.isOpen)
                        return;
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._updateSingleButtonAlpha(button, targetAlpha);
                        return GLib.SOURCE_REMOVE;
                    });
                };
                let signalIds = [];
                signalIds.push(button.connect('notify::hover', updateHandler));
                signalIds.push(button.connect('notify::active', updateHandler));
                signalIds.push(button.connect('notify::checked', updateHandler));
                signalIds.push(button.connect('notify::reactive', updateHandler));
                signalIds.push(button.connect('notify::mapped', updateHandler));
                signalIds.push(button.connect('key-focus-in', updateHandler));
                signalIds.push(button.connect('key-focus-out', updateHandler));
                this._buttonSignalIds.set(button, signalIds);
            }
            // Apply style safely
            this._updateSingleButtonAlpha(button, targetAlpha);
        }
    }
    // Start sampling timer
    _startButtonAlphaSampling() {
        this._updateButtonAlpha();
        if (this._buttonTimerId !== 0)
            return;
        this._buttonTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            if (!this.menu?.isOpen) {
                this._buttonTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._updateButtonAlpha();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopButtonAlphaSampling() {
        if (this._buttonTimerId !== 0) {
            GLib.source_remove(this._buttonTimerId);
            this._buttonTimerId = 0;
        }
    }
    // Revert processing when extension is disabled, etc.
    _clearButtonStyles() {
        this._stopButtonAlphaSampling();
        if (this._buttonSignalIds) {
            for (const [button, signalIds] of this._buttonSignalIds.entries()) {
                if (button) {
                    for (const id of signalIds) {
                        try {
                            button.disconnect(id);
                        }
                        catch (e) { }
                    }
                }
            }
            this._buttonSignalIds.clear();
        }
        for (const [button, originalStyle] of this._styledButtons.entries()) {
            if (button && button instanceof St.Widget && typeof button.set_style === 'function') {
                button.set_style(originalStyle || null);
            }
        }
        this._styledButtons.clear();
    }
    // ── Submenu position fix (QuickSettings-specific) ──────────────────────────
    // Fix: Force submenu position to the center of the parent menu
    _adjustSubmenuPositions() {
        if (!this._enableSubmenuFix || !this.menu?.isOpen || !this.animActor)
            return;
        // Scan when there's no cached submenus yet
        if (!this._cachedSubmenus) {
            this._cachedSubmenus = [];
            let deepScan = (actor) => {
                if (!actor)
                    return;
                if (actor instanceof St.Widget) {
                    let css = actor.get_style_class_name ? actor.get_style_class_name() : '';
                    if (css && css.split(' ').includes('quick-toggle-menu'))
                        this._cachedSubmenus.push(actor);
                }
                let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let child of children)
                    deepScan(child);
            };
            deepScan(this.menu.actor);
        }
        let foundMenus = this._cachedSubmenus;
        if (foundMenus.length === 0)
            return;
        // Get the absolute coordinates and size as the parent's base (animActor = the visual bounding box of the menu)
        let [parentAbsX, parentAbsY] = this.animActor.get_transformed_position();
        let [parentW, parentH] = this.animActor.get_size();
        if (Number.isNaN(parentAbsX) || Number.isNaN(parentAbsY) ||
            Number.isNaN(parentW) || Number.isNaN(parentH) ||
            parentW <= 0 || parentH <= 0)
            return;
        for (let submenu of foundMenus) {
            if (!submenu.mapped || !submenu.visible)
                continue;
            let [subAbsX, subAbsY] = submenu.get_transformed_position();
            let [subW, subH] = submenu.get_size();
            if (Number.isNaN(subAbsX) || Number.isNaN(subAbsY) ||
                Number.isNaN(subW) || Number.isNaN(subH) ||
                subW <= 0 || subH <= 0)
                continue;
            // X: centre-align submenu within parent
            let currentTranslationX = submenu.translation_x || 0;
            let baseRelativeX = subAbsX - parentAbsX - currentTranslationX;
            let targetRelativeX = (parentW - subW) / 2;
            let newTranslationX = targetRelativeX - baseRelativeX;
            if (Math.abs(currentTranslationX - newTranslationX) > 0.5) {
                submenu.translation_x = newTranslationX;
            }
            // Y: centre-align submenu in the available gap between neighbours
            let currentTranslationY = submenu.translation_y || 0;
            let baseAbsY = subAbsY - currentTranslationY;
            let subCenterY = baseAbsY + (subH / 2);
            let aboveMaxY = parentAbsY;
            let belowMinY = parentAbsY + parentH;
            let findBoundaries = (n) => {
                if (!n || !n.visible || !n.mapped || n === submenu)
                    return;
                if (typeof n.contains === 'function' && n.contains(submenu)) {
                    let children = typeof n.get_children === 'function' ? n.get_children() : [];
                    for (let child of children)
                        findBoundaries(child);
                    return;
                }
                let [, nodeY] = n.get_transformed_position();
                let [nodeW, nodeH] = n.get_size();
                if (Number.isNaN(nodeY) || Number.isNaN(nodeW) || Number.isNaN(nodeH) ||
                    nodeH <= 5 || nodeW <= 5)
                    return;
                // Separate and evaluate elements above and below based on the submenu's "center point"
                if (nodeY + (nodeH / 2) < subCenterY) {
                    // Elements above: Their bottom edge doesn't cross the submenu center, and are the lowest among them
                    if (nodeY + nodeH <= subCenterY && nodeY + nodeH > aboveMaxY)
                        aboveMaxY = nodeY + nodeH;
                }
                else {
                    // Elements below: Their top edge doesn't cross the submenu center, and are the highest among them
                    if (nodeY >= subCenterY && nodeY < belowMinY)
                        belowMinY = nodeY;
                }
                let children = typeof n.get_children === 'function' ? n.get_children() : [];
                for (let child of children)
                    findBoundaries(child);
            };
            // Execute boundary scan starting from the direct children of the box (parent container)
            let parentChildren = typeof this.animActor.get_children === 'function' ? this.animActor.get_children() : [];
            for (let child of parentChildren)
                findBoundaries(child);
            // Calculate the target value to place the submenu in the center of the identified vertical gap
            let targetTranslationY = (aboveMaxY + (belowMinY - aboveMaxY) / 2) - (subH / 2) - baseAbsY;
            // Chattering prevention (update only if there's a difference of 0.5px or more from the current movement)
            if (Math.abs(currentTranslationY - targetTranslationY) > 0.5) {
                submenu.translation_y = targetTranslationY;
            }
        }
    }
    _clearSubmenuFix() {
        // Scan when there's no cached submenus yet
        let foundMenus = this._cachedSubmenus || [];
        if (foundMenus.length === 0) {
            let deepScan = (actor) => {
                if (!actor)
                    return;
                if (actor instanceof St.Widget) {
                    let css = actor.get_style_class_name ? actor.get_style_class_name() : '';
                    if (css && css.split(' ').includes('quick-toggle-menu'))
                        foundMenus.push(actor);
                }
                let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let child of children)
                    deepScan(child);
            };
            if (this.menu?.actor)
                deepScan(this.menu.actor);
        }
        for (let submenu of foundMenus) {
            try {
                submenu.translation_x = 0;
            }
            catch (e) { }
        }
        this._cachedSubmenus = null; // Clear cache
    }
    // ── Effect remove / cleanup ─────────────────────────────────────────────────
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._adaptiveText?.stop();
        this._adaptiveText?.clear();
        this._clearButtonStyles();
        this._clearSubmenuFix();
        // Disconnect all event listeners
        for (let sig of this._signals) {
            try {
                if (sig && sig.id)
                    sig.target.disconnect(sig.id);
            }
            catch (e) { }
        }
        this._signals = [];
        if (this._animSignalId) {
            try {
                this.menu.disconnect(this._animSignalId);
            }
            catch (e) { }
            this._animSignalId = 0;
        }
        // Stop the render frame loop
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        // Remove transparent CSS overrides
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-qs-root');
            this.animActor.translation_x = 0;
            this.animActor.translation_y = 0;
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
        }
        this.targetActor.translation_y = 0;
        this.targetActor.translation_x = 0;
        this.targetActor.set_scale(1.0, 1.0);
        this.targetActor.opacity = 255;
        if (this.menu.actor) {
            this.menu.actor.opacity = 255;
            this.menu.actor.translation_x = 0;
            this.menu.actor.translation_y = 0;
            if (this.menu.isOpen)
                this.menu.close(false);
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
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
        this._lastScreenW = undefined;
        this._lastScreenH = undefined;
    }
    cleanup() {
        for (let sigId of this._settingsSignals) {
            try {
                this._settings.disconnect(sigId);
            }
            catch (e) { }
        }
        this._settingsSignals = [];
        if (!this.targetActor)
            return;
        this._removeEffect();
    }
    /**
     * Quick Settings draws its own tinted tiles and sliders, so text on those is
     * measured against the tile rather than the glass behind the popup.
     */
    _buildAdaptiveGroups() {
        const root = this.menu?.actor;
        if (!root || !root.mapped)
            return [];
        return groupByCard(root, QS_CARD_CLASSES, root);
    }
    _createAdaptiveText() {
        this._adaptiveText?.destroy();
        this._adaptiveText = new AdaptiveTextController({
            settings: this._settings,
            logger: this._logger,
            enabledKey: 'popup-enable-adaptive-text-color',
            intervalKey: 'popup-sample-interval-ms',
            collectGroups: () => this._buildAdaptiveGroups(),
            shouldSample: () => !!this.menu?.isOpen,
        });
    }
}
