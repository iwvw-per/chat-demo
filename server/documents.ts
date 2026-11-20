import { inflateRawSync, inflateSync } from 'node:zlib'
import { strFromU8, unzipSync, type Unzipped } from 'fflate'

const TEXT_LIMIT = 200_000
const PDF_MIN_LENGTH = 20

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'json5',
  'jsonld',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'xhtml',
  'ini',
  'conf',
  'cfg',
  'properties',
  'toml',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'ps1',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cxx',
  'cs',
  'java',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'css',
  'scss',
  'less',
  'php',
  'py',
  'rb',
  'go',
  'rs',
  'swift',
  'kt',
  'kts',
  'scala',
  'sql',
  'pl',
  'lua',
  'r',
  'dart',
  'vue',
  'svelte',
  'graphql',
  'gql',
  'tex',
  'rst',
  'env',
])

const MIME_EXTS: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/html': 'html',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/json': 'json',
  'application/ld+json': 'jsonld',
  'text/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/x-javascript': 'js',
  'text/x-python': 'py',
  'application/sql': 'sql',
  'application/graphql': 'graphql',
}

type DocumentKind = 'text' | 'docx' | 'pptx' | 'xlsx' | 'pdf'

const extFromName = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    switch (entity) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      default:
        return match
    }
  })

const stripTags = (value: string): string => decodeEntities(value.replace(/<[^>]*>/g, ''))

const decodeText = (data: Uint8Array): string => {
  const text = new TextDecoder('utf-8').decode(data)
  if (!text.includes('\uFFFD')) {
    return text
  }
  try {
    return new TextDecoder('gbk').decode(data)
  } catch {
    return text
  }
}

const looksLikeText = (data: Uint8Array): boolean => {
  const sample = data.subarray(0, 8192)
  if (sample.includes(0)) {
    return false
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sample)
  } catch {
    try {
      text = new TextDecoder('gbk').decode(sample)
    } catch {
      return false
    }
  }
  let control = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 && char !== '\t' && char !== '\n' && char !== '\r') {
      control++
    }
  }
  return control <= text.length / 20
}

const zipKind = (data: Uint8Array): DocumentKind | null => {
  let unzipped: Unzipped
  try {
    unzipped = unzipSync(data)
  } catch {
    return null
  }
  const paths = Object.keys(unzipped)
  if (paths.some((path) => path.startsWith('word/'))) {
    return 'docx'
  }
  if (paths.some((path) => path.startsWith('ppt/'))) {
    return 'pptx'
  }
  if (paths.some((path) => path.startsWith('xl/'))) {
    return 'xlsx'
  }
  return null
}

const sniffKind = (data: Uint8Array): DocumentKind | null => {
  if (data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return 'pdf'
  }
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
    const kind = zipKind(data)
    if (kind) {
      return kind
    }
  }
  return null
}

const resolveKind = (name: string, mimeType: string, data: Uint8Array): DocumentKind | null => {
  const ext = extFromName(name)
  if (ext === 'docx') {
    return 'docx'
  }
  if (ext === 'pptx') {
    return 'pptx'
  }
  if (ext === 'xlsx') {
    return 'xlsx'
  }
  if (ext === 'pdf') {
    return 'pdf'
  }
  const mime = mimeType.toLowerCase().split(';')[0].trim()
  if (mime === DOCX_MIME) {
    return 'docx'
  }
  if (mime === PPTX_MIME) {
    return 'pptx'
  }
  if (mime === XLSX_MIME) {
    return 'xlsx'
  }
  if (mime === 'application/pdf') {
    return 'pdf'
  }
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || mime in MIME_EXTS) {
    return 'text'
  }
  const sniffed = sniffKind(data)
  if (sniffed) {
    return sniffed
  }
  if (!ext && looksLikeText(data)) {
    return 'text'
  }
  return null
}

const extractDocx = (unzipped: Unzipped): string => {
  const entry = unzipped['word/document.xml']
  if (!entry) {
    return ''
  }
  const xml = strFromU8(entry)
  return stripTags(
    xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:p\b[^>]*\/>/g, '\n')
      .replace(/<w:(?:tab|ptab)\b[^>]*\/?>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
  )
}

const extractPptx = (unzipped: Unzipped): string => {
  const slides = Object.keys(unzipped)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => {
      const left = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0)
      const right = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0)
      return left - right
    })
  return slides
    .map((path) => {
      const xml = strFromU8(unzipped[path] as Uint8Array)
      const parts: string[] = []
      for (const match of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
        parts.push(decodeEntities(match[1] ?? ''))
      }
      return parts.join('')
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

const parseSharedStrings = (unzipped: Unzipped): string[] => {
  const entry = unzipped['xl/sharedStrings.xml']
  if (!entry) {
    return []
  }
  const xml = strFromU8(entry)
  const values: string[] = []
  for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const inner = match[1] ?? ''
    let text = ''
    for (const part of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
      text += decodeEntities(part[1] ?? '')
    }
    values.push(text)
  }
  return values
}

const extractSheet = (xml: string, shared: string[]): string => {
  const lines: string[] = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? ''
      const inner = cell[2] ?? ''
      const type = /t="([^"]*)"/.exec(attrs)?.[1]
      let value = ''
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
        value = Number.isFinite(index) ? (shared[index] ?? '') : ''
      } else if (type === 'inlineStr') {
        for (const part of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
          value += decodeEntities(part[1] ?? '')
        }
      } else {
        value = decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
      }
      cells.push(value.replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
    }
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

const extractXlsx = (unzipped: Unzipped): string => {
  const shared = parseSharedStrings(unzipped)
  const sheets = Object.keys(unzipped)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort((a, b) => {
      const left = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0)
      const right = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0)
      return left - right
    })
  return sheets
    .map((path) => extractSheet(strFromU8(unzipped[path] as Uint8Array), shared))
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

const decodePdfString = (token: string): string => {
  const body = token.slice(1, -1)
  let result = ''
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char !== '\\') {
      result += char
      continue
    }
    const next: string | undefined = body[++index]
    switch (next) {
      case 'n':
        result += '\n'
        break
      case 'r':
        result += '\r'
        break
      case 't':
        result += '\t'
        break
      case 'b':
        result += '\b'
        break
      case 'f':
        result += '\f'
        break
      case '(':
        result += '('
        break
      case ')':
        result += ')'
        break
      case '\\':
        result += '\\'
        break
      case undefined:
        break
      case '\n':
        break
      case '\r':
        if (body[index + 1] === '\n') {
          index++
        }
        break
      default:
        if (next >= '0' && next <= '7') {
          let octal = next
          while (octal.length < 3 && body[index + 1] >= '0' && body[index + 1] <= '7') {
            octal += body[++index]
          }
          result += String.fromCharCode(Number.parseInt(octal, 8))
        } else {
          result += next
        }
    }
  }
  return result
}

const decodePdfArray = (token: string): string => {
  const body = token.slice(1, -1)
  let result = ''
  for (const part of body.match(/\((?:\\.|[^\\()])*\)|[-+]?(?:\d+\.?\d*|\.\d+)/g) ?? []) {
    if (part.startsWith('(')) {
      result += decodePdfString(part)
      continue
    }
    if (Number(part) < -100) {
      result += ' '
    }
  }
  return result
}

const decodePdfContent = (content: string): string => {
  const tokens =
    content.match(/\((?:\\.|[^\\()])*\)|\[[^\]]*\]|[-+]?(?:\d+\.?\d*|\.\d+)|Tj|TJ|T\*|Td|TD|'|"|BT/g) ?? []
  const out: string[] = []
  let lastString = ''
  let lastArray = ''
  for (const token of tokens) {
    if (token.startsWith('(')) {
      lastString = token
      continue
    }
    if (token.startsWith('[')) {
      lastArray = token
      continue
    }
    if (token === 'Tj') {
      out.push(decodePdfString(lastString))
      lastString = ''
      continue
    }
    if (token === 'TJ') {
      out.push(decodePdfArray(lastArray))
      lastArray = ''
      continue
    }
    if (token === "'" || token === '"') {
      out.push(decodePdfString(lastString), '\n')
      lastString = ''
      continue
    }
    if (token === 'T*' || token === 'Td' || token === 'TD' || token === 'BT') {
      out.push('\n')
    }
  }
  return out.join('')
}

const extractPdf = (data: Uint8Array): string => {
  const raw = Buffer.from(data).toString('latin1')
  const blocks: string[] = []
  const streamPattern = /(?<![A-Za-z])stream\r?\n/g
  let match = streamPattern.exec(raw)
  while (match) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) {
      break
    }
    const chunk = Buffer.from(raw.slice(start, end), 'latin1')
    const input = new Uint8Array(chunk)
    let decoded: Buffer | null = null
    try {
      decoded = inflateSync(input)
    } catch {
      try {
        decoded = inflateRawSync(input)
      } catch {
        decoded = null
      }
    }
    const content = decoded ? decoded.toString('latin1') : chunk.toString('latin1')
    for (const text of content.matchAll(/BT([\s\S]*?)ET/g)) {
      blocks.push(decodePdfContent(text[1] ?? ''))
    }
    match = streamPattern.exec(raw)
  }
  return blocks
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

const truncate = (text: string): { text: string; truncated: boolean } =>
  text.length > TEXT_LIMIT
    ? { text: text.slice(0, TEXT_LIMIT), truncated: true }
    : { text, truncated: false }

export const extractDocumentText = async (
  name: string,
  mimeType: string,
  data: Buffer
): Promise<{ text: string; truncated: boolean } | null> => {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const kind = resolveKind(name, mimeType, bytes)
  if (!kind) {
    return null
  }
  if (kind === 'text') {
    return truncate(decodeText(bytes).replace(/^\uFEFF/, ''))
  }
  if (kind === 'pdf') {
    const text = extractPdf(bytes)
    return text.length < PDF_MIN_LENGTH ? { text: '', truncated: false } : truncate(text)
  }
  let unzipped: Unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch {
    return null
  }
  if (kind === 'docx') {
    return truncate(extractDocx(unzipped))
  }
  if (kind === 'pptx') {
    return truncate(extractPptx(unzipped))
  }
  return truncate(extractXlsx(unzipped))
}
