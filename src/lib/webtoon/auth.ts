import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'

const COOKIE='webtoon_studio_session'
const DURATION=12*60*60
function secret():string{
  const value=process.env.WEBTOON_STUDIO_TOKEN||''
  if(value.length<32)throw new Error('Set a random WEBTOON_STUDIO_TOKEN of at least 32 characters')
  return value
}
function mac(input:string):string{
  return createHmac('sha256',secret()).update('webtoon-session-v1:'+input).digest('base64url')
}
function safeEqual(a:string,b:string):boolean{
  const left=Buffer.from(a),right=Buffer.from(b)
  return left.length===right.length&&timingSafeEqual(left,right)
}
export function verifyStudioPassword(candidate:unknown):boolean{
  return typeof candidate==='string'&&safeEqual(candidate,secret())
}
export function issueStudioCookie(request:Request):string{
  const expires=Math.floor(Date.now()/1000)+DURATION
  const payload=expires+'.'+randomBytes(12).toString('base64url')
  const value=payload+'.'+mac(payload)
  const secure=new URL(request.url).protocol==='https:'||
    request.headers.get('x-forwarded-proto')==='https'
  return COOKIE+'='+encodeURIComponent(value)+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+DURATION+
    (secure?'; Secure':'')
}
export function clearStudioCookie():string{
  return COOKIE+'=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
}
export function isStudioAuthenticated(request:Request):boolean{
  try{
    const cookie=request.headers.get('cookie')||''
    const found=cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))
    if(!found)return false
    const raw=decodeURIComponent(found.slice(COOKIE.length+1))
    const parts=raw.split('.')
    if(parts.length!==3||!/^\d+$/.test(parts[0])||!/^[A-Za-z0-9_-]{10,}$/.test(parts[1]))return false
    const expires=Number(parts[0]),now=Math.floor(Date.now()/1000)
    if(!Number.isSafeInteger(expires)||expires<now||expires>now+DURATION)return false
    return safeEqual(parts[2],mac(parts[0]+'.'+parts[1]))
  }catch{return false}
}
export function requireStudioAuth(request:Request):void{
  if(!isStudioAuthenticated(request))throw new Error('Webtoon Studio session required')
}
export function requireSameOrigin(request:Request):void{
  const origin=request.headers.get('origin')
  if(!origin)return
  const expected=new URL(request.url)
  const candidate=new URL(origin)
  if(candidate.protocol===expected.protocol&&candidate.host===expected.host)return
  // Trusted proxy reconstruction for authenticated Google Colab kernel-port forwarding.
  const forwardedHost=request.headers.get('x-forwarded-host')
  const forwardedProto=request.headers.get('x-forwarded-proto')
  if(forwardedHost&&forwardedProto&&candidate.host===forwardedHost&&
     candidate.protocol===forwardedProto+':')return
  throw new Error('Cross-origin studio request blocked')
}
