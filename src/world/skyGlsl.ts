// ============================================================
//  SKY GLSL - the sky's colour as a shader function
// ------------------------------------------------------------
//  skyColor(direction) returns the colour of the sky in that
//  direction (no sun disc, no stars: just the gradient, the
//  sun's warm glow, the horizon haze band and the city glow).
//
//  The sky dome paints it. The terrain, the ridges and the city
//  call the SAME function to find the colour they should dissolve
//  into, so faraway things melt into exactly the sky behind them
//  instead of fading to a flat slab (a v1 lesson).
//
//  The uniforms come from sky.ts (skyUniforms) and are shared by
//  every material that includes this chunk.
// ============================================================

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyMid;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyHorizonAnti;
uniform vec3 uSkySunGlow;
uniform vec3 uSkyHaze;
uniform vec3 uSkyBelt;
uniform vec3 uSkyEarthShadow;
uniform float uSkyBeltAmt;
uniform vec2 uCityDir;
uniform float uCityCos;
uniform vec3 uCityGlow;
uniform float uSunVisible;
uniform float uTime;

// How much of a horizontal direction faces the sun: 1 toward it, 0 away.
float skySunward( vec3 d ) {
  vec2 h = d.xz;
  float hl = length( h );
  vec2 s = uSunDir.xz;
  float sl = length( s );
  float az = ( hl > 1e-5 && sl > 1e-5 ) ? dot( h / hl, s / sl ) : 0.0;
  return smoothstep( -0.25, 1.0, az );
}

vec3 skyColor( vec3 d ) {
  float y = d.y;
  float up = max( y, 0.0 );
  float sunward = skySunward( d );

  // Warm only toward the sun: the far side of the sky keeps its violet.
  vec3 horizon = mix( uSkyHorizonAnti, uSkyHorizon, sunward * sunward );

  // Horizon -> mid -> zenith. The horizon colour climbs higher on the sun side.
  float lift = mix( 0.16, 0.3, sunward );
  vec3 col = mix( horizon, uSkyMid, smoothstep( 0.0, lift, pow( up, 0.85 ) ) );
  col = mix( col, uSkyZenith, smoothstep( lift * 0.55, 0.92, up ) );

  // Opposite the sunset: the "Belt of Venus", a pink band lying above the
  // dusky blue-violet shadow of the world itself. Fades with the afterglow.
  float anti = ( 1.0 - sunward ) * ( 1.0 - sunward ) * uSkyBeltAmt;
  float belt = smoothstep( 0.035, 0.1, y ) * ( 1.0 - smoothstep( 0.13, 0.3, y ) );
  col = mix( col, uSkyBelt, belt * anti * 0.75 );
  float earthShadow = ( 1.0 - smoothstep( 0.015, 0.075, y ) ) * step( 0.0, y );
  col = mix( col, uSkyEarthShadow, earthShadow * anti * 0.7 );

  // The sun's warm glow: a wide wash hugging the horizon, and a tighter core.
  float cosA = max( dot( d, uSunDir ), 0.0 );
  float low = 1.0 - smoothstep( -0.05, 0.38, up );
  col += uSkySunGlow * ( pow( cosA, 5.0 ) * 0.24 * low + pow( cosA, 40.0 ) * 0.14 );

  // At night the megacity's light lifts the horizon in its direction.
  vec2 h = d.xz;
  float hl = length( h );
  float cityFacing = hl > 1e-5 ? dot( h / hl, uCityDir ) : 0.0;
  float cityArc = smoothstep( uCityCos - 0.12, uCityCos + 0.25, cityFacing );
  col += uCityGlow * cityArc * exp( -abs( y ) * 9.0 );

  // A soft luminous haze band lying along the horizon.
  float band = exp( -abs( y ) * 26.0 );
  col = mix( col, uSkyHaze, band * 0.42 );

  // Below the horizon the sky turns to the haze faraway ground melts into.
  col = mix( col, mix( horizon, uSkyHaze, 0.6 ) * 0.8, smoothstep( -0.01, -0.22, y ) );
  return col;
}

// The colour faraway ground fades into when seen along d: the sky right at the horizon.
vec3 skyHazeColor( vec3 d ) {
  vec3 h = normalize( vec3( d.x, clamp( d.y, -0.015, 0.02 ), d.z ) );
  return skyColor( h );
}
`
