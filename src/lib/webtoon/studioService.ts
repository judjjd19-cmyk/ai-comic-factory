import 'server-only'

import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises'
import sharp from 'sharp'
import {inspectLayout} from './panelQA'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ProjectStore, type ProjectSnapshot} from './projectStore'
import type {PairPlan} from './contracts'
import {generatePairPlan} from './pairPlanner'
import {predict} from '@/app/queries/predict'
import {renderQueuedPanel} from '@/app/engine/renderQueuedPanel'
import {pollComfyUI,submitComfyUI} from '@/app/engine/comfyui'
import {generateEpisodeDrafts,activateNextEpisodeDraft,readEpisodeDrafts,initialScene} from './episodeDrafts'

const store=new ProjectStore()
const safeId=(x:string):string=>{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x))throw new Error('Unsafe ID')
  return x
}
const root=()=>resolve(process.env.WEBTOON_DATA_DIR||join(process.cwd(),'webtoon-data'))
const taskPath=(projectId:string,pairId:string,panelIndex:0|1)=>
  join(root(),safeId(projectId),'tasks',safeId(pairId)+'_'+panelIndex+'.json')
type Task={promptId:string;pairId:string;panelIndex:0|1;createdAt:string;
  status:'pending'|'failed';attempt:number;width:number;height:number;error?:string}
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

export async function createWebtoonProject(projectId:string):Promise<ProjectSnapshot>{
  return store.create(safeId(projectId),{characters:[],locations:[],assets:[]})
}
export async function listWebtoonProjects(){return store.listProjects()}
export async function webtoonSnapshot(projectId:string){return store.read(projectId)}
export async function stageWebtoonMaster(projectId:string,revision:number,ownerId:string,
  kind:'identity'|'location'|'view'|'outfit',dataUri:string,outfitId?:string,view?:'front'|'left'|'right'|'back'){
  if(dataUri.length>28_000_000)throw new Error('Image exceeds upload limit')
  const match=/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri)
  if(!match)throw new Error('Expected a PNG, JPEG or WebP data URI')
  return store.stageMaster(projectId,revision,{ownerId,kind,mime:match[1] as 'image/png'|'image/jpeg'|'image/webp',
    image:Buffer.from(match[2],'base64'),...(outfitId?{outfitId}:{}),...(kind==='view'&&view?{view}:{})})
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
export async function generateMasterImage(prompt:string,width=768,height=1024){
  if(!prompt.trim()||prompt.length>1600)throw new Error('Master prompt length invalid')
  return submitComfyUI('single character design sheet, consistent appearance, no text; '+prompt,width,height)
}
export async function pollMasterImage(promptId:string){return pollComfyUI(promptId)}
export async function planWebtoonPair(projectId:string,storyGoal:string,episodeId='episode1',
  locationId?:string,storyBibleSummary=''):Promise<ProjectSnapshot>{
  if(!storyGoal.trim()||storyGoal.length>5000)throw new Error('Story goal must be provided')
  safeId(episodeId)
  const snapshot=await store.read(projectId)
  if(snapshot.catalog.characters.length<1)throw new Error('Register at least one character master')
  if(snapshot.catalog.locations.length<1)throw new Error('Register at least one location master')
  const last=snapshot.pairs.at(-1)
  if(last&&last.job.status!=='approved')throw new Error('Finish reviewing the previous pair before planning another')
  const location=snapshot.catalog.locations.find(l=>l.id===(locationId||snapshot.catalog.locations[0].id))
  if(!location)throw new Error('Unknown location')
  const initial=initialScene(snapshot.catalog,location.id)
  const pairId='pair'+String(snapshot.pairs.length+1).padStart(5,'0')
  const input={
    pairId,episodeId,storyGoal,storyBibleSummary,
    approvedHistorySummary:snapshot.pairs.slice(-8).map(p=>
      p.plan.panels.map(x=>x.summary+' '+x.bubbles.map(b=>b.text).join(' ')).join(' / ')).join('\n'),
    before:last?.plan.after||initial,catalog:snapshot.catalog
  }
  const plan:PairPlan=await generatePairPlan(input,({systemPrompt,userPrompt,maxNewTokens})=>predict({
    systemPrompt,userPrompt,nbMaxNewTokens:maxNewTokens,
    llmVendorConfig:{vendor:'SERVER',apiKey:'',modelId:''}
  }))
  // Check revision again; no speculative plan may overwrite a concurrently approved pair.
  return store.appendPair(projectId,snapshot.revision,plan)
}
export async function startWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,width=768,height=1024){
  if(panelIndex!==0&&panelIndex!==1)throw new Error('Invalid panel index')
  let snapshot=await store.read(projectId)
  const record=snapshot.pairs.find(p=>p.plan.id===pairId)
  if(!record)throw new Error('Unknown pair')
  const expected=panelIndex===0?'rendering_first':'rendering_second'
  const initial=panelIndex===0?'validated':'first_approved'
  if(record.job.status===initial)
    snapshot=await store.advancePair(projectId,snapshot.revision,pairId,panelIndex===0?'render_first':'render_second')
  else if(record.job.status!==expected)throw new Error('Pair cannot render in state '+record.job.status)
  const existing=await getTask(projectId,pairId,panelIndex)
  if(existing && existing.status!=='failed')return{promptId:existing.promptId,status:'pending'}
  if(existing && existing.attempt>=3)throw new Error('Retry budget exhausted (3 attempts)')
  const scene=await renderQueuedPanel({projectId,pairId,panelIndex,width,height})
  if(scene.status!=='pending'||!scene.renderId)throw new Error('ComfyUI did not queue this render')
  await saveTask(projectId,{promptId:scene.renderId,pairId,panelIndex,createdAt:new Date().toISOString(),
    status:'pending',attempt:(existing?.attempt||0)+1,width,height},!!existing)
  return{promptId:scene.renderId,status:'pending'}
}
export async function pollWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1){
  const task=await getTask(projectId,pairId,panelIndex)
  if(!task)throw new Error('No recorded ComfyUI job')
  if(task.status==='failed')return{status:'error',error:task.error||'Previous render failed; press restart'}
  let snapshot=await store.read(projectId)
  const record=snapshot.pairs.find(p=>p.plan.id===pairId)
  if(!record)throw new Error('Unknown pair')
  const review=panelIndex===0?'review_first':'review_second'
  if(record.job.status===review)return{status:'review',snapshot}
  const expected=panelIndex===0?'rendering_first':'rendering_second'
  if(record.job.status!==expected)throw new Error('Unexpected pair state '+record.job.status)
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
  if(meta.width!==task.width || meta.height!==task.height){
    const message='Unexpected output dimensions: '+meta.width+'x'+meta.height
    await saveTask(projectId,{...task,status:'failed',error:message},true)
    return{status:'error',error:message}
  }
  snapshot=await store.advancePair(projectId,snapshot.revision,pairId,panelIndex===0?'review_first':'review_second')
  snapshot=await store.stageImage(projectId,snapshot.revision,pairId,panelIndex,bytes,
    match[1] as 'image/png'|'image/jpeg'|'image/webp')
  return{status:'review',snapshot}
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
  return {issues,width:metadata.width,height:metadata.height,manualVisualReviewRequired:true}
}
export async function approveWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,assetId:string,reviewer:string){
  const report=await inspectWebtoonPanel(projectId,pairId,panelIndex,assetId)
  const blocks=report.issues.filter(x=>x.severity==='blocking')
  if(blocks.length)throw Error('QA blocking issues: '+blocks.map(x=>x.code).join(', '))
  const snapshot=await store.read(projectId)
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
  const snapshot=await store.read(projectId)
  return store.setBubble(projectId,snapshot.revision,panelId,bubbleId,text,box)
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
