import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
import {generateEpisodeDrafts,activateNextEpisodeDraft} from '../src/lib/webtoon/episodeDrafts.ts'
import {episodePairId,nextEpisodeId} from '../src/lib/webtoon/seriesLoop.ts'
import {seriesNarrativeContext,episodeCompletionReady} from '../src/lib/webtoon/seriesNarrative.ts'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=','base64')
const catalog={characters:[{id:'hero',version:1,displayName:'민서',description:'black hair',outfitIds:['uniform'],identityReferenceId:'identity'}],
 locations:[{id:'roof',version:1,description:'roof',referenceIds:[]}],
 assets:[{id:'identity',kind:'identity',ownerId:'hero',uri:'refs/identity.png',
   sha256:'a'.repeat(64),status:'approved',version:1}]}
const llm=async({userPrompt})=>{
 const data=JSON.parse(userPrompt)
 const state=data.authoritativeBefore
 const actor=state.actors[0]
 return JSON.stringify({middle:state,after:state,panels:[0,1].map(i=>({
   id:data.pairId+'_'+i,sceneId:state.sceneId,locationId:state.locationId,
   summary:'민서가 비밀을 발견함',camera:'medium',events:[],
   characters:[{characterId:actor.characterId,outfitId:actor.outfitId,box:actor.box,
      facing:actor.facing,action:'observes',emotion:'surprised'}],
   bubbles:[{id:'bubble_'+i,type:'speech',speakerId:actor.characterId,text:'비밀이야',
      box:[.65,.03,.3,.2],tailTarget:[.3,.6],readOrder:0}]
 }))})
}
async function env(fn){
 const dir=await mkdtemp(join(tmpdir(),'webtoon-series-'))
 const prior=process.env.WEBTOON_DATA_DIR
 process.env.WEBTOON_DATA_DIR=dir
 try{
   const store=new ProjectStore(dir)
   await store.create('serial',catalog)
   await fn(store)
 }finally{
   if(prior===undefined)delete process.env.WEBTOON_DATA_DIR
   else process.env.WEBTOON_DATA_DIR=prior
   await rm(dir,{recursive:true,force:true})
 }
}
async function completePair(store,episodeId){
 let result=await activateNextEpisodeDraft('serial',episodeId,store)
 let state=result.snapshot
 const pair=state.pairs.at(-1)
 for(let i=0;i<2;i++){
   state=await store.advancePair('serial',state.revision,pair.plan.id,i===0?'render_first':'render_second')
   state=await store.advancePair('serial',state.revision,pair.plan.id,i===0?'review_first':'review_second')
   state=await store.stageImage('serial',state.revision,pair.plan.id,i,png,'image/png')
   state=await store.approvePanel('serial',state.revision,pair.plan.id,i,state.catalog.assets.at(-1).id,'human')
 }
 return state
}
test('2 episodes: stable IDs, approval-gated finalization, open thread and resolved carryover',()=>env(async store=>{
 const first=await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'학교 비밀',storyBible:'세계관',pairCount:1},llm,store)
 assert.equal(first.plans[0].id,'episode1_p00001')
 let state=await completePair(store,'episode1')
 const ep=state.series.episodes[0]
 assert.equal(episodeCompletionReady(ep,state.pairs,new Set(state.approvedPanels.map(p=>p.id))).ready,true)
 state=await store.setBubble('serial',state.revision,'episode1_p00001_1','bubble_1','수정한 마지막 대사',[.65,.03,.3,.2])
 state=await store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'학교 비밀이 발견됨',endingHook:'누가 숨겼을까?',
   openThreads:[{id:'secret',description:'비밀의 주인이 누구인가'}],
   resolveThreadIds:[],
   relationshipUpdates:[]
 })
 assert.equal(state.series.episodes[0].status,'completed')
 assert.equal(state.series.episodes[0].handoff.lastDialogue,'수정한 마지막 대사')
 await assert.rejects(store.setBubble('serial',state.revision,'episode1_p00001_1',
   'bubble_1','완료 후 무단 수정',[.65,.03,.3,.2]),/immutable/)
 assert.equal(nextEpisodeId(state.series),'episode2')
 assert.deepEqual(state.series.episodes[0].handoff.finalState,state.pairs.at(-1).plan.after)
 const seen=[]
 const second=await generateEpisodeDrafts({projectId:'serial',episodeId:'episode2',
   storyGoal:'비밀 추적',storyBible:'세계관',pairCount:1},async p=>{
     seen.push(p.userPrompt);return llm(p)
   },store)
 assert.equal(second.plans[0].id,'episode2_p00001')
 assert.deepEqual(second.plans[0].before,state.series.episodes[0].handoff.finalState)
 assert(seen.some(text=>text.includes('secret')))
 assert(seriesNarrativeContext(state.series).includes('비밀의 주인이 누구인가'))
 state=await completePair(store,'episode2')
 state=await store.finalizeEpisode('serial',state.revision,'episode2',{
   summary:'범인이 드러남',endingHook:'새 사건의 시작',
   openThreads:[],resolveThreadIds:['secret']
 })
 assert.equal(state.series.episodes.length,2)
 assert.equal(state.series.threads[0].status,'resolved')
 assert.equal(state.series.threads[0].resolvedEpisode,'episode2')
 assert.equal(state.approvedPanels.length,4)
 await assert.rejects(store.finalizeEpisode('serial',state.revision,'episode2',{
   summary:'again',endingHook:'again',openThreads:[],resolveThreadIds:[]
 }),/already completed|not active/)
}))
test('cannot start a new episode or finalize while previous panels remain unapproved',()=>env(async store=>{
 await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'학교',storyBible:'',pairCount:2},llm,store)
 let state=await completePair(store,'episode1')
 await assert.rejects(store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'too early',endingHook:'end',openThreads:[],resolveThreadIds:[]
 }),/unplanned or unfinished pairs/)
 await assert.rejects(generateEpisodeDrafts({projectId:'serial',episodeId:'episode2',
   storyGoal:'다음',storyBible:'',pairCount:1},llm,store),/Complete the active episode/)
 await assert.rejects(store.beginEpisode('serial',state.revision,{
   episodeId:'episode2',targetPairs:1,startState:state.pairs.at(-1).plan.after
 }),/Finish the current episode/)
}))
test('episode IDs are collision-free even when future outline exists before production',()=>env(async store=>{
 assert.equal(episodePairId('chapter01',1),'chapter01_p00001')
 assert.equal(episodePairId('chapter02',1),'chapter02_p00001')
 assert.throws(()=>episodePairId('../bad',1),/Invalid/)
 await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'첫 화',storyBible:'',pairCount:1},llm,store)
 const state=await store.read('serial')
 assert.equal(state.pairs.length,0)
}))

test('cannot preplan a later episode while an earlier saved draft is unfinished',()=>env(async store=>{
 await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'시작',storyBible:'',pairCount:2},llm,store)
 await assert.rejects(generateEpisodeDrafts({projectId:'serial',episodeId:'episode2',
   storyGoal:'이어지는 이야기',storyBible:'',pairCount:2},llm,store),
   /Complete the earlier drafted episode episode1/)
}))
test('episode completion detects corruption of a previously approved image',()=>env(async store=>{
 const {writeFile}=await import('node:fs/promises')
 const {join}=await import('node:path')
 await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'작품',storyBible:'',pairCount:1},llm,store)
 let state=await completePair(store,'episode1')
 const image=state.catalog.assets.find(a=>a.id===state.pairs[0].job.firstApprovedAssetId)
 const dataDir=process.env.WEBTOON_DATA_DIR
 await writeFile(join(dataDir,'serial',image.uri),Buffer.from('corrupted'))
 await assert.rejects(store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'마감',endingHook:'다음 사건',openThreads:[],resolveThreadIds:[]
 }),/checksum|hash|mismatch/i)
 assert.equal((await store.read('serial')).series.episodes[0].status,'producing')
}))

test('editing early dialogue after later pairs exist blocks finalization until downstream review',()=>env(async store=>{
 await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'이어지는 대화',storyBible:'',pairCount:2},llm,store)
 let state=await completePair(store,'episode1')
 state=await completePair(store,'episode1')
 const first=state.pairs[0].plan.panels[0]
 state=await store.setBubble('serial',state.revision,first.id,first.bubbles[0].id,
   '이전 설정과 충돌할 수도 있는 수정 대사',[.65,.03,.3,.2])
 assert.equal(state.series.episodes[0].continuityReviewRequired,true)
 await assert.rejects(store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'이야기',endingHook:'다음 화',openThreads:[],resolveThreadIds:[]
 }),/Downstream story continuity must be reviewed/)
 state=await store.acknowledgeEpisodeContinuity('serial',state.revision,'episode1','reviewer')
 assert.equal(state.series.episodes[0].continuityReviewRequired,false)
 state=await store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'이야기',endingHook:'다음 화',openThreads:[],resolveThreadIds:[]
 })
 assert.equal(state.series.episodes[0].status,'completed')
}))

test('long serial memory always retains open thread IDs in valid JSON',()=>{
 const threads=Array.from({length:15},(_,i)=>({
   id:'thread_'+i,description:'실마리 '+i+' '+('가'.repeat(500)),
   introducedEpisode:'episode1',status:'open'
 }))
 const serialized=seriesNarrativeContext({
   episodes:[{id:'episode1',status:'completed',handoff:{
     summary:'이전 화 '+('사건'.repeat(500)),endingHook:'새 사건',lastDialogue:'기억해',finalState:{}
   }}],
   threads,relationships:[]
 })
 const parsed=JSON.parse(serialized)
 assert.equal(parsed.unresolvedThreads.length,15)
 assert.equal(parsed.unresolvedThreads[14].id,'thread_14')
 assert(serialized.length<7301)
})

test('editing first dialogue after second panel approval requires a continuity check',()=>env(async store=>{
 await generateEpisodeDrafts({projectId:'serial',episodeId:'episode1',
   storyGoal:'한 쌍 대화',storyBible:'',pairCount:1},llm,store)
 let state=await completePair(store,'episode1')
 const first=state.pairs[0].plan.panels[0]
 state=await store.setBubble('serial',state.revision,first.id,first.bubbles[0].id,
   '첫 컷의 말이 달라졌다',[.65,.03,.3,.2])
 assert.equal(state.series.episodes[0].continuityReviewRequired,true)
 await assert.rejects(store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'수정됨',endingHook:'마무리',openThreads:[],resolveThreadIds:[]
 }),/Downstream story continuity/)
 state=await store.acknowledgeEpisodeContinuity('serial',state.revision,'episode1','reviewer')
 state=await store.finalizeEpisode('serial',state.revision,'episode1',{
   summary:'수정됨',endingHook:'마무리',openThreads:[],resolveThreadIds:[]
 })
 assert.equal(state.series.episodes[0].status,'completed')
}))
