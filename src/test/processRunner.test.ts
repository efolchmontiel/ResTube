import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand, type Command } from '../../server/processRunner';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), kill: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, default: { execFile: mocks.execFile } }));
vi.mock('node:process', () => ({ platform: 'linux', kill: mocks.kill, default: { platform: 'linux', kill: mocks.kill } }));

type ProcessError = Error & { code?: string; killed?: boolean; stderr?: string };
type Completion = (error: ProcessError | null, stdout: string, stderr: string) => void;
class FakeChild {
  pid: number | undefined = 12345;
  private closeListener: (() => void) | undefined;
  private pipeError: (() => void) | undefined;
  kill = vi.fn(() => true);
  stdin = {
    end: vi.fn<(input?: string) => void>(),
    on: vi.fn((_event: 'error', listener: () => void) => { this.pipeError = listener; }),
  };
  once(_event: 'close', listener: () => void) { this.closeListener = listener; return this; }
  close() { this.closeListener?.(); }
  emitPipeError() { this.pipeError?.(); }
}
const command: Command = { file: 'harmless-fake-launcher', args: ['fixed-arg'], input: 'data on stdin', timeout: 100, maxBuffer: 2048 };
function fakeProcess() {
  const child = new FakeChild();
  let complete!: Completion;
  mocks.execFile.mockImplementation((_file, _args, _options, callback: Completion) => {
    complete = callback;
    return child;
  });
  return { child, complete: (error: ProcessError | null, stdout = '', stderr = '') => complete(error, stdout, stderr) };
}
function observe(promise: Promise<string>) {
  let settled = false;
  const outcome = promise.then(
    (stdout) => { settled = true; return { stdout }; },
    (error: unknown) => { settled = true; return { error }; },
  );
  return { outcome, isSettled: () => settled };
}
beforeEach(() => { vi.useFakeTimers(); mocks.execFile.mockReset(); mocks.kill.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('runCommand: cierre confirmado antes de liberar el trabajo', () => {
  it.each(['abort', 'timeout'] as const)('%s termina el grupo Linux, pero no resuelve antes de close', async (cause) => {
    const fake = fakeProcess();
    const controller = new AbortController();
    const observed = observe(runCommand(command, controller.signal));
    if (cause === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(command.timeout);
    expect(mocks.kill).toHaveBeenCalledWith(-fake.child.pid!, 'SIGKILL');

    // Node puede invocar el callback de error antes del evento close.
    const failure = Object.assign(new Error(cause), { code: cause === 'abort' ? 'ABORT_ERR' : 'ETIMEDOUT', killed: true });
    fake.complete(failure, 'partial stdout', 'private stderr');
    await Promise.resolve();
    const settledBeforeClose = observed.isSettled();
    const terminationBeforeClose = mocks.kill.mock.calls.slice();
    fake.child.close();
    const result = await observed.outcome;

    expect(settledBeforeClose).toBe(false);
    expect(terminationBeforeClose).toContainEqual([-fake.child.pid!, 'SIGKILL']);
    expect(fake.child.kill).not.toHaveBeenCalled(); // No se mata solo al launcher.
    expect(result).toMatchObject({ error: expect.objectContaining({ stderr: 'private stderr' }) });
    expect(mocks.execFile.mock.calls[0][2]).toMatchObject({ detached: true, maxBuffer: command.maxBuffer });
  });

  it('conserva stdout, stdin y entorno limpio, esperando close incluso después del callback exitoso', async () => {
    const fake = fakeProcess();
    const observed = observe(runCommand({ ...command, cleanEnv: true }, new AbortController().signal));
    fake.complete(null, 'actual stdout', 'ignored warning');
    await Promise.resolve();
    const settledBeforeClose = observed.isSettled();
    fake.child.close();
    expect(await observed.outcome).toEqual({ stdout: 'actual stdout' });
    expect(settledBeforeClose).toBe(false);
    expect(fake.child.stdin.end).toHaveBeenCalledWith(command.input);
    expect(mocks.execFile).toHaveBeenCalledWith(command.file, command.args, expect.objectContaining({ encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }), expect.any(Function));
  });

  it.each(['PROCESS_FAILED', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT'])('conserva %s y stderr solo después del cierre', async (code) => {
    const fake = fakeProcess();
    if (code === 'ENOENT') fake.child.pid = undefined;
    const observed = observe(runCommand(command, new AbortController().signal));
    const failure = Object.assign(new Error('raw failure for caller classification'), { code });
    fake.complete(failure, 'partial', 'raw stderr');
    await Promise.resolve();
    const settledBeforeClose = observed.isSettled();
    fake.child.close();
    expect(await observed.outcome).toEqual({ error: failure });
    expect(failure).toHaveProperty('stderr', 'raw stderr');
    expect(settledBeforeClose).toBe(false);
    if (code !== 'ENOENT') expect(mocks.kill).toHaveBeenCalledWith(-fake.child.pid!, 'SIGKILL');
  });

  it('no crea un proceso si la señal ya estaba abortada', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runCommand(command, controller.signal)).rejects.toBeDefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('propaga fallo sincrónico de spawn sin esperar un close inexistente', async () => {
    const failure = new Error('spawn failed synchronously');
    mocks.execFile.mockImplementation(() => { throw failure; });
    await expect(runCommand(command, new AbortController().signal)).rejects.toBe(failure);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it('abortar durante spawn termina el grupo sin enviar datos ni liberar antes de close', async () => {
    const fake = fakeProcess();
    const spawn = mocks.execFile.getMockImplementation()!;
    const controller = new AbortController();
    mocks.execFile.mockImplementation((...args) => {
      const child = spawn(...args);
      controller.abort();
      return child;
    });
    const observed = observe(runCommand(command, controller.signal));
    expect(mocks.kill).toHaveBeenCalledWith(-fake.child.pid!, 'SIGKILL');
    expect(fake.child.stdin.end).toHaveBeenCalledWith(undefined);
    fake.complete(null, 'late success');
    await Promise.resolve();
    expect(observed.isSettled()).toBe(false);
    fake.child.close();
    expect(await observed.outcome).toMatchObject({ error: expect.objectContaining({ name: 'AbortError' }) });
  });

  it('close anterior al callback espera también su stdout y limpia timeout y abort', async () => {
    const fake = fakeProcess();
    const controller = new AbortController();
    const observed = observe(runCommand(command, controller.signal));
    fake.child.close();
    await Promise.resolve();
    expect(observed.isSettled()).toBe(false);
    fake.complete(null, 'stdout after close');
    expect(await observed.outcome).toEqual({ stdout: 'stdout after close' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(command.timeout * 2);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(fake.child.kill).not.toHaveBeenCalled();
  });

  it('un fallo sincrónico de stdin también espera close', async () => {
    const fake = fakeProcess();
    const failure = Object.assign(new Error('broken stdin'), { code: 'EPIPE' });
    fake.child.stdin.end.mockImplementation(() => { throw failure; });
    const observed = observe(runCommand(command, new AbortController().signal));
    fake.complete(null, 'partial stdout');
    await Promise.resolve();
    const settledBeforeClose = observed.isSettled();
    fake.child.close();
    expect(await observed.outcome).toEqual({ error: failure });
    expect(settledBeforeClose).toBe(false);
    expect(mocks.kill).toHaveBeenCalledWith(-fake.child.pid!, 'SIGKILL');
  });

  it('no libera si falla la terminación del grupo, aunque cierre el launcher', async () => {
    const fake = fakeProcess();
    mocks.kill.mockImplementation(() => { throw Object.assign(new Error('group termination denied'), { code: 'EPERM' }); });
    const controller = new AbortController();
    const observed = observe(runCommand(command, controller.signal));
    controller.abort();
    fake.complete(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    fake.child.close();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(command.timeout * 2);
    expect(observed.isSettled()).toBe(false);
    expect(mocks.kill).toHaveBeenCalledTimes(1); // Terminación acotada, sin bucle de reintentos.
  });

  it('tolera EPIPE y una carrera ESRCH sin ocultar el resultado final', async () => {
    const fake = fakeProcess();
    mocks.kill.mockImplementation(() => { throw Object.assign(new Error('already exited'), { code: 'ESRCH' }); });
    const controller = new AbortController();
    const observed = observe(runCommand(command, controller.signal));
    expect(() => fake.child.emitPipeError()).not.toThrow();
    expect(() => controller.abort()).not.toThrow();
    fake.complete(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    fake.child.close();
    expect(await observed.outcome).toHaveProperty('error');
  });
});
