import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
import {generatePairPlan} from '../src/lib/webtoon/pairPlanner.ts'
import {selectReferences} from '../src/lib/webtoon/contracts.ts'
import {inspectLayout} from '../src/lib/webtoon/panelQA.ts'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=','base64')
const catalog={characters:[{id:'hero',version:1,displayName:'민서',description:'short black hair',outfitIds:['uniform'],identityReferenceId:'master'}],
 locations:[{id:'roof',version:1,description:'rooftop',referenceIds:[]}],
 assets:[{id:'master',kind:'identity',ownerId:'hero',uri:'refs/master.png',sha256:'a'.repeat(64),status:'approved',version:1}]}
const scene=()=>({sceneId:'scene1',locationId:'roof',timeKey:'evening',actors:[{
 characterId:'hero',outfitId:'uniform',box:[.1,.4,.4,.5],facing:'front',heldPropIds:[],emotion:'quiet'}]})
const panel=id=>({id,sceneId:'scene1',locationId:'roof',summary:'민서의 대화',camera:'medium',events:[],
 characters:[{characterId:'hero',outfitId:'uniform',box:[.1,.4,.4,.5],facing:'front',action:'talk',emotion:'quiet'}],
 bubbles:[{id:'bubble_'+id,type:'speech',speakerId:'hero',text:'안녕',box:[.65,.05,.25,.2],tailTarget:[.3,.5],readOrder:0}]})
test('mock story LLM -> validated two panels -> approved visual references -> next pair',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webtoon-integrated-'))
 try{
  const store=new ProjectStore(dir)
  let state=await store.create('story',catalog)
  const input={pairId:'pair00001',episodeId:'episode1',storyGoal:'친구에게 비밀을 말한다',
    storyBibleSummary:'같은 학교',approvedHistorySummary:'',before:scene(),catalog:state.catalog}
  const llm=async p=>{const q=JSON.parse(p.userPrompt);return JSON.stringify({
    middle:q.authoritativeBefore,after:q.authoritativeBefore,
    panels:[panel(q.pairId+'_0'),panel(q.pairId+'_1')]})}
  const pair=await generatePairPlan(input,llm)
  assert.equal(pair.panels.length,2)
  assert.deepEqual(inspectLayout(pair.panels[0]).filter(e=>e.severity==='blocking'),[])
  state=await store.appendPair('story',state.revision,pair)
  assert.deepEqual(selectReferences(pair.panels[0],state.catalog).map(r=>r.purpose),['identity'])
  for(let index=0;index<2;index++){
    state=await store.advancePair('story',state.revision,pair.id,index===0?'render_first':'render_second')
    state=await store.advancePair('story',state.revision,pair.id,index===0?'review_first':'review_second')
    state=await store.stageImage('story',state.revision,pair.id,index,png,'image/png')
    const asset=state.catalog.assets.at(-1)
    assert.equal(asset.status,'draft')
    if(index===1){
      const refs=selectReferences(pair.panels[1],state.catalog,state.approvedPanels[0])
      assert(refs.some(r=>r.purpose==='identity'))
      assert(refs.some(r=>r.purpose==='continuity'))
    }
    state=await store.approvePanel('story',state.revision,pair.id,index,asset.id,'human')
  }
  assert.equal(state.pairs[0].job.status,'approved')
  const next=await generatePairPlan({...input,pairId:'pair00002',before:state.pairs[0].plan.after},llm)
  state=await store.appendPair('story',state.revision,next)
  assert.deepEqual(state.pairs[1].plan.before,state.pairs[0].plan.after)
  assert.equal(state.approvedPanels.length,2)
 }finally{await rm(dir,{recursive:true,force:true})}
})
