// ============================================================
//  TUNNEL LIGHT - how a surface goes dark inside a tunnel
// ------------------------------------------------------------
//  The world has one shadow map, and only near the car at sundown,
//  so the sun and the sky would shine straight through a tunnel's
//  roof onto the road inside. Instead, every surface inside a tunnel
//  carries a "cover" value per vertex (aCover: 0 in the open, rising
//  to 1 over the first 30 m inside each portal, src/track/tunnels.ts)
//  and its shader turns the outdoor light down by it:
//
//    - the key light (the sun at sundown, the planet's glow at night)
//      is gone inside
//    - the sky's fill light (hemisphere) and its reflection in the wet
//      road (the environment map) drop to a faint trace
//    - the haze fades out (no pink fog filling a deep mouth)
//
//  The car's headlights are left alone: inside a tunnel they, and the
//  glowing strips on its walls, are the light. Used by the road
//  material (roadMaterial.ts) and the tunnel's walls (tunnelMaterial.ts).
// ============================================================

/** How much of the sky's fill light still reaches a fully covered surface. */
export const TUNNEL_SKY_LEFT = 0.1
/** How much of the sky's reflection still shows in a fully covered surface. */
export const TUNNEL_REFLECT_LEFT = 0.05

export const COVER_VERTEX_PARS = /* glsl */ `
attribute float aCover;
varying float vCover;
`
export const COVER_VERTEX_MAIN = /* glsl */ `
vCover = clamp(aCover, 0.0, 1.0);
`
export const COVER_FRAGMENT_PARS = /* glsl */ `
varying float vCover;
`

/** Marks round the key light in three's lights_fragment_begin chunk (the sun and directional lights). */
export const KEY_START = '#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )'
export const KEY_END = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )'

/** Before the key light: remember the light so far (the headlights, lit first). */
export const COVER_KEY_BEFORE = /* glsl */ `
vec3 sr2DiffBeforeKey = reflectedLight.directDiffuse;
vec3 sr2SpecBeforeKeyC = reflectedLight.directSpecular;
`
/** After the key light: what it added fades out with the cover. */
export const COVER_KEY_AFTER = /* glsl */ `
reflectedLight.directDiffuse = sr2DiffBeforeKey + (reflectedLight.directDiffuse - sr2DiffBeforeKey) * (1.0 - vCover);
reflectedLight.directSpecular = sr2SpecBeforeKeyC + (reflectedLight.directSpecular - sr2SpecBeforeKeyC) * (1.0 - vCover);
`

/** Just before lights_fragment_end: the sky's fill and reflection drop to a trace with the cover. */
export const COVER_INDIRECT = /* glsl */ `
#if defined( RE_IndirectDiffuse )
  irradiance *= mix(1.0, ${TUNNEL_SKY_LEFT.toFixed(3)}, vCover);
  iblIrradiance *= mix(1.0, ${TUNNEL_SKY_LEFT.toFixed(3)}, vCover);
#endif
#if defined( RE_IndirectSpecular )
  radiance *= mix(1.0, ${TUNNEL_REFLECT_LEFT.toFixed(3)}, vCover);
  clearcoatRadiance *= mix(1.0, ${TUNNEL_REFLECT_LEFT.toFixed(3)}, vCover);
#endif
`

/** three's fog, faded out with the cover (replaces #include <fog_fragment>). */
export const COVER_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * (1.0 - vCover) );
#endif
`

/**
 * three's lights_fragment_begin with the key light's share faded by the cover. `extraBefore`
 * and `extraAfter` go round the key light too (the road keeps only part of its highlight).
 * Returns null if three's chunk no longer has the marks (then the caller logs it).
 */
export function coverLightsBegin(chunk: string, extraBefore = '', extraAfter = ''): string | null {
  if (!chunk.includes(KEY_START) || !chunk.includes(KEY_END)) return null
  return chunk.replace(KEY_START, `${COVER_KEY_BEFORE}${extraBefore}\n${KEY_START}`).replace(KEY_END, `${extraAfter}\n${COVER_KEY_AFTER}\n${KEY_END}`)
}
