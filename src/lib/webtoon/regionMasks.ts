import sharp from 'sharp'
import {randomUUID} from 'node:crypto'
import type {Bounds} from './contracts'
import {requireLocalRuntimeURL} from './localRuntimeURLs.ts'

/** ComfyUI LoadImageMask's alpha channel is 1-alpha: punch a transparent actor region. */
export async function makeActorMask(width:number,height:number,box:Bounds):Promise<Buffer>{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>4096||height>4096)
    throw new Error('Invalid mask dimensions')
  const [x,y,w,h]=box
  if(![x,y,w,h].every(v=>Number.isFinite(v))||x<0||y<0||w<=0||h<=0||x+w>1.000001||y+h>1.000001)
    throw new Error('Invalid actor bounds')
  const rect=[x*width,y*height,w*width,h*height].map(Math.round)
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'">'+
    '<rect x="'+rect[0]+'" y="'+rect[1]+'" width="'+rect[2]+'" height="'+rect[3]+'" fill="white"/></svg>'
  return sharp({create:{width,height,channels:4,background:{r:0,g:0,b:0,alpha:1}}})
    .composite([{input:Buffer.from(svg),blend:'dest-out'}]).png().toBuffer()
}
export async function uploadActorMask(endpoint:string,data:Buffer,fetchFn:typeof fetch=fetch):Promise<string>{
  requireLocalRuntimeURL(endpoint,'ComfyUI mask upload')
  const form=new FormData()
  form.append('image',new Blob([new Uint8Array(data)],{type:'image/png'}),'webtoon_region_'+randomUUID()+'.png')
  form.append('type','input')
  const response=await fetchFn(endpoint.replace(/\/+$/,'')+'/upload/image',{method:'POST',body:form,cache:'no-store'})
  if(!response.ok)throw Error('Mask upload failed: HTTP '+response.status)
  const record=await response.json() as {name?:string;subfolder?:string}
  const filename=(record.subfolder?record.subfolder+'/':'')+(record.name||'')
  if(!/^[\w .()\/-]+\.png$/i.test(filename)||filename.includes('..'))throw Error('Unsafe uploaded mask name')
  return filename
}
