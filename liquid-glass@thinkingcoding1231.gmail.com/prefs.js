import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';

const SCHEMA_ID = 'org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com';
const BACKUP_VERSION = 1;

export default class LiquidGlassPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com");

    const blurRadiusRows = []; // blur-radius のテキストボックスの row を保持する

    // 拡張機能のディレクトリから resources.gresource の絶対パスを取得する
    const resourceFile = this.dir.get_child('resources.gresource');
    const resource = Gio.Resource.load(resourceFile.get_path());
    resource._register();
    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    iconTheme.add_resource_path('/com/example/my-app/icons');

    // --- General タブ ---
    // Landing page: the master toggles for every surface in one place, plus
    // settings backup/restore.
    const generalPage = new Adw.PreferencesPage({
      title: 'General',
      icon_name: 'preferences-system-symbolic',
    });
    window.add(generalPage);

    const surfacesGroup = new Adw.PreferencesGroup({
      title: 'Surfaces',
      description: 'Which parts of the shell get the liquid glass effect. These mirror the toggles on each page.',
    });
    generalPage.add(surfacesGroup);

    this._addSwitchRow(surfacesGroup, settings, 'enable-panel-glass', 'Top Panel', 'The top panel bar');
    this._addSwitchRow(surfacesGroup, settings, 'enable-dock-glass', 'Dock', 'Dash to Dock');
    this._addSwitchRow(surfacesGroup, settings, 'enable-menu-glass', 'Menus', 'Panel menus and popups');
    this._addSwitchRow(surfacesGroup, settings, 'enable-notification-glass', 'Notifications', 'Notification banners');
    this._addSwitchRow(surfacesGroup, settings, 'enable-quick-settings-glass', 'Quick Settings', 'The quick settings panel');
    this._addSwitchRow(surfacesGroup, settings, 'enable-osd-glass', 'OSD', 'Volume and brightness popups');

    const backupGroup = new Adw.PreferencesGroup({
      title: 'Backup & Restore',
      description: 'Save your tuned configuration to a file, restore it, or start over.',
    });
    generalPage.add(backupGroup);

    this._addButtonRow(backupGroup, 'Export Settings', 'Save all settings to a JSON file',
      'Export…', false, () => this._exportSettings(settings, window));
    this._addButtonRow(backupGroup, 'Import Settings', 'Load settings from a previously exported file',
      'Import…', false, () => this._importSettings(settings, window));
    this._addButtonRow(backupGroup, 'Reset All to Defaults', 'Discard every customisation and return to the shipped defaults',
      'Reset…', true, () => this._confirmResetSettings(settings, window));

    // --- Top Panel タブ ---
    const panelPage = new Adw.PreferencesPage({
      title: 'Top Panel',
      icon_name: 'focus-top-bar-symbolic',
    });
    window.add(panelPage);

    const panelGroup = new Adw.PreferencesGroup({
      title: 'Top Panel Settings',
      description: 'Configure the liquid glass effect for the GNOME top panel bar',
    });
    panelPage.add(panelGroup);

    this._addSwitchRow(panelGroup, settings, 'enable-panel-glass', 'Enable Glass Effect', 'Apply the effect to the top panel');

    this._addSwitchRow(panelGroup, settings, 'panel-transparent', 'Fully Transparent', 'Draw no glass at all — just the clock, icons and buttons over your wallpaper. Adaptive text colour still runs so they stay readable.');

    this._addSwitchRow(panelGroup, settings, 'panel-floating', 'Floating Panel', 'Inset the panel and draw it as a rounded pill. When off, the panel stays edge-to-edge and only its bottom corners are rounded.');
    const panelSideMarginRow = this._addSliderRow(panelGroup, settings, 'panel-side-margin', 'Side Margin', 'Left/right inset of the floating panel', 0, 100, 1);
    const panelTopMarginRow = this._addSliderRow(panelGroup, settings, 'panel-top-margin', 'Top Margin', 'Top inset of the floating panel', 0, 50, 1);
    // Margins only mean anything while the panel is floating.
    settings.bind('panel-floating', panelSideMarginRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('panel-floating', panelTopMarginRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addSliderRow(panelGroup, settings, 'panel-height', 'Panel Height', 'Overrides the theme height. 0 = theme default. A taller panel gives the glass more room to read.', 0, 120, 1);
    this._addSliderRow(panelGroup, settings, 'panel-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);

    this._addSwitchRow(panelGroup, settings, 'panel-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const panelSampleIntervalRow = this._addSliderRow(panelGroup, settings, 'panel-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency. The panel is always on screen, so keep this higher than for other surfaces.', 200, 5000, 50);
    settings.bind('panel-enable-adaptive-text-color', panelSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addColorRow(panelGroup, settings, 'panel-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(panelGroup, settings, 'panel-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const panelBlurRow = this._addSliderRow(panelGroup, settings, 'panel-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(panelBlurRow);
    this._addSliderRow(panelGroup, settings, 'panel-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    const panelAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    panelGroup.add(panelAdvanced);

    this._addSliderRow(panelAdvanced, settings, 'panel-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(panelAdvanced, settings, 'panel-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(panelAdvanced, settings, 'panel-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);

    // --- Dock タブ ---
    const dockPage = new Adw.PreferencesPage({
      title: 'Dock',
      icon_name: 'dock-bottom-symbolic',
    });
    window.add(dockPage);

    const dockGroup = new Adw.PreferencesGroup({
      title: 'Dock Settings',
      description: 'Configure the liquid glass effect for the Dash to Dock',
    });
    dockPage.add(dockGroup);

    // 有効化スイッチ
    this._addSwitchRow(dockGroup, settings, 'enable-dock-glass', 'Enable Glass Effect', 'Apply the effect to the dock');
    // 各種パラメータ
    this._addSliderRow(dockGroup, settings, 'dock-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(dockGroup, settings, 'dock-margin-bottom', 'Margin Bottom', 'Bottom spacing', -5, 30, 1);
    this._addColorRow(dockGroup, settings, 'dock-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(dockGroup, settings, 'dock-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const dockBlurRow = this._addSliderRow(dockGroup, settings, 'dock-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(dockBlurRow);
    this._addSliderRow(dockGroup, settings, 'dock-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // Advancedグループ (開閉可能)
    const dockAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    dockGroup.add(dockAdvanced);

    this._addSliderRow(dockAdvanced, settings, 'dock-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(dockAdvanced, settings, 'dock-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(dockAdvanced, settings, 'dock-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);

    // --- Popups タブ ---
    // One page for every popup surface. These used to be four pages carrying
    // four near-identical copies of the same settings; the shared popup-*
    // keys mean tuning the glass once applies to all of them.
    const popupPage = new Adw.PreferencesPage({
      title: 'Popups',
      icon_name: 'view-list-symbolic',
    });
    window.add(popupPage);

    const popupGroup = new Adw.PreferencesGroup({
      title: 'Popup Settings',
      description: 'Shared by the calendar menu, Quick Settings, notifications and OSDs. Turn individual surfaces on or off on the General page.',
    });
    popupPage.add(popupGroup);

    this._addSliderRow(popupGroup, settings, 'popup-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);

    this._addSwitchRow(popupGroup, settings, 'popup-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const popupSampleIntervalRow = this._addSliderRow(popupGroup, settings, 'popup-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    settings.bind('popup-enable-adaptive-text-color', popupSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addColorRow(popupGroup, settings, 'popup-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(popupGroup, settings, 'popup-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const popupBlurRow = this._addSliderRow(popupGroup, settings, 'popup-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(popupBlurRow);
    this._addSliderRow(popupGroup, settings, 'popup-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    const popupAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    popupGroup.add(popupAdvanced);

    this._addSliderRow(popupAdvanced, settings, 'popup-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(popupAdvanced, settings, 'popup-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(popupAdvanced, settings, 'popup-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);

    // The few things that genuinely differ per surface.
    const offsetsGroup = new Adw.PreferencesGroup({
      title: 'Per-popup Position',
      description: 'Fine positioning for individual surfaces.',
    });
    popupPage.add(offsetsGroup);

    const offsets = new Adw.ExpanderRow({
      title: 'Offsets',
      subtitle: 'Nudge individual popups into place'
    });
    offsetsGroup.add(offsets);

    this._addSliderRow(offsets, settings, 'menu-x-offset', 'Calendar Menu — X Offset', '', -200, 200, 1);
    this._addSliderRow(offsets, settings, 'menu-y-offset', 'Calendar Menu — Y Offset', '', -50, 100, 1);
    this._addSliderRow(offsets, settings, 'quick-settings-x-offset', 'Quick Settings — X Offset', '', -200, 200, 1);
    this._addSliderRow(offsets, settings, 'quick-settings-y-offset', 'Quick Settings — Y Offset', '', -50, 100, 1);
    this._addSliderRow(offsets, settings, 'notification-y-offset', 'Notifications — Y Offset', '', -50, 100, 1);
    this._addSliderRow(offsets, settings, 'osd-y-offset', 'OSD — Y Offset', '', -50, 100, 1);
    this._addSliderRow(offsets, settings, 'notification-hide-safety-margin', 'Notifications — Hide Safety Margin', '', 0, 40, 1);


    // --- Glass Properties タブ ---
    const shaderPage = new Adw.PreferencesPage({
      title: 'Glass',
      icon_name: 'image-adjust-shadows-symbolic',
    });
    window.add(shaderPage);

    const physGroup = new Adw.PreferencesGroup({ title: 'Physical &amp; Optical Properties' });
    shaderPage.add(physGroup);

    // Blur Method を選択する ComboRow を追加し、GSettingsにバインド
    const blurMethodRow = new Adw.ComboRow({
      title: 'Blur Method',
      model: Gtk.StringList.new([
        'Gaussian Blur (Recommended)',
        'Dual Kawase (Performance)'
      ])
    });
    this._addRowToContainer(physGroup, blurMethodRow);
    settings.bind('blur-method', blurMethodRow, 'selected', Gio.SettingsBindFlags.DEFAULT);

    this._addSliderRow(physGroup, settings, 'glass-max-z', 'Maximum Z Depth', 'Physical thickness of the glass', 0.0, 100.0, 1.0);
    this._addSliderRow(physGroup, settings, 'glass-displacement-scale', 'Displacement Scale', 'Strength of light refraction', 0.0, 200.0, 1.0);
    this._addSliderRow(physGroup, settings, 'glass-edge-smoothing', 'Edge Smoothing', 'Anti-aliasing feathering width', 0.0, 10.0, 0.1);
    this._addSliderRow(physGroup, settings, 'glass-profile-shape-n', 'Profile Shape N', 'Curvature shape of the surface', 1.0, 20.0, 0.1);
    this._addSliderRow(physGroup, settings, 'glass-ior', 'Index of Refraction', 'Optical density (1.5 - 2.4)', 1.0, 4.0, 0.01);
    this._addSliderRow(physGroup, settings, 'glass-chroma-strength', 'Chroma Strength', 'RGB color separation', 0.0, 0.1, 0.001);

    const lightGroup = new Adw.PreferencesGroup({ title: 'Lighting &amp; Reflections' });
    shaderPage.add(lightGroup);

    this._addSliderRow(lightGroup, settings, 'glass-specular-intensity', 'Specular Intensity', 'Brightness of highlights', 0.0, 5.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-shininess', 'Shininess', 'Sharpness of reflections', 1.0, 200.0, 1.0);
    this._addSliderRow(lightGroup, settings, 'glass-rim-width', 'Rim Width', 'Width of the edge lighting', 0.0, 20.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-intensity', 'Rim Intensity', 'Brightness of rim light', 0.0, 5.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-directional-power', 'Rim Directional Power', 'Light direction effect on rim', 0.0, 10.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-power', 'Rim Fresnel Power', 'Fresnel falloff for rim light', 0.0, 20.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-light-color-intensity', 'Rim Light Color Intensity', 'Multiplier for rim color', 0.0, 5.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-sheen-intensity', 'Sheen Intensity', 'Background sheen across surface', 0.0, 2.0, 0.01);
    this._addSliderRow(lightGroup, settings, 'glass-light-angle-deg', 'Light Angle (Deg)', 'Directional angle of light source', 0.0, 360.0, 1.0);

    const shadowGroup = new Adw.PreferencesGroup({
      title: 'Drop Shadow',
      description: 'Anchors the glass on light backgrounds (e.g. white wallpapers) so it does not visually disappear.'
    });
    shaderPage.add(shadowGroup);

    this._addSliderRow(shadowGroup, settings, 'shadow-radius', 'Shadow Radius (px)', 'How far the shadow extends past the glass edge. Set to 0 to disable.', 0.0, 100.0, 1.0);
    this._addSliderRow(shadowGroup, settings, 'shadow-intensity', 'Shadow Intensity', 'How dark the shadow is. 0 = invisible, 1 = pure black.', 0.0, 1.0, 0.01);

    const aoGroup = new Adw.PreferencesGroup({
      title: 'Inner Edge Darkening (AO)',
      description: 'A separate ambient-occlusion darkening just inside the glass edge, independent of the outer drop shadow above.'
    });
    shaderPage.add(aoGroup);

    this._addSliderRow(aoGroup, settings, 'glass-ao-intensity', 'AO Intensity', 'How dark the inner edge band gets. 0 = invisible, 1 = pure black.', 0.0, 1.0, 0.01);
    this._addSliderRow(aoGroup, settings, 'glass-ao-radius', 'AO Radius (px)', 'How far inward from the edge the darkening extends before fading out.', 0.0, 50.0, 0.5);

    const debugGroup = new Adw.PreferencesGroup({ title: 'Debug' });
    shaderPage.add(debugGroup);

    this._addSwitchRow(debugGroup, settings, 'output-logs', 'Output Logs', 'Output logs to the terminal');

    // Blur Methodの選択に応じて、各Blur Radiusの注釈（subtitle）を動的に切り替える処理
    const updateBlurSubtitles = () => {
      // get_int() が 1 (Dual Kawase) の時だけ注意書きを追加する
      const isDualKawase = settings.get_int('blur-method') === 1;
      const subtitle = isDualKawase
        ? 'Background blur intensity (Uses Dual Kawase blur; radius may not be pixel-accurate)'
        : 'Background blur intensity';

      // 登録しておいたすべての Blur Radius 行のサブタイトルを更新
      blurRadiusRows.forEach(row => {
        row.subtitle = subtitle;
      });
    };

    // 設定変更時のシグナル接続と、初期起動時の実行
    settings.connect('changed::blur-method', updateBlurSubtitles);
    updateBlurSubtitles();
  }

  // --- Backup & Restore ---

  // ボタン付きの行（Export / Import / Reset 用）
  _addButtonRow(container, title, subtitle, buttonLabel, destructive, onClicked) {
    const row = new Adw.ActionRow({ title, subtitle });
    const button = new Gtk.Button({
      label: buttonLabel,
      valign: Gtk.Align.CENTER,
    });
    if (destructive) button.add_css_class('destructive-action');
    button.connect('clicked', onClicked);
    row.add_suffix(button);
    row.activatable_widget = button;
    this._addRowToContainer(container, row);
    return row;
  }

  _toast(window, message) {
    // Adw.PreferencesWindow/Dialog both expose add_toast in the versions we
    // target, but fall back to a log line rather than throwing if it is absent.
    try {
      if (typeof window.add_toast === 'function') {
        window.add_toast(new Adw.Toast({ title: message, timeout: 3 }));
        return;
      }
    } catch (e) { }
    console.log(`[Liquid Glass] ${message}`);
  }

  /**
   * Serialises every key in the schema as its GVariant text form, which
   * round-trips exactly and keeps the type legible in the saved file.
   */
  _exportSettings(settings, window) {
    const dialog = new Gtk.FileDialog({
      title: 'Export Liquid Glass Settings',
      initial_name: 'liquid-glass-settings.json',
      modal: true,
    });

    dialog.save(window, null, (source, result) => {
      let file;
      try {
        file = source.save_finish(result);
      } catch (e) {
        // The user dismissed the dialog — not an error worth reporting.
        return;
      }
      if (!file) return;

      try {
        const payload = {
          schema: SCHEMA_ID,
          version: BACKUP_VERSION,
          keys: {},
        };
        for (const key of settings.settings_schema.list_keys())
          payload.keys[key] = settings.get_value(key).print(true);

        const text = JSON.stringify(payload, null, 2);
        file.replace_contents(
          new TextEncoder().encode(text), null, false,
          Gio.FileCreateFlags.REPLACE_DESTINATION, null
        );
        this._toast(window, `Exported ${Object.keys(payload.keys).length} settings`);
      } catch (e) {
        this._toast(window, `Export failed: ${e.message ?? e}`);
      }
    });
  }

  _importSettings(settings, window) {
    const dialog = new Gtk.FileDialog({
      title: 'Import Liquid Glass Settings',
      modal: true,
    });

    dialog.open(window, null, (source, result) => {
      let file;
      try {
        file = source.open_finish(result);
      } catch (e) {
        return; // dismissed
      }
      if (!file) return;

      try {
        const [ok, bytes] = file.load_contents(null);
        if (!ok) throw new Error('could not read the file');

        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if (!payload || typeof payload !== 'object' || !payload.keys)
          throw new Error('not a Liquid Glass settings file');
        if (payload.schema && payload.schema !== SCHEMA_ID)
          throw new Error('this file belongs to a different extension');

        const schema = settings.settings_schema;
        let applied = 0;
        let skipped = 0;

        // Batch the whole import into a single changeset. Without this, each
        // key fires its own changed:: signal and the running shell rebuilds
        // shader state ~80 times in a row.
        //
        // delay() is used on a throwaway Gio.Settings rather than the one the
        // widgets are bound to: there is no API to leave delay-apply mode, so
        // delaying the shared instance would silently swallow every later edit
        // the user makes in this window.
        const writer = this.getSettings(SCHEMA_ID);
        writer.delay();
        try {
          for (const [key, text] of Object.entries(payload.keys)) {
            if (!schema.has_key(key)) { skipped++; continue; }
            try {
              // Parse against the live schema's type, so a corrupt or
              // hand-edited file cannot write the wrong type into a key.
              const expectedType = settings.get_value(key).get_type();
              const variant = GLib.Variant.parse(expectedType, text, null, null);
              writer.set_value(key, variant);
              applied++;
            } catch (e) {
              skipped++;
            }
          }
          writer.apply();
        } catch (e) {
          writer.revert();
          throw e;
        }

        const detail = skipped > 0 ? `, ${skipped} skipped` : '';
        this._toast(window, `Imported ${applied} settings${detail}`);
      } catch (e) {
        this._toast(window, `Import failed: ${e.message ?? e}`);
      }
    });
  }

  _confirmResetSettings(settings, window) {
    const dialog = new Adw.AlertDialog({
      heading: 'Reset all settings?',
      body: 'Every Liquid Glass customisation returns to its default value. This cannot be undone — export a backup first if you want to keep the current look.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('reset', 'Reset');
    dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');

    dialog.connect('response', (_d, response) => {
      if (response !== 'reset') return;
      try {
        settings.delay();
        for (const key of settings.settings_schema.list_keys())
          settings.reset(key);
        settings.apply();
        this._toast(window, 'All settings reset to defaults');
      } catch (e) {
        try { settings.revert(); } catch (_) { }
        this._toast(window, `Reset failed: ${e.message ?? e}`);
      }
    });

    dialog.present(window);
  }

  // --- 便利メソッド群 ---

  _addRowToContainer(container, row) {
    if (container.add_row) {
      container.add_row(row);
    } else {
      container.add(row);
    }
  }

  // ON/OFFスイッチ
  _addSwitchRow(container, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({ title, subtitle });
    this._addRowToContainer(container, row);
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // スライダーと標準のスピンボタン（+/-）を配置するメソッド
  _addSliderRow(container, settings, key, title, subtitle, min, max, step) {
    const row = new Adw.ActionRow({ title, subtitle });

    // 小数点のステップ数に応じて入力欄の表示桁数を自動判定
    let digits = 0;
    if (step < 1) digits = 2;
    if (step < 0.01) digits = 3;

    // スライダーとスピンボタンで共有する Adjustment
    const adjustment = new Gtk.Adjustment({
      lower: min,
      upper: max,
      step_increment: step
    });

    // 1. スライダー (Gtk.Scale) の生成
    const scale = Gtk.Scale.new(Gtk.Orientation.HORIZONTAL, adjustment);
    scale.set_hexpand(true);
    scale.set_valign(Gtk.Align.CENTER);
    scale.set_draw_value(false);
    scale.set_size_request(160, -1); // 最低限の横幅

    // 2. 標準の数値入力＆上下ボタン (Gtk.SpinButton) の生成
    const spinButton = new Gtk.SpinButton({
      adjustment: adjustment,
      climb_rate: step,
      digits: digits,
      numeric: true,
      valign: Gtk.Align.CENTER,
    });

    // スライダーとスピンボタンを並べるコンテナ
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      valign: Gtk.Align.CENTER
    });
    box.append(scale);
    box.append(spinButton);

    row.add_suffix(box);
    this._addRowToContainer(container, row);

    // 設定とAdjustmentをバインド（これだけで両方が連動して保存・読み込みされます）
    settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

    return row;
  }

  // 数値入力（整数・小数両対応）※念のため維持
  _addSpinRow(container, settings, key, title, subtitle, min, max, step) {
    let digits = 0;
    if (step < 1) digits = 2;
    if (step < 0.01) digits = 3;
    const row = new Adw.SpinRow({
      title,
      subtitle,
      adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
      digits: digits,
    });
    this._addRowToContainer(container, row);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // 色選択
  _addColorRow(container, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({ title, subtitle });
    const colorButton = new Gtk.ColorDialogButton({
      valign: Gtk.Align.CENTER,
      dialog: new Gtk.ColorDialog(),
    });

    // 保存されたHEX文字列をRGBAに変換してセット
    const rgba = new Gdk.RGBA();
    rgba.parse(settings.get_string(key));
    colorButton.rgba = rgba;

    // 色が変わったらHEXに変換して保存
    colorButton.connect('notify::rgba', () => {
      const color = colorButton.rgba;
      const r = Math.floor(color.red * 255).toString(16).padStart(2, '0');
      const g = Math.floor(color.green * 255).toString(16).padStart(2, '0');
      const b = Math.floor(color.blue * 255).toString(16).padStart(2, '0');
      const hex = `#${r}${g}${b}`;

      settings.set_string(key, hex);
    });

    row.add_suffix(colorButton);
    this._addRowToContainer(container, row);
  }
}
