import {clearStudioCookie,isStudioAuthenticated,issueStudioCookie,requireSameOrigin,
  verifyStudioPassword} from '@/lib/webtoon/auth'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function GET(request:Request){
  return Response.json({authenticated:isStudioAuthenticated(request)},{headers:{'Cache-Control':'no-store'}})
}
export async function POST(request:Request){
  try{
    requireSameOrigin(request)
    if(Number(request.headers.get('content-length')||0)>1024)throw new Error('Credentials too large')
    const body=await request.json() as {token?:unknown}
    if(!verifyStudioPassword(body?.token))return Response.json({ok:false,error:'Invalid studio token'},{status:401})
    return Response.json({ok:true},{headers:{
      'Set-Cookie':issueStudioCookie(request),'Cache-Control':'no-store',
    }})
  }catch(e){return Response.json({ok:false,error:e instanceof Error?e.message:'Login failed'},{status:400})}
}
export async function DELETE(request:Request){
  try{
    requireSameOrigin(request)
    return Response.json({ok:true},{headers:{'Set-Cookie':clearStudioCookie(),'Cache-Control':'no-store'}})
  }catch{return Response.json({ok:false},{status:400})}
}
