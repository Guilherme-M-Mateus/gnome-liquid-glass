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
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableActor, UILayerSampler, WindowCloneManager } from './utils.js';
const GLib_SOURCE_REMOVE = GLib.SOURCE_REMOVE;
function laterAdd(cb) {
    return global.compositor?.get_laters?.().add(Meta.LaterType.BEFORE_REDRAW, cb) ?? 0;
}
/** Extra room around the surface for refraction and blur to spill into. */
export const SHADER_PADDING = 20;
export function hexToColorArray(hex) {
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
];
export class GlassLayer {
    bgActor;
    liquidBox;
    cloneContainer;
    effect;
    uiSampler;
    windowClones;
    _opts;
    _destroyed = false;
    // Only touch the actor tree when something actually moved.
    _lastX;
    _lastY;
    _lastW;
    _lastH;
    _lastFboW;
    _lastFboH;
    _lastRadius;
    constructor(opts) {
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
        });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setIsDock(!!opts.isDock);
        this.liquidBox.add_effect(this.effect);
        this.applySettings();
        this.windowClones = new WindowCloneManager(this.liquidBox, this.cloneContainer);
        this.uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [opts.root, global.windowGroup, global.window_group, ...(opts.exclusions ?? [])], this.cloneContainer);
    }
    /** Pushes every `<prefix>-*` value to the shader. */
    applySettings() {
        if (this._destroyed)
            return;
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
        if (this._destroyed)
            return;
        this.windowClones.rebuildClones();
        this.uiSampler.rebindSelf();
        this.uiSampler.refresh();
    }
    /** Excludes every other glass instance currently in uiGroup from this one. */
    excludeOtherGlassRoots() {
        if (this._destroyed)
            return;
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            if (child === this.bgActor)
                continue;
            const isGlass = child.get_name?.() === 'liquid-glass-bg-actor' ||
                (typeof child.get_children === 'function' &&
                    child.get_children().some((c) => c.get_name?.() === 'liquid-box'));
            if (isGlass)
                this.uiSampler.addExclusion(child);
        }
    }
    addExclusion(actor) {
        if (!this._destroyed && actor)
            this.uiSampler.addExclusion(actor);
    }
    /** Forces the next sync to rewrite the actor tree even if nothing moved. */
    invalidateGeometry() {
        this._lastX = this._lastY = this._lastW = this._lastH = undefined;
        this._lastFboW = this._lastFboH = this._lastRadius = undefined;
    }
    hide() { if (!this._destroyed)
        this.bgActor.hide(); }
    show() { if (!this._destroyed && !this.bgActor.visible)
        this.bgActor.show(); }
    /**
     * The per-frame geometry update every surface performs identically: size the
     * FBO, tell the shader where the glass sits inside it, and drag the clone
     * containers into the same coordinate space.
     */
    sync(geom) {
        if (this._destroyed)
            return;
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
        if (geom.opacity !== undefined)
            this.bgActor.opacity = geom.opacity;
        const radius = geom.cornerRadius;
        if (this._lastX !== bgX || this._lastY !== bgY ||
            this._lastW !== bgW || this._lastH !== bgH ||
            this._lastFboW !== fboW || this._lastFboH !== fboH ||
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
            }
            else {
                // Soft clip: limits fragment work to the surface plus room for the
                // shadow to decay, without hard-clipping children.
                this.bgActor.set_clip(localX - clipPad, localY - clipPad, bgW + clipPad * 2, bgH + clipPad * 2);
            }
            this.effect.setShadowMaxRadius(Math.max(0, clipPad - 20));
            if (radius !== undefined) {
                this.effect.setCornerRadius(radius);
                this._lastRadius = radius;
            }
            this.effect.setResolution(fboW, fboH);
            this.effect.setGlassGeometry(localX, localY, bgW, bgH);
            this._lastX = bgX;
            this._lastY = bgY;
            this._lastW = bgW;
            this._lastH = bgH;
            this._lastFboW = fboW;
            this._lastFboH = fboH;
        }
        this.windowClones.setOffset(-fbo.x, -fbo.y);
        this.uiSampler.refresh();
        this.uiSampler.sync(fbo.x, fbo.y, fboW, fboH);
        this.windowClones.sync();
    }
    /**
     * Order matters: the effect owns Cogl pipelines tied to the actor, so it is
     * cleaned up first. Destroying bgActor then cascades the whole subtree.
     */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        try {
            this.effect.cleanup();
        }
        catch (_) { }
        try {
            this.bgActor.hide();
        }
        catch (_) { }
        try {
            this.bgActor.destroy();
        }
        catch (_) { }
        try {
            this.uiSampler.destroy();
        }
        catch (_) { }
        try {
            this.windowClones.destroy();
        }
        catch (_) { }
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
    _id = 0;
    _tick;
    _shouldRun;
    _onStart;
    constructor(tick, shouldRun, onStart) {
        this._tick = tick;
        this._shouldRun = shouldRun;
        this._onStart = onStart;
    }
    get running() { return this._id !== 0; }
    start() {
        if (this._id !== 0 || !this._shouldRun())
            return;
        this._onStart?.();
        const step = () => {
            this._id = 0;
            if (!this._shouldRun())
                return GLib_SOURCE_REMOVE;
            this._tick();
            this._id = laterAdd(step);
            return GLib_SOURCE_REMOVE;
        };
        this._id = laterAdd(step);
    }
    stop() {
        if (this._id === 0)
            return;
        try {
            global.compositor?.get_laters?.().remove(this._id);
        }
        catch (_) { }
        this._id = 0;
    }
    /** Stops only if the run condition has gone false. */
    stopIfIdle() {
        if (!this._shouldRun())
            this.stop();
    }
}
