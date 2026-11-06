import { useEffect, useMemo, useRef, useState } from 'react'
import type { Anim, Clip, Effect, FragmentInspect, FragmentParamDecl, FxPreset, TextStyle } from '@shared/types'
import { useEditor, useFxPresets, findClip, uid } from '@/state/store'
import { GLOW_DEFAULTS } from '@/gl/glow'
import { COLOR_GRADE_DEFAULTS, COLOR_LOOK_PRESETS, type ColorGradeParams } from '@/gl/colorGrade'
import { useT } from '@/i18n'
import { bakeAudio, bakeState, bakePlan } from '@/engine/audioReact'
import { audibleTracksInRange } from '@/engine/subtitles'
import { useFragmentParams, paramValues, setParam, resetParams, rememberParamValues } from '@/engine/fragmentParams'
import { CtxMenu } from './CtxMenu'
import { Icon, Spinner } from './icons'
import { useCleanSpeechUi } from '@/engine/cleanSpeech'

function Num({
  label, value, step = 1, min, max, onChange
}: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="insp-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(3))}
        step={step}
        min={min}
        max={max}
        onFocus={() => useEditor.getState().pushHistory('hEdit')}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) onChange(v)
        }}
      />
    </label>
  )
}

export function Inspector() {
  const t = useT()
  const clipId = useEditor((s) => s.selection[0])
  const found = useEditor((s) => (clipId ? findClip(s.project, clipId) : null))

  return (
    <div className="inspector">
      <div className="panel-head">
        <span>{t('inspector')}</span>
      </div>
      <div className="insp-body">
        {found ? <ClipProps clip={found.clip} /> : <ProjectProps />}
      </div>
    </div>
  )
}

function ProjectProps() {
  const t = useT()
  const project = useEditor((s) => s.project)
  const patch = (p: Partial<typeof project>) =>
    useEditor.setState((s) => ({ project: { ...s.project, ...p } }))

  return (
    <>
      <div className="insp-section">{t('projectSettings')}</div>
      <label className="insp-field">
        <span>{t('label')}</span>
        <input value={project.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <Num label={`${t('resolution')} W`} value={project.width} step={2} min={16}
        onChange={(v) => patch({ width: Math.round(v / 2) * 2 })} />
      <Num label={`${t('resolution')} H`} value={project.height} step={2} min={16}
        onChange={(v) => patch({ height: Math.round(v / 2) * 2 })} />
      <Num label={t('framerate')} value={project.fps} step={1} min={1} max={120}
        onChange={(v) => patch({ fps: v })} />
    </>
  )
}

function ClipProps({ clip }: { clip: Clip }) {
  const t = useT()
  const update = (patch: Partial<Clip>) => useEditor.getState().updateClip(clip.id, patch)
  const setAnim = (key: keyof Clip['transform'], v: number) =>
    update({ transform: { ...clip.transform, [key]: { ...clip.transform[key], value: v } } })
  const setGain = (v: number) => update({ gain: { ...clip.gain, value: v } as Anim })
  const setStyle = (patch: Partial<TextStyle>) =>
    update({ textStyle: { ...clip.textStyle!, ...patch } })

  return (
    <>
      <div className="insp-section">{clip.label ?? t('clipName')}</div>
      {clip.kind === 'text' && clip.textStyle && (
        <>
          <label className="insp-field tall">
            <span>{t('text')}</span>
            <textarea
              rows={3}
              value={clip.text ?? ''}
              onFocus={() => useEditor.getState().pushHistory('hEdit')}
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          <Num label={t('fontSize')} value={clip.textStyle.fontSize} min={8} max={500}
            onChange={(v) => setStyle({ fontSize: v })} />
          <label className="insp-field">
            <span>{t('color')}</span>
            <input type="color" value={clip.textStyle.color}
              onChange={(e) => setStyle({ color: e.target.value })} />
          </label>
          <label className="insp-field">
            <span>{t('outline')}</span>
            <input type="color" value={clip.textStyle.outlineColor}
              onChange={(e) => setStyle({ outlineColor: e.target.value })} />
          </label>
          <Num label={`${t('outline')} px`} value={clip.textStyle.outlineWidth} min={0} max={40}
            onChange={(v) => setStyle({ outlineWidth: v })} />
          <label className="insp-field">
            <span>{t('bold')}</span>
            <input type="checkbox" checked={clip.textStyle.bold}
              onChange={(e) => setStyle({ bold: e.target.checked })} />
          </label>
        </>
      )}
      <div className="insp-section">{t('position')}</div>
      <Num label="X" value={clip.transform.x.value} onChange={(v) => setAnim('x', v)} />
      <Num label="Y" value={clip.transform.y.value} onChange={(v) => setAnim('y', v)} />
      <Num label={t('scale')} value={clip.transform.scale.value} step={0.05} min={0.01} max={20}
        onChange={(v) => setAnim('scale', v)} />
      <Num label={t('rotation')} value={clip.transform.rotation.value} step={1}
        onChange={(v) => setAnim('rotation', v)} />
      <Num label={t('opacity')} value={clip.transform.opacity.value} step={0.05} min={0} max={1}
        onChange={(v) => setAnim('opacity', v)} />
      <div className="insp-section">{t('volume')}</div>
      <Num label={t('volume')} value={clip.gain.value} step={0.05} min={0} max={2} onChange={setGain} />
      <label className="insp-field">
        <span>{t('muted')}</span>
        <input type="checkbox" checked={clip.muted}
          onChange={(e) => update({ muted: e.target.checked })} />
      </label>
      {(() => {
        const p = useEditor.getState().project
        const a = clip.assetId ? p.assets.find((x) => x.id === clip.assetId) : null
        if (!a?.hasAudio) return null
        return (
          <button
            style={{ marginTop: 6 }}
            data-act="clean-speech"
            onClick={() => useCleanSpeechUi.getState().openWithClip(clip.id)}
          >
            <Icon name="scissors" size={14} /> {t('cleanSpeech')}
          </button>
        )
      })()}
      {clip.kind === 'remotion' && <FragmentParamsSection clip={clip} />}
      {clip.kind === 'remotion' && <AudioReactSection clip={clip} />}
      <EffectsSection clip={clip} />
    </>
  )
}

/**
 * «Реакция на звук»: bake the sound under a fragment into its folder
 * (audio.json + audio.ts, see src/engine/audioReact.ts) so the composition can
 * move with the music. Shows whether the bake still matches what is under the
 * clip — a moved clip or an edited track makes it stale.
 */
function AudioReactSection({ clip }: { clip: Clip }) {
  const t = useT()
  const project = useEditor((s) => s.project)
  const [source, setSource] = useState(clip.audioBake?.source ?? 'mix')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setSource(clip.audioBake?.source ?? 'mix')
    setNote('')
    setError('')
  }, [clip.id])
  const plan = useMemo(() => bakePlan(project, clip, 'mix'), [project, clip])
  const tracks = useMemo(
    // the tracks heard under the composition itself, not in the analysis context around it
    () => (plan ? audibleTracksInRange(project, Math.max(0, plan.t0), plan.t0 + plan.frames * plan.step) : []),
    [project, plan]
  )
  const state = bakeState(project, clip)
  const src = source === 'mix' || tracks.some((tr) => tr.id === source) ? source : 'mix'

  const bake = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await bakeAudio(clip.id, { source: src })
      setNote(r.audible
        ? t('arDone').replace('{bpm}', r.bpm.toFixed(1)).replace('{n}', String(r.beats))
        : t('arSilent'))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="insp-section"><Icon name="reactive" size={13} /> {t('arTitle')}</div>
      <div className={`ar-state ${state}`} data-ar-state={state}>
        {state === 'none' ? t('arNone') : state === 'fresh' ? t('arFresh') : t('arStale')}
      </div>
      <label className="insp-field">
        <span>{t('arSource')}</span>
        <select value={src} disabled={busy} onChange={(e) => setSource(e.target.value)} data-act="ar-source">
          <option value="mix">{t('arMix')}</option>
          {tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
        </select>
      </label>
      <button data-act="ar-bake" disabled={busy} onClick={bake}>
        {busy ? <Spinner /> : <Icon name="reactive" />}{' '}
        {busy ? t('arWorking') : state === 'none' ? t('arBake') : t('arRebake')}
      </button>
      {note && <div className="dim">{note}</div>}
      {error && <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>}
      <div className="dim ar-hint">{t('arHint')}</div>
    </>
  )
}

/**
 * The fragment's own parameters (defineParams in @kadr/runtime): sliders that
 * move the preview live and are saved into the fragment's params.json.
 */
function FragmentParamsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const fid = clip.fragmentId!
  const [ins, setIns] = useState<FragmentInspect | null>(null)
  const [loading, setLoading] = useState(false)
  const [gen, setGen] = useState(0)
  useFragmentParams((s) => s.live[fid]) // re-render while a value is dragged
  useEffect(() => {
    let alive = true
    setLoading(true)
    window.kadr.fragmentInspect(fid)
      .then((r) => {
        if (!alive) return
        if (r.ok) rememberParamValues(fid, r.paramValues)
        setIns(r)
      })
      .catch((e) => { if (alive) setIns({ ok: false, error: String((e as Error)?.message ?? e) }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fid, gen])
  const decl: Record<string, FragmentParamDecl> = ins?.ok ? ins.params ?? {} : {}
  const names = Object.keys(decl)
  const values = paramValues(fid, decl, ins?.ok ? ins.paramValues : undefined)
  const set = (k: string, v: number | boolean | string) => setParam(fid, k, v)
  return (
    <>
      <div className="insp-section">
        <Icon name="sliders" size={13} /> {t('fpTitle')}
        <button className="fx-del fp-reload" data-act="fp-reload" aria-label={t('fpReload')} title={t('fpReload')}
          disabled={loading} onClick={() => setGen((g) => g + 1)}>
          {loading ? <Spinner /> : <Icon name="reload" size={13} />}
        </button>
      </div>
      {ins && !ins.ok && <div className="tr-error"><Icon name="alert" size={15} /><span>{ins.error.split('\n')[0]}</span></div>}
      {ins?.ok && !names.length && <div className="dim ar-hint">{t('fpNone')}</div>}
      {names.map((k) => {
        const d = decl[k]
        const v = values[k]
        const label = d.label || k
        if (typeof d.value === 'boolean') {
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type="checkbox" checked={v === true} onChange={(e) => set(k, e.target.checked)} />
            </label>
          )
        }
        if (typeof d.value === 'string') {
          const color = /^#[0-9a-f]{6}$/i.test(String(d.value))
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type={color ? 'color' : 'text'} value={String(v)} onChange={(e) => set(k, e.target.value)} />
            </label>
          )
        }
        const n = Number(v)
        const step = d.step ?? (d.min != null && d.max != null ? (d.max - d.min) / 200 : 0.01)
        const ranged = d.min != null && d.max != null && d.max > d.min
        const digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)))
        return (
          <label key={k} className="insp-field fx-slider fp-num" data-param={k}>
            <span>{label}</span>
            {ranged && (
              <input type="range" value={n} min={d.min} max={d.max} step={step}
                onChange={(e) => set(k, Number(e.target.value))} />
            )}
            <input type="number" value={Number(n.toFixed(digits))} step={step} min={d.min} max={d.max}
              onChange={(e) => { const x = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(x)) set(k, x) }} />
          </label>
        )
      })}
      {names.length > 0 && (
        <button data-act="fp-reset" onClick={() => void resetParams(fid)}>{t('fpReset')}</button>
      )}
    </>
  )
}

function Slider({
  label, value, min, max, step, onChange, onReset, unit = ''
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onReset?: () => void
  unit?: string
}) {
  return (
    <label className="insp-field fx-slider">
      <span onDoubleClick={onReset} title={onReset ? 'Подвійний клік для скидання' : undefined}>{label}</span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onPointerDown={() => useEditor.getState().pushHistory('hEffect')}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fx-val" onDoubleClick={onReset} title={onReset ? 'Подвійний клік для скидання' : undefined}>
        {Number(value.toFixed(2))}{unit}
      </span>
    </label>
  )
}

function EffectsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [name, setName] = useState('')
  const fxPresets = useFxPresets((s) => s.presets)
  const update = (effects: Effect[]) => useEditor.getState().updateClip(clip.id, { effects })
  const effects = clip.effects ?? []
  const addColorGrading = () => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: 'colorGrading', enabled: true, params: { ...COLOR_GRADE_DEFAULTS } }])
  }
  const addGlow = () => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: 'glow', enabled: true, params: { ...GLOW_DEFAULTS } }])
  }
  const addBlur = () => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: 'blur', enabled: true, params: { size: 20 } }])
  }
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])
  // selection moved to another clip — the open menu refers to stale effects
  useEffect(() => setMenu(null), [clip.id])
  const saveFx = () => {
    const nm = name.trim()
    if (!nm || !effects.length) return
    useFxPresets.getState().savePreset({
      name: nm,
      effects: effects.map((e) => ({ ...e, params: { ...e.params } }))
    })
    setName('')
  }
  const applyFx = (p: FxPreset) => {
    useEditor.getState().pushHistory('hPreset')
    update(p.effects.map((e) => ({ ...e, id: uid(), params: { ...e.params } })))
    setMenu(null)
  }
  return (
    <>
      <div className="insp-section fx-section-head">
        <span>{t('effects')}</span>
        <button
          className={`fx-preset-btn${menu ? ' active' : ''}`}
          data-act="fx-presets"
          title={t('fxPresetsHint')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { x: r.left, y: r.bottom + 4 })
          }}
        >
          <Icon name="star" size={12} /> {t('presets')}
        </button>
      </div>
      {effects.map((fx) =>
        fx.type === 'colorGrading' ? (
          <ColorGradingControls key={fx.id} clip={clip} fx={fx} />
        ) : fx.type === 'glow' ? (
          <GlowControls key={fx.id} clip={clip} fx={fx} />
        ) : fx.type === 'blur' ? (
          <BlurControls key={fx.id} clip={clip} fx={fx} />
        ) : null
      )}
      {!effects.some((e) => e.type === 'colorGrading') && (
        <button className="fx-add" data-act="add-color-grading" onClick={addColorGrading}>
          <Icon name="plus" size={13} /> <Icon name="palette" size={14} /> {t('fxColorGrading')}
        </button>
      )}
      {!effects.some((e) => e.type === 'glow') && (
        <button className="fx-add" data-act="add-glow" onClick={addGlow}>
          <Icon name="plus" size={13} /> <Icon name="glow" size={14} /> {t('fxGlow')}
        </button>
      )}
      {!effects.some((e) => e.type === 'blur') && (
        <button className="fx-add" data-act="add-blur" onClick={addBlur}>
          <Icon name="plus" size={13} /> <Icon name="blur" size={14} /> {t('fxBlur')}
        </button>
      )}
      {menu && (
        <CtxMenu x={menu.x} y={menu.y} className="preset-menu fx-preset-menu">
          <div className="ctx-title dim">{t('presets')} — {t('effects')}</div>
          {fxPresets.length === 0 && <div className="ctx-empty dim">{t('noPresets')}</div>}
          {fxPresets.map((p) => (
            <div className="preset-item" key={p.id}>
              <button onClick={() => applyFx(p)}>{p.name}</button>
              <button
                className="preset-del"
                title={t('deletePreset')}
                aria-label={t('deletePreset')}
                onClick={() => useFxPresets.getState().deletePreset(p.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <div className="preset-save-row">
            <input
              value={name}
              placeholder={t('presetName')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveFx()
              }}
            />
            <button disabled={!name.trim() || !effects.length} onClick={saveFx}>
              {t('presetSave')}
            </button>
          </div>
        </CtxMenu>
      )}
    </>
  )
}

function BlurControls({ clip, fx }: { clip: Clip; fx: Effect }) {
  const t = useT()
  const st = () => useEditor.getState()
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, {
      effects: (clip.effects ?? []).map((e) => (e.id === fx.id ? { ...e, ...patch } : e))
    })
  const size = typeof fx.params.size === 'number' ? fx.params.size : 20
  return (
    <div className="fx-block">
      <div className="fx-head">
        <label>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              st().pushHistory('hEffect')
              patchFx({ enabled: e.target.checked })
            }}
          />
          <span><Icon name="blur" size={14} /> {t('fxBlur')}</span>
        </label>
        <button
          className="fx-del"
          title={t('fxDelete')}
          onClick={() => {
            st().pushHistory('hEffect')
            st().updateClip(clip.id, {
              effects: (clip.effects ?? []).filter((e) => e.id !== fx.id)
            })
          }}
          aria-label={t('fxDelete')}
        ><Icon name="trash" size={14} /></button>
      </div>
      <Slider label={t('fxBlurSize')} value={size} min={0} max={300} step={1}
        onChange={(v) => patchFx({ params: { ...fx.params, size: v } })} />
    </div>
  )
}

function GlowControls({ clip, fx }: { clip: Clip; fx: Effect }) {
  const t = useT()
  const st = () => useEditor.getState()
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, {
      effects: (clip.effects ?? []).map((e) => (e.id === fx.id ? { ...e, ...patch } : e))
    })
  const setP = (key: string, v: number | string) =>
    patchFx({ params: { ...fx.params, [key]: v } })
  const num = (key: keyof typeof GLOW_DEFAULTS) => {
    const v = fx.params[key]
    return typeof v === 'number' ? v : (GLOW_DEFAULTS[key] as number)
  }
  return (
    <div className="fx-block">
      <div className="fx-head">
        <label>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              st().pushHistory('hEffect')
              patchFx({ enabled: e.target.checked })
            }}
          />
          <span><Icon name="glow" size={14} /> {t('fxGlow')}</span>
        </label>
        <button
          className="fx-del"
          title={t('fxDelete')}
          onClick={() => {
            st().pushHistory('hEffect')
            st().updateClip(clip.id, {
              effects: (clip.effects ?? []).filter((e) => e.id !== fx.id)
            })
          }}
          aria-label={t('fxDelete')}
        ><Icon name="trash" size={14} /></button>
      </div>
      <label className="insp-field">
        <span>{t('color')}</span>
        <input
          type="color"
          value={typeof fx.params.color === 'string' ? fx.params.color : GLOW_DEFAULTS.color}
          onFocus={() => st().pushHistory('hEffect')}
          onChange={(e) => setP('color', e.target.value)}
        />
      </label>
      <Slider label={t('fxSize')} value={num('size')} min={4} max={400} step={1}
        onChange={(v) => setP('size', v)} />
      <Slider label={t('fxIntensity')} value={num('intensity')} min={0} max={3} step={0.05}
        onChange={(v) => setP('intensity', v)} />
      <Slider label={t('fxSaturation')} value={num('saturation')} min={0} max={2} step={0.05}
        onChange={(v) => setP('saturation', v)} />
      <Slider label={t('fxSmoke')} value={num('smoke')} min={0} max={1} step={0.05}
        onChange={(v) => setP('smoke', v)} />
      <Slider label={t('fxSpeed')} value={num('speed')} min={0} max={3} step={0.05}
        onChange={(v) => setP('speed', v)} />
      <Slider label={t('fxParticles')} value={num('particles')} min={0} max={1} step={0.05}
        onChange={(v) => setP('particles', v)} />
    </div>
  )
}

function ColorGradingControls({ clip, fx }: { clip: Clip; fx: Effect }) {
  const t = useT()
  const st = () => useEditor.getState()
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, {
      effects: (clip.effects ?? []).map((e) => (e.id === fx.id ? { ...e, ...patch } : e))
    })
  const setP = (key: keyof ColorGradeParams, v: number) =>
    patchFx({ params: { ...fx.params, [key]: v } })
  const num = (key: keyof ColorGradeParams) => {
    const v = fx.params[key]
    return typeof v === 'number' ? v : COLOR_GRADE_DEFAULTS[key]
  }

  const applyLook = (lookParams: Partial<ColorGradeParams>) => {
    st().pushHistory('hEffect')
    patchFx({
      params: {
        ...COLOR_GRADE_DEFAULTS,
        ...lookParams
      }
    })
  }

  const resetAll = () => {
    st().pushHistory('hEffect')
    patchFx({ params: { ...COLOR_GRADE_DEFAULTS } })
  }

  const [tab, setTab] = useState<'wheels' | 'sliders'>('wheels')

  return (
    <div className="fx-block cg-block">
      <div className="fx-head">
        <label>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              st().pushHistory('hEffect')
              patchFx({ enabled: e.target.checked })
            }}
          />
          <span><Icon name="palette" size={14} /> {t('fxColorGrading')}</span>
        </label>
        <div className="fx-head-actions">
          <button
            className="fx-action-btn"
            title={t('cgReset')}
            aria-label={t('cgReset')}
            onClick={resetAll}
          >
            <Icon name="again" size={13} />
          </button>
          <button
            className="fx-del"
            title={t('fxDelete')}
            onClick={() => {
              st().pushHistory('hEffect')
              st().updateClip(clip.id, {
                effects: (clip.effects ?? []).filter((e) => e.id !== fx.id)
              })
            }}
            aria-label={t('fxDelete')}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {/* Creative Looks / Presets */}
      <div className="cg-group">
        <div className="cg-group-title dim">{t('cgLooks')}</div>
        <div className="cg-presets-row">
          {COLOR_LOOK_PRESETS.map((p) => (
            <button
              key={p.id}
              className="cg-preset-pill"
              onClick={() => applyLook(p.params)}
            >
              {t(p.nameKey as Parameters<typeof t>[0]) || p.name}
            </button>
          ))}
        </div>
      </div>

      {/* View Tabs: Color Wheels vs Sliders */}
      <div className="cg-tab-row">
        <button
          type="button"
          className={`cg-tab-btn${tab === 'wheels' ? ' active' : ''}`}
          onClick={() => setTab('wheels')}
        >
          <Icon name="palette" size={13} /> {t('cgTabWheels')}
        </button>
        <button
          type="button"
          className={`cg-tab-btn${tab === 'sliders' ? ' active' : ''}`}
          onClick={() => setTab('sliders')}
        >
          <Icon name="sliders" size={13} /> {t('cgTabSliders')}
        </button>
      </div>

      {tab === 'wheels' ? (
        <div className="cg-wheels-section">
          <div className="cg-wheels-container">
            <ColorWheel
              label={t('cgShadowsWheel')}
              x={num('shadowsX')}
              y={num('shadowsY')}
              luma={num('shadowsLuma')}
              onChange={(x, y, luma) => {
                patchFx({ params: { ...fx.params, shadowsX: x, shadowsY: y, shadowsLuma: luma } })
              }}
              onReset={() => {
                st().pushHistory('hEffect')
                patchFx({ params: { ...fx.params, shadowsX: 0, shadowsY: 0, shadowsLuma: 0 } })
              }}
            />
            <ColorWheel
              label={t('cgMidtonesWheel')}
              x={num('midtonesX')}
              y={num('midtonesY')}
              luma={num('midtonesLuma')}
              onChange={(x, y, luma) => {
                patchFx({ params: { ...fx.params, midtonesX: x, midtonesY: y, midtonesLuma: luma } })
              }}
              onReset={() => {
                st().pushHistory('hEffect')
                patchFx({ params: { ...fx.params, midtonesX: 0, midtonesY: 0, midtonesLuma: 0 } })
              }}
            />
            <ColorWheel
              label={t('cgHighlightsWheel')}
              x={num('highlightsX')}
              y={num('highlightsY')}
              luma={num('highlightsLuma')}
              onChange={(x, y, luma) => {
                patchFx({ params: { ...fx.params, highlightsX: x, highlightsY: y, highlightsLuma: luma } })
              }}
              onReset={() => {
                st().pushHistory('hEffect')
                patchFx({ params: { ...fx.params, highlightsX: 0, highlightsY: 0, highlightsLuma: 0 } })
              }}
            />
          </div>

          {/* Quick Tone & Saturation adjustment under wheels */}
          <div className="cg-group">
            <Slider
              label={t('cgExposure')}
              value={num('exposure')}
              min={-3}
              max={3}
              step={0.05}
              unit=" EV"
              onChange={(v) => setP('exposure', v)}
              onReset={() => setP('exposure', 0)}
            />
            <Slider
              label={t('cgContrast')}
              value={num('contrast')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('contrast', v)}
              onReset={() => setP('contrast', 0)}
            />
            <Slider
              label={t('cgSaturation')}
              value={num('saturation')}
              min={0}
              max={200}
              step={1}
              unit="%"
              onChange={(v) => setP('saturation', v)}
              onReset={() => setP('saturation', 100)}
            />
          </div>
        </div>
      ) : (
        <div className="cg-sliders-section">
          {/* White Balance */}
          <div className="cg-group">
            <div className="cg-group-title">{t('cgWhiteBalance')}</div>
            <Slider
              label={t('cgTemperature')}
              value={num('temperature')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('temperature', v)}
              onReset={() => setP('temperature', 0)}
            />
            <Slider
              label={t('cgTint')}
              value={num('tint')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('tint', v)}
              onReset={() => setP('tint', 0)}
            />
          </div>

          {/* Tone */}
          <div className="cg-group">
            <div className="cg-group-title">{t('cgTone')}</div>
            <Slider
              label={t('cgExposure')}
              value={num('exposure')}
              min={-3}
              max={3}
              step={0.05}
              unit=" EV"
              onChange={(v) => setP('exposure', v)}
              onReset={() => setP('exposure', 0)}
            />
            <Slider
              label={t('cgContrast')}
              value={num('contrast')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('contrast', v)}
              onReset={() => setP('contrast', 0)}
            />
            <Slider
              label={t('cgHighlights')}
              value={num('highlights')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('highlights', v)}
              onReset={() => setP('highlights', 0)}
            />
            <Slider
              label={t('cgShadows')}
              value={num('shadows')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('shadows', v)}
              onReset={() => setP('shadows', 0)}
            />
            <Slider
              label={t('cgWhites')}
              value={num('whites')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('whites', v)}
              onReset={() => setP('whites', 0)}
            />
            <Slider
              label={t('cgBlacks')}
              value={num('blacks')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('blacks', v)}
              onReset={() => setP('blacks', 0)}
            />
          </div>

          {/* Color */}
          <div className="cg-group">
            <div className="cg-group-title">{t('cgColorSection')}</div>
            <Slider
              label={t('cgSaturation')}
              value={num('saturation')}
              min={0}
              max={200}
              step={1}
              unit="%"
              onChange={(v) => setP('saturation', v)}
              onReset={() => setP('saturation', 100)}
            />
            <Slider
              label={t('cgVibrance')}
              value={num('vibrance')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('vibrance', v)}
              onReset={() => setP('vibrance', 0)}
            />
            <Slider
              label={t('cgHue')}
              value={num('hue')}
              min={-180}
              max={180}
              step={1}
              unit="°"
              onChange={(v) => setP('hue', v)}
              onReset={() => setP('hue', 0)}
            />
            <Slider
              label={t('cgGamma')}
              value={num('gamma')}
              min={0.2}
              max={3.0}
              step={0.05}
              onChange={(v) => setP('gamma', v)}
              onReset={() => setP('gamma', 1.0)}
            />
          </div>

          {/* Vignette */}
          <div className="cg-group">
            <div className="cg-group-title">{t('cgVignetteSection')}</div>
            <Slider
              label={t('cgVignette')}
              value={num('vignette')}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => setP('vignette', v)}
              onReset={() => setP('vignette', 0)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function ColorWheel({
  label,
  x,
  y,
  luma,
  onChange,
  onReset
}: {
  label: string
  x: number
  y: number
  luma: number
  onChange: (x: number, y: number, luma: number) => void
  onReset: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

  const handlePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const r = rect.width / 2
    const cx = rect.left + r
    const cy = rect.top + r
    let dx = (e.clientX - cx) / r
    let dy = (e.clientY - cy) / r
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > 1.0) {
      dx /= dist
      dy /= dist
    }
    onChange(Number(dx.toFixed(3)), Number(dy.toFixed(3)), luma)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isDragging.current = true
    useEditor.getState().pushHistory('hEffect')
    handlePointer(e)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    handlePointer(e)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    isDragging.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }

  // Calculate puck position in percent
  const leftPct = (x * 0.5 + 0.5) * 100
  const topPct = (y * 0.5 + 0.5) * 100

  // Calculate puck color preview
  const dist = Math.min(1.0, Math.sqrt(x * x + y * y))
  const angle = Math.atan2(y, x)
  const hueDeg = Math.round(((angle / (2 * Math.PI) + 1.0) % 1.0) * 360)
  const puckColor = dist < 0.01 ? '#ffffff' : `hsl(${hueDeg}, 100%, 65%)`

  return (
    <div className="cg-wheel-card">
      <div className="cg-wheel-head">
        <span className="cg-wheel-title">{label}</span>
        <button
          type="button"
          className="cg-wheel-reset"
          title={t('cgResetWheel')}
          onClick={onReset}
        >
          <Icon name="again" size={11} />
        </button>
      </div>
      <div
        ref={ref}
        className="cg-wheel-disc"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onReset}
        title="Перетягніть для зміни відтінку; подвійний клік для скидання"
      >
        <div className="cg-wheel-crosshair-h" />
        <div className="cg-wheel-crosshair-v" />
        <div className="cg-wheel-ring-inner" />
        <div
          className="cg-wheel-puck"
          style={{
            left: `${leftPct}%`,
            top: `${topPct}%`,
            backgroundColor: puckColor,
            borderColor: dist > 0.05 ? '#ffffff' : '#aaaaaa'
          }}
        />
      </div>
      <div className="cg-wheel-luma">
        <span className="dim">{t('cgWheelLuma')}</span>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={luma}
          onPointerDown={() => useEditor.getState().pushHistory('hEffect')}
          onChange={(e) => onChange(x, y, Number(e.target.value))}
          onDoubleClick={() => onChange(x, y, 0)}
          title="Подвійний клік для скидання"
        />
        <span className="fx-val" onDoubleClick={() => onChange(x, y, 0)}>{luma}</span>
      </div>
    </div>
  )
}

