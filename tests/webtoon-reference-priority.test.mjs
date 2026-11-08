import test from 'node:test'
import assert from 'node:assert/strict'
import {selectReferences} from '../src/lib/webtoon/contracts.ts'
const asset=(id,kind,ownerId,extra={})=>({id,kind,ownerId,uri:'refs/'+id+'.png',
  sha256:'a'.repeat(64),status:'approved',version:1,...extra})
const catalog={
 characters:[{id:'a',version:1,displayName:'A',description:'A',outfitIds:['default'],identityReferenceId:'a_id'},
             {id:'b',version:1,displayName:'B',description:'B',outfitIds:['default'],identityReferenceId:'b_id'}],
 locations:[{id:'roof',version:1,description:'roof',referenceIds:['roof_ref']}],
 assets:[asset('a_id','identity','a'),asset('b_id','identity','b'),
  asset('roof_ref','location','roof'),asset('a_outfit','outfit','a',{outfitId:'default'}),
  asset('b_outfit','outfit','b',{outfitId:'default'}),
  asset('panelprev','previous-panel','old-panel')]
}
const panel={sceneId:'scene1',locationId:'roof',characters:[
 {characterId:'a',outfitId:'default',facing:'front'},
 {characterId:'b',outfitId:'default',facing:'front'}]}
const previous={id:'old-panel',sceneId:'scene1',assetId:'panelprev',planId:'old',approvedAt:'2026-11-08'}
test('tight reference budgets preserve both identities and prior approved panel',()=>{
 assert.throws(()=>selectReferences(panel,catalog,previous,3),/Reference budget too small for location continuity/)
 const four=selectReferences(panel,catalog,previous,4)
 assert.deepEqual(four.map(x=>x.purpose),['identity','identity','continuity','location'])
})
test('previous panels from other scenes are not used as identity or scene reference',()=>{
 const refs=selectReferences(panel,catalog,{...previous,sceneId:'elsewhere'},4)
 assert.deepEqual(refs.map(x=>x.purpose),['identity','identity','location','outfit'])
})

test('latest approved outfit/view revision is used without changing the identity anchor',()=>{
 const expanded=structuredClone(catalog)
 expanded.assets.push(asset('a_outfit_new','outfit','a',{outfitId:'default'}))
 expanded.assets.push(asset('a_front_old','view','a',{view:'front'}))
 expanded.assets.push(asset('a_front_new','view','a',{view:'front'}))
 const chosen=selectReferences(panel,expanded,undefined,8)
 assert(chosen.some(r=>r.assetId==='a_id'&&r.purpose==='identity'))
 assert(chosen.some(r=>r.assetId==='a_outfit_new'&&r.purpose==='outfit'))
 assert(!chosen.some(r=>r.assetId==='a_outfit'))
 assert(chosen.some(r=>r.assetId==='a_front_new'&&r.purpose==='view'))
 assert(!chosen.some(r=>r.assetId==='a_front_old'))
})

test('do not silently skip location or continuation when all available slots are occupied',()=>{
 assert.throws(()=>selectReferences(panel,catalog,previous,2),/continuity/)
 assert.throws(()=>selectReferences(panel,catalog,previous,3),/location continuity/)
 const selected=selectReferences(panel,catalog,previous,4)
 assert.deepEqual(selected.map(x=>x.purpose),['identity','identity','continuity','location'])
})
test('missing location master is a blocking reference failure',()=>{
 const damaged=structuredClone(catalog)
 damaged.assets.find(a=>a.id==='roof_ref').status='rejected'
 assert.throws(()=>selectReferences(panel,damaged,undefined,6),/Approved location reference/)
})
