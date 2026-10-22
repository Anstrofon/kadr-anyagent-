#!/usr/bin/env python3
"""Kadr transcription runner: faster-whisper with anti-hallucination guards.

Reads a wav/audio file, streams NDJSON to stdout:
  {"type":"segment","start":..,"end":..,"text":..,"words":[{"start","end","word","probability"}]}
  {"type":"progress","p":0..1}
  {"type":"done","language":"ru","duration":..}
Errors go to stderr with a non-zero exit code.

Hallucination defenses (Whisper invents text in silence/music):
- built-in Silero VAD skips non-speech regions entirely
- condition_on_previous_text=False breaks repetition feedback loops
- compression_ratio / log_prob / no_speech thresholds drop gibberish
- hallucination_silence_threshold skips text "heard" inside long silences
- post-filters: drop segments whose words are uniformly low-confidence and
  collapse runs of identical consecutive segments (classic loop artifact)
"""
import argparse
import itertools
import json
import os
import sys

# Hugging Face's cache places RELATIVE symlinks from snapshots/ into blobs/.
# On some non-native filesystems (NTFS through ntfs3 here) os.symlink of such
# a path fails with ENOENT halfway through a model download. Writing regular
# copies instead works everywhere (an interrupted download can keep its blobs,
# so the cache may use up to twice the model size). MUST be set before
# huggingface_hub is imported.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--duration", type=float, default=0.0)
    # auto: CUDA when it works, CPU otherwise. GTX 16-series and other 4 GB
    # cards do not fit large-v3 in float16, so CUDA defaults to int8_float16.
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--compute-type", default="")
    args = ap.parse_args()

    from faster_whisper import WhisperModel
    from faster_whisper.utils import download_model

    threads = max(4, (os.cpu_count() or 8) - 2)

    # Resolve the model BEFORE choosing a device: a download failure is not a
    # CUDA failure and must not be reported (or retried) as one.
    try:
        model_path = args.model if os.path.isdir(args.model) else download_model(args.model)
    except Exception as exc:
        sys.stderr.write(f"model download failed: {exc}\n")
        raise

    def load(device, compute_type):
        return WhisperModel(model_path, device=device, compute_type=compute_type,
                            cpu_threads=threads)

    model = None
    device = "cpu"
    if args.device in ("auto", "cuda"):
        try:
            model = load("cuda", args.compute_type or "int8_float16")
            device = "cuda"
        except Exception as exc:
            if args.device == "cuda":
                raise
            # no driver / cuBLAS / cuDNN, or not enough VRAM — CPU still works
            print(f"[kadr] CUDA unavailable, using CPU: {exc}", file=sys.stderr)
    if model is None:
        model = load("cpu", args.compute_type or "int8")

    def transcribe(model):
        return model.transcribe(
            args.audio,
            language=None if args.language == "auto" else args.language,
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=120),
            condition_on_previous_text=False,
            word_timestamps=True,
            hallucination_silence_threshold=2.0,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )

    # A model can LOAD on CUDA without its libraries being usable: ctranslate2
    # resolves libcublas at the first encode, not at WhisperModel(). Pulling
    # the first segment forces that encode before anything is emitted, so an
    # "auto" run that cannot really use the card still falls back to CPU.
    try:
        segments, info = transcribe(model)
        it = iter(segments)
        first = next(it, None)
    except Exception as exc:
        if device != "cuda" or args.device == "cuda":
            raise
        print(f"[kadr] CUDA failed, using CPU: {exc}", file=sys.stderr)
        model = load("cpu", args.compute_type or "int8")
        device = "cpu"
        segments, info = transcribe(model)
        it = iter(segments)
        first = next(it, None)

    total = args.duration or getattr(info, "duration", 0) or 0
    prev_text = None
    repeats = 0
    for seg in itertools.chain([first] if first is not None else [], it):
        text = seg.text.strip()
        if not text:
            continue
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3),
             "word": w.word, "probability": round(w.probability, 3)}
            for w in (seg.words or [])
        ]
        # uniformly unsure words = likely confabulated over noise/music
        if words:
            avg_p = sum(w["probability"] for w in words) / len(words)
            if avg_p < 0.2:
                continue
        # collapse repetition loops: the same line over and over
        if text == prev_text:
            repeats += 1
            if repeats >= 2:
                continue
        else:
            prev_text = text
            repeats = 0
        emit({
            "type": "segment",
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": text,
            "words": words,
        })
        if total > 0:
            emit({"type": "progress", "p": min(1.0, seg.end / total)})

    emit({"type": "done", "language": getattr(info, "language", args.language),
          "duration": total})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — single funnel to the caller
        sys.stderr.write(f"transcribe failed: {e}\n")
        sys.exit(1)
