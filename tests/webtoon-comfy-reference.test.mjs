import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readApprovedReference, bindReferenceNodes, uploadReferenceImage, uploadSelectedReferences } from '../src/lib/webtoon/comfyReference.ts'

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/58BAwMCAwH+VX0AAAAASUVORK5CYII=', 'base64')
const digest=createHash('sha256').update(png).digest('hex')
const anchor={id:'hero_face',ownerId:'hero',kind:'identity',uri:'refs/face.png',sha256:digest,status:'approved',version:1}
const prior={id:'panel_prev',ownerId:'prev',kind:'previous-panel',uri:'assets/prev.png',sha256:digest,status:'approved',version:1}
const workflow=()=>({
  '1':{class_type:'LoadImage',inputs:{image:'old.png'}},
  '2':{class_type:'LoadImage',inputs:{image:'old.png'}},
  '3':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'sdxl'}},
  '4':{class_type:'IPAdapterAdvanced',inputs:{model:['3',0],image:['1',0]}},
  '5':{class_type:'IPAdapterAdvanced',inputs:{model:['4',0],image:['2',0]}},
  '6':{class_type:'KSampler',inputs:{model:['5',0],positive:['7',0],negative:['8',0]}},
  '7':{class_type:'CLIPTextEncode',inputs:{text:'a',clip:['3',1]}},
  '8':{class_type:'CLIPTextEncode',inputs:{text:'b',clip:['3',1]}},
  '9':{class_type:'VAEDecode',inputs:{samples:['6',0],vae:['3',2]}},
  '10':{class_type:'SaveImage',inputs:{images:['9',0]}}
})
const good=()=>[
  {assetId:'hero_face',purpose:'identity',characterId:'hero',image:'webtoon_abc.png'},
  {assetId:'panel_prev',purpose:'continuity',image:'webtoon_def.png'}
]
async function temporary(fn){const dir=await mkdtemp(join(tmpdir(),'comfy-ref-'));try{await mkdir(join(dir,'refs'));await mkdir(join(dir,'assets'));await writeFile(join(dir,'refs','face.png'),png);await writeFile(join(dir,'assets','prev.png'),png);return await fn(dir)}finally{await rm(dir,{force:true,recursive:true})}}
test('binds approved references to distinct connected LoadImage nodes without mutating source',()=>{
 const source=workflow();const mapped=bindReferenceNodes(source,good(),{'identity:hero':'1',continuity:'2'})
 assert.equal(mapped['1'].inputs.image,'webtoon_abc.png')
 assert.equal(mapped['2'].inputs.image,'webtoon_def.png')
 assert.equal(source['1'].inputs.image,'old.png')
})
test('unknown, duplicate and disconnected bindings fail closed',()=>{
 assert.throws(()=>bindReferenceNodes(workflow(),good(),{'identity:hero':'1'}),/Missing/)
 assert.throws(()=>bindReferenceNodes(workflow(),good(),{'identity:hero':'1',continuity:'1'}),/same LoadImage/)
 const wf=workflow();wf['11']={class_type:'LoadImage',inputs:{image:'unused.png'}}
 assert.throws(()=>bindReferenceNodes(wf,good(),{'identity:hero':'11',continuity:'2'}),/not connected/)
 assert.throws(()=>bindReferenceNodes(workflow(),good(),{'identity:hero':'3',continuity:'2'}),/LoadImage/)
})
test('reference reader checks SHA-256, approval and traversal protection',()=>temporary(async root=>{
 const read=await readApprovedReference(root,anchor)
 assert.equal(read.mime,'image/png');assert.ok(read.bytes.equals(png))
 await assert.rejects(readApprovedReference(root,{...anchor,status:'draft'}),/Unapproved/)
 await assert.rejects(readApprovedReference(root,{...anchor,sha256:'0'.repeat(64)}),/hash mismatch/)
 await assert.rejects(readApprovedReference(root,{...anchor,uri:'refs/../assets/prev.png'}),/Unsafe/)
}))
test('reference upload uses classic /upload/image and validates response',async()=>{
 let observed
 const mock=async (url,options)=>{
  observed={url,method:options.method,name:options.body.get('image').name,overwrite:options.body.get('overwrite')}
  return {ok:true,json:async()=>({name:'webtoon_'+digest.slice(0,32)+'.png',subfolder:'',type:'input'})}
 }
 const filename=await uploadReferenceImage('http://127.0.0.1:8188',anchor,png,mock)
 assert.equal(observed.url,'http://127.0.0.1:8188/upload/image')
 assert.equal(observed.method,'POST');assert.equal(observed.overwrite,'true')
 assert.equal(filename,observed.name)
 await assert.rejects(uploadReferenceImage('http://127.0.0.1:8188',{...anchor,status:'rejected'},png,mock),/unapproved/)
})
test('batch upload rejects unapproved previous panels and respects selected order',()=>temporary(async root=>{
 let uploads=0
 const mock=async()=>{uploads++;return {ok:true,json:async()=>({name:'webtoon_'+digest.slice(0,32)+'.png',type:'input',subfolder:''})}}
 const refs=await uploadSelectedReferences(root,[anchor,prior],[{assetId:'hero_face',purpose:'identity',characterId:'hero'},{assetId:'panel_prev',purpose:'continuity'}],'http://localhost:8188',mock)
 assert.equal(refs.length,2);assert.equal(uploads,2)
 await assert.rejects(uploadSelectedReferences(root,[anchor,{...prior,status:'draft'}],[{assetId:'panel_prev',purpose:'continuity'}],'http://localhost:8188',mock),/Unapproved/)
}))
test('art prompt includes character acting but never embeds LLM-written dialogue',async()=>{
 const {composePanelArtPrompt}=await import('../src/lib/webtoon/comfyReference.ts')
 const panel={id:'p1',sceneId:'s1',locationId:'room',summary:'meeting',camera:'closeup',characters:[{
  characterId:'hero',outfitId:'uniform',action:'waves',emotion:'happy',facing:'front',box:[.2,.2,.3,.4]}],
  bubbles:[{id:'b',type:'speech',speakerId:'hero',text:'안녕하세요! 대사!',box:[.0,.0,.3,.2],tailTarget:[.2,.3],readOrder:0}],events:[]}
 const catalog={characters:[{id:'hero',displayName:'민서',description:'black hair',outfitIds:['uniform']}],locations:[],assets:[]}
 const prompt=composePanelArtPrompt(panel,catalog)
 assert.ok(prompt.includes('민서')); assert.ok(prompt.includes('waves'))
 assert.ok(!prompt.includes('안녕하세요!'))
 assert.ok(prompt.includes('negative space'))
})
test('image connected only as a post-processing overlay is not accepted as a character conditioning reference',()=>{
 const wf=workflow()
 wf['11']={class_type:'LoadImage',inputs:{image:'unbound.png'}}
 wf['12']={class_type:'ImageComposite',inputs:{background:['9',0],overlay:['11',0]}}
 wf['10'].inputs.images=['12',0]
 assert.throws(()=>bindReferenceNodes(wf,good(),{
   'identity:hero':'11',continuity:'2'
 }),/does not feed sampler model or text conditioning/)
})
