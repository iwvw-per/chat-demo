import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { config } from './config.js'
import type { ProviderConfig } from './db.js'
import { HttpError } from './http.js'

type Value = Record<string, unknown>

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAIContentPart[]
}

type InlineImageBlock = Value & {
  source: { type: 'base64'; media_type: string; data: string }
}

const isRecord = (value: unknown): value is Value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const blocksOf = (value: unknown): Value[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

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
  const payload: Record<string, unknown> = { model, messages, stream: true, max_tokens: 4096 }
  if (images === 0 && thinking) {
    payload.reasoning_effort = 'high'
  }
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
      return
    }
    throw new HttpError(
      502,
      `无法连接模型接口: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!upstream.ok) {
    await pipeError(res, upstream)
    return
  }
  if (!upstream.body) {
    throw new HttpError(502, '模型接口没有返回流')
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const answerId = `msg_${randomUUID()}`
  let started = false
  let thinkingOpen = false
  let textOpen = false
  let thinkingIndex = -1
  let textIndex = -1
  let nextIndex = 0
  let answer = ''
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
      openText()
      answer += content
      sendEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: content },
      })
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
      return
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
    return
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