import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Versiones fijadas espejo del experimento aislado autorizado (.tools/tubescrape-probe-v050/venv).
export const PINS = Object.freeze({ python: '3.12', tubescrape: '0.5.0', httpx: '0.28.1' });
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const VERSION_CHECK = 'from importlib.metadata import version; print(version("tubescrape"), version("httpx"))';

function optionalLstat(path) {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
}

/** Dependency injection is only for isolated tests; the CLI always uses uv from PATH. */
export async function installCaptions({ root = projectRoot, run = defaultRun, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux' || arch !== 'x64') throw new Error('Este instalador local admite Linux x64.');
  const tools = join(root, '.tools');
  const toolsStat = optionalLstat(tools);
  if (toolsStat?.isSymbolicLink()) throw new Error('.tools no puede ser un enlace simbólico.');
  await mkdirSync(tools, { recursive: true });

  // 1. uv es un prerequisito externo: no se instala ni se modifica globalmente.
  const uv = await run('uv', ['--version'], { timeout: 15_000 });
  if (uv.status !== 0) throw new Error('Se requiere uv en PATH (https://docs.astral.sh/uv/). No se modifica ninguna instalación global.');

  // 2. Entorno gestionado en staging + renombrado: una creación parcial nunca queda marcada.
  const venv = join(tools, 'captions', 'python');
  const venvPython = join(venv, 'bin', 'python3');
  const venvStat = optionalLstat(venv);
  if (venvStat) {
    const cfg = venvStat.isDirectory() ? readCfgOrNull(join(venv, 'pyvenv.cfg')) : null;
    if (!cfg || !/^version(?:_info)?\s*=\s*3\.12\b/m.test(cfg)) throw new Error('.tools/captions/python existe y no es un entorno de Python 3.12; no se sobrescribe.');
  } else {
    const staging = mkdtempSync(join(tools, '.captions-venv-'));
    try {
      const created = await run('uv', ['venv', '--python', PINS.python, join(staging, 'python')],
        { env: uvEnv(root), timeout: 300_000 });
      if (created.status !== 0 || !optionalLstat(join(staging, 'python', 'pyvenv.cfg'))) {
        throw new Error('La creación del entorno de Python 3.12 no se completó.');
      }
      await mkdirSync(join(tools, 'captions'), { recursive: true });
      renameSync(join(staging, 'python'), venv);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  // 3. Dependencias fijadas del requirements oficial, con cache dentro del proyecto.
  const requirements = join(root, 'scripts', 'captions-requirements.txt');
  const pip = await run('uv', ['pip', 'install', '--python', venvPython, '-r', requirements], { env: uvEnv(root), timeout: 600_000 });
  if (pip.status !== 0) throw new Error('La instalación de dependencias fijadas no se completó.');

  // 4. Validación posterior con el intérprete real: las versiones fijadas deben responder.
  const check = await run(venvPython, ['-c', VERSION_CHECK], { timeout: 60_000 });
  if (check.status !== 0 || check.stdout.trim() !== `${PINS.tubescrape} ${PINS.httpx}`) {
    throw new Error('La validación del entorno de captions no confirma las versiones fijadas.');
  }
  return { venv, venvPython };
}

function readCfgOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
function uvEnv(root) {
  return { ...process.env, UV_CACHE_DIR: join(root, '.tools', 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(root, '.tools', 'python-install') };
}
function defaultRun(file, args, options = {}) {
  const result = spawnSync(file, args, { ...options, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Uso: pnpm run setup:captions\n'
      + 'Instala en .tools/captions/python (Linux x64) el entorno de subtítulos de YouTube: Python 3.12 gestionado,\n'
      + `tubescrape ${PINS.tubescrape} y httpx ${PINS.httpx} con todas las dependencias en versiones fijadas.\n`
      + 'Requisitos: uv en PATH (no se instala ni modifica globalmente) y conexión una sola vez para las dependencias.\n'
      + 'Todo el cache y el runtime quedan dentro de .tools/ del proyecto; no hay pesos de modelos ni Whisper.\n'
      + 'Rechaza destinos existentes distintos y nunca marca una salida parcial como éxito.');
  } else if (process.argv.length > 2) {
    console.error('Argumento no admitido. Usa pnpm run setup:captions --help.'); process.exitCode = 1;
  } else {
    try { const { venv } = await installCaptions(); console.log(`Entorno de captions listo: ${venv}.`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
