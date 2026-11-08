import test from 'node:test'
import assert from 'node:assert/strict'
import {parseCastProposals,buildCastPrompt,proposeCast} from '../src/lib/webtoon/castPlanner.ts'
const valid=()=>JSON.stringify({characters:[{id:'hero',displayName:'주인공',appearance:'검은 머리, 짙은 갈색 눈',outfitId:'uniform'}],
  locations:[{id:'school',description:'저녁의 학교 옥상, 난간과 계단실'}]})
test('story cast produces typed, stable canonical IDs and Korean descriptions',()=>{
 const value=parseCastProposals('```json\n'+valid()+'\n```')
 assert.equal(value.characters.length,1)
 assert.equal(value.characters[0].id,'hero')
 assert.equal(value.locations[0].id,'school')
 const prompt=buildCastPrompt('학교의 비밀','미스터리')
 assert.match(prompt.systemPrompt,/Korean webtoon/)
})
test('reject duplicated IDs and malformed cast instead of inventing missing characters',()=>{
 const x=JSON.parse(valid());x.characters.push(x.characters[0])
 assert.throws(()=>parseCastProposals(JSON.stringify(x)),/Duplicate/)
 x.characters=[{...x.characters[0],id:'../escape'}]
 assert.throws(()=>parseCastProposals(JSON.stringify(x)),/Invalid character/)
 assert.throws(()=>parseCastProposals('{}'),/1-8 characters/)
})
test('LLM cast proposal retries malformed JSON and preserves returned identities',async()=>{
 let calls=0
 const result=await proposeCast('학교의 비밀','',async()=>{calls++;return calls===1?'NO_JSON':valid()})
 assert.equal(calls,2)
 assert.equal(result.characters[0].outfitId,'uniform')
})
