// src/adaptiveText.ts
//
// Shared adaptive text colouring for every glass surface.
//
// Each surface used to carry its own near-identical copy of this logic — five
// of them, drifting apart over time (one matched St.Icon, another didn't; one
// tracked the styles it overwrote, others leaked them). This is that logic,
// once.
//
// Two things it does differently from the code it replaces:
//
//   Regions, not one blob. The old path merged every text actor into a single
//   bounding box, took one luminance reading and painted every label the same
//   colour. In the calendar popup that meant labels sitting on the extension's
//   own dark cards were given dark text. Groups are measured separately, and a
//   label on a card is measured against that card.
//
//   Hysteresis. The sampler reads the composited screen, so the text we just
//   coloured is part of what we measure next tick. With a bare threshold that
//   feeds back on itself and the colour oscillates forever whenever the
//   backdrop sits near the line. A deadband makes that impossible.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { Logger } from './logger.js';

export interface Rect { x: number; y: number; width: number; height: number }

/** One independently-measured region: some text, and the thing behind it. */
export interface AdaptiveGroup {
  /** Stable identity across ticks — the hysteresis state is keyed on this. */
  key: Clutter.Actor;
  targets: Clutter.Actor[];
  /**
   * What to measure. Omit to use a padded box around the glyphs; pass the card
   * an actor sits on when the text is over opaque chrome rather than glass.
   */
  rect?: Rect | null;
}

export interface AdaptiveTextOptions {
  settings: Gio.Settings;
  logger: Logger;
  /** Key holding the on/off boolean, e.g. 'popup-enable-adaptive-text-color'. */
  enabledKey: string;
  /** Key holding the sampling period in ms. */
  intervalKey: string;
  /** Called every tick to find what to colour. Return [] to skip the tick. */
  collectGroups: () => AdaptiveGroup[];
  /** Extra gate, e.g. "not while the overview is up". */
  shouldSample?: () => boolean;
}

interface StyledActor extends St.Widget {
  _lgColorTweenId?: number;
  _lgTargetColor?: string;
}

// Deadband around the light/dark threshold. Measured self-feedback with padded
// rects is ~0.008, so this is a ~7x margin: wide enough that our own glyphs can
// never flip the decision, narrow enough to still follow a real change.
const HYSTERESIS = 0.06;

// Horizontal breathing room around glyphs, so the backdrop dominates the
// reading rather than the text we are deciding the colour of.
const GLYPH_PAD_X = 24;
const GLYPH_PAD_Y = 6;

const COLOR_TWEEN_MS = 380;

/** Collects the labels and icons under `root` that are worth colouring. */
export function findTextActors(root: Clutter.Actor | null, found: Clutter.Actor[] = []): Clutter.Actor[] {
  if (!root) return found;

  if (root instanceof St.Label || root instanceof Clutter.Text || root instanceof St.Icon) {
    if (root.visible) found.push(root);
  }

  let children: Clutter.Actor[];
  try {
    children = root.get_children();
  } catch (_) {
    return found;
  }
  for (const child of children) findTextActors(child, found);
  return found;
}

function actorRect(actor: Clutter.Actor): Rect | null {
  try {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_size();
    if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  } catch (_) {
    return null;
  }
}

function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function hasAnyStyleClass(actor: Clutter.Actor, classes: string[]): boolean {
  const w = actor as St.Widget;
  if (typeof w.has_style_class_name !== 'function') return false;
  for (const c of classes) {
    try {
      if (w.has_style_class_name(c)) return true;
    } catch (_) { /* not an St.Widget */ }
  }
  return false;
}

/**
 * Splits `root`'s text into one group per opaque card, plus one group for
 * everything sitting directly on the glass.
 *
 * A label on a card must be judged against the card, not against the wallpaper
 * behind the popup — that mismatch is what produced dark text on the dark
 * `.events-button` / `.message` cards.
 */
export function groupByCard(
  root: Clutter.Actor | null,
  cardClasses: string[],
  baseKey: Clutter.Actor
): AdaptiveGroup[] {
  if (!root) return [];

  const byCard = new Map<Clutter.Actor, Clutter.Actor[]>();
  const onGlass: Clutter.Actor[] = [];

  for (const actor of findTextActors(root)) {
    // Walk up to the nearest enclosing card, stopping at the popup root.
    let card: Clutter.Actor | null = null;
    let cur: Clutter.Actor | null = actor;
    while (cur && cur !== root) {
      if (hasAnyStyleClass(cur, cardClasses)) { card = cur; break; }
      cur = cur.get_parent();
    }

    if (card) {
      const list = byCard.get(card);
      if (list) list.push(actor);
      else byCard.set(card, [actor]);
    } else {
      onGlass.push(actor);
    }
  }

  const groups: AdaptiveGroup[] = [];
  if (onGlass.length > 0) groups.push({ key: baseKey, targets: onGlass });
  for (const [card, targets] of byCard)
    groups.push({ key: card, targets, rect: actorRect(card) });
  return groups;
}

export class AdaptiveTextController {
  private _opts: AdaptiveTextOptions;
  private _sampler: StageContrastSampler;
  private _config: typeof AdaptiveContrastConfig;

  private _timerId = 0;
  private _inFlight = false;
  private _firstRun = true;

  /** Original inline style per actor, so teardown restores exactly. */
  private _styled = new Map<Clutter.Actor, string>();
  /** Last decision per group key, giving the deadband something to hold. */
  private _usesDarkText = new Map<Clutter.Actor, boolean>();

  constructor(opts: AdaptiveTextOptions) {
    this._opts = opts;
    this._sampler = new StageContrastSampler();
    this._config = {
      ...AdaptiveContrastConfig,
      enabled: opts.settings.get_boolean(opts.enabledKey),
      sampleIntervalMs: opts.settings.get_int(opts.intervalKey),
    };
  }

  get enabled(): boolean { return this._config.enabled; }

  /** Re-read the two settings; restarts the timer if the period changed. */
  syncSettings() {
    const { settings, enabledKey, intervalKey } = this._opts;
    this._config.enabled = settings.get_boolean(enabledKey);
    this._config.sampleIntervalMs = settings.get_int(intervalKey);
    if (this._timerId !== 0) { this.stop(); this.start(); }
    if (!this._config.enabled) { this.stop(); this.clear(); }
  }

  start() {
    if (!this._config.enabled || this._timerId !== 0) return;

    this.update();
    this._timerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(100, this._config.sampleIntervalMs),
      () => {
        if (!this._config.enabled) { this._timerId = 0; return GLib.SOURCE_REMOVE; }
        this.update();
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  stop() {
    if (this._timerId !== 0) {
      GLib.source_remove(this._timerId);
      this._timerId = 0;
    }
  }

  /** Sample once and apply. Safe to call directly (e.g. on menu open). */
  async update() {
    if (!this._config.enabled || this._inFlight) return;
    if (this._opts.shouldSample && !this._opts.shouldSample()) return;

    let groups: AdaptiveGroup[];
    try {
      groups = this._opts.collectGroups();
    } catch (e) {
      this._opts.logger.error(`[Liquid Glass] adaptive text: collect failed: ${e}`);
      return;
    }
    if (!groups || groups.length === 0) return;

    // Resolve one sample rect per group, dropping groups we cannot measure.
    const usable: { group: AdaptiveGroup, rect: Rect }[] = [];
    for (const group of groups) {
      const rect = group.rect ?? this._paddedRectFor(group);
      if (rect) usable.push({ group, rect });
    }
    if (usable.length === 0) return;

    const union = unionRects(usable.map(u => u.rect));
    if (!union) return;

    this._inFlight = true;
    const skipAnim = this._firstRun;
    this._firstRun = false;

    try {
      // One capture for every region, however many there are.
      const lumas = await this._sampler.sampleLuminanceRegions(union, usable.map(u => u.rect));
      this._opts.logger.log(
        `[Liquid Glass] adaptive: 1 capture -> ${usable.length} regions ` +
        `(${usable.reduce((n, u) => n + u.group.targets.length, 0)} actors)`
      );

      const threshold = this._config.luminanceThreshold;
      for (let i = 0; i < usable.length; i++) {
        const luma = lumas[i];
        if (luma === null || luma === undefined) continue;

        const { group } = usable[i];
        const prev = this._usesDarkText.get(group.key);
        let useDark: boolean;
        if (prev === undefined) useDark = luma > threshold;
        else if (prev && luma < threshold - HYSTERESIS) useDark = false;
        else if (!prev && luma > threshold + HYSTERESIS) useDark = true;
        else useDark = prev;
        this._usesDarkText.set(group.key, useDark);
        this._opts.logger.log(
          `[Liquid Glass]   region ${describeActor(group.key)} ` +
          `n=${group.targets.length} luma=${luma.toFixed(4)} ` +
          `-> ${useDark ? 'DARK' : 'LIGHT'} text`
        );

        const color = useDark ? this._config.darkTextColor : this._config.lightTextColor;
        for (const actor of group.targets)
          this._setActorColor(actor as StyledActor, color, skipAnim);
      }
    } catch (e) {
      this._opts.logger.error(`[Liquid Glass] adaptive text update failed: ${e}`);
    } finally {
      this._inFlight = false;
    }
  }

  /** Restores every style we overwrote and forgets all decisions. */
  clear() {
    for (const [raw, style] of this._styled.entries()) {
      const actor = raw as StyledActor;
      if (!actor || typeof actor.set_style !== 'function') continue;
      try {
        if (actor._lgColorTweenId) {
          GLib.source_remove(actor._lgColorTweenId);
          actor._lgColorTweenId = undefined;
        }
        actor._lgTargetColor = undefined;
        actor.set_style(style === '' ? null : style);
      } catch (_) { /* actor already destroyed */ }
    }
    this._styled.clear();
    this._usesDarkText.clear();
    this._firstRun = true;
  }

  destroy() {
    this.stop();
    this.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _paddedRectFor(group: AdaptiveGroup): Rect | null {
    const rects: Rect[] = [];
    for (const actor of group.targets) {
      const r = actorRect(actor);
      if (r) rects.push(r);
    }
    const u = unionRects(rects);
    if (!u) return null;
    return {
      x: Math.floor(u.x - GLYPH_PAD_X),
      y: Math.floor(u.y - GLYPH_PAD_Y),
      width: Math.max(1, Math.ceil(u.width + GLYPH_PAD_X * 2)),
      height: Math.max(1, Math.ceil(u.height + GLYPH_PAD_Y * 2)),
    };
  }

  private _setActorColor(actor: StyledActor, color: string, skipAnimation: boolean) {
    if (!actor || typeof actor.set_style !== 'function') return;
    if (actor._lgTargetColor === color) return;

    if (!this._styled.has(actor))
      this._styled.set(actor, actor.get_style() ?? '');

    actor._lgTargetColor = color;
    this._animateColor(actor, color, skipAnimation);
  }

  private _animateColor(actor: StyledActor, targetHex: string, skipAnimation: boolean) {
    if (actor._lgColorTweenId) {
      GLib.source_remove(actor._lgColorTweenId);
      actor._lgColorTweenId = undefined;
    }

    const base = this._styled.get(actor) ?? '';
    const target = hexToRgb(targetHex);
    const paint = (hex: string) => {
      try {
        actor.set_style(`${base} color: ${hex}; -st-icon-foreground-color: ${hex};`);
        return true;
      } catch (_) {
        return false;
      }
    };

    if (skipAnimation) {
      paint(rgbToHex(target.r, target.g, target.b));
      return;
    }

    let start: { red: number, green: number, blue: number };
    try {
      start = actor.get_theme_node().get_foreground_color();
    } catch (_) {
      paint(rgbToHex(target.r, target.g, target.b));
      return;
    }

    const startTime = GLib.get_monotonic_time();
    actor._lgColorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000;
      const t = Math.min(elapsedMs / COLOR_TWEEN_MS, 1.0);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      const r = Math.round(start.red + (target.r - start.red) * ease);
      const g = Math.round(start.green + (target.g - start.green) * ease);
      const b = Math.round(start.blue + (target.b - start.blue) * ease);

      if (!paint(rgbToHex(r, g, b)) || t >= 1.0) {
        actor._lgColorTweenId = undefined;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }
}

/** Short human label for a group key, for the debug log only. */
function describeActor(actor: Clutter.Actor): string {
  try {
    const name = actor.get_name();
    if (name) return name;
    const cls = (actor as any).get_style_class_name?.();
    if (cls) return `.${String(cls).split(/\s+/)[0]}`;
    return actor.constructor?.name ?? '?';
  } catch (_) {
    return '?';
  }
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number) {
  return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}
