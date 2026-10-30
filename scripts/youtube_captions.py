"""Adaptador de subtítulos de YouTube para ResTube (producción local).

Adquisición acotada con tubescrape 0.5.0 desde el venv propio del proyecto
(.tools/captions/python). En éxito imprime por stdout un objeto JSON estricto
{"language": "...", "cues": [{"start": <s>, "text": "..."}]}; en fallo imprime
por stderr {"error": "RESTUBE_<TOKEN>"} fijo con código de salida 1 (2 por argv
inválido) — el runner de Node conserva stderr en el rechazo, no stdout. Nunca
imprime excepciones, URLs firmadas, claves de API ni contenido de
transcripciones; el logging de la librería se desactiva porque sus advertencias
pueden incluir URLs firmadas.

Límites del contrato (los defaults de la librería NO son seguros):
- cero reintentos (max_retries=0 y CAPTCHA_MAX_RETRIES=1), nunca reintenta 403/429;
- sin cookies, sin proxies (httpx trust_env=False), sin redirecciones;
- solo HTTPS www.youtube.com en /youtubei/v1/player, /watch y /api/timedtext
  con v=<id> exacto, sin tlang (sin traducción) ni otros idiomas;
- presupuesto de 4 pedidos y tope de bytes por respuesta con conteo en stream;
- selección propia de pista: manual antes que automático, español antes que
  inglés dentro de cada grupo (el _pick_track de upstream no respeta esto).
"""
from __future__ import annotations

import json
import logging
import math
import re
import signal
import sys
from urllib.parse import parse_qsl, urlparse

# Las advertencias de la librería pueden incluir URLs firmadas o valores de query: silencio total.
logging.disable(logging.CRITICAL)

USAGE = 'Uso: youtube_captions.py --video-id <ID de 11 caracteres>\n'
VIDEO_ID_RE = re.compile(r'^[\w-]{11}$')
LANGUAGE_RE = re.compile(r'^(?:es|en)(?:-|$)')
ALLOWED_HOSTS = frozenset({'www.youtube.com'})
ALLOWED_PATHS = frozenset({'/youtubei/v1/player', '/watch', '/api/timedtext'})
MAX_REQUESTS = 4
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_CUES = 12_000
MAX_TOTAL_CHARS = 240_000
CUE_ACCOUNT_CHARS = 16
TOTAL_TIMEOUT_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 8


class RestubeStop(BaseException):
    """Interrupción de presupuesto/destino: deriva de BaseException para que la
    librería no la trague con sus `except Exception` internos."""

    def __init__(self, token: str) -> None:
        super().__init__(token)
        self.token = token


# Mapeo fijo por nombre de clase, fijado a tubescrape 0.5.0 (dependencia pineada).
TOKEN_BY_EXCEPTION_NAME = {
    'RateLimitError': 'RESTUBE_RATE_LIMIT',
    'CaptchaError': 'RESTUBE_BLOCKED',
    'BotDetectedError': 'RESTUBE_BLOCKED',
    'AgeRestrictedError': 'RESTUBE_UNAVAILABLE',
    'VideoUnavailableError': 'RESTUBE_UNAVAILABLE',
    'TranscriptsDisabledError': 'RESTUBE_NO_CAPTIONS',
    'TranscriptsNotAvailableError': 'RESTUBE_NO_CAPTIONS',
    'TranscriptFetchError': 'RESTUBE_NO_CAPTIONS',
    'TranslationNotAvailableError': 'RESTUBE_NO_CAPTIONS',
    'ParsingError': 'RESTUBE_FETCH',
    'RequestError': 'RESTUBE_FETCH',
    'YouTubeError': 'RESTUBE_FETCH',
}


def token_for(error: BaseException) -> str:
    if isinstance(error, RestubeStop):
        return error.token
    return TOKEN_BY_EXCEPTION_NAME.get(type(error).__name__, 'RESTUBE_FETCH')


def check_destination(url: str, video_id: str) -> None:
    """Solo HTTPS www.youtube.com en los endpoints fijos; /watch y /api/timedtext
    exigen exactamente un v=<id> del mismo video; /api/timedtext sin tlang."""
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS:
        raise RestubeStop('RESTUBE_DESTINATION')
    if parsed.username or parsed.password or parsed.port or parsed.fragment:
        raise RestubeStop('RESTUBE_DESTINATION')
    if parsed.path not in ALLOWED_PATHS:
        raise RestubeStop('RESTUBE_DESTINATION')
    query = parse_qsl(parsed.query, keep_blank_values=True)
    if parsed.path in ('/watch', '/api/timedtext'):
        ids = [value for key, value in query if key == 'v']
        if len(ids) != 1 or ids[0] != video_id:
            raise RestubeStop('RESTUBE_DESTINATION')
    if parsed.path == '/api/timedtext' and any(key == 'tlang' for key, _ in query):
        raise RestubeStop('RESTUBE_DESTINATION')


def select_track(tracks: list[dict], video_id: str) -> tuple[str, dict]:
    """Prioridad del contrato de ResTube: manual antes que automático, español
    antes que inglés dentro de cada grupo. Sin traducción, sin variantes no
    aceptadas y sin respaldo en otros idiomas: falla cerrado. Devuelve
    (url, info) como espera _pick_track de upstream."""
    groups: dict[str, dict[str, dict]] = {'manual': {}, 'auto': {}}
    for track in tracks:
        language = track.get('languageCode')
        url = track.get('baseUrl')
        if not isinstance(language, str) or not LANGUAGE_RE.match(language):
            continue
        if not isinstance(url, str) or not url:
            raise RestubeStop('RESTUBE_DESTINATION')
        check_destination(url, video_id)
        groups['auto' if track.get('kind') == 'asr' else 'manual'][language] = url
    for group in ('manual', 'auto'):
        languages = sorted(groups[group], key=lambda code: (not code.startswith('es'), code))
        if languages:
            code = languages[0]
            return groups[group][code], {'url': groups[group][code], 'language_code': code,
                                         'language': code, 'is_generated': group == 'auto'}
    raise RestubeStop('RESTUBE_NO_CAPTIONS')


def build_cues(segments: list) -> list[dict]:
    """Convierte segmentos de la librería en cues acotadas; omite vacías y
    nunca recorta en silencio: exceder un tope es error."""
    cues: list[dict] = []
    total = 0
    for segment in segments:
        text = (getattr(segment, 'text', '') or '').strip()
        if not text:
            continue
        total += len(text) + CUE_ACCOUNT_CHARS
        if total > MAX_TOTAL_CHARS or len(cues) >= MAX_CUES:
            raise RestubeStop('RESTUBE_TRANSCRIPT_LIMIT')
        start = getattr(segment, 'start', None)
        if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
            raise RestubeStop('RESTUBE_FETCH')
        cues.append({'start': float(start), 'text': text})
    if not cues:
        raise RestubeStop('RESTUBE_NO_CAPTIONS')
    return cues


def make_request_hook(video_id: str, counter: dict):
    def on_request(request):
        check_destination(str(request.url), video_id)
        if counter['count'] >= MAX_REQUESTS:
            raise RestubeStop('RESTUBE_BUDGET')
        counter['count'] += 1
        try:
            del request.headers['cookie']  # sin cookies de visitante, navegador ni cuenta
        except KeyError:
            pass
    return on_request


def make_response_hook():
    def on_response(response):
        status = response.status_code
        # Bloqueos: un solo intento, jamás reintento ni siguiente llamada.
        if status == 429:
            raise RestubeStop('RESTUBE_RATE_LIMIT')
        if status == 401:
            raise RestubeStop('RESTUBE_AUTH')
        if status == 403:
            raise RestubeStop('RESTUBE_BLOCKED')
        if 300 <= status < 400:
            raise RestubeStop('RESTUBE_DESTINATION')
        if status >= 400:
            raise RestubeStop('RESTUBE_FETCH')
        # Conteo de bytes en stream antes de buffer: el cuerpo nunca se acumula sin tope.
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_bytes():
            total += len(chunk)
            if total > MAX_RESPONSE_BYTES:
                raise RestubeStop('RESTUBE_BUDGET')
            chunks.append(chunk)
        response._content = b''.join(chunks)  # ya leída y acotada: evita relectura.
    return on_response


def build_client(headers: dict, video_id: str, counter: dict, transport=None):
    """Cliente httpx acotado: sin proxies del entorno, sin redirecciones y con
    los hooks de destino/presupuesto/bytes. transport es solo para pruebas."""
    import httpx

    return httpx.Client(
        headers=headers, timeout=REQUEST_TIMEOUT_SECONDS,
        trust_env=False, follow_redirects=False, transport=transport,
        event_hooks={'request': [make_request_hook(video_id, counter)],
                     'response': [make_response_hook()]},
    )


def acquire(video_id: str, transport=None) -> tuple[str, list]:
    """Ejecuta un get_transcript acotado; devuelve (language_code, segmentos)."""
    from tubescrape import YouTube
    from tubescrape.transcript import YouTubeTranscript

    counter = {'count': 0}

    class StrictTracks(YouTubeTranscript):
        # En la instancia que realmente se usa: sin bucle de captcha ni rotación
        # de proxies; un reto de bot es un único pedido y un fallo saneado.
        CAPTCHA_MAX_RETRIES = 1

        def _pick_track(self, tracks, languages, translation_languages=None):
            return select_track(tracks, video_id)

    yt = YouTube(timeout=REQUEST_TIMEOUT_SECONDS, max_retries=0)
    yt._http._cookies = {}  # sin cookies de visitante de upstream
    base = yt._http._get_sync_client()
    headers = dict(base.headers)
    base.close()
    client = build_client(headers, video_id, counter, transport=transport)
    yt._http._sync_client = client
    yt._transcript = StrictTracks(yt._http)
    try:
        transcript = yt.get_transcript(video_id, languages=['es', 'en'], timestamps=True)
    except Exception as error:
        # RestubeStop (BaseException) no pasa por aquí: sale con su token intacto.
        raise RestubeStop(token_for(error)) from None
    finally:
        client.close()
    return transcript.language_code, transcript.segments


def emit(payload: dict) -> None:
    # Éxito por stdout, compacto y acotado: el consumidor TypeScript valida la forma exacta.
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def emit_error(payload: dict) -> None:
    # Fallo por stderr (runCommand conserva stderr en el rechazo; execFile no adjunta
    # stdout): token fijo compacto, nunca excepciones ni contenido.
    sys.stderr.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.stderr.flush()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv == ['--help']:
        sys.stdout.write(USAGE)
        return 0
    if len(argv) != 2 or argv[0] != '--video-id' or not VIDEO_ID_RE.fullmatch(argv[1]):
        emit_error({'error': 'RESTUBE_BAD_REQUEST'})
        return 2
    video_id = argv[1]

    def deadline(_signum: int, _frame: object) -> None:
        raise RestubeStop('RESTUBE_TIMEOUT')

    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(TOTAL_TIMEOUT_SECONDS)
    try:
        language, segments = acquire(video_id)
        emit({'language': language, 'cues': build_cues(segments)})
        return 0
    except BaseException as error:  # salida siempre saneada: solo el token fijo, por stderr
        emit_error({'error': token_for(error)})
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())
