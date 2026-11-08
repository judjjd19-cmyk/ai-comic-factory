import test from 'node:test'
import assert from 'node:assert/strict'
import {buildAutoIPAdapter} from '../src/lib/webtoon/autoAdapter.ts'
const graph=()=>({'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'c.safetensors'}},
 '6':{class_type:'KSampler',inputs:{model:['1',0]}},'8':{class_type:'SaveImage',inputs:{images:['6',0]}}})
const panel={characters:[{characterId:'hero',outfitId:'uniform',action:'standing',emotion:'calm',facing:'front',box:[.05,.2,.4,.7]}]}
test('SDXL adapter uses per-character alpha mask and the sampler chain',()=>{
 const refs=[{assetId:'hero_id',purpose:'identity',characterId:'hero',image:'hero.png'},
 {assetId:'room_id',purpose:'location',image:'room.png'}]
 const v=buildAutoIPAdapter(graph(),refs,panel,{hero_id:'mask.png'})
 assert.deepEqual(v['6'].inputs.model,['webtoon_ip_1_adapter',0])
 assert.deepEqual(v['webtoon_ip_0_adapter'].inputs.attn_mask,['webtoon_ip_0_mask',0])
 assert.equal(v['webtoon_ip_0_mask'].class_type,'LoadImageMask')
 assert.equal(v['webtoon_ip_1_adapter'].inputs.attn_mask,undefined)
})
test('reject missing actor region mask and invalid ref names',()=>{
 const ref={assetId:'hero_id',purpose:'identity',characterId:'hero',image:'hero.png'}
 assert.throws(()=>buildAutoIPAdapter(graph(),[ref],panel,{}),/mask/)
 assert.throws(()=>buildAutoIPAdapter(graph(),[{...ref,image:'../escape.png'}],panel,{hero_id:'mask.png'}),/Unsafe/)
})

test('two simultaneous characters keep separate regional masks while scene and prior frame remain global',()=>{
 const actors=[{characterId:'hero',outfitId:'uniform',box:[.05,.2,.4,.7]},
   {characterId:'sidekick',outfitId:'coat',box:[.55,.2,.4,.7]}]
 const multi={characters:actors}
 const refs=[
   {assetId:'hero_face',purpose:'identity',characterId:'hero',image:'hero.png'},
   {assetId:'sidekick_face',purpose:'identity',characterId:'sidekick',image:'sidekick.png'},
   {assetId:'prev_img',purpose:'continuity',image:'prior.png'},
   {assetId:'room_ref',purpose:'location',image:'room.png'}
 ]
 const rendered=buildAutoIPAdapter(graph(),refs,multi,{
   hero_face:'hero_mask.png',sidekick_face:'sidekick_mask.png'
 })
 assert.deepEqual(rendered['webtoon_ip_0_adapter'].inputs.attn_mask,['webtoon_ip_0_mask',0])
 assert.deepEqual(rendered['webtoon_ip_1_adapter'].inputs.attn_mask,['webtoon_ip_1_mask',0])
 assert.notDeepEqual(rendered['webtoon_ip_0_mask'].inputs.image,rendered['webtoon_ip_1_mask'].inputs.image)
 assert.equal(rendered['webtoon_ip_2_adapter'].inputs.attn_mask,undefined)
 assert.equal(rendered['webtoon_ip_3_adapter'].inputs.attn_mask,undefined)
 assert.deepEqual(rendered['6'].inputs.model,['webtoon_ip_3_adapter',0])
})
