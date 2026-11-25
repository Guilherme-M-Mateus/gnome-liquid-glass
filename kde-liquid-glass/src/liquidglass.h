/*
    Liquid Glass for KWin — forked from KWin's blur effect (KWin 6.8).

    SPDX-FileCopyrightText: 2010 Fredrik Höglund <fredrik@kde.org>
    SPDX-FileCopyrightText: 2018 Alex Nemeth <alex.nemeth329@gmail.com>

    SPDX-License-Identifier: GPL-2.0-or-later
*/

#pragma once

#include "effect/effect.h"
#include "opengl/glutils.h"
#include "scene/item.h"

#include <QList>

#include <unordered_map>

namespace KWin
{

class BackgroundEffectItem;

struct GlassRenderData
{
    /// Dual Kawase render targets; textures[0] holds the unblurred background.
    std::vector<std::unique_ptr<GLTexture>> textures;
    std::vector<std::unique_ptr<GLFramebuffer>> framebuffers;
};

struct GlassEffectData
{
    std::optional<RegionF> content;
    std::optional<RegionF> frame;
    std::unordered_map<RenderView *, GlassRenderData> render;
    std::unique_ptr<BackgroundEffectItem> blurItem;
};

class LiquidGlassEffect : public KWin::Effect
{
    Q_OBJECT

public:
    LiquidGlassEffect();
    ~LiquidGlassEffect() override;

    static bool supported();

    void reconfigure(ReconfigureFlags flags) override;
    void prePaintScreen(ScreenPrePaintData &data) override;
    bool drawWindow(const RenderTarget &renderTarget, const RenderViewport &viewport, EffectWindow *w, int mask, const Region &deviceRegion, WindowPaintData &data) override;

    bool provides(Feature feature) override;
    bool isActive() const override;

    int requestedEffectChainPosition() const override
    {
        return 20;
    }

    bool eventFilter(QObject *watched, QEvent *event) override;

    bool blocksDirectScanout() const override;

public Q_SLOTS:
    void slotWindowAdded(KWin::EffectWindow *w);
    void slotWindowDeleted(KWin::EffectWindow *w);
    void slotViewRemoved(KWin::RenderView *view);
#if KWIN_BUILD_X11
    void slotPropertyNotify(KWin::EffectWindow *w, long atom);
#endif
    void setupDecorationConnections(EffectWindow *w);

private:
    void initBlurStrengthValues();
    RegionF blurRegion(EffectWindow *w) const;
    RegionF decorationBlurRegion(const EffectWindow *w) const;
    bool decorationSupportsBlurBehind(const EffectWindow *w) const;
    bool shouldBlur(const EffectWindow *w, int mask, const WindowPaintData &data) const;
    void updateBlurRegion(EffectWindow *w);
    void blur(const RenderTarget &renderTarget, const RenderViewport &viewport, EffectWindow *w, int mask, const Region &deviceRegion, WindowPaintData &data);

private:
    struct
    {
        std::unique_ptr<GLShader> shader;
        int mvpMatrixLocation;
        int offsetLocation;
        int halfpixelLocation;
    } m_downsamplePass;

    struct
    {
        std::unique_ptr<GLShader> shader;
        int mvpMatrixLocation;
        int offsetLocation;
        int halfpixelLocation;
    } m_upsamplePass;

    struct
    {
        std::unique_ptr<GLShader> shader;
        int mvpMatrixLocation;
        int resolutionLocation;
        int refResolutionLocation;
        int boxCenterLocation;
        int boxHalfSizeLocation;
        int opacityLocation;
        int cornerRadiusLocation;
        int tintLocation;
        int sharpLocation;
    } m_glassPass;

    /// Scalar shader uniforms read straight from kwinrc [Effect-liquidglass]: {config key, uniform, default}.
    struct FloatParam
    {
        const char *key;
        const char *uniform;
        float defaultValue;
        float value = 0;
        int location = -1;
    };
    std::vector<FloatParam> m_params;
    float m_cornerRadius = 26.0;
    bool m_pillPanels = true;
    float m_notificationCornerRadius = 16.0;
    QVector3D m_tint{1, 1, 1};

    bool m_valid = false;
#if KWIN_BUILD_X11
    long net_wm_blur_region = 0;
#endif
    RenderView *m_currentView = nullptr;

    size_t m_iterationCount;
    int m_offset;
    int m_expandSize;

    struct OffsetStruct
    {
        float minOffset;
        float maxOffset;
        int expandSize;
    };
    QList<OffsetStruct> blurOffsets;

    struct BlurValuesStruct
    {
        int iteration;
        float offset;
    };
    QList<BlurValuesStruct> blurStrengthValues;

    QMap<EffectWindow *, QMetaObject::Connection> windowBlurChangedConnections;
    std::unordered_map<EffectWindow *, GlassEffectData> m_windows;
};

inline bool LiquidGlassEffect::provides(Effect::Feature feature)
{
    if (feature == Blur) {
        return true;
    }
    return KWin::Effect::provides(feature);
}

} // namespace KWin
