// src/uiManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { GlassLayer } from './glassSurface.js';
import { AdaptiveTextController, groupByCard } from './adaptiveText.js';
import { UnpickableWidget } from './utils.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area.
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Opaque cards this extension draws inside the menu (see stylesheet.css). Text
// on these must be measured against the card itself, not against the wallpaper
// behind the popup.
const MENU_CARD_CLASSES = ['events-button', 'world-clocks-button', 'message', 'calendar'];
function rgbToHex(r, g, b) {
    return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}
// ==============================================
export class UIManager {
    extensionPath;
    _settings;
    _logger;
    targetActor;
    menu;
    animActor;
    bgActor;
    effect;
    _cloneContainer = null;
    _windowCloneManager = null;
    _signals;
    _animSignalId = 0;
    _frameSyncId;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    _adaptiveText = null;
    _settingsSignals;
    _isEffectActive;
    liquidBox = null;
    layer = null;
    _stableBaseW;
    _stableBaseH;
    _lastValidAnimAbsX;
    _lastValidAnimAbsY;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _interfaceSettings = null;
    _accentColorSignalId = 0;
    _dynamicCssFile = null;
    _cornerRadius = 0;
    _uiSampler = null;
    _lastScreenW;
    _lastScreenH;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        // Target the main container of the Date/Calendar menu
        this.targetActor = Main.panel.statusArea.dateMenu.menu.actor;
        this.menu = Main.panel.statusArea.dateMenu.menu;
        // Target for animations and visual offsets (The inner content)
        // @ts-expect-error
        this.animActor = Main.panel.statusArea.dateMenu.menu.box;
        this.bgActor = null;
        this.effect = null;
        this._signals = [];
        this._frameSyncId = 0;
        this._glassExpand = 0;
        this._menuXoffset = 0;
        this._menuYoffset = 0;
        // Adaptive text controller is created in _applyEffect, once the menu
        // actors it samples actually exist.
        this._settingsSignals = [];
        this._isEffectActive = false;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
            // console.log(`[Liquid Glass] System accent color changed.`);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._applySystemAccentColor();
                return GLib.SOURCE_REMOVE;
            });
        });
        // 初回実行
        this._applySystemAccentColor();
        if (this._settings.get_boolean('enable-menu-glass')) {
            this._applyEffect();
        }
    }
    _applySystemAccentColor() {
        if (!this.targetActor)
            return;
        // 1. 親要素と子要素を作成して、GNOMEテーマが要求する正しい階層を再現
        const parent = new UnpickableWidget({ style_class: 'calendar' });
        const child = new UnpickableWidget({ style_class: 'calendar-day calendar-today' });
        parent.add_child(child);
        // 2. UIグループに追加してスタイルを強制計算させる
        Main.layoutManager.uiGroup.add_child(parent);
        child.ensure_style();
        // 3. 計算済みの色を取得
        const themeNode = child.get_theme_node();
        const bgColor = themeNode.get_background_color();
        // 4. 用が済んだらすぐお掃除
        Main.layoutManager.uiGroup.remove_child(parent);
        parent.destroy();
        // 5. HEXに変換
        const colorStr = rgbToHex(bgColor.red, bgColor.green, bgColor.blue);
        // console.log(`[Liquid Glass] Set system accent color to ${colorStr}`);
        const cssContent = `
      .liquid-glass-menu-root .calendar-today,
      .liquid-glass-menu-root .calendar-today:hover,
      .liquid-glass-menu-root .calendar-today:active,
      .liquid-glass-menu-root .calendar-today:checked,
      .liquid-glass-menu-root .calendar-today:focus {
        background-color: ${colorStr} !important;
        color: white !important;
      }
    `;
        try {
            const cacheDir = GLib.get_user_cache_dir();
            const filePath = GLib.build_filenamev([cacheDir, 'liquid-glass-accent.css']);
            GLib.file_set_contents(filePath, cssContent);
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            if (this._dynamicCssFile) {
                theme.unload_stylesheet(this._dynamicCssFile);
            }
            this._dynamicCssFile = Gio.File.new_for_path(filePath);
            theme.load_stylesheet(this._dynamicCssFile);
            this._logger.log(`[Liquid Glass] [UIManager] System accent color applied: ${colorStr}`);
        }
        catch (e) {
            this._logger.error(`[Liquid Glass] [UIManager] Failed to apply system accent color: ${e}`);
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
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    }
    // 設定の動的反映
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFF切り替え
        connectSetting('enable-menu-glass', () => {
            let enabled = this._settings.get_boolean('enable-menu-glass');
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
        connectSetting('popup-blur-radius', () => {
            if (this.effect) {
                this.effect.setBlurRadius(this._settings.get_int('popup-blur-radius'));
            }
        });
        connectSetting('popup-brightness', () => {
            if (this.effect) {
                this.effect.setBrightness(this._settings.get_double('popup-brightness'));
            }
        });
        connectSetting('popup-contrast', () => {
            if (this.effect) {
                this.effect.setContrast(this._settings.get_double('popup-contrast'));
            }
        });
        connectSetting('popup-saturation', () => {
            if (this.effect) {
                this.effect.setSaturation(this._settings.get_double('popup-saturation'));
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
        connectSetting('menu-x-offset', () => {
            if (this.animActor) {
                this._menuXoffset = this._settings.get_int('menu-x-offset');
                this.animActor.translation_x = this._menuXoffset;
            }
        });
        connectSetting('menu-y-offset', () => {
            if (this.animActor) {
                this._menuYoffset = this._settings.get_int('menu-y-offset');
                this.animActor.translation_y = this._menuYoffset;
            }
        });
        connectSetting('popup-enable-adaptive-text-color', () => {
            this._adaptiveText?.syncSettings();
        });
        connectSetting('popup-sample-interval-ms', () => {
            this._adaptiveText?.syncSettings();
        });
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        if (!this.targetActor)
            return;
        // Remove default GNOME styling and make the background transparent
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-menu-root');
        // Shift the menu to apply user offsets
        this._menuXoffset = this._settings.get_int('menu-x-offset');
        this._menuYoffset = this._settings.get_int('menu-y-offset');
        this.animActor.translation_x = this._menuXoffset;
        this.animActor.translation_y = this._menuYoffset;
        this._glassExpand = this._settings.get_int('popup-glass-expand');
        this._adaptiveText = new AdaptiveTextController({
            settings: this._settings,
            logger: this._logger,
            enabledKey: 'popup-enable-adaptive-text-color',
            intervalKey: 'popup-sample-interval-ms',
            collectGroups: () => this._buildAdaptiveGroups(),
            shouldSample: () => !!this.menu?.isOpen,
        });
        // Pivot: the menu scales from top-centre; our glass from top-left because
        // we sync its exact coordinates each frame.
        this.animActor.set_pivot_point(0.5, 0.0);
        // Find the uiGroup-direct ancestor of the menu actor.
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        this._cornerRadius = this._settings.get_double('popup-corner-radius');
        // Actor tree, shader and clone samplers — all shared, see glassSurface.ts.
        // This glass goes *above* panelBox rather than below its own root, so the
        // panel does not paint over the menu's backdrop.
        this.layer = new GlassLayer({
            extensionPath: this.extensionPath,
            settings: this._settings,
            logger: this._logger,
            keyPrefix: 'popup',
            root: menuRoot,
            insertAbove: Main.layoutManager.panelBox,
        });
        this.bgActor = this.layer.bgActor;
        this.liquidBox = this.layer.liquidBox;
        this._cloneContainer = this.layer.cloneContainer;
        this.effect = this.layer.effect;
        this._windowCloneManager = this.layer.windowClones;
        this._uiSampler = this.layer.uiSampler;
        this.layer.hide();
        // Helper functions to hook into GNOME's render pipeline
        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback);
        };
        const laterRemove = (id) => {
            if (!id)
                return;
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(id);
        };
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        // Rebuild clones (called on menu open): delegate entirely to WindowCloneManager + UILayerSampler
        let buildClones = () => {
            if (!this.bgActor)
                return;
            // _uiSampler が存在する場合のみ除外リストへの追加処理を行う
            if (this._uiSampler) {
                for (let child of Main.layoutManager.uiGroup.get_children()) {
                    if (child === this.bgActor)
                        continue;
                    // 名前が 'liquid-glass-bg-actor' のもの、または 'liquid-box' を子に持つものを
                    // 他のLiquid Glassエフェクトの背景アクターと判定する
                    let isLiquidBg = child.name === 'liquid-glass-bg-actor' ||
                        (typeof child.get_children === 'function' &&
                            child.get_children().some(c => c.name === 'liquid-box'));
                    if (isLiquidBg) {
                        this._uiSampler.addExclusion(child);
                    }
                }
            }
            this._windowCloneManager?.rebuildClones();
            this._uiSampler?.rebindSelf();
            this._uiSampler?.refresh();
        };
        // Render loop: called every frame while the menu is visible
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
        // Clear the cached size whenever the menu opens so it can recalculate
        // based on any new notifications or calendar events
        this._signals.push({
            target: this.menu,
            id: this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._stableBaseW = undefined;
                    this._stableBaseH = undefined;
                    startFrameSync();
                    this._adaptiveText?.start();
                }
                else {
                    this._adaptiveText?.stop();
                }
            })
        });
        // Stop the render loop when the menu is fully hidden (mapped = false)
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (!this.menu.actor.mapped) {
                    stopFrameSync();
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
    // Calculates and synchronizes the position/size of the glass background every frame
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
            if (this.bgActor && this.bgActor.visible) {
                this.bgActor.hide();
            }
            return;
        }
        if (!this.bgActor.visible) {
            this.bgActor.show();
        }
        // GNOME's BoxPointer transition drives the popup's opacity; the glass just
        // follows it.
        this.bgActor.opacity = this.targetActor.opacity;
        let [inW, inH] = this.animActor.get_size();
        let [outW, outH] = this.targetActor.get_size();
        let [scaleX, scaleY] = this.animActor.get_scale();
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        scaleX = Number.isNaN(scaleX) ? 1.0 : scaleX;
        scaleY = Number.isNaN(scaleY) ? 1.0 : scaleY;
        scaleX *= this.targetActor.get_scale()[0];
        scaleY *= this.targetActor.get_scale()[1];
        let themeNode = this.animActor.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        let marginW = mL + mR;
        let marginH = mT + mB;
        let targetW = Math.round(inW);
        let targetH = Math.round(inH);
        // GNOME Shell Hover Bug Compensation:
        if (Math.abs(inW - outW) <= 2 && marginW > 0) {
            targetW = Math.round(inW - marginW);
            targetH = Math.round(inH - marginH);
        }
        this._stableBaseW = targetW;
        this._stableBaseH = targetH;
        // Multiply by the current animation scale.
        let w = Math.max(1, this._stableBaseW * scaleX);
        let h = Math.max(1, this._stableBaseH * scaleY);
        // Get the absolute position of the inner content actor
        let [animAbsX, animAbsY] = this.animActor.get_transformed_position();
        // Advanced Fallback Logic for NaN Coordinates
        if (Number.isNaN(animAbsX) || Number.isNaN(animAbsY)) {
            if (this._lastValidAnimAbsX !== undefined && this._lastValidAnimAbsY !== undefined) {
                animAbsX = this._lastValidAnimAbsX;
                animAbsY = this._lastValidAnimAbsY;
            }
            else {
                let monitor = Main.layoutManager.primaryMonitor;
                if (monitor) {
                    animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset;
                    animAbsY = (Main.panel.height || 27) + this._menuYoffset;
                }
                else {
                    animAbsX = 0;
                    animAbsY = 0;
                }
            }
        }
        else {
            this._lastValidAnimAbsX = animAbsX;
            this._lastValidAnimAbsY = animAbsY;
        }
        // The background needs to be larger than the UI to account for the glass expansion
        // and the extra padding required by the shader for edge refraction.
        let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
        let bgY = animAbsY - this._glassExpand - SHADER_PADDING;
        // Monitor geometry — always valid (defaults to 0 if monitor is null)
        let monitor = this._getMenuMonitorGeometry();
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
            // Menu position in monitor-local coordinates (shader uses these)
            let localBgX = bgX - monitorX;
            let localBgY = bgY - monitorY;
            // Only update positions/sizes if they actually changed to save CPU cycles
            if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
                this._lastBgX !== bgX || this._lastBgY !== bgY ||
                this._lastScreenW !== screenW || this._lastScreenH !== screenH) {
                // 1. bgActor: full monitor size, positioned at monitor origin
                this.bgActor.remove_transition('size');
                this.bgActor.remove_transition('position');
                this.bgActor.set_position(monitorX, monitorY);
                this.bgActor.set_size(screenW, screenH);
                this.bgActor.remove_transition('size');
                this.bgActor.remove_transition('position');
                // 2. liquidBox: full monitor size (relative to bgActor = 0,0)
                this.liquidBox?.set_position(0, 0);
                this.liquidBox?.set_size(screenW, screenH);
                // 3. GPU-efficient soft clip — limits rendering to the menu region +
                //    generous margin for drop-shadow decay without hard-clipping children.
                const CLIP_PADDING = 200;
                // this.liquidBox?.remove_clip();
                this.bgActor.set_clip(localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
                const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
                this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
                // 4. Update shader with full-screen resolution
                this.effect?.setResolution(screenW, screenH);
                // 5. Tell the shader where the menu lives within the full-screen FBO
                //    (matches the dockManager setGlassGeometry pattern)
                this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
                this._lastBgW = bgW;
                this._lastBgH = bgH;
                this._lastBgX = bgX;
                this._lastBgY = bgY;
                this._lastScreenW = screenW;
                this._lastScreenH = screenH;
            }
        }
        if (this.effect) {
            let currentScale = Math.min(scaleX, scaleY);
            this.effect.setCornerRadius(this._cornerRadius * currentScale);
            if (typeof this.effect.setAnimationScale === 'function') {
                this.effect.setAnimationScale(currentScale);
            }
        }
        // Clone sync every frame (dockManager pattern).
        // WindowCloneManager handles background + window actor clones.
        // UILayerSampler handles all uiGroup children — including the overview actors
        // automatically, so no separate overview/isOverview branch is needed.
        this._windowCloneManager?.setOffset(-monitorX, -monitorY);
        this._uiSampler?.refresh();
        this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
        this._windowCloneManager?.sync();
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
        return actor instanceof St.Widget &&
            actor.has_style_class_name(className);
    }
    // Adaptive text colouring lives in src/adaptiveText.ts, shared with every
    // other surface. The date menu needs card-aware grouping: labels sitting on
    // the opaque `.events-button` / `.world-clocks-button` / `.message` cards
    // this extension adds must be judged against that card, not against the
    // wallpaper behind the popup — measuring the whole popup as one region is
    // what used to give them dark text on a dark card.
    _buildAdaptiveGroups() {
        const root = this.menu?.actor;
        if (!root || !root.mapped)
            return [];
        return groupByCard(root, MENU_CARD_CLASSES, root);
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._adaptiveText?.destroy();
        this._adaptiveText = null;
        // Disconnect all event listeners
        for (let sig of this._signals) {
            try {
                if (sig && sig.id)
                    sig.target.disconnect(sig.id);
            }
            catch (e) { }
        }
        this._signals = [];
        // Stop the render frame loop
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        if (this._interfaceSettings && this._accentColorSignalId) {
            this._interfaceSettings.disconnect(this._accentColorSignalId);
            this._accentColorSignalId = 0;
            this._interfaceSettings = null;
        }
        // Remove transparent CSS overrides
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-menu-root');
            this.animActor.translation_y = 0;
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
        }
        if (this._dynamicCssFile) {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            theme.unload_stylesheet(this._dynamicCssFile);
            this._dynamicCssFile = null;
        }
        this.targetActor.translation_y = 0;
        this.targetActor.set_scale(1.0, 1.0);
        this.targetActor.opacity = 255;
        if (this.menu.actor) {
            this.menu.actor.opacity = 255;
            if (this.menu.isOpen) {
                this.menu.close(false);
            }
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
}
