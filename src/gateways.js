// Gateway abstraction. Replace Mock with a real provider by changing buildPayload/URL only.
const {dec}=require('./store');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class NotificationGateway{ // INotificationGateway
  constructor(g){this.g=g}
  get env(){return this.g.type.toUpperCase()+'_GATEWAY_'}
  get url(){return this.g.url||process.env[this.env+'URL']||'/mock/'+this.g.type}
  get token(){return(this.g.tokenEnc&&dec(this.g.tokenEnc))||process.env[this.env+'TOKEN']||'demo-token'}
  buildPayload(){throw new Error('Not implemented')}
  async call(body,origin,timeout){
    const u=this.url.startsWith('/')?origin+this.url:this.url,ac=new AbortController(),t0=Date.now(),to=setTimeout(()=>ac.abort(),timeout);
    try{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.token},body:JSON.stringify(body),signal:ac.signal});
      const data=await r.json().catch(()=>({}));return{ok:r.ok&&data.success!==false,status:r.status,data,ms:Date.now()-t0}}
    catch(e){const t=e.name==='AbortError';return{ok:false,status:t?408:502,data:{},ms:Date.now()-t0,error:t?'Timeout':'Gateway unreachable'}}
    finally{clearTimeout(to)}}
  async send(msg,origin){
    const body=this.buildPayload(msg);let r;
    for(let a=0;a<=this.g.retries;a++){r=await this.call(body,origin,this.g.timeout);r.attempts=a+1;
      if(r.ok||(r.status>=400&&r.status<500&&r.status!==408))break;await sleep(150*(a+1))}
    r.request=body;return r}
  test(origin){return this.call({test:true},origin,this.g.timeout)}
}
class SmsGateway extends NotificationGateway{buildPayload(m){return{phone:m.recipient,message:m.message}}}
class ZaloGateway extends NotificationGateway{buildPayload(m){return{phone:m.recipient,message:m.message}}}
class PushGateway extends NotificationGateway{buildPayload(m){return{recipient:m.recipient,title:m.title,message:m.message}}}
const map={sms:SmsGateway,zalo:ZaloGateway,push:PushGateway};
module.exports={create:g=>{
  const Gateway=map[String(g?.type||'').toLowerCase()];
  if(!Gateway)throw Object.assign(new Error(`Unsupported gateway type: ${g?.type||'(empty)'}`),{status:400});
  return new Gateway(g);
}};
