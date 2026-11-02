/**
 * Readable transcript projection for one teammate session (docs/21).
 *
 * The Host's session log is a sequence of typed events. This module turns the
 * message-bearing ones into a small, defensively-parsed transcript so the live
 * board can show what a teammate actually said and did. It is pure: unknown
 * event shapes are skipped, never thrown on.
 */

/** Maximum characters of one transcript line. */
const DEFAULT_TEXT_LIMIT = 1200

/** @returns trimmed text of a content block, or null. */
function blockText(block, textLimit) {
  if (block === null || typeof block !== 'object') return null
  if (block.type === 'text' && typeof block.text === 'string') {
    const text = block.text.trim()
    if (text.length === 0) return null
    return text.length > textLimit ? `${text.slice(0, textLimit)}…` : text
  }
  if (block.type === 'image') return '[image]'
  if (block.type === 'tool-call') {
    const name = typeof block.name === 'string' ? block.name : 'tool'
    let args = ''
    try {
      args = block.arguments === undefined ? '' : JSON.stringify(block.arguments)
    } catch {
      args = ''
    }
    const summary = `${name}${args.length === 0 ? '' : ` ${args}`}`
    return `[tool] ${summary.length > textLimit ? `${summary.slice(0, textLimit)}…` : summary}`
  }
  return null
}

/** @returns the message text of one message object, or null. */
function messageText(message, textLimit) {
  if (message === null || typeof message !== 'object') return null
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    const text = blockText(block, textLimit)
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * Project session events into a bounded transcript.
 * @param events - raw session events (unknown shapes are skipped).
 * @param options - `{ limit?, textLimit? }`.
 * @returns `{ messages, truncated, totalEvents }`.
 */
export function summarizeTranscript(events, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 40
  const textLimit = Number.isInteger(options.textLimit) && options.textLimit > 0 ? Math.min(options.textLimit, 8000) : DEFAULT_TEXT_LIMIT
  const list = Array.isArray(events) ? events : []
  const messages = []
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const type = typeof event.type === 'string' ? event.type : ''
    let role = null
    let message = null
    if (type === 'user/message') {
      role = 'user'
      message = event.data
    } else if (type === 'assistant/message') {
      role = 'assistant'
      message = event.data?.message
    } else if (type === 'system/message' || type === 'developer/message') {
      role = 'system'
      message = event.data?.message
    } else if (type === 'tool/result') {
      role = 'tool'
      message = event.data?.message
    }
    if (role === null) continue
    const text = messageText(message, textLimit)
    if (text === null) continue
    messages.push({ seq: Number.isInteger(event.seq) ? event.seq : null, role, text })
  }
  const truncated = messages.length > limit
  return { messages: truncated ? messages.slice(-limit) : messages, truncated, totalEvents: list.length }
}
