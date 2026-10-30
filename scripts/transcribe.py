"""RestTube local transcription wrapper.

Runs faster-whisper Base (multilingual, CPU int8) fully offline and emits exactly
one bounded JSON object on stdout:

    {"duration": float, "language": str, "cues": [{"start": float, "text": str}]}

The media is decoded HERE, before the engine, with a strict format/protocol
whitelist (concat/hls/dash/sdp can never follow references) into a bounded
float32 PCM file inside the same private job directory; the engine receives the
decoded array, never the media path, so its own unguarded decoder is bypassed.
Failures print a fixed diagnostic token (RESTUBE_ERROR:<CODE>) on stderr and
never echo media content, paths or stack traces.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = PROJECT_ROOT / ".tools" / "models" / "faster-whisper-base"
MAX_DURATION_SECONDS = 7200  # 2 h
SAMPLE_RATE = 16000
# Presupuesto pico explícito del PCM intermedio: 7200 s x 16000 muestras/s x 4 B = 460.8 MiB
# en disco dentro del job dir privado (archivo esparcido); la RAM nunca acumula los bloques.
MAX_PCM_BYTES = MAX_DURATION_SECONDS * SAMPLE_RATE * 4
MAX_CUES = 12000
MAX_TRANSCRIPT_CHARS = 240_000  # Mirror of server TRANSCRIPT_MAX_CHARS (chars + 16 per cue).
CPU_THREADS = 4  # Modest threads: leave headroom on the user's machine.

# Demuxers de contenedores corrientes y autocontenidos. concat/hls/dash/sdp quedan fuera:
# jamás pueden seguir referencias a otros archivos o protocolos.
SELF_CONTAINED_FORMATS = frozenset({
    "mov", "mp4", "m4a", "3gp", "3g2", "mj2",   # familia ISO BMFF
    "matroska", "webm", "avi", "ogg", "wav", "mp3", "flac",
})
DEFAULT_FORMAT_WHITELIST = ",".join(sorted(SELF_CONTAINED_FORMATS))

ERROR_EXIT = {
    "TRANSCRIPTION": 1,
    "FILE_INVALID": 2,
    "FILE_DURATION": 3,
    "TRANSCRIPT_LIMIT": 4,
    "TRANSCRIBER_MISSING": 5,
}


class TranscriptionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> int:
    print(f"RESTUBE_ERROR:{code}", file=sys.stderr)
    return ERROR_EXIT.get(code, 1)


def container_format_allowed(name: str) -> bool:
    """Un contenedor solo pasa si TODOS sus demuxers reportados están en la lista blanca."""
    parts = [part for part in str(name).split(",") if part]
    return bool(parts) and all(part in SELF_CONTAINED_FORMATS for part in parts)


def open_container_av(path: str, options: dict):
    import av  # Deferred: keeps deterministic tests install-free.

    return av.open(path, options=options)


def container_duration_to_seconds(raw) -> float | None:
    """PyAV expone container.duration en unidades AV_TIME_BASE (µs; verificado: WAV de
    0.5 s reporta 500000). Los tests inyectan conversión identidad sobre objetos falsos."""
    if raw is None:
        return None
    import av  # Deferred

    return float(raw) / float(av.time_base)


def audio_resampler_factory(sample_rate: int):
    import av  # Deferred

    return av.AudioResampler(format="flt", layout="mono", rate=sample_rate)


class MemmapSink:
    """Escribe float32 16k mono a un memmap acotado en disco; la RSS no acumula bloques."""

    def __init__(self, np, pcm_path: str, max_samples: int):
        self._np = np
        self._mm = np.memmap(pcm_path, dtype="float32", mode="w+", shape=(max_samples,))
        self.path = pcm_path
        self.written = 0

    def write(self, data):
        block = self._np.asarray(data, dtype="float32").reshape(-1)
        self._mm[self.written:self.written + block.size] = block
        self.written += block.size

    def array_view(self):
        return self._np.memmap(self.path, dtype="float32", mode="r", shape=(self.written,))


def memmap_sink_factory(pcm_path: str, max_samples: int) -> MemmapSink:
    import numpy as np  # Deferred

    return MemmapSink(np, pcm_path, max_samples)


@dataclass
class AudioPayload:
    array: object
    duration: float
    pcm_path: str


def decode_to_memmap(path, dest_dir, max_duration_seconds: float, *, sample_rate: int = SAMPLE_RATE,
                     format_whitelist: str = DEFAULT_FORMAT_WHITELIST, open_container=open_container_av,
                     sink_factory=memmap_sink_factory, resampler_factory=audio_resampler_factory,
                     duration_to_seconds=container_duration_to_seconds) -> AudioPayload:
    """Decodifica solo el archivo local subido: lista blanca de protocolo ('file') y de demuxers,
    duración de metadatos rechazada antes de decodificar, y conteo real de muestras mientras itera
    (metadatos deshonestos incluidos). Nunca recorta: el exceso es rechazo."""
    max_samples = max_duration_seconds * sample_rate
    options = {"protocol_whitelist": "file", "format_whitelist": format_whitelist}
    try:
        container = open_container(str(path), options)
    except TranscriptionError:
        raise
    except Exception:
        raise TranscriptionError("FILE_INVALID")
    pcm_path = ""
    try:
        if not container_format_allowed(getattr(container.format, "name", "")):
            raise TranscriptionError("FILE_INVALID")
        duration = duration_to_seconds(getattr(container, "duration", None))
        if duration is not None and duration > max_duration_seconds:
            raise TranscriptionError("FILE_DURATION")  # antes de decodificar un solo bloque
        audio_streams = list(getattr(container.streams, "audio", ()) or ())
        if not audio_streams:
            raise TranscriptionError("FILE_INVALID")
        resampler = resampler_factory(sample_rate)
        handle = tempfile.NamedTemporaryFile(dir=str(dest_dir), prefix="pcm-", suffix=".f32", delete=False)
        pcm_path = handle.name
        handle.close()
        sink = sink_factory(pcm_path, max_samples)
        for frame in container.decode(audio=0):  # índice del stream de audio (av 15)
            for out in resampler.resample(frame):
                data = out.to_ndarray()
                if sink.written + getattr(data, "size", 0) > max_samples:
                    raise TranscriptionError("FILE_DURATION")
                sink.write(data)
        if sink.written == 0:
            raise TranscriptionError("FILE_INVALID")  # silencio total o medio sin audio
        return AudioPayload(array=sink.array_view(), duration=sink.written / sample_rate, pcm_path=pcm_path)
    except BaseException:
        if pcm_path:
            try:
                os.unlink(pcm_path)
            except OSError:
                pass
        raise
    finally:
        container.close()


def build_engine(model_dir: Path, cpu_threads: int):
    # Offline by construction: local directory + explicit HF offline switches.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    from faster_whisper import WhisperModel  # Deferred: keeps deterministic tests install-free.

    return WhisperModel(
        str(model_dir), device="cpu", compute_type="int8",
        cpu_threads=cpu_threads, local_files_only=True,
    )


def transcribe_media(path, model_dir: Path = MODEL_DIR, engine_factory=build_engine,
                     decoder_factory=decode_to_memmap,
                     max_duration_seconds: float = MAX_DURATION_SECONDS) -> dict:
    """El motor recibe el audio ya decodificado y acotado; jamás la ruta del medio."""
    if re.match(r"^[A-Za-z][A-Za-z0-9+.\-]*://", str(path)):
        raise TranscriptionError("FILE_INVALID")
    if not model_dir.is_dir():
        raise TranscriptionError("TRANSCRIBER_MISSING")
    try:
        payload = decoder_factory(path, Path(path).parent, max_duration_seconds)
    except TranscriptionError:
        raise
    except ImportError:
        raise TranscriptionError("TRANSCRIBER_MISSING")
    except Exception:
        raise TranscriptionError("FILE_INVALID")
    try:
        try:
            engine = engine_factory(model_dir, CPU_THREADS)
            segments, info = engine.transcribe(audio=payload.array)
        except TranscriptionError:
            raise
        except Exception:
            raise TranscriptionError("TRANSCRIPTION")
        cues = []
        characters = 0
        for segment in segments:
            text = (getattr(segment, "text", "") or "").strip()
            start = float(getattr(segment, "start", 0.0))
            end = float(getattr(segment, "end", 0.0))
            if not text:
                continue
            if start < 0 or end < start or end > max_duration_seconds:
                raise TranscriptionError("FILE_DURATION")
            characters += len(text) + 16
            if characters > MAX_TRANSCRIPT_CHARS or len(cues) >= MAX_CUES:
                raise TranscriptionError("TRANSCRIPT_LIMIT")
            cues.append({"start": start, "text": text})
        if not cues:
            # Silencio o motor sin segmentos: nunca una transcripción fabricada.
            raise TranscriptionError("FILE_INVALID")
        language = getattr(info, "language", None) or "unknown"
        # La duración emitida es del medio decodificado completo (incluye silencio final),
        # no del final del último segmento de habla.
        return {"duration": payload.duration, "language": language, "cues": cues}
    finally:
        try:
            os.unlink(payload.pcm_path)
        except OSError:
            pass


def main(argv=None, model_dir: Path = MODEL_DIR, engine_factory=None, decoder_factory=None) -> int:
    parser = argparse.ArgumentParser(
        prog="transcribe.py",
        description="Transcripción local offline (faster-whisper Base int8) para ResTube.",
    )
    parser.add_argument("--media", required=True, help="Ruta local del archivo subido; jamás una URL.")
    args = parser.parse_args(argv)
    media = Path(args.media)
    if not media.is_file():
        return fail("FILE_INVALID")
    try:
        payload = transcribe_media(media, model_dir=model_dir,
                                   engine_factory=engine_factory or build_engine,
                                   decoder_factory=decoder_factory or decode_to_memmap)
    except TranscriptionError as error:
        return fail(error.code)
    except ImportError:
        return fail("TRANSCRIBER_MISSING")
    except Exception:
        # Sanitized: no exception text, no media content, no paths.
        return fail("TRANSCRIPTION")
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
