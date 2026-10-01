// ============================================================
//  GPU - which graphics chip the browser is really using
// ------------------------------------------------------------
//  Windows laptops often hand the browser the slow built-in chip
//  instead of the gaming one (the README explains the fix). This
//  reads the chip's name from the game's own WebGL context, once,
//  and tidies it: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU
//  (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)" becomes "NVIDIA
//  GeForce RTX 4060 Laptop GPU".
//
//  Shown in Settings > Graphics and under the FPS meter.
// ============================================================

export interface GpuInfo {
  /** What the driver reported, untouched. */
  raw: string
  /** Tidied for people. */
  name: string
  /** Looks like a built-in (integrated or software) chip that would struggle with this game. */
  builtIn: boolean
}

let cached: GpuInfo | null = null

/** Strip ANGLE's wrapper and the driver noise from a renderer string. */
export function tidyRenderer(raw: string): string {
  if (/SwiftShader/i.test(raw)) return 'SwiftShader (software, no graphics chip)'
  let s = raw.trim()
  const angle = /^ANGLE \((.*)\)$/.exec(s)
  if (angle) {
    // "Vendor, Device (0x...) Direct3D11 ..., D3D11" -> the device part.
    const parts = angle[1].split(', ')
    s = parts.length > 1 ? parts[1] : parts[0]
  }
  s = s
    .replace(/^ANGLE Metal Renderer:\s*/i, '')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(Direct3D|vs_\d|ps_\d|OpenGL|Vulkan).*$/i, '')
    .replace(/,\s*Unspecified Version$/i, '')
    .trim()
  return s || raw
}

/** Built-in chips: Intel graphics, AMD "Radeon(TM) Graphics" without an RX model, and software renderers. */
export function looksBuiltIn(name: string): boolean {
  if (/intel/i.test(name)) return true
  if (/Radeon\(TM\) Graphics/i.test(name) && !/\bRX\b/i.test(name)) return true
  return /Microsoft Basic Render|SwiftShader|llvmpipe|Software/i.test(name)
}

/** The chip the game's canvas runs on (cached after the first successful read). */
export function gpuInfo(): GpuInfo | null {
  if (cached) return cached
  const canvas = document.querySelector('canvas')
  if (!canvas) return null
  // Asking for the context type the canvas already has returns the game's own context.
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
  if (!gl) return null
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  const raw = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '')
  if (!raw) return null
  const name = tidyRenderer(raw)
  cached = { raw, name, builtIn: looksBuiltIn(name) }
  return cached
}
