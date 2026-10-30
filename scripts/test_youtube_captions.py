"""Tests deterministas del adaptador de subtítulos de YouTube (sin red real).

Run: python3 -m unittest discover -s scripts -p 'test_*.py'
Los tests de integración HTTP usan httpx.MockTransport y se ejecutan con el
intérprete del venv de captions; en el intérprete del sistema se marcan skip.
"""
import json
import pathlib
import subprocess
import sys
import unittest
from unittest import mock
from urllib.parse import urlencode

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import youtube_captions as adapter  # noqa: E402

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

try:
    import tubescrape  # noqa: F401
    HAS_TUBESCRAPPE = True
except ImportError:
    HAS_TUBESCRAPPE = False

ID = 'Q27iObu4lZc'
USAGE = adapter.USAGE


def timedtext_url(video_id=ID, **extra):
    params = {'v': video_id, 'lang': 'es', **extra}
    return f'https://www.youtube.com/api/timedtext?{urlencode(params)}'


def track(language, url, auto=False):
    entry = {'languageCode': language, 'baseUrl': url, 'name': {'simpleText': language}}
    if auto:
        entry['kind'] = 'asr'
    return entry


class CliTests(unittest.TestCase):
    """El CLI es determinista: --help exacto y argv inválido con token fijo."""

    def run_cli(self, *argv):
        return subprocess.run([sys.executable, str(pathlib.Path(adapter.__file__)), *argv],
                              capture_output=True, text=True, timeout=30)

    def test_help_exacto(self):
        result = self.run_cli('--help')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, USAGE)
        self.assertIn('--video-id', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_argv_invalido_token_por_stderr_y_salida_2(self):
        # El runner de Node (runCommand) conserva stderr en el rechazo, no stdout:
        # los tokens fijos van por stderr y stdout queda vacío.
        for argv in ([], ['--video-id'], ['--video-id', 'corto'], ['--video-id', 'Q27iObu4lZcX'],
                     ['--video-id', ID, 'extra'], ['--id', ID], [ID, '--video-id']):
            with self.subTest(argv=argv):
                result = self.run_cli(*argv)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stderr, '{"error":"RESTUBE_BAD_REQUEST"}\n')
                self.assertEqual(result.stdout, '')


class DestinationTests(unittest.TestCase):
    def test_endpoints_fijos_solo_https_www(self):
        adapter.check_destination(f'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', ID)
        adapter.check_destination(f'https://www.youtube.com/watch?{urlencode({"v": ID})}', ID)
        adapter.check_destination(timedtext_url(), ID)

    def test_rechaza_destinos_ajenos(self):
        bad = [
            'http://www.youtube.com/api/timedtext?v=' + ID,
            'https://attacker.example/api/timedtext?v=' + ID,
            'https://www.youtube.com:443/api/timedtext?v=' + ID,
            'https://user:pass@www.youtube.com/watch?v=' + ID,
            'https://www.youtube.com/api/timedtext?v=' + ID + '#frag',
            'https://www.youtube.com/youtubei/v1/next',
            'https://www.youtube.com/other',
        ]
        for url in bad:
            with self.subTest(url=url):
                with self.assertRaises(adapter.RestubeStop) as ctx:
                    adapter.check_destination(url, ID)
                self.assertEqual(ctx.exception.token, 'RESTUBE_DESTINATION')

    def test_timedtext_y_watch_exigen_el_mismo_video(self):
        for path in ('/api/timedtext', '/watch'):
            base = f'https://www.youtube.com{path}'
            with self.subTest(path=path):
                with self.assertRaises(adapter.RestubeStop):
                    adapter.check_destination(f'{base}?{urlencode({"v": "OTHERIDxxxxx"})}', ID)
                with self.assertRaises(adapter.RestubeStop):
                    adapter.check_destination(f'{base}?{urlencode({"v": ID, "v": "OTHERIDxxxxx"})}', ID)
                with self.assertRaises(adapter.RestubeStop):
                    adapter.check_destination(base, ID)
        with self.assertRaises(adapter.RestubeStop):
            adapter.check_destination(timedtext_url(tlang='en'), ID)


class SelectionTests(unittest.TestCase):
    """Manual antes que automático; español antes que inglés dentro de cada grupo."""

    def pick(self, tracks):
        url, info = adapter.select_track(tracks, ID)
        self.assertTrue(adapter.LANGUAGE_RE.match(info['language_code']))
        self.assertIsInstance(info['is_generated'], bool)
        return url, info['language_code']

    def test_manual_es_gana_siempre(self):
        url, language = self.pick([track('en', timedtext_url(lang='en')), track('es', timedtext_url(lang='es')),
                                   track('es', timedtext_url(lang='es', kind='asr'), auto=True)])
        self.assertEqual(language, 'es')
        self.assertIn('lang=es', url)

    def test_manual_antes_que_automatico(self):
        _, language = self.pick([track('en', timedtext_url(lang='en', kind='asr'), auto=True),
                                 track('en', timedtext_url(lang='en'))])
        self.assertEqual(language, 'en')

    def test_es_antes_que_en_dentro_de_automáticos(self):
        _, language = self.pick([track('en', timedtext_url(lang='en', kind='asr'), auto=True),
                                 track('es', timedtext_url(lang='es', kind='asr'), auto=True)])
        self.assertEqual(language, 'es')

    def test_variante_regional_aceptada(self):
        _, language = self.pick([track('es-419', timedtext_url(lang='es-419', kind='asr'), auto=True)])
        self.assertEqual(language, 'es-419')

    def test_otros_idiomas_no_son_respaldo(self):
        with self.assertRaises(adapter.RestubeStop) as ctx:
            self.pick([track('fr', timedtext_url(lang='fr')), track('pt', timedtext_url(lang='pt'), auto=True)])
        self.assertEqual(ctx.exception.token, 'RESTUBE_NO_CAPTIONS')

    def test_url_de_pista_fuera_de_contrato_falla_cerrado(self):
        for url in ['https://attacker.example/api/timedtext?v=' + ID, timedtext_url(tlang='en'),
                    'https://www.youtube.com/api/timedtext?v=OTHERIDxxxxx&lang=es', 'not a url']:
            with self.subTest(url=url):
                with self.assertRaises(adapter.RestubeStop):
                    self.pick([track('es', url)])


class CueTests(unittest.TestCase):
    class Segment:
        def __init__(self, start, text):
            self.start = start
            self.text = text

    def test_emite_cues_acotadas_y_omite_vacías(self):
        cues = adapter.build_cues([self.Segment(0, 'Hola mundo'), self.Segment(1.5, '  '), self.Segment(2, 'otra')])
        self.assertEqual(cues, [{'start': 0.0, 'text': 'Hola mundo'}, {'start': 2.0, 'text': 'otra'}])

    def test_topes_sin_recorte_silencioso(self):
        with self.assertRaises(adapter.RestubeStop) as ctx:
            adapter.build_cues([self.Segment(0, 'x' * adapter.MAX_TOTAL_CHARS)])
        self.assertEqual(ctx.exception.token, 'RESTUBE_TRANSCRIPT_LIMIT')
        with self.assertRaises(adapter.RestubeStop) as ctx:
            adapter.build_cues([self.Segment(i, 'x') for i in range(adapter.MAX_CUES + 1)])
        self.assertEqual(ctx.exception.token, 'RESTUBE_TRANSCRIPT_LIMIT')
        with self.assertRaises(adapter.RestubeStop):
            adapter.build_cues([])

    def test_start_invalido_es_error(self):
        for start in (None, -1, '0', float('nan'), True):
            with self.subTest(start=start):
                with self.assertRaises(adapter.RestubeStop):
                    adapter.build_cues([self.Segment(start, 'texto suficiente')])


class TokenTests(unittest.TestCase):
    def test_mapeo_fijo_por_excepcion(self):
        class RateLimitError(Exception): pass
        class CaptchaError(Exception): pass
        class BotDetectedError(Exception): pass
        class VideoUnavailableError(Exception): pass
        class TranscriptsDisabledError(Exception): pass
        class ParsingError(Exception): pass
        class RequestError(Exception): pass
        class TotallyUnknown(Exception): pass
        self.assertEqual(adapter.token_for(RateLimitError()), 'RESTUBE_RATE_LIMIT')
        self.assertEqual(adapter.token_for(CaptchaError()), 'RESTUBE_BLOCKED')
        self.assertEqual(adapter.token_for(BotDetectedError()), 'RESTUBE_BLOCKED')
        self.assertEqual(adapter.token_for(VideoUnavailableError()), 'RESTUBE_UNAVAILABLE')
        self.assertEqual(adapter.token_for(TranscriptsDisabledError()), 'RESTUBE_NO_CAPTIONS')
        self.assertEqual(adapter.token_for(ParsingError()), 'RESTUBE_FETCH')
        self.assertEqual(adapter.token_for(RequestError()), 'RESTUBE_FETCH')
        self.assertEqual(adapter.token_for(TotallyUnknown()), 'RESTUBE_FETCH')
        stop = adapter.RestubeStop('RESTUBE_TIMEOUT')
        self.assertEqual(adapter.token_for(stop), 'RESTUBE_TIMEOUT')


@unittest.skipUnless(HAS_HTTPX, 'requiere httpx (venv de captions)')
class HookTests(unittest.TestCase):
    """Comportamiento del cliente acotado con transporte simulado, sin red real."""

    def handler(self, routes, seen):
        def handle(request):
            seen.append(request)
            for matcher, response in routes:
                if matcher(request):
                    if callable(response):
                        return response(request)
                    return httpx.Response(response[0], content=response[1])
            return httpx.Response(500, content=b'no route')
        return handle

    def client_for(self, video_id, routes):
        seen = []
        transport = httpx.MockTransport(self.handler(routes, seen))
        counter = {'count': 0}
        client = adapter.build_client({'user-agent': 'test'}, video_id, counter, transport=transport)
        return client, seen, counter

    def test_bandera_aislada_del_cliente(self):
        captured = {}
        real = httpx.Client

        def spy(**kwargs):
            captured.update(kwargs)
            return real(**kwargs)

        with mock.patch('httpx.Client', spy):
            adapter.build_client({}, ID, {'count': 0})
        self.assertFalse(captured['trust_env'])
        self.assertFalse(captured['follow_redirects'])

    def test_sin_cookies_y_presupuesto_de_pedidos(self):
        client, seen, counter = self.client_for(ID, [(lambda request: True, (200, b'{}'))])
        request = client.build_request('POST', 'https://www.youtube.com/youtubei/v1/player',
                                       headers={'cookie': 'VISITOR=1'})
        client.send(request)
        self.assertNotIn('cookie', seen[0].headers)
        self.assertEqual(counter['count'], 1)
        for _ in range(adapter.MAX_REQUESTS - 1):
            client.send(client.build_request('GET', 'https://www.youtube.com/watch?v=' + ID))
        with self.assertRaises(adapter.RestubeStop) as ctx:
            client.send(client.build_request('GET', 'https://www.youtube.com/api/timedtext?v=' + ID))
        self.assertEqual(ctx.exception.token, 'RESTUBE_BUDGET')
        self.assertEqual(counter['count'], adapter.MAX_REQUESTS)
        client.close()

    def test_destinos_y_redirecciones_bloqueadas(self):
        client, _, _ = self.client_for(ID, [(lambda request: True, (200, b'{}'))])
        for method, url, token in [
            ('GET', 'http://www.youtube.com/api/timedtext?v=' + ID, 'RESTUBE_DESTINATION'),
            ('GET', 'https://evil.example/api/timedtext?v=' + ID, 'RESTUBE_DESTINATION'),
            ('GET', 'https://www.youtube.com/api/timedtext?v=OTHERIDxxxxx', 'RESTUBE_DESTINATION'),
            ('GET', 'https://www.youtube.com/api/timedtext?v=' + ID + '&tlang=en', 'RESTUBE_DESTINATION'),
        ]:
            with self.subTest(url=url):
                with self.assertRaises(adapter.RestubeStop) as ctx:
                    client.get(url)
                self.assertEqual(ctx.exception.token, token)
        # Redirección: nunca se sigue, ni siquiera hacia un destino válido.
        client2, seen2, _ = self.client_for(ID, [(lambda request: True, (302, b'', {'location': 'https://www.youtube.com/api/timedtext?v=' + ID}))])
        with self.assertRaises(adapter.RestubeStop) as ctx:
            client2.get('https://www.youtube.com/api/timedtext?v=' + ID)
        self.assertEqual(ctx.exception.token, 'RESTUBE_DESTINATION')
        self.assertEqual(len(seen2), 1)
        client.close(); client2.close()

    def test_estados_saneados_sin_reintento(self):
        client, seen, _ = self.client_for(ID, [(lambda request: True, (429, b'rate limited SECRET'))])
        with self.assertRaises(adapter.RestubeStop) as ctx:
            client.get('https://www.youtube.com/youtubei/v1/player')
        self.assertEqual(ctx.exception.token, 'RESTUBE_RATE_LIMIT')
        self.assertEqual(len(seen), 1)  # cero reintentos
        for status, token in ((401, 'RESTUBE_AUTH'), (403, 'RESTUBE_BLOCKED'), (500, 'RESTUBE_FETCH')):
            client2, seen2, _ = self.client_for(ID, [(lambda request: True, (status, b'SECRET'))])
            with self.subTest(status=status):
                with self.assertRaises(adapter.RestubeStop) as ctx:
                    client2.get('https://www.youtube.com/youtubei/v1/player')
                self.assertEqual(ctx.exception.token, token)
                self.assertEqual(len(seen2), 1)
            client2.close()
        client.close()

    def test_tope_de_bytes_con_conteo_en_stream(self):
        big = b'x' * (adapter.MAX_RESPONSE_BYTES + 1)
        client, seen, _ = self.client_for(ID, [(lambda request: True, (200, big))])
        with self.assertRaises(adapter.RestubeStop) as ctx:
            client.get('https://www.youtube.com/youtubei/v1/player')
        self.assertEqual(ctx.exception.token, 'RESTUBE_BUDGET')
        client.close()


@unittest.skipUnless(HAS_HTTPX and HAS_TUBESCRAPPE, 'requiere el venv de captions (tubescrape 0.5.0)')
class AcquisitionTests(unittest.TestCase):
    """Adquisición completa get_transcript con transporte simulado; nunca red real."""

    XML = ('<?xml version="1.0" encoding="utf-8"?>'
           '<transcript><text start="0" dur="2">palabra palabra palabra palabra</text>'
           '<text start="2" dur="2">otras palabras del video completo aquí</text></transcript>')

    def setUp(self):
        # La librería cachea la API key a nivel global de proceso: aislado por prueba.
        import tubescrape.transcript
        tubescrape.transcript._api_key_cache = None

    @staticmethod
    def player(tracks, playability=None):
        data = {'playabilityStatus': playability or {'status': 'OK'}}
        if tracks is not None:
            data['captions'] = {'playerCaptionsTracklistRenderer': {'captionTracks': tracks}}
        return data

    def run_acquire(self, routes):
        seen = []
        transport = httpx.MockTransport(self.simple_handler(routes, seen))
        language, segments = adapter.acquire(ID, transport=transport)
        return language, segments, seen

    def simple_handler(self, routes, seen):
        def handle(request):
            seen.append(request)
            for matcher, response in routes:
                if matcher(request):
                    return httpx.Response(response[0], content=response[1])
            raise AssertionError('ruta inesperada: ' + request.url.path)
        return handle

    def test_manual_es_dos_pedidos_sin_cookies(self):
        routes = [
            (lambda request: request.url.path == '/youtubei/v1/player',
             (200, json.dumps(self.player([track('en', timedtext_url(lang='en')), track('es', timedtext_url(lang='es')),
                                           track('es', timedtext_url(lang='es', kind='asr'), auto=True)])).encode())),
            (lambda request: request.url.path == '/api/timedtext', (200, self.XML)),
        ]
        language, segments, seen = self.run_acquire(routes)
        self.assertEqual(language, 'es')
        self.assertEqual(len(segments), 2)
        self.assertEqual(len(seen), 2)  # player + timedtext; sin watch ni reintentos
        self.assertEqual({request.method for request in seen}, {'POST', 'GET'})
        self.assertTrue(all('cookie' not in request.headers for request in seen))
        self.assertTrue(seen[0].url.path == '/youtubei/v1/player')

    def test_bloqueo_bot_en_un_solo_pedido(self):
        # Reto de bot real (playability LOGIN_REQUIRED): exactamente UN pedido, cero
        # reintentos (el CAPTCHA_MAX_RETRIES=1 debe regir la instancia que se usa).
        seen = []
        bot = json.dumps(self.player(None, {'status': 'LOGIN_REQUIRED', 'reason': "Sign in to confirm you're not a bot"})).encode()
        def handle(request):
            seen.append(request)
            return httpx.Response(200, content=bot)
        transport = httpx.MockTransport(handle)
        with self.assertRaises(adapter.RestubeStop) as ctx:
            adapter.acquire(ID, transport=transport)
        self.assertEqual(ctx.exception.token, 'RESTUBE_BLOCKED')
        self.assertEqual(len(seen), 1)

    def test_429_sin_reintentos(self):
        seen = []
        def handle(request):
            seen.append(request)
            return httpx.Response(429, content=b'SECRET')
        transport = httpx.MockTransport(handle)
        with self.assertRaises(adapter.RestubeStop) as ctx:
            adapter.acquire(ID, transport=transport)
        self.assertEqual(ctx.exception.token, 'RESTUBE_RATE_LIMIT')
        self.assertEqual(len(seen), 1)

    def test_cadena_de_refresco_de_api_key_queda_en_presupuesto(self):
        # En tubescrape 0.5.0 la reintentación con clave está rota: httpx reemplaza la query
        # cuando se pasan params, así que el player "con key" vuelve a salir sin clave. La
        # cadena real es player, watch, player, watch y el quinto pedido excede el tope:
        # falla cerrado en RESTUBE_BUDGET tras exactamente MAX_REQUESTS pedidos.
        seen = []
        def handle(request):
            seen.append(request)
            if request.url.path == '/watch':
                return httpx.Response(200, content=b'<html>{"INNERTUBE_API_KEY": "k"}</html>')
            return httpx.Response(200, content=json.dumps(self.player(None)).encode())
        transport = httpx.MockTransport(handle)
        with self.assertRaises(adapter.RestubeStop) as ctx:
            adapter.acquire(ID, transport=transport)
        self.assertEqual(ctx.exception.token, 'RESTUBE_BUDGET')
        self.assertEqual([request.url.path for request in seen],
                         ['/youtubei/v1/player', '/watch', '/youtubei/v1/player', '/watch'])
        self.assertTrue(all('key=' not in str(request.url) for request in seen))

    def test_tope_de_pedidos_en_cadena_completa(self):
        # Player sin captions y clave NO extraíble: player + watch y sin más pedidos:
        # upstream entrega su dato sin captions y el contrato responde sin subtítulos.
        seen = []
        def handle(request):
            seen.append(request)
            if request.url.path == '/watch':
                return httpx.Response(200, content=b'<html>sin clave</html>')
            return httpx.Response(200, content=json.dumps(self.player(None)).encode())
        transport = httpx.MockTransport(handle)
        with self.assertRaises(adapter.RestubeStop) as ctx:
            adapter.acquire(ID, transport=transport)
        self.assertEqual(ctx.exception.token, 'RESTUBE_NO_CAPTIONS')
        self.assertEqual([request.url.path for request in seen], ['/youtubei/v1/player', '/watch'])

    def test_transcripcion_vacia_es_error(self):
        routes = [
            (lambda request: request.url.path == '/youtubei/v1/player',
             (200, json.dumps(self.player([track('es', timedtext_url(lang='es'))])).encode())),
            (lambda request: request.url.path == '/api/timedtext',
             (200, '<?xml version="1.0"?><transcript></transcript>')),
        ]
        with self.assertRaises(adapter.RestubeStop) as ctx:
            self.run_acquire(routes)
        self.assertEqual(ctx.exception.token, 'RESTUBE_NO_CAPTIONS')


if __name__ == '__main__':
    unittest.main()
