/**
 * Extract exactly one top-level JSON array from an LLM response.
 * Handles fenced JSON, nested arrays, and bracket characters inside strings.
 */
export function cleanJson(input: string): string {
  const trimmed = input.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const content = (fence ? fence[1] : trimmed).trim()
  const start = content.indexOf("[")
  if (start < 0) throw new Error("LLM response does not contain a JSON array")
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === "[") {
      depth++
    } else if (ch === "]") {
      depth--
      if (depth === 0) return content.slice(start, i + 1)
    }
  }
  throw new Error("LLM response contains an unterminated JSON array")
}
