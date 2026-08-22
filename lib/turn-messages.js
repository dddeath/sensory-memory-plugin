import { messageTextOf } from './demotion-engine.js'

function messageSeqMap(session) {
  const result = new Map()
  for (const event of session?.events ?? []) {
    const message = event?.type === 'user/message' ? event.data : event?.data?.message
    if (message?.id !== undefined && Number.isFinite(event?.seq)) result.set(String(message.id), event.seq)
  }
  return result
}

function sourceSeqOf(message, turn, messageIndex, seqMap) {
  return message?.sourceSeq
    ?? message?.seq
    ?? (message?.id === undefined ? undefined : seqMap?.get(String(message.id)))
    ?? message?.id
    ?? message?.source?.seq
    ?? `${turn}-${messageIndex}`
}

export function extractRecentTurnMessages(messages, turn, session = null) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const seqMap = messageSeqMap(session)
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messages[index]?.source?.kind === 'user') {
      start = index
      break
    }
  }

  const result = []
  for (let messageIndex = start; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    if (!message || message.source?.kind === 'plugin') continue
    const role = String(message.role ?? 'assistant')
    const base = {
      role,
      sourceSeq: sourceSeqOf(message, turn, messageIndex, seqMap),
      toolName: message.toolName ?? message.name,
    }
    if (role === 'tool' || message.source?.kind === 'tool') {
      const text = messageTextOf(message)
      if (text.trim()) result.push({ ...base, role: 'tool', kind: 'tool', text })
      continue
    }
    if (Array.isArray(message.content)) {
      message.content.forEach((block, blockIndex) => {
        if (!block || typeof block !== 'object') return
        if (block.type !== 'text' && block.type !== 'reasoning') return
        if (typeof block.text !== 'string' || !block.text.trim()) return
        result.push({
          ...base,
          sourceSeq: sourceSeqOf(message, turn, messageIndex, seqMap),
          blockIndex,
          kind: block.type === 'reasoning' ? 'reasoning' : 'message',
          text: block.text,
        })
      })
      continue
    }
    const text = messageTextOf(message)
    if (text.trim()) result.push({ ...base, kind: 'message', text })
  }
  return result
}

export function lastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return String(messages[index].text ?? '')
  }
  return ''
}
