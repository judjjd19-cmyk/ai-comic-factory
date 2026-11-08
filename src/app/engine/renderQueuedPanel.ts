import 'server-only'

import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { ProjectStore } from '@/lib/webtoon/projectStore'
import { selectReferences } from '@/lib/webtoon/contracts'
import { uploadSelectedReferences, composePanelArtPrompt, type ComfyBindings } from '@/lib/webtoon/comfyReference'
import { submitComfyUI } from './comfyui'
import { makeActorMask,uploadActorMask } from '@/lib/webtoon/regionMasks'

/**
 * Server-side entry point for an APPROVED-master, sequential two-panel job.
 * Does not approve any output. Approval and QA are separate explicit stages.
 */
export async function renderQueuedPanel({ projectId, pairId, panelIndex, width, height, stylePrompt = '' }: {
  projectId: string; pairId: string; panelIndex: 0 | 1; width: number; height: number; stylePrompt?: string
}) {
  const store=new ProjectStore()
  const snapshot=await store.read(projectId) // rejects unsafe project IDs
  const pair=snapshot.pairs.find(record=>record.plan.id===pairId)
  if(!pair)throw new Error('Pair is not in the production queue')
  if(panelIndex!==0&&panelIndex!==1)throw new Error('Panel index must be 0 or 1')
  const required=panelIndex===0?'rendering_first':'rendering_second'
  if(pair.job.status!==required)throw new Error('Panel must be in the correct rendering state')
  const panel=pair.plan.panels[panelIndex]
  const previous=panelIndex===0
    ? snapshot.approvedPanels.at(-1)
    : snapshot.approvedPanels.find(p=>p.planId===pairId&&p.id===pair.plan.panels[0].id)
  if(panelIndex===1&&!previous)throw new Error('Cannot render second panel before first approved')
  const budget=Number(process.env.WEBTOON_REFERENCE_BUDGET||6)
  if(!Number.isInteger(budget)||budget<1||budget>8)
    throw new Error('WEBTOON_REFERENCE_BUDGET must be 1-8')
  const selected=selectReferences(panel,snapshot.catalog,previous,budget)
  const projectRoot=resolve(process.env.WEBTOON_DATA_DIR||join(process.cwd(),'webtoon-data'),projectId)
  const endpoint=process.env.COMFYUI_API_URL||'http://127.0.0.1:8188'
  const uploaded=await uploadSelectedReferences(projectRoot,snapshot.catalog.assets,selected,endpoint)
  const prompt=composePanelArtPrompt(panel,snapshot.catalog,stylePrompt||'clean color Korean webtoon illustration')
  if((process.env.COMFYUI_REFERENCE_MODE||'auto')==='auto'){
    const masks:Record<string,string>={}
    for(const ref of uploaded){
      if(!ref.characterId)continue
      const actor=panel.characters.find(a=>a.characterId===ref.characterId)
      if(!actor)throw Error('Reference does not correspond to a visible actor')
      masks[ref.assetId]=await uploadActorMask(endpoint,await makeActorMask(width,height,actor.box))
    }
    return submitComfyUI(prompt,width,height,{uploaded,auto:{panel,masks}})
  }
  const path=process.env.COMFYUI_REFERENCE_BINDINGS_PATH||'comfyui/reference-bindings.json'
  const raw=JSON.parse(await readFile(resolve(process.cwd(),path),'utf8')) as unknown
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid ComfyUI reference node bindings')
  const bindings=raw as ComfyBindings
  if(Object.values(bindings).some(value=>typeof value!=='string'))throw new Error('ComfyUI reference node IDs must be strings')
  return submitComfyUI(prompt,width,height,{uploaded,bindings})
}