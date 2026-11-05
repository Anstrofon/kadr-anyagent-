import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Icon, Spinner } from './icons'
import { useEditor } from '@/state/store'
import { importFiles } from '@/engine/mediaImport'
import { dirOf } from '@shared/paths'
import type { YouTubeItem } from '@shared/types'

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void
    YT?: any
  }
}

function formatSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const remS = s % 60
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h > 0) {
    return `${h}:${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`
  }
  return `${m}:${String(remS).padStart(2, '0')}`
}

export function YouTubeDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [items, setItems] = useState<YouTubeItem[]>([])
  const [selected, setSelected] = useState<YouTubeItem | null>(null)
  const [error, setError] = useState('')

  // Trimming
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioOnly, setAudioOnly] = useState(false)

  // Download
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; status: string } | null>(null)

  const playerRef = useRef<any>(null)

  // Load YouTube IFrame API script once
  useEffect(() => {
    if (!window.YT && !document.getElementById('yt-iframe-api-script')) {
      const tag = document.createElement('script')
      tag.id = 'yt-iframe-api-script'
      tag.src = 'https://www.youtube.com/iframe_api'
      document.body.appendChild(tag)
    }
  }, [])

  // Listen to download progress
  useEffect(() => {
    if (!open) return
    const unsub = window.kadr.onYtProgress((p) => {
      setProgress(p)
    })
    return () => unsub()
  }, [open])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setSelected(null)
      setProgress(null)
      setError('')
    }
  }, [open])

  // Initialize YouTube IFrame Player when video is selected
  useEffect(() => {
    if (!selected) return

    let playerInstance: any = null
    let pollTimer: any = null

    const createPlayer = () => {
      if (!window.YT || !window.YT.Player) return
      try {
        playerInstance = new window.YT.Player('yt-player-container', {
          videoId: selected.id,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            controls: 1,
            modestbranding: 1,
            rel: 0
          },
          events: {
            onReady: (event: any) => {
              playerRef.current = event.target
              pollTimer = setInterval(() => {
                try {
                  if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
                    const t = playerRef.current.getCurrentTime()
                    if (Number.isFinite(t)) setCurrentTime(t)
                  }
                } catch { /* ignore */ }
              }, 250)
            }
          }
        })
      } catch (err) {
        console.warn('Failed to init YT.Player:', err)
      }
    }

    if (window.YT && window.YT.Player) {
      createPlayer()
    } else {
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        createPlayer()
      }
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer)
      try {
        playerInstance?.destroy?.()
      } catch { /* ignore */ }
      playerRef.current = null
    }
  }, [selected])

  const handleSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    setError('')
    setSelected(null)
    try {
      const res = await window.kadr.ytSearch(query.trim())
      if (res.error) {
        setError(res.error)
      } else {
        setItems(res.items || [])
        if (res.items && res.items.length === 1) {
          handleSelect(res.items[0])
        }
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setSearching(false)
    }
  }

  const handleSelect = (item: YouTubeItem) => {
    setSelected(item)
    setStartSec(0)
    setEndSec(item.duration || 60)
    setCurrentTime(0)
    setError('')
  }

  const seekTo = (sec: number) => {
    if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
      playerRef.current.seekTo(sec, true)
    }
  }

  const setInPoint = () => {
    let t = currentTime
    if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
      t = playerRef.current.getCurrentTime()
    }
    const safe = Math.floor(t)
    setStartSec(Math.min(safe, Math.max(0, endSec - 1)))
  }

  const setOutPoint = () => {
    let t = currentTime
    if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
      t = playerRef.current.getCurrentTime()
    }
    const safe = Math.ceil(t)
    setEndSec(Math.max(safe, startSec + 1))
  }

  const handleDownload = async () => {
    if (!selected) return
    setDownloading(true)
    setError('')
    setProgress({ percent: 0, status: 'Підготовка завантаження...' })

    try {
      const projectPath = useEditor.getState().projectPath
      const projectDir = projectPath ? dirOf(projectPath) : null

      const res = await window.kadr.ytDownload({
        url: selected.url,
        title: selected.title,
        startSec: startSec > 0 ? startSec : undefined,
        endSec: endSec < selected.duration ? endSec : undefined,
        audioOnly,
        projectDir
      })

      if (res.error) {
        setError(res.error)
      } else if (res.path) {
        await importFiles([res.path], null)
        onClose()
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setDownloading(false)
    }
  }

  if (!open) return null

  const duration = selected?.duration || 0
  const cutDuration = Math.max(0, endSec - startSec)

  return (
    <Modal
      title="YouTube VideoCutter"
      titleIcon={<Icon name="play" size={17} />}
      onClose={onClose}
      wide
      actions={
        <>
          <button onClick={onClose} disabled={downloading}>Закрити</button>
          {selected && (
            <button
              className="primary"
              disabled={downloading}
              onClick={handleDownload}
            >
              {downloading ? 'Завантаження...' : `Додати в проект (${formatSec(cutDuration)})`}
            </button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Search bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); void handleSearch() }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            type="text"
            value={query}
            placeholder="Вставте посилання на YouTube або назву (наприклад, Mylene Farmer)..."
            onChange={(e) => setQuery(e.target.value)}
            disabled={searching || downloading}
            style={{ flex: 1, padding: '7px 12px' }}
          />
          <button type="submit" disabled={searching || downloading || !query.trim()} className="primary">
            {searching ? <Spinner size={14} /> : 'Знайти'}
          </button>
        </form>

        {error && (
          <div style={{ color: 'var(--c-danger, #f44)', fontSize: 13, background: 'rgba(255,0,0,0.08)', padding: '8px 12px', borderRadius: 4 }}>
            Помилка: {error}
          </div>
        )}

        {/* Selected Video Player & Cutter */}
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--c-bg-2, #141720)', padding: 12, borderRadius: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ minWidth: 0, paddingRight: 8 }}>
                <strong style={{ fontSize: 14, display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {selected.title}
                </strong>
                <div className="dim" style={{ fontSize: 12 }}>{selected.uploader} · {formatSec(selected.duration)}</div>
              </div>
              <button
                onClick={() => setSelected(null)}
                style={{ padding: '3px 8px', fontSize: 11, flexShrink: 0 }}
                disabled={downloading}
              >
                Назад до списку
              </button>
            </div>

            {/* Official YouTube Embed Player */}
            <div style={{
              position: 'relative',
              width: '100%',
              height: 330,
              background: '#000',
              borderRadius: 6,
              overflow: 'hidden'
            }}>
              <div id="yt-player-container" style={{ width: '100%', height: '100%' }} />
            </div>

            {/* Trimming controls */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={setInPoint}
                  disabled={downloading}
                  title="Встановити початок фрагмента на поточному часі відтворення"
                >
                  [ Початок ({formatSec(currentTime)})
                </button>
                <button
                  type="button"
                  onClick={setOutPoint}
                  disabled={downloading}
                  title="Встановити кінець фрагмента на поточному часі відтворення"
                >
                  Кінець ({formatSec(currentTime)}) ]
                </button>
              </div>

              <div style={{ fontSize: 13, fontWeight: 500 }}>
                Діапазон: <span style={{ color: 'var(--c-accent, #3b82f6)' }}>{formatSec(startSec)} → {formatSec(endSec)}</span> ({formatSec(cutDuration)})
              </div>
            </div>

            {/* Range Sliders */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 60, fontSize: 12 }} className="dim">Початок:</span>
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.5}
                  value={startSec}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value)
                    const safe = Math.min(val, endSec - 1)
                    setStartSec(safe)
                    seekTo(safe)
                  }}
                  style={{ flex: 1 }}
                />
                <span style={{ width: 50, fontSize: 12, textAlign: 'right' }}>{formatSec(startSec)}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 60, fontSize: 12 }} className="dim">Кінець:</span>
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.5}
                  value={endSec}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value)
                    const safe = Math.max(val, startSec + 1)
                    setEndSec(safe)
                    seekTo(safe)
                  }}
                  style={{ flex: 1 }}
                />
                <span style={{ width: 50, fontSize: 12, textAlign: 'right' }}>{formatSec(endSec)}</span>
              </div>
            </div>

            {/* Format selection */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="ytFormat"
                  checked={!audioOnly}
                  onChange={() => setAudioOnly(false)}
                />
                🎬 Відео + Аудіо (MP4)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="ytFormat"
                  checked={audioOnly}
                  onChange={() => setAudioOnly(true)}
                />
                🎵 Тільки звук (MP3)
              </label>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {downloading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--c-bg-2, #141720)', padding: 12, borderRadius: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span>{progress?.status || 'Завантаження...'}</span>
              <span>{progress?.percent ? `${progress.percent.toFixed(0)}%` : ''}</span>
            </div>
            <div style={{ width: '100%', height: 6, background: 'var(--c-bg-3, #222)', borderRadius: 3, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress?.percent || 5}%`,
                  height: '100%',
                  background: 'var(--c-accent, #3b82f6)',
                  transition: 'width 0.2s ease'
                }}
              />
            </div>
          </div>
        )}

        {/* Search Results list (when no video is currently selected) */}
        {!selected && items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflowY: 'auto' }}>
            {items.map((item) => (
              <div
                key={item.id}
                onClick={() => handleSelect(item)}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: 8,
                  borderRadius: 6,
                  background: 'var(--c-bg-2, #141720)',
                  cursor: 'pointer',
                  border: '1px solid transparent',
                  transition: 'border-color 0.15s ease'
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-accent, #3b82f6)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
              >
                {item.thumbnail ? (
                  <img
                    src={item.thumbnail}
                    alt=""
                    style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 4, background: '#000' }}
                  />
                ) : (
                  <div style={{ width: 120, height: 68, background: '#222', borderRadius: 4 }} />
                )}
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {item.title}
                  </div>
                  <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                    {item.uploader} · {formatSec(item.duration)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
