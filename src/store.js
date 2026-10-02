// Repositories over an in-memory store (survives warm Vercel invocations only).
// Swap the `repos` implementation for Postgres/Upstash without touching services.
const crypto=require('crypto');
const key=()=>crypto.createHash('sha256').update(process.env.APP_SECRET||'dev-secret-change-me').digest();
const enc=t=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),iv),b=Buffer.concat([c.update(t,'utf8'),c.final()]);return [iv,c.getAuthTag(),b].map(x=>x.toString('base64')).join('.')};
const dec=s=>{try{const[i,t,b]=s.split('.').map(x=>Buffer.from(x,'base64'));const d=crypto.createDecipheriv('aes-256-gcm',key(),i);d.setAuthTag(t);return Buffer.concat([d.update(b),d.final()]).toString('utf8')}catch{return null}};
const id=()=>crypto.randomBytes(8).toString('hex');
const DEFAULTS={defaultGateway:'push',timeout:5000,retries:3,logging:true,history:true};
function seed(){
  const ch=['sms','zalo','push'],now=Date.now(),logs=[];
  for(let i=0;i<400;i++){const c=ch[Math.floor(Math.random()*3)],ok=Math.random()<.95;
    logs.push({id:id(),gatewayId:c,channel:c,recipient:'09'+Math.floor(1e7+Math.random()*9e7),title:'Thông báo',message:'Demo message',status:ok?'sent':'failed',
    messageId:ok?c.toUpperCase()+'-DEMO-'+id().slice(0,6).toUpperCase():null,responseCode:ok?200:500,responseTime:80+Math.floor(Math.random()*120),
    errorMessage:ok?null:'Gateway error',request:{},response:{},createdAt:new Date(now-Math.random()*30*864e5).toISOString()})}
  logs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return{gateways:ch.map(t=>({id:t,name:t==='sms'?'SMS':t[0].toUpperCase()+t.slice(1),type:t,enabled:true,url:null,tokenEnc:null,timeout:5000,retries:3})),
    logs,keys:[],settings:{...DEFAULTS}};
}
const db=globalThis.__ngw||(globalThis.__ngw=seed());
const repos={
  gateways:{all:()=>db.gateways,get:i=>db.gateways.find(g=>g.id===i),update:(i,p)=>Object.assign(repos.gateways.get(i),p)},
  logs:{all:()=>db.logs,get:i=>db.logs.find(l=>l.id===i),add:l=>{db.logs.unshift(l);if(db.logs.length>5000)db.logs.length=5000;return l}},
  keys:{all:()=>db.keys,get:i=>db.keys.find(k=>k.id===i),add:k=>{db.keys.unshift(k);return k},byHash:h=>db.keys.find(k=>k.hash===h&&k.status==='active')},
  settings:{get:()=>db.settings,set:s=>Object.assign(db.settings,s),reset:()=>Object.assign(db.settings,DEFAULTS)}
};
module.exports={repos,enc,dec,id};
