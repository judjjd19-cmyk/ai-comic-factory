import type {ComfyWorkflow} from './comfyReference.ts'
export interface ComfyNodeSpec {input?:{required?:Record<string,unknown>;optional?:Record<string,unknown>}}
export type ComfyNodeInfo=Record<string,ComfyNodeSpec>
const MODEL_FIELDS=new Set(['ckpt_name','lora_name','ipadapter_file','clip_name'])
/** Validate against actual /object_info before expending GPU time. */
export function validateComfyWorkflow(workflow:ComfyWorkflow,info:ComfyNodeInfo):void {
  if(!info||typeof info!=='object'||Object.keys(info).length===0)
    throw new Error('ComfyUI object_info is missing or empty')
  for(const [nodeId,node] of Object.entries(workflow)){
    const spec=info[node.class_type]
    if(!spec)throw new Error('ComfyUI node class not installed: '+node.class_type+' ('+nodeId+')')
    const required=spec.input?.required||{}
    for(const [field,fieldInfo] of Object.entries(required)){
      if(!(field in node.inputs))throw new Error('Missing required ComfyUI input '+nodeId+'.'+field)
      if(!MODEL_FIELDS.has(field))continue
      const option=Array.isArray(fieldInfo)?fieldInfo[0]:null
      const allowed=Array.isArray(option)?option:null
      const chosen=node.inputs[field]
      if(allowed&&allowed.length>0&&typeof chosen==='string'&&!allowed.includes(chosen))
        throw new Error('ComfyUI model file not installed for '+node.class_type+': '+chosen)
    }
  }
}
