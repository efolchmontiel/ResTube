"""Deterministic tests for the local transcription wrapper (no model/av/numpy install needed).

Run with: python3 -m unittest discover -s scripts -p 'test_*.py'
Engine, container opener, resampler and sink are injected: faster-whisper, av and
numpy are never imported by these tests.
"""
import io
import json
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import transcribe  # noqa: E402


class FakeSegment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class FakeInfo:
    def __init__(self, language="es"):
        self.language = language


class FakeEngine:
    def __init__(self, segments, info=None, crash=None):
        self._segments = segments
        self._info = info or FakeInfo()
        self._crash = crash
        self.audio_received = None

    def transcribe(self, audio=None):
        self.audio_received = audio
        if self._crash is not None:
            raise self._crash
        return iter(self._segments), self._info


class FakeArray:
    """Sustituto mínimo de ndarray: el decoder solo lee .size y lo entrega al sink."""

    def __init__(self, size):
        self.size = size


class FakeFrame:
    def __init__(self, size):
        self._size = size

    def to_ndarray(self):
        return FakeArray(self._size)


class FakeResampler:
    def resample(self, frame):
        return [frame]


class FakeContainer:
    def __init__(self, format_name, duration=None, frames=()):
        self.format = SimpleNamespace(name=format_name)
        self.duration = duration
        self.streams = SimpleNamespace(audio=[SimpleNamespace()])
        self._frames = list(frames)
        self.decode_calls = 0
        self.closed = False
        self.open_options = None

    def decode(self, audio=None):
        self.decode_calls += 1
        yield from self._frames

    def close(self):
        self.closed = True


class FakeSink:
    def __init__(self, path, max_samples):
        self.path = path
        self.max_samples = max_samples
        self.written = 0

    def write(self, data):
        self.written += data.size

    def array_view(self):
        return SimpleNamespace(size=self.written)


def fake_decoder(payload_duration=0.5, frames_size=None, crash=None, samples=None):
    """Decoder falso: crea un pcm real propio (para probar limpieza) y entrega el payload."""
    def factory(path, dest_dir, max_duration_seconds):
        handle = tempfile.NamedTemporaryFile(dir=str(dest_dir), prefix="pcm-", suffix=".f32", delete=False)
        handle.close()
        if crash is not None:
            # Un decoder real limpia su propio temporal al fallar; el wrapper jamás ve rutas.
            pathlib.Path(handle.name).unlink()
            raise crash
        return transcribe.AudioPayload(array=SimpleNamespace(size=samples or 8000), duration=payload_duration, pcm_path=handle.name)
    return factory


def make_fake_container(format_name="mov,mp4,m4a,3gp,3g2,mj2", duration=1.0, frames=None, sample_blocks=(1600,)):
    container = FakeContainer(format_name, duration=duration, frames=[FakeFrame(size) for size in (frames or sample_blocks)])
    def opener(path, options):
        container.open_options = options
        return container
    return container, opener


class DecodeWhitelistTests(unittest.TestCase):
    def test_concat_hls_dash_sdp_are_denied_before_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            for denied in ("concat", "hls", "dash", "sdp"):
                container, opener = make_fake_container(format_name=denied)
                with self.assertRaises(transcribe.TranscriptionError) as raised:
                    transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                                sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
                self.assertEqual(raised.exception.code, "FILE_INVALID", denied)
                self.assertEqual(container.decode_calls, 0)
                self.assertEqual(container.open_options.get("protocol_whitelist"), "file")
                self.assertIn("format_whitelist", container.open_options)

    def test_allowed_selfcontained_format_passes_whitelist_and_options_are_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            container, opener = make_fake_container(format_name="mov,mp4,m4a,3gp,3g2,mj2", duration=0.1)
            payload = transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                                  sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertEqual(container.decode_calls, 1)
            self.assertTrue(pathlib.Path(payload.pcm_path).exists())
            self.assertEqual(container.open_options.get("protocol_whitelist"), "file")
            for allowed in ("mp4", "matroska", "webm", "avi", "ogg", "wav", "mp3", "flac"):
                self.assertIn(allowed, container.open_options.get("format_whitelist"))
            for denied in ("concat", "hls", "dash", "sdp"):
                self.assertNotIn(denied, container.open_options.get("format_whitelist"))
            self.assertTrue(container.closed)  # el decoder es dueño del ciclo de vida del contenedor

    def test_container_format_allowed_is_strict_per_demuxer(self):
        self.assertTrue(transcribe.container_format_allowed("mov,mp4,m4a,3gp,3g2,mj2"))
        self.assertTrue(transcribe.container_format_allowed("matroska,webm"))
        for denied in ("concat", "hls", "dash", "sdp", "http", ""):
            self.assertFalse(transcribe.container_format_allowed(denied))
        self.assertFalse(transcribe.container_format_allowed("mov,concat"))
        self.assertFalse(transcribe.container_format_allowed("matroska,hls"))


class DecodeBudgetTests(unittest.TestCase):
    def test_metadata_duration_over_limit_is_rejected_before_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            container, opener = make_fake_container(duration=transcribe.MAX_DURATION_SECONDS + 1)
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                            sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertEqual(raised.exception.code, "FILE_DURATION")
            self.assertEqual(container.decode_calls, 0)

    def test_actual_decoded_samples_over_limit_rejected_even_with_honest_short_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            # Metadatos de 0.1 s pero bloques que en suma superan el máximo real (2 s = 32000 muestras).
            container, opener = make_fake_container(duration=0.1, sample_blocks=(20000, 20000))
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.decode_to_memmap(media, directory, 2.0, open_container=opener,
                                            sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertEqual(raised.exception.code, "FILE_DURATION")
            self.assertEqual(list(pathlib.Path(directory).glob("pcm-*")), [])

    def test_full_duration_counts_trailing_silence_not_last_speech(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            # 16000 muestras/s: 0.5 s de "habla" + 2.5 s de silencio = 3.0 s completos.
            container, opener = make_fake_container(duration=3.0, sample_blocks=(8000, 40000))
            payload = transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                                  sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertAlmostEqual(payload.duration, 3.0)
            self.assertEqual(payload.array.size, 48000)

    def test_zero_audio_is_rejected_without_inventing_cues(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            container, opener = make_fake_container(duration=1.0, sample_blocks=())
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                            sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertEqual(raised.exception.code, "FILE_INVALID")

    def test_missing_audio_stream_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            container = FakeContainer("mov,mp4,m4a,3gp,3g2,mj2", duration=1.0)
            container.streams = SimpleNamespace(audio=[])
            def opener(path, options):
                container.open_options = options
                return container
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                            sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertEqual(raised.exception.code, "FILE_INVALID")

    def test_open_failure_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            def opener(path, options):
                raise OSError("SECRET local path detail")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.decode_to_memmap(media, directory, transcribe.MAX_DURATION_SECONDS, open_container=opener,
                                            sink_factory=FakeSink, resampler_factory=lambda rate: FakeResampler(),
                                                duration_to_seconds=lambda raw: None if raw is None else float(raw))
            self.assertEqual(raised.exception.code, "FILE_INVALID")


class TranscribeMediaTests(unittest.TestCase):
    def test_emits_one_bounded_json_object_from_real_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input")
            media.write_bytes(b"\x1aE\xdf\xa3 fake container bytes")
            payload = transcribe.transcribe_media(
                media, model_dir=pathlib.Path(directory),
                engine_factory=lambda md, threads: FakeEngine([FakeSegment(0.0, 3.5, " Hola mundo. "), FakeSegment(3.5, 7.0, " Segunda línea.")]),
                decoder_factory=fake_decoder(payload_duration=7.0),
            )
            self.assertEqual(set(payload), {"duration", "language", "cues"})
            # La duración emitida es el medio decodificado completo (con silencio final), no el último segmento.
            self.assertEqual(payload["duration"], 7.0)
            self.assertEqual(payload["language"], "es")
            self.assertEqual(payload["cues"], [
                {"start": 0.0, "text": "Hola mundo."},
                {"start": 3.5, "text": "Segunda línea."},
            ])

    def test_engine_receives_decoded_audio_never_the_media_path(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00")
            engine_holder = {}
            def engine_factory(md, threads):
                engine_holder["engine"] = FakeEngine([FakeSegment(0.0, 0.4, "hola")])
                return engine_holder["engine"]
            transcribe.transcribe_media(media, model_dir=pathlib.Path(directory), engine_factory=engine_factory,
                                        decoder_factory=fake_decoder(payload_duration=0.5))
            self.assertIsNotNone(engine_holder["engine"].audio_received)
            self.assertNotEqual(str(engine_holder["engine"].audio_received), str(media))

    def test_silence_is_rejected_without_inventing_a_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"\x00" * 16)
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory),
                                            engine_factory=lambda md, t: FakeEngine([]),
                                            decoder_factory=fake_decoder(payload_duration=2.0))
            self.assertEqual(raised.exception.code, "FILE_INVALID")

    def test_missing_media_file_is_rejected_before_any_engine_work(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(pathlib.Path(directory, "absent"), model_dir=pathlib.Path(directory),
                                            engine_factory=lambda md, t: FakeEngine([]),
                                            decoder_factory=fake_decoder(payload_duration=1.0))
            self.assertEqual(raised.exception.code, "FILE_INVALID")

    def test_url_like_media_is_rejected_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            for url in ("https://example.invalid/video.mp4", "http://127.0.0.1:1/x", "rtsp://cam/stream"):
                with self.assertRaises(transcribe.TranscriptionError) as raised:
                    transcribe.transcribe_media(url, model_dir=pathlib.Path(directory), engine_factory=lambda md, t: FakeEngine([]),
                                                decoder_factory=fake_decoder(payload_duration=1.0))
                self.assertEqual(raised.exception.code, "FILE_INVALID")

    def test_missing_model_environment_reports_transcriber_missing_before_decoder(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"x")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory, "absent-model"),
                                            engine_factory=lambda md, t: FakeEngine([FakeSegment(0, 1, "hola")]),
                                            decoder_factory=fake_decoder(payload_duration=1.0))
            self.assertEqual(raised.exception.code, "TRANSCRIBER_MISSING")

    def test_duration_limit_is_enforced_without_truncation_or_partial_output(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"x")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory), max_duration_seconds=2.0,
                    engine_factory=lambda md, t: FakeEngine([FakeSegment(0.0, 3.0, "largo")]),
                    decoder_factory=fake_decoder(payload_duration=2.0))
            self.assertEqual(raised.exception.code, "FILE_DURATION")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory),
                    engine_factory=lambda md, t: FakeEngine([FakeSegment(0.0, 10.0, "x" * transcribe.MAX_TRANSCRIPT_CHARS)]),
                    decoder_factory=fake_decoder(payload_duration=10.0))
            self.assertEqual(raised.exception.code, "TRANSCRIPT_LIMIT")

    def test_decoder_metadata_rejection_reaches_the_engine_never(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"x")
            engine_holder = {}
            def engine_factory(md, threads):
                engine_holder["engine"] = FakeEngine([])
                return engine_holder["engine"]
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory), engine_factory=engine_factory,
                                            decoder_factory=fake_decoder(crash=transcribe.TranscriptionError("FILE_DURATION")))
            self.assertEqual(raised.exception.code, "FILE_DURATION")
            self.assertNotIn("engine", engine_holder)

    def test_decoder_failure_is_sanitized_and_owned_tempfile_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"SECRET audio bytes")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory),
                                            engine_factory=lambda md, t: FakeEngine([]),
                                            decoder_factory=fake_decoder(crash=RuntimeError("SECRET decode failure")))
            self.assertEqual(raised.exception.code, "FILE_INVALID")
            self.assertEqual(list(pathlib.Path(directory).glob("pcm-*")), [])
            self.assertEqual(list(pathlib.Path(directory).glob("*.f32")), [])

    def test_engine_crash_cleans_the_owned_tempfile(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"SECRET audio bytes")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory),
                                            engine_factory=lambda md, t: FakeEngine([], crash=RuntimeError("SECRET decode failure")),
                                            decoder_factory=fake_decoder(payload_duration=1.0))
            self.assertEqual(raised.exception.code, "TRANSCRIPTION")
            self.assertEqual(list(pathlib.Path(directory).glob("pcm-*")), [])
            self.assertEqual(list(pathlib.Path(directory).glob("*.f32")), [])

    def test_missing_av_environment_reports_transcriber_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"x")
            def broken_decoder(path, dest_dir, max_duration_seconds):
                import numpy  # no está en el intérprete de pruebas
                return transcribe.AudioPayload(array=None, duration=1.0, pcm_path="")
            with self.assertRaises(transcribe.TranscriptionError) as raised:
                transcribe.transcribe_media(media, model_dir=pathlib.Path(directory),
                                            engine_factory=lambda md, t: FakeEngine([]),
                                            decoder_factory=broken_decoder)
            self.assertEqual(raised.exception.code, "TRANSCRIBER_MISSING")


class MainInterfaceTests(unittest.TestCase):
    def test_success_writes_exactly_one_json_object_to_stdout(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"x")
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = transcribe.main(["--media", str(media)], model_dir=pathlib.Path(directory),
                                       engine_factory=lambda md, t: FakeEngine([FakeSegment(0.0, 2.0, "hola")]),
                                       decoder_factory=fake_decoder(payload_duration=2.0))
            self.assertEqual(code, 0)
            self.assertEqual(err.getvalue(), "")
            payload = json.loads(out.getvalue())
            self.assertEqual(payload, {"duration": 2.0, "language": "es", "cues": [{"start": 0.0, "text": "hola"}]})

    def test_known_failure_prints_only_the_error_token(self):
        with tempfile.TemporaryDirectory() as directory:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = transcribe.main(["--media", str(pathlib.Path(directory, "absent"))])
            self.assertEqual(code, transcribe.ERROR_EXIT["FILE_INVALID"])
            self.assertEqual(out.getvalue(), "")
            self.assertEqual(err.getvalue(), "RESTUBE_ERROR:FILE_INVALID\n")
            self.assertNotIn(directory, err.getvalue())

    def test_rejects_calls_without_media_argument(self):
        with self.assertRaises(SystemExit):
            transcribe.main([])

    def test_default_engine_requires_a_local_model_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            media = pathlib.Path(directory, "input"); media.write_bytes(b"x")
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = transcribe.main(["--media", str(media)], model_dir=pathlib.Path(directory, "no-model"))
            self.assertEqual(code, transcribe.ERROR_EXIT["TRANSCRIBER_MISSING"])
            self.assertEqual(out.getvalue(), "")


class DefaultModelPathTests(unittest.TestCase):
    def test_model_directory_is_project_local_and_not_a_url(self):
        self.assertTrue(str(transcribe.MODEL_DIR).startswith(str(transcribe.PROJECT_ROOT)))
        self.assertIn(".tools", str(transcribe.MODEL_DIR))
        self.assertEqual(transcribe.CPU_THREADS, 4)
        self.assertLessEqual(transcribe.CPU_THREADS, 8)
        # Presupuesto pico explícito: 7200 s x 16000 muestras/s en float32.
        self.assertEqual(transcribe.MAX_DURATION_SECONDS * transcribe.SAMPLE_RATE * 4, 460_800_000)
        self.assertEqual(transcribe.SAMPLE_RATE, 16000)
        for denied in ("concat", "hls", "dash", "sdp"):
            self.assertNotIn(denied, transcribe.DEFAULT_FORMAT_WHITELIST)


if __name__ == "__main__":
    unittest.main()
