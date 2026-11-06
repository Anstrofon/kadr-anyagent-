#!/usr/bin/env python3
"""Kadr clean speech runner: automatic silence shortening and breath detection/removal.

Analyzes voice/audio track:
1. Silero VAD detects speech segments with fine temporal precision.
2. Interspeech gaps are analyzed for breaths (broadband noise, high spectral flatness, low HNR)
   and dead silences.
3. Long pauses are shortened to a natural gap (e.g. 200ms) with micro-crossfades to prevent clicks.
4. Breaths can be cleanly ducked (e.g. -18dB) or excised.
5. Saves clean WAV/FLAC audio with full sample accuracy.

Outputs NDJSON to stdout:
  {"type": "progress", "p": 0.4, "stage": "analyzing"}
  {"type": "done", "silences_shortened": 12, "breaths_ducked": 5, ...}
"""
import argparse
import json
import math
import os
import sys
import numpy as np


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_audio_mono16k(path: str) -> tuple[np.ndarray, int]:
    """Load audio as 16kHz float32 mono for VAD and acoustic feature analysis."""
    import av

    container = av.open(path)
    audio_streams = [s for s in container.streams if s.type == "audio"]
    if not audio_streams:
        raise ValueError("no audio stream found")

    resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
    chunks = []
    for frame in container.decode(audio_streams[0]):
        rf = resampler.resample(frame)
        if rf:
            for f in rf:
                chunks.append(f.to_ndarray()[0])

    if not chunks:
        return np.zeros(0, dtype=np.float32), 16000

    audio = np.concatenate(chunks)
    return audio, 16000


def load_audio_native(path: str) -> tuple[np.ndarray, int, int]:
    """Load native audio as float32 array [channels, samples], sample_rate, num_channels."""
    import av

    container = av.open(path)
    audio_streams = [s for s in container.streams if s.type == "audio"]
    if not audio_streams:
        raise ValueError("no audio stream found")

    stream = audio_streams[0]
    sr = stream.rate or 44100
    channels = stream.channels or 1

    # Keep native channels & rate
    resampler = av.AudioResampler(
        format="flt",
        layout="mono" if channels == 1 else "stereo",
        rate=sr
    )

    chunks = []
    for frame in container.decode(stream):
        rf = resampler.resample(frame)
        if rf:
            for f in rf:
                chunks.append(f.to_ndarray())

    if not chunks:
        return np.zeros((channels, 0), dtype=np.float32), sr, channels

    full = np.concatenate(chunks, axis=1)
    return full, sr, full.shape[0]


def save_audio(path: str, data: np.ndarray, sr: int):
    """Save float32 audio (channels, samples) to WAV or FLAC via PyAV."""
    import av

    # Ensure channels x samples
    if data.ndim == 1:
        data = data.reshape(1, -1)

    channels, num_samples = data.shape
    container = av.open(path, mode="w")

    ext = os.path.splitext(path)[1].lower()
    codec_name = "flac" if ext == ".flac" else "pcm_s16le"

    layout = "mono" if channels == 1 else "stereo"
    stream = container.add_stream(codec_name, rate=sr, layout=layout)

    # Convert float32 [-1.0, 1.0] to int16 for pcm_s16le or flac s16
    clamped = np.clip(data, -1.0, 1.0)
    int_data = (clamped * 32767.0).astype(np.int16)

    # Encode in chunks
    frame_size = 4096
    layout_name = "mono" if channels == 1 else "stereo"
    for i in range(0, num_samples, frame_size):
        chunk = int_data[:, i:i + frame_size]
        if chunk.shape[1] == 0:
            continue
        chunk_packed = chunk.T.reshape(1, -1) if channels > 1 else chunk
        frame = av.AudioFrame.from_ndarray(chunk_packed, format="s16", layout=layout_name)
        frame.rate = sr
        for packet in stream.encode(frame):
            container.mux(packet)

    for packet in stream.encode():
        container.mux(packet)

    container.close()


def detect_speech_vad(audio16k: np.ndarray) -> np.ndarray:
    """Silero VAD frame probabilities (512 samples = 32ms hop)."""
    from faster_whisper.vad import get_vad_model
    model = get_vad_model()
    chunk = 512
    n = (len(audio16k) // chunk) * chunk
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    probs = model(np.ascontiguousarray(audio16k[:n], dtype=np.float32))
    return np.ravel(np.asarray(probs, dtype=np.float32))


def analyze_breath(audio16k: np.ndarray, t0: float, t1: float, sr: int = 16000) -> dict:
    """Check if window [t0, t1] contains breath characteristics.

    Breaths:
    - High spectral flatness (> 0.28)
    - Low HNR (< 4.5 dB)
    - Broadband energy predominantly in 500-3500 Hz
    - Moderate RMS (above noise floor, below modal speech)
    """
    s0 = max(0, int(t0 * sr))
    s1 = min(len(audio16k), int(t1 * sr))
    if s1 - s0 < 256:
        return {"is_breath": False, "score": 0.0}

    chunk = audio16k[s0:s1]
    rms = float(np.sqrt(np.mean(chunk ** 2)) + 1e-12)
    rms_db = 20.0 * math.log10(rms)

    win = 512
    n_frames = len(chunk) // win
    if n_frames < 1:
        return {"is_breath": False, "score": 0.0}

    frames = chunk[:n_frames * win].reshape(-1, win) * np.hanning(win)
    spec = np.abs(np.fft.rfft(frames, axis=1)) + 1e-10
    gm = np.exp(np.mean(np.log(spec), axis=1))
    am = np.mean(spec, axis=1)
    flatness = float(np.mean(gm / am))

    # HNR
    x = chunk - chunk.mean()
    ac = np.correlate(x, x, mode="full")[x.size - 1:]
    ac /= (ac[0] + 1e-12)
    lo, hi = sr // 400, sr // 80
    peak = float(ac[lo:hi].max()) if hi < ac.size else 0.0
    peak = min(max(peak, 1e-6), 0.999)
    hnr = float(10.0 * math.log10(peak / (1.0 - peak)))

    # Breath decision
    # Typical breath: flatness > 0.28, hnr < 4.0, rms_db between -48 and -20
    is_breath = (flatness > 0.28 and hnr < 4.5 and -50.0 < rms_db < -18.0)
    score = (flatness * 0.5) + (max(0.0, 5.0 - hnr) * 0.1)

    return {
        "is_breath": is_breath,
        "score": score,
        "flatness": flatness,
        "hnr": hnr,
        "rms_db": rms_db
    }


def find_breaths_in_gap(audio16k: np.ndarray, t0: float, t1: float, sr: int = 16000) -> list[tuple[float, float]]:
    """Scan gap [t0, t1] for breath intervals."""
    dur = t1 - t0
    if dur < 0.15:
        return []

    breaths = []
    win_len = 0.20  # 200ms window
    step = 0.05     # 50ms step

    t = t0
    cur_start = None
    cur_end = None

    while t + win_len <= t1 + 0.02:
        info = analyze_breath(audio16k, t, min(t1, t + win_len), sr)
        if info["is_breath"]:
            if cur_start is None:
                cur_start = t
            cur_end = min(t1, t + win_len)
        else:
            if cur_start is not None:
                if cur_end - cur_start >= 0.10:  # min breath 100ms
                    breaths.append((cur_start, cur_end))
                cur_start = None
                cur_end = None
        t += step

    if cur_start is not None and cur_end - cur_start >= 0.10:
        breaths.append((cur_start, cur_end))

    # Merge overlapping breath regions
    if not breaths:
        return []

    merged = [list(breaths[0])]
    for b in breaths[1:]:
        if b[0] <= merged[-1][1] + 0.05:
            merged[-1][1] = max(merged[-1][1], b[1])
        else:
            merged.append(list(b))

    return [(m[0], m[1]) for m in merged]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Input audio file")
    ap.add_argument("--output", required=True, help="Output audio file")
    ap.add_argument("--min-silence", type=float, default=0.40, help="Min silence duration in seconds to shorten")
    ap.add_argument("--target-silence", type=float, default=0.20, help="Target shortened silence duration in seconds")
    ap.add_argument("--breath-mode", choices=["duck", "cut", "keep"], default="duck", help="How to handle breaths")
    ap.add_argument("--breath-duck-db", type=float, default=-18.0, help="Attenuation in dB when breath-mode is duck")
    ap.add_argument("--crossfade-ms", type=float, default=15.0, help="Crossfade duration in ms")
    args = ap.parse_args()

    emit({"type": "progress", "p": 0.05, "stage": "loading"})

    # 1. Load audio
    audio16k, sr16k = load_audio_mono16k(args.input)
    native_data, native_sr, channels = load_audio_native(args.input)

    orig_duration = native_data.shape[1] / float(native_sr)
    if orig_duration <= 0.2:
        emit({"type": "error", "message": "audio is too short"})
        sys.exit(1)

    emit({"type": "progress", "p": 0.20, "stage": "vad"})

    # 2. Silero VAD
    probs = detect_speech_vad(audio16k)
    hop_s = 512 / 16000.0  # 32ms

    # Speech thresholding with pad
    is_speech = probs > 0.45
    pad_frames = int(0.08 / hop_s)  # 80ms pad

    speech_mask = np.zeros(len(probs), dtype=bool)
    speech_indices = np.where(is_speech)[0]
    for idx in speech_indices:
        start_f = max(0, idx - pad_frames)
        end_f = min(len(probs), idx + pad_frames + 1)
        speech_mask[start_f:end_f] = True

    # Find speech intervals and non-speech gaps
    speech_intervals = []
    i = 0
    n_frames = len(speech_mask)
    while i < n_frames:
        if not speech_mask[i]:
            i += 1
            continue
        j = i
        while j < n_frames and speech_mask[j]:
            j += 1
        speech_intervals.append((i * hop_s, min(orig_duration, j * hop_s)))
        i = j

    # Merge very close speech intervals (< 120ms)
    merged_speech = []
    if speech_intervals:
        merged_speech.append(list(speech_intervals[0]))
        for sp in speech_intervals[1:]:
            if sp[0] - merged_speech[-1][1] < 0.12:
                merged_speech[-1][1] = sp[1]
            else:
                merged_speech.append(list(sp))

    # Gaps between speech
    gaps = []
    last_end = 0.0
    for sp in merged_speech:
        if sp[0] > last_end:
            gaps.append((last_end, sp[0]))
        last_end = sp[1]
    if last_end < orig_duration:
        gaps.append((last_end, orig_duration))

    emit({"type": "progress", "p": 0.45, "stage": "analyzing_breaths"})

    # 3. Analyze each gap for breaths & silence
    silences_shortened = 0
    breaths_ducked = 0
    breaths_cut = 0

    duck_gain = math.pow(10.0, args.breath_duck_db / 20.0)

    # Work directly on native audio sample array
    # We will construct a time edit list: segments of audio to keep or attenuate
    # Edit action: ('keep', t0, t1), ('duck', t0, t1, gain), ('fade', t0, t1)
    
    # Let's map gaps into sub-actions
    # For each gap [g0, g1]:
    #   detect breaths inside [g0, g1]
    #   if breath-mode == 'cut': treat breath as removable silence
    #   if breath-mode == 'duck': duck breath, and shorten remaining silence around it
    actions = []
    # Interleave speech and processed gaps
    speech_idx = 0
    num_speech = len(merged_speech)

    cur_time = 0.0
    for g0, g1 in gaps:
        # Before gap, add speech segment that precedes it
        while speech_idx < num_speech and merged_speech[speech_idx][0] < g1:
            s_t0, s_t1 = merged_speech[speech_idx]
            if s_t0 >= cur_time:
                actions.append({"type": "keep", "t0": s_t0, "t1": s_t1})
                cur_time = s_t1
            speech_idx += 1

        gap_dur = g1 - g0
        if gap_dur < args.min_silence:
            # Too short to alter, keep as is
            actions.append({"type": "keep", "t0": g0, "t1": g1})
            cur_time = g1
            continue

        # Look for breaths
        breaths = find_breaths_in_gap(audio16k, g0, g1, sr16k) if args.breath_mode != "keep" else []

        if not breaths:
            # Pure silence gap
            # Shorten from gap_dur to target_silence
            silences_shortened += 1
            if args.target_silence > 0:
                # Keep target_silence around center/edges
                # Keeping half at start and half at end preserves natural room decay & attack
                half = args.target_silence / 2.0
                actions.append({"type": "keep", "t0": g0, "t1": min(g1, g0 + half)})
                actions.append({"type": "keep", "t0": max(g0, g1 - half), "t1": g1})
            cur_time = g1
        else:
            # Gap with breath(s)
            if args.breath_mode == "cut":
                # Cut breaths along with excess silence
                breaths_cut += len(breaths)
                silences_shortened += 1
                if args.target_silence > 0:
                    half = args.target_silence / 2.0
                    actions.append({"type": "keep", "t0": g0, "t1": min(g1, g0 + half)})
                    actions.append({"type": "keep", "t0": max(g0, g1 - half), "t1": g1})
                cur_time = g1
            elif args.breath_mode == "duck":
                # Duck the breath, shorten silence around it
                breaths_ducked += len(breaths)
                silences_shortened += 1
                # Subdivide gap: before breath, breath (ducked), after breath
                b_t0, b_t1 = breaths[0]  # primary breath
                pre_dur = b_t0 - g0
                post_dur = g1 - b_t1
                target_half = args.target_silence / 2.0

                if pre_dur > target_half:
                    actions.append({"type": "keep", "t0": max(g0, b_t0 - target_half), "t1": b_t0})
                else:
                    actions.append({"type": "keep", "t0": g0, "t1": b_t0})

                actions.append({"type": "duck", "t0": b_t0, "t1": b_t1, "gain": duck_gain})

                if post_dur > target_half:
                    actions.append({"type": "keep", "t0": b_t1, "t1": min(g1, b_t1 + target_half)})
                else:
                    actions.append({"type": "keep", "t0": b_t1, "t1": g1})

                cur_time = g1

    # Add any remaining speech at the end
    while speech_idx < num_speech:
        s_t0, s_t1 = merged_speech[speech_idx]
        if s_t0 >= cur_time:
            actions.append({"type": "keep", "t0": s_t0, "t1": s_t1})
            cur_time = s_t1
        speech_idx += 1

    emit({"type": "progress", "p": 0.70, "stage": "rendering"})

    # 4. Render processed audio with micro-crossfades
    xfade_samples = int((args.crossfade_ms / 1000.0) * native_sr)
    if xfade_samples % 2 != 0:
        xfade_samples += 1

    chunks = []
    for act in actions:
        s0 = max(0, int(act["t0"] * native_sr))
        s1 = min(native_data.shape[1], int(act["t1"] * native_sr))
        if s1 <= s0:
            continue
        c = native_data[:, s0:s1].copy()
        if act["type"] == "duck":
            # Smoothly duck gain in and out
            gain = act["gain"]
            fade_len = min(xfade_samples, c.shape[1] // 2)
            if fade_len > 1:
                env = np.ones(c.shape[1], dtype=np.float32) * gain
                # ramp down from 1.0 to gain
                env[:fade_len] = np.linspace(1.0, gain, fade_len)
                # ramp up from gain to 1.0
                env[-fade_len:] = np.linspace(gain, 1.0, fade_len)
                c *= env
            else:
                c *= gain
        chunks.append(c)

    if not chunks:
        # Fallback to copy
        out_audio = native_data
    else:
        # Splice chunks with crossfades
        out_parts = [chunks[0]]
        for nxt in chunks[1:]:
            prev = out_parts[-1]
            flen = min(xfade_samples, prev.shape[1] // 4, nxt.shape[1] // 4)
            if flen > 4:
                # Fade out tail of prev, fade in head of nxt
                w_out = np.cos(np.linspace(0, np.pi / 2, flen)) ** 2
                w_in = np.sin(np.linspace(0, np.pi / 2, flen)) ** 2

                # Overlap blend
                blend = prev[:, -flen:] * w_out + nxt[:, :flen] * w_in
                out_parts[-1] = prev[:, :-flen]
                out_parts.append(blend)
                out_parts.append(nxt[:, flen:])
            else:
                out_parts.append(nxt)

        out_audio = np.concatenate(out_parts, axis=1)

    emit({"type": "progress", "p": 0.90, "stage": "saving"})

    # Ensure output dir exists
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)

    save_audio(args.output, out_audio, native_sr)

    new_duration = out_audio.shape[1] / float(native_sr)
    saved_s = max(0.0, orig_duration - new_duration)

    emit({
        "type": "done",
        "output": args.output,
        "silences_shortened": silences_shortened,
        "breaths_ducked": breaths_ducked,
        "breaths_cut": breaths_cut,
        "orig_duration": round(orig_duration, 2),
        "new_duration": round(new_duration, 2),
        "saved_s": round(saved_s, 2)
    })


if __name__ == "__main__":
    main()
