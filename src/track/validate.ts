// Track worker replaces this file: validateTrack(json) per src/track/schema.ts.
import type { ValidationResult } from './schema'

export function validateTrack(json: unknown): ValidationResult {
  void json
  return { ok: false, errors: [{ path: '', message: 'track validator not built yet' }], warnings: [] }
}
