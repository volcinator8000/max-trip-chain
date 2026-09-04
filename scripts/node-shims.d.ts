// Minimal ambient declarations for Node built-ins used by the build scripts.
// These substitute for @types/node which is not installed in this project.

type BufferEncoding = "utf-8" | "utf8" | "ascii" | "binary" | "base64" | "hex";

/**
 * The little of Node's stream surface the GTFS converter needs: it streams 200 MB
 * archives to disk and back out again rather than reading them into memory.
 */
interface NodeReadStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): NodeReadStream;
  on(event: "end", cb: () => void): NodeReadStream;
  on(event: "error", cb: (err: unknown) => void): NodeReadStream;
  destroy(): void;
}

interface NodeWriteStream {
  write(chunk: Uint8Array): boolean;
  once(event: "drain", cb: () => void): NodeWriteStream;
  on(event: "error", cb: (err: unknown) => void): NodeWriteStream;
  end(cb?: () => void): void;
}

declare module "fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(file: string, data: string, encoding: BufferEncoding): void;
  export function readFileSync(file: string, encoding: BufferEncoding): string;
  export function readdirSync(path: string): string[];
  export function unlinkSync(path: string): void;
  export function renameSync(from: string, to: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { size: number; mtimeMs: number };
  export function createReadStream(path: string, options?: { highWaterMark?: number }): NodeReadStream;
  export function createWriteStream(path: string): NodeWriteStream;
}

declare module "path" {
  export function resolve(...paths: string[]): string;
  export function dirname(p: string): string;
  export function join(...paths: string[]): string;
  export function basename(p: string, ext?: string): string;
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

declare const process: {
  cwd(): string;
  exit(code?: number): never;
  env: NodeJS.ProcessEnv;
  /** [execPath, scriptPath, ...args] — the converter takes network ids as args. */
  argv: string[];
};

/** Node's Buffer, used only to adapt fetch/stream chunks. */
declare const Buffer: {
  from(data: Uint8Array): Uint8Array;
};
