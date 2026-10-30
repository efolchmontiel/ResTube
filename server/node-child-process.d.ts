/**
 * Declaraciones mínimas para los bridges locales: execFile, AbortSignal y stdin.
 * El repo no incluye @types/node y
 * no se agregan dependencias solo por esto: la superficie usada es mínima y
 * está acotada a este archivo de tipos (incluye el grupo POSIX del runner).
 */
declare module 'node:path' {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
}

declare module 'node:fs/promises' {
  export interface FileHandle {
    write(buffer: Uint8Array): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    close(): Promise<void>;
  }
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  export function readdir(path: string): Promise<string[]>;
  export function readFile(path: string): Promise<Uint8Array>;
  export interface Stats { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; size: number }
  export function stat(path: string): Promise<Stats>;
  export function lstat(path: string): Promise<Stats>;
  export function writeFile(path: string, data: string | Uint8Array, options?: { flag?: string; mode?: number }): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function link(existingPath: string, newPath: string): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:http' {
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
    address(): { port: number } | null;
    on(event: string, callback: (...args: never[]) => void): void;
  }
  export interface IncomingMessageLike { statusCode?: number; on(event: string, callback: (...args: never[]) => void): void }
  export interface ClientRequest {
    write(chunk: Uint8Array): unknown;
    end(): void;
    destroy(): void;
    on(event: 'response', callback: (res: IncomingMessageLike) => void): void;
    on(event: string, callback: (...args: never[]) => void): void;
  }
  export function createServer(handler: (req: unknown, res: unknown) => void): Server;
  export function request(options: Record<string, unknown>, callback?: (res: IncomingMessageLike) => void): ClientRequest;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}

declare module 'node:process' {
  export const platform: string;
  export function kill(pid: number, signal: string): boolean;
}

declare module 'node:child_process' {
  export interface ExecFileOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    encoding?: string;
    timeout?: number;
    maxBuffer?: number;
    windowsHide?: boolean;
    signal?: AbortSignal;
    killSignal?: string;
    detached?: boolean;
  }

  export interface ExecFileException extends Error {
    code?: string | number;
    killed?: boolean;
    signal?: string;
    cmd?: string;
    stderr?: string;
  }

  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ): {
    pid?: number;
    stdin: { end(input?: string): void; on(event: 'error', callback: () => void): void } | null;
    kill(signal?: string): boolean;
    once(event: 'close', callback: () => void): unknown;
  };

  export interface SpawnSyncOptions { encoding?: string; timeout?: number }
  export interface SpawnSyncResult { status: number | null; stdout: string; stderr: string; error?: Error }
  export function spawnSync(file: string, args: readonly string[], options?: SpawnSyncOptions): SpawnSyncResult;
}
