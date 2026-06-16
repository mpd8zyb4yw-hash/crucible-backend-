// CrucibleMark.tsx
// Drop into /Users/justin/Desktop/crucible/src/CrucibleMark.tsx
// Usage: <CrucibleMark thinking={thinking} done={globalDone} />
// Replaces the "ready" / "selecting models…" text in the idle model status bar.

import { useEffect, useRef } from 'react'

interface CrucibleMarkProps {
  thinking: boolean
  done: boolean
}

// Palette cycles through during drip — matches App.tsx PALETTE
const DRIP_COLORS: Array<[number, number, number]> = [
  [124, 124, 248], // purple
  [77,  184, 158], // teal
  [192, 132, 252], // violet
  [245, 158,  11], // amber
  [56,  189, 248], // sky
]

export default function CrucibleMark({ thinking, done }: CrucibleMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef  = useRef({ thinking, done })
  stateRef.current = { thinking, done }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    const SIZE   = 48
    const DPR    = window.devicePixelRatio || 1
    canvas.width  = SIZE * DPR
    canvas.height = SIZE * DPR
    canvas.style.width  = `${SIZE}px`
    canvas.style.height = `${SIZE}px`
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)

    // ── Crucible geometry (all in 48×48 space) ───────────────────────────────
    // A minimal tapered cup: wide rim, narrow base, slight taper
    const RIM_L  = 10,  RIM_R  = 38  // rim endpoints x
    const RIM_Y  = 14                 // rim y
    const BASE_L = 16,  BASE_R = 32  // base endpoints x
    const BASE_Y = 36                 // base y
    const TIP_X  = 24,  TIP_Y  = 40  // spout tip (center bottom)

    function drawVessel(alpha: number) {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth   = 1.5
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'

      // Left side: rim → base
      ctx.beginPath()
      ctx.moveTo(RIM_L, RIM_Y)
      ctx.lineTo(BASE_L, BASE_Y)
      ctx.stroke()

      // Right side: rim → base
      ctx.beginPath()
      ctx.moveTo(RIM_R, RIM_Y)
      ctx.lineTo(BASE_R, BASE_Y)
      ctx.stroke()

      // Base curve: base_l → tip → base_r
      ctx.beginPath()
      ctx.moveTo(BASE_L, BASE_Y)
      ctx.quadraticCurveTo(TIP_X, BASE_Y + 6, BASE_R, BASE_Y)
      ctx.stroke()

      // Rim line
      ctx.beginPath()
      ctx.moveTo(RIM_L, RIM_Y)
      ctx.lineTo(RIM_R, RIM_Y)
      ctx.stroke()

      ctx.restore()
    }

    // ── Animation state ───────────────────────────────────────────────────────
    let animId: number
    let t            = 0      // global time, increments each frame
    let dripT        = 0      // 0→1 drip progress within one cycle
    let colorIndex   = 0      // which palette color we're on
    let colorT       = 0      // 0→1 blend toward next color
    let doneGlow     = 0      // 0→1 completion glow pulse
    let doneTriggered = false

    const DRIP_SPEED  = 0.008  // how fast drip falls (lower = slower, more fluid)
    const COLOR_SPEED = 0.003  // how fast color cycles


    function currentDripColor(alpha: number): string {
      const a = DRIP_COLORS[colorIndex % DRIP_COLORS.length]
      const b = DRIP_COLORS[(colorIndex + 1) % DRIP_COLORS.length]
      const r = Math.round(a[0] + (b[0] - a[0]) * colorT)
      const g = Math.round(a[1] + (b[1] - a[1]) * colorT)
      const bl = Math.round(a[2] + (b[2] - a[2]) * colorT)
      return `rgba(${r},${g},${bl},${alpha})`
    }

    function drawDrip(progress: number) {
      // progress 0→1: droplet stretches down from TIP_Y, falls, fades at bottom
      // Phase 1 (0→0.4): droplet elongates from tip
      // Phase 2 (0.4→0.8): droplet detaches and falls
      // Phase 3 (0.8→1.0): droplet fades out at bottom

      const FALL_DIST = 14  // px the drop falls below tip

      let alpha: number
      let headY: number
      let tailY: number

      if (progress < 0.4) {
        // elongating from tip
        const p    = progress / 0.4
        alpha      = p
        tailY      = TIP_Y
        headY      = TIP_Y + p * 5
      } else if (progress < 0.8) {
        // detached, falling
        const p    = (progress - 0.4) / 0.4
        alpha      = 1
        tailY      = TIP_Y + p * FALL_DIST * 0.4
        headY      = TIP_Y + 5 + p * FALL_DIST
      } else {
        // fading
        const p    = (progress - 0.8) / 0.2
        alpha      = 1 - p
        tailY      = TIP_Y + FALL_DIST * 0.4 + p * 4
        headY      = TIP_Y + 5 + FALL_DIST + p * 3
      }

      const color = currentDripColor(alpha)

      ctx.save()
      ctx.strokeStyle = color
      ctx.fillStyle   = color
      ctx.lineWidth   = 2
      ctx.lineCap     = 'round'

      // Draw as a short rounded line (stretched droplet)
      ctx.beginPath()
      ctx.moveTo(TIP_X, tailY)
      ctx.lineTo(TIP_X, headY)
      ctx.stroke()

      // Small circle at head of drop
      ctx.beginPath()
      ctx.arc(TIP_X, headY, 1.5, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
    }

    function drawGlow(glowAlpha: number) {
      // Soft radial glow around the vessel on done
      const a = DRIP_COLORS[colorIndex % DRIP_COLORS.length]
      const gradient = ctx.createRadialGradient(TIP_X, TIP_Y, 2, TIP_X, TIP_Y, 22)
      gradient.addColorStop(0, `rgba(${a[0]},${a[1]},${a[2]},${glowAlpha * 0.35})`)
      gradient.addColorStop(1, `rgba(${a[0]},${a[1]},${a[2]},0)`)
      ctx.save()
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.restore()
    }

    function frame() {
      ctx.clearRect(0, 0, SIZE, SIZE)

      const { thinking: isThinking, done: isDone } = stateRef.current

      t += 1

      if (isThinking) {
        // Advance drip
        dripT     += DRIP_SPEED
        colorT    += COLOR_SPEED
        doneGlow   = 0
        doneTriggered = false

        if (colorT >= 1) {
          colorT   = 0
          colorIndex = (colorIndex + 1) % DRIP_COLORS.length
        }
        if (dripT > 1) dripT = 0

        drawVessel(0.7)
        drawDrip(dripT)

      } else if (isDone && !doneTriggered) {
        // Complete one last drip then glow
        if (dripT < 1) {
          dripT  += DRIP_SPEED * 1.5  // finish faster
          colorT += COLOR_SPEED
          if (colorT >= 1) { colorT = 0; colorIndex = (colorIndex + 1) % DRIP_COLORS.length }
          drawVessel(0.85)
          drawDrip(dripT)
        } else {
          doneTriggered = true
          dripT = 0
        }
        if (doneGlow < 1) doneGlow = Math.min(doneGlow + 0.04, 1)
        drawGlow(doneGlow * Math.sin(doneGlow * Math.PI))

      } else if (isDone && doneTriggered) {
        // Settle: glow fades, vessel returns to dim static
        doneGlow = Math.max(doneGlow - 0.02, 0)
        const vesselAlpha = 0.25 + doneGlow * 0.45
        drawGlow(doneGlow * 0.5)
        drawVessel(vesselAlpha)

      } else {
        // Idle: static dim vessel, no animation
        drawVessel(0.22)
      }

      animId = requestAnimationFrame(frame)
    }

    animId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(animId)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', flexShrink: 0 }}
    />
  )
}
