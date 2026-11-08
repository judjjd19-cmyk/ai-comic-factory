/** Strict local-only HTTP endpoints for the 100% local Webtoon Studio mode. */
export function requireLocalRuntimeURL(value:string,service:string):URL{
  let url:URL
  try{url=new URL(value)}
  catch{throw new Error(service+' URL is invalid')}
  if(url.protocol!=='http:'||
     !['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
     !!url.username||!!url.password||!!url.search||!!url.hash)
    throw new Error(service+' must use a local HTTP loopback endpoint; remote inference is forbidden')
  return url
}
