import 'server-only'

import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ProjectStore, type ProjectSnapshot} from './projectStore'
import type {SceneState,PairPlan} from './contracts'
import {generatePairPlan} from './pairPlanner'
import {predict} from '@/app/queries/predict'
import {renderQueuedPanel} from '@/app/engine/renderQueuedPanel'
import {pollComfyUI,submitComfyUI} from '@/app/engine/comfyui'

const store=new ProjectStore()
const safeId=(x:string):string=>{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x))throw new Error('Unsafe ID')
  return x
}
const root=()=>resolve(process.env.WEBTOON_DATA_DIR||join(process.cwd(),'webtoon-data'))
const taskPath=(projectId:string,pairId:string,panelIndex:0|1)=>
  join(root(),safeId(projectId),'tasks',safeId(pairId)+'_'+panelIndex+'.json')
type Task={promptId:string;pairId:string;panelIndex:0|1;createdAt:string}
async function getTask(projectId:string,pairId:string,panelIndex:0|1):Promise<Task|null>{
  try{return JSON.parse(await readFile(taskPath(projectId,pairId,panelIndex),'utf8')) as Task}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
}
async function saveTask(projectId:string,task:Task):Promise<void>{
  const file=taskPath(projectId,task.pairId,task.panelIndex)
  await mkdir(join(root(),safeId(projectId),'tasks'),{recursive:true})
  // Exclusive write prevents one user from clobbering another user's pending render.
  await writeFile(file,JSON.stringify(task,null,2),{flag:'wx'})
}

export async function createWebtoonProject(projectId:string):Promise<ProjectSnapshot>{
  return store.create(safeId(projectId),{characters:[],locations:[],assets:[]})
}
export async function listWebtoonProjects(){return store.listProjects()}
export async function webtoonSnapshot(projectId:string){return store.read(projectId)}
export async function stageWebtoonMaster(projectId:string,revision:number,ownerId:string,
  kind:'identity'|'location'|'view'|'outfit',dataUri:string,outfitId?:string){
  if(dataUri.length>28_000_000)throw new Error('Image exceeds upload limit')
  const match=/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri)
  if(!match)throw new Error('Expected a PNG, JPEG or WebP data URI')
  return store.stageMaster(projectId,revision,{ownerId,kind,mime:match[1] as 'image/png'|'image/jpeg'|'image/webp',
    image:Buffer.from(match[2],'base64'),...(outfitId?{outfitId}:{})})
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
  const initial:SceneState={sceneId:'scene1',locationId:location.id,timeKey:'initial',
    actors:snapshot.catalog.characters.slice(0,2).map((c,i)=>({
      characterId:c.id,outfitId:c.outfitIds[0],
      box:[i===0?0.08:0.54,0.23,0.36,0.67],
      facing:i===0?'right':'left',emotion:'neutral',heldPropIds:[]
    }))}
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
  if(existing)return{promptId:existing.promptId,status:'pending'}
  const scene=await renderQueuedPanel({projectId,pairId,panelIndex,width,height})
  if(scene.status!=='pending'||!scene.renderId)throw new Error('ComfyUI did not queue this render')
  await saveTask(projectId,{promptId:scene.renderId,pairId,panelIndex,createdAt:new Date().toISOString()})
  return{promptId:scene.renderId,status:'pending'}
}
export async function pollWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1){
  const task=await getTask(projectId,pairId,panelIndex)
  if(!task)throw new Error('No recorded ComfyUI job')
  let snapshot=await store.read(projectId)
  const record=snapshot.pairs.find(p=>p.plan.id===pairId)
  if(!record)throw new Error('Unknown pair')
  const review=panelIndex===0?'review_first':'review_second'
  if(record.job.status===review)return{status:'review',snapshot}
  const expected=panelIndex===0?'rendering_first':'rendering_second'
  if(record.job.status!==expected)throw new Error('Unexpected pair state '+record.job.status)
  const result=await pollComfyUI(task.promptId)
  if(result.status!=='completed')return{status:result.status,error:result.error}
  const match=/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(result.assetUrl)
  if(!match)throw new Error('ComfyUI returned an unsupported image')
  const bytes=Buffer.from(match[2],'base64')
  snapshot=await store.advancePair(projectId,snapshot.revision,pairId,panelIndex===0?'review_first':'review_second')
  snapshot=await store.stageImage(projectId,snapshot.revision,pairId,panelIndex,bytes,
    match[1] as 'image/png'|'image/jpeg'|'image/webp')
  return{status:'review',snapshot}
}
export async function approveWebtoonPanel(projectId:string,pairId:string,panelIndex:0|1,assetId:string,reviewer:string){
  const snapshot=await store.read(projectId)
  return store.approvePanel(projectId,snapshot.revision,pairId,panelIndex,assetId,reviewer)
}
export async function editWebtoonBubble(projectId:string,panelId:string,bubbleId:string,text:string,
  box:[number,number,number,number]){
  const snapshot=await store.read(projectId)
  return store.setBubble(projectId,snapshot.revision,panelId,bubbleId,text,box)
}
export async function webtoonAsset(projectId:string,assetId:string){return store.readAsset(projectId,assetId)}
