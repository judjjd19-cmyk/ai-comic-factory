/**
 * Single-host persistent production state. Intended for a mounted Colab drive,
 * not a multi-user public database. Writes are atomic and protected by a
 * per-project filesystem lock. Model output never rewrites canonical masters.
 */
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  validatePairPlan,
  transitionPairJob,
  type WebtoonCatalog,
  type PairPlan,
  type PairJob,
  type PairJobEvent,
  type ApprovedPanel,
  type ReferenceAsset,
} from './contracts.ts'

export interface PairRecord { plan: PairPlan; job: PairJob }
export interface ProjectSnapshot {
  schemaVersion: 1
  revision: number
  projectId: string
  catalog: WebtoonCatalog
  pairs: PairRecord[]
  approvedPanels: ApprovedPanel[]
}

type NonApprovalEvent = Exclude<PairJobEvent, 'approve_first' | 'approve_second' | 'validate'>
const validId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)
const assertId = (id: string): void => { if (!validId(id)) throw new Error('Unsafe or invalid identifier') }
const hash = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex')

export class ProjectStore {
  private readonly root: string
  constructor(root = process.env.WEBTOON_DATA_DIR || resolve(process.cwd(), 'webtoon-data')) {
    this.root = resolve(root)
  }
  private dir(projectId: string): string {
    assertId(projectId)
    return join(this.root, projectId)
  }
  private manifest(projectId: string): string { return join(this.dir(projectId), 'manifest.json') }

  private async readRaw(projectId: string): Promise<ProjectSnapshot> {
    const snapshot = JSON.parse(await readFile(this.manifest(projectId), 'utf8')) as ProjectSnapshot
    if (snapshot.schemaVersion !== 1 || snapshot.projectId !== projectId ||
        !Array.isArray(snapshot.pairs) || !Array.isArray(snapshot.catalog.characters)) {
      throw new Error('Project manifest is invalid or unsupported')
    }
    return snapshot
  }
  private async writeAtomic(projectId: string, snapshot: ProjectSnapshot): Promise<void> {
    const tmp = join(this.dir(projectId), '.manifest-' + randomUUID() + '.tmp')
    try {
      await writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
      await rename(tmp, this.manifest(projectId))
    } finally {
      await rm(tmp, { force: true })
    }
  }
  private async locked<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const directory = this.dir(projectId)
    await mkdir(directory, { recursive: true })
    const lockDir = join(directory, '.manifest-lock')
    try { await mkdir(lockDir) }
    catch (e) { throw new Error('Project is locked by another writer: ' + String(e)) }
    try { return await action() }
    finally { await rm(lockDir, { recursive: true, force: true }) }
  }
  private async modify(projectId: string, expectedRevision: number, change: (s: ProjectSnapshot) => void | Promise<void>): Promise<ProjectSnapshot> {
    return this.locked(projectId, async () => {
      const current = await this.readRaw(projectId)
      if (current.revision !== expectedRevision) {
        throw new Error(`Revision conflict: expected ${expectedRevision}, current ${current.revision}`)
      }
      const next = structuredClone(current)
      await change(next)
      next.revision += 1
      await this.writeAtomic(projectId, next)
      return next
    })
  }

  async create(projectId: string, catalog: WebtoonCatalog): Promise<ProjectSnapshot> {
    return this.locked(projectId, async () => {
      try { await stat(this.manifest(projectId)); throw new Error('Project already exists') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      const uniqueIds = new Set<string>()
      for (const c of catalog.characters) {
        assertId(c.id)
        if (uniqueIds.has('c:' + c.id)) throw new Error('Duplicate character')
        uniqueIds.add('c:' + c.id)
        const anchor = catalog.assets.find(a => a.id === c.identityReferenceId)
        if (!anchor || anchor.kind !== 'identity' || anchor.ownerId !== c.id ||
            anchor.status !== 'approved' || anchor.version !== c.version || !anchor.sha256 || !anchor.uri) {
          throw new Error('Character master requires approved identity asset: ' + c.id)
        }
      }
      for (const l of catalog.locations) assertId(l.id)
      for (const a of catalog.assets) assertId(a.id)
      const snapshot: ProjectSnapshot = { schemaVersion: 1, revision: 0, projectId, catalog: structuredClone(catalog), pairs: [], approvedPanels: [] }
      await this.writeAtomic(projectId, snapshot)
      return snapshot
    })
  }
  async read(projectId: string): Promise<ProjectSnapshot> {
    return structuredClone(await this.readRaw(projectId))
  }
  async appendPair(projectId: string, expectedRevision: number, plan: PairPlan): Promise<ProjectSnapshot> {
    return this.modify(projectId, expectedRevision, snapshot => {
      if (snapshot.pairs.some(item => item.plan.id === plan.id)) throw new Error('Duplicate pair ID')
      const previous = snapshot.pairs.at(-1)
      if (previous) {
        if (previous.job.status !== 'approved') throw new Error('Previous pair is not approved')
        if (JSON.stringify(previous.plan.after) !== JSON.stringify(plan.before))
          throw new Error('Pair before-state does not match previously approved after-state')
      }
      const issues = validatePairPlan(plan, snapshot.catalog)
      if (issues.length) throw new Error('Invalid pair plan: ' + issues.map(i => i.code + ':' + i.path).join(', '))
      const job = transitionPairJob({ id: plan.id, status: 'planned', revision: 0 }, 'validate')
      snapshot.pairs.push({plan: structuredClone(plan), job})
    })
  }
  async advancePair(projectId: string, expectedRevision: number, pairId: string, event: NonApprovalEvent): Promise<ProjectSnapshot> {
    return this.modify(projectId, expectedRevision, snapshot => {
      const item = snapshot.pairs.find(entry => entry.plan.id === pairId)
      if (!item) throw new Error('Unknown pair ID')
      if (event === 'approve_first' || event === 'approve_second' || event === 'validate')
        throw new Error('This event must use the dedicated approval function')
      item.job = transitionPairJob(item.job, event)
    })
  }
  /** Save a render as a DRAFT asset; it cannot be used as a continuity reference. */
  async stageImage(projectId: string, expectedRevision: number, pairId: string,
    panelIndex: 0 | 1, image: Buffer, mime: 'image/png' | 'image/jpeg' | 'image/webp'): Promise<ProjectSnapshot> {
    if (image.length < 8 || image.length > 20 * 1024 * 1024) throw new Error('Invalid image size')
    const magic = mime === 'image/png' ? image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
      mime === 'image/jpeg' ? image[0] === 0xff && image[1] === 0xd8 :
      image.subarray(0,4).toString('ascii') === 'RIFF' && image.subarray(8,12).toString('ascii') === 'WEBP'
    if (!magic) throw new Error('Image header does not match MIME type')
    const extension = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'
    const digest = hash(image)
    const assetId = 'render_' + createHash('sha256').update(pairId + ':' + panelIndex + ':' + digest).digest('hex').slice(0, 40)
    return this.modify(projectId, expectedRevision, async snapshot => {
      const pair = snapshot.pairs.find(entry => entry.plan.id === pairId)
      if (!pair) throw new Error('Unknown pair')
      const expected = panelIndex === 0 ? 'review_first' : 'review_second'
      if (pair.job.status !== expected) throw new Error('Image stage requires matching review state')
      if (snapshot.catalog.assets.some(a => a.id === assetId)) throw new Error('Image already staged')
      const mediaDir = join(this.dir(projectId), 'assets')
      await mkdir(mediaDir, {recursive: true})
      const file = join(mediaDir, digest + '.' + extension)
      try { await writeFile(file, image, {flag:'wx'}) }
      catch(e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      // Verify even when a file with the same hash-named path already exists.
      if (hash(await readFile(file)) !== digest) throw new Error('Image store checksum mismatch')
      snapshot.catalog.assets.push({id:assetId,kind:'previous-panel',ownerId:pair.plan.panels[panelIndex].id,
        uri:'assets/' + digest + '.' + extension,sha256:digest,status:'draft',version:1})
    })
  }

  /** Manual review approval. Automatic visual QA will be added later. */
  async approvePanel(projectId: string, expectedRevision: number, pairId: string, panelIndex: 0 | 1,
    assetId: string, reviewer: string): Promise<ProjectSnapshot> {
    if (!reviewer.trim()) throw new Error('Reviewer identity is required')
    return this.modify(projectId, expectedRevision, async snapshot => {
      const entry = snapshot.pairs.find(p => p.plan.id === pairId)
      if (!entry) throw new Error('Unknown pair')
      const expected = panelIndex === 0 ? 'review_first' : 'review_second'
      if (entry.job.status !== expected) throw new Error('Panel cannot be approved in current state')
      const asset = snapshot.catalog.assets.find(a => a.id === assetId)
      if (!asset || asset.kind !== 'previous-panel' || asset.ownerId !== entry.plan.panels[panelIndex].id ||
          asset.status !== 'draft' || !asset.sha256 || !asset.uri.startsWith('assets/'))
        throw new Error('Cannot approve an unstaged or mismatched image')
      const actual = await readFile(join(this.dir(projectId), asset.uri))
      if (hash(actual) !== asset.sha256) throw new Error('Image checksum mismatch at approval')
      asset.status = 'approved'
      entry.job = transitionPairJob(entry.job, panelIndex === 0 ? 'approve_first' : 'approve_second', assetId)
      snapshot.approvedPanels.push({id:entry.plan.panels[panelIndex].id,sceneId:entry.plan.panels[panelIndex].sceneId,
        assetId,approvedAt:new Date().toISOString(),planId:pairId})
    })
  }
}