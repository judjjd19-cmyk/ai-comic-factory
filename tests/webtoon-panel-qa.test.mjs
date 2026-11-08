import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectLayout} from '../src/lib/webtoon/panelQA.ts'
const panel=()=>({characters:[{characterId:'hero',box:[.1,.4,.5,.5]}],
 bubbles:[{id:'b',type:'speech',speakerId:'hero',text:'안녕',box:[.1,.1,.2,.2],tailTarget:[.2,.5],readOrder:0}]})
test('safe bubble does not create blocking issues',()=>{
 assert.equal(inspectLayout(panel()).filter(x=>x.severity==='blocking').length,0)
})
test('QA reports speaker mismatch and overlapping bubbles',()=>{
 const p=panel();p.bubbles.push({...p.bubbles[0],id:'b2',speakerId:'other'})
 const issues=inspectLayout(p)
 assert(issues.some(x=>x.code==='UNKNOWN_SPEAKER'))
 assert(issues.some(x=>x.code==='BUBBLE_OVERLAP'))
})
test('text edits can produce blocking empty/invalid geometry',()=>{
 const issues=inspectLayout(panel(),{b:{text:'',box:[0,0,0,0]}})
 assert(issues.some(x=>x.code==='EMPTY_DIALOGUE'))
 assert(issues.some(x=>x.code==='INVALID_BUBBLE_BOX'))
})
