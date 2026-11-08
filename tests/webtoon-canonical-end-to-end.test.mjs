import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
import {generateEpisodeDrafts,activateNextEpisodeDraft} from '../src/lib/webtoon/episodeDrafts.ts'
import {selectReferences} from '../src/lib/webtoon/contracts.ts'
import {inspectLayout} from '../src/lib/webtoon/panelQA.ts'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=','base64')
const llm=async({userPrompt})=>{
 const q=JSON.parse(userPrompt)
 const before=q.authoritativeBefore,actor=before.actors[0]
 return JSON.stringify({middle:before,after:before,panels:[0,1].map(i=>({
   id:q.pairId+'_'+i,sceneId:before.sceneId,locationId:before.locationId,
   summary:'주인공이 대화한다',camera:'medium',events:[],
   characters:[{characterId:actor.characterId,outfitId:actor.outfitId,box:actor.box,
     facing:actor.facing,emotion:'calm',action:'speaks'}],
   bubbles:[{id:'bubble_'+i,type:'speech',speakerId:actor.characterId,text:'안녕하세요',
     box:[.66,.05,.3,.2],tailTarget:[.3,.4],readOrder:0}]
 }))})
}
test('empty project through canonical masters, LLM plans, sequential images, approval and next episode',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webtoon-real-path-'))
 const prior=process.env.WEBTOON_DATA_DIR
 process.env.WEBTOON_DATA_DIR=root
 try{
  const store=new ProjectStore(root)
  let s=await store.create('comic',{characters:[],locations:[],assets:[]})
  s=await store.stageMaster('comic',s.revision,{ownerId:'hero',kind:'identity',image:png,mime:'image/png'})
  s=await store.approveCharacter('comic',s.revision,s.catalog.assets.at(-1).id,{
    id:'hero',displayName:'민서',description:'black hair',outfitId:'uniform'
  })
  s=await store.stageMaster('comic',s.revision,{ownerId:'room',kind:'location',image:png,mime:'image/png'})
  s=await store.approveLocation('comic',s.revision,s.catalog.assets.at(-1).id,{
    id:'room',description:'school rooftop'
  })
  s=await store.updateStory('comic',s.revision,'학교의 비밀','세계관의 규칙')
  assert.equal(s.catalog.characters.length,1)
  assert.equal(s.catalog.locations.length,1)
  const draft=await generateEpisodeDrafts({projectId:'comic',episodeId:'episode1',
    storyGoal:'학교에서 발견한 비밀',storyBible:'세계관의 규칙',pairCount:1},llm,store)
  assert.equal(draft.plans.length,1)
  s=(await activateNextEpisodeDraft('comic','episode1',store)).snapshot
  const pair=s.pairs[0]
  assert.equal(s.series.episodes.length,1)
  assert.equal(s.series.episodes[0].pairIds[0],pair.plan.id)
  assert.deepEqual(selectReferences(pair.plan.panels[0],s.catalog).map(x=>x.purpose),
    ['identity','location'])
  for(let i=0;i<2;i++){
    s=await store.advancePair('comic',s.revision,pair.plan.id,i===0?'render_first':'render_second')
    assert.equal(inspectLayout(pair.plan.panels[i]).filter(x=>x.severity==='blocking').length,0)
    s=await store.stageImage('comic',s.revision,pair.plan.id,i,png,'image/png')
    assert.equal(s.pairs[0].job.status,i===0?'review_first':'review_second')
    const image=s.catalog.assets.at(-1)
    assert.equal(image.status,'draft')
    s=await store.approvePanel('comic',s.revision,pair.plan.id,i,image.id,'human reviewer')
    if(i===0){
      const refs=selectReferences(pair.plan.panels[1],s.catalog,s.approvedPanels.at(-1))
      assert.deepEqual(refs.map(x=>x.purpose),['identity','continuity','location'])
    }
  }
  assert.equal(s.pairs[0].job.status,'approved')
  s=await store.finalizeEpisode('comic',s.revision,'episode1',{
    summary:'비밀을 발견함',endingHook:'누가 숨겼는가',
    openThreads:[{id:'mystery',description:'숨겨진 비밀의 주인'}],resolveThreadIds:[]
  })
  const previous=s.series.episodes[0].handoff.finalState
  const next=await generateEpisodeDrafts({projectId:'comic',episodeId:'episode2',
    storyGoal:'비밀의 주인을 추적',storyBible:'세계관의 규칙',pairCount:1},llm,store)
  assert.deepEqual(next.plans[0].before,previous)
  assert.notEqual(next.plans[0].id,pair.plan.id)
  assert.equal((await activateNextEpisodeDraft('comic','episode2',store)).snapshot.series.episodes.length,2)
 }finally{
  if(prior===undefined)delete process.env.WEBTOON_DATA_DIR
  else process.env.WEBTOON_DATA_DIR=prior
  await rm(root,{recursive:true,force:true})
 }
})
