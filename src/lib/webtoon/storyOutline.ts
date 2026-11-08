import type {WebtoonCatalog} from './contracts.ts'
export type StoryStage='opening'|'inciting'|'escalation'|'climax'|'hook'
export interface StageBeat{stage:StoryStage;event:string;characterIds:string[];locationId:string;emotionalChange:string}
export interface EpisodeOutline{episodeId:string;theme:string;stakes:string;beats:StageBeat[];recommendedPairs?:number}
export interface OutlineMessages{systemPrompt:string;userPrompt:string;maxNewTokens:number}
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const stages:StoryStage[]=['opening','inciting','escalation','climax','hook']
const rec=(x:unknown):x is Record<string,unknown>=>typeof x==='object'&&x!==null&&!Array.isArray(x)
const str=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0
export function parseEpisodeOutline(raw:string,episodeId:string,catalog:WebtoonCatalog):EpisodeOutline{
  if(raw.length>30_000||raw.length===0||!ID.test(episodeId))throw Error('Invalid outline response')
  const trimmed=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim()
  let value:unknown
  try{value=JSON.parse(trimmed.slice(trimmed.indexOf('{'),trimmed.lastIndexOf('}')+1))}
  catch{throw Error('Outline response must be valid JSON')}
  if(!rec(value)||value.episodeId!==episodeId||!str(value.theme)||!str(value.stakes)||
    !Array.isArray(value.beats)||value.beats.length!==5)throw Error('Expected five episode beats')
  const recommendedPairs=value.recommendedPairs
  if(recommendedPairs!==undefined&&(!Number.isInteger(recommendedPairs)||
    (recommendedPairs as number)<1||(recommendedPairs as number)>250))
    throw Error('recommendedPairs must be between 1 and 250')
  const people=new Set(catalog.characters.map(c=>c.id))
  const places=new Set(catalog.locations.map(l=>l.id))
  const beats:StageBeat[]=value.beats.map((v:unknown,i:number)=>{
    if(!rec(v)||v.stage!==stages[i]||!str(v.event)||!str(v.emotionalChange)||
      !str(v.locationId)||!places.has(v.locationId)||!Array.isArray(v.characterIds)||
      v.characterIds.length===0||v.characterIds.some((c:unknown)=>typeof c!=='string'||!people.has(c))||
      new Set(v.characterIds).size!==v.characterIds.length)
      throw Error('Invalid outline beat '+i+' or unknown character/location')
    return{stage:v.stage as StoryStage,event:v.event.trim().slice(0,1200),
      emotionalChange:v.emotionalChange.trim().slice(0,300),
      characterIds:v.characterIds as string[],locationId:v.locationId}
  })
  return{episodeId,theme:value.theme.trim().slice(0,500),stakes:value.stakes.trim().slice(0,1000),beats,
    ...(recommendedPairs===undefined?{}:{recommendedPairs:recommendedPairs as number})}
}
export function outlineMessages(episodeId:string,premise:string,bible:string,catalog:WebtoonCatalog):OutlineMessages{
  if(!ID.test(episodeId)||!premise.trim()||premise.length>5000||bible.length>15000)
    throw Error('Invalid episode request')
  if(!catalog.characters.length||!catalog.locations.length)throw Error('Approved masters required')
  return {maxNewTokens:2600,
    systemPrompt:[
      'Write a coherent Korean webtoon episode outline before any panel dialogue.',
      'Preserve premise, character and location identities; never introduce unregistered IDs.',
      'Exactly five ordered beats: opening, inciting, escalation, climax, hook.',
      'Create compelling causality, stakes and an ending hook, without repeating a beat.',
      'Return one JSON object only: episodeId, theme, stakes, beats, recommendedPairs.',
      'recommendedPairs is the number of TWO-PANEL pairs (1..250), selected for pacing, scroll length and narrative density.',
      'Favor enough panels for visual storytelling, reactions and scene transitions; do not pad scenes with filler.',
      'Every beat has stage, event, characterIds, locationId, emotionalChange.'
    ].join('\n'),
    userPrompt:JSON.stringify({episodeId,premise,bible,
      allowedCharacters:catalog.characters.map(c=>({id:c.id,name:c.displayName,description:c.description})),
      allowedLocations:catalog.locations.map(l=>({id:l.id,description:l.description}))})
  }
}
export function outlineBeatForPair(outline:EpisodeOutline,pairIndex:number,pairCount:number):StageBeat{
  if(!Number.isInteger(pairIndex)||!Number.isInteger(pairCount)||pairCount<1||pairIndex<0||pairIndex>=pairCount)
    throw Error('Invalid two-panel pair index')
  const act=Math.min(4,Math.floor(pairIndex*5/pairCount))
  return outline.beats[act]
}
export async function designEpisodeOutline(episodeId:string,premise:string,bible:string,catalog:WebtoonCatalog,
 llm:(p:OutlineMessages)=>Promise<string>):Promise<EpisodeOutline>{
  const messages=outlineMessages(episodeId,premise,bible,catalog)
  let last:unknown
  for(let i=0;i<2;i++){
    try{return parseEpisodeOutline(await llm({...messages,userPrompt:messages.userPrompt+
      (i?'\nThe previous JSON was invalid. Follow all field and ID constraints.':'')}),episodeId,catalog)}
    catch(e){last=e}
  }
  throw last
}
