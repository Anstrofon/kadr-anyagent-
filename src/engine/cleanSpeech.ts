// Speech cleanup engine: silence shortening and breath detection/removal.
import { create } from 'zustand'
import { useEditor, findClip, uid } from '@/state/store'
import type { CleanSpeechRequest, CleanSpeechResult, MediaAsset } from '@shared/types'

export interface CleanSpeechOptions {
  minSilence: number // seconds, e.g. 0.4
  targetSilence: number // seconds, e.g. 0.2
  breathMode: 'duck' | 'cut' | 'keep'
  breathDuckDb: number // e.g. -18
  crossfadeMs: number // e.g. 15
}

export const CLEAN_SPEECH_DEFAULTS: CleanSpeechOptions = {
  minSilence: 0.40,
  targetSilence: 0.20,
  breathMode: 'duck',
  breathDuckDb: -18.0,
  crossfadeMs: 15.0
}

interface CleanSpeechUiState {
  open: boolean
  clipId: string | null
  busy: boolean
  progress: { progress: number; stage: string } | null
  lastResult: CleanSpeechResult | null
  error: string | null
  openWithClip: (clipId: string) => void
  close: () => void
  setBusy: (busy: boolean) => void
  setProgress: (p: { progress: number; stage: string } | null) => void
  setLastResult: (r: CleanSpeechResult | null) => void
  setError: (err: string | null) => void
}

export const useCleanSpeechUi = create<CleanSpeechUiState>((set) => ({
  open: false,
  clipId: null,
  busy: false,
  progress: null,
  lastResult: null,
  error: null,
  openWithClip: (clipId) => set({ open: true, clipId, error: null, lastResult: null, progress: null }),
  close: () => set({ open: false, clipId: null, busy: false, progress: null, error: null }),
  setBusy: (busy) => set({ busy }),
  setProgress: (progress) => set({ progress }),
  setLastResult: (lastResult) => set({ lastResult }),
  setError: (error) => set({ error })
}))

export async function cleanSpeechForClip(
  clipId: string,
  options: CleanSpeechOptions
): Promise<CleanSpeechResult> {
  const st = useEditor.getState()
  const found = findClip(st.project, clipId)
  if (!found) throw new Error('Кліп не знайдено')

  const clip = found.clip
  const asset = clip.assetId ? st.project.assets.find((a) => a.id === clip.assetId) : null
  if (!asset?.hasAudio) throw new Error('Кліп не містить аудіо')

  const ui = useCleanSpeechUi.getState()
  ui.setBusy(true)
  ui.setError(null)
  ui.setProgress({ progress: 0.05, stage: 'start' })

  const unlisten = window.kadr.onCleanSpeechProgress((p) => {
    ui.setProgress(p)
  })

  try {
    const res = await window.kadr.cleanSpeech({
      audioPath: asset.path,
      minSilence: options.minSilence,
      targetSilence: options.targetSilence,
      breathMode: options.breathMode,
      breathDuckDb: options.breathDuckDb,
      crossfadeMs: options.crossfadeMs
    })

    const probe = await window.kadr.probeMedia(res.outputPath)
    const baseName = asset.name.replace(/\.[^/.]+$/, '')
    const newAsset: MediaAsset = {
      id: uid(),
      ...probe.asset,
      name: `${baseName} ✂️.wav`
    }

    const cur = useEditor.getState()
    cur.pushHistory('hCleanSpeech')
    cur.addAsset(newAsset)

    // Adjust clip duration to new cleaned audio duration
    const newDur = Math.max(0.1, res.newDuration)
    cur.updateClip(clip.id, {
      assetId: newAsset.id,
      inPoint: 0,
      duration: newDur
    })

    ui.setLastResult(res)
    return res
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    ui.setError(msg)
    throw err
  } finally {
    unlisten()
    ui.setBusy(false)
  }
}
