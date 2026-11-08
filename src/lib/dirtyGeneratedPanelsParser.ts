import type { GeneratedPanel } from "@/types"
import { cleanJson } from "./cleanJson"

export function dirtyGeneratedPanelsParser(input: string): GeneratedPanel[] {
  const parsed: unknown = JSON.parse(cleanJson(input))
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Expected a non-empty array of generated panels")
  }
  return parsed.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid panel at index " + i)
    const raw = entry as Record<string, unknown>
    if (typeof raw.instructions !== "string" || !raw.instructions.trim()) {
      throw new Error("Panel " + i + " is missing drawing instructions")
    }
    if (raw.speech !== undefined && typeof raw.speech !== "string") {
      throw new Error("Panel " + i + " has invalid speech")
    }
    if (raw.caption !== undefined && typeof raw.caption !== "string") {
      throw new Error("Panel " + i + " has invalid caption")
    }
    return {
      panel: i,
      instructions: raw.instructions.trim(),
      speech: typeof raw.speech === "string" ? raw.speech.trim() : "",
      caption: typeof raw.caption === "string" ? raw.caption.trim() : ""
    }
  })
}
