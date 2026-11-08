import {webtoonAsset} from '@/lib/webtoon/studioService'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function GET(request:Request){
  try{
    const host=request.headers.get('host')||''
    if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
      return new Response('Local studio only',{status:403})
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
