declare module 'node:sqlite' {
  type SQLInputValue = null | number | bigint | string | Uint8Array
  type SQLOutputValue = null | number | bigint | string | Uint8Array

  export class StatementSync {
    run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[]
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}