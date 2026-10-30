// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installYtdlp } from './setup-ytdlp.mjs';

const roots = [];
const bytes = Buffer.from('isolated executable fixture, never executed');
const release = { version: 'fixture', url: 'https://github.com/yt-dlp/yt-dlp/releases/download/fixture/yt-dlp_linux', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
async function fixture() {
  const root = await mkdtemp(fileURLToPath(new URL('../.test-ytdlp-', import.meta.url)));
  roots.push(root);
  const fetcher = vi.fn(async () => new Response(bytes));
  return { root, fetcher, target: join(root, '.tools', 'yt-dlp'), install: (options = {}) => installYtdlp({ root, fetcher, release, platform: 'linux', arch: 'x64', ...options }) };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('project-local yt-dlp setup', () => {
  it('documents its command and rejects unknown options without installing', () => {
    const script = fileURLToPath(new URL('./setup-ytdlp.mjs', import.meta.url));
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 2000 });
    expect({ status: help.status, stdout: help.stdout, stderr: help.stderr }).toEqual({ status: 0, stdout: 'Uso: pnpm run setup:yt-dlp\nInstala yt-dlp 2026.10.26 en .tools/yt-dlp (Linux x64), verificando tamaño y SHA-256.\nNo modifica instalaciones globales ni sobrescribe archivos distintos.\n', stderr: '' });
    const unknown = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', timeout: 2000 });
    expect({ status: unknown.status, stdout: unknown.stdout, stderr: unknown.stderr }).toEqual({ status: 1, stdout: '', stderr: 'Argumento no admitido. Usa pnpm run setup:yt-dlp --help.\n' });
  });
  it('installs only checksum-verified bytes inside the project with executable permissions', async () => {
    const f = await fixture();
    expect(await f.install()).toBe(f.target);
    expect(await readFile(f.target)).toEqual(bytes);
    expect((await stat(f.target)).mode & 0o777).toBe(0o755);
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(release.url, expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }));
  });
  it('is idempotent without network when the pinned binary is already installed', async () => {
    const f = await fixture(); await f.install(); f.fetcher.mockClear();
    expect(await f.install()).toBe(f.target); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects corruption without creating an executable or accepting partial downloads', async () => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => new Response(Buffer.alloc(bytes.length, 1)));
    await expect(f.install()).rejects.toThrow(/SHA-256/);
    await expect(stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects oversized downloads before installation', async () => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => new Response(Buffer.alloc(bytes.length + 1)));
    await expect(f.install()).rejects.toThrow(/tamaño/);
    await expect(stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves an existing unexpected file rather than overwriting it', async () => {
    const f = await fixture(); await mkdir(join(f.root, '.tools')); await writeFile(f.target, 'human file');
    await expect(f.install()).rejects.toThrow(/existente/);
    expect(await readFile(f.target, 'utf8')).toBe('human file'); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects HTTP errors without installing or leaking remote bodies', async () => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => new Response('PRIVATE remote body', { status: 403 }));
    await expect(f.install()).rejects.toThrow('No se pudo descargar yt-dlp (HTTP 403).');
    await expect(stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a symlinked tools directory and unsupported platforms', async () => {
    const f = await fixture(); const other = join(f.root, 'other'); await mkdir(other); await symlink(other, join(f.root, '.tools'));
    await expect(f.install()).rejects.toThrow(/enlace simbólico/);
    await expect(f.install({ platform: 'win32' })).rejects.toThrow(/Linux x64/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
