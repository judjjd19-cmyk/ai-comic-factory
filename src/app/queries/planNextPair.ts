"use server"

import type { LLMVendorConfig } from "@/types"
import { predict } from "./predict"
import {
  generatePairPlan,
  type PairPlannerInput,
} from "@/lib/webtoon/pairPlanner"

/**
 * Validated two-panel planning entry point for the future pair production queue.
 * This does not modify character masters or invoke the image generator.
 */
export async function planNextPair(input: PairPlannerInput, llmVendorConfig: LLMVendorConfig) {
  return generatePairPlan(input, ({systemPrompt, userPrompt, maxNewTokens}) => predict({
    systemPrompt,
    userPrompt,
    nbMaxNewTokens: maxNewTokens,
    llmVendorConfig,
  }))
}