import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {ProjectStore} from './projectStore.ts'
import {generatePairPlan,type PairPlannerInput,type PlannerMessages} from './pairPlanner.ts'
import type {PairPlan,SceneState,WebtoonCatalog} from './contracts.ts'

const id=(s:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(s))throw Error('Invalid identifier');return s}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const masterHash=(catalog:WebtoonCatalog)=>hash({characters:catalog.characters,locations:catalog.locations,assets:catalog.assets.filter(a=>a.kind!=='previous-panel')})
const root=()=>resolve(process.env.WEBTOON_DATA_DIR||join(process.cwd(),'webtoon-data'))
const path=(projectId:string,episodeId:string)=>join(root(),id(projectId),'drafts',id(episodeId)+'.json')
export interface EpisodeDrafts {
  projectId:string;episodeId:string;catalogHash:string;storyGoal:string;storyBible:string
  cursor:number;plans:PairPlan[];updatedAt:string
}
async function save(file:string,record:EpisodeDrafts){
  await mkdir(dirname(file),{recursive:true})
  const temp=file+'.'+randomUUID()+'.tmp'
  try{await writeFile(temp,JSON.stringify(record,null,2),{flag:'wx'});await rename(temp,file)}
  finally{await rm(temp,{force:true})}
}
export async function readEpisodeDrafts(projectId:string,episodeId:string):Promise<EpisodeDrafts|null>{
  try{return JSON.parse(await readFile(path(projectId,episodeId),'utf8')) as EpisodeDrafts}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
}
export function initialScene(catalog:WebtoonCatalog,locationId?:string):SceneState {
  const location=catalog.locations.find(l=>l.id===(locationId||catalog.locations[0]?.id))
  if(!location)throw Error('Approved location required')
  if(!catalog.characters.length)throw Error('Approved character required')
  return{sceneId:'scene1',locationId:location.id,timeKey:'initial',actors:
    catalog.characters.slice(0,2).map((actor,i)=>({characterId:actor.id,outfitId:actor.outfitIds[0],
      box:[i===0?0.08:0.54,0.23,0.36,0.67] as [number,number,number,number],
      facing:(i===0?'right':'left') as 'right'|'left',heldPropIds:[],emotion:'neutral'}))}
}
export async function generateEpisodeDrafts(input:{projectId:string;episodeId:string;storyGoal:string;
    storyBible:string;pairCount:number;locationId?:string},llm:(messages:PlannerMessages)=>Promise<string>,
    store=new ProjectStore()):Promise<EpisodeDrafts>{
  const {projectId,episodeId,storyGoal,storyBible}=input
  id(projectId);id(episodeId)
  if(!Number.isInteger(input.pairCount)||input.pairCount<1||input.pairCount>50)throw Error('Invalid pair count')
  if(!storyGoal.trim()||storyGoal.length>5000||storyBible.length>15000)throw Error('Invalid episode story')
  const snapshot=await store.read(projectId)
  const catalogHash=masterHash(snapshot.catalog)
  const file=path(projectId,episodeId)
  let draft=await readEpisodeDrafts(projectId,episodeId)
  if(draft){
    if(draft.catalogHash!==catalogHash||draft.storyGoal!==storyGoal||draft.storyBible!==storyBible||
       draft.plans.length>input.pairCount)throw Error('Existing draft conflicts with requested episode')
  }else{
    draft={projectId,episodeId,catalogHash,storyGoal,storyBible,cursor:0,plans:[],updatedAt:new Date().toISOString()}
    await save(file,draft)
  }
  for(let i=draft.plans.length;i<input.pairCount;i++){
    const last=draft.plans.at(-1)||snapshot.pairs.at(-1)?.plan
    const before=last?.after||initialScene(snapshot.catalog,input.locationId)
    const pairId='pair'+String(snapshot.pairs.length+i+1).padStart(5,'0')
    const plannerInput:PairPlannerInput={pairId,episodeId,storyGoal,storyBibleSummary:storyBible,
      approvedHistorySummary:draft.plans.slice(-6).map(p=>p.panels.map(q=>q.summary).join(' / ')).join('\n'),
      before,catalog:snapshot.catalog}
    const plan=await generatePairPlan(plannerInput,llm)
    draft.plans.push(plan)
    draft.updatedAt=new Date().toISOString()
    await save(file,draft)
  }
  return draft
}
export async function activateNextEpisodeDraft(projectId:string,episodeId:string,store=new ProjectStore()){
  const draft=await readEpisodeDrafts(projectId,episodeId)
  if(!draft)throw Error('No saved episode plan')
  const snapshot=await store.read(projectId)
  if(masterHash(snapshot.catalog)!==draft.catalogHash)throw Error('Masters changed since episode planning')
  const last=snapshot.pairs.at(-1)
  if(last&&last.job.status!=='approved')throw Error('Previous pair must be approved first')
  let cursor=draft.cursor
  while(cursor<draft.plans.length&&snapshot.pairs.some(p=>p.plan.id===draft.plans[cursor].id))cursor++
  if(cursor>=draft.plans.length)return {snapshot,remaining:0}
  const plan=draft.plans[cursor]
  if(last&&JSON.stringify(last.plan.after)!==JSON.stringify(plan.before))throw Error('Approved scene diverged from planned continuation')
  const updated=await store.appendPair(projectId,snapshot.revision,plan)
  draft.cursor=cursor+1
  draft.updatedAt=new Date().toISOString()
  await save(path(projectId,episodeId),draft)
  return{snapshot:updated,remaining:draft.plans.length-draft.cursor}
}
