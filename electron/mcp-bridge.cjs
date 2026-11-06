#!/usr/bin/env node
// MCP server bridging AI agents to the running Kadr editor.
// Spawned by the embedded agent (see kadr-mcp.json); forwards tool calls to
// the editor's local HTTP bridge (port = argv[2]), which evaluates JS in the
// renderer where window.kadrEditor lives.
//
// Transports:
//   • stdio  — always on; the embedded agent talks through it
//   • StreamableHTTP — optional (--http-port N); any external MCP client
//     (Antigravity, opencode, VS Code Copilot) can connect to
//     http://127.0.0.1:N/mcp with the token in the x-kadr-token header
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Resolve bridge port & token:
// 1. Explicit positional argv: mcp-bridge.cjs <port> <token>
// 2. ~/.kadr/editor-bridge.json written by running Kadr instance
// 3. Environment variables KADR_BRIDGE_PORT / KADR_BRIDGE_TOKEN
let PORT = Number(process.argv[2])
let TOKEN = process.argv[3] || ''

if (!PORT || isNaN(PORT)) {
  // If first arg was a flag like --http-port, reset PORT
  PORT = 0
  try {
    const bridgeFile = path.join(os.homedir(), '.kadr', 'editor-bridge.json')
    if (fs.existsSync(bridgeFile)) {
      const data = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'))
      if (data && data.port) {
        PORT = Number(data.port)
        TOKEN = data.token || TOKEN
      }
    }
  } catch (err) {
    // ignore
  }
}

if (!PORT && process.env.KADR_BRIDGE_PORT) {
  PORT = Number(process.env.KADR_BRIDGE_PORT)
  TOKEN = process.env.KADR_BRIDGE_TOKEN || TOKEN
}

if (!PORT) {
  console.error('[mcp-bridge] Error: No active Kadr editor bridge found.')
  console.error('Make sure Kadr is running, or specify bridge parameters:')
  console.error('  usage: mcp-bridge.cjs [<editor-bridge-port> <token>] [--http-port <port>]')
  process.exit(1)
}

// Never outlive our agent (stdin closes when it dies) or the editor
// (bridge port stops answering) — an orphaned bridge inherits Chromium's
// listening sockets and would block the next editor launch.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
let bridgeMisses = 0
setInterval(() => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 3000 },
    (res) => { res.resume(); bridgeMisses = 0 } // any response = editor alive
  )
  req.on('error', () => { if (++bridgeMisses >= 3) process.exit(0) })
  req.on('timeout', () => { req.destroy(); if (++bridgeMisses >= 3) process.exit(0) })
  req.end()
}, 10000).unref()

// --http-port N: start a StreamableHTTP transport so external MCP clients
// (Antigravity, opencode, VS Code Copilot, custom scripts) can connect.
// The port is either explicit or auto-assigned (0 → random free port).
const httpPortIdx = process.argv.indexOf('--http-port')
const HTTP_PORT = httpPortIdx !== -1 ? Number(process.argv[httpPortIdx + 1] || 0) : null

/** POST the code (async function body) to the editor, return parsed result. */
function editorEval(code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code })
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/eval', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-kadr-token': TOKEN
        } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          if (res.statusCode === 403) {
            reject(new Error('editor bridge rejected this session (stale token) — ' +
              'reopen the Kadr terminal panel'))
            return
          }
          try {
            const r = JSON.parse(data)
            if (r.error) reject(new Error(r.error))
            else resolve(r.ok)
          } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', (e) => reject(new Error(
      `editor bridge unreachable (${e.message}) — is the Kadr terminal panel still open?`)))
    req.end(body)
  })
}

// claude kills the stdio transport when a single JSON-RPC message exceeds
// 16 MB ("stdout overflow → Connection closed") — cap every tool result far
// below that. Whole-project dumps with asset waveforms/thumbnails were the
// culprit; kadr_state strips those, this guard covers kadr_eval and the rest.
const MAX_TEXT = 4_000_000
const asText = (v) => {
  let text = JSON.stringify(v, null, 1)
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT) +
      '\n…[result truncated at 4 MB — return selected fields instead of whole ' +
      'objects; asset waveform/thumbnail blobs are the usual culprits]'
  }
  return { content: [{ type: 'text', text }] }
}
const asError = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true })

const server = new McpServer({ name: 'kadr', version: '1.0.0' })

server.registerTool('kadr_state', {
  description:
    'Read the LIVE state of the Kadr project currently open in the editor: full project ' +
    '(tracks→clips, assets with absolute media file paths, fps, size), projectPath, selection, ' +
    'playhead, and available export presets. All times are in seconds. tracks[0] is the topmost ' +
    'video track (drawn last). Clip: {id, kind: media|text, assetId, start, duration, inPoint, ' +
    'speed, gain, muted, transform, mask?, maskShapes?, effects[], transitionIn/Out?, fadeIn/Out?}. ' +
    'project.markers are the user\'s free-floating timeline markers ({id, time, label}) — use ' +
    'them as anchors the user set for you (\u00abfrom marker 2 to marker 3\u00bb). Markers with ' +
    'kind:"beat" are DETECTED MUSICAL BEATS ({time, strength 0..1, strong}) laid down by kadr_beats — ' +
    'cut and time animations on them; they are snap targets, not the user\'s anchors. ' +
    'project.texts lists transcript/subtitle documents (TextDoc {id, name, path, format: srt|txt, ' +
    'assetId?, offset?}) — path is a real file you can Read/Edit; see kadr_transcribe to create them. ' +
    'project.voiceRuns are ElevenLabs voice-overs ({id, assetId, scriptPath, scriptHash, tempo, runDir?}) ' +
    'and project.defects their suspected defects. THESE ARE NOT MARKERS AND NOT THE RANGE: a defect ' +
    'belongs to one audio clip, its src/phrase times are SOURCE seconds of that clip\'s asset, and ' +
    'only the USER turns proposed into confirmed/rejected. voiceDefects[] in this result is the same ' +
    'list with timeline seconds already worked out — seek with those, never compute them yourself ' +
    '(clip speed and inPoint are in it). ' +
    'Asset waveform/thumbnail blobs are omitted (hasWaveform/hasThumbnail flags remain).',
  inputSchema: {}
}, async () => {
  try {
    return asText(await editorEval(`
      const s = window.kadrEditor.useEditor.getState()
      // strip multi-MB base64 blobs: a >16 MB tool result makes claude drop
      // the whole MCP connection ("stdout overflow")
      const assets = s.project.assets.map(a => {
        const { waveform, thumbnail, thumbnailEnd, ...rest } = a
        return { ...rest, hasWaveform: !!waveform, hasThumbnail: !!thumbnail }
      })
      return {
        project: { ...s.project, assets },
        projectPath: s.projectPath,
        selection: s.selection,
        playhead: s.playhead,
        exportPresets: window.kadrEditor.PRESETS.map(p => ({
          id: p.id, name: p.name, container: p.container, audioOnly: !!p.audioOnly
        })),
        // source seconds mapped to the timeline here, once: doing it in the
        // model means getting speed/inPoint wrong sooner or later
        voiceDefects: window.kadrEditor.placeDefects(s.project).map(pl => ({
          id: pl.defect.id, runId: pl.defect.runId, clipId: pl.clipId,
          origin: pl.defect.origin, class: pl.defect.cls, tier: pl.defect.tier,
          confidence: pl.defect.confidence, state: pl.defect.state,
          words: pl.defect.words, src: pl.defect.src,
          phrase: [pl.defect.phrase.t0, pl.defect.phrase.t1],
          timeline: [pl.src.start, pl.src.end],
          phraseTimeline: pl.phrase ? [pl.phrase.start, pl.phrase.end] : null,
          text: (pl.defect.phrase.text || '').slice(0, 160)
        }))
      }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_eval', {
  description:
    'Run JavaScript inside the Kadr editor page and return its result (must be JSON-serializable). ' +
    'The code is the body of an async function — use `return`. API surface:\n' +
    '- window.kadrEditor.useEditor.getState() → store: project, selection, playhead, and actions: ' +
    'pushHistory(label) (call ONCE before a discrete low-level edit like updateClip — enables undo; ' +
    'high-level actions such as addTrack/insertClipFromAsset/splitAtPlayhead push their own), ' +
    'updateClip(clipId, patch), ' +
    'insertClipFromAsset(assetId, trackId, startSec), insertClipsFromAssets([ids], trackId, at) ' +
    '(back-to-back, audio → audio track), removeAssets([assetIds]) (drops the bin entries AND every ' +
    'clip using them, one undo), setClipDuration(clipId, sec), setClipSpeed(clipId, speed, duration) ' +
    '(speed 0.02–100), addAsset(asset), ' +
    'addTrack(kind), select([ids]), setPlayhead(sec), setProject(project), splitAtPlayhead(), ' +
    'addMarker(sec) (auto-numbered, returns id), moveMarker(id, sec), removeMarker(id), ' +
    'deleteSelection(), setTransition(clipId, type|null), setEdgeTransitions(...).\n' +
    '- window.kadrEditor.uid() → new id; .PRESETS → export presets; .projectDuration(project); ' +
    '.evalAnim(anim, t); await .reverseClip(clipId) — reverse a video/audio clip in place ' +
    '(renders a backwards copy, swaps the clip to it; calling again un-reverses); ' +
    'await .normalizeClip(clipId, {targetLufs?, peakDb?}) — measure the clip audio (EBU R128) ' +
    'and set its gain for −14 LUFS with a −1 dBTP ceiling (defaults); works on either half of a ' +
    'linked A/V pair, one undo entry, returns {gain, gainDb, measuredLufs, peakLimited}; ' +
    'await .snapshotFrame({t?, importToBin?}) — see kadr_snapshot; ' +
    'await .importFiles([paths], {trackId, at}|null) — probe files into the bin (deduped by path) ' +
    'and, with a placement, lay them out back-to-back on the timeline from `at`.\n' +
    '- await window.kadr.probeMedia(path) → { asset } (probe a media file to import: then ' +
    'addAsset({ id: uid(), ...asset })); window.kadr.writeProject(path, project); ' +
    'window.kadr.readProject(path).\n' +
    'Times are seconds. Animatable scalars (clip gain, transform.x/y/scale/rotation/opacity) are ' +
    'Anim objects — write { value: 0.5 }, NEVER a bare number. ' +
    'Mutations: always pushHistory first; the store is zustand — re-read ' +
    'getState() after each action. NEVER return whole project/asset objects — asset ' +
    'waveform/thumbnail blobs are megabytes of base64 (results are truncated at 4 MB); ' +
    'return the specific fields you need. Example — add a media file to track V1 at 2s:\n' +
    'const ed = window.kadrEditor; const st = () => ed.useEditor.getState();\n' +
    'const { asset } = await window.kadr.probeMedia("/path/v.mp4");\n' +
    'const id = ed.uid(); st().pushHistory("hInsert"); st().addAsset({ id, ...asset });\n' +
    'const tr = st().project.tracks.find(t => t.name === "V1");\n' +
    'st().insertClipFromAsset(id, tr.id, 2); return st().project.tracks.length;',
  inputSchema: { code: z.string().describe('async function body to run in the editor page') }
}, async ({ code }) => {
  try { return asText(await editorEval(code)) } catch (e) { return asError(e) }
})

server.registerTool('kadr_snapshot', {
  description:
    'YOUR EYES on the timeline: render the WYSIWYG frame at time t (default: current playhead) ' +
    'to a PNG at project resolution and return its absolute path — then Read that file to SEE ' +
    'the frame (composition, text placement, colors, effects). Media decodes at SOURCE quality ' +
    '(originals, not the preview proxies); Remotion fragments are included (forced through ' +
    'pixel capture). The PNG lands next to the project file (Downloads if the project was ' +
    'never saved) and is imported into the media bin unless importToBin=false — pass false ' +
    'when you only need to look. Takes ~2 s, up to ~5 s with fragments or many clips.',
  inputSchema: {
    t: z.number().optional().describe('project time in seconds; default = current playhead'),
    importToBin: z.boolean().optional().describe('default true: register the PNG as a media asset')
  }
}, async ({ t, importToBin }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.snapshotFrame(${JSON.stringify({ t, importToBin })})
      return r`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_sheet', {
  description:
    'A CONTACT SHEET: several WYSIWYG frames in one PNG, each labelled with its time (and bar.beat ' +
    'when the timeline carries an analysed beat grid). Same rendering path as kadr_snapshot ' +
    '(fragments through pixel capture at full width, originals decoded) — use it to check a ' +
    'sequence in one look: the middle of every transition, both sides of every cut between ' +
    'fragments, the key beats. Read the returned file to see it. Up to 48 frames; `width` is the ' +
    'width of ONE frame in the sheet (default 480; 960 or the project width to read small text). ' +
    'Never imported into the media bin. ~1–5 s per frame.',
  inputSchema: {
    times: z.array(z.number()).min(1).max(48).describe('project times in seconds, in sheet order'),
    cols: z.number().int().min(1).max(12).optional().describe('frames per row (default min(4, count))'),
    width: z.number().int().min(120).max(3840).optional().describe('width of one frame in px (default 480)')
  }
}, async ({ times, cols, width }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.contactSheet(${JSON.stringify({ times, cols, width })})
      return { path: r.path, width: r.width, height: r.height, frames: r.frames.map((f) => f.label) }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_model_import', {
  description:
    'Import 3D models (STL, 3MF, STEP, OBJ, GLB/glTF) into the project\'s kadr-lib/models — the project ' +
    'must be saved. 3MF is read the way the slicer builds it (build items, components in other files ' +
    'of the package, units), CAD Z-up becomes Y-up, heavy meshes are decimated to `budget` triangles ' +
    '(default 200 000), each part gets its size and an oriented bounding box (mm). The result: ' +
    '<name>.glb (metres) + <name>.json + a thumbnail. In a fragment: `import m from ' +
    '\'@lib/models/<name>.glb\'`, `const model = useModel(m)` from \'@kadr/three\' → model.list / ' +
    'model.parts[name] ({geometry, edges, box, size}), 1 scene unit = 10 cm, the model centred and ' +
    'standing on y = 0. insert:{start,end} also puts a ready turntable fragment on the timeline. ' +
    'Check the returned sizes against the real object before building a film on it.',
  inputSchema: {
    paths: z.array(z.string()).min(1).describe('absolute paths of the model files'),
    name: z.string().optional().describe('model name (one file only; default: the file name)'),
    budget: z.number().int().min(1000).optional().describe('triangles kept for the whole model (default 200000)'),
    insert: z.object({ start: z.number(), end: z.number() }).optional().describe('also insert a turntable fragment of the (first) model')
  }
}, async ({ paths, name, budget, insert }) => {
  try {
    return asText(await editorEval(`
      const E = window.kadrEditor
      const infos = await E.importModels(${JSON.stringify(paths)}, ${JSON.stringify({ name, budget })})
      let fragment = null
      if (${JSON.stringify(!!insert)} && infos[0]) {
        const f = await E.insertModelFragment(infos[0].name, ${JSON.stringify(insert ? { start: insert.start, duration: insert.end - insert.start } : {})})
        fragment = { fragmentId: f.id, clipId: f.clipId, entryFile: f.entry }
      }
      return { models: infos.map((m) => ({ name: m.name, file: 'kadr-lib/models/' + m.file, sizeMm: m.sizeMm,
        triangles: [m.trianglesIn, m.trianglesOut], parts: m.parts.map((p) => ({ name: p.name, bboxMm: p.bboxMm, obbHalfMm: p.obbMm.half })) })), fragment }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_fragment_media', {
  description:
    'Make a video from the bin usable inside a fragment\'s <Video>: a copy in the project\'s ' +
    'kadr-lib/media that is UPRIGHT (a phone\'s rotation applied), SDR BT.709 (an HLG/PQ HDR ' +
    'recording tone-mapped — played as it is it looks flat and grey), H.264 with a keyframe every ' +
    '30 frames (a fragment seeks constantly; a phone\'s long GOP makes each seek decode seconds), ' +
    'no bigger than the project. Returns the import to use: `import clip from \'@lib/media/<name>.mp4\'` ' +
    '→ <Video src={clip} /> (Video, not OffthreadVideo). Rebuilt only when the source changes.',
  inputSchema: { assetId: z.string().describe('a video asset id from kadr_state') }
}, async ({ assetId }) => {
  try {
    return asText(await editorEval(`return await window.kadrEditor.prepareForFragment(${JSON.stringify(assetId)})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_models', {
  description: 'The 3D models already imported into this project (kadr-lib/models): names, sizes (mm), parts. See kadr_model_import.',
  inputSchema: {}
}, async () => {
  try {
    return asText(await editorEval(`
      await window.kadrEditor.refreshModels()
      return window.kadrEditor.useModelsUi.getState().models.map((m) => ({ name: m.name, import: "@lib/models/" + m.file, sizeMm: m.sizeMm,
        parts: m.parts.map((p) => p.name), source: m.source }))`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_check', {
  description:
    'CHECK the motion piece against the music and the rules of readable motion, before showing it. ' +
    'It reads what each fragment DECLARES about itself — export `inspect` with the fragment: ' +
    '`export const fragment = { component, meta, inspect }` where inspect = { events: [{t, kind: ' +
    '"big"|"small", label}], texts: [{from, to, text, sub?, role?: "title"|"note"|"caption", box?: ' +
    '[x,y,w,h], color?, at?: (t) => [x,y]}], camera?: (t) => ({pos, target, fov}), continuous?: ' +
    'true } (composition seconds / pixels; types in "@kadr/runtime": defineInspect, KadrInspect). ' +
    'Warns about: an event off the beat (>40 ms), a BIG event not on the first beat of a bar, an ' +
    'event inside a pause of the music, a caption shown shorter than its reading time (1–3 words ' +
    '≥0.8 s, longer ≥ max(1.2 s, 0.3 s/word), a subtitle +0.7 s), a caption that moves while ' +
    'readable (>20 px/s), two main captions at once or overlapping, a camera that jerks. Notes ' +
    'first beats of bars with nothing on them. pixels:true also renders frames: caption contrast ' +
    'against the real background (WCAG, titles ≥3:1, other text ≥4.5:1) and the seams between ' +
    'butt-joined fragments (a warning when a fragment declares continuous: true and the cut shows). ' +
    'Needs the music map on the timeline for the rhythm rules (kadr_beats first). Times returned ' +
    'are TIMELINE seconds.',
  inputSchema: {
    clipIds: z.array(z.string()).optional().describe('check these fragment clips only (default: all)'),
    pixels: z.boolean().optional().describe('also contrast and seams — renders frames, ~1–5 s each'),
    collisions: z.boolean().optional().describe('also parts of the 3D kit (<Part> from @kadr/three) passing through each other: plays every fragment frame by frame (every 1/15 s) — slow; parts touching on every frame are reported as an assembly in contact, not an error')
  }
}, async ({ clipIds, pixels, collisions }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.runChecks(${JSON.stringify({ clipIds, pixels, collisions })})
      return { checked: r.checked,
        warnings: r.issues.filter((i) => i.level === 'warn').map((i) => ({ kind: i.kind, t: +i.t.toFixed(3), end: i.end != null ? +i.end.toFixed(3) : undefined, clipId: i.clipId, message: i.message })),
        notes: r.issues.filter((i) => i.level === 'info').slice(0, 80).map((i) => ({ kind: i.kind, t: +i.t.toFixed(3), message: i.message })),
        events: r.events.length }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_typecheck', {
  description:
    'Type-check ONE fragment the way the preview and the render resolve it (its project\'s ' +
    '\'@lib/…\', Kadr\'s \'@kadr/…\', three/r3f types) and return only the errors in that ' +
    'fragment, its project\'s kadr-lib and Kadr\'s runtime. Run it after editing a fragment ' +
    'instead of tsc over the whole workspace (hundreds of unrelated fragments live there). ' +
    '~5–20 s.',
  inputSchema: { fragmentId: z.string().describe('the fragment id (clip.fragmentId)') }
}, async ({ fragmentId }) => {
  try {
    return asText(await editorEval(`return await window.kadr.fragmentTypecheck(${JSON.stringify(fragmentId)})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_export', {
  description:
    'Render the current Kadr project (or a time range of it) to a file and wait for completion. ' +
    'Uses the same WYSIWYG pipeline as the editor (GPU composite, effects, transitions, audio mix). ' +
    'presetId comes from kadr_state.exportPresets (default: first mp4). For audio-only output pick ' +
    'an audioOnly preset (mp3). Returns when the file is fully written.',
  inputSchema: {
    outputPath: z.string().describe('absolute output file path; extension should match the preset container'),
    presetId: z.string().optional(),
    start: z.number().optional().describe('range start, seconds'),
    end: z.number().optional().describe('range end, seconds'),
    motionBlur: z.boolean().optional().describe('default true'),
    frameBlending: z.boolean().optional().describe('default true')
  }
}, async ({ outputPath, presetId, start, end, motionBlur, frameBlending }) => {
  try {
    return asText(await editorEval(`
      const ed = window.kadrEditor
      const preset = ${JSON.stringify(presetId ?? null)}
        ? ed.PRESETS.find(p => p.id === ${JSON.stringify(presetId ?? '')})
        : ed.PRESETS.find(p => p.container === 'mp4')
      if (!preset) throw new Error('preset not found')
      const range = ${start != null && end != null ? `{ start: ${start}, end: ${end} }` : 'null'}
      const h = ed.startExport(ed.useEditor.getState().project, preset,
        ${JSON.stringify(outputPath)}, () => {}, range,
        { motionBlur: ${motionBlur !== false}, frameBlending: ${frameBlending !== false} })
      await h.done
      return { written: ${JSON.stringify(outputPath)}, preset: preset.id }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_transcribe', {
  description:
    'Speech-to-text over the project audio (local faster-whisper, anti-hallucination guards). ' +
    'Target is either a whole imported media file (assetId from kadr_state) or a timeline range ' +
    '[start, end) in project seconds (everything audible there, mixed like an export). Writes ' +
    '<name>.srt and <name>.txt next to the source media and registers them in project.texts ' +
    '(each entry has the absolute file path — you can Read/Edit those files directly; the ' +
    'editor subtitle panel picks up external edits). For ranges, timecodes "absolute" = ' +
    'project-timeline seconds, "relative" = from the range start; for whole files cue times are ' +
    'source-media seconds. Runs at roughly realtime speed for model large-v3 — expect a long call.',
  inputSchema: {
    assetId: z.string().optional().describe('transcribe this whole media file'),
    start: z.number().optional().describe('range start, project seconds'),
    end: z.number().optional().describe('range end, project seconds'),
    model: z.enum(['large-v3', 'medium', 'base']).optional().describe('default large-v3'),
    language: z.string().optional().describe("'auto' (default), 'ru', 'en', …"),
    timecodes: z.enum(['absolute', 'relative']).optional().describe('range targets only; default absolute'),
    maxWords: z.number().optional().describe(
      'words per cue: 1-4 = short precise cues from word-level timestamps (default 3), 0 = whole phrases')
  }
}, async ({ assetId, start, end, model, language, timecodes, maxWords }) => {
  try {
    const target = assetId
      ? { kind: 'asset', assetId }
      : { kind: 'range', start, end }
    if (!assetId && (typeof start !== 'number' || typeof end !== 'number')) {
      throw new Error('pass either assetId or start+end')
    }
    return asText(await editorEval(`
      const r = await window.kadrEditor.transcribe(${JSON.stringify({ target, model, language, timecodes, maxWords })})
      return { srtPath: r.srtPath, txtPath: r.txtPath, language: r.language,
               cues: r.segments.length,
               preview: r.segments.slice(0, 12).map(s => s.start.toFixed(1) + '-' + s.end.toFixed(1) + ' ' + s.text) }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_fragment_create', {
  description:
    'Create a Remotion fragment: an animated composition (React/TSX) living as a clip on the ' +
    'Kadr timeline at [start, end) project seconds. Use it for animations, dynamic subtitles, ' +
    'motion graphics, self-contained scenes. Returns the fragment id and the entry TSX file — ' +
    'EDIT THAT FILE with your normal file tools; the editor preview hot-reloads your changes ' +
    'live (no rendering during iteration; the real render happens once at export). For a saved ' +
    'project the fragment folder lives next to the .kadr file (<projectDir>/kadr-fragments/<id>); ' +
    'unsaved projects keep it in the shared workspace until the first save moves it over. Rules:\n' +
    '- the composition is sized to the project and runs at >=60 fps; meta.json in the fragment ' +
    'folder holds width/height/fps/durationInFrames — keep durationInFrames in sync if you ' +
    'change timing\n' +
    '- transparent: true (default) = overlay with alpha over the clips below; false = opaque ' +
    'self-contained scene\n' +
    '- to use media/images, copy or write files INTO the fragment folder and import them ' +
    '(import bg from "./bg.jpg") — absolute paths will not survive the final render bundling\n' +
    '- SHARED CODE AND ASSETS of a saved project live ONCE in <projectDir>/kadr-lib/ and every ' +
    'fragment of the project imports them as \'@lib/…\' (preview and render; an edit there hot-reloads ' +
    'all of them and invalidates their renders) — never copy a module into several fragments. ' +
    'Fonts in kadr-lib/fonts/ are registered by Kadr (family = file name, "Inter-700.woff2" → Inter ' +
    '700); 3D models go there with kadr_model_import, videos with kadr_fragment_media\n' +
    '- \'@kadr/runtime\': defineInspect (what kadr_check reads), loadFont, and defineParams/useParams — ' +
    'values the user tunes with sliders in the Inspector, live in the preview, saved in the ' +
    'fragment\'s params.json (edit that file to set them; it hot-updates without a reload). ' +
    '\'@kadr/three\': Kadr\'s 3D kit (useModel, Scene3D, Studio, Camera + cameraPath, Part, Layer, ' +
    'Callout, Balloons, PortraitReveal…)\n' +
    '- after editing, kadr_typecheck <fragmentId> (not tsc over the workspace)\n' +
    '- embed video with <Video>, NOT <OffthreadVideo>: the latter needs Remotion\'s native ' +
    'compositor (glibc >= 2.32) and dies on older systems with "GLIBC_2.3x not found"\n' +
    '- the module must keep exporting `fragment = { component, meta }`\n' +
    '- subtitle data: read SRT files from kadr_state project.texts and bake the cues into the ' +
    'composition (e.g. as a const array) for word-precise animated captions\n' +
    '- SOUND: when anything is audible under [start, end) the sound is baked into the fragment ' +
    'right away (audio:true is the default): audio.ts in the folder gives ' +
    '`import { useAudio, beats } from "./audio"` → per-frame level/bass/mid/treble (0..1, smoothed), ' +
    'beat/accent pulses and the beat list in COMPOSITION seconds. Use it — reveals on the beats, ' +
    'subtle breathing on the bass — see kadr_audio_react for the taste rules.',
  inputSchema: {
    name: z.string().describe('short human name, e.g. "intro-title"'),
    start: z.number().describe('clip start, project seconds'),
    end: z.number().describe('clip end, project seconds'),
    transparent: z.boolean().optional().describe('default true (alpha overlay)'),
    audio: z.boolean().optional().describe('bake the sound under the clip into audio.json/audio.ts (default true)')
  }
}, async ({ name, start, end, transparent, audio }) => {
  try {
    return asText(await editorEval(`
      const E = window.kadrEditor
      const r = await E.createFragment(${JSON.stringify({ name, start, end, transparent })})
      let playerUrl = null
      try { playerUrl = (await E.ensureFragmentServer()) + '/?comp=' + r.id } catch {}
      let sound = null
      if (${audio !== false}) {
        try {
          const b = await E.bakeAudio(r.clipId)
          sound = b.audible
            ? { files: b.files, bpm: b.bpm, beats: b.beats,
                usage: "import { useAudio, beats } from './audio'; const a = useAudio()" }
            : { files: b.files, note: 'nothing audible under the clip — the data is zeros; ' +
                're-bake with kadr_audio_react after the music is placed' }
        } catch (err) { sound = { error: String(err && err.message || err) } }
      }
      return { fragmentId: r.id, clipId: r.clipId, dir: r.dir, entryFile: r.entry,
               meta: r.meta, playerUrl, sound }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_beats', {
  description:
    'The MUSIC MAP: beats, BARS (meter and the "one" of every bar), the SONG\'S SECTIONS and its ' +
    'PAUSES, laid on the timeline (thin pink lines, the first beat of a bar heavier with its bar ' +
    'number; sections as a labelled band under the ruler; pauses hatched). Clips, the range and ' +
    'markers SNAP to all of them. Run it FIRST on any music-driven project and show the user the ' +
    'map (sections × bars → what happens there) before building. The beats are librosa\'s ' +
    'beat_track ported to the editor (verified beat-for-beat), moved onto the kick attacks when ' +
    'librosa sits systematically late. The "one" is the phase with the strongest kick (with the ' +
    'bass line and harmonic change, minus the backbeat snare); `phaseConfidence` says how sure — ' +
    'below ~0.2 check it by ear/eye. `kickOffsetMs` = where the kicks really sit against the grid ' +
    '(e.g. −15: 15 ms before it — lead your visual accents by that). Sections: intro / build / ' +
    'verse / chorus / break / outro with `energy` 0..1 — the labels are a heuristic of loudness and ' +
    'repetition; `pauses` are where the music stops (drums out) — keep the picture still there. ' +
    'Earlier analysis markers inside the span are replaced; the user\'s own markers are never ' +
    'touched. Listen to specific clips (clipIds — the music clip, not the whole mix with a ' +
    'voice-over), one track (trackId), or the whole mix of [start, end) (default: the project). ' +
    'grid: "all" every beat (default), "half" beats 1 and 3, "bar" the first beat of each bar, ' +
    '"strong" accents only. READING RULE: text needs ~0.3 s per word — above ~110 BPM reveal ' +
    'TEXT on "half" or "bar". clear:true removes the analysis markers instead. Returns tempo, ' +
    'meter, bars (bar number → time), sections, pauses and the beats (t, bar.beat).',
  inputSchema: {
    clipIds: z.array(z.string()).optional().describe('listen to these clips only'),
    trackId: z.string().optional().describe('listen to this track only'),
    start: z.number().optional().describe('span start, timeline seconds'),
    end: z.number().optional().describe('span end, timeline seconds'),
    grid: z.enum(['all', 'half', 'bar', 'strong']).optional().describe('default "all"'),
    clear: z.boolean().optional().describe('remove beat markers in the span (or all) instead')
  }
}, async ({ clipIds, trackId, start, end, grid, clear }) => {
  try {
    const range = start != null && end != null ? { start, end } : undefined
    if (clear) {
      return asText(await editorEval(`
        return { removed: window.kadrEditor.clearBeats(${JSON.stringify(range ?? null)} || undefined) }`))
    }
    const opts = { clipIds, trackId, range, grid }
    return asText(await editorEval(`
      const E = window.kadrEditor
      const r = await E.detectBeats(${JSON.stringify(opts)})
      const p = E.useEditor.getState().project
      const inSpan = (p.markers || []).filter(m => m.kind === 'beat' &&
        m.time >= r.range.start - 1e-6 && m.time <= r.range.end + 1e-6)
      const rh = r.analysis.rhythm
      const T = (x) => +(r.range.start + x).toFixed(3)
      return { tempo: r.tempo, found: r.found, placed: r.placed, range: r.range, listenedTo: r.source,
               attackShiftMs: r.attackShiftMs,
               meter: rh && rh.meter, meterConfidence: rh && rh.meterConfidence, phaseConfidence: rh && rh.phaseConfidence,
               kickOffsetMs: rh && rh.kickOffsetMs,
               bars: r.analysis.beats.filter(b => b.beatInBar === 1 && b.bar > 0).slice(0, 300).map(b => [b.bar, T(b.time)]),
               sections: rh ? rh.sections.map(s => ({ label: s.label, start: T(s.start), end: T(s.end), bar: s.startBar,
                 bars: s.bars, energy: s.energy, repeatOf: s.repeatOf })) : [],
               pauses: rh ? rh.pauses.map(x => ({ start: T(x.start), end: T(x.end), depthDb: x.depth })) : [],
               beats: inSpan.slice(0, 400).map(m => ({ t: +m.time.toFixed(3),
                 b: m.bar != null ? m.bar + '.' + m.beatInBar : undefined, s: +(m.strength || 0).toFixed(2),
                 strong: !!m.strong })),
               truncated: inSpan.length > 400 }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_audio_react', {
  description:
    'Bake the sound under a Remotion fragment clip INTO the fragment, so the composition moves ' +
    'with the music. Writes audio.json + audio.ts next to its entry TSX; in the composition: ' +
    '`import { useAudio, beats, bpm } from "./audio"`, `const a = useAudio()` → a.level, a.bass, ' +
    'a.mid, a.treble (0..1, normalised over the clip, attack/release smoothed), a.beat / a.accent ' +
    '(1 on a beat / an accented beat, decaying to 0 in ~0.15 s; useAudio(0.3) for a slower decay), ' +
    'a.beatIndex, a.sinceBeat; `beats` = [{time (composition s), strength, strong, bar, beatInBar}]. ' +
    'THE BAR\'S HIERARCHY (needs kadr_beats on the timeline first — bars and sections come from the ' +
    'whole track, not the few seconds under the clip): `useAccent()` / `accentAt(frame, fps)` → ' +
    '{hit: 1 on the "one", 0.35 on other beats, 0 in a pause — decaying; bar; beat; beatInBar; ' +
    'barNumber; section; energy; pause}, pulses already led by the measured kick offset; ' +
    '`breathAt(frame, fps)` a swell once per bar as deep as the section is energetic; `bars` (times ' +
    'of every "one"), `sections`, `sectionAt(t)`, `pauses`, `inPause(t)`, `meter`, `kickOffsetMs`. ' +
    'Big events on `bars`, small ones on beats, NOTHING in pauses; glow breathes with breathAt and ' +
    'answers accent.hit — never a uniform pulse on every beat. ' +
    'kadr_fragment_create already bakes by default — call this after the music under the clip ' +
    'changes or the clip moves (kadr_state shows clip.audioBake; an export re-bakes stale ones by ' +
    'itself, the live preview does not). source: "mix" (default) or a trackId to listen to one ' +
    'track (e.g. only the music, not the voice-over). TASTE (from /brag): make EXISTING elements ' +
    'breathe — glow, a few percent of scale, background warmth, depth — never an equaliser, ' +
    'waveform bars or musical notes, never strobing, never text pulsing so hard it cannot be read.',
  inputSchema: {
    clipId: z.string().describe('a remotion clip id'),
    source: z.string().optional().describe('"mix" (default) or a track id')
  }
}, async ({ clipId, source }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.bakeAudio(${JSON.stringify(clipId)}, ${JSON.stringify({ source })})
      return r`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_sounds', {
  description:
    'Search the sound library: 260 bundled effects (Kenney + a keyboard set, CC0), 5 music beds ' +
    '(ende.app, CC BY 4.0 — never register them with Content ID) and the USER\'S OWN sounds ' +
    '(origin "user", ids "user:<folder>/<file>", family = their folder, e.g. "mine" — prefer these ' +
    'when they fit: the user chose them). Every effect carries brightness (warm/balanced/bright), ' +
    'hfRisk (low/medium/high — how sharp and fatiguing it gets when repeated), suggested uses, and ' +
    'HIT: seconds from the file start to its main attack (a whoosh ~0.5 s, a boom with a lead-in ' +
    '~1.5 s) — kadr_sound_add puts that moment on the time you give. note = a human description. ' +
    'Results come gentlest first. Uses: major reveal, hard transition, soft reveal, logo payoff, ' +
    'success, reveal confirmation, button press, selection, simulated user action, toggle, mode ' +
    'change, card reveal, sequential item, swipe, panel opening, typing, general accent, tiny ' +
    'accent only, chaotic accent, comedic interruption, ambience, dissolve, mechanical. ' +
    '"mechanical" = a mechanism IN THE FRAME (click, switch, latch, a light metal/plastic/wood knock): ' +
    'under a song with vocals use only these, quietly (gain 0.4–0.5), each on something visibly ' +
    'clicking into place — booms and whooshes fight the song.',
  inputSchema: {
    kind: z.enum(['sfx', 'music']).optional().describe('default: both'),
    family: z.string().optional(),
    use: z.string().optional(),
    soft: z.boolean().optional().describe('leave out hfRisk "high"'),
    query: z.string().optional().describe('substring of the name, a tag or the note'),
    origin: z.enum(['bundled', 'user']).optional().describe('only bundled or only the user\'s own'),
    rescan: z.boolean().optional().describe('re-read the user folder first (new files get analysed)'),
    limit: z.number().optional().describe('default 40 effects')
  }
}, async ({ kind, family, use, soft, query, origin, rescan, limit }) => {
  try {
    const q = { family, use, soft, text: query }
    return asText(await editorEval(`
      const E = window.kadrEditor
      const L = await E.loadSoundLibrary(${rescan ? 'true' : 'false'})
      const out = { userFolder: L.userRoot }
      if (${JSON.stringify(kind ?? '')} !== 'music') {
        const hits = E.findSfx(L.sfx, ${JSON.stringify(q)})
          .filter(s => !${JSON.stringify(origin ?? '')} || s.origin === ${JSON.stringify(origin ?? '')})
        out.sfx = hits.slice(0, ${Number(limit ?? 40)}).map(s => ({ id: s.id, origin: s.origin, family: s.family,
          duration: s.duration, hit: s.hit, brightness: s.brightness, hfRisk: s.hfRisk, envelope: s.envelope,
          uses: s.uses, tags: s.tags, note: s.note }))
        out.sfxMatching = hits.length
        out.sfxTotal = L.sfx.length
      }
      if (${JSON.stringify(kind ?? '')} !== 'sfx') {
        out.music = L.music.map(m => ({ id: m.id, name: m.name, description: m.descEn,
          duration: m.duration, bpm: m.tempo, license: m.license }))
      }
      return out`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_sound_add', {
  description:
    'Put a library sound (id from kadr_sounds) on the timeline so that its HIT lands at `at` ' +
    '(default: the playhead) — the clip starts `hit` seconds earlier (alignHit:false to start the ' +
    'file at `at`; music always starts at `at`). ' +
    'It goes on the first audio track that is FREE over its length, or a new track — never on top ' +
    'of existing audio (an overlap on one track would crossfade into the music). Music gets its ' +
    'beat markers straight away (beats:false to skip). MIX, per /brag: effects sit UNDER the ' +
    'music, never harsh — start sound effects around gain 0.5-0.8 against music at 1, prefer ' +
    'low/medium hfRisk for anything repeated, place an effect 0-0.1 s BEFORE the visual it ' +
    'accompanies lands, and use fewer, better-timed cues rather than one per movement. One undo ' +
    'entry per call. Returns start (clip start) and hitAt.',
  inputSchema: {
    id: z.string().describe('sfx id like "impact/impactSoft_medium_001.ogg" / "user:mine/boom.mp3", or a music id'),
    at: z.number().optional().describe('timeline seconds where the HIT lands; default = playhead'),
    alignHit: z.boolean().optional().describe('default true for effects'),
    gain: z.number().optional().describe('clip gain 0..2, default 1'),
    beats: z.boolean().optional().describe('music: lay beat markers (default true)'),
    grid: z.enum(['all', 'half', 'bar', 'strong']).optional().describe('music beat grid, default "all"')
  }
}, async ({ id, at, alignHit, gain, beats, grid }) => {
  try {
    return asText(await editorEval(`
      return await window.kadrEditor.addSound(${JSON.stringify(id)}, ${JSON.stringify({ at, alignHit, gain, beats, grid })})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_sound_label', {
  description:
    'Describe one of the USER\'S OWN sounds (id "user:…" from kadr_sounds): what it is good for ' +
    '(uses, same vocabulary as kadr_sounds), tags, and a short note in the user\'s language ' +
    '("низкий удар после 1.5 с подводки"). Brightness, hfRisk, envelope and hit are measured by the ' +
    'editor and cannot be set. Survives re-analysis of the file. Bundled sounds cannot be edited. ' +
    'Listen-free rule of thumb: base uses on the measured numbers (hit, duration, envelope, ' +
    'brightness) and the file name, and say that you did.',
  inputSchema: {
    id: z.string().describe('"user:<folder>/<file>"'),
    uses: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    note: z.string().optional()
  }
}, async ({ id, uses, tags, note }) => {
  try {
    return asText(await editorEval(`
      return await window.kadrEditor.setSoundMeta(${JSON.stringify(id)}, ${JSON.stringify({ uses, tags, note })})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_neon_wave', {
  description:
    'Generate a «neon wave» clip: an audio-reactive glowing sine line (the user\'s Blender ' +
    'preset rebuilt as a Remotion fragment) over [start, end) project seconds. The loudness of ' +
    'the timeline mix in that range — or of ONE audio track when trackId is given — drives the ' +
    'wiggle frequency and height (Blender "Bake Sound" follower: 5 ms attack / 200 ms release). ' +
    'Opaque black background, project size, >=60 fps; lands on the topmost free video track and ' +
    'is selected. Returns the fragment id and its entry TSX: `S` at the top holds every style ' +
    'knob (colour ramp, glow, streaks, amplitude, speed), `ENV` the loudness per frame — edit ' +
    'the file to restyle, the preview hot-reloads. Regenerate (call again) after the audio changes.',
  inputSchema: {
    start: z.number().describe('clip start, project seconds'),
    end: z.number().describe('clip end, project seconds'),
    trackId: z.string().optional().describe('restrict the sound to this audio track (from kadr_state); default = whole mix'),
    name: z.string().optional().describe('fragment name, default "wave"')
  }
}, async ({ start, end, trackId, name }) => {
  try {
    const opts = { range: { start, end }, source: trackId ? { trackId } : 'mix', name }
    return asText(await editorEval(`
      const r = await window.kadrEditor.neonWave(${JSON.stringify(opts)})
      return { fragmentId: r.fragmentId, clipId: r.clipId, entryFile: r.entry, frames: r.frames, peak: r.peak }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_speak', {
  description:
    'Voice a text through ElevenLabs and put the audio on the timeline. Needs an API key set in ' +
    'the editor\'s voice-over settings (it lives in the main process; nothing here can read it). ' +
    'Give exactly one source: `text` verbatim, `textDocId` from project.texts, or `path` to a ' +
    'txt/srt on disk. Lands on a free audio track at `at` (default: the playhead), CREATING an ' +
    'audio track if the project has none. Writes <name>.script.txt next to the audio — the exact ' +
    'text that was synthesised — and registers it in project.texts; kadr_voice_check aligns ' +
    'against THAT file, so never retype it. COSTS ElevenLabs credits: say so before calling.',
  inputSchema: {
    text: z.string().optional().describe('the text itself'),
    textDocId: z.string().optional().describe('id of a document from project.texts'),
    path: z.string().optional().describe('absolute path to a .txt/.srt'),
    at: z.number().optional().describe('timeline second to place it at; default = playhead'),
    name: z.string().optional().describe('base name for the produced files')
  }
}, async ({ text, textDocId, path, at, name }) => {
  try {
    const given = [text, textDocId, path].filter((x) => x !== undefined)
    if (given.length !== 1) throw new Error('pass exactly one of text / textDocId / path')
    const opts = { text, textDocId, path, at, name }
    return asText(await editorEval(`
      const r = await window.kadrEditor.speakText(${JSON.stringify(opts)})
      return { runId: r.runId, assetId: r.assetId, clipId: r.clipId, path: r.path,
               scriptPath: r.scriptPath, duration: r.duration, tempo: r.tempo, chunks: r.chunks }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_check', {
  description:
    'Run the local defect detector (python/ttsqc) over ONE voice-over and fill project.defects. ' +
    'Takes MINUTES and holds the GPU — warn the user, then call and wait, do not retry mid-flight; ' +
    'an export must not be running. Analyses the asset file itself against the script that was ' +
    'synthesised; refuses if that script has been edited since (word indices would be lies). ' +
    'Everything it finds arrives as state "proposed": deciding is the USER\'s job, done by ' +
    'clicking the violet flags. Returns counts and the analysis trust (below 0.9 the list is ' +
    'probably incomplete).',
  inputSchema: {
    runId: z.string().optional().describe('voice run from project.voiceRuns; default = the selected clip\'s'),
    assetId: z.string().optional().describe('or pick the run by its audio asset'),
    minConfidence: z.number().optional().describe('0 = show every candidate (default), 0.4-0.8 = working thresholds'),
    device: z.string().optional().describe('"cuda" (default) or "cpu"')
  }
}, async ({ runId, assetId, minConfidence, device }) => {
  try {
    const opts = { runId, assetId, minConfidence, device }
    return asText(await editorEval(`
      const r = await window.kadrEditor.checkVoice(${JSON.stringify(opts)})
      const p = window.kadrEditor.useEditor.getState().project
      const mine = (p.defects || []).filter(d => d.runId === r.runId)
      const byClass = {}
      for (const d of mine) byClass[d.cls || '?'] = (byClass[d.cls || '?'] || 0) + 1
      return { runId: r.runId, defects: r.defects, trust: r.trust, runDir: r.runDir, byClass }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_verdict', {
  description:
    'Record the verdict on defects: defect=true means "yes, regenerate this phrase", false means ' +
    '"not a defect". ONLY use this when the user has told you their decision in words — the ' +
    'verdicts also become training data for the detector, so guessing on their behalf poisons it. ' +
    'Every verdict is one undo entry.',
  inputSchema: {
    ids: z.array(z.string()).describe('defect ids from kadr_state.voiceDefects'),
    defect: z.boolean().describe('true = confirmed defect, false = not a defect')
  }
}, async ({ ids, defect }) => {
  try {
    return asText(await editorEval(`
      window.kadrEditor.setVerdict(${JSON.stringify(ids)}, ${defect ? 'true' : 'false'})
      const p = window.kadrEditor.useEditor.getState().project
      const st = {}
      for (const d of (p.defects || [])) st[d.state] = (st[d.state] || 0) + 1
      return { updated: ${ids.length}, states: st }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_mark', {
  description:
    'Record a defect the detector missed, at a place the USER pointed out. Times are TIMELINE ' +
    'seconds; the editor maps them into the audio and works out which phrase they fall in, using ' +
    'the finished analysis (no models are loaded). Requires kadr_voice_check to have run once. ' +
    'This is the only channel that can teach the detector to find a kind of defect it never ' +
    'proposes — so place them where the user says, never on a hunch.',
  inputSchema: {
    start: z.number().describe('timeline seconds'),
    end: z.number().describe('timeline seconds'),
    assetId: z.string().optional().describe('voice-over asset; default = the only one')
  }
}, async ({ start, end, assetId }) => {
  try {
    return asText(await editorEval(`
      const E = window.kadrEditor, s = E.useEditor.getState()
      const runs = s.project.voiceRuns || []
      const run = ${JSON.stringify(assetId ?? null)}
        ? runs.find(r => r.assetId === ${JSON.stringify(assetId ?? null)}) : runs[0]
      if (!run) throw new Error('no voice-over in this project')
      const clip = s.project.tracks.flatMap(t => t.clips)
        .find(c => c.assetId === run.assetId && ${start} < c.start + c.duration && ${end} > c.start)
      if (!clip) throw new Error('no clip of that voice-over covers this time')
      const a = E.projectToSrc(clip, ${start}), b = E.projectToSrc(clip, ${end})
      const id = await E.addUserDefect(run.assetId, a, b)
      const d = E.useEditor.getState().project.defects.find(x => x.id === id)
      return { id, src: d.src, phrase: [d.phrase.t0, d.phrase.t1], text: d.phrase.text }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_regenerate', {
  description:
    'Re-synthesise the CONFIRMED defective phrases of one voice-over and splice them back into ' +
    'the audio. Acts ONLY on defects whose state is "confirmed" — it will not touch "proposed" ' +
    'ones, because confirming is the user\'s judgement, not yours. Phrases that touch are merged ' +
    'and everything is spliced in one pass: one new audio file, one undo entry. ' +
    'The patch is sped up by the SAME factor the file was (VoiceRun.tempo), levelled to the ' +
    'stretch it replaces and joined with equal-power crossfades in the silence between sentences. ' +
    'The result is almost never the same length, so by default everything after the splice is ' +
    'SHIFTED (ripple) across all unlocked tracks — otherwise the picture would drift out of sync. ' +
    'COSTS ElevenLabs credits, one request per phrase: tell the user how many before calling. ' +
    'Refuses when a clip boundary falls inside a phrase being replaced.',
  inputSchema: {
    runId: z.string().optional().describe('voice run; default = the one with confirmed defects'),
    ids: z.array(z.string()).optional().describe('specific defect ids; default = all confirmed'),
    ripple: z.boolean().optional().describe('shift what follows (default true)'),
    rippleAllTracks: z.boolean().optional().describe('shift on every unlocked track (default true)'),
    reverify: z.boolean().optional().describe('run the detector again afterwards (minutes)')
  }
}, async ({ runId, ids, ripple, rippleAllTracks, reverify }) => {
  try {
    const opts = { runId, ids, ripple, rippleAllTracks, reverify }
    return asText(await editorEval(`
      const r = await window.kadrEditor.regenerateDefects(${JSON.stringify(opts)})
      return { phrases: r.units, newAssetId: r.newAssetId, deltaSeconds: r.delta,
               duration: r.duration, seams: r.seams, warnings: r.warnings }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_learn', {
  description:
    'Look at, and optionally retrain, the defect detector\'s confidence model from the verdicts ' +
    'collected so far. WITHOUT retrain (the default) it only reports what the corpus holds — ' +
    'examples, files, how many of the user\'s own marks are usable — and touches nothing. ' +
    'With retrain:true AND confirm:true it rebuilds the model FROM SCRATCH and overwrites the ' +
    'file, which is shared with the user\'s own console ttsqc; the previous model is backed up ' +
    'first. Only ever do this when the user asks for it in so many words — never as tidying up. ' +
    'Be honest about what it buys: confirming and rejecting raises PRECISION; recall only moves ' +
    'for marks the generator already had a candidate for, and marks it never proposes at all ' +
    'cannot be learned by this model — they are counted separately (userUnmatched).',
  inputSchema: {
    retrain: z.boolean().optional().describe('rebuild the model (default: only report)'),
    confirm: z.boolean().optional().describe('required together with retrain:true')
  }
}, async ({ retrain, confirm }) => {
  try {
    if (retrain && !confirm) {
      throw new Error('retraining overwrites the machine-wide model — pass confirm:true once the user has agreed')
    }
    return asText(await editorEval(`
      await window.kadrEditor.flushAllVerdicts()
      const r = await window.kadrEditor.${retrain ? 'retrain()' : 'learnStatus()'}
      return r`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_youtube', {
  description:
    'Search YouTube videos/audio or download media directly into the project.\n' +
    'Actions:\n' +
    '- "search": search YouTube by query, returns matching items (id, title, duration, uploader, url, thumbnail).\n' +
    '- "download": download a video or audio by URL into the project media bin and optionally insert it onto the timeline. ' +
    'Supports cutting a segment via startSec / endSec, downloading audio-only (mp3/wav) for music/sfx/podcasts.',
  inputSchema: {
    action: z.enum(['search', 'download']).describe('action to perform'),
    query: z.string().optional().describe('search query or video URL for "search"'),
    url: z.string().optional().describe('video/stream URL for "download"'),
    title: z.string().optional().describe('custom asset title for "download"'),
    audioOnly: z.boolean().optional().describe('true to extract and download only the audio track'),
    startSec: z.number().optional().describe('trim segment start in seconds'),
    endSec: z.number().optional().describe('trim segment end in seconds'),
    insertOnTimeline: z.boolean().optional().describe('true to place the downloaded clip onto the timeline'),
    trackId: z.string().optional().describe('target track id to insert on; defaults to first matching video/audio track'),
    at: z.number().optional().describe('timeline time in seconds to insert at; defaults to playhead')
  }
}, async (args) => {
  try {
    if (args.action === 'search') {
      if (!args.query) throw new Error('query parameter is required for action "search"')
      return asText(await editorEval(`
        const res = await window.kadr.ytSearch(${JSON.stringify(args.query)})
        if (res.error) throw new Error(res.error)
        return res.items || []`))
    }
    if (args.action === 'download') {
      if (!args.url) throw new Error('url parameter is required for action "download"')
      return asText(await editorEval(`
        const r = await window.kadrEditor.downloadYouTubeMedia(
          ${JSON.stringify({
            url: args.url,
            title: args.title || 'YouTube media',
            audioOnly: args.audioOnly,
            startSec: args.startSec,
            endSec: args.endSec
          })},
          ${JSON.stringify({
            insertOnTimeline: args.insertOnTimeline,
            trackId: args.trackId,
            at: args.at
          })}
        )
        return {
          assetId: r.asset.id,
          name: r.asset.name,
          duration: r.asset.duration,
          path: r.asset.path,
          insertedClipId: r.insertedClipId
        }`))
    }
    throw new Error('unknown action')
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_image', {
  description:
    'Search for images/photos across the Web, Pinterest, Wallpaper catalogs or transparent PNG sources, ' +
    'and download them directly into the project.\n' +
    'Actions:\n' +
    '- "search": search images by query and source ("web", "pinterest", "wallpapers", "transparent").\n' +
    '- "download": download an image by URL into the project media bin and optionally insert it onto a video track.',
  inputSchema: {
    action: z.enum(['search', 'download']).describe('action to perform'),
    query: z.string().optional().describe('search query for "search"'),
    source: z.enum(['web', 'pinterest', 'wallpapers', 'transparent']).optional().describe('image source category'),
    page: z.number().optional().describe('page number for search results'),
    url: z.string().optional().describe('image URL for "download"'),
    title: z.string().optional().describe('asset title for downloaded image'),
    insertOnTimeline: z.boolean().optional().describe('true to place the image onto a video track'),
    trackId: z.string().optional().describe('target track id; defaults to first video track'),
    at: z.number().optional().describe('timeline time in seconds to insert at; defaults to playhead'),
    duration: z.number().optional().describe('duration in seconds on timeline (default 5s)')
  }
}, async (args) => {
  try {
    if (args.action === 'search') {
      if (!args.query) throw new Error('query parameter is required for action "search"')
      return asText(await editorEval(`
        const res = await window.kadr.imageSearch(${JSON.stringify({
          query: args.query,
          source: args.source || 'web',
          page: args.page || 1
        })})
        if (res.error) throw new Error(res.error)
        return res.items || []`))
    }
    if (args.action === 'download') {
      if (!args.url) throw new Error('url parameter is required for action "download"')
      return asText(await editorEval(`
        const r = await window.kadrEditor.downloadAndImportImage(
          ${JSON.stringify({
            url: args.url,
            title: args.title || 'Image'
          })},
          ${JSON.stringify({
            insertOnTimeline: args.insertOnTimeline,
            trackId: args.trackId,
            at: args.at,
            duration: args.duration || 5
          })}
        )
        return {
          assetId: r.asset.id,
          name: r.asset.name,
          width: r.asset.width,
          height: r.asset.height,
          path: r.asset.path,
          insertedClipId: r.insertedClipId
        }`))
    }
    throw new Error('unknown action')
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_clean_speech', {
  description:
    'Automatically clean an audio or voice clip on the timeline by detecting speech with Silero VAD, ' +
    'shortening dead pauses to a natural pacing, and detecting/attenuating (or excising) breaths. ' +
    'Produces a seamless new audio asset with micro-crossfades to eliminate clicks and updates the clip.',
  inputSchema: {
    clipId: z.string().describe('ID of the audio or video clip to clean'),
    minSilence: z.number().optional().describe('minimum silence length to shorten in seconds (default 0.40)'),
    targetSilence: z.number().optional().describe('target shortened silence length in seconds (default 0.20)'),
    breathMode: z.enum(['duck', 'cut', 'keep']).optional().describe(
      '"duck" (recommended: attenuate breath by dB), "cut" (remove breath), or "keep" (preserve breath)'),
    breathDuckDb: z.number().optional().describe('attenuation in dB when breathMode is "duck" (default -18)'),
    crossfadeMs: z.number().optional().describe('seam crossfade in milliseconds (default 15)')
  }
}, async ({ clipId, minSilence, targetSilence, breathMode, breathDuckDb, crossfadeMs }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.cleanSpeechForClip(
        ${JSON.stringify(clipId)},
        ${JSON.stringify({
          minSilence: typeof minSilence === 'number' ? minSilence : 0.40,
          targetSilence: typeof targetSilence === 'number' ? targetSilence : 0.20,
          breathMode: breathMode || 'duck',
          breathDuckDb: typeof breathDuckDb === 'number' ? breathDuckDb : -18,
          crossfadeMs: typeof crossfadeMs === 'number' ? crossfadeMs : 15
        })}
      )
      return {
        silencesShortened: r.silencesShortened,
        breathsDucked: r.breathsDucked,
        breathsCut: r.breathsCut,
        origDuration: r.origDuration,
        newDuration: r.newDuration,
        savedSeconds: r.savedSeconds,
        outputPath: r.outputPath
      }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_color_grade', {
  description:
    'Apply professional cinematic color grading (Lumetri style) to any video or image clip. ' +
    'Can apply predefined looks or fine-tune exposure, contrast, temperature, tint, shadows, highlights, saturation, clarity, vignette.',
  inputSchema: {
    clipId: z.string().describe('target clip ID to apply color grading to'),
    preset: z.enum([
      'tealOrange', 'cyberpunk', 'filmWarm', 'noir', 'cleanPunch', 'fadedMatte', 'reset'
    ]).optional().describe('cinematic look preset'),
    exposure: z.number().optional().describe('exposure adjustment (-2.0 to 2.0, default 0)'),
    contrast: z.number().optional().describe('contrast factor (0.5 to 2.0, default 1.0)'),
    saturation: z.number().optional().describe('saturation factor (0.0 to 2.5, default 1.0)'),
    temperature: z.number().optional().describe('color temperature in Kelvin (2000 to 10000, default 6500 neutral)'),
    tint: z.number().optional().describe('green-magenta tint (-100 to 100, default 0)'),
    highlights: z.number().optional().describe('highlights recovery/boost (-100 to 100, default 0)'),
    shadows: z.number().optional().describe('shadows lift/crush (-100 to 100, default 0)'),
    clarity: z.number().optional().describe('midtones contrast / clarity (-100 to 100, default 0)'),
    vignette: z.number().optional().describe('vignette darkness (0.0 to 1.0, default 0)')
  }
}, async (args) => {
  try {
    const { clipId, preset, ...restParams } = args
    return asText(await editorEval(`
      const r = await window.kadrEditor.applyColorGrade(
        ${JSON.stringify(clipId)},
        ${JSON.stringify({
          preset: preset === 'reset' ? undefined : preset,
          params: preset === 'reset' ? window.kadrEditor.COLOR_GRADE_DEFAULTS : restParams
        })}
      )
      return { clipId: r.clipId, effectId: r.effectId, params: r.params }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_motion_track', {
  description:
    'Track motion of an object/person in a video clip and optionally bind another clip (text, sticker, overlay, title) ' +
    'to automatically follow the tracked movement across the timeline using animated keyframes.',
  inputSchema: {
    sourceClipId: z.string().describe('ID of the video clip containing the moving object to track'),
    box: z.object({
      nx: z.number().min(0).max(1).describe('normalized center X coordinate (0.0 to 1.0)'),
      ny: z.number().min(0).max(1).describe('normalized center Y coordinate (0.0 to 1.0)'),
      nw: z.number().min(0.01).max(1).describe('normalized box width (0.01 to 1.0)'),
      nh: z.number().min(0.01).max(1).describe('normalized box height (0.01 to 1.0)')
    }).describe('initial bounding box around the object to track'),
    targetClipId: z.string().optional().describe('ID of another clip (e.g. text or graphic) to bind position to'),
    startSec: z.number().optional().describe('relative start time within the clip in seconds (default 0)'),
    endSec: z.number().optional().describe('relative end time within the clip in seconds (default clip duration)'),
    method: z.enum(['lk', 'template', 'mil']).optional().describe('tracking algorithm: "lk" (Lucas-Kanade point flow), "template", or "mil"')
  }
}, async ({ sourceClipId, box, targetClipId, startSec, endSec, method }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.motionTrackAndBind(
        ${JSON.stringify(sourceClipId)},
        ${JSON.stringify(box)},
        ${JSON.stringify({ targetClipId, startSec, endSec, method })}
      )
      return {
        totalFrames: r.result.totalFrames,
        fps: r.result.fps,
        keyframesCount: r.result.keyframes ? r.result.keyframes.length : 0,
        boundTargetClipId: r.boundTargetClipId
      }`))
  } catch (e) { return asError(e) }
})

// ---------------------------------------------------------------------------
// Transport startup: stdio (always) + StreamableHTTP (when --http-port given)
// ---------------------------------------------------------------------------

/**
 * Publish the MCP HTTP endpoint to a well-known file so external tools
 * (Antigravity, opencode, custom scripts) can discover the running editor.
 */
function publishEndpoint(httpPort) {
  const dir = path.join(os.homedir(), '.kadr')
  const file = path.join(dir, 'mcp-endpoint.json')
  const data = {
    transport: 'streamable-http',
    url: `http://127.0.0.1:${httpPort}/mcp`,
    token: TOKEN,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    // clean up on exit
    const cleanup = () => { try { fs.unlinkSync(file) } catch { /* gone */ } }
    process.on('exit', cleanup)
    process.on('SIGINT', () => { cleanup(); process.exit(0) })
    process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  } catch (err) {
    console.error('[mcp-bridge] failed to write endpoint file:', err.message)
  }
}

async function startTransports() {
  // 1. stdio transport — always on (the embedded agent talks through it)
  const stdioTransport = new StdioServerTransport()
  await server.connect(stdioTransport)

  // 2. StreamableHTTP transport — when --http-port is given
  if (HTTP_PORT !== null) {
    const httpServer = http.createServer(async (req, res) => {
      // Token auth for external clients
      if (req.headers['x-kadr-token'] !== TOKEN && TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid or missing x-kadr-token header' }))
        return
      }

      if (req.url === '/mcp') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless mode
        })
        // Connect the MCP server to this transport for this request
        await server.connect(transport)
        await transport.handleRequest(req, res)
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', pid: process.pid }))
      } else {
        res.writeHead(404).end()
      }
    })

    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      const addr = httpServer.address()
      const port = typeof addr === 'object' ? addr.port : HTTP_PORT
      console.error(`[mcp-bridge] StreamableHTTP listening on http://127.0.0.1:${port}/mcp`)
      publishEndpoint(port)
    })

    httpServer.on('error', (err) => {
      console.error('[mcp-bridge] HTTP server error:', err.message)
    })
  }
}

startTransports().catch((e) => {
  console.error('mcp-bridge failed:', e)
  process.exit(1)
})
