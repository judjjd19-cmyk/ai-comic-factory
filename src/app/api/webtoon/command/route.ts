import {requireStudioAuth,requireSameOrigin} from '@/lib/webtoon/auth'
import {
  listWebtoonProjects,createWebtoonProject,webtoonSnapshot,stageWebtoonMaster,
  approveWebtoonCharacter,approveWebtoonLocation,approveWebtoonSupplement,
  generateMasterImage,pollMasterImage,planWebtoonPair,startWebtoonPanel,
  pollWebtoonPanel,approveWebtoonPanel,rejectWebtoonPanel,editWebtoonBubble,generateCharacterReference,
  planEntireWebtoonEpisode,nextPlannedWebtoonPair,savedWebtoonEpisodeDrafts,inspectWebtoonPanel,planOneWebtoonPairStep,suggestWebtoonCast,saveWebtoonStory,createWebtoonEpisodeOutline,
} from '@/lib/webtoon/studioService'

export const runtime='nodejs'
export const dynamic='force-dynamic'

function guard(request:Request){requireStudioAuth(request)}
const str=(v:unknown):string=>typeof v==='string'?v:''
const number=(v:unknown):number=>typeof v==='number'?v:Number(v)
const index=(v:unknown):0|1=>{
  if(v!==0&&v!==1)throw new Error('panelIndex must be 0 or 1')
  return v
}
function fail(error:unknown){
  return Response.json({ok:false,error:error instanceof Error?error.message:'Unknown error'},{status:400})
}
export async function GET(request:Request){
  try{
    guard(request)
    const url=new URL(request.url)
    const projectId=url.searchParams.get('projectId')
    const data=projectId?await webtoonSnapshot(projectId):await listWebtoonProjects()
    return Response.json({ok:true,data},{headers:{'Cache-Control':'no-store'}})
  }catch(e){return fail(e)}
}
export async function POST(request:Request){
  try{
    guard(request)
    requireSameOrigin(request)
    if(Number(request.headers.get('content-length')||0)>28_500_000)
      return Response.json({ok:false,error:'Request too large'},{status:413})
    const body=await request.json() as Record<string,unknown>
    if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid request body')
    const projectId=str(body.projectId), rev=number(body.revision), assetId=str(body.assetId)
    let data:unknown
    switch(str(body.action)){
      case 'create':
        data=await createWebtoonProject(projectId);break
      case 'stageMaster':
        data=await stageWebtoonMaster(projectId,rev,str(body.ownerId),
          body.kind as 'identity'|'location'|'view'|'outfit',str(body.dataUri),str(body.outfitId)||undefined,str(body.view) as 'front'|'left'|'right'|'back');break
      case 'approveCharacter':
        data=await approveWebtoonCharacter(projectId,rev,assetId,{
          id:str(body.ownerId),displayName:str(body.displayName),
          description:str(body.description),outfitId:str(body.outfitId)});break
      case 'approveLocation':
        data=await approveWebtoonLocation(projectId,rev,assetId,{
          id:str(body.ownerId),description:str(body.description)});break
      case 'approveSupplement':
        data=await approveWebtoonSupplement(projectId,rev,assetId);break
      case 'generateMaster':
        data=body.kind==='view'||body.kind==='outfit'
          ?await generateCharacterReference(projectId,str(body.ownerId),body.kind,
            str(body.prompt),str(body.view) as 'front'|'left'|'right'|'back',
            number(body.width)||768,number(body.height)||1024)
          :await generateMasterImage(str(body.prompt),number(body.width)||768,number(body.height)||1024);break
      case 'pollMaster':
        data=await pollMasterImage(str(body.promptId));break
      case 'saveStory':
        data=await saveWebtoonStory(projectId,str(body.storyGoal),str(body.storyBibleSummary));break
      case 'suggestCast':
        data=await suggestWebtoonCast(str(body.storyGoal),str(body.storyBibleSummary));break
      case 'designEpisodeOutline':
        data=await createWebtoonEpisodeOutline(projectId,str(body.episodeId)||'episode1',
          str(body.storyGoal),str(body.storyBibleSummary));break
      case 'planEpisodeStep':
        data=await planOneWebtoonPairStep(projectId,str(body.episodeId)||'episode1',
          str(body.storyGoal),str(body.storyBibleSummary),number(body.pairCount),
          str(body.locationId)||undefined);break
      case 'planEpisode':
        data=await planEntireWebtoonEpisode(projectId,str(body.episodeId)||'episode1',
          str(body.storyGoal),str(body.storyBibleSummary),number(body.pairCount),
          str(body.locationId)||undefined);break
      case 'activateDraft':
        data=await nextPlannedWebtoonPair(projectId,str(body.episodeId)||'episode1');break
      case 'draftStatus':
        data=await savedWebtoonEpisodeDrafts(projectId,str(body.episodeId)||'episode1');break
      case 'planPair':
        data=await planWebtoonPair(projectId,str(body.storyGoal),str(body.episodeId)||'episode1',
          str(body.locationId)||undefined,str(body.storyBibleSummary));break
      case 'startPanel':
        data=await startWebtoonPanel(projectId,str(body.pairId),index(body.panelIndex),
          number(body.width)||768,number(body.height)||1024);break
      case 'pollPanel':
        data=await pollWebtoonPanel(projectId,str(body.pairId),index(body.panelIndex));break
      case 'inspectPanel':
        data=await inspectWebtoonPanel(projectId,str(body.pairId),index(body.panelIndex),assetId);break
      case 'rejectPanel':
        data=await rejectWebtoonPanel(projectId,str(body.pairId),index(body.panelIndex),assetId,str(body.reason));break
      case 'approvePanel':
        data=await approveWebtoonPanel(projectId,str(body.pairId),index(body.panelIndex),
          assetId,str(body.reviewer)||'local-reviewer');break
      case 'editBubble':
        data=await editWebtoonBubble(projectId,str(body.panelId),str(body.bubbleId),
          str(body.text),body.box as [number,number,number,number]);break
      default:throw new Error('Unknown command')
    }
    return Response.json({ok:true,data},{headers:{'Cache-Control':'no-store'}})
  }catch(e){return fail(e)}
}
