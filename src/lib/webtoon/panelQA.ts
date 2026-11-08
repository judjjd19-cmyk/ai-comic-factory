import type {Bounds,PanelPlan} from './contracts.ts'
export type QAIssue={severity:'warning'|'blocking';code:string;message:string;target:string}
function intersection(a:Bounds,b:Bounds):number{
 const x=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))
 const y=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]))
 return x*y
}
const area=(b:Bounds)=>b[2]*b[3]
export function inspectLayout(panel:PanelPlan,overrides:Record<string,{text:string;box:Bounds}>={}):QAIssue[]{
 const issues:QAIssue[]=[]
 const bad=(severity:QAIssue['severity'],code:string,message:string,target:string)=>issues.push({severity,code,message,target})
 const bubbles=panel.bubbles.map(b=>({...b,text:overrides[b.id]?.text??b.text,box:overrides[b.id]?.box??b.box}))
 for(let i=0;i<bubbles.length;i++){
   const a=bubbles[i]
   if(!a.text.trim())bad('blocking','EMPTY_DIALOGUE','말풍선 텍스트 누락',a.id)
   if(!a.box||!Array.isArray(a.box)||a.box.some(n=>!Number.isFinite(n))||a.box[2]<=0||a.box[3]<=0||
     a.box[0]<0||a.box[1]<0||a.box[0]+a.box[2]>1.000001||a.box[1]+a.box[3]>1.000001){
       bad('blocking','INVALID_BUBBLE_BOX','말풍선이 화면 밖에 있음',a.id);continue
   }
   if([...a.text].length>Math.max(12,Math.floor(900*area(a.box))))
     bad('warning','BUBBLE_OVERFLOW','한국어 대사가 말풍선에 넘칠 수 있음',a.id)
   for(let j=i+1;j<bubbles.length;j++){
     const b=bubbles[j]
     if(b.box&&area(a.box)>0&&intersection(a.box,b.box)>0.35*Math.min(area(a.box),area(b.box)))
       bad('warning','BUBBLE_OVERLAP','말풍선이 크게 겹침',a.id+'/'+b.id)
   }
   for(const actor of panel.characters){
     const face:Bounds=[actor.box[0],actor.box[1],actor.box[2],actor.box[3]*0.42]
     if(intersection(a.box,face)>0.25*area(a.box))
       bad('warning','FACE_OCCLUSION','말풍선이 얼굴 부분을 가릴 가능성',a.id+'/'+actor.characterId)
   }
   if(a.type!=='narration'&&!panel.characters.some(c=>c.characterId===a.speakerId))
     bad('blocking','UNKNOWN_SPEAKER','말풍선 화자가 컷에 없음',a.id)
 }
 return issues
}
