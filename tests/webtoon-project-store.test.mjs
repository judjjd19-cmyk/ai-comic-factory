import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../src/lib/webtoon/projectStore.ts'
import { selectReferences } from '../src/lib/webtoon/contracts.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=', 'base64')
const mkcatalog = () => ({
 characters:[{id:'hero',version:1,displayName:'주인공',description:'black hair',outfitIds:['school'],identityReferenceId:'hero_face'}],
 locations:[{id:'room',version:1,description:'room',referenceIds:[]}],
 assets:[{id:'hero_face',kind:'identity',ownerId:'hero',uri:'refs/face.png',sha256:'a'.repeat(64),status:'approved',version:1}]
})
const actor=()=>({characterId:'hero',outfitId:'school',box:[.1,.1,.7,.7],facing:'front',heldPropIds:[],emotion:'calm'})
const scene=()=>({sceneId:'scene1',locationId:'room',timeKey:'d1',actors:[actor()]})
const panel=id=>({id,sceneId:'scene1',locationId:'room',summary:'talk',camera:'medium',characters:[{
 characterId:'hero',outfitId:'school',action:'talks',emotion:'calm',box:[.1,.1,.7,.7],facing:'front'}],
 bubbles:[{id:'b_'+id,type:'speech',speakerId:'hero',text:'네!',box:[.0,.0,.2,.2],tailTarget:[.25,.4],readOrder:0}],events:[]})
const plan=(id='pair1')=>({id,episodeId:'episode1',before:scene(),middle:scene(),after:scene(),panels:[panel(id+'_0'),panel(id+'_1')]})
async function temporary(run) {
 const folder=await mkdtemp(join(tmpdir(),'webtoon-state-'))
 try { return await run(new ProjectStore(folder),folder) } finally { await rm(folder,{recursive:true,force:true}) }
}
test('new project persists catalog, rejects invalid project ID and preserves immutable initial master',async()=>temporary(async(store)=>{
 await assert.rejects(store.create('../escape',mkcatalog()),/Unsafe/)
 const catalog=mkcatalog();const initial=await store.create('my_project',catalog)
 assert.equal(initial.revision,0)
 catalog.characters[0].description='MUTATION'
 assert.equal((await store.read('my_project')).catalog.characters[0].description,'black hair')
 await assert.rejects(store.create('my_project',mkcatalog()),/already exists/)
}))
test('plan requires approved preceding pair and optimistic revision',async()=>temporary(async(store)=>{
 await store.create('test',mkcatalog())
 let state=await store.appendPair('test',0,plan())
 assert.equal(state.pairs[0].job.status,'validated')
 await assert.rejects(store.appendPair('test',0,plan('pair2')),/Revision conflict/)
 await assert.rejects(store.appendPair('test',state.revision,plan('pair2')),/not approved/)
 assert.equal((await store.read('test')).pairs.length,1)
}))
test('staged images cannot become next-panel references until explicitly approved',async()=>temporary(async(store)=>{
 let state=await store.create('test',mkcatalog())
 state=await store.appendPair('test',state.revision,plan())
 state=await store.advancePair('test',state.revision,'pair1','render_first')
 state=await store.advancePair('test',state.revision,'pair1','review_first')
 state=await store.stageImage('test',state.revision,'pair1',0,png,'image/png')
 const asset=state.catalog.assets.at(-1)
 assert.equal(asset.status,'draft')
 assert.equal(selectReferences(state.pairs[0].plan.panels[1],state.catalog,{id:'pair1_0',planId:'pair1',sceneId:'scene1',assetId:asset.id,approvedAt:'now'}).some(r=>r.purpose==='continuity'),false)
 state=await store.approvePanel('test',state.revision,'pair1',0,asset.id,'human-reviewer')
 assert.equal(state.pairs[0].job.status,'first_approved')
 assert.equal(selectReferences(state.pairs[0].plan.panels[1],state.catalog,state.approvedPanels[0]).some(r=>r.purpose==='continuity'),true)
 state=await store.advancePair('test',state.revision,'pair1','render_second')
 state=await store.advancePair('test',state.revision,'pair1','review_second')
 state=await store.stageImage('test',state.revision,'pair1',1,png,'image/png')
 const second=state.catalog.assets.at(-1)
 state=await store.approvePanel('test',state.revision,'pair1',1,second.id,'human-reviewer')
 assert.equal(state.pairs[0].job.status,'approved')
 assert.equal(state.approvedPanels.length,2)
 const pair2=plan('pair2');pair2.before=state.pairs[0].plan.after
 const added=await store.appendPair('test',state.revision,pair2)
 assert.equal(added.pairs.length,2)
}))
test('invalid bytes and tampered image checksum are rejected before approval',async()=>temporary(async(store,folder)=>{
 let state=await store.create('test',mkcatalog());state=await store.appendPair('test',state.revision,plan())
 state=await store.advancePair('test',state.revision,'pair1','render_first')
 state=await store.advancePair('test',state.revision,'pair1','review_first')
 await assert.rejects(store.stageImage('test',state.revision,'pair1',0,Buffer.from('hello'), 'image/png'),/Invalid image size/)
 state=await store.stageImage('test',state.revision,'pair1',0,png,'image/png')
 const asset=state.catalog.assets.at(-1)
 await writeFile(join(folder,'test',asset.uri),Buffer.from('wrong'))
 await assert.rejects(store.approvePanel('test',state.revision,'pair1',0,asset.id,'reviewer'),/checksum mismatch/)
 assert.equal((await store.read('test')).pairs[0].job.status,'review_first')
}))