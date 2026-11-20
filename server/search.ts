import { config } from './config.js'

const ENDPOINT = 'https://api.anysearch.com/mcp'

export type WebSearchItem = {
  title: string
  url: string
  snippet: string
  pageAge: string | null
}

export type WebFetchPage = {
  title: string | null
  url: string
  text: string
}

const apiKey = () => config.searchApiKey

type JsonRpcResult = {
  result?: { content?: unknown }
  error?: { message?: string }
}

type TextPart = { type?: unknown; text?: unknown }

const readTextPart = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ''
  }
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as TextPart).type === 'text' &&
      typeof (part as TextPart).text === 'string'
    ) {
      return (part as TextPart).text as string
    }
  }
  return ''
}

/** 调用 AnySearch 的 JSON-RPC 工具;未配置 key 时按匿名额度调用。 */
const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const key = apiKey()
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`搜索服务返回 ${response.status}`)
  }
  const payload = (await response.json()) as JsonRpcResult
  if (payload.error) {
    throw new Error(payload.error.message ?? '搜索服务返回错误')
  }
  return readTextPart(payload.result?.content)
}

/** 解析 "### 序号. 标题 / - **URL**: ... / - 摘要 date: ..." 形式的搜索结果 */
const parseSearchMarkdown = (text: string): WebSearchItem[] => {
  const items: WebSearchItem[] = []
  const blocks = text.split(/^###\s+/m).slice(1)
  for (const block of blocks) {
    const lines = block.split('\n')
    const title = (lines[0] ?? '').replace(/^\d+\.\s*/, '').trim()
    let url = ''
    const snippets: string[] = []
    for (const line of lines.slice(1)) {
      const trimmed = line.trim()
      const urlMatch = /^-\s*\*\*URL\*\*:\s*(\S+)/.exec(trimmed)
      if (urlMatch) {
        url = urlMatch[1]
        continue
      }
      if (trimmed.startsWith('- ')) {
        snippets.push(trimmed.slice(2).trim())
      }
    }
    if (!title || !url) {
      continue
    }
    const joined = snippets.join(' ').trim()
    const ageMatch = /\sdate:\s*([^,]+)$/.exec(joined)
    const pageAge = ageMatch ? ageMatch[1].trim() : null
    const snippet = ageMatch ? joined.slice(0, ageMatch.index).trim() : joined
    items.push({ title, url, snippet, pageAge })
  }
  return items
}

export const searchWeb = async (query: string, maxResults = 6): Promise<WebSearchItem[]> => {
  const text = await callTool('search', {
    query,
    max_results: Math.min(Math.max(maxResults, 1), 10),
  })
  return parseSearchMarkdown(text)
}

const MAX_PAGE_CHARS = 60_000

export const fetchPage = async (url: string): Promise<WebFetchPage | null> => {
  const text = await callTool('extract', { url })
  if (!text) {
    return null
  }
  let title: string | null = null
  let content = text
  try {
    const parsed = JSON.parse(text) as { title?: unknown; content?: unknown; url?: unknown }
    if (typeof parsed.title === 'string') {
      title = parsed.title
    }
    if (typeof parsed.content === 'string') {
      content = parsed.content
    }
  } catch {
    // 非 JSON 时直接使用返回的 Markdown 正文
  }
  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }
  return {
    title,
    url,
    text: trimmed.length > MAX_PAGE_CHARS ? trimmed.slice(0, MAX_PAGE_CHARS) : trimmed,
  }
}
