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

// Bump the normal by a height field's screen-space slope (dHdxy),
// the same way three's bumpMap does, without needing a texture.
vec3 sr2Perturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos));
  vec3 sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`
