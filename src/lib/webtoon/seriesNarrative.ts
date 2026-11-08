import type {SeriesLedger,EpisodeRecord} from './seriesLoop.ts'
import type {PairPlan} from './contracts.ts'

/** Closed episodes, not speculative drafts, are the source of serial canon. */
export function seriesNarrativeContext(series:SeriesLedger|undefined):string{
  if(!series)return''
  const completed=series.episodes.filter(e=>e.status==='completed'&&e.handoff)
  const recent=completed.slice(-3).map(e=>({
    episodeId:e.id,summary:e.handoff!.summary,
    endingHook:e.handoff!.endingHook,
    lastDialogue:e.handoff!.lastDialogue
  }))
  const unresolved=series.threads.filter(t=>t.status==='open')
    .map(t=>({id:t.id,description:t.description,introducedEpisode:t.introducedEpisode}))
  const relationships=series.relationships.map(r=>({
    characterIds:r.characterIds,note:r.note,updatedEpisode:r.updatedEpisode
  }))
  let serialized=JSON.stringify({previousEpisodes:recent,unresolvedThreads:unresolved,
    characterRelationships:relationships})
  if(serialized.length<=12000)return serialized
  // Preserve all open thread IDs and emit complete JSON, never silently cut a JSON object.
  serialized=JSON.stringify({
    previousEpisodes:recent.map(e=>({...e,summary:e.summary.slice(0,800),
      endingHook:e.endingHook.slice(0,200),lastDialogue:e.lastDialogue.slice(0,200)})),
    unresolvedThreads:unresolved.map(t=>({...t,description:t.description.slice(0,120)})),
    characterRelationships:relationships.map(r=>({...r,note:r.note.slice(0,120)})),
  })
  if(serialized.length>18000)
    throw Error('Canonical series context exceeds token budget; consolidate thread descriptions')
  return serialized
}
export function draftEpisodeSummary(pairs:PairPlan[]):string{
  return pairs.flatMap(pair=>pair.panels.map(p=>p.summary))
    .filter(Boolean).join(' / ').slice(0,6000)
}
export function episodeCompletionReady(episode:EpisodeRecord|undefined,pairs:Array<{
  plan:PairPlan;job:{status:string;firstApprovedAssetId?:string;secondApprovedAssetId?:string}
}>,approvedPanelIds:Set<string>):{ready:boolean;reason:string}{
  if(!episode)return{ready:false,reason:'Unknown episode'}
  if(episode.status==='completed')return{ready:false,reason:'Episode is already completed'}
  if(episode.pairIds.length!==episode.targetPairs||episode.targetPairs<1)
    return{ready:false,reason:'Not all planned pairs are present'}
  for(const pairId of episode.pairIds){
    const pair=pairs.find(p=>p.plan.id===pairId)
    if(!pair||pair.job.status!=='approved'||!pair.job.firstApprovedAssetId||
       !pair.job.secondApprovedAssetId||!pair.plan.panels.every(p=>approvedPanelIds.has(p.id)))
      return{ready:false,reason:'Unapproved pair: '+pairId}
  }
  return{ready:true,reason:''}
}
