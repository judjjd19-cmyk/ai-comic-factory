import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePairPlan, selectReferences, transitionPairJob } from '../src/lib/webtoon/contracts.ts'

function fixture() {
 const catalog = {
  characters: [
   {id:'minseo',version:1,displayName:'민서',description:'black hair',outfitIds:['uniform'],identityReferenceId:'minseo_front'},
   {id:'junho',version:1,displayName:'준호',description:'brown hair',outfitIds:['uniform'],identityReferenceId:'junho_front'}
  ],
  locations:[{id:'rooftop',version:1,description:'school',referenceIds:['roof_master']}],
  assets:[
   {id:'minseo_front',kind:'identity',ownerId:'minseo',uri:'assets/minseo_front.png',sha256:'1'.repeat(64),status:'approved',version:1},
   {id:'junho_front',kind:'identity',ownerId:'junho',uri:'assets/junho_front.png',sha256:'2'.repeat(64),status:'approved',version:1},
   {id:'roof_master',kind:'location',ownerId:'rooftop',uri:'assets/roof.png',sha256:'3'.repeat(64),status:'approved',version:1},
   {id:'panel_0_image',kind:'previous-panel',ownerId:'panel_0',uri:'assets/panel0.png',sha256:'4'.repeat(64),status:'approved',version:1}
  ]
 }
 const actor=(characterId,outfitId='uniform')=>({characterId,outfitId,box:[.2,.2,.25,.65],facing:'right',heldPropIds:[],emotion:'surprised'})
 const base=()=>({sceneId:'scene_1',locationId:'rooftop',timeKey:'day_1',actors:[actor('minseo'),actor('junho')]})
 const panel=(id)=>({id,sceneId:'scene_1',locationId:'rooftop',summary:'surprised',camera:'medium shot',characters:[
  {characterId:'minseo',outfitId:'uniform',action:'talking',emotion:'surprised',box:[.2,.2,.25,.65],facing:'right'},
  {characterId:'junho',outfitId:'uniform',action:'listening',emotion:'neutral',box:[.6,.2,.3,.6],facing:'left'}
 ],bubbles:[{id:'bubble_'+id,type:'speech',speakerId:'minseo',text:'뭐야?',box:[.0,.0,.25,.2],tailTarget:[.25,.25],readOrder:0}],events:[]})
 return {catalog,pair:{id:'pair_1',episodeId:'episode_1',before:base(),middle:base(),after:base(),panels:[panel('panel_1'),panel('panel_2')]}}
}
const clone=(x)=>JSON.parse(JSON.stringify(x))
test('correct pair validates with zero errors',()=>{
 const {pair,catalog}=fixture()
 assert.deepEqual(validatePairPlan(pair,catalog),[])
})
test('reject nonexistent characters and wrong speech speakers',()=>{
 const {pair,catalog}=fixture(); pair.panels[0].characters[0].characterId='alien'
 pair.panels[1].bubbles[0].speakerId='ghost'
 const codes=validatePairPlan(pair,catalog).map(x=>x.code)
 assert.ok(codes.includes('UNKNOWN_CHARACTER'))
 assert.ok(codes.includes('INVALID_SPEAKER'))
})
test('reject outfit/scene/position errors and bubble overflow',()=>{
 const {pair,catalog}=fixture(); pair.middle.actors[0].outfitId='coat'
 pair.panels[0].characters[0].box=[.9,.8,.5,.3]
 pair.panels[1].locationId='other'
 const codes=validatePairPlan(pair,catalog).map(x=>x.code)
 assert.ok(codes.includes('OUTFIT_MISMATCH'))
 assert.ok(codes.includes('INVALID_BOX'))
 assert.ok(codes.includes('LOCATION_MISMATCH'))
})
test('detect duplicate read orders, conflicting prop holders, unannounced transition',()=>{
 const {pair,catalog}=fixture(); pair.panels[0].bubbles.push({...pair.panels[0].bubbles[0],id:'b2'})
 pair.after.locationId='city'
 pair.after.actors[0].heldPropIds=['phone'];pair.after.actors[1].heldPropIds=['phone']
 const codes=validatePairPlan(pair,catalog).map(x=>x.code)
 for(const code of ['READ_ORDER','CONFLICTING_PROP_HOLDER','UNDECLARED_LOCATION_CHANGE']) assert.ok(codes.includes(code),code)
})
test('reference selection prioritizes immutable masters, location and approved prior panel',()=>{
 const {pair,catalog}=fixture()
 const p=pair.panels[1]
 const refs=selectReferences(p,catalog,{id:'panel_0',assetId:'panel_0_image',sceneId:'scene_1',planId:'pair_0',approvedAt:'2026-11-08'},6)
 assert.deepEqual(refs.map(x=>x.purpose),['identity','identity','continuity','location'])
 catalog.assets.find(x=>x.id==='panel_0_image').status='rejected'
 assert.throws(()=>selectReferences(p,catalog,{id:'panel_0',assetId:'panel_0_image',sceneId:'scene_1',planId:'pair_0',approvedAt:'2026-11-08'}),/continuity reference is missing/)
})
test('missing anchor or insufficient budget blocks instead of silently omitting identity',()=>{
 const {pair,catalog}=fixture()
 assert.throws(()=>selectReferences(pair.panels[0],catalog,undefined,1),/budget/)
 catalog.assets.find(x=>x.id==='junho_front').status='rejected'
 assert.throws(()=>selectReferences(pair.panels[0],catalog),/Missing approved identity/)
})
test('approval state machine requires first panel before second and evidence for approval',()=>{
 let job={id:'pair_1',status:'planned',revision:0}
 assert.throws(()=>transitionPairJob(job,'render_second'),/Invalid/)
 for(const event of ['validate','render_first','review_first']) job=transitionPairJob(job,event)
 assert.throws(()=>transitionPairJob(job,'approve_first'),/asset ID/)
 job=transitionPairJob(job,'approve_first','first_img')
 job=transitionPairJob(job,'render_second')
 job=transitionPairJob(job,'review_second')
 job=transitionPairJob(job,'approve_second','second_img')
 assert.equal(job.status,'approved')
 assert.equal(job.revision,7)
 assert.throws(()=>transitionPairJob(job,'approve_second','new_img'),/Invalid/)
})