import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
import {generatePairPlan} from '../src/lib/webtoon/pairPlanner.ts'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=','base64')
const catalog={characters:[{id:'hero',version:1,displayName:'주인공',
 description:'검은 머리',outfitIds:['default'],identityReferenceId:'identity'}],
 locations:[{id:'room',version:1,description:'room',referenceIds:[]}],
 assets:[{id:'identity',kind:'identity',ownerId:'hero',version:1,status:'approved',
  uri:'refs/master.png',sha256:'a'.repeat(64)}]}
const scene=()=>({sceneId:'s1',locationId:'room',timeKey:'day',actors:[{
 characterId:'hero',outfitId:'default',box:[.1,.3,.5,.6],facing:'front',
 emotion:'calm',heldPropIds:[]}]})
async function plannedPair(store){
 const snap=await store.read('book')
 const input={pairId:'episode1_p00001',episodeId:'episode1',storyGoal:'인물의 행동',
  storyBibleSummary:'학교',approvedHistorySummary:'',before:scene(),catalog:snap.catalog}
 return generatePairPlan(input,async({userPrompt})=>{
  const q=JSON.parse(userPrompt)
  return JSON.stringify({middle:q.authoritativeBefore,after:q.authoritativeBefore,
    panels:[0,1].map(i=>({id:q.pairId+'_'+i,sceneId:'s1',locationId:'room',
      summary:'대화',camera:'medium',events:[],
      characters:[{characterId:'hero',outfitId:'default',action:'talk',
        emotion:'calm',box:[.1,.3,.5,.6],facing:'front'}],
      bubbles:[{id:'b'+i,type:'speech',speakerId:'hero',text:'안녕',
        box:[.6,.05,.3,.2],tailTarget:[.4,.5],readOrder:0}]}))})
 })
}
async function run(fn){
 const dir=await mkdtemp(join(tmpdir(),'webtoon-path-'))
 try{const store=new ProjectStore(dir);await store.create('book',catalog);await fn(store,dir)}
 finally{await rm(dir,{recursive:true,force:true})}
}
test('invalid first pair rolls back episode registration atomically',()=>run(async store=>{
 const valid=await plannedPair(store)
 const invalid=structuredClone(valid)
 invalid.panels[0].locationId='missing'
 await assert.rejects(store.appendPair('book',0,invalid,{
   targetPairs:3,startState:valid.before
 }),/Invalid pair plan/)
 const snapshot=await store.read('book')
 assert.equal(snapshot.revision,0)
 assert.deepEqual(snapshot.series.episodes,[])
 assert.equal(snapshot.pairs.length,0)
 const validState=await store.appendPair('book',0,valid,{
   targetPairs:3,startState:valid.before
 })
 assert.equal(validState.revision,1)
 assert.equal(validState.series.episodes[0].pairIds[0],valid.id)
}))
test('completed ComfyUI bytes are staged atomically from rendering into review',()=>run(async(store,dir)=>{
 const plan=await plannedPair(store)
 let s=await store.appendPair('book',0,plan,{targetPairs:1,startState:plan.before})
 s=await store.advancePair('book',s.revision,plan.id,'render_first')
 const oldRevision=s.revision
 s=await store.stageImage('book',s.revision,plan.id,0,png,'image/png')
 assert.equal(s.revision,oldRevision+1)
 assert.equal(s.pairs[0].job.status,'review_first')
 assert.equal(s.catalog.assets.at(-1).status,'draft')
 const restarted=new ProjectStore(dir)
 assert.equal((await restarted.read('book')).pairs[0].job.status,'review_first')
 s=await restarted.approvePanel('book',s.revision,plan.id,0,s.catalog.assets.at(-1).id,'reviewer')
 assert.equal(s.pairs[0].job.status,'first_approved')
}))
test('approved identity supports a newly introduced outfit and separate facing views',()=>run(async store=>{
 let s=await store.read('book')
 s=await store.stageMaster('book',s.revision,{
   ownerId:'hero',kind:'outfit',outfitId:'winter',image:png,mime:'image/png'
 })
 const outfit=s.catalog.assets.at(-1)
 s=await store.approveSupplementalReference('book',s.revision,outfit.id)
 assert(s.catalog.characters[0].outfitIds.includes('winter'))
 assert.equal(s.catalog.assets.find(x=>x.id===outfit.id).status,'approved')
 s=await store.stageMaster('book',s.revision,{
   ownerId:'hero',kind:'view',view:'front',image:png,mime:'image/png'
 })
 const front=s.catalog.assets.at(-1).id
 s=await store.stageMaster('book',s.revision,{
   ownerId:'hero',kind:'view',view:'back',image:png,mime:'image/png'
 })
 const back=s.catalog.assets.at(-1).id
 assert.notEqual(front,back)
 s=await store.approveSupplementalReference('book',s.revision,front)
 s=await store.approveSupplementalReference('book',s.revision,back)
 assert.equal(s.catalog.assets.find(x=>x.id===back).status,'approved')
}))

test('a byte-identical rerender after rejection creates a fresh review asset',()=>run(async store=>{
 const plan=await plannedPair(store)
 let state=await store.appendPair('book',0,plan,{targetPairs:1,startState:plan.before})
 state=await store.advancePair('book',state.revision,plan.id,'render_first')
 state=await store.stageImage('book',state.revision,plan.id,0,png,'image/png')
 const firstAsset=state.catalog.assets.at(-1).id
 state=await store.rejectPanel('book',state.revision,plan.id,0,firstAsset,'wrong pose')
 assert.equal(state.pairs[0].job.status,'rendering_first')
 state=await store.stageImage('book',state.revision,plan.id,0,png,'image/png')
 const secondAsset=state.catalog.assets.at(-1).id
 assert.notEqual(firstAsset,secondAsset)
 assert.equal(state.catalog.assets.find(x=>x.id===firstAsset).status,'rejected')
 assert.equal(state.catalog.assets.find(x=>x.id===secondAsset).status,'draft')
 assert.equal(state.pairs[0].job.status,'review_first')
}))
