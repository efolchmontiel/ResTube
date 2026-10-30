// @vitest-environment node
/** Tests deterministas de scripts/setup-captions.mjs (sin red ni installs reales).
 *  Corre en los dos runners autorizados: `node --test` y la suite vitest del proyecto.
 *  Las afirmaciones usan node:assert en ambos; solo cambia el registro de casos.
 *  Los fixtures viven bajo .tools/ (excluido en git) y se limpian solos al terminar. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as nodeTest, after as nodeAfter, mock as nodeMock } from 'node:test';
import { installCaptions, PINS } from './setup-captions.mjs';

let vitest = null;
try { vitest = await import('vitest'); } catch { /* node --test: sin estado interno de vitest */ }

const run = vitest
  ? { group: (name, fn) => vitest.describe(name, fn), case: (name, fn) => vitest.it(name, fn), hook: (fn) => vitest.afterEach(fn), mock: vitest.vi }
  : { group: (name, fn) => fn(), case: (name, fn) => nodeTest(name, fn), hook: (fn) => nodeAfter(fn), mock: nodeMock };
// vitest entrega cada llamada como arreglo de argumentos; node:test como {arguments}.
const argsOf = (call) => (Array.isArray(call) ? call : call.arguments);

const roots = [];
function fixtureRoot() {
  const base = fileURLToPath(new URL('../.tools/', import.meta.url));
  const root = mkdtempSync(join(base, '.test-captions-'));
  roots.push(root);
  return root;
}
run.hook(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const okRun = async () => ({ status: 0, stdout: '0.5.0 0.28.1\n', stderr: '' });
async function installPinnedVenv(root) {
  const venv = join(root, '.tools', 'captions', 'python');
  mkdirSync(venv, { recursive: true });
  writeFileSync(join(venv, 'pyvenv.cfg'), 'version = 3.12.8\n');
}

run.group('project-local captions setup', () => {
  run.case('documents its command and rejects unknown options without touching anything', () => {
    const script = fileURLToPath(new URL('./setup-captions.mjs', import.meta.url));
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('pnpm run setup:captions'));
    assert.ok(help.stdout.includes('tubescrape 0.5.0'));
    assert.ok(help.stdout.includes('Python 3.12'));
    assert.match(help.stdout, /uv en PATH/);
    assert.doesNotMatch(help.stdout, /instalación global/i);
    const unknown = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', timeout: 5000 });
    assert.deepEqual({ status: unknown.status, stdout: unknown.stdout, stderr: unknown.stderr }, {
      status: 1, stdout: '', stderr: 'Argumento no admitido. Usa pnpm run setup:captions --help.\n',
    });
  });

  run.case('pins the probed venv versions in the requirements file', async () => {
    const requirements = await readFileSync(fileURLToPath(new URL('./captions-requirements.txt', import.meta.url)), 'utf8');
    assert.match(requirements, new RegExp(`^tubescrape==${PINS.tubescrape.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(requirements, /^httpx==0\.28\.1$/m);
    assert.match(requirements, /^httpcore==1\.0\.9$/m);
    assert.match(requirements, /^h11==0\.16\.0$/m);
    assert.match(requirements, /^anyio==4\.15\.1$/m);
    assert.match(requirements, /^certifi==\d+\.\d+\.\d+$/m);
    assert.match(requirements, /^idna==3\.20$/m);
    assert.match(requirements, /^typing-extensions==4\.16\.0$/m);
  });

  run.case('creates the pinned venv, installs pinned deps with project-local caches and validates versions', async () => {
    const root = fixtureRoot();
    await installPinnedVenv(root);
    const mockRun = run.mock.fn(okRun);
    const result = await installCaptions({ root, run: mockRun });
    assert.ok(result.venvPython.endsWith(join('.tools', 'captions', 'python', 'bin', 'python3')));
    const calls = mockRun.mock.calls.map(argsOf);
    assert.equal(calls[0][0], 'uv');
    assert.deepEqual(calls[0][1], ['--version']);
    assert.ok(calls[0][2].timeout > 0);
    assert.equal(calls.some(([, args]) => args[0] === 'venv'), false); // el venv ya existía
    const pip = calls.find(([, args]) => args[0] === 'pip');
    assert.equal(pip[0], 'uv');
    assert.ok(pip[1].includes('--python'));
    assert.ok(pip[1].includes(join(root, '.tools', 'captions', 'python', 'bin', 'python3')));
    assert.equal(pip[1].at(-1), join(root, 'scripts', 'captions-requirements.txt'));
    assert.deepEqual(
      { UV_CACHE_DIR: pip[2].env.UV_CACHE_DIR, UV_PYTHON_INSTALL_DIR: pip[2].env.UV_PYTHON_INSTALL_DIR },
      { UV_CACHE_DIR: join(root, '.tools', 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(root, '.tools', 'python-install') },
    );
    assert.ok(pip[2].timeout > 0);
    const validation = calls.at(-1);
    assert.equal(validation[0], join(root, '.tools', 'captions', 'python', 'bin', 'python3'));
    assert.equal(validation[1][0], '-c');
    assert.match(validation[1][1], /importlib\.metadata/);
    assert.ok(validation[1][1].includes('tubescrape') && validation[1][1].includes('httpx'));
  });

  run.case('creates a missing venv via staging and rename, then installs and validates', async () => {
    const root = fixtureRoot();
    const mockRun = run.mock.fn(async (file, args) => {
      if (args[0] === 'venv') { mkdirSync(join(args[3], 'bin'), { recursive: true }); writeFileSync(join(args[3], 'pyvenv.cfg'), 'version = 3.12.8\n'); }
      return okRun();
    });
    await installCaptions({ root, run: mockRun });
    const venvCall = mockRun.mock.calls.map(argsOf).find(([, args]) => args[0] === 'venv');
    assert.ok(venvCall, 'debe crear el venv');
    const [, args] = venvCall;
    assert.deepEqual(args.slice(0, 2), ['venv', '--python']);
    assert.equal(args[2], PINS.python);
    assert.match(args[3], /\.tools[\\/]\.captions-venv-[a-zA-Z0-9]+[\\/]python$/);
    assert.ok(!existsSync(args[3])); // el staging se eliminó tras el rename
    assert.ok(existsSync(join(root, '.tools', 'captions', 'python', 'pyvenv.cfg')));
    assert.equal(mockRun.mock.calls.map(argsOf).some(([, , options]) => options.env && 'HF_HOME' in options.env), false);
  });

  run.case('completes idempotently when the pinned venv already exists', async () => {
    const root = fixtureRoot();
    await installPinnedVenv(root);
    const mockRun = run.mock.fn(okRun);
    await assert.doesNotReject(installCaptions({ root, run: mockRun }));
    const nonVersionCalls = mockRun.mock.calls.map(argsOf).filter(([file, args]) => file !== 'uv' || args[0] !== '--version');
    assert.deepEqual(nonVersionCalls.map(([file, args]) => [file, args[0]]), [['uv', 'pip'], [join(root, '.tools', 'captions', 'python', 'bin', 'python3'), '-c']]);
    assert.equal(mockRun.mock.calls.map(argsOf).some(([, args]) => args[0] === 'venv'), false);
  });

  run.case('refuses a missing uv prerequisite without creating destinations', async () => {
    const root = fixtureRoot();
    const mockRun = run.mock.fn(async () => ({ status: 1, stdout: '', stderr: '' }));
    await assert.rejects(installCaptions({ root, run: mockRun }), /uv/);
    assert.equal(existsSync(join(root, '.tools', 'captions')), false);
  });

  run.case('refuses unexpected existing destinations instead of overwriting them', async () => {
    const root = fixtureRoot();
    const mockRun = run.mock.fn(okRun);
    mkdirSync(join(root, '.tools', 'captions'), { recursive: true });
    writeFileSync(join(root, '.tools', 'captions', 'python'), 'human file');
    await assert.rejects(installCaptions({ root, run: mockRun }), /existe/);
    assert.equal(readFileSync(join(root, '.tools', 'captions', 'python'), 'utf8'), 'human file');
    const wrong = fixtureRoot();
    await installPinnedVenv(wrong);
    writeFileSync(join(wrong, '.tools', 'captions', 'python', 'pyvenv.cfg'), 'version = 3.11.9\n');
    await assert.rejects(installCaptions({ root: wrong, run: mockRun }), /3\.12/);
    assert.equal(mockRun.mock.calls.map(argsOf).every(([file, args]) => file !== 'uv' || args[0] !== 'venv'), true);
  });

  run.case('never marks a failed creation, install or validation as success', async () => {
    const root = fixtureRoot();
    const failVenv = run.mock.fn(async (file, args) => ({ status: args[0] === 'venv' ? 1 : 0, stdout: 'uv 0.11.15\n', stderr: 'private uv error' }));
    await assert.rejects(installCaptions({ root, run: failVenv }), /entorno/);
    const root2 = fixtureRoot();
    await installPinnedVenv(root2);
    const failPip = run.mock.fn(async (file, args) => ({ status: args[0] === 'pip' ? 1 : 0, stdout: 'private pip error', stderr: '' }));
    await assert.rejects(installCaptions({ root: root2, run: failPip }), /dependencias/);
    const badValidation = run.mock.fn(async (file, args) => ({ status: 0, stdout: args[0] === '-c' ? '0.6.0 0.28.1\n' : 'uv 0.11.15\n', stderr: '' }));
    await assert.rejects(installCaptions({ root: root2, run: badValidation }), /versiones|validaci/);
    const crashValidation = run.mock.fn(async (file, args) => ({ status: args[0] === '-c' ? 1 : 0, stdout: '', stderr: '' }));
    await assert.rejects(installCaptions({ root: root2, run: crashValidation }), /versiones|validaci/);
  });

  run.case('refuses a symlinked .tools directory and unsupported platforms', async () => {
    const root = fixtureRoot();
    const other = join(root, 'other');
    mkdirSync(other);
    symlinkSync(other, join(root, '.tools'));
    const mockRun = run.mock.fn(okRun);
    await assert.rejects(installCaptions({ root, run: mockRun }), /enlace simbólico/);
    assert.equal(mockRun.mock.calls.length, 0);
    await assert.rejects(installCaptions({ root: fixtureRoot(), run: mockRun, platform: 'win32' }), /Linux x64/);
    assert.equal(mockRun.mock.calls.length, 0);
  });
});
