import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{ProjectStore}from'../src/lib/webtoon/projectStore.ts'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=','base64')
async function run(fn){
 const dir=await mkdtemp(join(tmpdir(),'webtoon-master-'))
 try{const store=new ProjectStore(dir);const initial=await store.create('book',{characters:[],locations:[],assets:[]});return await fn(store,initial,dir)}
 finally{await rm(dir,{recursive:true,force:true})}
}
test('master draft cannot condition art before approved',()=>run(async(store,s)=>{
 s=await store.stageMaster('book',s.revision,{ownerId:'hero',kind:'identity',image:png,mime:'image/png'})
 assert.equal(s.catalog.characters.length,0);assert.equal(s.catalog.assets[0].status,'draft')
 s=await store.approveCharacter('book',s.revision,s.catalog.assets[0].id,{id:'hero',displayName:'주인공',description:'black hair',outfitId:'uniform'})
 assert.equal(s.catalog.assets[0].status,'approved')
 const data=await store.readAsset('book',s.catalog.assets[0].id)
 assert.deepEqual(data.bytes,png)
 await assert.rejects(store.stageMaster('book',s.revision,{ownerId:'hero',kind:'identity',image:png,mime:'image/png'}),/already|overwrite/i)
}))
test('checksum protects approval of tampered location master',()=>run(async(store,s,dir)=>{
 s=await store.stageMaster('book',s.revision,{ownerId:'room',kind:'location',image:png,mime:'image/png'})
 await writeFile(join(dir,'book',s.catalog.assets[0].uri),Buffer.from('corrupted'))
 await assert.rejects(store.approveLocation('book',s.revision,s.catalog.assets[0].id,{id:'room',description:'classroom'}),/checksum/)
 assert.equal((await store.read('book')).catalog.locations.length,0)
}))
test('owner and revision mismatch cannot approve',()=>run(async(store,s)=>{
 s=await store.stageMaster('book',s.revision,{ownerId:'hero',kind:'identity',image:png,mime:'image/png'})
 await assert.rejects(store.approveCharacter('book',s.revision,s.catalog.assets[0].id,{id:'other',displayName:'a',description:'b',outfitId:'o'}),/exact draft/i)
 await assert.rejects(store.approveCharacter('book',0,s.catalog.assets[0].id,{id:'hero',displayName:'a',description:'b',outfitId:'o'}),/Revision conflict/i)
}))

test('a persisted image-generation prompt survives reload and links to the staged draft',()=>run(async(store,s,dir)=>{
 s=await store.recordMasterJob('book',s.revision,{
   promptId:'generated_1234567890',ownerId:'hero',kind:'identity',
   outfitId:'uniform',description:'검은 머리'
 })
 const reopened=await new ProjectStore(dir).read('book')
 assert.equal(reopened.masterJobs[0].status,'pending')
 assert.equal(reopened.masterJobs[0].promptId,'generated_1234567890')
 await assert.rejects(store.stageMaster('book',s.revision,{
   ownerId:'other',kind:'identity',outfitId:'uniform',
   image:png,mime:'image/png',promptId:'generated_1234567890'
 }),/job identity\/angle/)
 assert.equal((await store.read('book')).catalog.assets.length,0)
 s=await store.stageMaster('book',s.revision,{
   ownerId:'hero',kind:'identity',outfitId:'uniform',
   image:png,mime:'image/png',promptId:'generated_1234567890'
 })
 assert.equal(s.masterJobs[0].status,'staged')
 assert.equal(s.catalog.assets[0].status,'draft')
}))
