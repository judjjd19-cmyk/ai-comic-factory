import test from 'node:test'
import assert from 'node:assert/strict'
import {uploadActorMask} from '../src/lib/webtoon/regionMasks.ts'

test('two different actor-region masks cannot overwrite each other',async()=>{
 const seen=[]
 const fakeFetch=async(_url,request)=>{
   const file=request.body.get('image')
   seen.push(file.name)
   return{ok:true,json:async()=>({name:file.name})}
 }
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4])
 const first=await uploadActorMask('http://127.0.0.1:8188',bytes,fakeFetch)
 const second=await uploadActorMask('http://127.0.0.1:8188',bytes,fakeFetch)
 assert.equal(seen.length,2)
 assert.notEqual(first,second)
 assert.match(first,/webtoon_region_[\da-f-]+\.png/)
})
