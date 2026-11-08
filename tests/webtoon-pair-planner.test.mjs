import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPairMessages, decodePairPlan, generatePairPlan, PairPlanValidationError } from '../src/lib/webtoon/pairPlanner.ts'
function fixture() {
 const actor = {characterId:'minseo',outfitId:'uniform',box:[.3,.2,.3,.6],facing:'front',heldPropIds:[],emotion:'calm'}
 const state = () => ({sceneId:'scene_1',locationId:'rooftop',timeKey:'evening',actors:[actor]})
 const panel = id => ({id,sceneId:'scene_1',locationId:'rooftop',summary:'talk',camera:'medium',characters:[{
   characterId:'minseo',outfitId:'uniform',action:'talk',emotion:'calm',box:[.3,.2,.3,.6],facing:'front'}],
   bubbles:[{id:'bubble_'+id,type:'speech',speakerId:'minseo',text:'안녕!',box:[.0,.0,.2,.2],tailTarget:[.3,.25],readOrder:0}],events:[]})
 const input={pairId:'pair_1',episodeId:'episode_1',storyGoal:'긴장감 있는 이야기',storyBibleSummary:'설정',approvedHistorySummary:'준호를 만남',before:state(),catalog:{
 characters:[{id:'minseo',version:1,displayName:'민서',description:'black hair',outfitIds:['uniform'],identityReferenceId:'face1'}],
 locations:[{id:'rooftop',version:1,description:'roof',referenceIds:[]}],
 assets:[{id:'face1',kind:'identity',ownerId:'minseo',uri:'f.png',sha256:'1'.repeat(64),status:'approved',version:1}]}}
 const output={middle:state(),after:state(),panels:[panel('p1'),panel('p2')]}
 return {input,output}
}
test('build prompt includes Korean scene, continuity, allowed IDs and two panels',()=>{
 const {input}=fixture();const messages=buildPairMessages(input)
 assert.ok(messages.userPrompt.includes('minseo'))
 assert.ok(messages.userPrompt.includes('긴장감'))
 assert.ok(messages.systemPrompt.includes('EXACTLY two'))
})
test('decode valid plan without allowing AI to change canonical state',()=>{
 const {input,output}=fixture();const before=JSON.stringify(input.before)
 const result=decodePairPlan('```json\n'+JSON.stringify(output)+'\n```',input)
 assert.equal(result.id,'pair_1');assert.equal(result.panels.length,2)
 assert.equal(JSON.stringify(input.before),before)
})
test('wrong speaker and invalid count are rejected',()=>{
 const {input,output}=fixture();output.panels[0].bubbles[0].speakerId='not_visible'
 assert.throws(()=>decodePairPlan(JSON.stringify(output),input),PairPlanValidationError)
 output.panels.pop()
 assert.throws(()=>decodePairPlan(JSON.stringify(output),input),/state\/panel/)
})
test('malformed JSON is rejected without silent fallback',()=>{
 const {input}=fixture();assert.throws(()=>decodePairPlan('not json',input),/valid JSON/)
})
test('model is forbidden from rewriting approved prior state',()=>{
 const {input,output}=fixture();output.before={...input.before,timeKey:'unknown'}
 assert.throws(()=>decodePairPlan(JSON.stringify(output),input),/alter authoritative/)
})
test('retry feeds validation errors to LLM and succeeds without changing pair ID',async()=>{
 const {input,output}=fixture();let calls=0
 const result=await generatePairPlan(input,async messages=>{
  calls++
  if(calls===1)return '{bad json'
  assert.ok(messages.userPrompt.includes('INVALID_JSON'))
  return JSON.stringify(output)
 })
 assert.equal(calls,2);assert.equal(result.id,input.pairId)
})
test('exhausting retries raises validation error rather than creating degraded panels',async()=>{
 const {input}=fixture();let calls=0
 await assert.rejects(generatePairPlan(input,async()=>{calls++;return '{}'},2),PairPlanValidationError)
 assert.equal(calls,2)
})
test('series panels must have pair-scoped identities and invalid model IDs are retried',async()=>{
 const {input,output}=fixture()
 input.episodeId='episode1';input.pairId='episode1_p00001'
 assert.throws(()=>decodePairPlan(JSON.stringify(output),input),/Panel IDs must equal/)
 output.panels[0].id=input.pairId+'_0'
 output.panels[1].id=input.pairId+'_1'
 const result=decodePairPlan(JSON.stringify(output),input)
 assert.deepEqual(result.panels.map(p=>p.id),['episode1_p00001_0','episode1_p00001_1'])
})
