import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
test('story bible is durable and does not mutate the catalog', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webtoon-story-'))
 try{
  const store=new ProjectStore(dir)
  let s=await store.create('book',{characters:[],locations:[],assets:[]})
  const catalog=structuredClone(s.catalog)
  s=await store.updateStory('book',s.revision,'학교의 비밀','시간 이동은 불가능')
  assert.equal(s.story.premise,'학교의 비밀')
  assert.equal(s.story.bible,'시간 이동은 불가능')
  assert.deepEqual(s.catalog,catalog)
  const restored=await new ProjectStore(dir).read('book')
  assert.equal(restored.story.version,1)
  await assert.rejects(store.updateStory('book',0,'수정',''),/Revision conflict/)
  const edited=await store.updateStory('book',restored.revision,'새로운 진상','세계관 사실 유지')
  assert.equal(edited.story.version,2)
  assert.equal(edited.approvedPanels.length,0)
 }finally{await rm(dir,{recursive:true,force:true})}
})
