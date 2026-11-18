import { config as appConfig } from './config.js'
import type { ProviderConfig } from './db.js'

const TITLE_PROMPT = [
  '你负责为一段对话生成标题。',
  '要求:使用对话本身的语言;概括主题,不要照抄原句;',
  '不超过 12 个汉字或 6 个英文单词;不要引号、书名号、句号、冒号;不要解释;只输出标题本身。',
].join('')

const count = (value: string) => Array.from(value).length

const cleanTitle = (value: string): string => {
  const line =
    value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean) ?? ''
  const trimmed = line
    .replace(/^标题[:：]\s*/, '')
    .replace(/^[\s"'“”‘’`【[(]+/, '')
    .replace(/[\s"'“”‘’`】\])]+$/, '')
    .replace(/[。．.!！?？,，;；:：]+$/, '')
    .trim()
  return count(trimmed) > 40 ? Array.from(trimmed).slice(0, 40).join('') : trimmed
}

type CompletionResponse = {
  choices?: { message?: { content?: unknown } }[]
}

const readContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .join('')
}

/** 用一次非流式补全让模型概括会话标题;失败时返回空串,由调用方回退到首条提问。 */
export const generateTitle = async (
  provider: ProviderConfig,
  question: string,
  answer: string
): Promise<string> => {
  const response = await fetch(
    `${provider.baseUrl.replace(/\/+$/, '')}${appConfig.apiPaths.chatCompletions}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model || appConfig.apiModel,
        stream: false,
        max_tokens: 256,
        temperature: 0.3,
        messages: [
          { role: 'system', content: TITLE_PROMPT },
          { role: 'user', content: `用户:${question}\n\n助手:${answer}` },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    }
  )
  if (!response.ok) {
    return ''
  }
  const data = (await response.json()) as CompletionResponse
  return cleanTitle(readContent(data.choices?.[0]?.message?.content))
}