"use client"

import {useCallback,useEffect,useRef,useState} from 'react'
import type {ProjectSnapshot} from '@/lib/webtoon/projectStore'
import type {BubblePlan} from '@/lib/webtoon/contracts'
import type {CastProposals} from '@/lib/webtoon/castPlanner'
import {episodeCompletionReady,draftEpisodeSummary} from '@/lib/webtoon/seriesNarrative'
import {nextEpisodeId} from '@/lib/webtoon/seriesLoop'

type ProjectListItem={projectId:string;revision:number;characters:number;pairs:number}
type ApiReply={ok:boolean;data?:any;error?:string}
const assetUrl=(projectId:string,assetId:string)=>
  '/api/webtoon/asset?projectId='+encodeURIComponent(projectId)+'&assetId='+encodeURIComponent(assetId)
const boxPct=(b:[number,number,number,number])=>({
  left:(b[0]*100)+'%',top:(b[1]*100)+'%',width:(b[2]*100)+'%',height:(b[3]*100)+'%'
})
async function request(action:string,params:Record<string,unknown>):Promise<any>{
  const response=await fetch('/api/webtoon/command',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action,...params}),
  })
  const json=await response.json() as ApiReply
  if(!response.ok||!json.ok)throw new Error(json.error||'Studio command failed')
  return json.data
}
async function fileData(file:File):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))
    throw new Error('PNG/JPEG/WebP 이미지만 가능')
  if(file.size>20*1024*1024)throw new Error('이미지가 20MB를 초과함')
  return new Promise((resolve,reject)=>{
    const reader=new FileReader()
    reader.onload=()=>resolve(String(reader.result))
    reader.onerror=()=>reject(reader.error)
    reader.readAsDataURL(file)
  })
}
function BubblePositionEditor({bubble,initialBox,onSave}:{
  bubble:BubblePlan;initialBox:[number,number,number,number];
  onSave:(box:[number,number,number,number])=>void
}){
  const [box,setBox]=useState<[number,number,number,number]>(initialBox)
  useEffect(()=>{setBox(initialBox)},[initialBox[0],initialBox[1],initialBox[2],initialBox[3]])
  const labels=['x','y','width','height'] as const
  return <div className="border rounded p-2 text-xs space-y-2">
    <strong>말풍선 {bubble.id} · {bubble.speakerId||'나레이션'}</strong>
    <div className="grid grid-cols-4 gap-2">
      {labels.map((label,i)=><label key={label} className="flex flex-col gap-1">
        {label}<input type="number" step={0.01} min={0} max={1} value={box[i]}
          className="min-w-0 border rounded p-1"
          onChange={e=>setBox(prev=>{
            const changed=[...prev] as [number,number,number,number]
            changed[i]=Number(e.target.value);return changed
          })}/></label>)}
    </div>
    <button className="rounded border px-2 py-1" onClick={()=>onSave(box)}>말풍선 위치·크기 적용</button>
  </div>
}
export default function WebtoonStudio(){
  const [authorized,setAuthorized]=useState<boolean|null>(null)
  const [studioToken,setStudioToken]=useState('')
  const [projects,setProjects]=useState<ProjectListItem[]>([])
  const [projectId,setProjectId]=useState('')
  const [newId,setNewId]=useState('webtoon1')
  const [snapshot,setSnapshot]=useState<ProjectSnapshot|null>(null)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('기준 이미지 등록 → 콘티 2컷 생성 → 작화 → 승인')
  const [ownerId,setOwnerId]=useState('hero')
  const [displayName,setDisplayName]=useState('주인공')
  const [description,setDescription]=useState('검은 머리, 짙은 갈색 눈, 현대적 교복')
  const [outfitId,setOutfitId]=useState('uniform')
  const [kind,setKind]=useState<'identity'|'location'|'view'|'outfit'>('identity')
  const [view,setView]=useState<'front'|'left'|'right'|'back'>('front')
  const [file,setFile]=useState<File|null>(null)
  const [draftId,setDraftId]=useState('')
  const [generated,setGenerated]=useState('')
  const [masterPromptId,setMasterPromptId]=useState('')
  const [masterContext,setMasterContext]=useState<{
    ownerId:string;kind:'identity'|'location'|'view'|'outfit';view:string;outfitId:string
  }|null>(null)
  const [storyGoal,setStoryGoal]=useState('두 주인공이 오래된 비밀을 발견하는 미스터리 웹툰')
  const [episodeId,setEpisodeId]=useState('episode1')
  const [episodePairs,setEpisodePairs]=useState(10)
  const [autoContinue,setAutoContinue]=useState(false)
  const [finalSynopsis,setFinalSynopsis]=useState('')
  const [finalHook,setFinalHook]=useState('')
  const [openThreadsText,setOpenThreadsText]=useState('')
  const [resolveThreadsText,setResolveThreadsText]=useState('')
  const [relationshipNotesText,setRelationshipNotesText]=useState('')
  const [remainingDrafts,setRemainingDrafts]=useState<number|null>(null)
  const [episodeOutline,setEpisodeOutline]=useState<any>(null)
  const [storyBible,setStoryBible]=useState('')
  const [loadedStoryVersion,setLoadedStoryVersion]=useState<string>('')
  const [castSuggestions,setCastSuggestions]=useState<CastProposals|null>(null)
  const [reviewCheck,setReviewCheck]=useState(false)
  const [rejectReason,setRejectReason]=useState('인물 외형 또는 구도가 콘티와 다름')
  const [qaIssues,setQaIssues]=useState<Array<{severity:string;code:string;message:string}>>([])
  const stripRef=useRef<HTMLDivElement>(null)
  const renderPollingRef=useRef(false)
  const masterPollingRef=useRef(false)
  const autoActionRef=useRef('')
  const [pollFailed,setPollFailed]=useState(false)
  const cancelPlanningRef=useRef(false)

  const refresh=useCallback(async(id=projectId)=>{
    try{
      const url='/api/webtoon/command'+(id?'?projectId='+encodeURIComponent(id):'')
      const res=await fetch(url,{cache:'no-store'})
      const reply=await res.json() as ApiReply
      if(!res.ok||!reply.ok)throw new Error(reply.error||'Project request failed')
      if(id)setSnapshot(reply.data as ProjectSnapshot)
      else setProjects(reply.data as ProjectListItem[])
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}
  },[projectId])
  useEffect(()=>{
    void fetch('/api/webtoon/auth',{cache:'no-store'})
      .then(r=>r.json()).then(d=>setAuthorized(d.authenticated===true)).catch(()=>setAuthorized(false))
  },[])
  useEffect(()=>{if(authorized)void refresh(projectId)},[authorized,projectId,refresh])
  const login=async()=>{
    setBusy(true)
    try{
      const result=await fetch('/api/webtoon/auth',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({token:studioToken})})
      const data=await result.json()
      if(!result.ok||!data.ok)throw Error(data.error||'Invalid token')
      setAuthorized(true);setStudioToken('');setMessage('Webtoon Studio authenticated')
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }

  const run=async(action:string,params:Record<string,unknown>={},onDone?:(data:any)=>void)=>{
    if(busy)return
    setBusy(true);setMessage(action+' 실행 중')
    try{
      const data=await request(action,{...(projectId?{projectId}:{}),...params})
      if(data?.catalog&&data?.pairs)setSnapshot(data as ProjectSnapshot)
      else if(data?.snapshot?.catalog)setSnapshot(data.snapshot as ProjectSnapshot)
      if(onDone)onDone(data)
      setMessage(action+' 완료')
      if(action==='create')await refresh('')
      if(action==='startPanel'||action==='pollPanel')await refresh(projectId)
    }catch(e){setMessage('오류: '+(e instanceof Error?e.message:String(e)))}
    finally{setBusy(false)}
  }
  const selectedMasterDraft=snapshot?.catalog.assets.find(a=>a.id===draftId)
  const activeEpisode=snapshot?.series?.episodes.find(e=>e.status==='producing')
  const selectedEpisode=snapshot?.series?.episodes.find(e=>e.id===episodeId)
  const episodePairsInProject=snapshot?.pairs.filter(p=>p.plan.episodeId===episodeId)||[]
  const currentPair=snapshot?.pairs.at(-1)
  const lastPair=currentPair?.plan.episodeId===episodeId?currentPair:undefined
  const episodeReady=snapshot&&selectedEpisode?episodeCompletionReady(selectedEpisode,
    snapshot.pairs,new Set(snapshot.approvedPanels.map(p=>p.id))):null
  useEffect(()=>{
    if(!snapshot?.story)return
    const key=snapshot.projectId+':'+snapshot.story.version
    if(key===loadedStoryVersion)return
    setStoryGoal(snapshot.story.premise)
    setStoryBible(snapshot.story.bible)
    setLoadedStoryVersion(key)
  },[snapshot?.projectId,snapshot?.story?.version,loadedStoryVersion])
  const assetForPanel=(panelId:string)=>snapshot?.catalog.assets.filter(a=>
    a.kind==='previous-panel'&&a.ownerId===panelId&&(a.status==='draft'||a.status==='approved')).at(-1)
  const saveBubble=async(panelId:string,bubble:BubblePlan,text:string,box=bubble.box)=>{
    if(!snapshot)return
    await run('editBubble',{panelId,bubbleId:bubble.id,text,box})
  }
  const stageMaster=async()=>{
    if(!snapshot)return
    let dataUri=''
    if(generated && masterContext &&
       (masterContext.ownerId!==ownerId||masterContext.kind!==kind||
        masterContext.view!==view||masterContext.outfitId!==outfitId)){
      setMessage('생성된 원본의 캐릭터·종류가 변경됐어. 해당 원본의 설정으로 되돌리거나 다시 생성해.')
      return
    }
    try{dataUri=generated||await fileData(file as File)}
    catch(e){setMessage(e instanceof Error?e.message:String(e));return}
    await run('stageMaster',{revision:snapshot.revision,ownerId,kind,outfitId,view,dataUri},data=>{
      const latest=data.catalog.assets.at(-1)
      if(latest)setDraftId(latest.id)
      setReviewCheck(false)
    })
  }
  const approveMaster=async()=>{
    if(!snapshot||!selectedMasterDraft||!reviewCheck)return
    const action=selectedMasterDraft.kind==='identity'?'approveCharacter':selectedMasterDraft.kind==='location'?'approveLocation':'approveSupplement'
    await run(action,{revision:snapshot.revision,assetId:draftId,ownerId,displayName,
      description,outfitId},()=>{setDraftId('');setGenerated('');setFile(null);setMasterContext(null);setMasterPromptId('');setReviewCheck(false)})
  }
  const planPair=async()=>{
    if(!snapshot)return
    await run('planPair',{storyGoal,episodeId,storyBibleSummary:storyBible,pairCount:episodePairs,
      locationId:snapshot.catalog.locations[0]?.id})
  }
  const planEpisode=async()=>{
    if(!snapshot||busy)return
    cancelPlanningRef.current=false
    setBusy(true)
    try{
      let previous=-1
      for(let attempt=0;attempt<episodePairs&&!cancelPlanningRef.current;attempt++){
        const data=await request('planEpisodeStep',{projectId,storyGoal,episodeId,
          storyBibleSummary:storyBible,pairCount:episodePairs,
          locationId:snapshot.catalog.locations[0]?.id})
        const produced=data.plans.length
        if(produced===previous)throw new Error('No progress during episode planning')
        previous=produced
        setRemainingDrafts(produced-data.cursor)
        setMessage('회차 콘티 '+produced+'/'+episodePairs+'쌍 저장됨')
        if(produced>=episodePairs)break
      }
      if(cancelPlanningRef.current)setMessage('회차 콘티 생성 중단됨. 저장된 쌍에서 이어서 재시작할 수 있음.')
    }catch(e){setMessage('회차 계획 오류: '+String(e))}
    finally{setBusy(false);cancelPlanningRef.current=false}
  }
  const activateDraft=async()=>{
    await run('activateDraft',{episodeId},data=>{
      if(data.snapshot)setSnapshot(data.snapshot)
      setRemainingDrafts(data.remaining)
    })
  }
  const finalizeCurrentEpisode=async()=>{
    if(!snapshot||!selectedEpisode||!episodeReady?.ready)return
    try{
    const openThreads=openThreadsText.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
      const divider=line.indexOf('|')
      if(divider<1)throw new Error('복선 형식: thread_id | 설명')
      return{id:line.slice(0,divider).trim(),description:line.slice(divider+1).trim()}
    })
    const resolveThreadIds=resolveThreadsText.split(/[,\n]/).map(x=>x.trim()).filter(Boolean)
    const relationshipUpdates=relationshipNotesText.split('\n').map(x=>x.trim()).filter(Boolean).map(line=>{
      const sep=line.indexOf('|')
      const characters=line.slice(0,sep).split(',').map(x=>x.trim())
      if(sep<0||characters.length!==2)throw new Error('관계 형식: 인물ID1,인물ID2 | 변화')
      return{characterIds:characters as [string,string],note:line.slice(sep+1).trim()}
    })
    await run('finalizeEpisode',{episodeId,summary:finalSynopsis||draftEpisodeSummary(episodePairsInProject.map(p=>p.plan)),
      endingHook:finalHook||selectedEpisode.outline?.beats.at(-1)?.event||
        episodePairsInProject.at(-1)?.plan.panels[1].summary||'회차 종료',
      openThreads,resolveThreadIds,relationshipUpdates},data=>{
      const next=nextEpisodeId(data.series)
      setEpisodeId(next)
      setRemainingDrafts(null);setEpisodeOutline(null);setFinalSynopsis('');setFinalHook('')
      setOpenThreadsText('');setResolveThreadsText('');setRelationshipNotesText('')
      setMessage('회차 확정. 다음 화 '+next+'를 시작할 수 있어.')
    })
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}
  }
  useEffect(()=>{
    if(!authorized||!projectId||!episodeId)return
    let disposed=false
    void request('draftStatus',{projectId,episodeId}).then(data=>{
      if(disposed)return
      setRemainingDrafts(data?data.plans.length-data.cursor:null)
      setEpisodeOutline(data?.outline||null)
    }).catch(()=>{if(!disposed)setRemainingDrafts(null)})
    return()=>{disposed=true}
  },[authorized,projectId,episodeId])
  useEffect(()=>{
    if(!authorized||!autoContinue||busy||!snapshot||!activeEpisode||!lastPair||
      activeEpisode.id!==episodeId)return
    const status=lastPair.job.status
    let action:string|undefined,parameters:Record<string,unknown>={}
    if(status==='validated'){
      action='startPanel';parameters={pairId:lastPair.plan.id,panelIndex:0}
    }else if(status==='first_approved'){
      action='startPanel';parameters={pairId:lastPair.plan.id,panelIndex:1}
    }else if(status==='approved'&&
      activeEpisode.pairIds.length<activeEpisode.targetPairs&&remainingDrafts!==null&&remainingDrafts>0){
      action='activateDraft';parameters={episodeId}
    }
    if(!action)return
    const key=projectId+'|'+snapshot.revision+'|'+lastPair.plan.id+'|'+status+'|'+action
    if(autoActionRef.current===key)return
    autoActionRef.current=key
    void run(action,parameters,data=>{
      if(data?.snapshot)setSnapshot(data.snapshot)
      if(typeof data?.remaining==='number')setRemainingDrafts(data.remaining)
    })
  },[authorized,autoContinue,busy,projectId,episodeId,snapshot?.revision,
    lastPair?.plan.id,lastPair?.job.status,remainingDrafts])
  const startRender=async(pairId:string,index:0|1)=>{
    setPollFailed(false)
    await run('startPanel',{pairId,panelIndex:index})
  }
  const resetRender=async(pairId:string,index:0|1)=>{
    await run('resetPanelTask',{pairId,panelIndex:index,
      reason:'ComfyUI interrupted or an earlier image job is no longer available'},()=>{
        // Hold polling until a replacement task has actually been submitted.
        setPollFailed(true)
        setMessage('기존 작업을 보관했어. 해당 컷 작업을 다시 제출해.')
      })
  }
  const pollRender=async(pairId:string,index:0|1)=>{
    await run('pollPanel',{pairId,panelIndex:index},result=>{
      if(result.status==='pending')setMessage('ComfyUI 렌더링 진행 중')
      else if(result.status==='error')setMessage(result.error||'ComfyUI 오류')
    })
  }
  // Poll only while a ComfyUI job is rendering. Human QA/approval remains mandatory.
  useEffect(()=>{
    if(!authorized||!projectId||busy||pollFailed||!lastPair)return
    const status=lastPair.job.status
    const orphanFirst=status==='review_first'&&!assetForPanel(lastPair.plan.panels[0].id)
    const orphanSecond=status==='review_second'&&!assetForPanel(lastPair.plan.panels[1].id)
    if(status!=='rendering_first'&&status!=='rendering_second'&&!orphanFirst&&!orphanSecond)return
    const pairId=lastPair.plan.id
    const index:0|1=(status==='rendering_first'||orphanFirst)?0:1
    let disposed=false
    const timer=setInterval(()=>{
      if(renderPollingRef.current)return
      renderPollingRef.current=true
      void request('pollPanel',{projectId,pairId,panelIndex:index})
        .then(async data=>{
          if(disposed)return
          if(data.status==='review'){
            setPollFailed(false)
            if(data.snapshot)setSnapshot(data.snapshot)
            else await refresh(projectId)
            setMessage('작화 완료. 원본·대사·인물 일치를 검수한 뒤 승인해.')
          }else if(data.status==='error'){
            setPollFailed(true)
            setMessage('이미지 생성 오류: '+(data.error||'알 수 없는 오류'))
          }
        }).catch(e=>{
          if(!disposed)setMessage('렌더링 상태 조회 실패: '+String(e))
        }).finally(()=>{renderPollingRef.current=false})
    },3500)
    return()=>{disposed=true;clearInterval(timer)}
  },[authorized,projectId,busy,pollFailed,lastPair?.plan.id,lastPair?.job.status,refresh])
  useEffect(()=>{
    if(!authorized||busy||!masterPromptId||generated)return
    let cancelled=false
    const timer=setInterval(()=>{
      if(masterPollingRef.current)return
      masterPollingRef.current=true
      void request('pollMaster',{promptId:masterPromptId})
        .then(data=>{
          if(cancelled)return
          if(data.status==='completed'&&data.assetUrl){
            setGenerated(data.assetUrl)
            setMasterPromptId('')
            setMessage('기준 이미지 초안 생성 완료. 이미지 확인 후 등록·승인해.')
          }else if(data.status==='error'){
            setMessage('기준 이미지 생성 오류: '+data.error)
            setMasterPromptId('')
          }
        }).catch(e=>{if(!cancelled)setMessage('기준 이미지 상태 조회 실패: '+String(e))})
        .finally(()=>{masterPollingRef.current=false})
    },3500)
    return()=>{cancelled=true;clearInterval(timer)}
  },[authorized,busy,masterPromptId,generated])
  const approvePanel=async(pairId:string,index:0|1,assetId:string)=>{
    if(!reviewCheck)return
    await run('approvePanel',{pairId,panelIndex:index,assetId},()=>setReviewCheck(false))
  }
  const exportEpisodeManifest=()=>{
    if(!snapshot)return
    const episode=snapshot.series?.episodes.find(e=>e.id===episodeId)
    if(!episode){setMessage('선택한 화가 존재하지 않아.');return}
    const pairs=snapshot.pairs.filter(pair=>pair.plan.episodeId===episode.id)
    const approved=new Set(snapshot.approvedPanels.map(p=>p.id))
    const result={
      schemaVersion:1,projectId:snapshot.projectId,episode,story:snapshot.story,
      pairs:pairs.map(pair=>({plan:pair.plan,job:pair.job,
        panels:pair.plan.panels.map((panel,index)=>({
          panelId:panel.id,approved:approved.has(panel.id),
          imageAssetId:index===0?pair.job.firstApprovedAssetId:pair.job.secondApprovedAssetId,
          dialogue:panel.bubbles.map(b=>({
            id:b.id,type:b.type,speakerId:b.speakerId,readOrder:b.readOrder,
            text:snapshot.bubbleOverrides?.[panel.id]?.[b.id]?.text??b.text,
            box:snapshot.bubbleOverrides?.[panel.id]?.[b.id]?.box??b.box,
            tailTarget:b.tailTarget
          }))
        }))})),
      unresolvedThreads:snapshot.series?.threads.filter(x=>x.status==='open')||[],
      relationships:snapshot.series?.relationships||[]
    }
    const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'})
    const link=document.createElement('a')
    const url=URL.createObjectURL(blob)
    link.href=url;link.download=projectId+'-'+episodeId+'-manifest.json';link.click()
    URL.revokeObjectURL(url)
    setMessage(episodeId+' 원고·말풍선·서사 상태 JSON을 저장함')
  }
  const exportImage=async()=>{
    const root=stripRef.current
    if(!root||!snapshot)return
    const elements=Array.from(root.children).filter((x):x is HTMLElement=>x instanceof HTMLElement)
    if(!elements.length){setMessage('선택한 화에 승인된 컷이 없어.');return}
    setBusy(true)
    try{
      const html2canvas=(await import('html2canvas')).default
      const perPart=10
      const parts=Math.ceil(elements.length/perPart)
      for(let part=0;part<parts;part++){
        const selection=elements.slice(part*perPart,(part+1)*perPart)
        const panels=[]
        for(const element of selection){
          const canvas=await html2canvas(element,{backgroundColor:'#ffffff',useCORS:true,scale:1})
          panels.push(canvas)
        }
        const width=Math.max(...panels.map(c=>c.width))
        const gap=24
        const height=panels.reduce((sum,c)=>sum+Math.round(c.height*width/c.width),0)+gap*(panels.length-1)
        if(height>30000||width>8192)throw Error('웹툰 이미지 크기가 브라우저 최대치를 초과함')
        const result=document.createElement('canvas')
        result.width=width;result.height=height
        const ctx=result.getContext('2d')
        if(!ctx)throw Error('Canvas context unavailable')
        ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height)
        let y=0
        for(const canvas of panels){
          const scaledHeight=Math.round(canvas.height*width/canvas.width)
          ctx.drawImage(canvas,0,y,width,scaledHeight)
          y+=scaledHeight+gap
        }
        const blob=await new Promise<Blob>((resolve,reject)=>
          result.toBlob(value=>value?resolve(value):reject(Error('PNG serialization failed')),'image/png'))
        const url=URL.createObjectURL(blob)
        const link=document.createElement('a')
        link.href=url
        link.download=projectId+'-'+episodeId+'-part'+String(part+1).padStart(2,'0')+'.png'
        link.click()
        await new Promise(resolve=>setTimeout(resolve,120))
        URL.revokeObjectURL(url)
      }
      setMessage(episodeId+' 세로 웹툰 '+elements.length+'컷을 '+parts+'개 PNG로 저장함')
    }catch(e){setMessage('화별 내보내기 오류: '+String(e))}
    finally{setBusy(false)}
  }

  const bubbleOverlay=(panelId:string,bubble:BubblePlan,editable=true)=>{
    const override=snapshot?.bubbleOverrides?.[panelId]?.[bubble.id]
    const box=override?.box||bubble.box
    const content=override?.text??bubble.text
    const boxType=bubble.type==='narration'?'rounded-lg':bubble.type==='thought'?'rounded-[48%] border-dashed':'rounded-[50%]'
    const tailPoint=bubble.tailTarget
    const tail=tailPoint&&bubble.type!=='narration'&&
      Number.isFinite(tailPoint[0])&&Number.isFinite(tailPoint[1])
      ?[100*(tailPoint[0]-box[0])/box[2],100*(tailPoint[1]-box[1])/box[3]]:null
    return <div key={bubble.id} className={'absolute z-10 flex flex-col items-center justify-center bg-white border-2 border-stone-950 p-2 shadow-sm text-center text-stone-900 '+boxType}
      style={{...boxPct(box),fontSize:'clamp(10px,1.2vw,17px)',overflow:'visible',wordBreak:'keep-all'}}>
      {tail&&<svg aria-hidden="true" className="absolute pointer-events-none overflow-visible"
        style={{left:0,top:0,width:'100%',height:'100%',zIndex:-1}}
        viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={'M 45 82 L '+tail[0]+' '+tail[1]+' L 57 85 Z'}
          stroke="#1c1917" strokeWidth="1.5" fill="white"/>
      </svg>}
      {editable?
        <textarea key={content} defaultValue={content} aria-label={bubble.id+' 대사'} rows={2}
          onBlur={event=>{if(event.target.value!==content)void saveBubble(panelId,bubble,event.target.value,box)}}
          className="w-full h-full resize-none bg-transparent text-center leading-snug outline-none break-keep"/>:
        <div className="w-full text-center leading-snug whitespace-pre-wrap break-keep"
          style={{overflowWrap:'anywhere'}}>{content}</div>}
      {editable&&<span className="absolute -bottom-4 text-[9px] bg-white px-1 text-stone-500">
        {bubble.speakerId||'나레이션'}</span>}
    </div>
  }
  const panelCard=(pair:ProjectSnapshot['pairs'][number],idx:0|1)=>{
    const panel=pair.plan.panels[idx]
    const asset=assetForPanel(panel.id)
    return <div key={panel.id} className="border rounded-xl bg-stone-50 overflow-hidden">
      <div className="px-3 py-2 text-xs text-stone-600 flex justify-between">
        <span>{panel.id} · {panel.camera}</span><span>{asset?.status||'미생성'}</span>
      </div>
      <div className="relative w-full aspect-[3/4] bg-stone-200">
        {asset&&<img src={assetUrl(projectId,asset.id)} alt={panel.summary} className="absolute inset-0 w-full h-full object-cover"/>}
        {asset&&panel.bubbles.slice().sort((a,b)=>a.readOrder-b.readOrder).map(b=>bubbleOverlay(panel.id,b,selectedEpisode?.status!=='completed'))}
        {!asset&&<div className="absolute inset-0 grid place-items-center text-sm text-stone-500">{panel.summary}</div>}
      </div>
      <div className="px-3 py-3 text-xs text-stone-700 space-y-2">
        <p>{panel.summary}</p>
        {selectedEpisode?.status!=='completed'&&panel.bubbles.map(b=>{
          const override=snapshot?.bubbleOverrides?.[panel.id]?.[b.id]
          return <BubblePositionEditor key={b.id} bubble={b}
            initialBox={override?.box||b.box}
            onSave={box=>void saveBubble(panel.id,b,override?.text??b.text,box)}/>
        })}
      </div>
    </div>
  }

  if(authorized===null)return <main className="p-8">제작 화면 인증 확인 중…</main>
  if(!authorized)return <main className="min-h-screen bg-stone-100 p-6 flex items-center justify-center">
    <form onSubmit={e=>{e.preventDefault();void login()}} className="bg-white rounded-xl border p-6 w-full max-w-md space-y-4">
      <h1 className="text-xl font-bold">Webtoon Studio 인증</h1>
      <p className="text-sm">WEBTOON_STUDIO_TOKEN 환경변수의 비밀 토큰을 입력해.</p>
      <input aria-label="Studio secret" type="password" required autoComplete="off"
        className="border rounded p-2 w-full" value={studioToken}
        onChange={e=>setStudioToken(e.target.value)}/>
      <button type="submit" disabled={busy} className="rounded bg-stone-900 text-white p-2 w-full">로그인</button>
      <p role="alert" className="text-sm text-red-700">{message}</p>
    </form>
  </main>
  return <main className="min-h-screen bg-[#f5f2ec] text-stone-900 p-4 md:p-8">
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-3xl font-bold">Webtoon Studio</h1><p className="text-stone-600">승인된 원본 · 연속 2컷 · 편집 가능한 대사</p></div>
        <div className="flex gap-4 items-center">
          <a href="/" className="text-sm underline">기존 Comic Factory 편집기</a>
          <button className="text-sm underline" onClick={()=>void fetch('/api/webtoon/auth',{method:'DELETE'})
            .then(()=>{setAuthorized(false);setSnapshot(null)})}>로그아웃</button>
        </div>
      </header>
      <p role="status" className="rounded border bg-white px-4 py-2 text-sm">{message}</p>
      <section className="rounded-xl bg-white p-4 space-y-3">
        <h2 className="font-bold text-xl">1. 작품 선택</h2>
        <div className="flex gap-2 flex-wrap">
          <select value={projectId} onChange={e=>{setProjectId(e.target.value);setDraftId('')}}
            className="border p-2 rounded">
            <option value="">새 작품 / 작품 선택</option>
            {projects.map(p=><option key={p.projectId} value={p.projectId}>{p.projectId} · {p.pairs}쌍</option>)}
          </select>
          <input className="border p-2 rounded" value={newId} onChange={e=>setNewId(e.target.value)} aria-label="신규 작품 ID"/>
          <button disabled={busy} onClick={()=>void run('create',{projectId:newId},()=>setProjectId(newId))}
            className="rounded bg-stone-900 text-white px-4 py-2 disabled:opacity-40">작품 생성</button>
        </div>
        {snapshot&&<div className="space-y-2 border-t pt-3">
          <h3 className="font-semibold">작품 줄거리 · 세계관 원본</h3>
          <textarea className="border rounded p-2 w-full" rows={3} value={storyGoal}
            onChange={e=>setStoryGoal(e.target.value)} aria-label="작품 핵심 줄거리"/>
          <textarea className="border rounded p-2 w-full" rows={3} value={storyBible}
            onChange={e=>setStoryBible(e.target.value)} aria-label="세계관 및 서사 규칙"/>
          <button disabled={busy||!storyGoal.trim()} className="border rounded px-3 py-2"
            onClick={()=>void run('saveStory',{storyGoal,storyBibleSummary:storyBible})}>
            작품 설정 영구 저장
          </button>
          <p className="text-xs text-stone-500">스토리 정보는 승인된 이미지에 덮어쓰지 않고 별도로 저장돼.</p>
        </div>}
        {snapshot&&<p className="text-sm text-stone-500">리비전 {snapshot.revision} · 캐릭터 {snapshot.catalog.characters.length}명 · 장소 {snapshot.catalog.locations.length}개</p>}
      </section>
      {snapshot&&<section className="rounded-xl bg-white p-4 space-y-3">
        <h2 className="font-bold text-xl">연재 화수 · 진행 상태 · 다음 화 연결</h2>
        <p className="text-sm text-stone-600">완료된 화는 잠그고, 마지막 승인 상태와 미회수 복선을 다음 화에 자동으로 전달해.</p>
        {snapshot.series?.episodes.length?(
          <div className="flex flex-wrap gap-2">
            {snapshot.series.episodes.map(ep=><button key={ep.id}
              onClick={()=>{setEpisodeId(ep.id);setRemainingDrafts(null);setEpisodeOutline(ep.outline||null)}}
              className={'px-3 py-2 rounded border text-sm '+(episodeId===ep.id?'bg-stone-900 text-white':'bg-white')}>
              {ep.ordinal}화 · {ep.status==='completed'?'완료':'제작 중'} · {ep.pairIds.length}/{ep.targetPairs}쌍
            </button>)}
            <button className="px-3 py-2 rounded border text-sm"
              onClick={()=>{setEpisodeId(nextEpisodeId(snapshot.series!));setRemainingDrafts(null);setEpisodeOutline(null)}}>
              다음 화 ID 준비
            </button>
          </div>
        ):<div className="text-sm text-stone-600">
          {snapshot.pairs.length?<>이전 버전의 컷들이 있어. 모든 컷이 승인됐다면
            <button className="underline mx-1" onClick={()=>void run('migrateLegacyEpisodes')}>
              기존 작품의 회차 데이터 변환
            </button>을 먼저 실행해.</>:'아직 시작된 화가 없어. 아래에서 첫 화를 설계해.'}
        </div>}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <strong>현재 선택: {episodeId}</strong>
          <label className="flex items-center gap-2"><input type="checkbox" checked={autoContinue}
            onChange={e=>setAutoContinue(e.target.checked)}/>
            2컷 승인 시 다음 단계 자동 진행 (검수·승인은 수동)
          </label>
        </div>
        {activeEpisode&&activeEpisode.id!==episodeId&&
          <p className="text-sm text-amber-700">현재 {activeEpisode.id} 제작 중. 완료 확정 후 다음 화 제작 가능.</p>}
        {selectedEpisode&&<div className="border rounded p-3 space-y-2">
          <p className="text-sm">화수 {selectedEpisode.ordinal} ·
            {selectedEpisode.status==='completed'?' 확정 완료':' 진행 중'} ·
            {selectedEpisode.pairIds.length*2}/{selectedEpisode.targetPairs*2}컷 계획 등록
          </p>
          {selectedEpisode.handoff&&<div className="text-sm space-y-1">
            <p><strong>이번 화 요약:</strong> {selectedEpisode.handoff.summary}</p>
            <p><strong>마지막 후킹:</strong> {selectedEpisode.handoff.endingHook}</p>
            <p><strong>다음 화 시작 상태:</strong> {selectedEpisode.handoff.finalState.locationId} ·
              {selectedEpisode.handoff.finalState.timeKey}</p>
          </div>}
          {selectedEpisode.continuityReviewRequired&&<div className="rounded border border-amber-600 p-3 space-y-2">
            <p className="text-sm text-amber-800">이전 컷의 대사가 수정되어 이후 2컷들과 서사 충돌이 없는지 검토해야 해.
              검토를 완료하기 전에는 해당 화를 마감할 수 없어.</p>
            <button className="border rounded px-3 py-2 text-sm" disabled={busy}
              onClick={()=>void run('acknowledgeContinuity',{episodeId,reviewer:'local-reviewer'})}>
              이후 컷·대사 연결 검수 완료
            </button>
          </div>}
          {selectedEpisode.status==='producing'&&<>
            <p className="text-xs text-stone-600">확정 조건: 모든 2컷 쌍 등록 + 각 컷 승인 + 복선·후킹 인계 내용 작성.</p>
            <p className={episodeReady?.ready?'text-green-800 text-sm':'text-amber-700 text-sm'}>
              {episodeReady?.ready?'모든 컷 승인 완료 — 화수 마감 가능':'마감 대기: '+(episodeReady?.reason||'')}
            </p>
            {episodeReady?.ready&&<div className="space-y-2">
              <textarea className="border rounded p-2 w-full" rows={3}
                placeholder="이번 화의 사건·전개·변화 요약 (비워두면 승인된 콘티 요약 사용)"
                value={finalSynopsis} onChange={e=>setFinalSynopsis(e.target.value)}/>
              <input className="border rounded p-2 w-full" placeholder="마지막 후킹 / 다음 화 기대 사건"
                value={finalHook} onChange={e=>setFinalHook(e.target.value)}/>
              <textarea className="border rounded p-2 w-full" rows={2}
                placeholder="이번 화에 새로 생긴 미해결 복선 — 줄마다 thread_id | 설명"
                value={openThreadsText} onChange={e=>setOpenThreadsText(e.target.value)}/>
              <textarea className="border rounded p-2 w-full" rows={2}
                placeholder="이번 화에서 회수된 기존 복선 ID (쉼표 또는 줄바꿈으로 구분)"
                value={resolveThreadsText} onChange={e=>setResolveThreadsText(e.target.value)}/>
              <textarea className="border rounded p-2 w-full" rows={2}
                placeholder="관계 변화 — 줄마다 캐릭터ID1,캐릭터ID2 | 변화 내용"
                value={relationshipNotesText} onChange={e=>setRelationshipNotesText(e.target.value)}/>
              <button className="bg-stone-900 text-white rounded px-4 py-2 disabled:opacity-40"
                disabled={busy} onClick={()=>void finalizeCurrentEpisode()}>
                {selectedEpisode.ordinal}화 완료 확정 → 다음 화 준비
              </button>
            </div>}
          </>}
        </div>}
        {snapshot.series?.threads.some(t=>t.status==='open')&&<div className="text-sm space-y-1">
          <strong>미회수 복선 목록</strong>
          {snapshot.series.threads.filter(t=>t.status==='open').map(t=><p key={t.id}>
            {t.id} · {t.description} (처음: {t.introducedEpisode})
          </p>)}
        </div>}
      </section>
      {snapshot&&<section className="rounded-xl bg-white p-4 space-y-3">
        <h2 className="font-bold text-xl">2. 스토리에서 주요 인물·장소 초안 제안</h2>
        <p className="text-sm text-stone-600">LLM이 캐릭터 외형과 주요 장소를 제안해. 아래 제안은 아직 기준 이미지가 아니며, 이미지를 생성·확인·승인해야 고정 원본이 돼.</p>
        <button className="border rounded px-3 py-2 disabled:opacity-40" disabled={busy||!storyGoal.trim()}
          onClick={()=>void run('suggestCast',{storyGoal,storyBibleSummary:storyBible},
            data=>setCastSuggestions(data as CastProposals))}>스토리 기반 주요 캐릭터·장소 설계</button>
        {castSuggestions&&<div className="grid md:grid-cols-2 gap-3 text-sm">
          <div className="space-y-2">
            <h3 className="font-semibold">캐릭터 제안</h3>
            {castSuggestions.characters.map(c=><div key={c.id} className="border rounded p-3 space-y-1">
              <strong>{c.displayName} ({c.id})</strong>
              <p className="whitespace-pre-wrap">{c.appearance}</p>
              <button className="underline" onClick={()=>{setKind('identity');setOwnerId(c.id);
                setDisplayName(c.displayName);setDescription(c.appearance);setOutfitId(c.outfitId);
                setFile(null);setGenerated('');setDraftId('');setMasterPromptId('')}}>
                기준 캐릭터 이미지 만들기
              </button>
            </div>)}
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold">장소 제안</h3>
            {castSuggestions.locations.map(l=><div key={l.id} className="border rounded p-3 space-y-1">
              <strong>{l.id}</strong><p className="whitespace-pre-wrap">{l.description}</p>
              <button className="underline" onClick={()=>{setKind('location');setOwnerId(l.id);
                setDescription(l.description);setFile(null);setGenerated('');setDraftId('');setMasterPromptId('')}}>
                장소 기준 이미지 만들기
              </button>
            </div>)}
          </div>
        </div>}
      </section>}
      {snapshot&&<section className="rounded-xl bg-white p-4 space-y-3">
        <h2 className="font-bold text-xl">3. 캐릭터·장소 기준 이미지 등록</h2>
        <p className="text-sm text-stone-600">이미지를 먼저 생성하거나 업로드하고, 미리보기 확인 후 승인해야 기준 이미지로 사용돼.</p>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-2">
            <select value={kind} onChange={e=>setKind(e.target.value as typeof kind)} className="border rounded p-2 w-full">
              <option value="identity">캐릭터 얼굴·기준 이미지</option><option value="location">장소 기준 이미지</option>
              <option value="view">기존 캐릭터 시점 참고 이미지</option><option value="outfit">기존 캐릭터 의상 참고 이미지</option>
            </select>
            <input className="border rounded p-2 w-full" placeholder="캐릭터·장소 ID" value={ownerId} onChange={e=>setOwnerId(e.target.value)}/>
            {kind==='identity'&&<input className="border rounded p-2 w-full" placeholder="표시 이름" value={displayName} onChange={e=>setDisplayName(e.target.value)}/>}
            {kind==='view'&&<select className="border p-2 rounded w-full" value={view} onChange={e=>setView(e.target.value as typeof view)}>
              <option value="front">정면</option><option value="left">왼쪽</option>
              <option value="right">오른쪽</option><option value="back">후면</option></select>}
            <textarea className="border rounded p-2 w-full" placeholder="외형·장소 설명" value={description} onChange={e=>setDescription(e.target.value)} rows={3}/>
            {(kind==='identity'||kind==='outfit')&&<input className="border rounded p-2 w-full" placeholder="의상 ID" value={outfitId} onChange={e=>setOutfitId(e.target.value)}/>}
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{setFile(e.target.files?.[0]||null);setGenerated('');setMasterContext(null);setMasterPromptId('')}}/>
            <div className="flex gap-2 flex-wrap">
              <button className="border rounded px-3 py-2" disabled={busy}
                onClick={()=>void run('generateMaster',{projectId,ownerId,kind,view,
                  prompt:description,width:768,height:1024},
                  data=>{setMasterPromptId(data.renderId);setMasterContext({ownerId,kind,view,outfitId});
                    setMessage('생성 작업: '+data.renderId)})}>AI로 원본 초안 생성</button>
              <button className="border rounded px-3 py-2" disabled={!masterPromptId||busy}
                onClick={()=>void run('pollMaster',{promptId:masterPromptId},
                  data=>{if(data.status==='completed')setGenerated(data.assetUrl);else setMessage('이미지 생성 중: '+data.status)})}>생성 결과 조회</button>
              <button className="border rounded px-3 py-2 bg-stone-900 text-white" disabled={busy||(!file&&!generated)}
                onClick={()=>void stageMaster()}>이미지 초안 등록</button>
            </div>
          </div>
          <div className="space-y-2">
            {generated&&<img className="h-52 object-contain border rounded" src={generated} alt="생성된 캐릭터 초안"/>}
            {snapshot.catalog.assets.some(a=>a.status==='draft'&&a.kind!=='previous-panel')&&<>
              <label className="text-xs font-medium block">저장된 기준 이미지 초안 (새로고침 후에도 재선택 가능)</label>
              <select className="border rounded p-2 w-full text-sm" value={draftId} onChange={e=>{
                const chosen=snapshot.catalog.assets.find(a=>a.id===e.target.value)
                setDraftId(e.target.value);setReviewCheck(false)
                if(chosen){
                  setOwnerId(chosen.ownerId)
                  setKind(chosen.kind as 'identity'|'location'|'view'|'outfit')
                  if(chosen.outfitId)setOutfitId(chosen.outfitId)
                  if(chosen.view)setView(chosen.view)
                }
              }}>
                <option value="">검수할 저장 초안 선택</option>
                {snapshot.catalog.assets.filter(a=>a.status==='draft'&&a.kind!=='previous-panel')
                  .map(a=><option key={a.id} value={a.id}>
                    {a.kind} · {a.ownerId} · {a.outfitId||a.view||a.id.slice(-8)}
                  </option>)}
              </select>
            </>}
            {draftId&&selectedMasterDraft&&<>
              <img className="h-52 object-contain border rounded" src={assetUrl(projectId,draftId)} alt="승인할 기준 이미지"/>
              <p className="text-xs break-all">{selectedMasterDraft.kind}: {draftId}</p>
              <label className="flex gap-2 text-sm items-start">
                <input type="checkbox" checked={reviewCheck} onChange={e=>setReviewCheck(e.target.checked)}/>
                실제 이미지의 얼굴·의상·기준 설명을 육안으로 확인했고 원본으로 승인함
              </label>
              <button disabled={!reviewCheck||busy} className="rounded bg-stone-900 text-white px-4 py-2 disabled:opacity-40"
                onClick={()=>void approveMaster()}>기준 이미지 승인</button>
            </>}
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-2 text-sm">
          {snapshot.catalog.characters.map(c=><div key={c.id} className="border rounded p-2 flex gap-2 items-center">
            <img className="w-16 h-16 object-cover" alt={c.displayName} src={assetUrl(projectId,c.identityReferenceId)}/>
            <span>{c.displayName} ({c.id}) · {c.outfitIds.join(', ')}</span>
          </div>)}
          {snapshot.catalog.locations.map(l=><div key={l.id} className="border rounded p-2">
            장소 {l.id}: {l.description}</div>)}
        </div>
      </section>}
      {snapshot&&<section className="rounded-xl bg-white p-4 space-y-3">
        <h2 className="font-bold text-xl">3. LLM 두 컷 콘티</h2>
        <input className="border rounded p-2 w-full" placeholder="회차 ID" value={episodeId} onChange={e=>setEpisodeId(e.target.value)}/>
        <textarea className="border rounded p-2 w-full" rows={3} value={storyGoal} onChange={e=>setStoryGoal(e.target.value)} placeholder="이번 두 컷의 사건·목표"/>
        <textarea className="border rounded p-2 w-full" rows={2} value={storyBible} onChange={e=>setStoryBible(e.target.value)} placeholder="세계관·인물 관계·주요 복선"/>
        <div className="border rounded p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <button className="border rounded px-3 py-2 disabled:opacity-40" disabled={busy}
              onClick={()=>void run('designEpisodeOutline',{episodeId,storyGoal,storyBibleSummary:storyBible},
                data=>{setEpisodeOutline(data.outline);if(data.outline?.recommendedPairs)setEpisodePairs(data.outline.recommendedPairs)})}>
              LLM 회차 기승전결·클리프행어 설계
            </button>
            <button className="underline text-sm" disabled={busy}
              onClick={()=>void run('draftStatus',{episodeId},data=>setEpisodeOutline(data?.outline||null))}>
              저장된 회차 기획 불러오기
            </button>
          </div>
          {episodeOutline&&<div className="space-y-2 text-sm">
            <p><strong>주제:</strong> {episodeOutline.theme}</p>
            <p><strong>갈등·위험:</strong> {episodeOutline.stakes}</p>
            {episodeOutline.recommendedPairs&&<p><strong>LLM 권장 길이:</strong> {episodeOutline.recommendedPairs*2}컷 · {episodeOutline.recommendedPairs}쌍 (직접 조정 가능)</p>}
            {episodeOutline.beats?.map((beat:any)=><p key={beat.stage} className="border-l-2 pl-3">
              <strong>{beat.stage}</strong> · {beat.event} ({beat.emotionalChange})
            </p>)}
          </div>}
        </div>
        <div className="flex gap-3 items-center flex-wrap">
          <label className="text-sm">회차 2컷 쌍 수
            <input type="number" min={1} max={250} value={episodePairs}
              onChange={e=>setEpisodePairs(Math.max(1,Math.min(250,Number(e.target.value)||1)))}
              className="ml-2 border rounded p-2 w-20"/>
          </label>
          <button className="rounded border px-4 py-2 disabled:opacity-40" disabled={busy}
            onClick={()=>void planEpisode()}>LLM: 회차 콘티 생성·중단 시 재개</button>
          {busy&&<button className="rounded border border-amber-600 px-3 py-2 text-amber-700"
            onClick={()=>{cancelPlanningRef.current=true}}>현재 2컷 완료 후 중단</button>}
          <button className="rounded bg-stone-900 text-white px-4 py-2 disabled:opacity-40"
            disabled={busy||(lastPair&&lastPair.job.status!=='approved')}
            onClick={()=>void activateDraft()}>이미지 단계: 저장된 다음 2컷 불러오기</button>
          <button className="rounded border px-4 py-2 disabled:opacity-40" disabled={busy||(lastPair&&lastPair.job.status!=='approved')}
            onClick={()=>void planPair()}>즉석 다음 2컷 계획</button>
        </div>
        {remainingDrafts!==null&&<p className="text-sm">아직 활성화되지 않은 사전 콘티: {remainingDrafts}쌍</p>
        {lastPair&&<div className="border rounded p-3 text-sm">
          <strong>{lastPair.plan.id} · {lastPair.job.status}</strong>
          {lastPair.plan.panels.map((panel,i)=><p key={i}>{i+1}컷: {panel.summary} — {panel.characters.map(a=>a.action).join(', ')}</p>)}
        </div>}
      </section>}
      {snapshot&&lastPair&&<section className="rounded-xl bg-white p-4 space-y-3">
        <h2 className="font-bold text-xl">4. 두 컷 순차 작화·승인</h2>
        <p className="text-sm text-stone-600">컷 1 승인 후 컷 2 시작 가능. 검수되지 않은 이미지는 다음 컷에 넘기지 않아.</p>
        <div className="flex gap-2 flex-wrap">
          {(['validated','rendering_first'].includes(lastPair.job.status))&&
            <button className="rounded border px-3 py-2" disabled={busy}
              onClick={()=>void startRender(lastPair.plan.id,0)}>첫 컷 작업 제출 / 재개</button>}
          {lastPair.job.status==='rendering_first'&&<>
            <button className="rounded border px-3 py-2" disabled={busy}
              onClick={()=>void pollRender(lastPair.plan.id,0)}>첫 컷 상태 조회·검수 등록</button>
            <button className="rounded border border-amber-600 px-3 py-2" disabled={busy}
              onClick={()=>void resetRender(lastPair.plan.id,0)}>
              중단된 첫 컷 작업 초기화
            </button>
          </>}
          {(['first_approved','rendering_second'].includes(lastPair.job.status))&&
            <button className="rounded border px-3 py-2" disabled={busy}
              onClick={()=>void startRender(lastPair.plan.id,1)}>두 번째 컷 작업 제출 / 재개</button>}
          {lastPair.job.status==='rendering_second'&&<>
            <button className="rounded border px-3 py-2" disabled={busy}
              onClick={()=>void pollRender(lastPair.plan.id,1)}>두 번째 컷 상태 조회·검수 등록</button>
            <button className="rounded border border-amber-600 px-3 py-2" disabled={busy}
              onClick={()=>void resetRender(lastPair.plan.id,1)}>
              중단된 두 번째 컷 작업 초기화
            </button>
          </>}
        </div>
        {(['review_first','review_second'].includes(lastPair.job.status))&&<>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={reviewCheck} onChange={e=>setReviewCheck(e.target.checked)}/>
            캐릭터 얼굴·인물 위치·의상·동작·화자·말풍선 여백을 검수했고 이 컷을 승인함
          </label>
          {(()=>{
            const idx=lastPair.job.status==='review_first'?0:1
            const image=assetForPanel(lastPair.plan.panels[idx].id)
            return <div className="flex gap-2 flex-wrap">
              <button className="rounded border px-3 py-2" disabled={!image||busy}
                onClick={()=>image&&void run('inspectPanel',{pairId:lastPair.plan.id,panelIndex:idx,assetId:image.id},
                  data=>setQaIssues(data.issues))}>기계적 QA 검사</button>
              <input className="border rounded p-2 text-xs" aria-label="반려 이유"
                value={rejectReason} onChange={e=>setRejectReason(e.target.value)}/>
              <button className="rounded border border-red-500 text-red-700 px-3 py-2 disabled:opacity-40"
                disabled={!image||busy||!rejectReason.trim()}
                onClick={()=>image&&void run('rejectPanel',{pairId:lastPair.plan.id,panelIndex:idx,
                  assetId:image.id,reason:rejectReason},()=>{setReviewCheck(false);setQaIssues([])})}>반려 후 해당 컷 재생성</button>
              <button className="rounded bg-stone-900 text-white px-4 py-2 disabled:opacity-40"
                disabled={!reviewCheck||busy||!image}
                onClick={()=>image&&void approvePanel(lastPair.plan.id,idx,image.id)}>{idx+1}컷 승인</button>
            </div>
          })()}
        </>}
        {qaIssues.length>0&&<ul className="text-xs p-3 border rounded space-y-1">
          {qaIssues.map((x,i)=><li key={i} className={x.severity==='blocking'?'text-red-700':'text-amber-700'}>
            {x.severity}: {x.code} · {x.message}</li>)}
        </ul>}
        <div className="grid md:grid-cols-2 gap-4">
          {panelCard(lastPair,0)}{panelCard(lastPair,1)}
        </div>
      </section>}
      {snapshot&&snapshot.approvedPanels.length>0&&<section className="rounded-xl bg-white p-4 space-y-3">
        <div className="flex justify-between items-center flex-wrap">
          <h2 className="font-bold text-xl">{episodeId} · 승인된 세로 웹툰</h2>
          <div className="flex gap-2 flex-wrap">
            <button disabled={busy} className="border rounded px-3 py-2" onClick={()=>void exportImage()}>
              선택 화 PNG 내보내기 (10컷씩)
            </button>
            <button className="border rounded px-3 py-2" onClick={exportEpisodeManifest}>
              선택 화 대사·컷·서사 JSON
            </button>
          </div>
        </div>
        <div ref={stripRef} className="mx-auto max-w-xl bg-white space-y-5">
          {episodePairsInProject.flatMap(pair=>pair.plan.panels.map(panel=>({pair,panel})))
            .filter(({panel})=>snapshot.approvedPanels.some(p=>p.id===panel.id))
            .map(({panel})=>{
              const asset=assetForPanel(panel.id)
              return asset&&<div key={panel.id} className="w-full aspect-[3/4] relative bg-white">
                <img src={assetUrl(projectId,asset.id)} className="absolute inset-0 w-full h-full object-cover" alt={panel.summary}/>
                {panel.bubbles.slice().sort((a,b)=>a.readOrder-b.readOrder).map(b=>bubbleOverlay(panel.id,b,false))}
              </div>
            })}
        </div>
      </section>}
    </div>
  </main>
}
