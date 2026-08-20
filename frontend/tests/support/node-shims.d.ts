// @types/node is not one of this project's five approved frontend
// packages, so plain `.ts` files importing `node:fs`/`node:path`/`node:url`
// have no ambient types even though the vitest runtime (Node) resolves
// them fine. A `declare module` inside an ordinary `.ts` file that already
// has top-level imports is treated as module *augmentation* -- it must
// live in a global-script `.d.ts` file to declare a brand new module.
// Only what the source-scan test in theme.test.ts calls is declared here.

declare module 'node:fs' {
  export function readFileSync(filePath: string, encoding: string): string
  export function existsSync(filePath: string): boolean
  export function mkdirSync(dirPath: string, options?: { recursive?: boolean }): string | undefined
  export function mkdtempSync(prefix: string): string
  export function realpathSync(filePath: string): string
  export function writeFileSync(filePath: string, data: string, encoding: string): void
}

declare module 'node:path' {
  export function dirname(filePath: string): string
  export function join(...segments: string[]): string
  export function resolve(...segments: string[]): string
  export function basename(filePath: string): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

// Only the slice of a Node stream/child-process this project's Playwright
// fixture (tests/visual/picker-ingest.spec.ts) actually touches: reading
// stdout/stderr line by line and waiting for exit -- not the real Node
// types, which this project deliberately does not add as a dependency.
interface ShimStreamChunk {
  toString(encoding?: string): string
}

interface ShimReadableStream {
  on(event: 'data', listener: (chunk: ShimStreamChunk) => void): void
}

interface ShimChildProcess {
  stdout: ShimReadableStream | null
  stderr: ShimReadableStream | null
  on(event: 'exit', listener: (code: number | null) => void): void
  kill(): void
}

declare module 'node:child_process' {
  export type ChildProcess = ShimChildProcess
  export function spawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ): ShimChildProcess
}

declare module 'node:process' {
  const shimProcess: { env: Record<string, string | undefined> }
  export default shimProcess
}
