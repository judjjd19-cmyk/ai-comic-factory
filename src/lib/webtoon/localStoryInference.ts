/**
 * Webtoon Studio is local-only. Never fall back to cloud inference when
 * a default Comic Factory LLM provider is missing or misconfigured.
 */
export interface LocalStoryPrompt {
  systemPrompt:string
  userPrompt:string
  maxNewTokens:number
}
export function localStoryURL(value=process.env.LLM_OPENAI_API_BASE_URL):URL {
  if(!value)throw new Error('Local Qwen server URL (LLM_OPENAI_API_BASE_URL) is not configured')
  let url:URL
  try{url=new URL(value)}catch{throw new Error('Invalid local Qwen server URL')}
  if(url.protocol!=='http:'||
     !['localhost','127.0.0.1','[::1]'].includes(url.hostname)||
     url.username||url.password||url.search||url.hash)
    throw new Error('Webtoon LLM must use a local HTTP loopback server, never a remote API')
  const base=url.href.endsWith('/')?url.href:url.href+'/'
  return new URL('chat/completions',base)
}
export async function predictWebtoonLocal(
  {systemPrompt,userPrompt,maxNewTokens}:LocalStoryPrompt,
  fetchFn:typeof fetch=fetch,
):Promise<string>{
  if(!systemPrompt.trim()||!userPrompt.trim()||!Number.isInteger(maxNewTokens)||
     maxNewTokens<1||maxNewTokens>16384)throw new Error('Invalid local story inference request')
  const url=localStoryURL()
  const response=await fetchFn(url,{method:'POST',headers:{
    'Content-Type':'application/json',
    'Authorization':'Bearer '+(process.env.AUTH_OPENAI_API_KEY||'local')
  },body:JSON.stringify({
    model:process.env.LLM_OPENAI_API_MODEL||'Qwen3.5-9B',
    messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],
    temperature:0.8,max_tokens:maxNewTokens,stream:false
  }),cache:'no-store',signal:AbortSignal.timeout(600_000)})
  if(!response.ok)throw new Error('Local Qwen inference HTTP '+response.status+
    ': '+(await response.text()).slice(0,600))
  const body=await response.json() as {
    choices?:Array<{message?:{content?:unknown}}> }
  const answer=body?.choices?.[0]?.message?.content
  if(typeof answer!=='string'||!answer.trim())
    throw new Error('Local Qwen returned empty or invalid story text')
  return answer
}
