import test from 'node:test'
import assert from 'node:assert/strict'
import {validateComfyWorkflow} from '../src/lib/webtoon/comfyPreflight.ts'
const graph={
 '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'Illustrious-XL-v2.0.safetensors'}},
 '2':{class_type:'IPAdapterModelLoader',inputs:{ipadapter_file:'ip-adapter-plus_sdxl_vit-h.safetensors'}}
}
const info={
 CheckpointLoaderSimple:{input:{required:{ckpt_name:[['Illustrious-XL-v2.0.safetensors'],{}]}}},
 IPAdapterModelLoader:{input:{required:{ipadapter_file:[['ip-adapter-plus_sdxl_vit-h.safetensors'],{}]}}}
}
test('accepts a real installed model and required custom node inputs',()=>{
 assert.doesNotThrow(()=>validateComfyWorkflow(graph,info))
})
test('rejects missing IPAdapter plugin before expensive GPU render',()=>{
 assert.throws(()=>validateComfyWorkflow(graph,{CheckpointLoaderSimple:info.CheckpointLoaderSimple}),/not installed/)
})
test('rejects mismatched checkpoint filename',()=>{
 const invalid=structuredClone(graph);invalid['1'].inputs.ckpt_name='not-downloaded.safetensors'
 assert.throws(()=>validateComfyWorkflow(invalid,info),/model file not installed/)
})
test('requires mandatory ComfyUI node inputs',()=>{
 const invalid=structuredClone(graph);delete invalid['2'].inputs.ipadapter_file
 assert.throws(()=>validateComfyWorkflow(invalid,info),/Missing required/)
})
