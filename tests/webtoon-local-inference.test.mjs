import test from 'node:test'
import assert from 'node:assert/strict'
import {localStoryURL,predictWebtoonLocal} from '../src/lib/webtoon/localStoryInference.ts'
test('Webtoon Studio never silently falls back to a cloud LLM',async()=>{
 const old=process.env.LLM_OPENAI_API_BASE_URL
 try{
   for(const value of ['https://api.openai.com/v1','http://external.example:8000/v1',
     'https://127.0.0.1:8000/v1','http://127.0.0.1.evil.example/v1']){
     process.env.LLM_OPENAI_API_BASE_URL=value
     assert.throws(()=>localStoryURL(),/local HTTP loopback/)
   }
   delete process.env.LLM_OPENAI_API_BASE_URL
   assert.throws(()=>localStoryURL(),/not configured/)
 }finally{if(old===undefined)delete process.env.LLM_OPENAI_API_BASE_URL
   else process.env.LLM_OPENAI_API_BASE_URL=old}
})
test('local story request sends user dialogue and system directions only to llama.cpp loopback',async()=>{
 const prev=process.env.LLM_OPENAI_API_BASE_URL
 process.env.LLM_OPENAI_API_BASE_URL='http://127.0.0.1:8000/v1'
 try{
   let called=0
   const transport=async(url,opts)=>{
     called++
     assert.equal(url.toString(),'http://127.0.0.1:8000/v1/chat/completions')
     const body=JSON.parse(opts.body)
     assert.equal(body.model,'Qwen3.5-9B')
     assert.equal(body.messages[0].content,'콘티 지시')
     assert.equal(body.messages[1].content,'우리 이야기')
     assert.equal(body.max_tokens,2800)
     assert.equal(body.stream,false)
     return{ok:true,json:async()=>({choices:[{message:{content:'{"panels":[]}'} }]})}
   }
   const answer=await predictWebtoonLocal({systemPrompt:'콘티 지시',userPrompt:'우리 이야기',
     maxNewTokens:2800},transport)
   assert.equal(answer,'{"panels":[]}')
   assert.equal(called,1)
 }finally{if(prev===undefined)delete process.env.LLM_OPENAI_API_BASE_URL
   else process.env.LLM_OPENAI_API_BASE_URL=prev}
})
test('malformed local-server responses fail rather than becoming fake stories',async()=>{
 const prev=process.env.LLM_OPENAI_API_BASE_URL
 process.env.LLM_OPENAI_API_BASE_URL='http://localhost:8000/v1'
 try{
   await assert.rejects(predictWebtoonLocal({systemPrompt:'a',userPrompt:'b',maxNewTokens:5},
     async()=>({ok:true,json:async()=>({choices:[]})})),/empty or invalid/)
   await assert.rejects(predictWebtoonLocal({systemPrompt:'a',userPrompt:'b',maxNewTokens:5},
     async()=>({ok:false,status:503,text:async()=>('unavailable')})),/HTTP 503/)
 }finally{if(prev===undefined)delete process.env.LLM_OPENAI_API_BASE_URL
   else process.env.LLM_OPENAI_API_BASE_URL=prev}
})
