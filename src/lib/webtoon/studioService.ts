import 'server-only'

import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises'
import sharp from 'sharp'
import {inspectLayout} from './panelQA'
import {episodePairId, nextEpisodeId, type EpisodeCompletion} from './seriesLoop'
import {seriesNarrativeContext} from './seriesNarrative'
import {uploadSelectedReferences} from './comfyReference'
import {makeActorMask,uploadActorMask} from './regionMasks'
import type {PanelPlan,SelectedReference} from './contracts'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ProjectStore, type ProjectSnapshot} from './projectStore'
import type {PairPlan} from './contracts'
import {generatePairPlan} from './pairPlanner'
import {predict} from '@/app/queries/predict'
import {renderQueuedPanel} from '@/app/engine/renderQueuedPanel'
import {pollComfyUI,submitComfyUI} from '@/app/engine/comfyui'
import {generateEpisodeDrafts,activateNextEpisodeDraft,readEpisodeDrafts,initialScene,
  saveEpisodeOutline,withSeriesPlanningLock,ensureNoOtherDraft} from './episodeDrafts'
import {proposeCast} from './castPlanner'
import {designEpisodeOutline} from './storyOutline'

const store=new ProjectStore()
const safeId=(x:string):string=>{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x))throw new Error('Unsafe ID')
  return x
}
const root=()=>resolve(process.env.WEBTOON_DATA_DIR||join(process.cwd(),'webtoon-data'))
const taskPath=(projectId:string,pairId:string,panelIndex:0|1)=>
  join(root(),safeId(projectId),'tasks',safeId(pairId)+'_'+panelIndex+'.json')
type Task={promptId:string;pairId:string;panelIndex:0|1;createdAt:string;
  status:'submitting'|'pending'|'failed';attempt:number;width:number;height:number;error?:string;
  renderMeta?: {seed:number|null;workflowSha256:string;checkpoint:string;styleLoRA:string}}
async function getTask(projectId:string,pairId:string,panelIndex:0|1):Promise<Task|null>{
  try{return JSON.parse(await readFile(taskPath(projectId,pairId,panelIndex),'utf8')) as Task}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
}
async function saveTask(projectId:string,task:Task,replace=false):Promise<void>{
  const file=taskPath(projectId,task.pairId,task.panelIndex)
  await mkdir(join(root(),safeId(projectId),'tasks'),{recursive:true})
  if(!replace){
    await writeFile(file,JSON.stringify(task,null,2),{flag:'wx'})
    return
  }
  const temp=file+'.'+randomUUID()+'.tmp'
  await writeFile(temp,JSON.stringify(task,null,2),{flag:'wx'})
  await rename(temp,file)
}


/** File-system lease: two requests cannot submit the same pair/panel concurrently. */
async function withRenderTaskLock<T>(projectId:string,pairId:string,panelIndex:0|1,fn:()=>Promise<T>):Promise<T>{
  const folder=join(root(),safeId(projectId),'tasks')
  await mkdir(folder,{recursive:true})
  const lock=join(folder,safeId(pairId)+'_'+panelIndex+'.lock')
  let acquired=false
  for(let attempt=0;attempt<3&&!acquired;attempt++){
    try{
      await mkdir(lock)
      acquired=true
      await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'})
    }catch(e){
      if(acquired){await rm(lock,{recursive:true,force:true});throw e}
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e
      const info=await stat(lock).catch(()=>null)
      if(!info)continue
      let pid=0
      try{pid=Number(JSON.parse(await readFile(join(lock,'owner.json'),'utf8')).pid)}catch{}
      let alive=false
      if(Number.isInteger(pid)&&pid>1){
        try{process.kill(pid,0);alive=true}
        catch(error){alive=(error as NodeJS.ErrnoException).code==='EPERM'}
      }
      if(alive||Date.now()-info.mtimeMs<15_000)
        throw new Error('A render submission for this panel is already in progress')
      const stale=lock+'.abandoned-'+randomUUID()
      try{await rename(lock,stale);await rm(stale,{recursive:true,force:true})}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    }
  }
  if(!acquired)throw new Error('Unable to acquire render task lock')
  try{return await fn()}
  finally{await rm(lock,{recursive:true,force:true})}
}

export async function createWebtoonProject(projectId:string):Promise<ProjectSnapshot>{
  return store.create(safeId(projectId),{characters:[],locations:[],assets:[]})
}
export async function listWebtoonProjects(){return store.listProjects()}
export async function webtoonSnapshot(projectId:string){return store.read(projectId)}
export async function stageWebtoonMaster(projectId:string,revision:number,ownerId:string,
  kind:'identity'|'location'|'view'|'outfit',dataUri:string,outfitId?:string,view?:'front'|'left'|'right'|'back',promptId?:string){
  if(dataUri.length>28_000_000)throw new Error('Image exceeds upload limit')
  const match=/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri)
  if(!match)throw new Error('Expected a PNG, JPEG or WebP data URI')
  return store.stageMaster(projectId,revision,{ownerId,kind,mime:match[1] as 'image/png'|'image/jpeg'|'image/webp',
    image:Buffer.from(match[2],'base64'),
    ...((kind==='identity'||kind==='outfit')&&outfitId?{outfitId}:{}),
    ...(kind==='view'&&view?{view}:{}),...(promptId?{promptId}:{})})
}
export async function approveWebtoonCharacter(projectId:string,revision:number,assetId:string,
  details:{id:string;displayName:string;description:string;outfitId:string}){
  return store.approveCharacter(projectId,revision,assetId,details)
}
export async function approveWebtoonLocation(projectId:string,revision:number,assetId:string,
  details:{id:string;description:string}){
  return store.approveLocation(projectId,revision,assetId,details)
}
export async function approveWebtoonSupplement(projectId:string,revision:number,assetId:string){
  return store.approveSupplementalReference(projectId,revision,assetId)
}
export async function generateMasterImage(prompt:string,width=768,height=1024,
  kind:'identity'|'location'='identity'){
  if(!prompt.trim()||prompt.length>1600)throw new Error('Master prompt length invalid')
  const instructions=kind==='location'
    ?'empty recurring webtoon location background reference, stable architectural layout, fixed furnishings, lighting and perspective, no characters, no lettering; '
    :'single canonical character identity reference, recognizable face, consistent hairstyle and eye color, neutral pose, no additional characters, no lettering; '
  return submitComfyUI(instructions+prompt,width,height)
}
export async function pollMasterImage(promptId:string){return pollComfyUI(promptId)}
/** A submitted master prompt becomes a recoverable project job before UI polling. */
export async function queueWebtoonMaster(projectId:string,ownerId:string,
  kind:'identity'|'location'|'view'|'outfit',description:string,
  outfitId?:string,view:'front'|'left'|'right'|'back'='front',width=768,height=1024){
  safeId(projectId);safeId(ownerId)
  if(!['identity','location','view','outfit'].includes(kind))throw Error('Invalid master kind')
  const output=(kind==='view'||kind==='outfit')
    ?await generateCharacterReference(projectId,ownerId,kind,description,view,width,height)
    :await generateMasterImage(description,width,height,kind)
  if(!output.renderId||output.status!=='pending')throw Error('ComfyUI master job was not queued')
  const snapshot=await store.read(projectId)
  const recorded=await store.recordMasterJob(projectId,snapshot.revision,{
    promptId:output.renderId,ownerId,kind,description,
    ...((kind==='identity'||kind==='outfit')&&outfitId?{outfitId}:{}),
    ...(kind==='view'?{view}:{})
  })
  return{...output,snapshot:recorded}
}

/** Generate additional views/outfits from immutable approved identity, not free-running txt2img. */
export async function generateCharacterReference(projectId:string,ownerId:string,kind:'view'|'outfit',
  description:string,view:'front'|'left'|'right'|'back'='front',width=768,height=1024){
  safeId(ownerId)
  if(!['view','outfit'].includes(kind)||!['front','left','right','back'].includes(view))
    throw new Error('Invalid character reference request')
  if(!description.trim()||description.length>1600)throw new Error('Character prompt required')
  const snapshot=await store.read(projectId)
  const character=snapshot.catalog.characters.find(c=>c.id===ownerId)
  if(!character)throw new Error('Approved character identity required before generating additional views')
  const master=snapshot.catalog.assets.find(a=>a.id===character.identityReferenceId)
  if(!master||master.status!=='approved')throw new Error('Unapproved character master')
  const selected:SelectedReference[]=[{assetId:master.id,purpose:'identity',characterId:ownerId}]
  const projectRoot=join(root(),safeId(projectId))
  const endpoint=process.env.COMFYUI_API_URL||'http://127.0.0.1:8188'
  const uploaded=await uploadSelectedReferences(projectRoot,snapshot.catalog.assets,selected,endpoint)
  const box:[number,number,number,number]=[0.12,0.07,0.76,0.88]
  const panel:PanelPlan={id:'reference',sceneId:'reference',locationId:'reference',
    summary:description,camera:view,characters:[{
      characterId:ownerId,outfitId:character.outfitIds[0],action:'neutral standing',
      emotion:'neutral',box,facing:view
    }],bubbles:[],events:[]}
  const masks:Record<string,string>={}
  for(const reference of uploaded){
    masks[reference.assetId]=await uploadActorMask(endpoint,await makeActorMask(width,height,box))
  }
  const prompt='same recognizable character as the reference image, '+
    'consistent facial structure, hair and eye colors, '+view+' view, '+
    'character reference illustration, clean line art, no text, '+description
  return submitComfyUI(prompt,width,height,{uploaded,auto:{panel,masks}})
}
export async function planWebtoonPair(projectId:string,storyGoal:string,episodeId='episode1',
  locationId?:string,storyBibleSummary='',targetPairs=10):Promise<ProjectSnapshot>{
  if(!storyGoal.trim()||storyGoal.length>5000)throw new Error('Story goal must be provided')
  safeId(episodeId)
  return withSeriesPlanningLock(projectId,async()=>{
  const snapshot=await store.read(projectId)
  await ensureNoOtherDraft(projectId,episodeId,
    new Set(snapshot.series?.episodes.filter(e=>e.status==='completed').map(e=>e.id)||[]))
  if(snapshot.catalog.characters.length<1)throw new Error('Register at least one character master')
  if(snapshot.catalog.locations.length<1)throw new Error('Register at least one location master')
  const last=snapshot.pairs.at(-1)
  if(last&&last.job.status!=='approved')throw new Error('Finish reviewing the previous pair before planning another')
  const location=snapshot.catalog.locations.find(l=>l.id===(locationId||snapshot.catalog.locations[0].id))
  if(!location)throw new Error('Unknown location')
  const initial=initialScene(snapshot.catalog,location.id)
  const active=snapshot.series?.episodes.find(e=>e.status==='producing')
  if(active&&active.id!==episodeId)throw Error('Finalize the current episode before creating the next')
  if(snapshot.series?.episodes.some(e=>e.id===episodeId&&e.status==='completed'))
    throw Error('This episode is already completed')
  if(await readEpisodeDrafts(projectId,episodeId))
    throw Error('This episode has saved drafts: use the approved draft activation workflow')
  const pairIndex=active?.pairIds.length||0
  const pairId=episodePairId(episodeId,pairIndex+1)
  if(active&&pairIndex>=active.targetPairs)throw Error('Episode already has the planned number of pairs')
  const input={
    pairId,episodeId,storyGoal,storyBibleSummary,
    approvedHistorySummary:('CANONICAL_EPISODE_MEMORY: '+seriesNarrativeContext(snapshot.series)+'\n'+
      snapshot.pairs.slice(-8).map(p=>
        p.plan.panels.map(x=>x.summary+' '+x.bubbles.map(b=>
          snapshot.bubbleOverrides?.[x.id]?.[b.id]?.text??b.text).join(' ')).join(' / ')).join('\n')).slice(0,10000),
    before:last?.plan.after||initial,catalog:snapshot.catalog
  }
  const plan:PairPlan=await generatePairPlan(input,({systemPrompt,userPrompt,maxNewTokens})=>predict({
    systemPrompt,userPrompt,nbMaxNewTokens:maxNewTokens,
    llmVendorConfig:{vendor:'SERVER',apiKey:'',modelId:''}
  }))
  // Beginning the episode and appending its first pair must commit in ONE manifest revision.
  // A failed append cannot leave an empty active episode that blocks future work.
  return store.appendPair(projectId,snapshot.revision,plan,
    active?undefined:{targetPairs,startState:last?.plan.after||initial})
  })
}
export async function startWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,width=768,height=1024){
  if(panelIndex!==0&&panelIndex!==1)throw new Error('Invalid panel index')
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<256||height<256||
    width>2048||height>2048||width%8!==0||height%8!==0)
    throw new Error('Image dimensions must be multiples of 8, between 256 and 2048')
  return withRenderTaskLock(projectId,pairId,panelIndex,async()=>{
    let snapshot=await store.read(projectId)
    const record=snapshot.pairs.find(p=>p.plan.id===pairId)
    if(!record)throw new Error('Unknown pair')
    const expected=panelIndex===0?'rendering_first':'rendering_second'
    const initial=panelIndex===0?'validated':'first_approved'
    if(record.job.status===initial)
      snapshot=await store.advancePair(projectId,snapshot.revision,pairId,panelIndex===0?'render_first':'render_second')
    else if(record.job.status!==expected)throw new Error('Pair cannot render in state '+record.job.status)
    let existing=await getTask(projectId,pairId,panelIndex)
    if(existing?.status==='pending')return {promptId:existing.promptId,status:'pending'}
    if(existing?.status==='submitting'){
      const age=Date.now()-new Date(existing.createdAt).getTime()
      if(Number.isFinite(age)&&age>=0&&age<180_000)
        return{promptId:'',status:'submitting'}
      existing={...existing,status:'failed',error:'Unfinished submission from previous server session'}
      await saveTask(projectId,existing,true)
    }
    if(existing&&existing.attempt>=3)throw new Error('Retry budget exhausted (3 attempts)')
    const reserved:Task={promptId:'',pairId,panelIndex,
      createdAt:new Date().toISOString(),status:'submitting',
      attempt:(existing?.attempt||0)+1,width,height}
    await saveTask(projectId,reserved,!!existing)
    try{
      const scene=await renderQueuedPanel({projectId,pairId,panelIndex,width,height})
      if(scene.status!=='pending'||!scene.renderId)throw new Error('ComfyUI did not queue the render')
      await saveTask(projectId,{...reserved,promptId:scene.renderId,status:'pending',
        ...(scene.renderMeta?{renderMeta:scene.renderMeta}:{})},true)
      return{promptId:scene.renderId,status:'pending'}
    }catch(e){
      await saveTask(projectId,{...reserved,status:'failed',error:String(e)},true)
      throw e
    }
  })
}
/** Explicit recovery when Colab/ComfyUI lost a prompt; never touches approved images. */
export async function resetWebtoonPanelTask(projectId:string,pairId:string,panelIndex:0|1,reason:string){
  if(!reason.trim()||reason.length>600)throw Error('A retry reason is required')
  return withRenderTaskLock(projectId,pairId,panelIndex,async()=>{
    const snapshot=await store.read(projectId)
    const pair=snapshot.pairs.find(p=>p.plan.id===pairId)
    const expected=panelIndex===0?'rendering_first':'rendering_second'
    if(!pair||pair.job.status!==expected)
      throw Error('Only an unapproved rendering job may be reset')
    const task=await getTask(projectId,pairId,panelIndex)
    if(!task)throw Error('No task to reset')
    // The old Comfy job can still finish; its output is intentionally ignored.
    // Keep a forensic record with promptId, attempt, metadata and reset reason.
    const file=taskPath(projectId,pairId,panelIndex)
    const archived=file+'.reset.'+randomUUID()
    await rename(file,archived)
    await writeFile(archived+'.reason.txt',reason.trim(),{flag:'wx'})
    return{status:'reset',pairId,panelIndex,previousPromptId:task.promptId}
  })
}
export async function pollWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1){
  return withRenderTaskLock(projectId,pairId,panelIndex,async()=>{
    const task=await getTask(projectId,pairId,panelIndex)
    if(!task)throw new Error('No recorded ComfyUI job')
    let snapshot=await store.read(projectId)
    const pair=snapshot.pairs.find(p=>p.plan.id===pairId)
    if(!pair)throw new Error('Unknown pair')
    const expected=panelIndex===0?'rendering_first':'rendering_second'
    const review=panelIndex===0?'review_first':'review_second'
    const panelId=pair.plan.panels[panelIndex].id
    if(pair.job.status===review){
      // Legacy interrupted requests can have review status without a staged image.
      // Only return review once there is an actual image to inspect.
      if(snapshot.catalog.assets.some(a=>a.kind==='previous-panel'&&a.ownerId===panelId&&a.status==='draft'))
        return{status:'review',snapshot}
    }else if(pair.job.status!==expected){
      throw new Error('Unexpected pair state '+pair.job.status)
    }
    if(task.status==='submitting')return{status:'submitting'}
    if(task.status==='failed')return{status:'error',error:task.error||'Previous render failed; press restart'}
    if(!task.promptId)throw new Error('Missing ComfyUI prompt ID')
    const result=await pollComfyUI(task.promptId)
    if(result.status==='error'){
      await saveTask(projectId,{...task,status:'failed',error:result.error||'ComfyUI failed'},true)
      return{status:'error',error:result.error}
    }
    if(result.status!=='completed')return{status:result.status,error:result.error}
    const match=/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(result.assetUrl)
    if(!match)throw new Error('ComfyUI returned an unsupported image')
    const bytes=Buffer.from(match[2],'base64')
    const meta=await sharp(bytes).metadata()
    if(meta.width!==task.width||meta.height!==task.height){
      const message='Unexpected output dimensions: '+meta.width+'x'+meta.height
      await saveTask(projectId,{...task,status:'failed',error:message},true)
      return{status:'error',error:message}
    }
    // A single atomic ProjectStore change moves rendering -> review and saves the
    // image record. Retrying after a network drop can no longer strand an empty review.
    snapshot=await store.stageImage(projectId,snapshot.revision,pairId,panelIndex,bytes,
      match[1] as 'image/png'|'image/jpeg'|'image/webp')
    return{status:'review',snapshot}
  })
}
export async function inspectWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,assetId:string){
  const snapshot=await store.read(projectId)
  const pair=snapshot.pairs.find(p=>p.plan.id===pairId)
  if(!pair)throw Error('Unknown pair')
  const panel=pair.plan.panels[panelIndex]
  const asset=snapshot.catalog.assets.find(a=>a.id===assetId)
  if(!asset||asset.kind!=='previous-panel'||asset.ownerId!==panel.id||asset.status!=='draft')
    throw Error('Expected the staged image for this panel')
  const {bytes}=await store.readAsset(projectId,assetId)
  const metadata=await sharp(bytes).metadata()
  const issues=inspectLayout(panel,snapshot.bubbleOverrides?.[panel.id]||{})
  if(!metadata.width||!metadata.height||metadata.width<256||metadata.height<256)
    issues.push({severity:'blocking',code:'IMAGE_DIMENSIONS',message:'그림 해상도가 너무 작음',target:panel.id})
  const stats=await sharp(bytes).stats()
  if(Number.isFinite(stats.entropy)&&stats.entropy<0.08)
    issues.push({severity:'warning',code:'NEAR_BLANK_IMAGE',message:'빈 이미지에 가까움: 육안 검토 필요',target:panel.id})
  return {issues,width:metadata.width,height:metadata.height,
    snapshotRevision:snapshot.revision,manualVisualReviewRequired:true}
}
export async function approveWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,assetId:string,reviewer:string){
  const report=await inspectWebtoonPanel(projectId,pairId,panelIndex,assetId)
  const blocks=report.issues.filter(x=>x.severity==='blocking')
  if(blocks.length)throw Error('QA blocking issues: '+blocks.map(x=>x.code).join(', '))
  const snapshot=await store.read(projectId)
  if(snapshot.revision!==report.snapshotRevision)
    throw new Error('Project changed during visual review; QA must be repeated')
  return store.approvePanel(projectId,snapshot.revision,pairId,panelIndex,assetId,reviewer)
}
export async function rejectWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,assetId:string,reason:string){
  const snapshot=await store.read(projectId)
  const updated=await store.rejectPanel(projectId,snapshot.revision,pairId,panelIndex,assetId,reason)
  const task=await getTask(projectId,pairId,panelIndex)
  if(task){
    const file=taskPath(projectId,pairId,panelIndex)
    await rename(file,file+'.rejected.'+updated.revision)
  }
  return updated
}
export async function editWebtoonBubble(projectId:string,panelId:string,bubbleId:string,text:string,
  box:[number,number,number,number]){
  // A rapid sequence of edits can race with auto-progress/QA revisions.
  // Retry only the optimistic conflict, never validation or immutable-episode errors.
  for(let attempt=0;attempt<3;attempt++){
    const snapshot=await store.read(projectId)
    try{return await store.setBubble(projectId,snapshot.revision,panelId,bubbleId,text,box)}
    catch(error){
      if(!(error instanceof Error)||!error.message.startsWith('Revision conflict')||attempt===2)throw error
    }
  }
  throw new Error('Unable to persist dialogue edits')
}
export async function webtoonAsset(projectId:string,assetId:string){return store.readAsset(projectId,assetId)}

export async function planEntireWebtoonEpisode(projectId:string,episodeId:string,storyGoal:string,storyBible:string,
  pairCount:number,locationId?:string){
  return generateEpisodeDrafts({projectId,episodeId,storyGoal,storyBible,pairCount,locationId},
    ({systemPrompt,userPrompt,maxNewTokens})=>predict({
      systemPrompt,userPrompt,nbMaxNewTokens:maxNewTokens,
      llmVendorConfig:{vendor:'SERVER',apiKey:'',modelId:''}
    }),store)
}
export async function nextPlannedWebtoonPair(projectId:string,episodeId:string){
  return activateNextEpisodeDraft(projectId,episodeId,store)
}
export async function savedWebtoonEpisodeDrafts(projectId:string,episodeId:string){
  return readEpisodeDrafts(projectId,episodeId)
}

export async function planOneWebtoonPairStep(projectId:string,episodeId:string,storyGoal:string,storyBible:string,
  pairCount:number,locationId?:string){
  return generateEpisodeDrafts({projectId,episodeId,storyGoal,storyBible,pairCount,locationId,maxNewPairs:1},
    ({systemPrompt,userPrompt,maxNewTokens})=>predict({
      systemPrompt,userPrompt,nbMaxNewTokens:maxNewTokens,
      llmVendorConfig:{vendor:'SERVER',apiKey:'',modelId:''}
    }),store)
}

/** LLM casting proposal only; no character/location is registered without an approved image. */
export async function suggestWebtoonCast(projectId:string,story:string,bible:string){
  const suggestions=await proposeCast(story,bible,({systemPrompt,userPrompt,maxNewTokens})=>predict({
    systemPrompt,userPrompt,nbMaxNewTokens:maxNewTokens,
    llmVendorConfig:{vendor:'SERVER',apiKey:'',modelId:''}
  }))
  const snapshot=await store.read(projectId)
  // Suggestions are unapproved metadata, never canonical image masters.
  return store.saveCasting(projectId,snapshot.revision,suggestions)
}

export async function saveWebtoonStory(projectId:string,premise:string,bible:string){
  const snapshot=await store.read(projectId)
  return store.updateStory(projectId,snapshot.revision,premise,bible)
}

export async function createWebtoonEpisodeOutline(projectId:string,episodeId:string,premise:string,bible:string){
  const snapshot=await store.read(projectId)
  const carryover=seriesNarrativeContext(snapshot.series)
  const outline=await designEpisodeOutline(episodeId,premise,
    (bible+'\nCANONICAL_PREVIOUS_EPISODE_MEMORY: '+carryover).slice(0,15000),snapshot.catalog,
    ({systemPrompt,userPrompt,maxNewTokens})=>predict({
      systemPrompt,userPrompt,nbMaxNewTokens:maxNewTokens,
      llmVendorConfig:{vendor:'SERVER',apiKey:'',modelId:''}
    }))
  return saveEpisodeOutline(projectId,episodeId,premise,bible,outline,store)
}

/** The final episode is only committed once every planned pair has two approved images. */
export async function finalizeWebtoonEpisode(projectId:string,episodeId:string,
  input:EpisodeCompletion):Promise<ProjectSnapshot>{
  const snapshot=await store.read(projectId)
  return store.finalizeEpisode(projectId,snapshot.revision,episodeId,input)
}
export async function nextWebtoonEpisodeId(projectId:string){
  const snapshot=await store.read(projectId)
  return nextEpisodeId(snapshot.series||{episodes:[],threads:[],relationships:[]})
}
export async function migrateWebtoonLegacyEpisodes(projectId:string){
  const snapshot=await store.read(projectId)
  return store.migrateLegacySeries(projectId,snapshot.revision)
}

export async function acknowledgeWebtoonContinuity(projectId:string,episodeId:string,reviewer:string){
  const snapshot=await store.read(projectId)
  return store.acknowledgeEpisodeContinuity(projectId,snapshot.revision,episodeId,reviewer)
}
