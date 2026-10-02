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
class TwilioGateway extends NotificationGateway{
  get accountSid(){
    if(process.env.TWILIO_ACCOUNT_SID)return process.env.TWILIO_ACCOUNT_SID;
    const m=(this.g.url||'').match(/Accounts\/(AC[a-zA-Z0-9]+)/i);
    return m?m[1]:'';
  }
  get authToken(){return(this.g.tokenEnc&&dec(this.g.tokenEnc))||process.env.TWILIO_AUTH_TOKEN||process.env.TWILIO_GATEWAY_TOKEN||'demo-token'}
  get fromNumber(){return process.env.TWILIO_PHONE_NUMBER||process.env.TWILIO_FROM||''}
  get isTwilioApi(){return this.url.includes('api.twilio.com')||(Boolean(this.accountSid)&&!this.g.url)}
  get url(){
    if(this.g.url)return this.g.url;
    if(process.env.TWILIO_GATEWAY_URL)return process.env.TWILIO_GATEWAY_URL;
    if(this.accountSid)return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    return '/mock/twilio';
  }
  buildPayload(m){
    return{To:m.recipient,From:this.fromNumber||undefined,Body:m.message,to:m.recipient,phone:m.recipient,message:m.message};
  }
  async call(body,origin,timeout){
    if(this.isTwilioApi&&this.accountSid){
      const u=this.url.startsWith('/')?origin+this.url:this.url,ac=new AbortController(),t0=Date.now(),to=setTimeout(()=>ac.abort(),timeout);
      try{
        const auth=Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
        const form=new URLSearchParams();
        form.append('To',body.To||body.to||body.phone||body.recipient);
        if(body.From||body.from||this.fromNumber)form.append('From',body.From||body.from||this.fromNumber);
        form.append('Body',body.Body||body.body||body.message);
        const r=await fetch(u,{
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+auth},
          body:form.toString(),
          signal:ac.signal
        });
        const data=await r.json().catch(()=>({}));
        const ok=r.ok&&!data.error_code&&!data.code&&data.status!=='failed'&&data.status!=='undelivered';
        return{ok,status:r.status,data:{...data,messageId:data.sid||data.messageId},ms:Date.now()-t0,error:ok?null:(data.message||data.error_message||'Twilio error')};
      }catch(e){
        const t=e.name==='AbortError';
        return{ok:false,status:t?408:502,data:{},ms:Date.now()-t0,error:t?'Timeout':(e.message||'Gateway unreachable')};
      }finally{clearTimeout(to)}
    }
    return super.call(body,origin,timeout);
  }
  async test(origin){
    if(this.isTwilioApi&&this.accountSid){
      const ac=new AbortController(),t0=Date.now(),to=setTimeout(()=>ac.abort(),this.g.timeout);
      try{
        const auth=Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
        const u=`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}.json`;
        const r=await fetch(u,{method:'GET',headers:{Authorization:'Basic '+auth},signal:ac.signal});
        const data=await r.json().catch(()=>({}));
        return{ok:r.ok,status:r.status,data,ms:Date.now()-t0,error:r.ok?null:(data.message||'Twilio authentication failed')};
      }catch(e){
        const t=e.name==='AbortError';
        return{ok:false,status:t?408:502,ms:Date.now()-t0,error:t?'Timeout':'Twilio unreachable'};
      }finally{clearTimeout(to)}
    }
    return super.test(origin);
  }
}
class SmsGateway extends NotificationGateway{
  constructor(g){
    super(g);
    if(process.env.SMS_PROVIDER==='twilio'||g.url?.includes('api.twilio.com')){
      this.twilio=new TwilioGateway(g);
    }
  }
  buildPayload(m){return this.twilio?this.twilio.buildPayload(m):{phone:m.recipient,message:m.message}}
  call(body,origin,timeout){return this.twilio?this.twilio.call(body,origin,timeout):super.call(body,origin,timeout)}
  test(origin){return this.twilio?this.twilio.test(origin):super.test(origin)}
}
class ZaloGateway extends NotificationGateway{buildPayload(m){return{phone:m.recipient,message:m.message}}}
class PushGateway extends NotificationGateway{buildPayload(m){return{recipient:m.recipient,title:m.title,message:m.message}}}
const map={sms:SmsGateway,zalo:ZaloGateway,push:PushGateway,twilio:TwilioGateway};
module.exports={create:g=>new map[g.type](g)};


