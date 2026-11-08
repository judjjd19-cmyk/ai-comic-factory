import test from 'node:test'
import assert from 'node:assert/strict'
import {parseEpisodeOutline,designEpisodeOutline,outlineBeatForPair} from '../src/lib/webtoon/storyOutline.ts'
const catalog={characters:[{id:'hero'}],locations:[{id:'school'}]}
const beats=['opening','inciting','escalation','climax','hook'].map((stage,i)=>({
 stage,event:'장면 '+i,characterIds:['hero'],locationId:'school',emotionalChange:'긴장이 커짐'}))
const response=()=>JSON.stringify({episodeId:'ep1',theme:'믿음',stakes:'비밀이 드러남',beats})
test('a complete outline has a fixed dramatic arc with known people and places',()=>{
 const outline=parseEpisodeOutline(response(),'ep1',catalog)
 assert.equal(outline.beats.length,5)
 assert.equal(outlineBeatForPair(outline,0,10).stage,'opening')
 assert.equal(outlineBeatForPair(outline,9,10).stage,'hook')
})
test('invalid location, character and act order cannot enter the story pipeline',()=>{
 const a=JSON.parse(response());a.beats[2].locationId='unregistered'
 assert.throws(()=>parseEpisodeOutline(JSON.stringify(a),'ep1',catalog),/unknown character\/location/)
 const b=JSON.parse(response());b.beats[4].stage='opening'
 assert.throws(()=>parseEpisodeOutline(JSON.stringify(b),'ep1',catalog),/Invalid outline beat/)
})
test('LLM repairs invalid outline but never fakes an outline after two failures',async()=>{
 let count=0
 const result=await designEpisodeOutline('ep1','학교의 비밀','',catalog,async()=>{
   count++;return count===1?'broken':response()
 })
 assert.equal(count,2);assert.equal(result.beats[4].stage,'hook')
 await assert.rejects(designEpisodeOutline('ep1','사건','',catalog,async()=>'{bad'),/valid JSON/)
})
