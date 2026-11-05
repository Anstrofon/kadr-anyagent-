import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ImageSearchResult, ImageSearchOptions, ImageDownloadOptions } from '@shared/types'

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

function sanitizeFilename(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean.length > 80 ? clean.slice(0, 80).trim() : clean) || 'image'
}

function extFromMime(mime: string | null, url: string): string {
  if (mime) {
    if (mime.includes('png')) return 'png'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('svg')) return 'svg'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
    if (mime.includes('avif')) return 'avif'
  }
  const cleanUrl = url.split('?')[0].toLowerCase()
  for (const ext of ['png', 'webp', 'jpg', 'jpeg', 'gif', 'svg', 'avif']) {
    if (cleanUrl.endsWith(`.${ext}`)) return ext === 'jpeg' ? 'jpg' : ext
  }
  return 'jpg'
}

export function registerImageSearchIpc(): void {
  // 1. Search images (Google/Web or Pinterest)
  ipcMain.handle(
    'image:search',
    async (_e, opts: ImageSearchOptions): Promise<{ items: ImageSearchResult[]; error?: string }> => {
      const { query, source = 'web', page = 1 } = opts
      const trimmed = query.trim()
      if (!trimmed) return { items: [] }

      let fullQuery = trimmed
      if (source === 'pinterest') {
        fullQuery += ' site:pinterest.com'
      } else if (source === 'wallpapers') {
        fullQuery += ' 4k wallpaper background'
      } else if (source === 'transparent') {
        fullQuery += ' transparent png'
      }

      try {
        // Step 1: Extract vqd token from search page
        const tokenUrl = `https://duckduckgo.com/?q=${encodeURIComponent(fullQuery)}`
        const tokenRes = await fetch(tokenUrl, {
          headers: { 'User-Agent': USER_AGENT }
        })
        const html = await tokenRes.text()
        const vqdMatch = html.match(/vqd=([0-9-]+)/) || html.match(/vqd=["']([^"']+)["']/)
        if (!vqdMatch || !vqdMatch[1]) {
          return { items: [], error: 'Не вдалося ініціалізувати пошук (vqd token)' }
        }
        const vqd = vqdMatch[1]

        // Step 2: Query DuckDuckGo Images API
        const apiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(
          fullQuery
        )}&vqd=${vqd}&f=,,,;&p=${page}`
        const apiRes = await fetch(apiUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            Referer: 'https://duckduckgo.com/'
          }
        })

        if (!apiRes.ok) {
          return { items: [], error: `Помилка сервісу пошуку: HTTP ${apiRes.status}` }
        }

        const data: any = await apiRes.json()
        const rawResults = data.results || []

        const items: ImageSearchResult[] = rawResults.map((r: any, idx: number) => ({
          id: `img-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          title: r.title || trimmed,
          image: r.image,
          thumbnail: r.thumbnail || r.image,
          width: r.width || 0,
          height: r.height || 0,
          sourceUrl: r.url || '',
          domain: r.source || ''
        }))

        return { items }
      } catch (err: any) {
        return { items: [], error: err?.message || 'Помилка завантаження результатів пошуку' }
      }
    }
  )

  // 2. Download image to disk
  ipcMain.handle(
    'image:download',
    async (_e, opts: ImageDownloadOptions): Promise<{ path?: string; error?: string }> => {
      const { url, title, projectDir } = opts
      if (!url) return { error: 'Порожнє посилання на зображення' }

      let outDir = projectDir ? join(projectDir, 'media') : join(homedir(), 'kadr-downloads')
      try {
        await fs.mkdir(outDir, { recursive: true })
      } catch {
        outDir = join(app.getPath('userData'), 'imported')
        await fs.mkdir(outDir, { recursive: true })
      }

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Referer: url
          }
        })

        if (!res.ok) {
          return { error: `Не вдалося завантажити зображення: HTTP ${res.status}` }
        }

        const mime = res.headers.get('content-type')
        const ext = extFromMime(mime, url)
        const cleanName = sanitizeFilename(title || 'image')
        const filename = `${cleanName}_${Date.now().toString(36)}.${ext}`
        const filePath = join(outDir, filename)

        const arrayBuffer = await res.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        await fs.writeFile(filePath, buffer)

        return { path: filePath }
      } catch (err: any) {
        return { error: err?.message || 'Помилка під час збереження зображення' }
      }
    }
  )
}
