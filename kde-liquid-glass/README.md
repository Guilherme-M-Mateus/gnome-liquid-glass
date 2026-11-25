# Liquid Glass for KDE Plasma 6

A KWin effect that brings the liquid glass shader from the GNOME extension to Plasma,
plus a matching Plasma Style that makes panels and popups see-through so the glass shows.

### Demo

Overview:

![Overview](../assets/kde/overview.png)

Dock (floating panel with Icons-only Task Manager):

![Dock](../assets/kde/dock.png)

Notifications:

![Notification](../assets/kde/notification.png)

Panel popups (Digital Clock):

![Calendar popup](../assets/kde/calendar.png)

System Tray (the Plasma counterpart of Quick Settings):

![System Tray](../assets/kde/system-tray.png)

OSD:

![Volume OSD](../assets/kde/osd.png)

All six are real screenshots: Plasma 6.8.3 with the Breeze Dark colours, the "Next"
wallpaper, and this effect and Plasma Style at their default settings.

## How it works

It is a fork of KWin's built-in **Blur** effect. Every surface that asks KWin for blur
already gets the glass, with no per-app setup: panels, popups, notifications, OSDs,
KRunner, and translucent apps and decorations. KWin's background capture and dual-Kawase
blur are kept as they are. The final composite pass is the GNOME shader
(`src/shaders/glass.frag`), ported to KWin: superellipse height profile, Snell
refraction, chromatic aberration, rim, specular and sheen lighting, and inner AO.

It is a replacement for Blur, so turn Blur off when you turn this on.

## Requirements

KWin / Plasma **6.8** (built against 6.8.3) on OpenGL compositing. KWin effects are
compiled against KWin's internal API, so rebuild after every Plasma update.

Build dependencies:

- Arch: `kwin extra-cmake-modules cmake ninja`
- Fedora: `kwin-devel extra-cmake-modules`
- Debian/Ubuntu: `kwin-dev extra-cmake-modules`

## Install

```bash
cd kde-liquid-glass
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr
cmake --build build
sudo cmake --install build
kwriteconfig6 --file kwinrc --group Plugins --key blurEnabled false
kwriteconfig6 --file kwinrc --group Plugins --key liquidglassEnabled true
qdbus6 org.kde.KWin /KWin reconfigure
```

You can also toggle it in *System Settings → Desktop Effects → Liquid Glass*.

Then install the **Liquid Glass Plasma Style**. Breeze's panel and popup backgrounds are
about 85% opaque and hide most of the glass. This style is Breeze with those backgrounds
at 18%, and it turns off the background-contrast pass that would darken the glass.
Everything else falls back to Breeze.

```bash
mkdir -p ~/.local/share/plasma/desktoptheme
cp -r plasma-style/liquid-glass ~/.local/share/plasma/desktoptheme/
plasma-apply-desktoptheme liquid-glass
```

The style works with both Breeze and Breeze Dark colours. To get the layout in the
screenshots, use a floating top panel (Application Launcher, spacer, Digital Clock, spacer,
System Tray) and a floating bottom panel set to *Fit content* with the *Icons-only Task
Manager*.

To uninstall, turn Blur back on, switch the Plasma Style back to Breeze, and delete
`/usr/lib/qt6/plugins/kwin/effects/plugins/liquidglass.so` and
`~/.local/share/plasma/desktoptheme/liquid-glass`.

## Settings

There is no settings UI yet. All settings go in `kwinrc` under `[Effect-liquidglass]`. The
defaults match the GNOME extension's defaults. For example:

```bash
kwriteconfig6 --file kwinrc --group Effect-liquidglass --key CornerRadius 20
qdbus6 org.kde.KWin /KWin reconfigure
```

| Key | Default | |
|---|---|---|
| BlurStrength | 5 | 1–15, same scale as KWin Blur |
| CornerRadius | 12 | px; a window's own rounded corners win if it has them |
| TintColor | #ffffff | |
| TintStrength | 0.12 | |
| MaxZ | 25 | glass thickness |
| DisplacementScale | 78.5 | refraction strength |
| IOR | 2.4 | |
| ProfileShapeN | 7 | edge curvature (superellipse n) |
| EdgeSmoothing | 2 | |
| ChromaStrength | 0.006 | chromatic aberration |
| RimWidth / RimIntensity / RimPower / RimDirectionalPower / RimLightColorIntensity | 5 / 0.6 / 6 / 2.7 / 1.4 | |
| SpecularIntensity / Shininess | 0 / 42 | |
| SheenIntensity | 0.32 | |
| AOIntensity / AORadius | 0.25 / 7.5 | |
| LightAngle | 50 | degrees |
| Brightness / Contrast / Saturation | 1 / 1 / 1 | |

## Not ported (yet)

- **Drop shadow:** KWin only lets the effect paint inside the blur region, and Plasma
  themes already draw shadows.
- **Adaptive text colour:** Plasma themes handle contrast themselves.
- **GNOME panel and dock layout options** (floating pill and so on): use Plasma's own
  floating panel.
- **Refraction across the glass edge:** the effect only captures what is behind the
  glass, so refraction near the edges clamps instead of pulling in pixels from outside.

## License

GPL-2.0-or-later, because it is derived from KWin. The rest of this repository stays MIT.
