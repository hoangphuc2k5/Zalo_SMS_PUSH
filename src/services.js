const {repos,enc,id}=require('./store');
const crypto=require('crypto');
const {create}=require('./gateways');
const CH=['sms','zalo','push'];
const bad=m=>Object.assign(new Error(m),{status:400});
const nf=m=>Object.assign(new Error(m),{status:404});
const RANGE={today:1,'7d':7,'30d':30,'90d':90};
const since=r=>{const d=RANGE[r]||7,s=new Date();if(d===1)s.setHours(0,0,0,0);else s.setTime(Date.now()-d*864e5);return s.toISOString()};
const pub=g=>({id:g.id,name:g.name,type:g.type,enabled:g.enabled,url:create(g).url,hasToken:true,timeout:g.timeout,retries:g.retries});

class GatewayManagementService{
  list(){return repos.gateways.all().map(pub)}
  get(i){const g=repos.gateways.get(i);if(!g)throw nf('Gateway not found');return g}
  update(i,b){const g=this.get(i),p={};
    if(b.enabled!==undefined)p.enabled=!!b.enabled;
    if(b.url!==undefined){if(!/^(https?:\/\/[^\s]+|\/mock\/[a-z]+)$/.test(b.url))throw bad('Invalid gateway URL');p.url=b.url}
    if(b.timeout!==undefined){const t=+b.timeout;if(!(t>=500&&t<=15000))throw bad('Timeout must be 500-15000 ms');p.timeout=t}
    if(b.retries!==undefined){const r=+b.retries;if(!Number.isInteger(r)||r<0||r>5)throw bad('Retry must be 0-5');p.retries=r}
    if(b.token)p.tokenEnc=enc(String(b.token));
    return pub(repos.gateways.update(i,p))}
  async test(i,origin){const r=await create(this.get(i)).test(origin);return{ok:r.ok,status:r.status,responseTime:r.ms,error:r.error||(r.ok?null:'Request failed')}}
}
class NotificationHistoryService{
  list(q){let l=repos.logs.all();
    if(q.channel)l=l.filter(x=>x.channel===q.channel);if(q.status)l=l.filter(x=>x.status===q.status);
    if(q.from)l=l.filter(x=>x.createdAt>=new Date(q.from).toISOString());
    if(q.to)l=l.filter(x=>x.createdAt<=new Date(new Date(q.to).getTime()+864e5).toISOString());
    if(q.search){const s=String(q.search).toLowerCase();l=l.filter(x=>[x.recipient,x.message,x.messageId].join(' ').toLowerCase().includes(s))}
    const page=Math.max(1,+q.page||1),size=25;
    return{total:l.length,page,size,items:l.slice((page-1)*size,page*size)}}
  get(i){const l=repos.logs.get(i);if(!l)throw nf('Not found');return l}
}
class NotificationService{ // depends only on the gateway abstraction
  constructor(gm){this.gm=gm}
  async send(b,origin){
    const channel=String(b.channel||'').toLowerCase();
    if(!CH.includes(channel))throw bad('Invalid channel');
    const recipient=String(b.recipient||'').trim(),message=String(b.message||'').trim(),title=String(b.title||'').trim();
    if(!recipient||recipient.length>200)throw bad('Recipient is required');
    if(channel==='sms'&&!/^\+?\d{9,15}$/.test(recipient))throw bad('Phone number must be 9-15 digits');
    if(!message||message.length>1000)throw bad('Message is required (max 1000 chars)');
    if(title.length>100)throw bad('Title is too long');
    const g=this.gm.get(channel);if(!g.enabled)throw Object.assign(new Error('Gateway is disabled'),{status:409});
    const r=await create(g).send({recipient,title,message},origin),s=repos.settings.get();
    const log={id:id(),gatewayId:g.id,channel,recipient,title,message,status:r.ok?'sent':'failed',messageId:r.data.messageId||null,
      responseCode:r.status,responseTime:r.ms,errorMessage:r.ok?null:(r.error||r.data.error||'Gateway error'),request:r.request,response:r.data,createdAt:new Date().toISOString()};
    if(s.history)repos.logs.add(log);
    if(s.logging)console.log(`[notify] ${channel} ${log.status} ${r.status} ${r.ms}ms`); // never log secrets
    return log}
}
class StatisticsService{
  summary(range){const from=since(range),all=repos.logs.all(),l=all.filter(x=>x.createdAt>=from);
    const ok=l.filter(x=>x.status==='sent').length,days={},by={sms:0,zalo:0,push:0};
    l.forEach(x=>{const d=x.createdAt.slice(0,10);days[d]=days[d]||{date:d,sent:0,failed:0};days[d][x.status==='sent'?'sent':'failed']++;by[x.channel]++});
    const t0=new Date();t0.setHours(0,0,0,0);
    const gateways=CH.map(c=>{const a=all.filter(x=>x.channel===c),t=a.filter(x=>x.createdAt>=t0.toISOString()),r=l.filter(x=>x.channel===c),rs=r.filter(x=>x.status==='sent').length;
      return{id:c,requestsToday:t.length,successToday:t.filter(x=>x.status==='sent').length,failedToday:t.filter(x=>x.status==='failed').length,
        lastRequest:a[0]?a[0].createdAt:null,requests:r.length,successRate:r.length?+(rs/r.length*100).toFixed(1):0}});
    return{total:l.length,success:ok,failed:l.length-ok,successRate:l.length?+(ok/l.length*100).toFixed(1):0,
      perDay:Object.values(days).sort((a,b)=>a.date.localeCompare(b.date)),byChannel:by,gateways}}
}
class ApiKeyService{
  list(){return repos.keys.all().map(({hash,...k})=>k)}
  create(name){name=String(name||'').trim();if(!name||name.length>60)throw bad('Key name is required');
    const secret='sk_live_'+crypto.randomBytes(24).toString('hex'),k={id:id(),name,hash:ApiKeyService.hash(secret),preview:secret.slice(0,8)+'••••'+secret.slice(-4),createdAt:new Date().toISOString(),lastUsed:null,status:'active'};
    repos.keys.add(k);return{...this.list()[0],secret}} // secret shown exactly once
  revoke(i){const k=repos.keys.get(i);if(!k)throw nf('Not found');k.status='revoked';return{ok:true}}
  static hash(s){return crypto.createHash('sha256').update(s).digest('hex')}
  static verify(s){const k=repos.keys.byHash(ApiKeyService.hash(String(s)));if(k)k.lastUsed=new Date().toISOString();return!!k}
}
const gm=new GatewayManagementService();
module.exports={gm,history:new NotificationHistoryService(),notifier:new NotificationService(gm),stats:new StatisticsService(),keys:new ApiKeyService(),repos,ApiKeyService};
