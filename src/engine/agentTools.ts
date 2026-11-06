// High-level tools exposed to AI agents via MCP bridge.
import { useEditor, findClip, uid } from '@/state/store'
import { cleanSpeechForClip, CLEAN_SPEECH_DEFAULTS, type CleanSpeechOptions } from './cleanSpeech'
import { COLOR_GRADE_DEFAULTS, COLOR_LOOK_PRESETS, type ColorGradeParams } from '@/gl/colorGrade'
import type {
  YouTubeDownloadOptions,
  ImageDownloadOptions,
  MediaAsset,
  Effect,
  MotionTrackResult,
  Keyframe
} from '@shared/types'

export async function applyColorGrade(
  clipId: string,
  options: { preset?: string; params?: Partial<ColorGradeParams> }
) {
  const st = useEditor.getState()
  const found = findClip(st.project, clipId)
  if (!found) throw new Error(`Clip ${clipId} not found`)

  const presetValues = options.preset && (COLOR_LOOK_PRESETS as any)[options.preset]
    ? (COLOR_LOOK_PRESETS as any)[options.preset]
    : {}

  const mergedParams: ColorGradeParams = {
    ...COLOR_GRADE_DEFAULTS,
    ...presetValues,
    ...(options.params || {})
  }

  st.pushHistory('hEffect')
  const clip = found.clip
  const effects = [...(clip.effects || [])]
  const existingIdx = effects.findIndex((e) => e.type === 'colorGrade')

  const fx: Effect = {
    id: existingIdx !== -1 ? effects[existingIdx].id : uid(),
    type: 'colorGrade',
    enabled: true,
    params: mergedParams
  }

  if (existingIdx !== -1) {
    effects[existingIdx] = fx
  } else {
    effects.push(fx)
  }

  st.updateClip(clip.id, { effects })
  return { clipId, effectId: fx.id, params: mergedParams }
}

export async function downloadYouTubeMedia(
  opts: YouTubeDownloadOptions,
  placement?: { insertOnTimeline?: boolean; trackId?: string; at?: number }
) {
  const st = useEditor.getState()
  const projectDir = st.projectPath ? st.projectPath.replace(/\/[^/]+$/, '') : null

  const res = await window.kadr.ytDownload({
    ...opts,
    projectDir: opts.projectDir || projectDir
  })

  if (res.error || !res.path) {
    throw new Error(res.error || 'Failed to download YouTube media')
  }

  const { asset: probed } = await window.kadr.probeMedia(res.path)
  const newAsset: MediaAsset = {
    id: uid(),
    ...probed,
    name: opts.title || probed.name
  }

  st.pushHistory('hInsert')
  st.addAsset(newAsset)

  let insertedClipId: string | null = null
  if (placement?.insertOnTimeline) {
    const isAudio = newAsset.kind === 'audio' || !!opts.audioOnly
    let targetTrack = placement.trackId
      ? st.project.tracks.find((t) => t.id === placement.trackId)
      : st.project.tracks.find((t) => t.kind === (isAudio ? 'audio' : 'video'))

    if (!targetTrack) {
      targetTrack = st.addTrack(isAudio ? 'audio' : 'video')
    }

    const atTime = typeof placement.at === 'number' ? placement.at : st.playhead
    st.insertClipFromAsset(newAsset.id, targetTrack.id, atTime)

    // find newly created clip
    const updated = useEditor.getState()
    const foundTrack = updated.project.tracks.find((t) => t.id === targetTrack!.id)
    const newClip = foundTrack?.clips.find((c) => c.assetId === newAsset.id && Math.abs(c.start - atTime) < 0.05)
    insertedClipId = newClip?.id || null
  }

  return {
    asset: newAsset,
    insertedClipId
  }
}

export async function downloadAndImportImage(
  opts: ImageDownloadOptions,
  placement?: { insertOnTimeline?: boolean; trackId?: string; at?: number; duration?: number }
) {
  const st = useEditor.getState()
  const projectDir = st.projectPath ? st.projectPath.replace(/\/[^/]+$/, '') : null

  const res = await window.kadr.imageDownload({
    ...opts,
    projectDir: opts.projectDir || projectDir
  })

  if (res.error || !res.path) {
    throw new Error(res.error || 'Failed to download image')
  }

  const { asset: probed } = await window.kadr.probeMedia(res.path)
  const newAsset: MediaAsset = {
    id: uid(),
    ...probed,
    name: opts.title || probed.name
  }

  st.pushHistory('hInsert')
  st.addAsset(newAsset)

  let insertedClipId: string | null = null
  if (placement?.insertOnTimeline) {
    let targetTrack = placement.trackId
      ? st.project.tracks.find((t) => t.id === placement.trackId)
      : st.project.tracks.find((t) => t.kind === 'video')

    if (!targetTrack) {
      targetTrack = st.addTrack('video')
    }

    const atTime = typeof placement.at === 'number' ? placement.at : st.playhead
    st.insertClipFromAsset(newAsset.id, targetTrack.id, atTime)

    const updated = useEditor.getState()
    const foundTrack = updated.project.tracks.find((t) => t.id === targetTrack!.id)
    const newClip = foundTrack?.clips.find((c) => c.assetId === newAsset.id && Math.abs(c.start - atTime) < 0.05)
    if (newClip && placement.duration && placement.duration > 0) {
      updated.updateClip(newClip.id, { duration: placement.duration })
    }
    insertedClipId = newClip?.id || null
  }

  return {
    asset: newAsset,
    insertedClipId
  }
}

export async function motionTrackAndBind(
  sourceClipId: string,
  box: { nx: number; ny: number; nw: number; nh: number },
  opts?: {
    targetClipId?: string
    startSec?: number
    endSec?: number
    method?: 'lk' | 'template' | 'mil'
  }
): Promise<{ result: MotionTrackResult; boundTargetClipId?: string }> {
  const st = useEditor.getState()
  const found = findClip(st.project, sourceClipId)
  if (!found) throw new Error(`Source clip ${sourceClipId} not found`)

  const asset = found.clip.assetId ? st.project.assets.find((a) => a.id === found.clip.assetId) : null
  if (!asset || asset.kind !== 'video') {
    throw new Error(`Clip ${sourceClipId} is not a video media clip`)
  }

  const mediaStart = (found.clip.inPoint || 0) + (opts?.startSec ?? 0)
  const duration = typeof opts?.endSec === 'number'
    ? opts.endSec - (opts.startSec ?? 0)
    : found.clip.duration
  const mediaEnd = mediaStart + duration

  const res = await window.kadr.motionTrack({
    videoPath: asset.path,
    start: mediaStart,
    end: mediaEnd,
    box,
    method: opts?.method || 'lk',
    fps: asset.fps || 30
  })

  if (res.error) {
    throw new Error(res.error)
  }

  if (opts?.targetClipId && res.keyframes && res.keyframes.length > 0) {
    const targetFound = findClip(st.project, opts.targetClipId)
    if (targetFound) {
      const projW = st.project.width || 1920
      const projH = st.project.height || 1080

      const keyframesX: Keyframe[] = []
      const keyframesY: Keyframe[] = []

      for (const kf of res.keyframes) {
        // Map normalized coordinates 0..1 to centered project coordinates (-W/2..W/2, -H/2..H/2)
        const posX = Math.round((kf.nx - 0.5) * projW)
        const posY = Math.round((kf.ny - 0.5) * projH)

        keyframesX.push({
          time: kf.time,
          value: posX,
          easing: 'linear'
        })
        keyframesY.push({
          time: kf.time,
          value: posY,
          easing: 'linear'
        })
      }

      st.pushHistory('hKeyframe')
      st.updateClip(targetFound.clip.id, {
        transform: {
          ...targetFound.clip.transform,
          x: {
            ...targetFound.clip.transform.x,
            keyframes: keyframesX
          },
          y: {
            ...targetFound.clip.transform.y,
            keyframes: keyframesY
          }
        }
      })
    }
  }

  return {
    result: res,
    boundTargetClipId: opts?.targetClipId
  }
}
