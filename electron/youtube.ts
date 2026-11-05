import { ipcMain, app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { promises as fs } from 'fs'
import { homedir } from 'os'

export interface YouTubeItem {
  id: string
  title: string
  duration: number
  uploader: string
  thumbnail: string
  url: string
}

export interface YouTubeDownloadOptions {
  url: string
  title: string
  startSec?: number
  endSec?: number
  audioOnly?: boolean
  projectDir?: string | null
}

function formatTimeSection(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const remS = s % 60
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`
  }
  return `00:${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80).trim() || 'youtube_clip'
}

export function registerYouTubeIpc() {
  // 1. Search or get video info
  ipcMain.handle('youtube:search', async (_e, queryOrUrl: string): Promise<{ items: YouTubeItem[]; error?: string }> => {
    const raw = queryOrUrl.trim()
    if (!raw) return { items: [] }

    const isUrl = /^https?:\/\//i.test(raw)
    const target = isUrl ? raw : `ytsearch5:${raw}`

    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', [
        '--dump-json',
        '--no-warnings',
        '--flat-playlist',
        '--default-search', 'ytsearch5',
        target
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d.toString('utf8') })
      proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })

      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          resolve({ items: [], error: stderr.slice(-300) || 'Помилка пошуку в yt-dlp' })
          return
        }

        const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
        const items: YouTubeItem[] = []

        for (const line of lines) {
          try {
            const data = JSON.parse(line)
            const id = data.id || ''
            const url = data.url && data.url.startsWith('http')
              ? data.url
              : `https://www.youtube.com/watch?v=${id}`
            const title = data.title || 'Untitled'
            const duration = Number(data.duration) || 0
            const uploader = data.uploader || data.channel || ''
            let thumbnail = ''
            if (Array.isArray(data.thumbnails) && data.thumbnails.length) {
              thumbnail = data.thumbnails[data.thumbnails.length - 1].url || ''
            } else if (data.thumbnail) {
              thumbnail = data.thumbnail
            } else if (id) {
              thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
            }

            items.push({ id, title, duration, uploader, thumbnail, url })
          } catch {
            // skip malformed line
          }
        }

        resolve({ items })
      })

      proc.on('error', (err) => {
        resolve({ items: [], error: String(err.message || err) })
      })
    })
  })

  // 2. Direct stream URL for HTML5 video preview
  ipcMain.handle('youtube:get-stream', async (_e, url: string): Promise<{ streamUrl?: string; error?: string }> => {
    return new Promise((resolve) => {
      // 18 is 360p/640x360 mp4 with audio, universally streamable in chromium
      const proc = spawn('yt-dlp', [
        '-g',
        '-f', '18/best[ext=mp4]/best',
        '--no-warnings',
        url.trim()
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let out = ''
      let err = ''
      proc.stdout.on('data', (d) => { out += d.toString('utf8') })
      proc.stderr.on('data', (d) => { err += d.toString('utf8') })

      proc.on('close', (code) => {
        const streamUrl = out.trim().split('\n')[0]
        if (code === 0 && streamUrl) {
          resolve({ streamUrl })
        } else {
          resolve({ error: err.slice(-300) || 'Не вдалося отримати відеопотік' })
        }
      })

      proc.on('error', (e) => {
        resolve({ error: String(e.message || e) })
      })
    })
  })

  // 3. Download trimmed section
  ipcMain.handle('youtube:download', async (e, opts: YouTubeDownloadOptions): Promise<{ path?: string; error?: string }> => {
    const { url, title, startSec, endSec, audioOnly, projectDir } = opts

    // target directory: projectDir/media or ~/kadr-downloads
    let outDir = projectDir ? join(projectDir, 'media') : join(homedir(), 'kadr-downloads')
    try {
      await fs.mkdir(outDir, { recursive: true })
    } catch {
      outDir = join(app.getPath('userData'), 'downloads')
      await fs.mkdir(outDir, { recursive: true })
    }

    const clean = sanitizeFilename(title)
    const hasCut = typeof startSec === 'number' && typeof endSec === 'number' && endSec > startSec
    const tag = hasCut ? `_${Math.floor(startSec)}s-${Math.floor(endSec)}s` : ''
    const ext = audioOnly ? 'mp3' : 'mp4'
    const outPath = join(outDir, `${clean}${tag}.${ext}`)

    const args: string[] = ['--no-warnings']

    if (hasCut) {
      const s0 = formatTimeSection(startSec!)
      const s1 = formatTimeSection(endSec!)
      args.push('--download-sections', `*${s0}-${s1}`, '--force-keyframes-at-cuts')
    }

    if (audioOnly) {
      args.push('-x', '--audio-format', 'mp3')
    } else {
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best')
      args.push('--merge-output-format', 'mp4')
    }

    args.push('-o', outPath, url)

    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stderr = ''

      proc.stdout.on('data', (d) => {
        const str = d.toString('utf8')
        // parse progress percent: [download]  45.2% of 12.34MiB at 5.00MiB/s ETA 00:02
        const match = str.match(/\[download\]\s+([\d.]+)%/)
        if (match) {
          const percent = parseFloat(match[1])
          e.sender.send('youtube:progress', { percent, status: str.trim() })
        }
      })

      proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })

      proc.on('close', (code) => {
        if (code === 0) {
          e.sender.send('youtube:progress', { percent: 100, status: 'Завершено' })
          resolve({ path: outPath })
        } else {
          resolve({ error: stderr.slice(-400) || `yt-dlp завершився з кодом ${code}` })
        }
      })

      proc.on('error', (err) => {
        resolve({ error: String(err.message || err) })
      })
    })
  })
}
