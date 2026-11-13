import { useEffect, useRef, useState, useMemo } from 'react'
import { useEditor, findClip, withLinked } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { usePopout } from '@/engine/popout'
import { useT } from '@/i18n'
import type { Clip, Project } from '@shared/types'

interface BoxCoords {
  left: number
  top: number
  width: number
  height: number
  centerX: number
  centerY: number
  disp: number
  rawW: number
  rawH: number
}

function getClipDimensions(clip: Clip, project: Project): { w: number; h: number } {
  if (clip.kind === 'media') {
    const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : null
    if (asset?.width && asset?.height) {
      return { w: asset.width, h: asset.height }
    }
    return { w: project.width, h: project.height }
  }
  if (clip.kind === 'remotion') {
    const fw = clip.fragmentMeta?.width ?? project.width
    const fh = clip.fragmentMeta?.height ?? project.height
    return { w: fw, h: fh }
  }
  if (clip.kind === 'text') {
    const fontSize = clip.textStyle?.fontSize || 64
    const lines = (clip.text || 'Text').split('\n')
    const maxLineLen = Math.max(...lines.map((l) => l.length), 4)
    const approxW = Math.max(120, maxLineLen * fontSize * 0.65)
    const approxH = Math.max(60, lines.length * fontSize * 1.3)
    return { w: approxW, h: approxH }
  }
  return { w: project.width, h: project.height }
}

export function TransformGizmo({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const t = useT()
  const popped = usePopout((s) => s.win)
  const selId = useEditor((s) => s.selection[0])
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const [canvasRect, setCanvasRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null)

  const gesture = useRef<{
    mode: 'move' | 'tl' | 'tr' | 'bl' | 'br'
    startX: number
    startY: number
    baseX: number
    baseY: number
    baseScale: number
    initBoxW: number
    initBoxH: number
    pushed: boolean
  } | null>(null)

  // Find selected visual clip
  const targetClip = useMemo(() => {
    if (!selId) return null
    for (const track of project.tracks) {
      if (track.kind === 'audio') continue
      const c = track.clips.find((item) => item.id === selId)
      if (c && (c.kind === 'media' || c.kind === 'text' || c.kind === 'remotion')) {
        return c
      }
    }
    return null
  }, [selId, project])

  const active = !!targetClip && playhead >= targetClip.start - 1e-6 && playhead <= targetClip.start + targetClip.duration + 1e-6

  // Measure canvas viewport
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const measure = () => {
      const c = el.getBoundingClientRect()
      const p = el.parentElement?.getBoundingClientRect()
      if (!p) return
      setCanvasRect({ left: c.left - p.left, top: c.top - p.top, w: c.width, h: c.height })
    }
    measure()
    const win = el.ownerDocument?.defaultView ?? window
    let raf = 0
    const ro = new win.ResizeObserver(() => {
      win.cancelAnimationFrame(raf)
      raf = win.requestAnimationFrame(measure)
    })
    ro.observe(el)
    return () => {
      try { win.cancelAnimationFrame(raf) } catch { /* ignore */ }
      ro.disconnect()
    }
  }, [canvas, popped, active])

  // Click on canvas to select topmost clip under pointer (Premiere Pro style)
  useEffect(() => {
    const el = canvas.current
    if (!el) return

    const handleCanvasPointerDown = (e: MouseEvent) => {
      // If clicking directly on an active gizmo handle, let gizmo handle it
      const targetEl = e.target as HTMLElement | null
      if (targetEl?.closest?.('.transform-gizmo')) return

      const cRect = el.getBoundingClientRect()
      if (
        e.clientX < cRect.left ||
        e.clientX > cRect.right ||
        e.clientY < cRect.top ||
        e.clientY > cRect.bottom
      ) {
        return
      }

      const st = useEditor.getState()
      const curPlayhead = st.playhead
      const curProj = st.project

      // Click position normalized from canvas center (-projW/2..+projW/2, -projH/2..+projH/2)
      const disp = cRect.width / Math.max(1, curProj.width)
      const clickProjX = (e.clientX - (cRect.left + cRect.width / 2)) / disp
      const clickProjY = (e.clientY - (cRect.top + cRect.height / 2)) / disp

      // Check tracks from top (visual overlay order)
      for (const track of curProj.tracks) {
        if (track.kind === 'audio') continue
        for (let i = track.clips.length - 1; i >= 0; i--) {
          const clip = track.clips[i]
          if (clip.kind !== 'media' && clip.kind !== 'text' && clip.kind !== 'remotion') continue
          if (curPlayhead < clip.start - 0.01 || curPlayhead > clip.start + clip.duration + 0.01) continue

          const dims = getClipDimensions(clip, curProj)
          const fit = Math.min(curProj.width / dims.w, curProj.height / dims.h)
          const relTime = Math.max(0, Math.min(clip.duration, curPlayhead - clip.start))
          const scale = evalAnim(clip.transform.scale, relTime) * fit
          const objW = dims.w * scale
          const objH = dims.h * scale
          const objX = evalAnim(clip.transform.x, relTime)
          const objY = evalAnim(clip.transform.y, relTime)

          const halfW = objW / 2
          const halfH = objH / 2

          if (
            clickProjX >= objX - halfW &&
            clickProjX <= objX + halfW &&
            clickProjY >= objY - halfH &&
            clickProjY <= objY + halfH
          ) {
            // Hit! Select this clip (and its group/linked partners) directly from preview!
            st.select(withLinked(curProj, [clip.id]))
            return
          }
        }
      }
    }

    el.addEventListener('mousedown', handleCanvasPointerDown)
    return () => el.removeEventListener('mousedown', handleCanvasPointerDown)
  }, [canvas])

  const boxCoords = useMemo<BoxCoords | null>(() => {
    if (!targetClip || !active || !canvasRect) return null
    const disp = canvasRect.w / Math.max(1, project.width)
    const rel = Math.max(0, Math.min(targetClip.duration, playhead - targetClip.start))

    const dims = getClipDimensions(targetClip, project)
    const fit = Math.min(project.width / dims.w, project.height / dims.h)
    const scaleAnim = evalAnim(targetClip.transform.scale, rel)
    const effectiveScale = scaleAnim * fit

    const boxW = dims.w * effectiveScale * disp
    const boxH = dims.h * effectiveScale * disp
    const posX = evalAnim(targetClip.transform.x, rel) * disp
    const posY = evalAnim(targetClip.transform.y, rel) * disp

    const centerX = canvasRect.left + canvasRect.w / 2 + posX
    const centerY = canvasRect.top + canvasRect.h / 2 + posY

    return {
      left: centerX - boxW / 2,
      top: centerY - boxH / 2,
      width: Math.max(16, boxW),
      height: Math.max(16, boxH),
      centerX,
      centerY,
      disp,
      rawW: dims.w * fit,
      rawH: dims.h * fit
    }
  }, [targetClip, active, canvasRect, project, playhead])

  if (!targetClip || !active || !boxCoords) return null

  const st = () => useEditor.getState()

  const writeTransform = (px: number, py: number, ps: number) => {
    const f = findClip(st().project, targetClip.id)
    if (!f) return
    st().updateClip(targetClip.id, {
      transform: {
        ...f.clip.transform,
        x: { ...f.clip.transform.x, value: Math.round(px * 10) / 10 },
        y: { ...f.clip.transform.y, value: Math.round(py * 10) / 10 },
        scale: { ...f.clip.transform.scale, value: Math.round(ps * 1000) / 1000 }
      }
    })
  }

  const beginGesture = (mode: 'move' | 'tl' | 'tr' | 'bl' | 'br') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

    gesture.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      baseX: evalAnim(targetClip.transform.x, Math.max(0, playhead - targetClip.start)),
      baseY: evalAnim(targetClip.transform.y, Math.max(0, playhead - targetClip.start)),
      baseScale: evalAnim(targetClip.transform.scale, Math.max(0, playhead - targetClip.start)),
      initBoxW: boxCoords.width,
      initBoxH: boxCoords.height,
      pushed: false
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return

    if (!g.pushed) {
      st().pushHistory('hEdit')
      g.pushed = true
    }

    const dxPx = e.clientX - g.startX
    const dyPx = e.clientY - g.startY
    const disp = boxCoords.disp

    if (g.mode === 'move') {
      const newX = g.baseX + dxPx / disp
      const newY = g.baseY + dyPx / disp
      writeTransform(newX, newY, g.baseScale)
    } else {
      // Corner scaling: compute distance from center relative to initial distance
      const centerClientX = boxCoords.centerX
      const centerClientY = boxCoords.centerY
      const currentDist = Math.hypot(e.clientX - centerClientX, e.clientY - centerClientY)
      const initDist = Math.hypot(g.startX - centerClientX, g.startY - centerClientY) || 1

      const factor = currentDist / initDist
      const newScale = Math.min(25, Math.max(0.02, g.baseScale * factor))
      writeTransform(g.baseX, g.baseY, newScale)
    }
  }

  const onPointerUp = () => {
    gesture.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    st().pushHistory('hEdit')
    const factor = Math.pow(1.05, -e.deltaY / 100)
    const rel = Math.max(0, Math.min(targetClip.duration, playhead - targetClip.start))
    const curScale = evalAnim(targetClip.transform.scale, rel)
    const curX = evalAnim(targetClip.transform.x, rel)
    const curY = evalAnim(targetClip.transform.y, rel)
    writeTransform(curX, curY, Math.min(25, Math.max(0.02, curScale * factor)))
  }

  // Double click resets position to center
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    st().pushHistory('hEdit')
    const rel = Math.max(0, Math.min(targetClip.duration, playhead - targetClip.start))
    const curScale = evalAnim(targetClip.transform.scale, rel)
    writeTransform(0, 0, curScale)
  }

  const currentScalePct = Math.round(
    evalAnim(targetClip.transform.scale, Math.max(0, playhead - targetClip.start)) * 100
  )

  return (
    <div
      className="transform-gizmo"
      style={{
        left: boxCoords.left,
        top: boxCoords.top,
        width: boxCoords.width,
        height: boxCoords.height
      }}
      onPointerDown={beginGesture('move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      title={`${t('gizmoHint')} · Подвійний клік — центрувати`}
    >
      {/* 4 Corner Handles for intuitive resizing from any angle */}
      <div
        className="gizmo-handle handle-tl"
        onPointerDown={beginGesture('tl')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        className="gizmo-handle handle-tr"
        onPointerDown={beginGesture('tr')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        className="gizmo-handle handle-bl"
        onPointerDown={beginGesture('bl')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        className="gizmo-handle handle-br"
        onPointerDown={beginGesture('br')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      {/* Center anchor crosshair */}
      <div className="gizmo-center-cross">
        <div className="cross-dot" />
      </div>

      {/* Scale tooltip badge */}
      <div className="gizmo-scale-badge">{currentScalePct}%</div>
    </div>
  )
}
