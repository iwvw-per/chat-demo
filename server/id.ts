import { randomBytes } from 'node:crypto'

export const createId = (): string => randomBytes(16).toString('hex')