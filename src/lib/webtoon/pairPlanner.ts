/** LLM planning stage. No image generation or master mutation occurs here. */
import {
  validatePairPlan,
  type PairPlan,
  type PanelPlan,
  type SceneState,
  type WebtoonCatalog,
  type Issue,
} from './contracts.ts'

export interface PairPlannerInput {
  pairId: string
  episodeId: string
  storyGoal: string
  storyBibleSummary: string
  approvedHistorySummary: string
  before: SceneState
  catalog: WebtoonCatalog
}

export interface PlannerMessages {
  systemPrompt: string
  userPrompt: string
  maxNewTokens: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const string = (value: unknown): value is string => typeof value === 'string'
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string)
const bounds = (value: unknown): value is [number,number,number,number] =>
  Array.isArray(value) && value.length === 4 && value.every(n => typeof n === 'number' && Number.isFinite(n))
const point = (value: unknown): boolean => value === null ||
  (Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number'))
function scene(value: unknown): value is SceneState {
  return record(value) && string(value.sceneId) && string(value.locationId) && string(value.timeKey) &&
    Array.isArray(value.actors) && value.actors.every(actor => record(actor) && string(actor.characterId) &&
      string(actor.outfitId) && bounds(actor.box) && string(actor.facing) &&
      strings(actor.heldPropIds) && string(actor.emotion))
}
function panel(value: unknown): value is PanelPlan {
  return record(value) && string(value.id) && string(value.sceneId) && string(value.locationId) &&
    string(value.summary) && string(value.camera) && strings(value.events) &&
    Array.isArray(value.characters) && value.characters.every(actor => record(actor) &&
      string(actor.characterId) && string(actor.outfitId) && string(actor.action) &&
      string(actor.emotion) && string(actor.facing) && bounds(actor.box)) &&
    Array.isArray(value.bubbles) && value.bubbles.every(b => record(b) && string(b.id) &&
      string(b.type) && (b.speakerId === null || string(b.speakerId)) &&
      string(b.text) && bounds(b.box) && point(b.tailTarget) &&
      typeof b.readOrder === 'number' && Number.isInteger(b.readOrder))
}

/** Strip one optional JSON code fence without modifying any JSON string content. */
function parseObject(text: string): unknown {
  let value = text.trim()
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (match) value = match[1].trim()
  return JSON.parse(value) as unknown
}

export class PairPlanValidationError extends Error {
  issues: Issue[]
  constructor(issues: Issue[]) {
    super(issues.map(i => `${i.path}: ${i.message}`).join('; '))
    this.name = 'PairPlanValidationError'
    this.issues = issues
  }
}

export function buildPairMessages(input: PairPlannerInput, correction = ''): PlannerMessages {
  const systemPrompt = [
    'You are a Korean webtoon scriptwriter and two-panel storyboard director.',
    'Generate EXACTLY two consecutive panels of one scene sequence, with visible actor positions, expressions, poses, speech bubbles and a before/middle/after state transition.',
    'Only use the registered IDs and outfit IDs below; never invent or silently rename a canonical character, location, or outfit.',
    'Keep fixed character appearance and current clothes; a change requires an explicit outfit_change event.',
    'The FIRST panel moves the authoritative before state to middle; the SECOND moves middle to after.',
    'Coordinates are normalized x,y,width,height, with all values inside [0,1]. Bubble tails target the actual speaker. Reading order is explicit.',
    'Speech bubble TEXT must be natural Korean dialogue. The image renderer must NEVER draw text: the editor will insert exact dialogue later.',
    'Each panel should advance the scene with visually renderable acting and consistent screen direction. No isolated illustrations.',
    'Return only JSON object with keys middle, after, panels. Do not rewrite before, masters, pair IDs or episode IDs.',
    'Each panel must have id, sceneId, locationId, summary, camera, characters [{characterId,outfitId,action,emotion,box,facing}], bubbles [{id,type,speakerId,text,box,tailTarget,readOrder}], events [].',
    'Each state must have sceneId, locationId, timeKey, actors [{characterId,outfitId,box,facing,heldPropIds,emotion}].',
    'The speakerId is null only for narration bubbles. Types: speech, thought, narration. Events: character_enters, character_exits, outfit_change, scene_transition, prop_transfer, other.',
  ].join('\n')
  const userPrompt = JSON.stringify({
    task: 'Plan next two webtoon panels',
    pairId: input.pairId,
    episodeId: input.episodeId,
    storyGoal: input.storyGoal,
    storyBibleSummary: input.storyBibleSummary,
    approvedHistorySummary: input.approvedHistorySummary,
    authoritativeBefore: input.before,
    registeredCharacters: input.catalog.characters.map(c => ({
      id: c.id, displayName: c.displayName, description: c.description, outfitIds: c.outfitIds,
    })),
    registeredLocations: input.catalog.locations.map(l => ({ id: l.id, description: l.description })),
    ...(correction ? { previousOutputProblems: correction } : {}),
  })
  return { systemPrompt, userPrompt, maxNewTokens: 2800 }
}

/** Prevent the model from rewriting previous approved scene state or canonical IDs. */
export function decodePairPlan(text: string, input: PairPlannerInput): PairPlan {
  let value: unknown
  try { value = parseObject(text) }
  catch { throw new PairPlanValidationError([{code:'INVALID_JSON',path:'response',message:'LLM did not return valid JSON'}]) }
  if (!record(value) || !scene(value.middle) || !scene(value.after) ||
      !Array.isArray(value.panels) || value.panels.length !== 2 || !value.panels.every(panel)) {
    throw new PairPlanValidationError([{code:'INVALID_SCHEMA',path:'response',message:'Missing or mistyped state/panel fields'}])
  }
  if ('before' in value && JSON.stringify(value.before) !== JSON.stringify(input.before)) {
    throw new PairPlanValidationError([{code:'MASTER_STATE_MUTATION',path:'before',message:'Model attempted to alter authoritative before state'}])
  }
  if (('id' in value && value.id !== input.pairId) ||
      ('episodeId' in value && value.episodeId !== input.episodeId)) {
    throw new PairPlanValidationError([{code:'IDENTIFIER_MUTATION',path:'id',message:'Model attempted to alter pair or episode ID'}])
  }
  const draft: PairPlan = {
    id: input.pairId, episodeId: input.episodeId,
    before: structuredClone(input.before),
    middle: value.middle, after: value.after,
    panels: [value.panels[0], value.panels[1]],
  }
  const issues = validatePairPlan(draft, input.catalog)
  if (issues.length) throw new PairPlanValidationError(issues)
  return draft
}

/** Retries invalid LLM plans only; never downgrades them into fabricated panels. */
export async function generatePairPlan(
  input: PairPlannerInput,
  llm: (messages: PlannerMessages) => Promise<string>,
  maxAttempts = 2,
): Promise<PairPlan> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw new Error('maxAttempts must be between 1 and 3')
  let errors: Issue[] = []
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const correction = errors.map(e => `${e.code} ${e.path}: ${e.message}`).join('\n').slice(0, 1600)
    const raw = await llm(buildPairMessages(input, correction))
    try { return decodePairPlan(raw, input) }
    catch (error) {
      if (!(error instanceof PairPlanValidationError)) throw error
      errors = error.issues
    }
  }
  throw new PairPlanValidationError(errors)
}