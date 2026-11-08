import type {PanelPlan} from './contracts.ts'
import type {ComfyWorkflow,UploadedReference} from './comfyReference.ts'

/** Add IP-Adapter conditioning to a standard SDXL API workflow without per-project hardcoded node IDs. */
export function buildAutoIPAdapter(workflow:ComfyWorkflow,refs:UploadedReference[],panel:PanelPlan,
  masks:Record<string,string>={},ipFile='ip-adapter-plus_sdxl_vit-h.safetensors',
  clipFile='CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'){
  if(!refs.length)throw Error('At least one approved identity reference required')
  const clone:ComfyWorkflow=structuredClone(workflow)
  const samplers=Object.entries(clone).filter(([,n])=>
    n.class_type==='KSampler'||n.class_type==='KSamplerAdvanced')
  const requested=process.env.COMFYUI_SAMPLER_NODE_ID
  const selected=requested?samplers.find(([id])=>id===requested):
    samplers.length===1?samplers[0]:undefined
  if(!selected)throw Error('Expected exactly one KSampler or a configured COMFYUI_SAMPLER_NODE_ID')
  const sampler=selected[1]
  if(!Array.isArray(sampler.inputs.model))throw Error('Sampler model link missing')
  const prefix='webtoon_ip_'
  if(Object.keys(clone).some(k=>k.startsWith(prefix)))throw Error('Reserved node ID collision')
  clone[prefix+'model']={class_type:'IPAdapterModelLoader',inputs:{ipadapter_file:ipFile}}
  clone[prefix+'vision']={class_type:'CLIPVisionLoader',inputs:{clip_name:clipFile}}
  let model=structuredClone(sampler.inputs.model)
  for(let i=0;i<refs.length;i++){
    const ref=refs[i]
    const base=prefix+i
    const actor=panel.characters.find(a=>a.characterId===ref.characterId)
    if((ref.purpose==='identity'||ref.purpose==='view'||ref.purpose==='outfit')&&!actor)
      throw Error('Region reference does not belong to visible actor: '+ref.assetId)
    if(!/^[\w .()\/-]+\.(png|jpg|jpeg|webp)$/i.test(ref.image)||ref.image.includes('..'))
      throw Error('Unsafe uploaded reference filename')
    clone[base+'_image']={class_type:'LoadImage',inputs:{image:ref.image}}
    const weight={identity:0.75,view:0.35,outfit:0.45,location:0.22,continuity:0.28}[ref.purpose]
    const inputs:Record<string,unknown>={model,ipadapter:[prefix+'model',0],image:[base+'_image',0],
      clip_vision:[prefix+'vision',0],weight,weight_type:'linear',combine_embeds:'concat',
      start_at:0,end_at:0.88,embeds_scaling:'V only'}
    if(actor){
      const mask=masks[ref.assetId]
      if(!mask)throw Error('Missing required actor regional mask for '+ref.assetId)
      if(!/^[\w .()\/-]+\.png$/i.test(mask)||mask.includes('..'))throw Error('Unsafe mask path')
      clone[base+'_mask']={class_type:'LoadImageMask',inputs:{image:mask,channel:'alpha'}}
      inputs.attn_mask=[base+'_mask',0]
    }
    clone[base+'_adapter']={class_type:'IPAdapterAdvanced',inputs}
    model=[base+'_adapter',0]
  }
  sampler.inputs.model=model
  return clone
}
