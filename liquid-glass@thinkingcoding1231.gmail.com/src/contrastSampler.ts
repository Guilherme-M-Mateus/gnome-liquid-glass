import Shell from 'gi://Shell';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

export const AdaptiveContrastConfig = {
  enabled: true,
  samplePerElement: false, // 要素ごとにサンプリングするか、全体をまとめてサンプリングするか　負荷を考慮してデフォルトはまとめてサンプリング
  sampleIntervalMs: 200, // 5Hz
  luminanceThreshold: 0.42,
  lightTextColor: '#f2f2f2',
  darkTextColor: '#1a1a1a',
};

function _clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function _srgbToLinear(c: number): number {
  const n = c / 255.0;
  if (n <= 0.04045)
    return n / 12.92;
  return Math.pow((n + 0.055) / 1.055, 2.4);
}

/**
 * sRGB -> linear for every possible channel byte.
 *
 * The inputs are always integers in 0..255, so the transfer function has only
 * 256 possible results. Computing it per channel per pixel meant three
 * Math.pow() calls for every sampled pixel — the dominant cost of a sample
 * pass. The table is exact, not an approximation: it stores the same values
 * _srgbToLinear() returns.
 */
const _SRGB_TO_LINEAR: Float64Array = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) table[i] = _srgbToLinear(i);
  return table;
})();

function _luminanceFromRgb(r: number, g: number, b: number): number {
  return 0.2126 * _SRGB_TO_LINEAR[r]
    + 0.7152 * _SRGB_TO_LINEAR[g]
    + 0.0722 * _SRGB_TO_LINEAR[b];
}

function _trimmedMean(values: number[], trimRatio: number = 0.1): number | null {
  if (values.length === 0)
    return null;

  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * trimRatio);
  const start = _clamp(trim, 0, sorted.length - 1);
  const end = _clamp(sorted.length - trim, start + 1, sorted.length);

  let sum = 0.0;
  for (let i = start; i < end; i++)
    sum += sorted[i];

  return sum / (end - start);
}

/**
 * Target number of samples along each axis of a measured region.
 *
 * The luminance estimate feeds a light/dark text decision with a hysteresis
 * band around it, so a few thousand samples is far more than enough; the extra
 * precision from reading every pixel changes nothing about the outcome.
 */
const SAMPLES_PER_AXIS = 48;

/**
 * Per-axis sampling stride for a region.
 *
 * Previously a single stride derived from the *smaller* dimension:
 * `max(1, floor(min(w, h) / 48))`. For anything long and thin — the top panel
 * band being the obvious case, at roughly 1920x40 — the short side drives the
 * divisor to 0, the stride clamps to 1, and the loop walks every one of the
 * ~77k pixels instead of the intended ~2.3k. Computing the axes independently
 * keeps the sample count near the target whatever the aspect ratio.
 */
function _strides(width: number, height: number): [number, number] {
  return [
    Math.max(1, Math.floor(width / SAMPLES_PER_AXIS)),
    Math.max(1, Math.floor(height / SAMPLES_PER_AXIS)),
  ];
}

function _getActorRect(actor: Clutter.Actor): { x: number, y: number, width: number, height: number } | null {
  if (!actor)
    return null;

  const [x, y] = actor.get_transformed_position();
  const [w, h] = actor.get_size();

  if ([x, y, w, h].some(Number.isNaN))
    return null;

  const width = Math.max(1, Math.floor(w));
  const height = Math.max(1, Math.floor(h));
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

function _mergeRects(rects: { x: number, y: number, width: number, height: number }[]): { x: number, y: number, width: number, height: number } | null {
  if (rects.length === 0)
    return null;

  let minX = rects[0].x;
  let minY = rects[0].y;
  let maxX = rects[0].x + rects[0].width;
  let maxY = rects[0].y + rects[0].height;

  for (let i = 1; i < rects.length; i++) {
    const r = rects[i];
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}


/**
 * Captures a screen region and decodes it, without touching the filesystem.
 *
 * The previous path wrote a PNG to /tmp and immediately read it back to decode
 * it. That is a full write/read round trip through the filesystem, on a repeat
 * timer, for a buffer that is thrown away microseconds later — and on an idle
 * desktop the panel's sampler alone did it once a second, forever.
 *
 * Capturing into a memory stream keeps the PNG encode (Shell.Screenshot only
 * writes PNG) but drops the disk I/O and the unlink.
 */
async function _captureAreaToPixbuf(
  screenshot: Shell.Screenshot,
  rect: { x: number, y: number, width: number, height: number }
): Promise<GdkPixbuf.Pixbuf | null> {
  return new Promise((resolve: (pixbuf: GdkPixbuf.Pixbuf | null) => void) => {
    try {
      const stream = Gio.MemoryOutputStream.new_resizable();

      screenshot.screenshot_area(
        rect.x, rect.y, rect.width, rect.height, stream,
        (obj, res) => {
          try {
            if (!obj) throw new Error('Screenshot object is null');

            const success = obj.screenshot_area_finish(res)[0];
            // Must close before stealing: the PNG encoder may still be
            // buffering, and steal_as_bytes() on an open stream can truncate.
            stream.close(null);
            if (!success) { resolve(null); return; }

            const bytes = stream.steal_as_bytes();
            const input = Gio.MemoryInputStream.new_from_bytes(bytes);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(input, null);
            input.close(null);
            resolve(pixbuf ?? null);
          } catch (e) {
            try { stream.close(null); } catch (_) { }
            resolve(null);
          }
        }
      );
    } catch (e) {
      resolve(null);
    }
  });
}

export class StageContrastSampler {
  private _screenshot: Shell.Screenshot;

  constructor() {
    this._screenshot = new Shell.Screenshot();
  }

  async sampleLuminance(rect: { x: number, y: number, width: number, height: number }): Promise<number | null> {
    if (!rect || rect.width <= 0 || rect.height <= 0)
      return null;

    const pixbuf = await _captureAreaToPixbuf(this._screenshot, rect);
    if (!pixbuf)
      return null;

    try {
      const width = pixbuf.get_width();
      const height = pixbuf.get_height();
      const rowstride = pixbuf.get_rowstride();
      const channels = pixbuf.get_n_channels();
      const hasAlpha = pixbuf.get_has_alpha();
      const pixels = pixbuf.get_pixels();

      const [stepX, stepY] = _strides(width, height);
      const values: number[] = [];

      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const idx = y * rowstride + x * channels;
          if (hasAlpha) {
            const a = pixels[idx + 3];
            if (a < 32)
              continue;

            if (a < 255) {
              const scale = 255.0 / a;
              const r = _clamp(Math.round(pixels[idx + 0] * scale), 0, 255);
              const g = _clamp(Math.round(pixels[idx + 1] * scale), 0, 255);
              const b = _clamp(Math.round(pixels[idx + 2] * scale), 0, 255);
              values.push(_luminanceFromRgb(r, g, b));
              continue;
            }
          }

          const r = pixels[idx + 0];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          values.push(_luminanceFromRgb(r, g, b));
        }
      }

      return _trimmedMean(values, 0.10);
    } catch (e) {
      return null;
    }
  }

  /**
   * Measures several regions from a SINGLE screen capture.
   *
   * `sampleLuminance` takes one screenshot and decodes it — so measuring N
   * regions with it costs N captures, serialized. A popup can easily hold 150
   * text actors (a calendar alone has 42 day cells), which makes per-region
   * colouring unaffordable that way. Here the union is captured once and every
   * sub-rect is read out of that one decoded pixbuf, so the cost no longer
   * depends on how many regions are asked for.
   *
   * `subRects` are in the same absolute screen coordinates as `union`; any that
   * fall outside it, or that hold no usable pixels, come back as null.
   */
  async sampleLuminanceRegions(
    union: { x: number, y: number, width: number, height: number },
    subRects: { x: number, y: number, width: number, height: number }[]
  ): Promise<(number | null)[]> {
    const out: (number | null)[] = subRects.map(() => null);
    if (!union || union.width <= 0 || union.height <= 0 || subRects.length === 0)
      return out;

    const pixbuf = await _captureAreaToPixbuf(this._screenshot, union);
    if (!pixbuf)
      return out;

    try {
      const width = pixbuf.get_width();
      const height = pixbuf.get_height();
      const rowstride = pixbuf.get_rowstride();
      const channels = pixbuf.get_n_channels();
      const hasAlpha = pixbuf.get_has_alpha();
      const pixels = pixbuf.get_pixels();

      // The capture can come back at a different pixel size than requested on
      // a scaled display, so map requested coordinates through that ratio.
      const sx = width / union.width;
      const sy = height / union.height;

      for (let i = 0; i < subRects.length; i++) {
        const r = subRects[i];
        if (!r || r.width <= 0 || r.height <= 0) continue;

        const x0 = _clamp(Math.floor((r.x - union.x) * sx), 0, Math.max(0, width - 1));
        const y0 = _clamp(Math.floor((r.y - union.y) * sy), 0, Math.max(0, height - 1));
        const x1 = _clamp(Math.ceil((r.x - union.x + r.width) * sx), x0 + 1, width);
        const y1 = _clamp(Math.ceil((r.y - union.y + r.height) * sy), y0 + 1, height);

        const [stepX, stepY] = _strides(x1 - x0, y1 - y0);
        const values: number[] = [];

        for (let y = y0; y < y1; y += stepY) {
          for (let x = x0; x < x1; x += stepX) {
            const idx = y * rowstride + x * channels;
            if (hasAlpha) {
              const a = pixels[idx + 3];
              if (a < 32)
                continue;

              if (a < 255) {
                const scale = 255.0 / a;
                const rr = _clamp(Math.round(pixels[idx + 0] * scale), 0, 255);
                const gg = _clamp(Math.round(pixels[idx + 1] * scale), 0, 255);
                const bb = _clamp(Math.round(pixels[idx + 2] * scale), 0, 255);
                values.push(_luminanceFromRgb(rr, gg, bb));
                continue;
              }
            }

            values.push(_luminanceFromRgb(pixels[idx + 0], pixels[idx + 1], pixels[idx + 2]));
          }
        }

        out[i] = _trimmedMean(values, 0.10);
      }

      return out;
    } catch (e) {
      return out;
    }
  }

  decideTextColor(luminance: number, config: typeof AdaptiveContrastConfig = AdaptiveContrastConfig): string | null {
    if (luminance === null || luminance === undefined)
      return null;

    return luminance > config.luminanceThreshold
      ? config.darkTextColor
      : config.lightTextColor;
  }

  async chooseColorsForActors(actors: Clutter.Actor[], config: typeof AdaptiveContrastConfig = AdaptiveContrastConfig): Promise<Map<Clutter.Actor, string>> {
    const rects: { x: number, y: number, width: number, height: number }[] = [];
    const targets: Clutter.Actor[] = [];

    for (const actor of actors) {
      const rect = _getActorRect(actor);
      if (!rect)
        continue;

      targets.push(actor);
      rects.push(rect);
    }

    const result = new Map();
    if (targets.length === 0)
      return result;

    if (!config.samplePerElement) {
      const merged = _mergeRects(rects);
      if (!merged)
        return result;
      const luma = await this.sampleLuminance(merged);
      // Only null means "could not measure". A luminance of exactly 0.0 is a
      // legitimate reading (a pure black backdrop) and must not be discarded —
      // `!luma` used to throw that away and leave the text at its old colour.
      if (luma === null)
        return result;
      const color = this.decideTextColor(luma, config);
      if (!color)
        return result;

      for (const actor of targets)
        result.set(actor, color);
      return result;
    }

    // Per-element: one region per actor, but a single capture for all of them.
    const merged = _mergeRects(rects);
    if (!merged)
      return result;
    const lumas = await this.sampleLuminanceRegions(merged, rects);
    for (let i = 0; i < targets.length; i++) {
      const luma = lumas[i];
      if (luma === null || luma === undefined)
        continue;
      const color = this.decideTextColor(luma, config);
      if (color)
        result.set(targets[i], color);
    }

    return result;
  }
}
