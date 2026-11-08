import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,utimes,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProjectStore} from '../src/lib/webtoon/projectStore.ts'
test('interrupted Colab writer lock is recovered without overwriting project state',async()=>{
 const root=await mkdtemp(join(tmpdir(),'webtoon-recover-'))
 try{
  const store=new ProjectStore(root)
  let snapshot=await store.create('book',{characters:[],locations:[],assets:[]})
  const lock=join(root,'book','.manifest-lock')
  await mkdir(lock)
  await writeFile(join(lock,'owner.json'),JSON.stringify({pid:99999999,started:Date.now()-60000}))
  const old=new Date(Date.now()-60000)
  await utimes(lock,old,old)
  snapshot=await store.updateStory('book',snapshot.revision,'작품 줄거리','세계관 원본')
  assert.equal(snapshot.story.premise,'작품 줄거리')
  assert.equal((await store.read('book')).story.version,1)
  await mkdir(lock)
  await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,started:Date.now()}))
  await assert.rejects(store.updateStory('book',snapshot.revision,'변경',''),/active writer/)
  assert.equal((await store.read('book')).story.premise,'작품 줄거리')
 }finally{await rm(root,{recursive:true,force:true})}
})
