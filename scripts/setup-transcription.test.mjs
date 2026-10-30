// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTranscription, PINS } from './setup-transcription.mjs';

const roots = [];
async function fixtureRoot() {
  const root = await mkdtemp(fileURLToPath(new URL('../.test-transcription-', import.meta.url)));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const okRun = vi.fn(async () => ({ status: 0, stdout: 'uv 0.11.15\n', stderr: '' }));

async function installPinnedModel(root) {
  const modelDir = join(root, '.tools', 'models', 'faster-whisper-base');
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'revision.txt'), `${PINS.modelRevision}\n`);
}
async function installPinnedVenv(root) {
  const venv = join(root, '.tools', 'python');
  await mkdir(venv, { recursive: true });
  await writeFile(join(venv, 'pyvenv.cfg'), 'version = 3.12.8\n');
}

describe('project-local transcription setup', () => {
  it('documents its command and rejects unknown options without touching anything', () => {
    const script = fileURLToPath(new URL('./setup-transcription.mjs', import.meta.url));
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('pnpm run setup:transcription');
    expect(help.stdout).toContain('faster-whisper 1.2.1');
    expect(help.stdout).toContain(PINS.modelRevision);
    expect(help.stdout).not.toMatch(/total de 145/i);
    const unknown = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', timeout: 5000 });
    expect({ status: unknown.status, stdout: unknown.stdout, stderr: unknown.stderr }).toEqual({
      status: 1, stdout: '', stderr: 'Argumento no admitido. Usa pnpm run setup:transcription --help.\n',
    });
  });

  it('pins the documented versions in the requirements file, including the PyAV compatibility pin', async () => {
    const requirements = await readFile(fileURLToPath(new URL('./transcription-requirements.txt', import.meta.url)), 'utf8');
    expect(requirements).toContain(`faster-whisper==${PINS.fasterWhisper}`);
    expect(requirements).toContain(`huggingface-hub==${PINS.hub}`);
    // faster-whisper 1.2.1 llama av.open(..., metadata_errors='ignore'), keyword eliminado en av 19.
    expect(requirements).toMatch(/^av==15\.1\.0$/m);
    expect(requirements).not.toMatch(/^torch\b|\bcuda\b/i);
  });

  it('creates the venv, installs pinned deps and downloads the pinned model revision with project-local caches', async () => {
    const root = await fixtureRoot();
    await installPinnedVenv(root);
    const run = vi.fn(okRun);
    // With a mocked download nothing is written: the fail-closed marker check must refuse.
    await expect(installTranscription({ root, run })).rejects.toThrow(/no se completó/);
    const calls = run.mock.calls;
    expect(calls[0]).toEqual(['uv', ['--version'], expect.objectContaining({ timeout: expect.any(Number) })]);
    expect(calls.some(([, args]) => args[0] === 'venv')).toBe(false);
    const pip = calls.find(([, args]) => args[0] === 'pip');
    expect(pip?.[0]).toBe('uv');
    expect(pip?.[1]).toContain('--python');
    expect(pip?.[1]).toContain(join(root, '.tools', 'python', 'bin', 'python3'));
    expect(pip?.[1]).toContain('-r');
    expect(pip?.[1].at(-1)).toBe(join(root, 'scripts', 'transcription-requirements.txt'));
    expect(pip?.[2].env).toMatchObject({ UV_CACHE_DIR: join(root, '.tools', 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(root, '.tools', 'python-install') });
    expect(pip?.[2].timeout).toBeGreaterThan(0);
    const model = calls.find(([file]) => file.endsWith(join('.tools', 'python', 'bin', 'python3')));
    expect(model?.[1][0]).toBe('-c');
    expect(model?.[1][2]).toBe(PINS.modelRepo);
    expect(model?.[1][3]).toBe(PINS.modelRevision);
    expect(model?.[1][4]).toMatch(/\.tools[\\/].model-install-[a-zA-Z0-9]+[\\/]model$/);
    expect(model?.[1][4]).not.toBe(join(root, '.tools', 'models', 'faster-whisper-base'));
    expect(model?.[2].env).toMatchObject({ HF_HOME: join(root, '.tools', 'hf-home') });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('completes idempotently when the pinned venv and model revision already exist', async () => {
    const root = await fixtureRoot();
    await installPinnedVenv(root);
    await installPinnedModel(root);
    const run = vi.fn(okRun);
    await expect(installTranscription({ root, run })).resolves.toBeTruthy();
    const downloads = (run.mock.calls ).filter(([file, args]) => file !== 'uv' || args[0] !== '--version');
    expect(downloads.map(([file, args]) => [file, args[0]])).toEqual([['uv', 'pip']]);
    expect((run.mock.calls ).some(([, args]) => args.includes('venv'))).toBe(false);
    expect((run.mock.calls ).some(([, , options]) => options.env && 'HF_HOME' in options.env)).toBe(false);
  });

  it('accepts uv version_info on repeated setup without recreating the project environment', async () => {
    const root = await fixtureRoot();
    await installPinnedVenv(root); await installPinnedModel(root);
    await writeFile(join(root, '.tools', 'python', 'pyvenv.cfg'), 'implementation = CPython\nuv = 0.11.15\nversion_info = 3.12.13\ninclude-system-site-packages = false\n');
    const run = vi.fn(okRun);
    await expect(installTranscription({ root, run })).resolves.toBeTruthy();
    expect(run.mock.calls.some(([, args]) => args[0] === 'venv')).toBe(false);
  });

  it('refuses a missing uv prerequisite without creating destinations', async () => {
    const root = await fixtureRoot();
    const run = vi.fn(async () => ({ status: 1, stdout: '', stderr: '' }));
    await expect(installTranscription({ root, run })).rejects.toThrow(/uv/);
    await expect(mkdir(join(root, '.tools', 'python')).catch((error) => error.code)).resolves.toBeUndefined();
  });

  it('refuses unexpected existing destinations instead of overwriting them', async () => {
    const root = await fixtureRoot();
    const run = vi.fn(okRun);
    await mkdir(join(root, '.tools'), { recursive: true });
    await writeFile(join(root, '.tools', 'python'), 'human file');
    await expect(installTranscription({ root, run })).rejects.toThrow(/existe/);
    expect(await readFile(join(root, '.tools', 'python'), 'utf8')).toBe('human file');
    const wrongVenv = await fixtureRoot();
    await installPinnedVenv(wrongVenv);
    await writeFile(join(wrongVenv, '.tools', 'python', 'pyvenv.cfg'), 'version = 3.11.9\n');
    await expect(installTranscription({ root: wrongVenv, run })).rejects.toThrow(/3\.12/);
    const wrongModel = await fixtureRoot();
    await installPinnedVenv(wrongModel);
    const modelDir = join(wrongModel, '.tools', 'models', 'faster-whisper-base');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'revision.txt'), 'deadbeef\n');
    await expect(installTranscription({ root: wrongModel, run })).rejects.toThrow(/revisión/);
    expect(await readFile(join(modelDir, 'revision.txt'), 'utf8')).toBe('deadbeef\n');
    const unmarkedModel = await fixtureRoot();
    await installPinnedVenv(unmarkedModel);
    await mkdir(join(unmarkedModel, '.tools', 'models', 'faster-whisper-base'), { recursive: true });
    await expect(installTranscription({ root: unmarkedModel, run })).rejects.toThrow(/marcador/);
    expect(run.mock.calls.every(([file, args]) => file !== 'uv' || args[0] !== 'venv')).toBe(true);
  });

  it('never marks a failed venv creation or model download as success', async () => {
    const root = await fixtureRoot();
    const run = vi.fn(async (file, args) => ({ status: args[0] === 'venv' ? 1 : 0, stdout: 'uv 0.11.15\n', stderr: 'private uv error' }));
    await expect(installTranscription({ root, run })).rejects.toThrow(/entorno/);
    const root2 = await fixtureRoot();
    await installPinnedVenv(root2);
    const failModel = vi.fn(async (file, args) => ({ status: args[0] === '-c' ? 1 : 0, stdout: 'uv 0.11.15\n', stderr: '' }));
    await expect(installTranscription({ root: root2, run: failModel })).rejects.toThrow(/modelo|descarga/);
  });

  it('refuses a symlinked .tools directory and unsupported platforms', async () => {
    const root = await fixtureRoot();
    const other = join(root, 'other'); await mkdir(other);
    await symlink(other, join(root, '.tools'));
    const run = vi.fn(okRun);
    await expect(installTranscription({ root, run })).rejects.toThrow(/enlace simbólico/);
    expect(run).not.toHaveBeenCalled();
    await expect(installTranscription({ root: await fixtureRoot(), run, platform: 'win32' })).rejects.toThrow(/Linux x64/);
    expect(run).not.toHaveBeenCalled();
  });
});
