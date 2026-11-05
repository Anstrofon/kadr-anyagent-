import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { MotionTrackRequest, MotionTrackResult, MotionTrackProgress } from '@shared/types'

let currentProcess: ChildProcess | null = null

function projectVenv(): string {
  const venv = join(app.getAppPath(), '.venv', 'bin', 'python3')
  return existsSync(venv) ? venv : ''
}

function pythonForTracker(): string {
  const want = process.env.KADR_PYTHON || process.env.KADR_TRANSCRIBE_PYTHON
  if (want && want.trim()) return want.trim()
  return projectVenv() || 'python3'
}

export function registerMotionTrackerIpc(): void {
  ipcMain.handle('motion:track', async (event, req: MotionTrackRequest): Promise<MotionTrackResult> => {
    if (currentProcess) {
      try {
        currentProcess.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      currentProcess = null
    }

    const pyExe = pythonForTracker()
    const scriptPath = join(app.getAppPath(), 'scripts', 'track_motion.py')

    if (!existsSync(scriptPath)) {
      throw new Error(`Tracker script not found at ${scriptPath}`)
    }

    const boxStr = `${req.box.nx},${req.box.ny},${req.box.nw},${req.box.nh}`
    const args = [
      scriptPath,
      '--video', req.videoPath,
      '--start', String(req.start),
      '--end', String(req.end),
      '--box', boxStr,
      '--method', req.method || 'lk'
    ]
    if (req.fps && req.fps > 0) {
      args.push('--fps', String(req.fps))
    }

    return new Promise<MotionTrackResult>((resolve, reject) => {
      const child = spawn(pyExe, args, {
        cwd: app.getAppPath(),
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      })
      currentProcess = child

      let buffer = ''
      let result: MotionTrackResult | null = null
      let stderrOut = ''

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const data = JSON.parse(trimmed)
            if (data.type === 'progress') {
              const prog: MotionTrackProgress = {
                frame: data.frame,
                total: data.total,
                percent: data.percent,
                time: data.time,
                nx: data.nx,
                ny: data.ny
              }
              event.sender.send('motion:track-progress', prog)
            } else if (data.type === 'done') {
              result = {
                fps: data.fps ?? req.fps ?? 30,
                width: data.width ?? 1920,
                height: data.height ?? 1080,
                totalFrames: data.total ?? data.keyframes?.length ?? 0,
                keyframes: data.keyframes ?? []
              }
            } else if (data.type === 'error') {
              reject(new Error(data.message || 'Motion tracker failed'))
              return
            }
          } catch {
            /* ignore non-json lines */
          }
        }
      })

      child.stderr.on('data', (chunk) => {
        stderrOut += chunk.toString()
      })

      child.on('close', (code) => {
        if (currentProcess === child) currentProcess = null
        if (code === 0 && result) {
          resolve(result)
        } else if (code !== 0) {
          reject(new Error(`Tracker failed with code ${code}: ${stderrOut.slice(0, 500)}`))
        } else {
          reject(new Error('Tracker completed without returning result'))
        }
      })

      child.on('error', (err) => {
        if (currentProcess === child) currentProcess = null
        reject(err)
      })
    })
  })

  ipcMain.handle('motion:cancel', async () => {
    if (currentProcess) {
      try {
        currentProcess.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      currentProcess = null
    }
    return { ok: true }
  })
}
