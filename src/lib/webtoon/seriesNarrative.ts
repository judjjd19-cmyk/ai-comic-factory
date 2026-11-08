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
  // Open thread identities must precede optional history; never cut structured JSON in half.
  const serialize=(limit:number,lastOnly=false):string=>JSON.stringify({
    unresolvedThreads:unresolved.map(t=>({...t,description:t.description.slice(0,limit)})),
    characterRelationships:relationships.map(r=>({...r,note:r.note.slice(0,limit)})),
    previousEpisodes:(lastOnly?recent.slice(-1):recent).map(e=>({
      episodeId:e.episodeId,
      endingHook:e.endingHook.slice(0,Math.max(100,limit)),
      summary:e.summary.slice(0,limit*3),
      lastDialogue:e.lastDialogue.slice(0,limit)
    }))
  })
  let serialized=serialize(350)
  if(serialized.length>7300)serialized=serialize(100)
  if(serialized.length>7300)serialized=serialize(40,true)
  if(serialized.length>7300)
    throw Error('Too many unresolved threads for the story context; consolidate their summaries')
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
  if(episode.continuityReviewRequired)
    return{ready:false,reason:'Dialogue changes require downstream continuity review'}
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
