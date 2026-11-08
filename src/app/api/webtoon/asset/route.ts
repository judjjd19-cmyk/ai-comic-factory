import {webtoonAsset} from '@/lib/webtoon/studioService'
import {requireStudioAuth} from '@/lib/webtoon/auth'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function GET(request:Request){
  try{
    requireStudioAuth(request)
    const url=new URL(request.url)
    const projectId=url.searchParams.get('projectId')||''
    const assetId=url.searchParams.get('assetId')||''
    const {bytes,mime}=await webtoonAsset(projectId,assetId)
    return new Response(new Uint8Array(bytes),{status:200,headers:{
      'Content-Type':mime,'Cache-Control':'private, max-age=0, must-revalidate',
      'X-Content-Type-Options':'nosniff',
    }})
  }catch(e){return new Response(e instanceof Error?e.message:'Not found',{status:404})}
}
