import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Official GitHub release asset and SHA-256, pinned together. No "latest" at install time.
export const RELEASE = Object.freeze({
  version: '2026.10.26',
  url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux',
  size: 41166968,
  sha256: '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
});
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Dependency injection is only for isolated tests; the CLI always uses the pinned release. */
export async function installYtdlp({ root = projectRoot, fetcher = fetch, release = RELEASE, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux' || arch !== 'x64') throw new Error('Este instalador local admite Linux x64. No se usará yt-dlp del sistema.');
  const directory = join(root, '.tools');
  const target = join(directory, 'yt-dlp');
  const directoryStat = await optionalStat(directory);
  if (directoryStat?.isSymbolicLink()) throw new Error('.tools no puede ser un enlace simbólico.');
  const existing = await optionalStat(target);
  if (existing) {
    if (!existing.isFile() || existing.size !== release.size || digest(await readFile(target)) !== release.sha256) {
      throw new Error('El archivo local existente no coincide con la versión fijada; no se sobrescribió.');
    }
    await chmod(target, 0o755);
    return target;
  }
  const response = await fetcher(release.url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) throw new Error(`No se pudo descargar yt-dlp (HTTP ${response.status}).`);
  if (response.url) {
    const final = new URL(response.url);
    if (final.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com'].includes(final.hostname)) {
      await response.body.cancel();
      throw new Error('La descarga no terminó en un servidor oficial permitido.');
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > release.size) throw new Error('La descarga supera el tamaño fijado.');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (size !== release.size || digest(bytes) !== release.sha256) throw new Error('La descarga no coincide con el tamaño/SHA-256 fijado.');

  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, '.install-'));
  try {
    const staged = join(temporary, 'yt-dlp');
    await writeFile(staged, bytes, { flag: 'wx', mode: 0o755 });
    // Atomic, but unlike rename this never replaces an existing user file.
    await link(staged, target);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return target;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Uso: pnpm run setup:yt-dlp\nInstala yt-dlp 2026.10.26 en .tools/yt-dlp (Linux x64), verificando tamaño y SHA-256.\nNo modifica instalaciones globales ni sobrescribe archivos distintos.');
  } else if (process.argv.length > 2) {
    console.error('Argumento no admitido. Usa pnpm run setup:yt-dlp --help.'); process.exitCode = 1;
  } else {
    try { await installYtdlp(); console.log(`yt-dlp ${RELEASE.version} listo en .tools/yt-dlp.`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
