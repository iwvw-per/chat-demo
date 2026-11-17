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

const isRecord = (value: unknown): value is Value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const blocksOf = (value: unknown): Value[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

type InlineImageBlock = Value & {
  source: { type: 'base64'; media_type: string; data: string }
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

const answerText = (payload: Value): string => {
  const choice = blocksOf(payload.choices)[0]
  if (!choice) {
    return ''
  }
  const message = isRecord(choice.message) ? choice.message : {}
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.content)) {
    return message.content
      .flatMap((part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
      )
      .join('')
  }
  return typeof choice.text === 'string' ? choice.text : ''
}

const sendEvent = (res: Response, event: string, data: unknown) => {
  if (!res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

const pipeError = async (res: Response, response: globalThis.Response) => {
  const text = await response.text().catch(() => '')
  const contentType = response.headers.get('Content-Type')
  if (contentType) {
    res.setHeader('Content-Type', contentType)
  }
  res.status(response.status).send(text || response.statusText)
}

export const handleVisionMessage = async (
  res: Response,
  body: Value,
  provider: ProviderConfig
): Promise<void> => {
  const { messages, lastUserText, images } = toOpenAIMessages(body)
  if (images === 0 || messages.length === 0) {
    throw new HttpError(400, '没有可读取的图片', 'invalid_vision_request')
  }
  const model =
    config.visionModel || (typeof body.model === 'string' ? body.model : provider.model)
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })

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
        body: JSON.stringify({ model, messages, stream: false, max_tokens: 4096 }),
        signal: controller.signal,
      }
    )
  } catch (error) {
    if (controller.signal.aborted) {
      return
    }
    throw new HttpError(
      502,
      `无法连接多模态接口: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!upstream.ok) {
    await pipeError(res, upstream)
    return
  }
  let payload: Value
  try {
    const parsed = (await upstream.json()) as unknown
    if (!isRecord(parsed)) {
      throw new Error('invalid payload')
    }
    payload = parsed
  } catch {
    throw new HttpError(502, '多模态接口返回格式错误')
  }
  const answer = answerText(payload)
  if (!answer) {
    throw new HttpError(502, '多模态模型未返回文本内容')
  }
  const usage = isRecord(payload.usage) ? payload.usage : {}
  const inputTokens = Number(usage.prompt_tokens) || 0
  const outputTokens = Number(usage.completion_tokens) || 0
  const titleEnabled = isRecord(body.title) && body.title.enabled === true
  const title = titleEnabled ? (lastUserText.trim() || '图片对话').slice(0, 40) : undefined
  const usagePayload = {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  }

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  sendEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usagePayload,
    },
  })
  sendEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  sendEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: answer },
  })
  sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sendEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null, ...(title ? { title } : {}) },
    usage: { ...usagePayload, output_tokens: outputTokens },
  })
  sendEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}