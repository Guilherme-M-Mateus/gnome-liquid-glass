#version 140
// Liquid glass composite pass for KWin.
// Port of the Three.js prototype (prototypes/sandbox-threejs/src/shaders/glass.frag):
// one superellipse dome over the whole shape, Snell refraction, chromatic
// aberration and additive rim / specular / sheen lighting. The drop shadow is dropped:
// KWin only lets us paint inside the blur region, and Plasma themes draw their
// own shadows anyway.

uniform sampler2D texUnit;   // dual-Kawase blurred background behind the glass

uniform vec2 resolution;     // size of the captured background, logical px
uniform vec2 refResolution;  // output size; optical constants are tuned against it
uniform vec2 boxCenter;      // glass rect, logical px, top-left origin
uniform vec2 boxHalfSize;
uniform float opacity;

uniform float corner_radius;
uniform float max_z;
uniform float displacement_scale;
uniform float edge_smoothing;
uniform float profile_shape_n;
uniform float bezel_width;   // px over which the glass rises; flat beyond it
uniform float ior;
uniform float chroma_strength;
uniform float tint_strength;
uniform vec3 tint;
uniform float specular_intensity;
uniform float rim_width;
uniform float rim_intensity;
uniform float rim_directional_power;
uniform float rim_power;
uniform float rim_light_color_intensity;
uniform float sheen_intensity;
uniform float shininess;
uniform float light_angle_deg;
uniform float brightness;
uniform float contrast;
uniform float saturation;

in vec2 uv;
out vec4 fragColor;

// KWin texcoords have v=1 at the top; the math below uses a top-left origin
// like Cogl, so flip once on the way in and once per texture fetch.
vec3 fetch(vec2 st)
{
    return texture(texUnit, vec2(st.x, 1.0 - st.y)).rgb;
}

float sdRoundRect(vec2 p, vec2 b, float r)
{
    vec2 d = abs(p) - b + vec2(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}

float profileHeight(float t, float zScale)
{
    float n = max(profile_shape_n, 1.01);
    float invT = clamp(1.0 - t, 0.0, 1.0);
    float inner = max(1.0 - pow(invT, n), 0.0);
    return pow(inner, 1.0 / n) * zScale;
}

float getHeight(vec2 p, vec2 b, float r, float zScale)
{
    float d = sdRoundRect(p, b, r);
    float smoothZone = max(edge_smoothing, 1.0);
    if (d > smoothZone)
        return 0.0;
    // A bezel of bezel_width px, capped at a full dome for thin shapes like pill panels.
    float maxDepth = max(min(bezel_width, -sdRoundRect(vec2(0.0), b, r)), 1.0);
    float t = clamp(max(-d, 0.0) / maxDepth, 0.0, 1.0);
    float fade = 1.0 - smoothstep(-smoothZone, smoothZone, d);
    return profileHeight(t, zScale) * fade;
}

vec2 heightGradient(vec2 p, vec2 b, float r, float zScale, vec2 res)
{
    float minRes = max(min(res.x, res.y), 1.0);
    float e = clamp(minRes / 560.0, 0.45, 1.20);
    float hR = getHeight(p + vec2(e, 0.0), b, r, zScale);
    float hL = getHeight(p - vec2(e, 0.0), b, r, zScale);
    float hB = getHeight(p + vec2(0.0, e), b, r, zScale);
    float hT = getHeight(p - vec2(0.0, e), b, r, zScale);
    return vec2((hR - hL) / (2.0 * e), (hB - hT) / (2.0 * e));
}

// Displacement in logical pixels. The GNOME version returns it in UV of a
// full-monitor FBO; multiplying by refResolution keeps the same look while our
// texture only covers the glass itself.
vec2 getDisplacementPx(float d, vec3 normal)
{
    if (d > 0.0)
        return vec2(0.0);
    vec3 refractedRay = refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / max(ior, 1.001));
    if (length(refractedRay) < 0.0001)
        return vec2(0.0);
    float minRes = max(min(refResolution.x, refResolution.y), 1.0);
    float safe_z = max(-refractedRay.z, 0.15);
    vec2 disp = (refractedRay.xy / safe_z) * (displacement_scale / minRes);
    if (length(disp) > 0.30)
        disp = normalize(disp) * 0.30;
    return disp * refResolution;
}

vec2 stabilizedUV(vec2 candidate, vec2 fallback)
{
    vec2 clamped = clamp(candidate, vec2(0.001), vec2(0.999));
    float edgeDist = min(min(candidate.x, candidate.y), min(1.0 - candidate.x, 1.0 - candidate.y));
    return mix(fallback, clamped, smoothstep(-0.04, 0.03, edgeDist));
}

vec3 applySCB(vec3 color, float b, float c, float s)
{
    color *= b;
    color = mix(vec3(0.5), color, c);
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    return max(mix(vec3(luma), color, s), 0.0);
}

void main()
{
    vec2 st = vec2(uv.x, 1.0 - uv.y);
    vec2 local_pos = st * resolution - boxCenter;
    float r = min(corner_radius, min(boxHalfSize.x, boxHalfSize.y));
    float edgeFeather = max(edge_smoothing, 0.75);

    float d = sdRoundRect(local_pos, boxHalfSize, r);
    float insideMask = 1.0 - smoothstep(-edgeFeather, edgeFeather, d);
    if (insideMask <= 0.0) {
        fragColor = vec4(0.0);
        return;
    }

    vec3 normal = normalize(vec3(-heightGradient(local_pos, boxHalfSize, r, max_z, refResolution), 1.0));
    float edgeDampen = smoothstep(0.0, edgeFeather * 3.0, -d);
    vec2 disp = getDisplacementPx(d, normal) * edgeDampen / resolution;
    vec2 refractedUv = stabilizedUV(st + disp, st);

    float minRes = max(min(refResolution.x, refResolution.y), 1.0);
    vec2 chromaDir = length(disp) > 0.00001 ? normalize(disp) : vec2(0.0);
    vec2 chromaVec = chromaDir * (chroma_strength / minRes) * refResolution / resolution * edgeDampen;
    vec2 uvR = stabilizedUV(refractedUv + chromaVec, refractedUv);
    vec2 uvG = refractedUv;
    vec2 uvB = stabilizedUV(refractedUv - chromaVec, refractedUv);

    // Rotated-grid 4-tap supersample, wider near the rim where refraction is steep.
    float edgeProximity = 1.0 - smoothstep(0.0, edgeFeather * 4.0, -d);
    vec2 texel = vec2(mix(0.75, 2.5, edgeProximity)) / resolution;
    vec2 o1 = vec2(0.375, -0.125) * texel;
    vec2 o2 = vec2(0.125, 0.375) * texel;
    vec2 o3 = vec2(-0.375, 0.125) * texel;
    vec2 o4 = vec2(-0.125, -0.375) * texel;
    vec2 margin = vec2(1.2) / resolution;
#define SAFE(u) clamp(u, margin, 1.0 - margin)
    vec3 refracted;
    if (length(chromaVec * resolution) < 0.5) {
        refracted = (fetch(SAFE(uvG + o1)) + fetch(SAFE(uvG + o2)) + fetch(SAFE(uvG + o3)) + fetch(SAFE(uvG + o4))) * 0.25;
    } else {
        refracted = vec3(
            fetch(SAFE(uvR + o1)).r + fetch(SAFE(uvR + o2)).r + fetch(SAFE(uvR + o3)).r + fetch(SAFE(uvR + o4)).r,
            fetch(SAFE(uvG + o1)).g + fetch(SAFE(uvG + o2)).g + fetch(SAFE(uvG + o3)).g + fetch(SAFE(uvG + o4)).g,
            fetch(SAFE(uvB + o1)).b + fetch(SAFE(uvB + o2)).b + fetch(SAFE(uvB + o3)).b + fetch(SAFE(uvB + o4)).b) * 0.25;
    }

    vec3 baseColor = mix(applySCB(refracted, brightness, contrast, saturation), tint, tint_strength);

    float lightAngleRad = radians(light_angle_deg);
    vec3 lightDir = normalize(vec3(cos(lightAngleRad), -sin(lightAngleRad), 0.38)); // y up, as in the prototype
    vec3 viewDir = vec3(0.0, 0.0, 1.0);

    float edgeBand = 1.0 - smoothstep(0.0, rim_width, abs(d));
    float rimFresnel = pow(max(1.0 - max(dot(normal, viewDir), 0.0), 0.0), max(rim_power, 0.001));
    // Full highlight on the edge facing the light, a faint one opposite; no all-round outline.
    float facing = dot(normal.xy, lightDir.xy) / max(length(normal.xy) * length(lightDir.xy), 1e-4);
    float lightMask = pow(max(facing, 0.0), max(rim_directional_power, 1.0)) + 0.25 * pow(max(-facing, 0.0), max(rim_directional_power, 1.0));
    float rimShape = mix(pow(edgeBand, 0.85), rimFresnel, 0.55);
    float rimLight = rimShape * lightMask * rim_intensity * rim_light_color_intensity;

    float specular = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), max(shininess, 1.0)) * specular_intensity;
    specular *= mix(0.25, 1.0, insideMask) * clamp(edgeBand + insideMask * 0.65, 0.0, 1.0);

    float sheen = pow(max(dot(normal, lightDir), 0.0), 1.65) * mix(1.0, 0.55, edgeBand) * sheen_intensity;

    vec3 lit = clamp(baseColor + vec3(specular + rimLight + edgeBand * 0.008 + sheen), 0.0, 1.0);

    // Premultiplied output.
    fragColor = vec4(lit * insideMask, insideMask) * opacity;
}
