import { mkdirSync, lstatSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Official sources, pinned together. Model revision is the HF content pin.
export const PINS = Object.freeze({
  python: '3.12',
  fasterWhisper: '1.2.1',
  hub: '2.4.0',
  modelRepo: 'Systran/faster-whisper-base',
  modelRevision: 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66',
});
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const MODEL_BOOTSTRAP = `
import pathlib, sys
from huggingface_hub import snapshot_download
repo, revision, dest = sys.argv[1], sys.argv[2], sys.argv[3]
snapshot_download(repo_id=repo, revision=revision, local_dir=dest,
                  allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"])
pathlib.Path(dest, "revision.txt").write_text(revision + "\\n")
`;

function optionalLstat(path) {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
}

/** Dependency injection is only for isolated tests; the CLI always uses uv from PATH. */
export async function installTranscription({ root = projectRoot, run = defaultRun, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux' || arch !== 'x64') throw new Error('Este instalador local admite Linux x64.');
  const tools = join(root, '.tools');
  const toolsStat = optionalLstat(tools);
  if (toolsStat?.isSymbolicLink()) throw new Error('.tools no puede ser un enlace simbólico.');
  await mkdirSync(tools, { recursive: true });

  // 1. uv es un prerequisito externo: no se instala ni se modifica globalmente.
  const uv = await run('uv', ['--version'], { timeout: 15_000 });
  if (uv.status !== 0) throw new Error('Se requiere uv en PATH (https://docs.astral.sh/uv/). No se modifica ninguna instalación global.');

  // 2. Entorno gestionado en staging + renombrado: una creación parcial nunca queda marcada.
  const venv = join(tools, 'python');
  const venvPython = join(venv, 'bin', 'python3');
  const venvStat = optionalLstat(venv);
  if (venvStat) {
    const cfg = venvStat.isDirectory() ? readCfgOrNull(join(venv, 'pyvenv.cfg')) : null;
    if (!cfg || !/^version(?:_info)?\s*=\s*3\.12\b/m.test(cfg)) throw new Error('.tools/python existe y no es un entorno de Python 3.12; no se sobrescribe.');
  } else {
    const staging = mkdtempSync(join(tools, '.venv-install-'));
    try {
      const created = await run('uv', ['venv', '--python', PINS.python, join(staging, 'python')],
        { env: uvEnv(root), timeout: 300_000 });
      if (created.status !== 0 || !optionalLstat(join(staging, 'python', 'pyvenv.cfg'))) {
        throw new Error('La creación del entorno de Python 3.12 no se completó.');
      }
      renameSync(join(staging, 'python'), venv);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  // 3. Dependencias fijadas del requirements oficial, con cache dentro del proyecto.
  const requirements = join(root, 'scripts', 'transcription-requirements.txt');
  const pip = await run('uv', ['pip', 'install', '--python', venvPython, '-r', requirements], { env: uvEnv(root), timeout: 600_000 });
  if (pip.status !== 0) throw new Error('La instalación de dependencias fijadas no se completó.');

  // 4. Pesos multilingües Base en revisión fijada; staging + rename, marcador al final.
  const modelDir = join(tools, 'models', 'faster-whisper-base');
  const marker = join(modelDir, 'revision.txt');
  const modelStat = optionalLstat(modelDir);
  if (modelStat) {
    const content = readCfgOrNull(marker);
    if (!content) throw new Error('.tools/models/faster-whisper-base existe sin marcador de revisión; no se sobrescribe ni se completa a medias.');
    if (content.trim() !== PINS.modelRevision) throw new Error('.tools/models/faster-whisper-base existe con otra revisión; no se sobrescribe.');
  } else {
    const staging = mkdtempSync(join(tools, '.model-install-'));
    try {
      const download = await run(venvPython, ['-c', MODEL_BOOTSTRAP, PINS.modelRepo, PINS.modelRevision, join(staging, 'model')],
        { env: hfEnv(root), timeout: 900_000 });
      const stagedModel = join(staging, 'model');
      if (download.status !== 0 || !optionalLstat(join(stagedModel, 'revision.txt'))) {
        throw new Error('La descarga del modelo en revisión fijada no se completó.');
      }
      await mkdirSync(join(tools, 'models'), { recursive: true });
      renameSync(stagedModel, modelDir);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  return { venv, venvPython, modelDir };
}

function readCfgOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
function uvEnv(root) {
  return { ...process.env, UV_CACHE_DIR: join(root, '.tools', 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(root, '.tools', 'python-install') };
}
function hfEnv(root) {
  return { ...process.env, HF_HOME: join(root, '.tools', 'hf-home') };
}
function defaultRun(file, args, options = {}) {
  const result = spawnSync(file, args, { ...options, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Uso: pnpm run setup:transcription\n'
      + 'Instala en .tools/ (Linux x64) el entorno de transcripción local: Python 3.12 gestionado, faster-whisper 1.2.1\n'
      + `y los pesos multilingües Base de ${PINS.modelRepo} en revisión fijada ${PINS.modelRevision}.\n`
      + 'Requisitos: uv en PATH (no se instala ni modifica globalmente) y conexión una sola vez para dependencias y pesos.\n'
      + 'Los pesos del modelo suman unos 145 MB más el entorno de ejecución: el total descargado NO es 145 MB.\n'
      + 'No modifica instalaciones globales de Python; rechaza destinos existentes distintos y nunca marca salida parcial como éxito.');
  } else if (process.argv.length > 2) {
    console.error('Argumento no admitido. Usa pnpm run setup:transcription --help.'); process.exitCode = 1;
  } else {
    try { const { modelDir } = await installTranscription(); console.log(`Transcripción local lista: pesos en ${modelDir}.`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
