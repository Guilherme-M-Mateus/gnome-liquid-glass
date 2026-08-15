import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Logger } from "./logger.js"

/**
 * Frame-time instrumentation, gated behind the `output-logs` setting.
 *
 * Every optimization in this extension is a claim about cost, and claims about
 * cost need numbers. This connects to the stage's 'after-paint' and records the
 * wall-clock interval between paints into a fixed ring buffer, then reports
 * percentiles on a slow timer.
 *
 * Percentiles rather than a mean: the thing that makes a desktop feel bad is
 * not the average frame, it's the occasional 40 ms one. A mean hides exactly
 * the frames worth finding.
 *
 * Note this measures the interval between paints of the whole shell, not this
 * extension's share of it. It is a regression detector for a fixed scenario
 * (idle, dragging a window, menu open), not an attribution tool — compare the
 * same scenario before and after a change. For attribution, use sysprof.
 */
export class PerfProbe {
  /** ~17 s of history at 60 Hz; enough to cover a full report window. */
  private static readonly CAPACITY = 1024;
  /** How often percentiles are emitted. */
  private static readonly REPORT_INTERVAL_MS = 5000;

  private _settings: Gio.Settings;
  private _logger: Logger;

  private _samples = new Float64Array(PerfProbe.CAPACITY);
  private _writeIndex = 0;
  private _filled = 0;
  private _lastPaintUs = 0;

  /** Counts paints attributed to a named surface, reset each report. */
  private _paintCounts = new Map<string, number>();

  private _afterPaintId = 0;
  private _reportTimerId = 0;
  private _settingsId = 0;
  private _stage: any = null;
  private _running = false;

  constructor(settings: Gio.Settings, logger: Logger) {
    this._settings = settings;
    this._logger = logger;

    this._settingsId = this._settings.connect('changed::output-logs', () => {
      if (this._settings.get_boolean('output-logs')) this.start();
      else this.stop();
    });

    if (this._settings.get_boolean('output-logs')) this.start();
  }

  /**
   * Records one paint of a named surface. Called from a manager's frame loop
   * to show how many surfaces are actually repainting in a given scenario —
   * the count matters as much as the frame time, since every glass surface
   * carries its own full effect pipeline.
   */
  countPaint(surface: string): void {
    if (!this._running) return;
    this._paintCounts.set(surface, (this._paintCounts.get(surface) ?? 0) + 1);
  }

  start(): void {
    if (this._running) return;

    this._stage = (globalThis as any).global?.stage;
    if (!this._stage) {
      this._logger.warn('[Liquid Glass] PerfProbe: no stage available');
      return;
    }

    this._running = true;
    this._lastPaintUs = 0;
    this._writeIndex = 0;
    this._filled = 0;
    this._paintCounts.clear();

    this._afterPaintId = this._stage.connect('after-paint', () => {
      const nowUs = GLib.get_monotonic_time();
      // The first paint has no predecessor to measure against.
      if (this._lastPaintUs !== 0) {
        this._samples[this._writeIndex] = (nowUs - this._lastPaintUs) / 1000;
        this._writeIndex = (this._writeIndex + 1) % PerfProbe.CAPACITY;
        if (this._filled < PerfProbe.CAPACITY) this._filled++;
      }
      this._lastPaintUs = nowUs;
    });

    this._reportTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT, PerfProbe.REPORT_INTERVAL_MS, () => {
        this._report();
        return GLib.SOURCE_CONTINUE;
      });

    this._logger.log('[Liquid Glass] PerfProbe started');
  }

  private _report(): void {
    if (this._filled === 0) return;

    // Copy out before sorting: the ring buffer keeps filling during the report.
    const sorted = Array.prototype.slice.call(this._samples, 0, this._filled) as number[];
    sorted.sort((a, b) => a - b);

    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2);

    const fps = sorted.length /
      (sorted.reduce((acc, ms) => acc + ms, 0) / 1000);

    let paints = '';
    if (this._paintCounts.size > 0) {
      paints = ' | paints ' + [...this._paintCounts.entries()]
        .map(([name, n]) => `${name}=${n}`).join(' ');
      this._paintCounts.clear();
    }

    this._logger.log(
      `[Liquid Glass] frame ms  p50=${at(0.50)} p95=${at(0.95)} p99=${at(0.99)} ` +
      `max=${sorted[sorted.length - 1].toFixed(2)} (${fps.toFixed(1)} fps, n=${sorted.length})${paints}`
    );

    // Each window reports only the frames observed since the last one.
    this._writeIndex = 0;
    this._filled = 0;
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._afterPaintId !== 0 && this._stage) {
      this._stage.disconnect(this._afterPaintId);
      this._afterPaintId = 0;
    }
    if (this._reportTimerId !== 0) {
      GLib.source_remove(this._reportTimerId);
      this._reportTimerId = 0;
    }
    this._stage = null;
    this._logger.log('[Liquid Glass] PerfProbe stopped');
  }

  cleanup(): void {
    this.stop();
    if (this._settingsId !== 0) {
      this._settings.disconnect(this._settingsId);
      this._settingsId = 0;
    }
  }
}
