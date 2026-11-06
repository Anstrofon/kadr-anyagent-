import { useEditor } from '@/state/store'
import { dirOf } from '@shared/paths'

/**
 * Standard 16-bit PCM Mono WAV encoder.
 * Extremely fast, zero-dependency, and lossless.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  // RIFF header
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')

  // fmt subchunk
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // SubChunk1Size (16 for PCM)
  view.setUint16(20, 1, true) // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true) // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true) // SampleRate
  view.setUint32(28, sampleRate * 2, true) // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true) // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true) // BitsPerSample (16 bits)

  // data subchunk
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // Write PCM 16-bit samples
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}

export interface VoiceRecorderSession {
  stop(): Promise<{ wav: Uint8Array; duration: number; sampleRate: number }>
  cancel(): void
  getCurrentDuration(): number
}

export interface StartRecorderOpts {
  deviceId?: string
  onLevel?: (rms: number, peak: number) => void
}

/**
 * Capture microphone audio via Web Audio API.
 * Uses 48 kHz standard sample rate.
 */
export async function startVoiceRecording(opts: StartRecorderOpts = {}): Promise<VoiceRecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000
    }
  })

  const audioCtx = new AudioContext({ sampleRate: 48000 })
  const source = audioCtx.createMediaStreamSource(stream)
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)

  // ScriptProcessor to capture chunks
  const bufferSize = 4096
  const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1)
  const chunks: Float32Array[] = []
  let totalSamples = 0
  let isRecording = true
  const startTime = performance.now()

  processor.onaudioprocess = (e) => {
    if (!isRecording) return
    const input = e.inputBuffer.getChannelData(0)
    const copy = new Float32Array(input.length)
    copy.set(input)
    chunks.push(copy)
    totalSamples += copy.length

    if (opts.onLevel) {
      let sum = 0
      let peak = 0
      for (let i = 0; i < input.length; i++) {
        const abs = Math.abs(input[i])
        if (abs > peak) peak = abs
        sum += abs * abs
      }
      const rms = Math.sqrt(sum / input.length)
      opts.onLevel(Math.min(1, rms * 3), Math.min(1, peak))
    }
  }

  // Dummy mute gain to keep processor running without audio feedback loop
  const muteNode = audioCtx.createGain()
  muteNode.gain.value = 0
  source.connect(processor)
  processor.connect(muteNode)
  muteNode.connect(audioCtx.destination)

  const cleanup = () => {
    isRecording = false
    try { processor.disconnect() } catch { /* ignore */ }
    try { source.disconnect() } catch { /* ignore */ }
    try { analyser.disconnect() } catch { /* ignore */ }
    try { muteNode.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop())
    void audioCtx.close().catch(() => {})
  }

  return {
    getCurrentDuration: () => (performance.now() - startTime) / 1000,
    cancel: () => {
      cleanup()
    },
    stop: async () => {
      isRecording = false
      cleanup()

      const merged = new Float32Array(totalSamples)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }

      const sampleRate = audioCtx.sampleRate || 48000
      const duration = totalSamples / sampleRate
      const wav = encodeWav(merged, sampleRate)
      return { wav, duration, sampleRate }
    }
  }
}

/**
 * Save recorded WAV to project/userData and insert onto the timeline at `at`.
 */
export async function saveVoiceoverClip({
  wavData,
  duration,
  at,
  trackId,
  label
}: {
  wavData: Uint8Array
  duration: number
  at: number
  trackId?: string | null
  label?: string
}): Promise<{ clipId: string; trackId: string; assetId: string; path: string }> {
  const st = useEditor.getState()
  const projectPath = st.projectPath
  const projectDir = projectPath ? dirOf(projectPath) : null

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const baseName = `voiceover_${dateStr}`

  // Save WAV to disk via Electron main
  const path = await window.kadr.voiceoverSave(projectDir, baseName, wavData)

  // Probe media to register as an asset
  const probe = await window.kadr.probeMedia(path)

  const clipLabel = label?.trim() || `Голос ${pad(now.getHours())}:${pad(now.getMinutes())}`

  // Place on target track or next free audio track
  const placed = st.placeAudio(probe.asset, at, {
    label: clipLabel,
    history: 'hSpeak',
    trackId: trackId || undefined
  })

  // Select the newly created clip
  if (placed.clipId) {
    useEditor.setState({ selection: [placed.clipId], playhead: at + duration })
  }

  return { ...placed, path }
}
