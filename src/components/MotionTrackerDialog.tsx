import { useEffect, useRef, useState, useMemo } from 'react'
import { create } from 'zustand'
import { useEditor, findClip } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { Modal } from './Modal'
import { Icon, Spinner } from './icons'
import type { Clip, Keyframe, MotionTrackProgress, MotionTrackResult } from '@shared/types'

export const useMotionTrackerUi = create<{
  open: boolean
  clipId: string | null
  openWithClip(clipId: string): void
  close(): void
}>((set) => ({
  open: false,
  clipId: null,
  openWithClip: (clipId) => set({ open: true, clipId }),
  close: () => set({ open: false, clipId: null })
}))

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const f = Math.floor((sec % 1) * 30)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`
}

export function MotionTrackerDialog() {
  const open = useMotionTrackerUi((s) => s.open)
  const clipId = useMotionTrackerUi((s) => s.clipId)
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)

  const clipData = useMemo(() => {
    if (!clipId) return null
    const found = findClip(project, clipId)
    if (!found) return null
    const asset = found.clip.assetId ? project.assets.find((a) => a.id === found.clip.assetId) : null
    return { clip: found.clip, track: found.track, asset }
  }, [project, clipId])

  const clip = clipData?.clip
  const asset = clipData?.asset

  // Tracking Range in media seconds
  const [currentMediaTime, setCurrentMediaTime] = useState(0)
  const [startMediaTime, setStartMediaTime] = useState(0)
  const [endMediaTime, setEndMediaTime] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Tracking Box (normalized 0..1 relative to video frame)
  // [nx, ny] is the center, [nw, nh] is width & height
  const [box, setBox] = useState({ nx: 0.5, ny: 0.5, nw: 0.12, nh: 0.12 })

  // Tracker state
  const [method, setMethod] = useState<'lk' | 'template' | 'mil'>('lk')
  const [tracking, setTracking] = useState(false)
  const [progress, setProgress] = useState<MotionTrackProgress | null>(null)
  const [trackResult, setTrackResult] = useState<MotionTrackResult | null>(null)
  const [error, setError] = useState('')
  const [appliedSuccess, setAppliedSuccess] = useState('')

  // Target attachment
  const [targetClipId, setTargetClipId] = useState<string>('')
  const [applyMode, setApplyMode] = useState<'relative' | 'absolute'>('relative')
  const [applyPosition, setApplyPosition] = useState(true)
  const [applyScale, setApplyScale] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    mode: 'move' | 'tl' | 'tr' | 'bl' | 'br'
    startX: number
    startY: number
    initBox: typeof box
  } | null>(null)

  // Initial setup when dialog opens
  useEffect(() => {
    if (!open || !clip || !asset) return
    const offsetInClip = Math.max(0, Math.min(clip.duration, playhead - clip.start))
    const initialMediaTime = clip.inPoint + offsetInClip * (clip.speed || 1)
    const clipEndMedia = clip.inPoint + clip.duration * (clip.speed || 1)

    setCurrentMediaTime(initialMediaTime)
    setStartMediaTime(initialMediaTime)
    setEndMediaTime(clipEndMedia)
    setTrackResult(null)
    setProgress(null)
    setError('')
    setAppliedSuccess('')

    // Pick first candidate target clip that is NOT the source clip
    const candidates: Clip[] = []
    for (const tr of project.tracks) {
      for (const c of tr.clips) {
        if (c.id !== clip.id) candidates.push(c)
      }
    }
    if (candidates.length > 0) {
      setTargetClipId(candidates[0].id)
    }
  }, [open, clipId])

  // Sync video time
  const syncToCurrentMediaTime = (time: number) => {
    const v = videoRef.current
    if (!v) return
    try {
      if (Math.abs(v.currentTime - time) > 0.03) {
        v.currentTime = time
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    syncToCurrentMediaTime(currentMediaTime)
  }, [currentMediaTime])

  // Progress listener
  useEffect(() => {
    if (!window.kadr?.onMotionTrackProgress) return
    const unbind = window.kadr.onMotionTrackProgress((p) => {
      setProgress(p)
      // Update box position dynamically during tracking
      setBox((prev) => ({ ...prev, nx: p.nx, ny: p.ny }))
      if (typeof p.time === 'number') {
        const frameMediaTime = startMediaTime + p.time
        setCurrentMediaTime(frameMediaTime)
        syncToCurrentMediaTime(frameMediaTime)
      }
    })
    return unbind
  }, [startMediaTime])

  // When track results exist and user scrubs or plays video in dialog, update box to match tracked trajectory
  useEffect(() => {
    if (!trackResult || !trackResult.keyframes || trackResult.keyframes.length === 0) return
    if (tracking) return
    const relT = currentMediaTime - startMediaTime
    if (relT < -0.05) return
    const kfs = trackResult.keyframes
    let closest = kfs[0]
    let minDiff = Math.abs(closest.time - relT)
    for (let i = 1; i < kfs.length; i++) {
      const diff = Math.abs(kfs[i].time - relT)
      if (diff < minDiff) {
        minDiff = diff
        closest = kfs[i]
      }
    }
    if (minDiff < 0.15) {
      setBox((prev) => ({
        ...prev,
        nx: closest.nx,
        ny: closest.ny,
        nw: closest.nw || prev.nw,
        nh: closest.nh || prev.nh
      }))
    }
  }, [currentMediaTime, trackResult, tracking, startMediaTime])

  if (!open || !clip || !asset) return null

  // All eligible target clips in project
  const targetCandidates = (() => {
    const list: { id: string; label: string; kind: string }[] = []
    for (const tr of project.tracks) {
      for (const c of tr.clips) {
        if (c.id === clip.id) continue
        let label = c.label || c.text || c.fragmentId || ''
        if (!label && c.assetId) {
          const a = project.assets.find((x) => x.id === c.assetId)
          label = a?.name || 'Кліп'
        }
        if (!label) label = `Шар ${c.id.slice(0, 5)}`
        list.push({ id: c.id, label, kind: c.kind })
      }
    }
    return list
  })()

  const handleStartTracking = async () => {
    if (tracking) return
    setError('')
    setAppliedSuccess('')
    setTracking(true)
    setProgress(null)

    try {
      const res = await window.kadr.motionTrack({
        videoPath: asset.path,
        start: startMediaTime,
        end: endMediaTime,
        box: {
          nx: box.nx - box.nw / 2,
          ny: box.ny - box.nh / 2,
          nw: box.nw,
          nh: box.nh
        },
        method,
        fps: project.fps || 30
      })
      setTrackResult(res)
    } catch (err: any) {
      setError(err?.message || 'Помилка трекінгу руху')
    } finally {
      setTracking(false)
    }
  }

  const handleCancelTracking = async () => {
    try {
      await window.kadr.motionTrackCancel()
    } catch {
      /* ignore */
    }
    setTracking(false)
  }

  const handleApply = () => {
    if (!trackResult || !trackResult.keyframes || trackResult.keyframes.length === 0) return
    const target = findClip(project, targetClipId)?.clip
    if (!target) {
      setError('Оберіть цільовий шар')
      return
    }

    const projW = project.width || 1920
    const projH = project.height || 1080
    const kfs = trackResult.keyframes
    const initKf = kfs[0]

    // Absolute start on timeline where tracking begins
    const offsetInSource = (startMediaTime - clip.inPoint) / (clip.speed || 1)
    const trackingStartTimeline = clip.start + offsetInSource

    const initObjPxX = (initKf.nx - 0.5) * projW
    const initObjPxY = (initKf.ny - 0.5) * projH
    const initObjW = initKf.nw || 0.1
    const initObjH = initKf.nh || 0.1

    // Initial transform values of target at trackingStartTimeline
    const targetRelStart = trackingStartTimeline - target.start
    const baseTargetX = evalAnim(target.transform.x, targetRelStart)
    const baseTargetY = evalAnim(target.transform.y, targetRelStart)
    const baseTargetScale = evalAnim(target.transform.scale, targetRelStart)

    const newKfsX: Keyframe[] = []
    const newKfsY: Keyframe[] = []
    const newKfsScale: Keyframe[] = []

    for (const kf of kfs) {
      const timelineT = trackingStartTimeline + kf.time
      const targetRelT = timelineT - target.start
      if (targetRelT < -0.05 || targetRelT > target.duration + 0.05) continue

      const currentObjPxX = (kf.nx - 0.5) * projW
      const currentObjPxY = (kf.ny - 0.5) * projH

      const valX = applyMode === 'relative'
        ? baseTargetX + (currentObjPxX - initObjPxX)
        : currentObjPxX
      const valY = applyMode === 'relative'
        ? baseTargetY + (currentObjPxY - initObjPxY)
        : currentObjPxY

      const timeClamped = Math.max(0, Math.min(target.duration, targetRelT))
      newKfsX.push({ time: timeClamped, value: Math.round(valX * 10) / 10, easing: 'linear' })
      newKfsY.push({ time: timeClamped, value: Math.round(valY * 10) / 10, easing: 'linear' })

      if (applyScale) {
        const scaleRatio = Math.sqrt((kf.nw * kf.nh) / (initObjW * initObjH || 0.01))
        newKfsScale.push({
          time: timeClamped,
          value: Math.round(baseTargetScale * scaleRatio * 100) / 100,
          easing: 'linear'
        })
      }
    }

    if (newKfsX.length === 0) {
      setError('Таймлайн цільового шару не перетинається з періодом трекінгу')
      return
    }

    const updatedTransform = { ...target.transform }
    if (applyPosition) {
      updatedTransform.x = { value: newKfsX[0].value, keyframes: newKfsX, smooth: true }
      updatedTransform.y = { value: newKfsY[0].value, keyframes: newKfsY, smooth: true }
    }
    if (applyScale && newKfsScale.length > 0) {
      updatedTransform.scale = { value: newKfsScale[0].value, keyframes: newKfsScale, smooth: true }
    }

    useEditor.getState().updateClip(target.id, { transform: updatedTransform })
    setAppliedSuccess(`Траєкторію успішно застосовано до шару! Створено ${newKfsX.length} ключів анімації.`)
  }

  // Pointer interaction for moving & sizing the track box
  const onPointerDownStage = (e: React.PointerEvent) => {
    if (tracking) return
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const px = (e.clientX - rect.left) / rect.width
    const py = (e.clientY - rect.top) / rect.height

    dragRef.current = {
      mode: 'move',
      startX: px,
      startY: py,
      initBox: { ...box }
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerDownHandle = (e: React.PointerEvent, mode: 'tl' | 'tr' | 'bl' | 'br') => {
    e.stopPropagation()
    if (tracking) return
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    dragRef.current = {
      mode,
      startX: (e.clientX - rect.left) / rect.width,
      startY: (e.clientY - rect.top) / rect.height,
      initBox: { ...box }
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !stageRef.current) return
    const rect = stageRef.current.getBoundingClientRect()
    const curX = (e.clientX - rect.left) / rect.width
    const curY = (e.clientY - rect.top) / rect.height
    const dx = curX - dragRef.current.startX
    const dy = curY - dragRef.current.startY
    const init = dragRef.current.initBox

    if (dragRef.current.mode === 'move') {
      setBox({
        ...init,
        nx: Math.max(init.nw / 2, Math.min(1 - init.nw / 2, init.nx + dx)),
        ny: Math.max(init.nh / 2, Math.min(1 - init.nh / 2, init.ny + dy))
      })
    } else {
      let nw = init.nw
      let nh = init.nh
      if (dragRef.current.mode === 'br') {
        nw = Math.max(0.02, Math.min(0.8, init.nw + dx * 2))
        nh = Math.max(0.02, Math.min(0.8, init.nh + dy * 2))
      } else if (dragRef.current.mode === 'tl') {
        nw = Math.max(0.02, Math.min(0.8, init.nw - dx * 2))
        nh = Math.max(0.02, Math.min(0.8, init.nh - dy * 2))
      } else if (dragRef.current.mode === 'tr') {
        nw = Math.max(0.02, Math.min(0.8, init.nw + dx * 2))
        nh = Math.max(0.02, Math.min(0.8, init.nh - dy * 2))
      } else if (dragRef.current.mode === 'bl') {
        nw = Math.max(0.02, Math.min(0.8, init.nw - dx * 2))
        nh = Math.max(0.02, Math.min(0.8, init.nh + dy * 2))
      }
      setBox({ ...init, nw, nh })
    }
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  const minTime = clip.inPoint
  const maxTime = clip.inPoint + clip.duration * (clip.speed || 1)
  const videoSrc = window.kadr.fileUrl(asset.path)

  return (
    <Modal
      title="Motion Tracking — Відстеження руху об'єкта"
      titleIcon={<Icon name="target" size={18} />}
      wide
      className="motion-dialog"
      onClose={() => {
        if (tracking) handleCancelTracking()
        useMotionTrackerUi.getState().close()
      }}
    >
      <div className="motion-tracker-container">
        {/* Left: Video Preview & Interactive Stage */}
        <div className="motion-stage-col">
          <div
            ref={stageRef}
            className="motion-viewport"
            style={{
              aspectRatio: asset.width && asset.height ? `${asset.width} / ${asset.height}` : '16 / 9'
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <video
              ref={videoRef}
              src={videoSrc}
              crossOrigin="anonymous"
              preload="auto"
              playsInline
              muted
              onLoadedMetadata={() => syncToCurrentMediaTime(currentMediaTime)}
              onLoadedData={() => syncToCurrentMediaTime(currentMediaTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={() => {
                if (videoRef.current && playing) {
                  setCurrentMediaTime(videoRef.current.currentTime)
                }
              }}
              onEnded={() => setPlaying(false)}
            />

            {/* SVG Trajectory Trail */}
            {trackResult && trackResult.keyframes.length > 0 && (
              <svg className="motion-trajectory-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                <polyline
                  points={trackResult.keyframes
                    .map((k) => `${k.nx * 1000},${k.ny * 1000}`)
                    .join(' ')}
                  fill="none"
                  stroke="#00ffff"
                  strokeWidth="2.5"
                  strokeDasharray="4 4"
                />
                {trackResult.keyframes
                  .filter((_, idx) => idx % 4 === 0 || idx === trackResult.keyframes.length - 1)
                  .map((k, idx) => (
                    <circle
                      key={idx}
                      cx={k.nx * 1000}
                      cy={k.ny * 1000}
                      r="4"
                      fill={idx === 0 ? '#00ff88' : idx === trackResult.keyframes.length - 1 ? '#ff3366' : '#00ffff'}
                    />
                  ))}
              </svg>
            )}

            {/* Outer Search Region Box (dashed) */}
            <div
              className="motion-search-box"
              style={{
                left: `${(box.nx - (box.nw * 2.2) / 2) * 100}%`,
                top: `${(box.ny - (box.nh * 2.2) / 2) * 100}%`,
                width: `${box.nw * 2.2 * 100}%`,
                height: `${box.nh * 2.2 * 100}%`
              }}
            />

            {/* Inner Feature Target Box (draggable) */}
            <div
              className="motion-feature-box"
              style={{
                left: `${(box.nx - box.nw / 2) * 100}%`,
                top: `${(box.ny - box.nh / 2) * 100}%`,
                width: `${box.nw * 100}%`,
                height: `${box.nh * 100}%`
              }}
              onPointerDown={onPointerDownStage}
            >
              <div className="motion-crosshair">
                <div className="cross-h" />
                <div className="cross-v" />
                <div className="cross-dot" />
              </div>
              <div className="handle tl" onPointerDown={(e) => onPointerDownHandle(e, 'tl')} />
              <div className="handle tr" onPointerDown={(e) => onPointerDownHandle(e, 'tr')} />
              <div className="handle bl" onPointerDown={(e) => onPointerDownHandle(e, 'bl')} />
              <div className="handle br" onPointerDown={(e) => onPointerDownHandle(e, 'br')} />
            </div>
          </div>

          {/* Transport / Timeline Bar */}
          <div className="motion-transport">
            <button
              className="motion-btn icon-btn"
              onClick={() => {
                const v = videoRef.current
                if (!v) return
                if (v.paused) {
                  v.play().catch(() => setPlaying(false))
                } else {
                  v.pause()
                }
              }}
              title={playing ? 'Пауза' : 'Відтворити'}
            >
              <Icon name={playing ? 'pause' : 'play'} size={15} />
            </button>

            <button
              className="motion-btn icon-btn"
              onClick={() => {
                const step = Math.max(minTime, currentMediaTime - 1 / (project.fps || 30))
                setCurrentMediaTime(step)
                syncToCurrentMediaTime(step)
              }}
              title="Кадр назад"
            >
              <Icon name="chevronLeft" size={14} />
            </button>

            <button
              className="motion-btn icon-btn"
              onClick={() => {
                const step = Math.min(maxTime, currentMediaTime + 1 / (project.fps || 30))
                setCurrentMediaTime(step)
                syncToCurrentMediaTime(step)
              }}
              title="Кадр вперед"
            >
              <Icon name="chevronRight" size={14} />
            </button>

            <span className="motion-timecode">
              {formatTimecode(currentMediaTime - clip.inPoint)} / {formatTimecode(clip.duration)}
            </span>

            <input
              type="range"
              className="motion-scrubber"
              min={minTime}
              max={maxTime}
              step={0.01}
              value={currentMediaTime}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                setCurrentMediaTime(val)
                syncToCurrentMediaTime(val)
              }}
            />

            <button
              className="motion-btn set-start-btn"
              onClick={() => setStartMediaTime(currentMediaTime)}
              title="Почати відстеження з цього кадру"
            >
              Старт: {formatTimecode(startMediaTime - clip.inPoint)}
            </button>
          </div>
        </div>

        {/* Right: Controls & Target Binding Panel */}
        <div className="motion-controls-col">
          {/* Section 1: Source Info & Tracker Setup */}
          <div className="motion-panel-section">
            <div className="section-title">1. Параметри відстеження</div>
            <div className="prop-row">
              <span className="prop-label">Кліп:</span>
              <span className="prop-val-dim">{asset.name}</span>
            </div>

            <div className="prop-row">
              <span className="prop-label">Метод:</span>
              <select
                className="motion-select"
                value={method}
                disabled={tracking}
                onChange={(e) => setMethod(e.target.value as any)}
              >
                <option value="lk">Lucas-Kanade (Point Flow, як в AE)</option>
                <option value="template">Template Matching (Рамка об'єкта)</option>
                <option value="mil">OpenCV MIL (Кореляційний трекер)</option>
              </select>
            </div>

            <div className="prop-row">
              <span className="prop-label">Діапазон:</span>
              <span className="prop-val-dim">
                {formatTimecode(startMediaTime - clip.inPoint)} → {formatTimecode(endMediaTime - clip.inPoint)} (
                {Math.round((endMediaTime - startMediaTime) * (project.fps || 30))} кадрів)
              </span>
            </div>

            <div className="motion-action-row">
              {!tracking ? (
                <button
                  className="motion-track-btn primary-btn"
                  onClick={handleStartTracking}
                >
                  <Icon name="target" size={15} /> Відстежити вперед (Track)
                </button>
              ) : (
                <button
                  className="motion-track-btn cancel-btn"
                  onClick={handleCancelTracking}
                >
                  <Spinner size={14} /> Зупинити відстеження
                </button>
              )}
            </div>

            {progress && (
              <div className="motion-progress-block">
                <div className="progress-info">
                  <span>Кадр {progress.frame} / {progress.total}</span>
                  <span>{progress.percent}%</span>
                </div>
                <div className="progress-bar-track">
                  <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Section 2: Target Binding (Apply) */}
          <div className="motion-panel-section">
            <div className="section-title">2. Прикріпити до об'єкта</div>

            <div className="prop-row">
              <span className="prop-label">Цільовий шар:</span>
              <select
                className="motion-select"
                value={targetClipId}
                disabled={tracking || targetCandidates.length === 0}
                onChange={(e) => setTargetClipId(e.target.value)}
              >
                {targetCandidates.length === 0 ? (
                  <option value="">Немає інших шарів на таймлайні</option>
                ) : (
                  targetCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      [{c.kind}] {c.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="prop-row-options">
              <label className="checkbox-lbl">
                <input
                  type="checkbox"
                  checked={applyPosition}
                  onChange={(e) => setApplyPosition(e.target.checked)}
                />
                Позиція (X / Y)
              </label>

              <label className="checkbox-lbl">
                <input
                  type="checkbox"
                  checked={applyScale}
                  onChange={(e) => setApplyScale(e.target.checked)}
                />
                Масштаб (Scale)
              </label>
            </div>

            <div className="prop-row-mode">
              <div className="mode-title">Режим прив'язки:</div>
              <label className="radio-lbl">
                <input
                  type="radio"
                  name="applyMode"
                  checked={applyMode === 'relative'}
                  onChange={() => setApplyMode('relative')}
                />
                <span>
                  <strong>Відносний рух (рекомендовано)</strong>
                  <div className="mode-sub">Шар зберігає своє початкове положення і слідує за зміщенням</div>
                </span>
              </label>

              <label className="radio-lbl">
                <input
                  type="radio"
                  name="applyMode"
                  checked={applyMode === 'absolute'}
                  onChange={() => setApplyMode('absolute')}
                />
                <span>
                  <strong>Точна прив'язка</strong>
                  <div className="mode-sub">Шар центрується безпосередньо в точці відстеження</div>
                </span>
              </label>
            </div>

            <button
              className="motion-apply-btn accent-btn"
              disabled={!trackResult || !targetClipId || tracking}
              onClick={handleApply}
            >
              <Icon name="check" size={15} /> Застосувати до шару (Apply)
            </button>

            {appliedSuccess && (
              <div className="motion-success-banner">
                <Icon name="check" size={14} /> {appliedSuccess}
              </div>
            )}
            {error && (
              <div className="motion-error-banner">
                <Icon name="alert" size={14} /> {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
