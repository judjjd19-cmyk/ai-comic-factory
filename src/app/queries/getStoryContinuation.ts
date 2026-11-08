import { Preset } from "../engine/presets"
import { GeneratedPanel, LLMVendorConfig } from "@/types"
import { predictNextPanels } from "./predictNextPanels"

export const getStoryContinuation = async ({
  preset,
  stylePrompt = "",
  userStoryPrompt = "",
  nbPanelsToGenerate,
  maxNbPanels,
  existingPanels = [],
  llmVendorConfig
}: {
  preset: Preset
  stylePrompt?: string
  userStoryPrompt?: string
  nbPanelsToGenerate: number
  maxNbPanels: number
  existingPanels?: GeneratedPanel[]
  llmVendorConfig: LLMVendorConfig
}): Promise<GeneratedPanel[]> => {
  if (!Number.isInteger(nbPanelsToGenerate) || nbPanelsToGenerate < 1) {
    throw new Error("nbPanelsToGenerate must be positive")
  }
  const panelCandidates = await predictNextPanels({
    preset,
    prompt: userStoryPrompt,
    nbPanelsToGenerate,
    maxNbPanels,
    existingPanels,
    llmVendorConfig,
  })
  if (panelCandidates.length !== nbPanelsToGenerate) {
    throw new Error("LLM generated " + panelCandidates.length + " panels, expected " + nbPanelsToGenerate)
  }
  const startAt = existingPanels.length + 1
  return panelCandidates.map((panel, i) => ({
    panel: startAt + i,
    instructions: panel.instructions,
    speech: panel.speech,
    caption: panel.caption,
  }))
}
