import test from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyStudioPassword,issueStudioCookie,isStudioAuthenticated,
  requireStudioAuth,requireSameOrigin,
} from '../src/lib/webtoon/auth.ts'

const original=process.env.WEBTOON_STUDIO_TOKEN
process.env.WEBTOON_STUDIO_TOKEN='unit-test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
test('studio authentication uses a signed HttpOnly cookie with no plain token',()=>{
  const browser=new Request('http://localhost:3000/api/webtoon/auth')
  const cookie=issueStudioCookie(browser)
  assert.match(cookie,/HttpOnly/)
  assert.match(cookie,/SameSite=Strict/)
  assert.equal(cookie.includes(process.env.WEBTOON_STUDIO_TOKEN),false)
  const session=new Request('http://localhost:3000/api/webtoon/command',{
    headers:{cookie:cookie.split(';')[0]}})
  assert.equal(isStudioAuthenticated(session),true)
  assert.doesNotThrow(()=>requireStudioAuth(session))
  assert.equal(isStudioAuthenticated(new Request('http://localhost:3000')),false)
})
test('reject forged cookie and cross-origin mutation',()=>{
  assert.equal(verifyStudioPassword('incorrect'),false)
  assert.equal(verifyStudioPassword(process.env.WEBTOON_STUDIO_TOKEN),true)
  const cookie=issueStudioCookie(new Request('http://localhost:3000'))
  const tampered=cookie.split(';')[0]+'tamper'
  assert.equal(isStudioAuthenticated(new Request('http://localhost:3000',{headers:{cookie:tampered}})),false)
  assert.throws(()=>requireSameOrigin(new Request('http://localhost:3000/api/webtoon/command',{
    headers:{origin:'https://untrusted.example'}})),/Cross-origin/)
})
test.after(()=>{if(original===undefined)delete process.env.WEBTOON_STUDIO_TOKEN
  else process.env.WEBTOON_STUDIO_TOKEN=original})
