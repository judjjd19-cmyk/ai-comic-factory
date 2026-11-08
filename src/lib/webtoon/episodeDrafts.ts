import {mkdir,readFile,writeFile,rename,rm,stat,readdir} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {ProjectStore} from './projectStore.ts'
import {generatePairPlan,type PairPlannerInput,type PlannerMessages} from './pairPlanner.ts'
import type {PairPlan,SceneState,WebtoonCatalog} from './contracts.ts'
import {type EpisodeOutline,outlineBeatForPair} from './storyOutline.ts'
import {episodePairId} from './seriesLoop.ts'
import {seriesNarrativeContext} from './seriesNarrative.ts'

const id=(s:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(s))throw Error('Invalid identifier');return s}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const masterHash=(catalog:WebtoonCatalog)=>hash({characters:catalog.characters,locations:catalog.locations,assets:catalog.assets.filter(a=>a.kind!=='previous-panel')})
const root=()=>resolve(process.env.WEBTOON_DATA_DIR||join(process.cwd(),'webtoon-data'))
const path=(projectId:string,episodeId:string)=>join(root(),id(projectId),'drafts',id(episodeId)+'.json')
export interface EpisodeDrafts {
  projectId:string;episodeId:string;catalogHash:string;storyGoal:string;storyBible:string
  cursor:number;startIndex:number;targetPairs?:number;plans:PairPlan[];updatedAt:string;outline?:EpisodeOutline
}
async function save(file:string,record:EpisodeDrafts){
  await mkdir(dirname(file),{recursive:true})
  const temp=file+'.'+randomUUID()+'.tmp'
  try{await writeFile(temp,JSON.stringify(record,null,2),{flag:'wx'});await rename(temp,file)}
  finally{await rm(temp,{force:true})}
}
export async function saveEpisodeOutline(projectId:string,episodeId:string,
  storyGoal:string,storyBible:string,outline:EpisodeOutline,store=new ProjectStore()):Promise<EpisodeDrafts>{
  id(projectId);id(episodeId)
  if(outline.episodeId!==episodeId||!storyGoal.trim()||storyGoal.length>5000||storyBible.length>15000)
    throw Error('Invalid episode outline metadata')
  return withDraftLock(path(projectId,episodeId),async()=>{
    const snapshot=await store.read(projectId)
    const file=path(projectId,episodeId)
    const existing=await readEpisodeDrafts(projectId,episodeId)
    if(existing && (existing.storyGoal!==storyGoal||existing.storyBible!==storyBible||
      existing.catalogHash!==masterHash(snapshot.catalog)||existing.plans.length>0))
      throw Error('Cannot replace outline after episode planning started or catalog changed')
    const draft:EpisodeDrafts=existing||{
      projectId,episodeId,storyGoal,storyBible,catalogHash:masterHash(snapshot.catalog),
      cursor:0,startIndex:snapshot.pairs.length,targetPairs:input.pairCount,plans:[],updatedAt:new Date().toISOString()
    }
    draft.outline=outline
    draft.updatedAt=new Date().toISOString()
    await save(file,draft)
    return draft
  })
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
async function withDraftLock<T>(file:string,action:()=>Promise<T>):Promise<T>{
  const lock=file+'.lock'
  await mkdir(dirname(file),{recursive:true})
  for(let retries=0;retries<2;retries++){
    try{
      await mkdir(lock)
      await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}))
      try{return await action()}
      finally{await rm(lock,{recursive:true,force:true})}
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e
      const meta=await stat(lock).catch(()=>null)
      if(!meta)continue
      let pid:number|null=null
      try{pid=JSON.parse(await readFile(join(lock,'owner.json'),'utf8')).pid}
      catch{}
      let alive=false
      if(Number.isInteger(pid)&&Number(pid)>1){
        try{process.kill(pid as number,0);alive=true}
        catch(e){alive=(e as NodeJS.ErrnoException).code==='EPERM'}
      }
      if(alive||Date.now()-meta.mtimeMs<15_000)
        throw new Error('Another episode-planning request is active')
      // Do not remove a newer lock acquired concurrently by someone else.
      try{
        const abandoned=lock+'.abandoned.'+randomUUID()
        await rename(lock,abandoned)
        await rm(abandoned,{recursive:true,force:true})
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
    }
  }
  throw new Error('Could not acquire episode planner lock')
}

async function rejectUnfinishedParallelDrafts(projectId:string,currentEpisodeId:string,
  completedIds:Set<string>):Promise<void>{
  const directory=join(root(),id(projectId),'drafts')
  for(const filename of await readdir(directory).catch(e=>{
    if((e as NodeJS.ErrnoException).code==='ENOENT')return [] as string[]
    throw e
  })){
    if(!filename.endsWith('.json')||filename===id(currentEpisodeId)+'.json')continue
    try{
      const other=JSON.parse(await readFile(join(directory,filename),'utf8')) as EpisodeDrafts
      if(other.episodeId!==currentEpisodeId&&!completedIds.has(other.episodeId)&&
         Array.isArray(other.plans)&&other.plans.length>0)
        throw Error('Complete the earlier drafted episode '+other.episodeId+
          ' before planning '+currentEpisodeId)
    }catch(e){
      if(e instanceof SyntaxError)throw Error('Corrupted existing episode draft '+filename)
      throw e
    }
  }
}
export async function generateEpisodeDrafts(input:{projectId:string;episodeId:string;storyGoal:string;
    storyBible:string;pairCount:number;locationId?:string;maxNewPairs?:number},llm:(messages:PlannerMessages)=>Promise<string>,
    store=new ProjectStore()):Promise<EpisodeDrafts>{
  const {projectId,episodeId,storyGoal,storyBible}=input
  id(projectId);id(episodeId)
  if(!Number.isInteger(input.pairCount)||input.pairCount<1||input.pairCount>250)throw Error('Invalid pair count')
  const step=input.maxNewPairs??Math.min(input.pairCount,50)
  if(!Number.isInteger(step)||step<1||step>50)throw Error('Invalid planning batch size')
  if(!storyGoal.trim()||storyGoal.length>5000||storyBible.length>15000)throw Error('Invalid episode story')
  return withDraftLock(join(root(),id(projectId),'drafts','.series-global-lock-target'),async()=>
    withDraftLock(path(projectId,episodeId),async()=>{
  const snapshot=await store.read(projectId)
  const series=snapshot.series
  const active=series?.episodes.find(e=>e.status==='producing')
  if(active&&active.id!==episodeId)
    throw Error('Complete the active episode before planning the next episode')
  if(series?.episodes.some(e=>e.id===episodeId&&e.status==='completed'))
    throw Error('Completed episodes cannot be regenerated in place')
  await rejectUnfinishedParallelDrafts(projectId,episodeId,
    new Set(series?.episodes.filter(e=>e.status==='completed').map(e=>e.id)||[]))
  const catalogHash=masterHash(snapshot.catalog)
  const file=path(projectId,episodeId)
  let draft=await readEpisodeDrafts(projectId,episodeId)
  if(draft){
    if(draft.catalogHash!==catalogHash||draft.storyGoal!==storyGoal||draft.storyBible!==storyBible||
       draft.plans.length>input.pairCount||
       (draft.targetPairs!==undefined&&draft.targetPairs!==input.pairCount))
      throw Error('Existing draft conflicts with requested episode or pair count')
    if(!draft.targetPairs&&draft.plans.length)
      throw Error('Legacy planned pairs need explicit migration before new series generation')
    draft.targetPairs=input.pairCount
  }else{
    draft={projectId,episodeId,catalogHash,storyGoal,storyBible,cursor:0,startIndex:snapshot.pairs.length,targetPairs:input.pairCount,plans:[],updatedAt:new Date().toISOString()}
    await save(file,draft)
  }
  const target=Math.min(input.pairCount,draft.plans.length+step)
  for(let i=draft.plans.length;i<target;i++){
    const last=draft.plans.at(-1)
    const lastEpisode=snapshot.series?.episodes.at(-1)
    const previousFinal=lastEpisode?.id!==episodeId?lastEpisode?.handoff?.finalState:undefined
    const before=last?.after||previousFinal||
      (active?.id===episodeId?active.startState:undefined)||
      (snapshot.pairs.length?snapshot.pairs.at(-1)!.plan.after:undefined)||
      initialScene(snapshot.catalog,input.locationId)
    const pairId=episodePairId(episodeId,i+1)
    const beat=draft.outline?outlineBeatForPair(draft.outline,i,input.pairCount):null
    const direction=beat?'\nCURRENT_EPISODE_BEAT: '+JSON.stringify(beat)+
      '\nFULL_EPISODE_ARC: '+draft.outline!.beats.map(b=>b.stage+'='+b.event).join(' | ').slice(0,2500)+
      '\nEPISODE_THEME: '+draft.outline!.theme+'; STAKES: '+draft.outline!.stakes:''
    const seriesMemory=seriesNarrativeContext(snapshot.series)
    const plannerInput:PairPlannerInput={pairId,episodeId,storyGoal,
      storyBibleSummary:(storyBible+direction).slice(0,15000),
      approvedHistorySummary:('CANONICAL_PREVIOUS_EPISODES: '+seriesMemory+'\n'+
        draft.plans.slice(-6).map(p=>p.panels.map(q=>q.summary).join(' / ')).join('\n')).slice(0,10000),
      before,catalog:snapshot.catalog}
    const plan=await generatePairPlan(plannerInput,llm)
    draft.plans.push(plan)
    draft.updatedAt=new Date().toISOString()
    await save(file,draft)
  }
  return draft
    }))
}
/** Activate exactly one saved pair; first activation records the entire episode lifecycle. */
export async function activateNextEpisodeDraft(projectId:string,episodeId:string,store=new ProjectStore()){
  id(projectId);id(episodeId)
  return withDraftLock(join(root(),id(projectId),'drafts','.series-global-lock-target'),async()=>
    withDraftLock(path(projectId,episodeId),async()=>{
    const draft=await readEpisodeDrafts(projectId,episodeId)
    if(!draft)throw Error('No saved episode plan')
    if(!draft.targetPairs||draft.plans.length!==draft.targetPairs)
      throw Error('All planned two-panel pairs must be saved before starting image production')
    let snapshot=await store.read(projectId)
    if(masterHash(snapshot.catalog)!==draft.catalogHash)throw Error('Masters changed since episode planning')
    const existing=snapshot.series?.episodes.find(x=>x.id===episodeId)
    if(existing?.status==='completed')throw Error('Episode was already finalized')
    if(!existing){
      const predecessor=snapshot.series?.episodes.at(-1)
      if(predecessor&&predecessor.status!=='completed')
        throw Error('Finish the preceding episode before activating the next')
      snapshot=await store.beginEpisode(projectId,snapshot.revision,{
        episodeId,targetPairs:draft.targetPairs,startState:draft.plans[0].before,
        ...(draft.outline?{outline:draft.outline}:{})
      })
    }
    const current=snapshot.series?.episodes.find(x=>x.id===episodeId)
    if(!current||current.targetPairs!==draft.targetPairs)throw Error('Episode record mismatch')
    let cursor=draft.cursor
    while(cursor<draft.plans.length&&current.pairIds.includes(draft.plans[cursor].id))cursor++
    if(cursor>=draft.plans.length){
      if(draft.cursor!==cursor){
        draft.cursor=cursor;draft.updatedAt=new Date().toISOString()
        await save(path(projectId,episodeId),draft)
      }
      return{snapshot,remaining:0}
    }
    const previous=snapshot.pairs.at(-1)
    if(previous&&previous.job.status!=='approved')
      throw Error('Previous two-panel pair needs both approved images')
    const plan=draft.plans[cursor]
    if(previous&&JSON.stringify(previous.plan.after)!==JSON.stringify(plan.before))
      throw Error('Approved scene diverged from planned continuation')
    const updated=await store.appendPair(projectId,snapshot.revision,plan)
    draft.cursor=cursor+1
    draft.updatedAt=new Date().toISOString()
    await save(path(projectId,episodeId),draft)
    return{snapshot:updated,remaining:draft.plans.length-draft.cursor}
    }))
}
