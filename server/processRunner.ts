import { execFile, type ExecFileException } from 'node:child_process';
import { kill, platform } from 'node:process';

export interface Command { file: string; args: string[]; input?: string; timeout: number; maxBuffer: number; cleanEnv?: boolean }
export type CommandRunner = (command: Command, signal: AbortSignal) => Promise<string>;

/** Sin shell; la promesa representa el cierre del proceso, no solo el pedido de terminarlo. */
export const runCommand: CommandRunner = (command, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const grouped = platform === 'linux';
  let child: ReturnType<typeof execFile> | undefined;
  let completion: { error: ExecFileException | null; stdout: string; stderr: string } | undefined;
  let stopError: ExecFileException | undefined;
  let closed = false;
  let terminationSent = false;
  let groupTerminationUnconfirmed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function terminate() {
    if (!child || terminationSent) return;
    terminationSent = true;
    try {
      if (grouped && child.pid !== undefined && child.pid > 0) {
        // El launcher y Pi comparten este grupo aislado: no se mata solo al padre.
        kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch (error) {
      // ESRCH confirma que el grupo ya no existe. Otro fallo no permite confirmar
      // la limpieza de descendientes, aunque llegue close del launcher: fail closed.
      if ((error as { code?: string } | null)?.code === 'ESRCH') return;
      if (grouped && child.pid !== undefined && child.pid > 0) groupTerminationUnconfirmed = true;
      if (!closed) {
        try { child.kill('SIGKILL'); } catch { /* El cierre sigue siendo obligatorio. */ }
      }
    }
  }

  function settleAfterClose() {
    if (!closed || !completion) return;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (groupTerminationUnconfirmed) return;
    const error = completion.error ?? stopError;
    if (error) {
      error.stderr = completion.stderr;
      reject(error);
    } else {
      resolve(completion.stdout);
    }
  }

  function abort() {
    stopError ??= Object.assign(new Error('Command aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    terminate();
  }

  // El timeout es propio para terminar todo el grupo, no el kill del launcher de execFile.
  // maxBuffer sigue a cargo de execFile; su callback de error también termina el grupo.
  try {
    child = execFile(command.file, command.args, {
      encoding: 'utf8', maxBuffer: command.maxBuffer, detached: grouped,
      windowsHide: true, killSignal: 'SIGKILL',
      ...(command.cleanEnv ? { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } } : {}),
    }, (error, stdout, stderr) => {
      completion = { error, stdout, stderr };
      if (error) terminate();
      settleAfterClose();
    });
  } catch (error) {
    // Spawn sincrónico fallido: no existe un hijo cuyo cierre haya que esperar.
    reject(error);
    return;
  }

  child.once('close', () => {
    closed = true;
    settleAfterClose();
  });
  signal.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => {
    stopError ??= Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGKILL' });
    terminate();
  }, command.timeout);

  // La señal pudo cambiar durante spawn, antes de registrar su listener.
  if (signal.aborted) abort();
  if (completion?.error) terminate();
  // EPIPE es posible si el proceso finaliza antes de consumir stdin.
  child.stdin?.on('error', () => {});
  try {
    child.stdin?.end(signal.aborted ? undefined : command.input);
  } catch (error) {
    stopError ??= error instanceof Error ? error : new Error('Could not write stdin');
    terminate();
  }
});
