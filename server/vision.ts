import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { config } from './config.js'
import { fetchPage, searchWeb, type WebFetchPage, type WebSearchItem } from './search.js'
import type { ProviderConfig } from './db.js'
import { HttpError } from './http.js'

type Value = Record<string, unknown>

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[]
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

type InlineImageBlock = Value & {
  source: { type: 'base64'; media_type: string; data: string }
}

const isRecord = (value: unknown): value is Value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 客户端声明的服务端工具映射为 OpenAI function 工具,交给上游决定何时调用 */
const OPENAI_TOOLS: Record<string, Value> = {
  deepseek_web_search: {
    type: 'function',
    function: {
      name: 'deepseek_web_search',
      description: '联网搜索网页并返回标题、链接与摘要,用于获取实时信息',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词' } },
        required: ['query'],
      },
    },
  },
  deepseek_read_url: {
    type: 'function',
    function: {
      name: 'deepseek_read_url',
      description: '读取指定网页的正文内容',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '网页地址' } },
        required: ['url'],
      },
    },
  },
}

const MAX_TOOL_ROUNDS = 4
const MAX_TOOL_CALLS = 4

const declaredTools = (body: Value): string[] => {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.type === 'string' && tool.type in OPENAI_TOOLS ? [tool.type] : []
  )
  return [...new Set(names)]
}

/** 模型原生 DSML 工具调用标记,上游偶尔漏解析会把它混进响应正文 */
const DSML_START_RE = /<(\/)?[|｜]+DSML/
const DSML_MARKER_PREFIX_RE = /^<(\/)?([|｜]*(D(S(M(L)?)?)?)?[|｜]*)?$/

const blocksOf = (value: unknown): Value[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

const ATTRIBUTE_RE = /name\s*=\s*"([^"]+)"/

/** 把 DSML 调用块解析成与 OpenAI tool_calls 同形的 name/args */
const parseDsmlCalls = (raw: string): { name: string; args: string }[] => {
  const calls: { name: string; args: Record<string, string> }[] = []
  const tagRe = /<(\/)?[|｜]+DSML[|｜]+\s*([A-Za-z_]*)([^>]*)>/g
  let current: { name: string; args: Record<string, string> } | null = null
  let param: string | null = null
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(raw)) !== null) {
    const inner = raw.slice(cursor, match.index)
    if (param && current) {
      current.args[param] = inner.trim()
    }
    cursor = match.index + match[0].length
    const closing = match[1] === '/'
    const tag = match[2]
    if (tag === 'invoke') {
      if (closing) {
        current = null
        param = null
      } else {
        const name = ATTRIBUTE_RE.exec(match[3] ?? '')
        current = { name: name ? name[1] : '', args: {} }
        calls.push(current)
      }
    } else if (tag === 'parameter') {
      if (closing) {
        param = null
      } else {
        const name = ATTRIBUTE_RE.exec(match[3] ?? '')
        param = name ? name[1] : null
      }
    }
  }
  return calls.map((call) => ({ name: call.name, args: JSON.stringify(call.args) }))
}

const isInlineImage = (block: Value): block is InlineImageBlock =>
  block.type === 'image' &&
  isRecord(block.source) &&
  block.source.type === 'base64' &&
  typeof block.source.media_type === 'string' &&
  typeof block.source.data === 'string'

export const hasInlineImages = (body: unknown): boolean =>
  isRecord(body) &&
  blocksOf(body.messages).some((message) => blocksOf(message.content).some(isInlineImage))

const toOpenAIMessages = (
  body: Value
): { messages: OpenAIMessage[]; lastUserText: string; images: number } => {
  const messages: OpenAIMessage[] = []
  let lastUserText = ''
  let images = 0
  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system })
  }
  for (const message of blocksOf(body.messages)) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        lastUserText = message.content
        messages.push({ role: 'user', content: message.content })
        continue
      }
      const parts: OpenAIContentPart[] = []
      for (const block of blocksOf(message.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          lastUserText = block.text
          parts.push({ type: 'text', text: block.text })
        } else if (isInlineImage(block)) {
          images += 1
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${String(block.source.media_type)};base64,${String(block.source.data)}`,
            },
          })
        }
      }
      if (parts.length > 0) {
        messages.push({ role: 'user', content: parts })
      }
      continue
    }
    if (message.role === 'assistant') {
      const text = blocksOf(message.content)
        .flatMap((block) =>
          block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        )
        .join('')
      if (text) {
        messages.push({ role: 'assistant', content: text })
      }
    }
  }
  return { messages, lastUserText, images }
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string'
          ? [part.text]
          : []
      )
      .join('')
  }
  return ''
}

const pipeError = async (res: Response, response: globalThis.Response) => {
  const text = await response.text().catch(() => '')
  const contentType = response.headers.get('Content-Type')
  if (contentType) {
    res.setHeader('Content-Type', contentType)
  }
  res.status(response.status).send(text || response.statusText)
}

const sendEvent = (res: Response, event: string, data: unknown) => {
  if (!res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

export const handleChatMessage = async (
  res: Response,
  body: Value,
  provider: ProviderConfig
): Promise<void> => {
  const { messages, lastUserText, images } = toOpenAIMessages(body)
  if (messages.length === 0) {
    throw new HttpError(400, '没有可发送的消息', 'invalid_chat_request')
  }
  const model =
    (images > 0 ? config.visionModel : '') ||
    (typeof body.model === 'string' ? body.model : provider.model)
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })

  const thinking = isRecord(body.thinking) && body.thinking.type === 'enabled'
  const tools = declaredTools(body)
  const upstreamTools = tools.map((name) => OPENAI_TOOLS[name])
  const basePayload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: 4096,
    ...(upstreamTools.length > 0 ? { tools: upstreamTools } : {}),
  }
  if (images === 0 && thinking) {
    basePayload.reasoning_effort = 'high'
  }

  const answerId = `msg_${randomUUID()}`
  const rounds = messages
  let started = false
  let thinkingOpen = false
  let textOpen = false
  let thinkingIndex = -1
  let textIndex = -1
  let nextIndex = 0
  let answer = ''
  let roundText = ''
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: 'end_turn' | 'max_tokens' = 'end_turn'

  const start = () => {
    if (started) {
      return
    }
    started = true
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    sendEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: answerId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    })
  }

  const openThinking = () => {
    if (thinkingOpen) {
      return
    }
    start()
    thinkingOpen = true
    thinkingIndex = nextIndex
    nextIndex += 1
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: thinkingIndex,
      content_block: { type: 'thinking', thinking: '' },
    })
  }

  const closeThinking = () => {
    if (!thinkingOpen) {
      return
    }
    thinkingOpen = false
    sendEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: thinkingIndex,
    })
  }

  const openText = () => {
    if (textOpen) {
      return
    }
    start()
    textOpen = true
    textIndex = nextIndex
    nextIndex += 1
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' },
    })
  }

  const closeText = () => {
    if (!textOpen) {
      return
    }
    textOpen = false
    sendEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: textIndex,
    })
  }

  /** 服务端工具结果按 Anthropic 事件补齐,前端据此渲染搜索时间线与来源卡片 */
  const emitServerToolUse = (
    id: string,
    name: 'deepseek_web_search' | 'deepseek_read_url',
    kind: 'search' | 'read_link',
    input: Value
  ) => {
    start()
    const index = nextIndex
    nextIndex += 1
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'server_tool_use',
        id,
        name,
        input,
        caller: { type: 'direct' },
        kind,
      },
    })
    sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  }

  const emitSearchResult = (toolUseId: string, results: WebSearchItem[]) => {
    const index = nextIndex
    nextIndex += 1
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        kind: 'search',
        content:
          results.length > 0
            ? results.map((item) => ({
                type: 'web_search_result',
                title: item.title,
                url: item.url,
                snippet: item.snippet,
                site_name: null,
                site_icon: null,
                page_age: item.pageAge,
              }))
            : [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
      },
    })
    sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  }

  const emitFetchResult = (toolUseId: string, page: WebFetchPage | null) => {
    const index = nextIndex
    nextIndex += 1
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_fetch_tool_result',
        tool_use_id: toolUseId,
        kind: 'read_link',
        content: page
          ? {
              type: 'web_fetch_result',
              url: page.url,
              content: {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: page.text },
                title: page.title,
              },
              published_at: null,
            }
          : { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
      },
    })
    sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  }

  const pendingCalls = new Map<number, { id: string; name: string; args: string }>()
  let pendingText = ''
  let dsmlCallIndex = 0

  const emitText = (text: string) => {
    if (!text) {
      return
    }
    openText()
    answer += text
    roundText += text
    sendEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: textIndex,
      delta: { type: 'text_delta', text },
    })
  }

  const addDsmlCalls = (raw: string) => {
    for (const call of parseDsmlCalls(raw)) {
      pendingCalls.set(1000 + dsmlCallIndex, {
        id: `call_dsml_${dsmlCallIndex}`,
        name: call.name,
        args: call.args,
      })
      dsmlCallIndex += 1
    }
  }

  /** 返回已消费的字符数;返回 -1 表示 DSML 块还没收完,继续等待后续增量 */
  const consumeDsml = (final: boolean): number => {
    const raw = pendingText
    const tagRe = /<(\/)?[|｜]+DSML[|｜]+\s*([A-Za-z_]*)([^>]*)>/g
    let sawCalls = false
    let depth = 0
    let match: RegExpExecArray | null
    while ((match = tagRe.exec(raw)) !== null) {
      const end = match.index + match[0].length
      const closing = match[1] === '/'
      const tag = match[2]
      if (tag === 'calls') {
        if (closing) {
          depth -= 1
          if (depth <= 0) {
            addDsmlCalls(raw.slice(0, end))
            return end
          }
        } else {
          depth += 1
          sawCalls = true
        }
        continue
      }
      if (!sawCalls && tag === 'invoke' && closing && !/^\s*<(\/)?[|｜]+DSML/.test(raw.slice(end))) {
        addDsmlCalls(raw.slice(0, end))
        return end
      }
    }
    return final ? raw.length : -1
  }

  /** 逐步放出正文,把 DSML 块挡在输出之外(不完整时先缓存,避免标记漏出) */
  const flushText = (final: boolean) => {
    for (;;) {
      const start = pendingText.search(DSML_START_RE)
      if (start >= 0) {
        emitText(pendingText.slice(0, start))
        pendingText = pendingText.slice(start)
        const consumed = consumeDsml(final)
        if (consumed < 0) {
          return
        }
        pendingText = pendingText.slice(consumed)
        continue
      }
      if (final) {
        emitText(pendingText)
        pendingText = ''
        return
      }
      const lt = pendingText.lastIndexOf('<')
      if (lt >= 0 && DSML_MARKER_PREFIX_RE.test(pendingText.slice(lt))) {
        emitText(pendingText.slice(0, lt))
        pendingText = pendingText.slice(lt)
        return
      }
      emitText(pendingText)
      pendingText = ''
      return
    }
  }

  const processPayload = (payload: Value) => {
    if (isRecord(payload.usage)) {
      inputTokens = Number(payload.usage.prompt_tokens) || inputTokens
      outputTokens = Number(payload.usage.completion_tokens) || outputTokens
    }
    const choice = blocksOf(payload.choices)[0]
    if (!choice) {
      return
    }
    const delta = isRecord(choice.delta) ? choice.delta : {}
    const reasoning = textOf(delta.reasoning_content) || textOf(delta.reasoning)
    if (reasoning && thinking) {
      if (textOpen) {
        closeText()
      }
      openThinking()
      sendEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      })
    }
    const content = textOf(delta.content)
    if (content) {
      closeThinking()
      pendingText += content
      flushText(false)
    }
    for (const call of blocksOf(delta.tool_calls)) {
      const index = Number(call.index) || 0
      const current = pendingCalls.get(index) ?? { id: '', name: '', args: '' }
      if (typeof call.id === 'string') {
        current.id = call.id
      }
      const fn = isRecord(call.function) ? call.function : {}
      if (typeof fn.name === 'string') {
        current.name = fn.name
      }
      if (typeof fn.arguments === 'string') {
        current.args += fn.arguments
      }
      pendingCalls.set(index, current)
    }
    if (choice.finish_reason === 'length') {
      stopReason = 'max_tokens'
    }
  }

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) {
      return
    }
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') {
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(payload)) {
      return
    }
    if (isRecord(payload.error)) {
      throw new HttpError(
        502,
        String(payload.error.message ?? '模型接口返回错误'),
        'vision_upstream_error'
      )
    }
    processPayload(payload)
  }

  /** 单轮请求:转发文本/思考增量,并把工具调用累积到 pendingCalls */
  const runRound = async (payload: Value) => {
    pendingCalls.clear()
    roundText = ''
    pendingText = ''
    let upstream: globalThis.Response
    try {
      upstream = await fetch(
        `${provider.baseUrl.replace(/\/+$/, '')}${config.apiPaths.chatCompletions}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      )
    } catch (error) {
      if (controller.signal.aborted) {
        return false
      }
      throw new HttpError(
        502,
        `无法连接模型接口: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!upstream.ok) {
      await pipeError(res, upstream)
      return false
    }
    if (!upstream.body) {
      throw new HttpError(502, '模型接口没有返回流')
    }
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          handleLine(line)
          index = buffer.indexOf('\n')
        }
      }
      if (buffer.trim()) {
        handleLine(buffer.trim())
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return false
      }
      if (!started) {
        throw new HttpError(
          502,
          error instanceof Error ? error.message : '模型接口流读取失败'
        )
      }
      sendEvent(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: error instanceof Error ? error.message : '读取失败' },
      })
      res.end()
      return false
    }
    flushText(true)
    return true
  }

  const runToolCall = async (
    call: { id: string; name: string; args: string },
    round: number
  ): Promise<string> => {
    let parsed: Value = {}
    try {
      parsed = isRecord(JSON.parse(call.args || '{}')) ? (JSON.parse(call.args || '{}') as Value) : {}
    } catch {
      parsed = {}
    }
    if (call.name === 'deepseek_web_search') {
      const query =
        typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : lastUserText
      const toolUseId = `srvtoolu_s_${round}_${randomUUID().replace(/-/g, '')}`
      emitServerToolUse(toolUseId, 'deepseek_web_search', 'search', {
        action: 'search',
        query,
        queries: [query],
      })
      try {
        const results = await searchWeb(query, 6)
        emitSearchResult(toolUseId, results)
        return JSON.stringify({
          results: results.map((item) => ({
            title: item.title,
            url: item.url,
            snippet: item.snippet,
          })),
        })
      } catch (error) {
        emitSearchResult(toolUseId, [])
        return `搜索失败: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
    const toolUseId = `srvtoolu_rl_${round}_${randomUUID().replace(/-/g, '')}`
    if (!url) {
      return '读取失败:缺少 url'
    }
    emitServerToolUse(toolUseId, 'deepseek_read_url', 'read_link', {
      action: 'read_link',
      url,
    })
    try {
      const page = await fetchPage(url)
      emitFetchResult(toolUseId, page)
      return page ? page.text : '网页内容不可访问'
    } catch (error) {
      emitFetchResult(toolUseId, null)
      return `读取失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const isLastRound = round === MAX_TOOL_ROUNDS - 1
    const continued = await runRound({
      ...basePayload,
      messages: rounds,
      ...(isLastRound && upstreamTools.length > 0 ? { tools: undefined } : {}),
    })
    if (!continued) {
      return
    }
    const calls = [...pendingCalls.values()].filter(
      (call) => call.name && tools.includes(call.name)
    )
    if (calls.length === 0) {
      break
    }
    closeThinking()
    closeText()
    const results: { id: string; content: string }[] = []
    for (const call of calls.slice(0, MAX_TOOL_CALLS)) {
      results.push({ id: call.id, content: await runToolCall(call, round) })
    }
    rounds.push({
      role: 'assistant',
      content: roundText,
      tool_calls: calls.slice(0, MAX_TOOL_CALLS).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.args || '{}' },
      })),
    })
    for (const result of results) {
      rounds.push({ role: 'tool', tool_call_id: result.id, content: result.content })
    }
  }

  /** 剥离 DSML 后可能只剩工具调用;补一轮不带工具的请求,确保有正文收尾 */
  if (!answer) {
    const finalRound = await runRound({ ...basePayload, messages: rounds, tools: undefined })
    if (!finalRound) {
      return
    }
  }

  if (!started || (!answer && !thinkingOpen)) {
    if (!started) {
      throw new HttpError(502, '模型没有返回内容')
    }
    sendEvent(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: '模型没有返回内容' },
    })
    res.end()
    return
  }

  closeThinking()
  closeText()
  const titleEnabled = isRecord(body.title) && body.title.enabled === true
  const title = titleEnabled ? (lastUserText.trim() || '图片对话').slice(0, 40) : undefined
  sendEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, ...(title ? { title } : {}) },
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens,
    },
  })
  sendEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}
