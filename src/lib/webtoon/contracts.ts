/**
 * Typed, model-independent contracts for the two-panel webtoon production line.
 * The authoritative character/location masters must never be synthesized from
 * model output. Data is validated before it can enter the render queue.
 */
export type Bounds = [number, number, number, number] // x, y, width, height in [0, 1]
export type Point = [number, number]
export type Facing = 'left' | 'right' | 'front' | 'back'

export interface ReferenceAsset {
  id: string
  kind: 'identity' | 'outfit' | 'view' | 'location' | 'previous-panel'
  ownerId: string
  uri: string
  sha256: string
  status: 'approved' | 'draft' | 'rejected'
  version: number
  view?: Facing
  outfitId?: string
}

export interface CharacterMaster {
  id: string
  version: number
  displayName: string
  description: string
  outfitIds: string[]
  identityReferenceId: string
}

export interface LocationMaster {
  id: string
  version: number
  description: string
  referenceIds: string[]
}

export interface ActorState {
  characterId: string
  outfitId: string
  box: Bounds
  facing: Facing
  heldPropIds: string[]
  emotion: string
}

export interface SceneState {
  sceneId: string
  locationId: string
  timeKey: string
  actors: ActorState[]
}

export interface BubblePlan {
  id: string
  type: 'speech' | 'thought' | 'narration'
  speakerId: string | null
  text: string
  box: Bounds
  tailTarget: Point | null
  readOrder: number
}

export interface PanelPlan {
  id: string
  sceneId: string
  locationId: string
  summary: string
  camera: string
  characters: Array<{
    characterId: string
    outfitId: string
    action: string
    emotion: string
    box: Bounds
    facing: Facing
  }>
  bubbles: BubblePlan[]
  /** A deliberate change between this panel's before and after state. */
  events: Array<'character_enters' | 'character_exits' | 'outfit_change' | 'scene_transition' | 'prop_transfer' | 'other'>
}

export interface PairPlan {
  id: string
  episodeId: string
  before: SceneState
  middle: SceneState
  after: SceneState
  panels: [PanelPlan, PanelPlan]
}

export interface WebtoonCatalog {
  characters: CharacterMaster[]
  locations: LocationMaster[]
  assets: ReferenceAsset[]
}

export interface Issue {
  code: string
  path: string
  message: string
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const validId = (id: string): boolean => typeof id === 'string' && ID.test(id)
const validPoint = (point: Point): boolean => Array.isArray(point) && point.length === 2 &&
  point.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
const validBox = (box: Bounds): boolean => Array.isArray(box) && box.length === 4 &&
  box.every(n => typeof n === 'number' && Number.isFinite(n)) &&
  box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0 &&
  box[0] + box[2] <= 1.000001 && box[1] + box[3] <= 1.000001

/** Returns *all* blocking errors. Does not mutate its arguments. */
export function validatePairPlan(pair: PairPlan, catalog: WebtoonCatalog): Issue[] {
  const issues: Issue[] = []
  const bad = (code: string, path: string, message: string): void => { issues.push({ code, path, message }) }
  const characters = new Map(catalog.characters.map(c => [c.id, c]))
  const locations = new Map(catalog.locations.map(l => [l.id, l]))
  const assets = new Map(catalog.assets.map(a => [a.id, a]))

  if (!validId(pair.id)) bad('INVALID_ID', 'id', 'Pair ID must be a stable identifier')
  if (!validId(pair.episodeId)) bad('INVALID_ID', 'episodeId', 'Episode ID must be a stable identifier')
  if (!Array.isArray(pair.panels) || pair.panels.length !== 2) {
    bad('PAIR_SIZE', 'panels', 'Exactly two panels are required')
    return issues
  }
  if (pair.panels[0].id === pair.panels[1].id) bad('DUPLICATE_PANEL', 'panels', 'Panel IDs must differ')

  for (const character of catalog.characters) {
    if (!validId(character.id) || character.version < 1 || !Number.isInteger(character.version))
      bad('MASTER_INVALID', `characters.${character.id}`, 'Invalid character master')
    if (new Set(character.outfitIds).size !== character.outfitIds.length)
      bad('DUPLICATE_OUTFIT', `characters.${character.id}`, 'Outfit IDs must be unique')
    const reference = assets.get(character.identityReferenceId)
    if (!reference || reference.kind !== 'identity' || reference.ownerId !== character.id ||
        reference.status !== 'approved' || reference.version !== character.version || !reference.sha256) {
      bad('MASTER_REFERENCE', `characters.${character.id}`, 'An approved, version-matched identity reference is required')
    }
  }

  const states = [pair.before, pair.middle, pair.after]
  states.forEach((state, step) => {
    const key = ['before', 'middle', 'after'][step]
    if (!validId(state.sceneId)) bad('SCENE_ID', `${key}.sceneId`, 'Invalid scene ID')
    if (!locations.has(state.locationId)) bad('UNKNOWN_LOCATION', `${key}.locationId`, 'Location is not in the catalog')
    const ids = new Set<string>()
    const propHolders = new Set<string>()
    state.actors.forEach((actor, i) => {
      const path = `${key}.actors.${i}`
      if (ids.has(actor.characterId)) bad('DUPLICATE_ACTOR', path, 'Actor is repeated in the same scene state')
      ids.add(actor.characterId)
      const master = characters.get(actor.characterId)
      if (!master) bad('UNKNOWN_CHARACTER', `${path}.characterId`, 'Actor is not registered')
      else if (!master.outfitIds.includes(actor.outfitId)) bad('OUTFIT_MISMATCH', `${path}.outfitId`, 'Outfit is not registered for actor')
      if (!validBox(actor.box)) bad('INVALID_BOX', `${path}.box`, 'Actor bounds must fit inside the panel')
      if (new Set(actor.heldPropIds).size !== actor.heldPropIds.length)
        bad('DUPLICATE_PROP', `${path}.heldPropIds`, 'Same prop is held twice')
      for (const propId of actor.heldPropIds) {
        if (propHolders.has(propId)) bad('CONFLICTING_PROP_HOLDER', `${path}.heldPropIds`, 'Prop is held by multiple actors')
        propHolders.add(propId)
      }
    })
  })

  pair.panels.forEach((panel, i) => {
    const key = `panels.${i}`
    const before = states[i], after = states[i + 1]
    if (!validId(panel.id)) bad('INVALID_ID', `${key}.id`, 'Invalid panel ID')
    if (panel.sceneId !== after.sceneId) bad('SCENE_MISMATCH', `${key}.sceneId`, 'Panel scene does not match resulting state')
    if (panel.locationId !== after.locationId) bad('LOCATION_MISMATCH', `${key}.locationId`, 'Panel location does not match resulting state')
    if (before.locationId !== after.locationId && !panel.events.includes('scene_transition'))
      bad('UNDECLARED_LOCATION_CHANGE', key, 'Scene transition event required to change location')
    const visible = new Set<string>()
    panel.characters.forEach((actor, j) => {
      const path = `${key}.characters.${j}`
      if (visible.has(actor.characterId)) bad('DUPLICATE_ACTOR', path, 'Actor appears twice in the same panel')
      visible.add(actor.characterId)
      const master = characters.get(actor.characterId)
      if (!master) bad('UNKNOWN_CHARACTER', `${path}.characterId`, 'Actor is not registered')
      else if (!master.outfitIds.includes(actor.outfitId)) bad('OUTFIT_MISMATCH', `${path}.outfitId`, 'Invalid outfit')
      if (!validBox(actor.box)) bad('INVALID_BOX', `${path}.box`, 'Actor bounds must fit inside the panel')
      const finalActor = after.actors.find(a => a.characterId === actor.characterId)
      if (!finalActor || finalActor.outfitId !== actor.outfitId)
        bad('ACTOR_STATE_MISMATCH', path, 'Visible actor must match resulting scene state')
    })
    const beforeActors = new Map(before.actors.map(a => [a.characterId, a]))
    for (const actor of after.actors) {
      const previous = beforeActors.get(actor.characterId)
      if (previous && previous.outfitId !== actor.outfitId && !panel.events.includes('outfit_change'))
        bad('UNDECLARED_OUTFIT_CHANGE', key, 'Outfit changed without an explicit event')
    }
    const seenBubbles = new Set<string>()
    const readOrders = new Set<number>()
    panel.bubbles.forEach((bubble, j) => {
      const path = `${key}.bubbles.${j}`
      if (!validId(bubble.id) || seenBubbles.has(bubble.id)) bad('BUBBLE_ID', path, 'Bubble ID must be unique in panel')
      seenBubbles.add(bubble.id)
      if (!Number.isInteger(bubble.readOrder) || bubble.readOrder < 0 || readOrders.has(bubble.readOrder))
        bad('READ_ORDER', `${path}.readOrder`, 'Reading order must be a unique nonnegative integer')
      readOrders.add(bubble.readOrder)
      if (!validBox(bubble.box)) bad('INVALID_BOX', `${path}.box`, 'Bubble bounds must fit inside the panel')
      if (bubble.tailTarget !== null && !validPoint(bubble.tailTarget))
        bad('INVALID_TARGET', `${path}.tailTarget`, 'Bubble tail target is outside panel')
      if (bubble.type === 'narration' && bubble.speakerId !== null)
        bad('NARRATION_SPEAKER', path, 'Narration must not have a character speaker')
      if (bubble.type !== 'narration' && (!bubble.speakerId || !visible.has(bubble.speakerId)))
        bad('INVALID_SPEAKER', path, 'Spoken/thought bubbles need a visible speaker')
      if (!bubble.text.trim()) bad('EMPTY_BUBBLE', `${path}.text`, 'Bubble dialogue must not be empty')
    })
  })

  return issues
}

export interface ApprovedPanel {
  id: string
  sceneId: string
  assetId: string
  approvedAt: string
  planId: string
}

export interface SelectedReference {
  assetId: string
  purpose: 'identity' | 'outfit' | 'view' | 'location' | 'continuity'
  characterId?: string
}

/** Only immutable approved assets are eligible. Identity images are mandatory. */
export function selectReferences(
  panel: PanelPlan,
  catalog: WebtoonCatalog,
  previous?: ApprovedPanel,
  maxCount = 8,
): SelectedReference[] {
  if (!Number.isInteger(maxCount) || maxCount < 1) throw new Error('Invalid reference budget')
  const byId = new Map(catalog.assets.map(asset => [asset.id, asset]))
  const result: SelectedReference[] = []
  const seen = new Set<string>()
  const add = (asset: ReferenceAsset | undefined, purpose: SelectedReference['purpose'], characterId?: string): void => {
    if (!asset || asset.status !== 'approved' || !asset.sha256 || seen.has(asset.id)) return
    if (result.length >= maxCount) return
    result.push({ assetId: asset.id, purpose, ...(characterId ? { characterId } : {}) })
    seen.add(asset.id)
  }
  for (const characterId of new Set(panel.characters.map(actor => actor.characterId))) {
    const master = catalog.characters.find(character => character.id === characterId)
    if (!master) throw new Error(`Unknown character ${characterId}`)
    const anchor = byId.get(master.identityReferenceId)
    if (!anchor || anchor.kind !== 'identity' || anchor.ownerId !== master.id ||
        anchor.version !== master.version || anchor.status !== 'approved' || !anchor.sha256) {
      throw new Error(`Missing approved identity anchor for ${characterId}`)
    }
    if (result.length >= maxCount) throw new Error('Reference budget too small for all visible character anchors')
    add(anchor, 'identity', characterId)
  }
  for (const actor of panel.characters) {
    const outfit = catalog.assets.find(a => a.kind === 'outfit' && a.ownerId === actor.characterId &&
      a.status === 'approved' && a.uri && a.sha256 && a.version === catalog.characters.find(c => c.id === actor.characterId)?.version &&
      a.outfitId === actor.outfitId)
    add(outfit, 'outfit', actor.characterId)
    // A view reference is useful for profile/back shots but never replaces the fixed identity anchor.
    const view = catalog.assets.find(a => a.kind === 'view' && a.ownerId === actor.characterId &&
      a.view === actor.facing && a.version === catalog.characters.find(c => c.id === actor.characterId)?.version &&
      a.status === 'approved' && a.sha256)
    add(view, 'view', actor.characterId)
  }
  const location = catalog.locations.find(l => l.id === panel.locationId)
  if (location) for (const id of location.referenceIds) {
    const asset = byId.get(id)
    if (asset?.ownerId === location.id && asset.kind === 'location' && asset.version === location.version) add(asset, 'location')
  }
  if (previous && previous.approvedAt && previous.sceneId === panel.sceneId) {
    const image = byId.get(previous.assetId)
    if (image && image.kind === 'previous-panel' && image.ownerId === previous.id) add(image, 'continuity')
  }
  return result
}

export type PairJobStatus = 'planned' | 'validated' | 'rendering_first' | 'review_first' |
  'first_approved' | 'rendering_second' | 'review_second' | 'approved' | 'blocked'
export type PairJobEvent = 'validate' | 'render_first' | 'review_first' | 'approve_first' |
  'render_second' | 'review_second' | 'approve_second' | 'block'

export interface PairJob {
  id: string
  status: PairJobStatus
  revision: number
  firstApprovedAssetId?: string
  secondApprovedAssetId?: string
}

export function transitionPairJob(job: PairJob, event: PairJobEvent, assetId?: string): PairJob {
  const transitions: Record<PairJobEvent, Partial<Record<PairJobStatus, PairJobStatus>>> = {
    validate: { planned: 'validated' },
    render_first: { validated: 'rendering_first' },
    review_first: { rendering_first: 'review_first' },
    approve_first: { review_first: 'first_approved' },
    render_second: { first_approved: 'rendering_second' },
    review_second: { rendering_second: 'review_second' },
    approve_second: { review_second: 'approved' },
    block: { planned: 'blocked', validated: 'blocked', rendering_first: 'blocked', review_first: 'blocked', first_approved: 'blocked', rendering_second: 'blocked', review_second: 'blocked' },
  }
  const target = transitions[event][job.status]
  if (!target) throw new Error(`Invalid pair job transition: ${job.status} -> ${event}`)
  if ((event === 'approve_first' || event === 'approve_second') && !assetId)
    throw new Error('Approval requires a verified rendered image asset ID')
  return {
    ...job, status: target, revision: job.revision + 1,
    ...(event === 'approve_first' ? { firstApprovedAssetId: assetId } : {}),
    ...(event === 'approve_second' ? { secondApprovedAssetId: assetId } : {}),
  }
}