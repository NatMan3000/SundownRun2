// ============================================================
//  SCREENSHOT - F9 (or __dev.screenshot()) saves the picture
// ------------------------------------------------------------
//  WebGL throws its drawing away once the browser has shown it,
//  so a screenshot has to be grabbed in the same moment the frame
//  finishes. r3f's addAfterEffect runs right after every frame is
//  drawn (post stack included); when a shot has been asked for, it
//  copies the canvas there and downloads it as a PNG.
// ============================================================

import { useEffect } from 'react'
import { addAfterEffect, useThree } from '@react-three/fiber'
import { controlSignals } from '../core/controls'
import { getGame } from '../core/store'
import { registerDev } from '../core/devHandles'

interface ShotRequest {
  resolve: (info: { file: string; width: number; height: number; bytes: number }) => void
}

const pending: ShotRequest[] = []

function fileName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const track = getGame().trackId || 'sundown'
  return `sundown-run-two_${track}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function Screenshot(): null {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    let lastSignal = controlSignals.screenshot
    const off = addAfterEffect(() => {
      if (controlSignals.screenshot !== lastSignal) {
        lastSignal = controlSignals.screenshot
        pending.push({ resolve: () => {} })
      }
      if (pending.length === 0) return
      const canvas = gl.domElement
      const requests = pending.splice(0, pending.length)
      const name = fileName()
      // toBlob copies the pixels NOW (before the browser discards them); encoding happens later.
      canvas.toBlob((blob) => {
        if (!blob) {
          console.error('[look] screenshot failed: the canvas gave no image')
          return
        }
        download(blob, name)
        for (const r of requests) r.resolve({ file: name, width: canvas.width, height: canvas.height, bytes: blob.size })
      }, 'image/png')
    })

    const offDev = registerDev(
      'screenshot',
      (() =>
        new Promise((resolve) => {
          pending.push({ resolve })
        })) as (...args: never[]) => unknown,
      'screenshot() - download a PNG of the next finished frame (same as F9); resolves to { file, width, height, bytes }',
    )
    return () => {
      off()
      offDev()
    }
  }, [gl])

  return null
}
