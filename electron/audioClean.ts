// Automated speech cleanup (silence shortening & breath removal).
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import type { CleanSpeechRequest, CleanSpeechResult } from '@shared/types'

let currentCleanJob: { py: ChildProcess | null; cancelled: boolean } | null = null

function projectVenv(): string {
  const venv = join(app.getAppPath(), '.venv', 'bin', 'python3')
  return existsSync(venv) ? venv : ''
}

function pythonForClean(): string {
  const want = process.env.KADR_TRANSCRIBE_PYTHON || process.env.KADR_TTSQC_PYTHON
  if (want && want.trim()) return want.trim()
  return projectVenv() || 'python3'
}

export function registerAudioCleanIpc(getWin: () => BrowserWindow | null) {
  ipcMain.handle('audio:clean-speech', async (_e, req: CleanSpeechRequest): Promise<CleanSpeechResult> => {
    if (currentCleanJob?.py) {
      throw new Error('Очищення аудіо вже виконується')
    }

    const job = { py: null as ChildProcess | null, cancelled: false }
    currentCleanJob = job

    const send = (progress: number, stage: string) => {
      const win = getWin()
      if (win && !win.isDestroyed()) {
        win.webContents.send('audio:clean-progress', { progress, stage })
      }
    }

    send(0.02, 'start')

    const outDir = join(app.getPath('userData'), 'cleaned-audio')
    await fs.mkdir(outDir, { recursive: true })

    const nameStem = basename(req.audioPath, extname(req.audioPath)).replace(/[^\p{L}\p{N}._-]/gu, '') || 'audio'
    const outPath = join(outDir, `${nameStem}-clean-${Date.now()}.wav`)

    const pyScript = join(app.getAppPath(), 'scripts', 'clean_speech.py')
    const pythonBin = pythonForClean()

    const args = [
      pyScript,
      '--input', req.audioPath,
      '--output', outPath,
      '--min-silence', String(req.minSilence ?? 0.40),
      '--target-silence', String(req.targetSilence ?? 0.20),
      '--breath-mode', req.breathMode || 'duck',
      '--breath-duck-db', String(req.breathDuckDb ?? -18.0),
      '--crossfade-ms', String(req.crossfadeMs ?? 15.0)
    ]

    return new Promise<CleanSpeechResult>((resolve, reject) => {
      const py = spawn(pythonBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1'
        }
      })
      job.py = py

      let buf = ''
      let errBuf = ''
      let result: CleanSpeechResult | null = null

      py.stdout.on('data', (chunk) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'progress') {
              send(Math.min(0.99, Number(msg.p) || 0), String(msg.stage || ''))
            } else if (msg.type === 'done') {
              result = {
                outputPath: msg.output,
                silencesShortened: msg.silences_shortened || 0,
                breathsDucked: msg.breaths_ducked || 0,
                breathsCut: msg.breaths_cut || 0,
                origDuration: msg.orig_duration || 0,
                newDuration: msg.new_duration || 0,
                savedSeconds: msg.saved_s || 0
              }
            } else if (msg.type === 'error') {
              errBuf += msg.message || ''
            }
          } catch {
            /* ignore non-json line */
          }
        }
      })

      py.stderr.on('data', (chunk) => {
        errBuf += chunk
      })

      py.on('error', (err) => {
        currentCleanJob = null
        reject(err)
      })

      py.on('close', (code) => {
        currentCleanJob = null
        if (code === 0 && result) {
          send(1.0, 'done')
          resolve(result)
        } else {
          reject(new Error(errBuf.slice(-600).trim() || `clean_speech.py exited with code ${code}`))
        }
      })
    })
  })
}
