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
