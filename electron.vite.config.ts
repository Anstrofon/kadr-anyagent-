import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'

// Electron's GPU process is forked from a zygote that starts BEFORE main.ts
// runs, so the EGL vendor for the discrete GPU (electron/gpu.ts) has to be in
// the environment the app is launched with — and this file runs in exactly
// that process. It may only be set when gpu.ts actually chose the discrete
// card: under Wayland Chromium composites through EGL, and pointing EGL at
// NVIDIA while the window's buffers come from the integrated GPU that drives
// the display makes eglCreateImage fail — the GPU process then dies in a loop
// ("OzoneImageBacking::ProduceSkiaGanesh failed", exit_code=8704) and the
// window stays black. On X11 the default GLX path ignored the variable, which
// hid this. So mirror gpu.ts's decision here: only an explicit 'discrete'
// preference (env or the saved one) may take over EGL.
const NV_EGL = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json'

function discreteGpuRequested(): boolean {
  if (process.env.KADR_GPU) return process.env.KADR_GPU === 'discrete'
  try {
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    const dir = process.env.KADR_USER_DATA || join(config, 'kadr')
    const saved = JSON.parse(readFileSync(join(dir, 'gpu.json'), 'utf8'))
    return saved.pref === 'discrete' && !saved.fallback
  } catch {
    return false
  }
}

if (
  process.platform === 'linux' &&
  discreteGpuRequested() &&
  existsSync(NV_EGL)
) {
  if (!process.env.__EGL_VENDOR_LIBRARY_FILENAMES) {
    process.env.__EGL_VENDOR_LIBRARY_FILENAMES = NV_EGL
  }
  if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
    process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
  }
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'electron/main.ts' },
      // node-pty is a native module — must stay a runtime require; the 3D
      // importers load WebAssembly next to their own files (electron/models.ts)
      rollupOptions: { external: ['electron', 'node-pty', 'occt-import-js', 'meshoptimizer'] }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: 'electron/preload.ts' },
      rollupOptions: { external: ['electron'] }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    plugins: [react()]
  }
})
