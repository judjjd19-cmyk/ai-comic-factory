import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,copyFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
const host='127.0.0.1'
const image=await sharp({create:{width:768,height:1024,channels:3,background:'#aabbcc'}}).png().toBuffer()
const mime='data:image/png;base64,'+image.toString('base64')
const bind=async server=>new Promise((resolve,reject)=>{
 server.once('error',reject);server.listen(0,host,()=>resolve(server.address().port))
})
const stop=async server=>new Promise(resolve=>server.close(resolve))
const json=async(request,response,status,data)=>{
 response.writeHead(status,{'Content-Type':'application/json'})
 response.end(JSON.stringify(data))
}
async function freePort(){
 const server=createServer()
 const port=await bind(server)
 await stop(server)
 return port
}
test('real Next API: masters -> local Qwen -> masked ComfyUI -> first/second approval -> next episode',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webtoon-live-api-'))
 const prompts=[],history=new Map()
 let uploads=0,localCalls=0
 const comfy=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost')
   if(url.pathname==='/object_info'){
     const classes=['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage',
       'KSampler','VAEDecode','SaveImage','IPAdapterModelLoader','CLIPVisionLoader',
       'IPAdapterAdvanced','LoadImage','LoadImageMask']
     return json(req,res,200,Object.fromEntries(classes.map(c=>[c,{input:{required:{}}}])))
   }
   if(url.pathname==='/upload/image'){
     for await(const _ of req){} // consume multipart bytes
     return json(req,res,200,{name:'uploaded_'+(++uploads)+'.png',subfolder:'',type:'input'})
   }
   if(url.pathname==='/prompt'){
     let body=''
     for await(const chunk of req)body+=chunk
     const data=JSON.parse(body)
     prompts.push(data.prompt)
     const id=randomUUID()
     history.set(id,data.prompt)
     return json(req,res,200,{prompt_id:id})
   }
   if(url.pathname.startsWith('/history/')){
     const id=url.pathname.split('/').at(-1)
     if(!history.has(id))return json(req,res,404,{})
     return json(req,res,200,{[id]:{status:{completed:true,status_str:'success'},
       outputs:{'8':{images:[{filename:'preview.png',subfolder:'',type:'output'}]}}}})
   }
   if(url.pathname==='/view'){
     res.writeHead(200,{'Content-Type':'image/png'})
     return res.end(image)
   }
   return json(req,res,404,{error:'unsupported comfy URL '+url.pathname})
 })
 const llm=createServer(async(req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname
   if(path!=='/v1/chat/completions')return json(req,res,404,{})
   let body=''
   for await(const piece of req)body+=piece
   const modelRequest=JSON.parse(body)
   const q=JSON.parse(modelRequest.messages[1].content)
   localCalls++
   assert.equal(modelRequest.model,'Qwen3.5-9B')
   const before=q.authoritativeBefore
   const actor=before.actors[0]
   assert(actor)
   const answer={middle:before,after:before,
     panels:[0,1].map(i=>({
       id:q.pairId+'_'+i,sceneId:before.sceneId,locationId:before.locationId,
       summary:'주인공이 인사한다',camera:'medium',events:[],
       characters:[{characterId:actor.characterId,outfitId:actor.outfitId,box:actor.box,
         facing:actor.facing,action:'speaking',emotion:'calm'}],
       bubbles:[{id:'bubble_'+i,type:'speech',speakerId:actor.characterId,text:'안녕하세요',
         box:[.64,.03,.32,.23],tailTarget:[.3,.5],readOrder:0}]
     }))}
   return json(req,res,200,{choices:[{message:{content:JSON.stringify(answer)}}]})
 })
 const comfyPort=await bind(comfy),llmPort=await bind(llm),appPort=await freePort()
 const token='local_smoke_test_token_'+randomUUID().replaceAll('-','')
 const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start',
   '--hostname',host,'--port',String(appPort)],{cwd:process.cwd(),env:{...process.env,
   WEBTOON_STUDIO_TOKEN:token,WEBTOON_DATA_DIR:dir,
   COMFYUI_API_URL:'http://'+host+':'+comfyPort,
   COMFYUI_REFERENCE_MODE:'auto',
   COMFYUI_WORKFLOW_PATH:'comfyui/workflow-api.example.json',
   COMFYUI_CHECKPOINT_NAME:'Illustrious-XL-v2.0.safetensors',
   LLM_OPENAI_API_MODEL:'Qwen3.5-9B',
   LLM_OPENAI_API_BASE_URL:'http://'+host+':'+llmPort+'/v1',
   AUTH_OPENAI_API_KEY:'local',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']})
 let logs=''
 for(const ch of [app.stdout,app.stderr])ch.on('data',d=>{logs+=d.toString();if(logs.length>10000)logs=logs.slice(-10000)})
 const origin='http://'+host+':'+appPort
 let cookie=''
 const post=async(action,data={})=>{
   const reply=await fetch(origin+'/api/webtoon/command',{method:'POST',headers:{
     'Content-Type':'application/json',Cookie:cookie,Origin:origin
   },body:JSON.stringify({action,projectId:'mycomic',...data})})
   const result=await reply.json()
   assert.equal(result.ok,true,action+': '+JSON.stringify(result)+'\nServer log: '+logs.slice(-1500))
   return result.data
 }
 try{
   let ready=false
   for(let attempt=0;attempt<120;attempt++){
     if(app.exitCode!==null)throw Error('Next server exited unexpectedly: '+logs)
     try{const r=await fetch(origin+'/api/webtoon/auth');if(r.ok){ready=true;break}}catch{}
     await new Promise(resolve=>setTimeout(resolve,500))
   }
   assert(ready,'Next did not become ready: '+logs)
   const auth=await fetch(origin+'/api/webtoon/auth',{method:'POST',
     headers:{'Content-Type':'application/json',Origin:origin},
     body:JSON.stringify({token})})
   assert.equal(auth.status,200)
   cookie=auth.headers.get('set-cookie')?.split(';')[0]||''
   assert(cookie.includes('webtoon_studio_session='))
   let state=await post('create')
   state=await post('stageMaster',{revision:state.revision,ownerId:'hero',
     kind:'identity',outfitId:'uniform',dataUri:mime})
   state=await post('approveCharacter',{revision:state.revision,
     assetId:state.catalog.assets.at(-1).id,ownerId:'hero',displayName:'민서',
     description:'검은 단발머리, 짙은 갈색 눈',outfitId:'uniform'})
   state=await post('stageMaster',{revision:state.revision,ownerId:'room',
     kind:'location',dataUri:mime})
   state=await post('approveLocation',{revision:state.revision,
     assetId:state.catalog.assets.at(-1).id,ownerId:'room',description:'학교 옥상'})
   const first=await post('planPair',{storyGoal:'주인공이 인사하는 장면',
     storyBibleSummary:'고등학교',episodeId:'episode1',pairCount:1,locationId:'room'})
   assert.equal(first.pairs.length,1)
   state=first
   const pair=state.pairs[0].plan.id
   assert.equal(pair,'episode1_p00001')
   for(let index=0;index<2;index++){
     const queued=await post('startPanel',{pairId:pair,panelIndex:index,width:768,height:1024})
     assert.equal(queued.status,'pending')
     const polled=await post('pollPanel',{pairId:pair,panelIndex:index})
     assert.equal(polled.status,'review')
     state=polled.snapshot
     assert.equal(state.pairs[0].job.status,index===0?'review_first':'review_second')
     const asset=state.catalog.assets.at(-1)
     const inspection=await post('inspectPanel',{pairId:pair,panelIndex:index,assetId:asset.id})
     assert.equal(inspection.issues.filter(x=>x.severity==='blocking').length,0)
     state=await post('approvePanel',{pairId:pair,panelIndex:index,assetId:asset.id,reviewer:'smoke-test'})
   }
   assert.equal(state.pairs[0].job.status,'approved')
   assert.equal(prompts.length,2)
   const firstGraph=prompts[0],secondGraph=prompts[1]
   assert.equal(Object.values(firstGraph).filter(n=>n.class_type==='IPAdapterAdvanced').length,2)
   assert.equal(Object.values(secondGraph).filter(n=>n.class_type==='IPAdapterAdvanced').length,3)
   assert(Object.values(secondGraph).some(n=>n.class_type==='LoadImageMask'))
   assert(uploads>=9)
   state=await post('finalizeEpisode',{episodeId:'episode1',summary:'학교에서 인사를 나눔',
     endingHook:'누가 나타날까?',openThreads:[{id:'mystery',description:'정체불명 전학생'}],resolveThreadIds:[]})
   assert.equal(state.series.episodes[0].status,'completed')
   const next=await post('planPair',{episodeId:'episode2',pairCount:1,
     storyGoal:'전학생과의 만남',storyBibleSummary:'고등학교',locationId:'room'})
   assert.equal(next.pairs.length,2)
   assert.deepEqual(next.pairs[1].plan.before,state.series.episodes[0].handoff.finalState)
   assert.equal(localCalls,2)
 }finally{
   app.kill('SIGTERM')
   await Promise.all([stop(comfy),stop(llm)])
   await rm(dir,{recursive:true,force:true})
 }
})
