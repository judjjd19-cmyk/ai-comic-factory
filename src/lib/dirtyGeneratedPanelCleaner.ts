import type { GeneratedPanel } from "@/types"

// Preserve intentional punctuation, names and dialogue. The old cleaner
// truncated every string at its final colon and altered the story.
export function dirtyGeneratedPanelCleaner(panel: GeneratedPanel): GeneratedPanel {
  return {
    panel: panel.panel,
    instructions: panel.instructions.trim(),
    speech: panel.speech.trim(),
    caption: panel.caption.trim(),
  }
}
