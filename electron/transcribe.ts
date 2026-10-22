// Transcription backend: mix the requested audio to a temp wav (the same
// segment graph as exports — what you hear is what gets transcribed), then
// run faster-whisper via scripts/transcribe.py, streaming progress and live
// text to the renderer. One job at a time.
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { promises as fs, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ExportMuxer, mixdownWav } from './ffmpeg'
import type { TranscribeRequest, TranscribeResult, TranscribeSegment } from '@shared/types'

let current: { muxer: ExportMuxer | null; py: ChildProcess | null; cancelled: boolean } | null = null

/**
 * Interpreter for scripts/transcribe.py. Distributions with a "managed"
 * python3 (Arch among them) refuse pip installs outside a venv, so the usual
 * place for faster-whisper is a project venv; prefer an explicit
 * KADR_TRANSCRIBE_PYTHON, then <app>/.venv, then an activated venv / system
 * python3 from PATH. The venv is not inside a packaged app (asar), so there
 * this simply falls through.
 */
function projectVenv(): string {
  const venv = join(app.getAppPath(), '.venv', 'bin', 'python3')
  return existsSync(venv) ? venv : ''
}

function pythonForTranscribe(): string {
  const want = process.env.KADR_TRANSCRIBE_PYTHON
  if (want && want.trim()) return want.trim()
  return projectVenv() || 'python3'
}

/**
 * CUDA runtime installed as wheels (python/requirements-cuda.txt) lives inside
 * the venv, not in the system loader path. CTranslate2 dlopens libcublas.so.12
 * and libcudnn.so.9 by soname, so their folders must be on LD_LIBRARY_PATH
 * when the interpreter starts.
 */
function venvNvidiaLibs(venvPython: string): string {
  const root = join(venvPython, '..', '..', 'lib')
  const dirs: string[] = []
  try {
    for (const py of readdirSync(root)) {
      const nvidia = join(root, py, 'site-packages', 'nvidia')
      if (!existsSync(nvidia)) continue
      for (const pkg of readdirSync(nvidia)) {
        const lib = join(nvidia, pkg, 'lib')
        if (existsSync(lib)) dirs.push(lib)
      }
    }
  } catch { /* CPU-only venv */ }
  return dirs.join(':')
}

/**
 * Where faster-whisper keeps its models. With a project venv the project is
 * self-contained, so the models belong on the same disk as it: the default
 * ~/.cache/huggingface may be a small home partition, and large-v3 alone is
 * ~3 GB. An explicit HF_HOME in the environment always wins.
 */
function transcribeEnv(): NodeJS.ProcessEnv {
  const py = projectVenv()
  if (!py) return process.env
  const env = { ...process.env }
  if (!env.HF_HOME) env.HF_HOME = join(app.getAppPath(), 'python', 'cache', 'huggingface')
  const cuda = venvNvidiaLibs(py)
  if (cuda) env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${cuda}:${env.LD_LIBRARY_PATH}` : cuda
  return env
}

async function run(win: BrowserWindow, req: TranscribeRequest): Promise<TranscribeResult> {
  if (current) throw new Error('transcription already running')
  const job = { muxer: null as ExportMuxer | null, py: null as ChildProcess | null, cancelled: false }
  current = job
  const wav = join(tmpdir(), `kadr-transcribe-${Date.now()}.wav`)
  const send = (progress: number, text: string) =>
    win.webContents.send('transcribe:progress', { progress, text })

  try {
    // 1) mixdown — ExportMuxer with an audio-only pcm preset writes a wav
    send(0.01, '')
    await mixdownWav(req.audioSegments, req.duration, wav, (m) => { job.muxer = m })
    job.muxer = null
    if (job.cancelled) throw new Error('cancelled')

    // 2) whisper
    const segments: TranscribeSegment[] = []
    let language = req.language
    let liveText = ''
    await new Promise<void>((resolve, reject) => {
      const py = spawn(pythonForTranscribe(), [
        join(app.getAppPath(), 'scripts', 'transcribe.py'),
        '--audio', wav,
        '--model', req.model,
        '--language', req.language,
        '--duration', String(req.duration)
      ], { env: transcribeEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      job.py = py
      let buf = ''
      let err = ''
      py.stdout.on('data', (c) => {
        buf += c
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'segment') {
              segments.push({ start: msg.start, end: msg.end, text: msg.text, words: msg.words })
              liveText = msg.text
            } else if (msg.type === 'progress') {
              send(Math.min(0.99, msg.p), liveText)
            } else if (msg.type === 'done') {
              language = msg.language
            }
          } catch { /* partial line */ }
        }
      })
      py.stderr.on('data', (c) => { err += c })
      py.on('error', reject)
      py.on('close', (code) => {
        job.py = null
        if (job.cancelled) reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(err.slice(0, 800) || `transcribe.py exited ${code}`))
      })
    })
    send(1, '')
    return { segments, language, duration: req.duration }
  } finally {
    current = null
    fs.unlink(wav).catch(() => { /* never created */ })
  }
}

export function registerTranscribeIpc(getWin: () => BrowserWindow | null) {
  ipcMain.handle('transcribe:run', (_e, req: TranscribeRequest) => {
    const win = getWin()
    if (!win) throw new Error('no window')
    return run(win, req)
  })
  ipcMain.handle('transcribe:cancel', () => {
    if (!current) return
    current.cancelled = true
    current.muxer?.cancel()
    current.py?.kill('SIGKILL')
  })

  // plain text IO for transcript files
  ipcMain.handle('file:read-text', async (_e, path: string) => {
    try {
      return await fs.readFile(path, 'utf8')
    } catch {
      return null
    }
  })
  ipcMain.handle('file:write-text', (_e, path: string, content: string) =>
    fs.writeFile(path, content, 'utf8')
  )
  ipcMain.handle('file:stat', async (_e, path: string) => {
    try {
      return (await fs.stat(path)).mtimeMs
    } catch {
      return null
    }
  })
}
