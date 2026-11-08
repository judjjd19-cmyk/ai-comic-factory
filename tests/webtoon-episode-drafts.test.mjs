import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
import {generateEpisodeDrafts,activateNextEpisodeDraft,readEpisodeDrafts} from '../src/lib/webtoon/episodeDrafts.ts'
const catalog={characters:[{id:'hero',version:1,displayName:'주인공',description:'black hair',outfitIds:['uniform'],identityReferenceId:'face'}],
 locations:[{id:'room',version:1,description:'room',referenceIds:[]}],
 assets:[{id:'face',kind:'identity',ownerId:'hero',uri:'refs/a.png',sha256:'a'.repeat(64),status:'approved',version:1}]}
const llm=async({userPrompt})=>{
 const x=JSON.parse(userPrompt),s=x.authoritativeBefore,a=s.actors[0]
 return JSON.stringify({middle:s,after:s,panels:[0,1].map(i=>({
  id:x.pairId+'_'+i,sceneId:s.sceneId,locationId:s.locationId,summary:'talk',camera:'medium',events:[],
  characters:[{characterId:'hero',outfitId:'uniform',box:a.box,facing:'front',action:'talk',emotion:'calm'}],
  bubbles:[{id:'bubble_'+i,type:'speech',speakerId:'hero',text:'안녕',box:[.1,.05,.25,.2],tailTarget:[.25,.4],readOrder:0}]
 }))})
}
async function setup(fn){
 const dir=await mkdtemp(join(tmpdir(),'webtoon-episode-'))
 const prev=process.env.WEBTOON_DATA_DIR
 process.env.WEBTOON_DATA_DIR=dir
 try{const store=new ProjectStore(dir);await store.create('book',catalog);return await fn(store)}
 finally{if(prev===undefined)delete process.env.WEBTOON_DATA_DIR;else process.env.WEBTOON_DATA_DIR=prev;await rm(dir,{recursive:true,force:true})}
}
test('episode planning persists two-panel drafts before any image approvals',()=>setup(async store=>{
 const d=await generateEpisodeDrafts({projectId:'book',episodeId:'episode1',storyGoal:'미스터리',storyBible:'학교',pairCount:3},llm,store)
 assert.equal(d.plans.length,3)
 assert.deepEqual(d.plans[1].before,d.plans[0].after)
 assert.equal((await store.read('book')).pairs.length,0)
 assert.equal((await readEpisodeDrafts('book','episode1')).plans.length,3)
 const first=await activateNextEpisodeDraft('book','episode1',store)
 assert.equal(first.snapshot.pairs.length,1)
 assert.equal(first.remaining,2)
 await assert.rejects(activateNextEpisodeDraft('book','episode1',store),/approved images|approved first/)
}))
test('episode generation resumes consistently and rejects changed premises',()=>setup(async store=>{
 const opts={projectId:'book',episodeId:'episode1',storyGoal:'학교',storyBible:'',pairCount:2}
 await generateEpisodeDrafts(opts,llm,store)
 const r=await generateEpisodeDrafts(opts,llm,store)
 assert.equal(r.plans.length,2)
 await assert.rejects(generateEpisodeDrafts({...opts,storyGoal:'other'},llm,store),/conflicts/)
}))

test('one-pair planning steps persist progress for Colab model switching',()=>setup(async store=>{
 const options={projectId:'book',episodeId:'incremental',storyGoal:'비밀',storyBible:'인물 관계',pairCount:3,maxNewPairs:1}
 const a=await generateEpisodeDrafts(options,llm,store)
 assert.equal(a.plans.length,1)
 const b=await generateEpisodeDrafts(options,llm,store)
 assert.equal(b.plans.length,2)
 const c=await generateEpisodeDrafts(options,llm,store)
 assert.equal(c.plans.length,3)
 assert.deepEqual(c.plans.map(p=>p.id),['incremental_p00001','incremental_p00002','incremental_p00003'])
 const resumed=await generateEpisodeDrafts(options,llm,store)
 assert.equal(resumed.plans.length,3)
}))
test('concurrent planning for one episode is rejected instead of duplicating pairs',()=>setup(async store=>{
 let release,notify
 const entered=new Promise(resolve=>{notify=resolve})
 const pending=new Promise(resolve=>{release=resolve})
 const options={projectId:'book',episodeId:'locked',storyGoal:'비밀',storyBible:'',pairCount:2,maxNewPairs:1}
 const delayed=async messages=>{notify();await pending;return llm(messages)}
 const first=generateEpisodeDrafts(options,delayed,store)
 await entered
 await assert.rejects(generateEpisodeDrafts(options,llm,store),/planning request is active/)
 release()
 assert.equal((await first).plans.length,1)
 assert.equal((await generateEpisodeDrafts(options,llm,store)).plans.length,2)
}))
