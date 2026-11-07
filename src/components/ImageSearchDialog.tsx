import { useState } from 'react'
import { Modal } from './Modal'
import { Icon, Spinner } from './icons'
import { useEditor } from '@/state/store'
import { importFiles } from '@/engine/mediaImport'
import { dirOf } from '@shared/paths'
import type { ImageSearchResult } from '@shared/types'

type SearchSource = 'web' | 'pinterest' | 'wallpapers' | 'transparent'

const QUICK_SUGGESTIONS = [
  'Аніме пейзаж',
  'Неонове місто',
  'Ретро кіберпанк',
  'Темний абстрактний фон',
  'Текстура паперу',
  'Космос галактика',
  'Мінімалізм 4k',
  'Стікери png'
]

export function ImageSearchDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SearchSource>('web')
  const [items, setItems] = useState<ImageSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ImageSearchResult | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importedSuccess, setImportedSuccess] = useState<string | null>(null)

  const handleSearch = async (overrideQuery?: string, overrideSource?: SearchSource) => {
    const q = (overrideQuery !== undefined ? overrideQuery : query).trim()
    if (!q) return
    const s = overrideSource || source

    setSearching(true)
    setError('')
    setSelected(null)
    setImportedSuccess(null)

    try {
      const res = await window.kadr.imageSearch({
        query: q,
        source: s
      })
      if (res.error) {
        setError(res.error)
        setItems([])
      } else {
        setItems(res.items || [])
        if ((res.items || []).length === 0) {
          setError('За вашим запитом нічого не знайдено. Спробуйте інший пошуковий запит.')
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Помилка під час пошуку зображень')
      setItems([])
    } finally {
      setSearching(false)
    }
  }

  const handleImport = async (item: ImageSearchResult) => {
    if (importingId) return
    setImportingId(item.id)
    setError('')
    setImportedSuccess(null)

    try {
      const projectPath = useEditor.getState().projectPath
      const projectDir = projectPath ? dirOf(projectPath) : null

      const res = await window.kadr.imageDownload({
        url: item.image,
        title: item.title,
        projectDir
      })

      if (res.error || !res.path) {
        setError(res.error || 'Не вдалося завантажити зображення')
        return
      }

      await importFiles([res.path], null)
      setImportedSuccess(item.id)
      setTimeout(() => {
        setImportedSuccess(null)
      }, 3500)
    } catch (err: any) {
      setError(err?.message || 'Помилка імпорту зображення')
    } finally {
      setImportingId(null)
    }
  }

  if (!open) return null

  return (
    <Modal
      title="Пошук та імпорт зображень (Google, Pinterest)"
      titleIcon={<Icon name="camera" size={18} />}
      wide
      className="image-search-dialog"
      onClose={onClose}
    >
      <div className="img-search-wrapper">
        {/* Search Bar & Source Tabs */}
        <div className="img-search-header">
          <form
            className="img-search-form"
            onSubmit={(e) => {
              e.preventDefault()
              handleSearch()
            }}
          >
            <div className="img-input-wrap">
              <Icon name="search" size={16} />
              <input
                type="text"
                className="img-search-input"
                placeholder="Введіть запит (наприклад: neon cat, anime wallpaper, cyberpunk, texture)..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {query && (
                <button
                  type="button"
                  className="img-clear-btn"
                  onClick={() => setQuery('')}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
            <button
              type="submit"
              className="img-submit-btn"
              disabled={searching || !query.trim()}
            >
              {searching ? <Spinner size={14} /> : <Icon name="search" size={14} />}
              <span>Знайти</span>
            </button>
          </form>

          {/* Source filters */}
          <div className="img-source-pills">
            <button
              type="button"
              className={`img-pill ${source === 'web' ? 'active' : ''}`}
              onClick={() => {
                setSource('web')
                if (query.trim()) handleSearch(query, 'web')
              }}
            >
              🌐 Google / Web
            </button>
            <button
              type="button"
              className={`img-pill ${source === 'pinterest' ? 'active' : ''}`}
              onClick={() => {
                setSource('pinterest')
                if (query.trim()) handleSearch(query, 'pinterest')
              }}
            >
              📌 Pinterest
            </button>
            <button
              type="button"
              className={`img-pill ${source === 'wallpapers' ? 'active' : ''}`}
              onClick={() => {
                setSource('wallpapers')
                if (query.trim()) handleSearch(query, 'wallpapers')
              }}
            >
              🖼 Шпалери (4K)
            </button>
            <button
              type="button"
              className={`img-pill ${source === 'transparent' ? 'active' : ''}`}
              onClick={() => {
                setSource('transparent')
                if (query.trim()) handleSearch(query, 'transparent')
              }}
            >
              ✨ PNG (Без фону)
            </button>
          </div>
        </div>

        {/* Quick suggestions when query is empty */}
        {items.length === 0 && !searching && (
          <div className="img-suggestions-box">
            <div className="suggestions-label">Популярні ідеї для відео:</div>
            <div className="suggestions-list">
              {QUICK_SUGGESTIONS.map((sug) => (
                <button
                  key={sug}
                  type="button"
                  className="suggestion-tag"
                  onClick={() => {
                    setQuery(sug)
                    handleSearch(sug)
                  }}
                >
                  {sug}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="img-error-bar">
            <Icon name="alert" size={14} /> {error}
          </div>
        )}

        {searching && (
          <div className="img-searching-state">
            <Spinner size={28} />
            <span>Шукаємо зображення високої якості...</span>
          </div>
        )}

        {/* Main Grid & Preview Area */}
        {items.length > 0 && (
          <div className="img-results-layout">
            <div className="img-grid-scroller">
              <div className="img-grid">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`img-card ${selected?.id === item.id ? 'active' : ''}`}
                    onClick={() => setSelected(item)}
                  >
                    <div className="img-thumb-container">
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        loading="lazy"
                        onError={(e) => {
                          // fallback to direct image
                          ;(e.target as HTMLImageElement).src = item.image
                        }}
                      />
                      {item.width && item.height ? (
                        <span className="img-res-badge">
                          {item.width}×{item.height}
                        </span>
                      ) : null}
                    </div>
                    <div className="img-card-info">
                      <span className="img-card-title" title={item.title}>
                        {item.title}
                      </span>
                      <button
                        type="button"
                        className="img-card-import-btn"
                        disabled={importingId === item.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleImport(item)
                        }}
                        title="Імпортувати в проект"
                      >
                        {importingId === item.id ? (
                          <Spinner size={12} />
                        ) : importedSuccess === item.id ? (
                          <Icon name="check" size={12} />
                        ) : (
                          <Icon name="download" size={12} />
                        )}
                        <span>
                          {importedSuccess === item.id
                            ? 'Додано'
                            : importingId === item.id
                            ? '...'
                            : 'В проект'}
                        </span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Selected Image Full Preview Panel */}
            {selected && (
              <div className="img-preview-panel">
                <div className="img-preview-head">
                  <div className="img-preview-title" title={selected.title}>
                    {selected.title}
                  </div>
                  <button
                    type="button"
                    className="img-preview-close"
                    onClick={() => setSelected(null)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>

                <div className="img-preview-view">
                  <img src={selected.image} alt={selected.title} />
                </div>

                <div className="img-preview-meta">
                  {selected.width && selected.height ? (
                    <div className="meta-item">
                      <span className="meta-lbl">Розмір:</span>
                      <span className="meta-val">
                        {selected.width} × {selected.height} px
                      </span>
                    </div>
                  ) : null}
                  {selected.domain ? (
                    <div className="meta-item">
                      <span className="meta-lbl">Джерело:</span>
                      <span className="meta-val">{selected.domain}</span>
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="img-preview-import-btn"
                  disabled={importingId === selected.id}
                  onClick={() => handleImport(selected)}
                >
                  {importingId === selected.id ? (
                    <Spinner size={15} />
                  ) : importedSuccess === selected.id ? (
                    <Icon name="check" size={15} />
                  ) : (
                    <Icon name="download" size={15} />
                  )}
                  <span>
                    {importedSuccess === selected.id
                      ? '✓ Додано в медіатеку!'
                      : importingId === selected.id
                      ? 'Завантажуємо фото...'
                      : 'Імпортувати в проект'}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
