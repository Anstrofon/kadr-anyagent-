import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './icons'
import type { AgentSettings } from '@shared/types'

export function AgentSettingsDialog({
  open,
  onClose,
  onSaved
}: {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}) {
  const [agent, setAgent] = useState<'opencode' | 'claude' | 'custom'>('opencode')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setSavedNote('')
    window.kadr.agentGetConfig().then((cfg) => {
      if (cfg) {
        setAgent(cfg.agent || 'opencode')
        setCommand(cfg.command || '')
        setArgs(Array.isArray(cfg.args) ? cfg.args.join(' ') : '')
        if (cfg.env && typeof cfg.env === 'object') {
          const lines = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`)
          setEnvVars(lines.join('\n'))
        } else {
          setEnvVars('')
        }
      }
    }).catch((err) => {
      setError(String(err))
    })
  }, [open])

  if (!open) return null

  const handleSave = async () => {
    setBusy(true)
    setError('')
    setSavedNote('')
    try {
      const parsedEnv: Record<string, string> = {}
      if (envVars.trim()) {
        for (const line of envVars.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eq = trimmed.indexOf('=')
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim()
            const val = trimmed.slice(eq + 1).trim()
            parsedEnv[key] = val
          }
        }
      }

      const parsedArgs = args.trim() ? args.trim().split(/\s+/) : undefined

      const cfg: AgentSettings = {
        agent,
        command: command.trim() || undefined,
        args: parsedArgs,
        env: Object.keys(parsedEnv).length ? parsedEnv : undefined
      }

      const res = await window.kadr.agentSaveConfig(cfg)
      if (res && res.error) {
        setError(res.error)
      } else {
        setSavedNote('Налаштування збережено')
        setTimeout(() => {
          onClose()
          onSaved?.()
        }, 600)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Налаштування AI Агента"
      titleIcon={<Icon name="settings" size={17} />}
      onClose={onClose}
      wide
      actions={
        <>
          <button onClick={onClose}>Скасувати</button>
          <button className="primary" disabled={busy} onClick={handleSave}>
            Зберегти та перезапустити
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label className="insp-field">
          <span style={{ minWidth: 120 }}>Тип агента:</span>
          <select
            value={agent}
            onChange={(e) => {
              const val = e.target.value as 'opencode' | 'claude' | 'custom'
              setAgent(val)
              if (val === 'opencode' && !command) setCommand('opencode')
              if (val === 'claude' && !command) setCommand('claude')
            }}
            style={{ flex: 1 }}
          >
            <option value="opencode">opencode (відкритий агент)</option>
            <option value="claude">Claude Code CLI</option>
            <option value="custom">Власна команда (Custom CLI)</option>
          </select>
        </label>

        <label className="insp-field">
          <span style={{ minWidth: 120 }}>Команда / шлях:</span>
          <input
            type="text"
            value={command}
            placeholder={agent === 'opencode' ? 'opencode (або повний шлях)' : agent === 'claude' ? 'claude' : 'назва команди'}
            onChange={(e) => setCommand(e.target.value)}
            style={{ flex: 1 }}
          />
        </label>
        <div className="dim hint-inline" style={{ marginTop: -8 }}>
          Залиште порожнім для пошуку у стандартному PATH, або вкажіть точний шлях (наприклад, <code>~/.local/bin/{agent}</code>).
        </div>

        <label className="insp-field">
          <span style={{ minWidth: 120 }}>Аргументи:</span>
          <input
            type="text"
            value={args}
            placeholder="додаткові параметри (необов'язково)"
            onChange={(e) => setArgs(e.target.value)}
            style={{ flex: 1 }}
          />
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Змінні оточення (KEY=VALUE):</span>
          <textarea
            rows={3}
            value={envVars}
            placeholder="OPENAI_API_KEY=sk-...&#10;HTTPS_PROXY=http://127.0.0.1:8080"
            onChange={(e) => setEnvVars(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          />
          <span className="dim hint-inline">
            Задає змінні середовища для дочірнього процесу агента.
          </span>
        </div>

        {error && (
          <div style={{ color: 'var(--c-danger, #f44)', fontSize: 13 }}>
            Помилка: {error}
          </div>
        )}

        {savedNote && (
          <div style={{ color: 'var(--c-accent, #3b82f6)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} /> {savedNote}
          </div>
        )}
      </div>
    </Modal>
  )
}
