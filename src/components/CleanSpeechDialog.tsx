import { useState, useMemo } from 'react'
import { Modal } from './Modal'
import { Icon, Spinner } from './icons'
import { useT } from '@/i18n'
import { useEditor, findClip } from '@/state/store'
import {
  useCleanSpeechUi,
  cleanSpeechForClip,
  CLEAN_SPEECH_DEFAULTS,
  type CleanSpeechOptions
} from '@/engine/cleanSpeech'

export function CleanSpeechDialog() {
  const t = useT()
  const open = useCleanSpeechUi((s) => s.open)
  const clipId = useCleanSpeechUi((s) => s.clipId)
  const busy = useCleanSpeechUi((s) => s.busy)
  const progress = useCleanSpeechUi((s) => s.progress)
  const lastResult = useCleanSpeechUi((s) => s.lastResult)
  const error = useCleanSpeechUi((s) => s.error)
  const close = useCleanSpeechUi((s) => s.close)

  const project = useEditor((s) => s.project)
  const targetClip = useMemo(() => {
    if (!clipId) return null
    const found = findClip(project, clipId)
    if (!found) return null
    const asset = found.clip.assetId ? project.assets.find((a) => a.id === found.clip.assetId) : null
    return { clip: found.clip, track: found.track, asset }
  }, [project, clipId])

  const [minSilence, setMinSilence] = useState(CLEAN_SPEECH_DEFAULTS.minSilence)
  const [targetSilence, setTargetSilence] = useState(CLEAN_SPEECH_DEFAULTS.targetSilence)
  const [breathMode, setBreathMode] = useState<'duck' | 'cut' | 'keep'>(CLEAN_SPEECH_DEFAULTS.breathMode)
  const [breathDuckDb, setBreathDuckDb] = useState(CLEAN_SPEECH_DEFAULTS.breathDuckDb)
  const [crossfadeMs, setCrossfadeMs] = useState(CLEAN_SPEECH_DEFAULTS.crossfadeMs)

  if (!open || !targetClip) return null

  const handleApply = async () => {
    if (!clipId) return
    const opts: CleanSpeechOptions = {
      minSilence,
      targetSilence,
      breathMode,
      breathDuckDb,
      crossfadeMs
    }
    try {
      await cleanSpeechForClip(clipId, opts)
    } catch {
      // Error is set in store
    }
  }

  const stageLabel = (stage: string) => {
    switch (stage) {
      case 'loading': return t('csStageLoading')
      case 'vad': return t('csStageVad')
      case 'analyzing_breaths': return t('csStageBreaths')
      case 'rendering': return t('csStageRendering')
      case 'saving': return t('csStageSaving')
      default: return t('csStageProcessing')
    }
  }

  return (
    <Modal
      title={t('csTitle')}
      onClose={close}
      closeDisabled={busy}
      titleIcon={<Icon name="scissors" size={16} />}
      actions={
        lastResult ? (
          <button className="primary" onClick={close}>
            {t('csDone')}
          </button>
        ) : (
          <>
            <button disabled={busy} onClick={close}>
              {t('cancel')}
            </button>
            <button className="primary" disabled={busy} onClick={handleApply}>
              {busy ? <Spinner size={14} /> : <Icon name="scissors" size={14} />}
              {' '}{busy ? t('csProcessing') : t('csApply')}
            </button>
          </>
        )
      }
    >
      <div className="clean-speech-body">
        {/* Clip info banner */}
        <div className="cs-clip-banner">
          <div className="cs-clip-name">
            <Icon name="music" size={14} />
            <span>{targetClip.clip.label || targetClip.asset?.name || 'Audio clip'}</span>
          </div>
          <div className="dim cs-clip-dur">
            {t('duration')}: {targetClip.clip.duration.toFixed(2)} с
          </div>
        </div>

        {lastResult ? (
          <div className="cs-result-card">
            <div className="cs-result-title">
              <Icon name="check" size={18} />
              <span>{t('csSuccessTitle')}</span>
            </div>
            <div className="cs-stats-grid">
              <div className="cs-stat-item">
                <span className="cs-stat-val">{lastResult.silencesShortened}</span>
                <span className="cs-stat-lbl">{t('csStatSilences')}</span>
              </div>
              <div className="cs-stat-item">
                <span className="cs-stat-val">
                  {lastResult.breathsDucked > 0 ? lastResult.breathsDucked : lastResult.breathsCut}
                </span>
                <span className="cs-stat-lbl">
                  {lastResult.breathsDucked > 0 ? t('csStatBreathsDucked') : t('csStatBreathsCut')}
                </span>
              </div>
              <div className="cs-stat-item highlight">
                <span className="cs-stat-val">-{lastResult.savedSeconds} с</span>
                <span className="cs-stat-lbl">{t('csStatSaved')}</span>
              </div>
            </div>
            <div className="dim cs-duration-flow">
              {lastResult.origDuration} с → <b>{lastResult.newDuration} с</b>
            </div>
          </div>
        ) : (
          <>
            {/* Busy Progress */}
            {busy && (
              <div className="cs-progress-block">
                <div className="cs-progress-header">
                  <span>{stageLabel(progress?.stage || '')}</span>
                  <span>{Math.round((progress?.progress ?? 0) * 100)}%</span>
                </div>
                <div className="cs-progress-bar">
                  <div
                    className="cs-progress-fill"
                    style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="tr-error">
                <Icon name="alert" size={15} />
                <span>{error}</span>
              </div>
            )}

            {/* Silence Shortening */}
            <div className="insp-section">
              <Icon name="split" size={13} /> {t('csSectionSilence')}
            </div>
            <div className="cs-row">
              <label className="insp-field">
                <span>{t('csMinSilence')}</span>
                <div className="cs-field-with-unit">
                  <input
                    type="number"
                    step={0.05}
                    min={0.15}
                    max={2.0}
                    value={minSilence}
                    disabled={busy}
                    onChange={(e) => setMinSilence(Math.max(0.1, Number(e.target.value)))}
                  />
                  <span className="dim">с</span>
                </div>
              </label>
              <label className="insp-field">
                <span>{t('csTargetSilence')}</span>
                <div className="cs-field-with-unit">
                  <input
                    type="number"
                    step={0.05}
                    min={0.0}
                    max={0.6}
                    value={targetSilence}
                    disabled={busy}
                    onChange={(e) => setTargetSilence(Math.max(0, Number(e.target.value)))}
                  />
                  <span className="dim">с</span>
                </div>
              </label>
            </div>
            <div className="dim cs-hint">
              {t('csSilenceHint')}
            </div>

            {/* Breath Cleanup */}
            <div className="insp-section" style={{ marginTop: 14 }}>
              <Icon name="speech" size={13} /> {t('csSectionBreaths')}
            </div>
            <div className="cs-mode-selector">
              <label className={`cs-mode-chip ${breathMode === 'duck' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="breathMode"
                  value="duck"
                  checked={breathMode === 'duck'}
                  disabled={busy}
                  onChange={() => setBreathMode('duck')}
                />
                <span className="cs-mode-title">{t('csBreathDuck')}</span>
                <span className="cs-mode-desc">{t('csBreathDuckDesc')}</span>
              </label>
              <label className={`cs-mode-chip ${breathMode === 'cut' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="breathMode"
                  value="cut"
                  checked={breathMode === 'cut'}
                  disabled={busy}
                  onChange={() => setBreathMode('cut')}
                />
                <span className="cs-mode-title">{t('csBreathCut')}</span>
                <span className="cs-mode-desc">{t('csBreathCutDesc')}</span>
              </label>
              <label className={`cs-mode-chip ${breathMode === 'keep' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="breathMode"
                  value="keep"
                  checked={breathMode === 'keep'}
                  disabled={busy}
                  onChange={() => setBreathMode('keep')}
                />
                <span className="cs-mode-title">{t('csBreathKeep')}</span>
                <span className="cs-mode-desc">{t('csBreathKeepDesc')}</span>
              </label>
            </div>

            {breathMode === 'duck' && (
              <label className="insp-field" style={{ marginTop: 10 }}>
                <span>{t('csBreathDuckLevel')}</span>
                <div className="cs-field-with-unit">
                  <input
                    type="range"
                    min={-36}
                    max={-6}
                    step={1}
                    value={breathDuckDb}
                    disabled={busy}
                    onChange={(e) => setBreathDuckDb(Number(e.target.value))}
                  />
                  <span className="cs-unit-badge">{breathDuckDb} dB</span>
                </div>
              </label>
            )}

            {/* Seams Crossfade */}
            <div className="insp-section" style={{ marginTop: 14 }}>
              <Icon name="sliders" size={13} /> {t('csSectionSeams')}
            </div>
            <label className="insp-field">
              <span>{t('csCrossfade')}</span>
              <div className="cs-field-with-unit">
                <input
                  type="number"
                  min={5}
                  max={50}
                  step={5}
                  value={crossfadeMs}
                  disabled={busy}
                  onChange={(e) => setCrossfadeMs(Math.max(2, Number(e.target.value)))}
                />
                <span className="dim">мс</span>
              </div>
            </label>
            <div className="dim cs-hint">
              {t('csCrossfadeHint')}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
