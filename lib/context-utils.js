export function estimateTokens(text) {
  let tokens = 0
  let asciiRun = 0
  const flushAscii = () => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4)
    asciiRun = 0
  }
  for (const character of String(text ?? '')) {
    if (/[^\x00-\x7F]/u.test(character)) {
      flushAscii()
      tokens += 1
    } else asciiRun += 1
  }
  flushAscii()
  return tokens
}

function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content.filter(Boolean) : []
}

function toolCallsOf(message) {
  const calls = []
  for (const call of message?.tool_calls ?? []) calls.push(call?.id ?? call?.toolCallId ?? call?.callId ?? null)
  for (const block of blocksOf(message)) {
    if (['tool-call', 'tool_call', 'tool-use', 'tool_use'].includes(block?.type)) {
      calls.push(block.id ?? block.toolCallId ?? block.callId ?? null)
    }
  }
  return calls
}

function toolResultsOf(message) {
  const results = []
  if (message?.role === 'tool') results.push(message.tool_call_id ?? message.toolCallId ?? message.callId ?? null)
  for (const block of blocksOf(message)) {
    if (['tool-result', 'tool_result', 'tool-output', 'tool_output'].includes(block?.type)) {
      results.push(block.toolCallId ?? block.tool_call_id ?? block.callId ?? block.id ?? null)
    }
  }
  if (results.length === 0 && message?.source?.kind === 'tool') results.push(message.source.callId ?? message.source.toolCallId ?? null)
  return results
}

function callsAreResolved(calls, results) {
  if (calls.length === 0) return true
  const namedCalls = calls.filter(Boolean).map(String)
  const namedResults = new Set(results.filter(Boolean).map(String))
  if (namedCalls.length === calls.length) return namedCalls.every((id) => namedResults.has(id))
  return results.length >= calls.length
}

export function protectToolPairBoundary(messages, proposedIndex) {
  if (!Array.isArray(messages)) return proposedIndex
  const boundary = Math.max(0, Math.min(messages.length, proposedIndex))
  let assistantIndex = boundary - 1
  while (assistantIndex >= 0 && toolResultsOf(messages[assistantIndex]).length > 0) assistantIndex -= 1
  const calls = toolCallsOf(messages[assistantIndex])
  if (calls.length === 0) return boundary
  const results = []
  for (let index = assistantIndex + 1; index < boundary; index += 1) results.push(...toolResultsOf(messages[index]))
  if (callsAreResolved(calls, results)) return boundary
  let adjusted = boundary
  while (adjusted < messages.length) {
    const current = toolResultsOf(messages[adjusted])
    if (current.length === 0) break
    results.push(...current)
    adjusted += 1
    if (callsAreResolved(calls, results)) return adjusted
  }
  return assistantIndex
}
