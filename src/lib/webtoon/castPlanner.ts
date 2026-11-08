/** Strict character/location proposals. Never treat them as approved image masters. */
export interface CharacterProposal { id:string;displayName:string;appearance:string;outfitId:string }
export interface LocationProposal { id:string;description:string }
export interface CastProposals { characters:CharacterProposal[];locations:LocationProposal[] }
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const record=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value)
const str=(value:unknown):value is string=>typeof value==='string'
const normal=(value:string)=>value.trim()
export function parseCastProposals(text:string):CastProposals{
  if(!text||text.length>40_000)throw new Error('Cast proposal response too large/empty')
  const cleaned=text.replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}\s*$/,'').trim()
  const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}')
  if(start<0||end<=start)throw new Error('Cast response must contain a JSON object')
  let raw:unknown
  try{raw=JSON.parse(cleaned.slice(start,end+1))}catch{throw new Error('Cast response is not valid JSON')}
  if(!record(raw)||!Array.isArray(raw.characters)||!Array.isArray(raw.locations)||
     raw.characters.length<1||raw.characters.length>8||raw.locations.length<1||raw.locations.length>8)
    throw new Error('Cast response needs 1-8 characters and 1-8 locations')
  const characters:CharacterProposal[]=raw.characters.map((value:unknown)=>{
    if(!record(value)||![value.id,value.displayName,value.appearance,value.outfitId].every(str)||
      !ID.test(value.id as string)||!ID.test(value.outfitId as string)||
      !normal(value.displayName as string)||!normal(value.appearance as string))
      throw new Error('Invalid character proposal')
    return{id:value.id as string,displayName:normal(value.displayName as string).slice(0,100),
      appearance:normal(value.appearance as string).slice(0,1800),outfitId:value.outfitId as string}
  })
  const locations:LocationProposal[]=raw.locations.map((value:unknown)=>{
    if(!record(value)||!str(value.id)||!ID.test(value.id)||!str(value.description)||
      !normal(value.description))throw new Error('Invalid location proposal')
    return{id:value.id,description:normal(value.description).slice(0,1800)}
  })
  if(new Set(characters.map(c=>c.id)).size!==characters.length||
     new Set(locations.map(l=>l.id)).size!==locations.length)
    throw new Error('Duplicate character or location IDs')
  return{characters,locations}
}
export function buildCastPrompt(story:string,bible:string):{systemPrompt:string;userPrompt:string;maxNewTokens:number}{
  if(!story.trim()||story.length>5000||bible.length>15000)throw new Error('Invalid story/bible')
  const systemPrompt=[
    'You are a Korean webtoon story editor and visual character designer.',
    'Extract the main recurring characters and stable locations needed to illustrate this story.',
    'Do not invent large casts. Keep identity, hairstyle, facial features, body type, outfits and key props specific.',
    'Descriptions must help a 2D Korean-webtoon image model maintain character consistency across panels.',
    'Use Korean for displayName, appearance and description. Use ASCII stable identifiers only for id/outfitId.',
    'Return strictly one JSON object and no markdown:',
    '{"characters":[{"id":"hero","displayName":"이름","appearance":"얼굴·머리·의상 설명","outfitId":"default"}],',
    '"locations":[{"id":"room","description":"배경 구조·고정 소품·주요 조명 설명"}]}',
    'Generate at least 1 and at most 8 characters and locations.'
  ].join('\n')
  return{systemPrompt,userPrompt:JSON.stringify({story,bible}),maxNewTokens:2200}
}
export async function proposeCast(story:string,bible:string,llm:
  (p:{systemPrompt:string;userPrompt:string;maxNewTokens:number})=>Promise<string>):Promise<CastProposals>{
  const prompt=buildCastPrompt(story,bible)
  let last:unknown
  for(let i=0;i<2;i++){
    try{return parseCastProposals(await llm({...prompt,
      userPrompt:i===0?prompt.userPrompt:prompt.userPrompt+'\nThe previous JSON was invalid; return valid JSON only.'}))}
    catch(e){last=e}
  }
  throw last
}
