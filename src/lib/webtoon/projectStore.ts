/**
 * Single-host persistent production state. Intended for a mounted Colab drive,
 * not a multi-user public database. Writes are atomic and protected by a
 * per-project filesystem lock. Model output never rewrites canonical masters.
 */
import { mkdir, readFile, writeFile, rename, rm, stat, readdir, realpath } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {CastProposals} from './castPlanner.ts'
import {emptySeries,beginEpisode,registerPair,prepareEpisodeHandoff,completeEpisode,
  type SeriesLedger,type EpisodeCompletion,type EpisodeHandoff} from './seriesLoop.ts'
import type {EpisodeOutline} from './storyOutline.ts'
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
  story?: { premise:string; bible:string; updatedAt:string; version:number }
  bubbleOverrides?: Record<string, Record<string, {text:string;box:[number,number,number,number]}>>
  rejections?: Array<{panelId:string;assetId:string;reason:string;at:string}>
  draftCasting?: CastProposals
  series?: SeriesLedger
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
    let acquired=false
    for(let attempt=0;attempt<3&&!acquired;attempt++){
      try{
        await mkdir(lockDir)
        acquired=true
        await writeFile(join(lockDir,'owner.json'),JSON.stringify({
          pid:process.pid,started:Date.now()
        }),{flag:'wx'})
      }catch(e){
        if(acquired){
          await rm(lockDir,{recursive:true,force:true})
          throw e
        }
        if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e
        const info=await stat(lockDir).catch(()=>null)
        if(!info)continue
        let pid=0
        try{pid=Number(JSON.parse(await readFile(join(lockDir,'owner.json'),'utf8')).pid)}
        catch{}
        let running=false
        if(Number.isInteger(pid)&&pid>1){
          try{process.kill(pid,0);running=true}
          catch(error){running=(error as NodeJS.ErrnoException).code==='EPERM'}
        }
        if(running||Date.now()-info.mtimeMs<15_000)
          throw new Error('Project is locked by another active writer')
        // Rename stale lock before removal so a newly acquired lock is not removed.
        const abandoned=lockDir+'.abandoned-'+randomUUID()
        try{
          await rename(lockDir,abandoned)
          await rm(abandoned,{recursive:true,force:true})
        }catch(error){
          if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
        }
      }
    }
    if(!acquired)throw new Error('Unable to recover project write lock')
    try{return await action()}
    finally{await rm(lockDir,{recursive:true,force:true})}
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
      const snapshot: ProjectSnapshot = { schemaVersion: 1, revision: 0, projectId, catalog: structuredClone(catalog), pairs: [], approvedPanels: [], series: emptySeries() }
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
      // New series mode requires a registered episode. Old projects created before
      // the series ledger existed retain their legacy pair recording behavior.
      if(snapshot.series?.episodes.length)registerPair(snapshot.series,plan)
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


  /** Add an episode only after the preceding episode has been explicitly finalized. */
  async beginEpisode(projectId:string,revision:number,input:{
    episodeId:string;targetPairs:number;startState:import('./contracts.ts').SceneState;
    outline?:EpisodeOutline
  }):Promise<ProjectSnapshot>{
    return this.modify(projectId,revision,snapshot=>{
      snapshot.series ||= emptySeries()
      const existing=snapshot.series.episodes.find(x=>x.id===input.episodeId)
      if(existing){
        if(existing.status!=='producing'||existing.targetPairs!==input.targetPairs||
           JSON.stringify(existing.startState)!==JSON.stringify(input.startState))
          throw Error('Existing episode does not match the requested opening')
        return
      }
      if(snapshot.pairs.length && !snapshot.series.episodes.length)
        throw Error('Legacy panels must be migrated before starting a new series episode')
      beginEpisode(snapshot.series,{id:input.episodeId,targetPairs:input.targetPairs,
        startState:input.startState,...(input.outline?{outline:input.outline}:{})})
    })
  }

  /** Completion is atomic: only all-approved, ordered panels may become an episode. */
  async finalizeEpisode(projectId:string,revision:number,episodeId:string,
    input:EpisodeCompletion):Promise<ProjectSnapshot>{
    return this.modify(projectId,revision,snapshot=>{
      if(!snapshot.series)throw Error('No episode ledger')
      const handoff=prepareEpisodeHandoff(snapshot.series,episodeId,snapshot.pairs,
        new Set(snapshot.approvedPanels.map(p=>p.id)),input,
        new Set(snapshot.catalog.characters.map(c=>c.id)))
      completeEpisode(snapshot.series,episodeId,handoff,input)
    })
  }

  /** A one-time, explicit upgrade for projects created before per-episode records. */
  async migrateLegacySeries(projectId:string,revision:number):Promise<ProjectSnapshot>{
    return this.modify(projectId,revision,snapshot=>{
      snapshot.series ||= emptySeries()
      if(snapshot.series.episodes.length)throw Error('Project is already in series mode')
      if(!snapshot.pairs.length)return
      const groups:Array<typeof snapshot.pairs>=[]
      for(const item of snapshot.pairs){
        let last=groups.at(-1)
        if(!last||last[0].plan.episodeId!==item.plan.episodeId){
          last=[];groups.push(last)
        }
        last.push(item)
      }
      for(const group of groups){
        if(!group.every(x=>x.job.status==='approved'))
          throw Error('All legacy panels must be approved before series migration')
        const first=group[0].plan,last=group.at(-1)!.plan
        const ending=last.panels[1]
        const lastDialogue=ending.bubbles.map(b=>b.text).join(' / ').slice(0,1200)
        const handoff:EpisodeHandoff={
          summary:group.flatMap(p=>p.plan.panels.map(q=>q.summary)).join(' / ').slice(0,6000),
          endingHook:ending.summary.slice(0,1200),
          lastDialogue,
          finalState:structuredClone(last.after),
          unresolvedThreadIds:[],completedAt:new Date().toISOString()
        }
        snapshot.series.episodes.push({
          id:first.episodeId,ordinal:snapshot.series.episodes.length+1,status:'completed',
          targetPairs:group.length,pairIds:group.map(x=>x.plan.id),startState:structuredClone(first.before),
          createdAt:new Date().toISOString(),handoff
        })
      }
    })
  }
  async listProjects(){
    await mkdir(this.root,{recursive:true})
    const result:Array<{projectId:string;revision:number;characters:number;pairs:number}>=[]
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!validId(entry.name))continue
      try{
        const item=await this.readRaw(entry.name)
        result.push({projectId:entry.name,revision:item.revision,characters:item.catalog.characters.length,pairs:item.pairs.length})
      }catch{}
    }
    return result.sort((a,b)=>a.projectId.localeCompare(b.projectId))
  }
  private async verifiedAsset(projectId:string,asset:ReferenceAsset):Promise<Buffer>{
    if(!/^[a-f\d]{64}$/i.test(asset.sha256)||!/^(assets|refs)\/[a-f\d]{64}\.(png|jpg|webp)$/.test(asset.uri))
      throw new Error('Invalid asset path or digest')
    const root=await realpath(this.dir(projectId))
    const file=await realpath(join(root,asset.uri))
    if(!file.startsWith(root+sep))throw new Error('Asset path escape')
    const bytes=await readFile(file)
    if(hash(bytes)!==asset.sha256.toLowerCase())throw new Error('Asset file checksum mismatch')
    return bytes
  }
  async readAsset(projectId:string,assetId:string){
    assertId(assetId)
    const asset=(await this.read(projectId)).catalog.assets.find(a=>a.id===assetId)
    if(!asset)throw new Error('Unknown image asset')
    const bytes=await this.verifiedAsset(projectId,asset)
    return{asset,bytes,mime:asset.uri.endsWith('.png')?'image/png':asset.uri.endsWith('.jpg')?'image/jpeg':'image/webp'}
  }
  async stageMaster(projectId:string,rev:number,input:{
    ownerId:string;kind:'identity'|'location'|'outfit'|'view';image:Buffer;
    mime:'image/png'|'image/jpeg'|'image/webp';outfitId?:string;
    view?:import('./contracts.ts').Facing
  }):Promise<ProjectSnapshot>{
    assertId(input.ownerId)
    if(input.outfitId)assertId(input.outfitId)
    if(!['identity','location','outfit','view'].includes(input.kind))throw new Error('Unsupported master kind')
    const bytes=input.image
    if(bytes.length<16||bytes.length>20*1024*1024)throw new Error('Invalid master image size')
    const magic=input.mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      input.mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216:
      input.mime==='image/webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':false
    if(!magic)throw new Error('Wrong master image format')
    const ext=input.mime==='image/png'?'png':input.mime==='image/jpeg'?'jpg':'webp'
    const sha=hash(bytes)
    const id='master_'+createHash('sha256').update(input.ownerId+input.kind+sha).digest('hex').slice(0,40)
    return this.modify(projectId,rev,async snapshot=>{
      if(snapshot.catalog.assets.some(a=>a.id===id))throw new Error('Master draft already exists')
      if(input.kind==='identity'&&snapshot.catalog.characters.some(c=>c.id===input.ownerId))
        throw new Error('Cannot overwrite approved character identity')
      if(input.kind==='location'&&snapshot.catalog.locations.some(l=>l.id===input.ownerId))
        throw new Error('Cannot overwrite approved location')
      const character=snapshot.catalog.characters.find(c=>c.id===input.ownerId)
      if((input.kind==='outfit'||input.kind==='view')&&!character)throw new Error('Unknown character')
      const dir=join(this.dir(projectId),'refs')
      await mkdir(dir,{recursive:true})
      const file=join(dir,sha+'.'+ext)
      try{await writeFile(file,bytes,{flag:'wx'})}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
      if(hash(await readFile(file))!==sha)throw new Error('Master checksum mismatch')
      snapshot.catalog.assets.push({id,kind:input.kind,ownerId:input.ownerId,uri:'refs/'+sha+'.'+ext,
        status:'draft',version:character?.version||1,sha256:sha,
        ...(input.outfitId?{outfitId:input.outfitId}:{}),...(input.view?{view:input.view}:{})})
    })
  }
  async approveCharacter(projectId:string,rev:number,assetId:string,input:{
    id:string;displayName:string;description:string;outfitId:string
  }):Promise<ProjectSnapshot>{
    assertId(input.id);assertId(input.outfitId)
    if(!input.displayName.trim()||!input.description.trim())throw new Error('Character fields missing')
    return this.modify(projectId,rev,async snapshot=>{
      if(snapshot.catalog.characters.some(c=>c.id===input.id))throw new Error('Character already registered')
      const asset=snapshot.catalog.assets.find(a=>a.id===assetId)
      if(!asset||asset.status!=='draft'||asset.kind!=='identity'||asset.ownerId!==input.id||asset.version!==1)
        throw new Error('An exact draft identity is required')
      await this.verifiedAsset(projectId,asset)
      asset.status='approved'
      snapshot.catalog.characters.push({id:input.id,version:1,displayName:input.displayName.trim(),
        description:input.description.trim(),outfitIds:[input.outfitId],identityReferenceId:asset.id})
    })
  }
  async approveLocation(projectId:string,rev:number,assetId:string,input:{id:string;description:string}):Promise<ProjectSnapshot>{
    assertId(input.id)
    if(!input.description.trim())throw new Error('Location description required')
    return this.modify(projectId,rev,async snapshot=>{
      if(snapshot.catalog.locations.some(l=>l.id===input.id))throw new Error('Location already registered')
      const asset=snapshot.catalog.assets.find(a=>a.id===assetId)
      if(!asset||asset.status!=='draft'||asset.kind!=='location'||asset.ownerId!==input.id||asset.version!==1)
        throw new Error('An exact draft location is required')
      await this.verifiedAsset(projectId,asset)
      asset.status='approved'
      snapshot.catalog.locations.push({id:input.id,version:1,description:input.description.trim(),referenceIds:[asset.id]})
    })
  }
  async approveSupplementalReference(projectId:string,rev:number,assetId:string):Promise<ProjectSnapshot>{
    return this.modify(projectId,rev,async snapshot=>{
      const asset=snapshot.catalog.assets.find(a=>a.id===assetId)
      if(!asset||asset.status!=='draft'||!['view','outfit'].includes(asset.kind))throw new Error('Draft view/outfit required')
      const character=snapshot.catalog.characters.find(c=>c.id===asset.ownerId)
      if(!character||character.version!==asset.version)throw new Error('Invalid character version')
      if(asset.kind==='outfit'&&!character.outfitIds.includes(asset.outfitId||''))throw new Error('Unknown outfit')
      await this.verifiedAsset(projectId,asset)
      asset.status='approved'
    })
  }
  async setBubble(projectId:string,rev:number,panelId:string,bubbleId:string,text:string,
    box:[number,number,number,number]):Promise<ProjectSnapshot>{
    assertId(panelId);assertId(bubbleId)
    if(!text.trim()||text.length>1200)throw new Error('Invalid dialogue')
    if(!Array.isArray(box)||box.length!==4||box.some(n=>!Number.isFinite(n))||
      box[0]<0||box[1]<0||box[2]<=0||box[3]<=0||box[0]+box[2]>1||box[1]+box[3]>1)
      throw new Error('Bubble bounds invalid')
    return this.modify(projectId,rev,snapshot=>{
      const panel=snapshot.pairs.flatMap(p=>p.plan.panels).find(p=>p.id===panelId)
      if(!panel||!panel.bubbles.some(b=>b.id===bubbleId))throw new Error('Unknown bubble')
      snapshot.bubbleOverrides ||= {}
      snapshot.bubbleOverrides[panelId] ||= {}
      snapshot.bubbleOverrides[panelId][bubbleId]={text,box}
    })
  }


  async rejectPanel(projectId:string,rev:number,pairId:string,panelIndex:0|1,assetId:string,reason:string):Promise<ProjectSnapshot>{
    if(!reason.trim()||reason.length>1200)throw Error('Rejection reason is required')
    return this.modify(projectId,rev,snapshot=>{
      const pair=snapshot.pairs.find(p=>p.plan.id===pairId)
      if(!pair)throw Error('Unknown pair')
      const status=panelIndex===0?'review_first':'review_second'
      if(pair.job.status!==status)throw Error('Cannot reject in this pair state')
      const panel=pair.plan.panels[panelIndex]
      const asset=snapshot.catalog.assets.find(a=>a.id===assetId)
      if(!asset||asset.ownerId!==panel.id||asset.kind!=='previous-panel'||asset.status!=='draft')
        throw Error('Cannot reject an unmatching or approved image')
      asset.status='rejected'
      pair.job=transitionPairJob(pair.job,panelIndex===0?'retry_first':'retry_second')
      snapshot.rejections ||= []
      snapshot.rejections.push({panelId:panel.id,assetId,reason:reason.trim(),at:new Date().toISOString()})
    })
  }


  async saveCasting(projectId:string,revision:number,proposals:CastProposals):Promise<ProjectSnapshot>{
    if(proposals.characters.length<1||proposals.locations.length<1||
       proposals.characters.length>8||proposals.locations.length>8)
      throw new Error('Invalid casting proposal count')
    return this.modify(projectId,revision,snapshot=>{
      // Casting drafts never mutate approved canonical identity/locations.
      snapshot.draftCasting=structuredClone(proposals)
    })
  }

  /** Persist author intent independently of generated visual artifacts. */
  async updateStory(projectId:string,revision:number,premise:string,bible:string):Promise<ProjectSnapshot>{
    if(!premise.trim()||premise.length>5000||bible.length>15000)
      throw new Error('Story premise/bible length invalid')
    return this.modify(projectId,revision,snapshot=>{
      const version=(snapshot.story?.version||0)+1
      snapshot.story={premise:premise.trim(),bible:bible.trim(),
        updatedAt:new Date().toISOString(),version}
    })
  }

}