import { useState, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { Modal } from './Modal'
import { Icon, Spinner } from './icons'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'
import {
  getAudioInputDevices,
  startVoiceRecording,
  saveVoiceoverClip,
  type VoiceRecorderSession
} from '@/engine/voiceRecorder'

export const useVoiceRecorderUi = create<{
  open: boolean
  targetTrackId: string | null
  openRecorder(trackId?: string | null): void
  close(): void
}>((set) => ({
  open: false,
  targetTrackId: null,
  openRecorder: (trackId = null) => set({ open: true, targetTrackId: trackId }),
  close: () => set({ open: false, targetTrackId: null })
}))

export function VoiceRecorderDialog({
  open: propOpen,
  onClose: propOnClose,
  initialTrackId: propTrackId
}: {
  open?: boolean
  onClose?: () => void
  initialTrackId?: string | null
} = {}) {
  const storeOpen = useVoiceRecorderUi((s) => s.open)
  const storeTrackId = useVoiceRecorderUi((s) => s.targetTrackId)
  const storeClose = useVoiceRecorderUi((s) => s.close)

  const open = propOpen !== undefined ? propOpen : storeOpen
  const onClose = propOnClose ?? storeClose
  const initialTrackId = propTrackId !== undefined ? propTrackId : storeTrackId

  const t = useT()
  const tracks = useEditor((s) => s.project.tracks)
  const audioTracks = tracks.filter((tr) => tr.kind === 'audio')
  const playhead = useEditor((s) => s.playhead)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [targetTrackId, setTargetTrackId] = useState<string>(initialTrackId || '')

  const [muteProject, setMuteProject] = useState(true)
  const [useCountdown, setUseCountdown] = useState(true)
  const [playTimeline, setPlayTimeline] = useState(true)

  const [status, setStatus] = useState<'idle' | 'countdown' | 'recording' | 'saving'>('idle')
  const [countdownVal, setCountdownVal] = useState(3)
  const [recordedDuration, setRecordedDuration] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')

  const sessionRef = useRef<VoiceRecorderSession | null>(null)
  const startPlayheadRef = useRef<number>(0)
  const mutedTracksRef = useRef<{ id: string; muted: boolean }[]>([])
  const timerRef = useRef<number | null>(null)
  const testStreamRef = useRef<MediaStream | null>(null)
  const testAudioCtxRef = useRef<AudioContext | null>(null)

  // Enumerate microphone devices when opened
  useEffect(() => {
    if (!open) return
    setError('')
    setSavedNote('')
    setStatus('idle')
    setAudioLevel(0)
    setRecordedDuration(0)

    if (initialTrackId) {
      setTargetTrackId(initialTrackId)
    } else if (audioTracks.length > 0 && !targetTrackId) {
      setTargetTrackId(audioTracks[0].id)
    }

    getAudioInputDevices().then((devs) => {
      setDevices(devs)
      if (devs.length > 0 && !selectedDevice) {
        setSelectedDevice(devs[0].deviceId)
      }
    }).catch(() => {
      setError(t('recNoMic'))
    })
  }, [open, initialTrackId])

  // Live microphone level monitor in idle mode so user can test before recording
  useEffect(() => {
    if (!open || status !== 'idle') {
      if (testStreamRef.current) {
        testStreamRef.current.getTracks().forEach((t) => t.stop())
        testStreamRef.current = null
      }
      if (testAudioCtxRef.current) {
        void testAudioCtxRef.current.close().catch(() => {})
        testAudioCtxRef.current = null
      }
      return
    }

    let active = true
    const startTest = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedDevice ? { exact: selectedDevice } : undefined,
            echoCancellation: true
          }
        })
        if (!active) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        testStreamRef.current = stream
        const ctx = new AudioContext({ sampleRate: 48000 })
        testAudioCtxRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        src.connect(analyser)

        const pcmData = new Uint8Array(analyser.frequencyBinCount)
        const check = () => {
          if (!active) return
          analyser.getByteFrequencyData(pcmData)
          let sum = 0
          for (let i = 0; i < pcmData.length; i++) {
            sum += pcmData[i]
          }
          const avg = sum / pcmData.length / 255
          setAudioLevel(Math.min(1, avg * 2.5))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      } catch (err) {
        if (active) setError(t('recNoMic'))
      }
    }

    void startTest()

    return () => {
      active = false
      if (testStreamRef.current) {
        testStreamRef.current.getTracks().forEach((t) => t.stop())
        testStreamRef.current = null
      }
      if (testAudioCtxRef.current) {
        void testAudioCtxRef.current.close().catch(() => {})
        testAudioCtxRef.current = null
      }
    }
  }, [open, selectedDevice, status])

  // Cleanup on unmount or close
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (sessionRef.current) {
        sessionRef.current.cancel()
        sessionRef.current = null
      }
    }
  }, [])

  const startActualRecording = async () => {
    setError('')
    try {
      startPlayheadRef.current = useEditor.getState().playhead

      // Mute project audio if requested
      if (muteProject) {
        const currentTracks = useEditor.getState().project.tracks
        mutedTracksRef.current = currentTracks
          .filter((tr) => tr.kind === 'audio')
          .map((tr) => ({ id: tr.id, muted: tr.muted }))

        for (const tr of mutedTracksRef.current) {
          if (!tr.muted) {
            useEditor.getState().updateTrack(tr.id, { muted: true })
          }
        }
      }

      // Start audio capture
      const session = await startVoiceRecording({
        deviceId: selectedDevice || undefined,
        onLevel: (rms) => setAudioLevel(rms)
      })
      sessionRef.current = session
      setStatus('recording')
      setRecordedDuration(0)

      // Start timeline playback if requested
      if (playTimeline) {
        useEditor.getState().setPlaying(true)
      }

      // Track duration
      timerRef.current = window.setInterval(() => {
        if (sessionRef.current) {
          setRecordedDuration(sessionRef.current.getCurrentDuration())
        }
      }, 50)
    } catch (err) {
      setStatus('idle')
      setError(String((err as Error)?.message || err))
    }
  }

  const handleStart = () => {
    setError('')
    if (useCountdown) {
      setStatus('countdown')
      setCountdownVal(3)
      let count = 3
      const cTimer = setInterval(() => {
        count -= 1
        if (count <= 0) {
          clearInterval(cTimer)
          void startActualRecording()
        } else {
          setCountdownVal(count)
        }
      }, 800)
    } else {
      void startActualRecording()
    }
  }

  const restoreProjectAudio = () => {
    if (muteProject && mutedTracksRef.current.length > 0) {
      for (const tr of mutedTracksRef.current) {
        useEditor.getState().updateTrack(tr.id, { muted: tr.muted })
      }
      mutedTracksRef.current = []
    }
  }

  const handleStop = async () => {
    if (!sessionRef.current || status !== 'recording') return
    setStatus('saving')
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // Stop timeline playback
    if (playTimeline) {
      useEditor.getState().setPlaying(false)
    }

    restoreProjectAudio()

    try {
      const { wav, duration } = await sessionRef.current.stop()
      sessionRef.current = null

      if (duration < 0.2) {
        setError('Запис занадто короткий')
        setStatus('idle')
        return
      }

      const res = await saveVoiceoverClip({
        wavData: wav,
        duration,
        at: startPlayheadRef.current,
        trackId: targetTrackId || undefined
      })

      setSavedNote(t('recAdded'))
      setStatus('idle')
      setRecordedDuration(0)
      setTimeout(() => {
        onClose()
      }, 1000)
    } catch (err) {
      setStatus('idle')
      setError(String((err as Error)?.message || err))
    }
  }

  const handleCancel = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (playTimeline) {
      useEditor.getState().setPlaying(false)
    }
    restoreProjectAudio()

    if (sessionRef.current) {
      sessionRef.current.cancel()
      sessionRef.current = null
    }

    setStatus('idle')
    setRecordedDuration(0)
  }

  // Keyboard controls: Space or R toggles record / stop
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      if (e.code === 'KeyR' || (e.code === 'Space' && status === 'recording')) {
        e.preventDefault()
        e.stopPropagation()
        if (status === 'recording') {
          void handleStop()
        } else if (status === 'idle') {
          handleStart()
        }
      } else if (e.code === 'Escape') {
        if (status === 'recording' || status === 'countdown') {
          e.preventDefault()
          e.stopPropagation()
          handleCancel()
        }
      }
    }

    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, status, useCountdown, muteProject, playTimeline, selectedDevice, targetTrackId])

  if (!open) return null

  const formatSec = (s: number) => {
    const mins = Math.floor(s / 60)
    const secs = Math.floor(s % 60)
    const ms = Math.floor((s % 1) * 100)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(mins)}:${pad(secs)}.${pad(ms)}`
  }

  return (
    <Modal open={open} onClose={() => { handleCancel(); onClose() }}>
      <div className="voice-rec-dialog">
        <div className="voice-rec-head">
          <div className="voice-rec-title">
            <Icon name="mic" size={18} />
            <span>{t('recVoiceTitle')}</span>
          </div>
          {status === 'recording' && (
            <div className="rec-live-badge">
              <span className="rec-dot" />
              <span>REC</span>
            </div>
          )}
        </div>

        {/* Live Visual Meter & Timer Area */}
        <div className="voice-rec-meter-box">
          {status === 'countdown' ? (
            <div className="voice-countdown-num">{countdownVal}</div>
          ) : (
            <>
              <div className="voice-timer-display">
                {status === 'recording' ? formatSec(recordedDuration) : formatSec(0)}
              </div>
              <div className="voice-meter-label">
                {status === 'recording' ? 'Йде запис звуку...' : t('recSpeakingHint')}
              </div>
              <div className="voice-meter-track">
                <div
                  className="voice-meter-bar"
                  style={{
                    width: `${Math.round(audioLevel * 100)}%`,
                    backgroundColor: audioLevel > 0.85 ? '#ff5252' : audioLevel > 0.6 ? '#ffca28' : '#4caf50'
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* Settings Area (visible when idle) */}
        {status === 'idle' && (
          <div className="voice-rec-settings">
            <div className="voice-setting-row">
              <label><Icon name="mic" size={14} /> {t('recDevice')}:</label>
              <select
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(e.target.value)}
                className="voice-select"
              >
                {devices.length === 0 ? (
                  <option value="">{t('recNoMic')}</option>
                ) : (
                  devices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Мікрофон ${i + 1}`}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="voice-setting-row">
              <label><Icon name="music" size={14} /> {t('recTargetTrack')}:</label>
              <select
                value={targetTrackId}
                onChange={(e) => setTargetTrackId(e.target.value)}
                className="voice-select"
              >
                <option value="">{t('recAutoTrack')}</option>
                {audioTracks.map((tr, i) => (
                  <option key={tr.id} value={tr.id}>
                    {tr.name || `Аудіодоріжка ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="voice-checkbox-grid">
              <label className="voice-checkbox-label">
                <input
                  type="checkbox"
                  checked={muteProject}
                  onChange={(e) => setMuteProject(e.target.checked)}
                />
                <span>{t('recMuteProject')}</span>
              </label>

              <label className="voice-checkbox-label">
                <input
                  type="checkbox"
                  checked={useCountdown}
                  onChange={(e) => setUseCountdown(e.target.checked)}
                />
                <span>{t('recCountdown')}</span>
              </label>

              <label className="voice-checkbox-label">
                <input
                  type="checkbox"
                  checked={playTimeline}
                  onChange={(e) => setPlayTimeline(e.target.checked)}
                />
                <span>{t('recPlayTimeline')}</span>
              </label>
            </div>
          </div>
        )}

        {error && (
          <div className="voice-rec-error">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </div>
        )}

        {savedNote && (
          <div className="voice-rec-success">
            <Icon name="check" size={15} />
            <span>{savedNote}</span>
          </div>
        )}

        {/* Action Controls */}
        <div className="voice-rec-actions">
          {status === 'idle' && (
            <button
              className="voice-btn-record"
              onClick={handleStart}
              disabled={devices.length === 0}
            >
              <span className="rec-circle-icon" />
              <span>{t('recStart')} (R)</span>
            </button>
          )}

          {status === 'countdown' && (
            <button className="voice-btn-cancel" onClick={handleCancel}>
              <Icon name="close" size={14} />
              <span>{t('recCancel')}</span>
            </button>
          )}

          {status === 'recording' && (
            <div className="voice-recording-actions">
              <button className="voice-btn-stop" onClick={handleStop}>
                <span className="rec-stop-icon" />
                <span>{t('recStop')} (Space)</span>
              </button>
              <button className="voice-btn-cancel" onClick={handleCancel}>
                <Icon name="close" size={14} />
                <span>{t('recCancel')}</span>
              </button>
            </div>
          )}

          {status === 'saving' && (
            <div className="voice-saving-state">
              <Spinner size={16} />
              <span>Збереження аудіо...</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
