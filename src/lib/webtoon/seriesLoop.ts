import type {PairPlan,SceneState} from './contracts.ts'
import type {EpisodeOutline} from './storyOutline.ts'

export type EpisodeStatus='producing'|'completed'
export interface SeriesThread{
  id:string;description:string;introducedEpisode:string
  status:'open'|'resolved';resolvedEpisode?:string
}
export interface RelationshipNote{
  characterIds:[string,string];note:string;updatedEpisode:string
}
export interface EpisodeHandoff{
  summary:string;endingHook:string;lastDialogue:string
  finalState:SceneState;unresolvedThreadIds:string[];completedAt:string
}
export interface EpisodeRecord{
  id:string;ordinal:number;status:EpisodeStatus;targetPairs:number
  pairIds:string[];startState:SceneState;createdAt:string
  outline?:EpisodeOutline;handoff?:EpisodeHandoff
  continuityReviewRequired?:boolean
  continuityReviewedAt?:string
}
export interface SeriesLedger{
  episodes:EpisodeRecord[];threads:SeriesThread[];relationships:RelationshipNote[]
}
export interface EpisodeCompletion{
  summary:string;endingHook:string
  openThreads:Array<{id:string;description:string}>
  resolveThreadIds:string[]
  relationshipUpdates?:Array<{characterIds:[string,string];note:string}>
}
export interface SeriesPair{
  plan:PairPlan
  job:{status:string;firstApprovedAssetId?:string;secondApprovedAssetId?:string}
}
const valid=(id:string)=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
const clone=<T>(value:T):T=>structuredClone(value)
export const emptySeries=():SeriesLedger=>({episodes:[],threads:[],relationships:[]})
export function episodePairId(episodeId:string,number:number):string{
  if(!valid(episodeId)||!Number.isInteger(number)||number<1||number>99999)
    throw Error('Invalid episode or pair ordinal')
  return episodeId+'_p'+String(number).padStart(5,'0')
}
export function getActiveEpisode(series:SeriesLedger):EpisodeRecord|undefined{
  return series.episodes.find(x=>x.status==='producing')
}
export function beginEpisode(series:SeriesLedger,input:{id:string;targetPairs:number;startState:SceneState;outline?:EpisodeOutline}):EpisodeRecord{
  if(!valid(input.id))throw Error('Invalid episode ID')
  if(!Number.isInteger(input.targetPairs)||input.targetPairs<1||input.targetPairs>250)
    throw Error('Episode pair count must be 1-250')
  if(series.episodes.some(e=>e.id===input.id))throw Error('Episode ID already exists')
  if(getActiveEpisode(series))throw Error('Finish the current episode before starting another')
  const previous=series.episodes.at(-1)
  if(previous&&(!previous.handoff||JSON.stringify(previous.handoff.finalState)!==JSON.stringify(input.startState)))
    throw Error('Next episode must inherit the approved previous episode handoff')
  if(input.outline&&input.outline.episodeId!==input.id)throw Error('Outline belongs to another episode')
  const record:EpisodeRecord={id:input.id,ordinal:series.episodes.length+1,status:'producing',
    targetPairs:input.targetPairs,pairIds:[],startState:clone(input.startState),
    createdAt:new Date().toISOString(),...(input.outline?{outline:clone(input.outline)}:{})}
  series.episodes.push(record)
  return record
}
export function registerPair(series:SeriesLedger,plan:PairPlan):void{
  const current=getActiveEpisode(series)
  if(!current||current.id!==plan.episodeId)throw Error('No active matching episode')
  if(current.pairIds.includes(plan.id))throw Error('Duplicate episode pair')
  if(current.targetPairs>0&&current.pairIds.length>=current.targetPairs)
    throw Error('Episode reached planned pair count')
  if(plan.id!==episodePairId(plan.episodeId,current.pairIds.length+1))
    throw Error('Episode pair ID/ordinal mismatch')
  if(!current.pairIds.length&&JSON.stringify(plan.before)!==JSON.stringify(current.startState))
    throw Error('First pair does not match canonical episode opening state')
  current.pairIds.push(plan.id)
}
export function prepareEpisodeHandoff(series:SeriesLedger,episodeId:string,
  pairs:SeriesPair[],approvedPanelIds:Set<string>,input:EpisodeCompletion,
  characterIds:Set<string>,bubbleOverrides:Record<string,Record<string,{text:string}>>={}):EpisodeHandoff{
  const ep=series.episodes.find(e=>e.id===episodeId)
  if(!ep||ep.status!=='producing'||getActiveEpisode(series)?.id!==episodeId)
    throw Error('Episode is not active')
  if(ep.continuityReviewRequired)throw Error('Downstream story continuity must be reviewed after dialogue edits')
  if(ep.targetPairs<1||ep.pairIds.length!==ep.targetPairs)
    throw Error('Episode still has unplanned or unfinished pairs')
  const belonging=ep.pairIds.map(id=>pairs.find(p=>p.plan.id===id))
  if(belonging.some(x=>!x))throw Error('Episode references a missing pair')
  for(const [index,entry] of belonging.entries()){
    if(!entry||entry.job.status!=='approved'||!entry.job.firstApprovedAssetId||!entry.job.secondApprovedAssetId||
      entry.plan.episodeId!==ep.id||!entry.plan.panels.every(p=>approvedPanelIds.has(p.id)))
      throw Error('Episode has unapproved panels at pair '+(index+1))
    if(index===0&&JSON.stringify(entry.plan.before)!==JSON.stringify(ep.startState))
      throw Error('Episode opening state changed')
    if(index>0&&JSON.stringify(entry.plan.before)!==JSON.stringify(belonging[index-1]!.plan.after))
      throw Error('Episode state transition is broken')
  }
  if(!input.summary.trim()||!input.endingHook.trim()||input.summary.length>6000||
     input.endingHook.length>1200)throw Error('Episode synopsis and ending hook are required')
  const opened=new Set<string>(),resolved=new Set<string>()
  for(const t of input.openThreads){
    if(!valid(t.id)||!t.description.trim()||t.description.length>1200||opened.has(t.id)||
      series.threads.some(x=>x.id===t.id))
      throw Error('Invalid or duplicate new story thread')
    opened.add(t.id)
  }
  for(const id of input.resolveThreadIds){
    if(!valid(id)||resolved.has(id)||!series.threads.some(x=>x.id===id&&x.status==='open'))
      throw Error('Cannot resolve an unknown/closed story thread')
    resolved.add(id)
  }
  for(const rel of input.relationshipUpdates||[]){
    if(!Array.isArray(rel.characterIds)||rel.characterIds.length!==2||
      rel.characterIds[0]===rel.characterIds[1]||!rel.characterIds.every(x=>characterIds.has(x))||
      !rel.note.trim()||rel.note.length>1000)throw Error('Invalid relationship update')
  }
  const last=belonging.at(-1)!.plan
  const finalPanel=last.panels.at(-1)!
  const dialogue=finalPanel.bubbles.map(x=>bubbleOverrides[finalPanel.id]?.[x.id]?.text??x.text)
    .join(' / ').slice(0,1200)
  const unresolved=[
    ...series.threads.filter(x=>x.status==='open'&&!resolved.has(x.id)).map(x=>x.id),
    ...input.openThreads.map(x=>x.id)
  ]
  return{summary:input.summary.trim(),endingHook:input.endingHook.trim(),lastDialogue:dialogue,
    finalState:clone(last.after),unresolvedThreadIds:unresolved,completedAt:new Date().toISOString()}
}
export function completeEpisode(series:SeriesLedger,episodeId:string,handoff:EpisodeHandoff,input:EpisodeCompletion):void{
  const ep=series.episodes.find(e=>e.id===episodeId)
  if(!ep||ep.status!=='producing')throw Error('Episode already completed or does not exist')
  for(const thread of input.openThreads){
    series.threads.push({id:thread.id,description:thread.description.trim(),
      introducedEpisode:episodeId,status:'open'})
  }
  for(const id of input.resolveThreadIds){
    const thread=series.threads.find(x=>x.id===id)
    if(!thread||thread.status!=='open')throw Error('Cannot resolve closed thread')
    thread.status='resolved';thread.resolvedEpisode=episodeId
  }
  for(const note of input.relationshipUpdates||[]){
    const ids=[...note.characterIds].sort() as [string,string]
    const existing=series.relationships.find(r=>r.characterIds[0]===ids[0]&&r.characterIds[1]===ids[1])
    if(existing){existing.note=note.note.trim();existing.updatedEpisode=episodeId}
    else series.relationships.push({characterIds:ids,note:note.note.trim(),updatedEpisode:episodeId})
  }
  ep.status='completed'
  ep.handoff=clone(handoff)
}
export function nextEpisodeId(series:SeriesLedger):string{
  let number=series.episodes.length+1
  while(series.episodes.some(x=>x.id==='episode'+number))number++
  return 'episode'+number
}
export function episodePanels(series:SeriesLedger,pairs:SeriesPair[],id:string):PairPlan['panels'][number][]{
  const episode=series.episodes.find(e=>e.id===id)
  if(!episode)throw Error('Unknown episode')
  return episode.pairIds.flatMap(pairId=>{
    const pair=pairs.find(p=>p.plan.id===pairId)
    if(!pair)throw Error('Missing episode pair')
    return pair.plan.panels
  })
}
