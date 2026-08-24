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
  export function readdirSync(dirPath: string): string[]
  export function statSync(filePath: string): { isDirectory(): boolean }
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

// node:child_process is deliberately NOT shimmed here: apache-arrow's own
// type declarations carry a `/// <reference types="node" />` (its
// builder.d.ts), so @types/node is unavoidably part of this program's type
// graph the moment anything imports apache-arrow -- and a hand-rolled
// `declare module 'node:child_process'` collides with the real one once
// both exist (a type alias and a class exported under the same name do
// not merge cleanly). The real, richer @types/node types now cover this
// module's `spawn`/`ChildProcess` for tests/visual/picker-ingest.spec.ts.

declare module 'node:process' {
  const shimProcess: { env: Record<string, string | undefined> }
  export default shimProcess
}
