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
 const ids=selectReferences(panel,catalog,previous,3)
 assert.deepEqual(ids.map(x=>x.purpose),['identity','identity','continuity'])
 const four=selectReferences(panel,catalog,previous,4)
 assert.deepEqual(four.map(x=>x.purpose),['identity','identity','continuity','location'])
})
test('previous panels from other scenes are not used as identity or scene reference',()=>{
 const refs=selectReferences(panel,catalog,{...previous,sceneId:'elsewhere'},4)
 assert.deepEqual(refs.map(x=>x.purpose),['identity','identity','location','outfit'])
})
