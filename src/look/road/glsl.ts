// ============================================================
//  SHARED GLSL - small shader helpers the road materials use
// ------------------------------------------------------------
//  Lines on the road are drawn with maths, not textures, so they
//  stay crisp at any distance. The trick is "analytic
//  anti-aliasing": fwidth() tells the shader how many metres one
//  screen pixel covers right here, and every line is softened by
//  exactly that much. Far away, where a line is thinner than a
//  pixel, it is drawn one pixel wide but dimmer (same total light),
//  so it never flickers or breaks into dashes.
//
//  It also holds the "never-NaN" helpers every road surface ends
//  with (sr2SafeLight and friends, see GitHub issue #2).
// ============================================================

export const ROAD_GLSL = /* glsl */ `
// Coverage (0..1) of a line of half-width hw centred on x = 0.
// w = metres per pixel here (fwidth). Never thinner than a pixel:
// below that it widens to a pixel and dims to keep the same light.
float sr2Line(float x, float hw, float w) {
  float hwPx = max(hw, w * 0.5);
  float cov = 1.0 - smoothstep(hwPx - w * 0.5, hwPx + w * 0.5, abs(x));
  return cov * (hw / hwPx);
}

// A row of dashes along s: on for duty*period, off for the rest,
// box-filtered over the pixel footprint w (no moire far away).
float sr2Dashes(float s, float period, float duty, float w) {
  float x = s / period;
  float fw = max(w / period, 1e-4);
  float a = x - fw * 0.5;
  float b = x + fw * 0.5;
  float fa = floor(a) * duty + min(fract(a), duty);
  float fb = floor(b) * duty + min(fract(b), duty);
  return clamp((fb - fa) / fw, 0.0, 1.0);
}

// Cheap hash + value noise. Lattice coordinates are wrapped so huge
// distances along the road never lose float precision.
float sr2Hash(vec2 p) {
  p = mod(p, 1024.0);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float sr2Noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sr2Hash(i);
  float b = sr2Hash(i + vec2(1.0, 0.0));
  float c = sr2Hash(i + vec2(0.0, 1.0));
  float d = sr2Hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The same kind of value noise, smoother (quintic fade, so its slope has no
// creases at the lattice lines), returning (value, d/dp.x, d/dp.y). The slope
// is exact maths, not a screen-space derivative: a normal built from dFdx of
// noise is constant over each 2x2 pixel block and shows as a brick pattern
// in a mirror-wet reflection.
vec3 sr2NoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = sr2Hash(i);
  float b = sr2Hash(i + vec2(1.0, 0.0));
  float c = sr2Hash(i + vec2(0.0, 1.0));
  float d = sr2Hash(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  float v = a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y;
  return vec3(v, du.x * (b - a + k * u.y), du.y * (c - a + k * u.x));
}

// ---- never-NaN maths (GitHub issue #2: flickering dots on the road) ----
// NaN means "not a number": what a GPU returns for maths with no answer, like
// normalize() of a zero-length arrow or pow() of a negative number. One NaN
// pixel looks like nothing, but min(NaN, cap) gives back the cap on Windows
// and Mac GPUs alike, so the road's brightness cap used to turn every NaN into
// a white-hot pixel, and bloom spread it into a flickering dot.

// The NaN counter (__dev.nancheck) sets this to a marker value while it draws
// its test picture, so it can count the NaNs the road caught. In the game it
// is 0: a NaN pixel draws black, invisible on the dark glass road.
uniform float uSr2NanTag;

// True for NaN. Tested on the number's bits (all exponent bits set, fraction
// not zero), because a shader compiler may "optimise" isnan() away.
bool sr2IsNan(float x) {
  return (floatBitsToUint(x) & 0x7fffffffu) > 0x7f800000u;
}

// The last step for every road surface's light: NaN becomes uSr2NanTag,
// Infinity and anything too bright becomes the cap, and light is never negative.
vec3 sr2SafeLight(vec3 c, float cap) {
  if (sr2IsNan(c.r) || sr2IsNan(c.g) || sr2IsNan(c.b)) return vec3(uSr2NanTag);
  return clamp(c, vec3(0.0), vec3(cap));
}

// normalize() that can't return NaN: a zero-length arrow gives the fallback.
vec3 sr2SafeNormalize(vec3 v, vec3 fallback) {
  float l2 = dot(v, v);
  return l2 > 1e-30 ? v * inversesqrt(l2) : fallback;
}

// How square-on this face is to the camera: 1 straight on, 0 edge-on. Built
// from screen derivatives, so it is exact for the face whatever the mesh's
// normal says. Clamped, so (1.0 - facing) never dips below zero from rounding
// (pow() of that would be NaN), and an edge-on face gives 0, not NaN.
// Call it outside any if() or loop (see sr2PerturbD).
float sr2Facing(vec3 viewPos) {
  vec3 c = cross(dFdx(viewPos), dFdy(viewPos));
  float l2 = dot(c, c) * dot(viewPos, viewPos);
  return l2 > 1e-30 ? clamp(abs(dot(c, viewPos)) * inversesqrt(l2), 0.0, 1.0) : 0.0;
}

// Bump the normal by a height field's screen-space slope (dHdxy), the same
// way three's bumpMap does, without needing a texture. dPdx and dPdy are the
// surface position's screen derivatives (dFdx / dFdy of -vViewPosition), taken
// by the caller OUTSIDE any if() or loop: derivatives inside a branch only some
// pixels of a 2x2 block take are undefined, and on Windows (Direct3D) GPUs they
// can come back as garbage.
vec3 sr2PerturbD(vec3 dPdx, vec3 dPdy, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = sr2SafeNormalize(dPdx, vec3(0.0));
  vec3 sy = sr2SafeNormalize(dPdy, vec3(0.0));
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return sr2SafeNormalize(abs(det) * surfNorm - grad, surfNorm);
}
`

/**
 * The value of uSr2NanTag, shared by every road-group material (road, slab
 * sides, ramps, barriers). 0 in the game; __dev.nancheck sets NAN_TAG_MARK for
 * the one frame it draws, so NaNs the road caught become countable pixels.
 */
export const NAN_TAG = { value: 0 }
/** The marker nancheck looks for (negative: no real light is ever negative). */
export const NAN_TAG_MARK = -4242
