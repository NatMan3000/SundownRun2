// ============================================================
//  WORLD STATS - numbers for the `world` inspector
// ------------------------------------------------------------
//  Each part of the world writes how big it is here when it
//  builds, so a checker can ask window.__game.get('world') and see
//  the time of day and the triangle cost of every part without
//  opening a profiler.
// ============================================================

export const worldStats = {
  /** Terrain triangles at the detail levels in use right now (before culling). */
  terrainTriangles: 0,
  /** Grid steps of the near / mid / far detail levels, e.g. "1/2/4". */
  terrainStrides: '',
  terrainChunks: 0,
  skyTriangles: 0,
  planetTriangles: 0,
  stars: 0,
  cityTowers: 0,
  cityTriangles: 0,
}
