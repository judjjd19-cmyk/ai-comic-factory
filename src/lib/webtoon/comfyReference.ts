/**
 * Upload approved character/location/previous-panel images to classic ComfyUI
 * and bind each one to an existing LoadImage node in a model-specific API workflow.
 * This deliberately does not guess IP-Adapter/ControlNet node graphs.
 */
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { ReferenceAsset, SelectedReference } from './contracts.ts'

export type ComfyNode = { class_type: string; inputs: Record<string, unknown> }
export type ComfyWorkflow = Record<string, ComfyNode>
export type ComfyBindings = Record<string, string>
export interface UploadedReference {
  assetId: string
  purpose: SelectedReference['purpose']
  characterId?: string
  image: string // ComfyUI LoadImage input file path
}

function safeImageUri(uri: string): boolean {
  return /^(assets|refs)\/[a-zA-Z0-9._/-]+\.(png|jpg|jpeg|webp)$/i.test(uri) &&
    !uri.split('/').includes('..')
}
function mime(uri: string): string {
  const ext=uri.toLowerCase().split('.').at(-1)
  return ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg'
}
function sha256(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
function signature(data: Buffer, fileMime: string): boolean {
  return fileMime==='image/png' ? data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    fileMime==='image/jpeg' ? data[0]===0xff&&data[1]===0xd8 :
    data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP'
}

export async function readApprovedReference(projectDirectory: string, asset: ReferenceAsset): Promise<{bytes:Buffer;mime:string}> {
  if (asset.status!=='approved' || !/^[a-f\d]{64}$/i.test(asset.sha256))
    throw new Error('Unapproved or unverified reference asset: '+asset.id)
  if (!safeImageUri(asset.uri)) throw new Error('Unsafe reference asset path')
  const root=await realpath(resolve(projectDirectory))
  const file=await realpath(resolve(root, asset.uri))
  if (!file.startsWith(root+sep)) throw new Error('Reference path escapes project directory')
  const bytes=await readFile(file)
  if (bytes.length<8 || bytes.length>20*1024*1024) throw new Error('Reference image size invalid')
  const imageMime=mime(asset.uri)
  if (!signature(bytes,imageMime)) throw new Error('Reference file is not the declared image type')
  if (sha256(bytes).toLowerCase()!==asset.sha256.toLowerCase()) throw new Error('Reference image hash mismatch')
  return {bytes,mime:imageMime}
}

export function bindingKey(ref: Pick<SelectedReference,'purpose'|'characterId'>): string {
  return (ref.purpose==='identity'||ref.purpose==='outfit'||ref.purpose==='view')
    ? ref.purpose+':'+(ref.characterId||'') : ref.purpose
}

/**
 * All selected references must map to a distinct, reachable LoadImage node;
 * otherwise fail closed rather than silently losing identity conditioning.
 */
export function bindReferenceNodes(workflow: ComfyWorkflow, refs: UploadedReference[], bindings: ComfyBindings): ComfyWorkflow {
  const clone: ComfyWorkflow=structuredClone(workflow)
  const reachable=new Set<string>()
  const walk=(id:string):void=>{
    if(reachable.has(id))return
    const node=clone[id]
    if(!node)throw new Error('Workflow contains an invalid node connection')
    reachable.add(id)
    for(const input of Object.values(node.inputs||{})){
      if(Array.isArray(input)&&input.length===2&&typeof input[0]==='string'&&Number.isInteger(input[1]))
        walk(input[0])
    }
  }
  for(const [id,node] of Object.entries(clone))if(node.class_type==='SaveImage')walk(id)
  if(!reachable.size)throw new Error('ComfyUI API workflow has no SaveImage output')
  const occupied=new Set<string>()
  for(const ref of refs){
    const key=bindingKey(ref)
    const id=bindings[key]
    if(!id)throw new Error('Missing ComfyUI reference node binding: '+key)
    if(occupied.has(id))throw new Error('Two references target the same LoadImage node: '+id)
    const node=clone[id]
    if(!node || node.class_type!=='LoadImage')throw new Error('Reference must map to a LoadImage node: '+key)
    if(!reachable.has(id))throw new Error('Reference LoadImage node is not connected to SaveImage output: '+key)
    if(!/^[\w .()\/-]+\.(png|jpe?g|webp)$/i.test(ref.image) || ref.image.includes('..'))
      throw new Error('Unsafe ComfyUI uploaded reference name')
    node.inputs.image=ref.image
    occupied.add(id)
  }
  return clone
}

/** Classic local ComfyUI endpoint: POST /upload/image (not Comfy Cloud /api). */
export async function uploadReferenceImage(endpoint: string, asset: ReferenceAsset, bytes: Buffer, fetchFn: typeof fetch = fetch): Promise<string> {
  if(asset.status!=='approved' || !/^[a-f\d]{64}$/i.test(asset.sha256) || sha256(bytes)!==asset.sha256.toLowerCase())
    throw new Error('Cannot upload unapproved or changed reference image')
  if(!safeImageUri(asset.uri))throw new Error('Unsafe reference image path')
  const url=new URL(endpoint)
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error('Invalid ComfyUI endpoint protocol')
  const imageMime=mime(asset.uri)
  if(!signature(bytes,imageMime))throw new Error('Invalid image signature')
  const extension=asset.uri.split('.').at(-1)?.toLowerCase()==='jpeg'?'jpg':asset.uri.split('.').at(-1)?.toLowerCase()
  const filename='webtoon_'+asset.sha256.slice(0,32)+'.'+extension
  const body=new FormData()
  body.append('image',new Blob([bytes],{type:imageMime}),filename)
  body.append('type','input')
  body.append('overwrite','true')
  const response=await fetchFn(endpoint.replace(/\/+$/,'')+'/upload/image',{method:'POST',body,cache:'no-store'})
  if(!response.ok)throw new Error('ComfyUI image upload failed: HTTP '+response.status)
  const result=await response.json() as {name?:unknown;subfolder?:unknown;type?:unknown}
  if(typeof result.name!=='string'||!result.name)throw new Error('ComfyUI upload response has no filename')
  const subfolder=typeof result.subfolder==='string'&&result.subfolder?result.subfolder+'/':''
  const returned=subfolder+result.name
  if(!/^[\w .()\/-]+\.(png|jpe?g|webp)$/i.test(returned) || returned.includes('..'))
    throw new Error('ComfyUI upload returned unsafe path')
  return returned
}

/** Loader used by a future pair runner after selectReferences() validation. */
export async function uploadSelectedReferences(
  projectDirectory:string,
  assets:ReferenceAsset[],
  selected:SelectedReference[],
  endpoint:string,
  fetchFn: typeof fetch=fetch,
):Promise<UploadedReference[]> {
  const byId=new Map(assets.map(a=>[a.id,a]))
  const uploaded:UploadedReference[]=[]
  for(const ref of selected){
    const asset=byId.get(ref.assetId)
    if(!asset)throw new Error('Missing reference asset: '+ref.assetId)
    const {bytes}=await readApprovedReference(projectDirectory,asset)
    const image=await uploadReferenceImage(endpoint,asset,bytes,fetchFn)
    uploaded.push({assetId:ref.assetId,purpose:ref.purpose,
      ...(ref.characterId?{characterId:ref.characterId}:{}),image})
  }
  return uploaded
}

/** Image instructions contain acting and reserved balloon space, never dialogue. */
export function composePanelArtPrompt(
  panel: import('./contracts.ts').PanelPlan,
  catalog: import('./contracts.ts').WebtoonCatalog,
  style = 'clean color Korean webtoon illustration',
): string {
  const actors=panel.characters.map(actor=>{
    const character=catalog.characters.find(c=>c.id===actor.characterId)
    if(!character)throw new Error('Cannot compose panel with unknown character')
    return [character.displayName,character.description,'outfit '+actor.outfitId,
      'acting '+actor.action,'emotion '+actor.emotion,'facing '+actor.facing,
      'approximate screen box '+actor.box.join('/')].join(', ')
  })
  const spaces=panel.bubbles.map(bubble=>'leave uncluttered negative space at '+bubble.box.join('/'))
  return [style,'single comic panel','no words, letters, or captions',panel.summary,
    'camera: '+panel.camera, ...actors,...spaces].filter(Boolean).join('; ')
}