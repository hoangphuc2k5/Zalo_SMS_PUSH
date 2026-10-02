const express=require('express'),jwt=require('jsonwebtoken'),crypto=require('crypto'),path=require('path');
const S=require('./services');
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'20kb'}));
const SECRET=()=>process.env.JWT_SECRET||process.env.APP_SECRET||'dev-secret-change-me';
const origin=r=>`${r.headers['x-forwarded-proto']||r.protocol}://${r.headers.host}`;
const ah=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);
const h=x=>crypto.createHash('sha256').update(String(x)).digest();
const eq=(a,b)=>crypto.timingSafeEqual(h(a),h(b));

app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
  const allow=(process.env.CORS_ORIGINS||'').split(',').filter(Boolean),o=req.headers.origin;
  if(o&&allow.includes(o))res.set({'Access-Control-Allow-Origin':o,'Vary':'Origin','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Api-Key','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE'});
  if(req.method==='OPTIONS')return res.sendStatus(204);next()});

const hits=new Map();
const rateLimit=(max,ms)=>(req,res,next)=>{const k=String(req.headers['x-forwarded-for']||req.ip),n=Date.now(),a=(hits.get(k+req.path)||[]).filter(t=>n-t<ms);
  if(a.length>=max)return res.status(429).json({error:'Too many requests. Try again in a minute.'});a.push(n);hits.set(k+req.path,a);next()};
const admin=(req,res,next)=>{try{jwt.verify((req.headers.authorization||'').slice(7),SECRET());next()}catch{res.status(401).json({error:'Authentication required'})}};
const adminOrKey=(req,res,next)=>{const k=req.headers['x-api-key'];if(k&&S.ApiKeyService.verify(k))return next();admin(req,res,next)};

app.get('/api/health',(q,s)=>s.json({status:'online',env:process.env.VERCEL_ENV||process.env.NODE_ENV||'development'}));
app.post('/api/auth/login',rateLimit(10,60000),(req,res)=>{const{username,password}=req.body||{};
  if(eq(username,process.env.ADMIN_USER||'admin')&&eq(password,process.env.ADMIN_PASSWORD||'Admin@123'))
    return res.json({token:jwt.sign({role:'admin'},SECRET(),{expiresIn:'8h'})});
  res.status(401).json({error:'Invalid username or password'})});

// Mock gateways: swap the gateway URL for a real provider later; UI and services stay unchanged.
const mockAuth=(q,s,n)=>eq((q.headers.authorization||'').replace('Bearer ',''),process.env.MOCK_TOKEN||'demo-token')?n():s.status(401).json({success:false,error:'Invalid gateway token'});
const need={sms:['phone','message'],zalo:['phone','message'],push:['recipient','message']};
Object.keys(need).forEach(c=>app.post('/mock/'+c,mockAuth,(req,res)=>{const b=req.body||{},rid=crypto.randomBytes(3).toString('hex').toUpperCase();
  if(b.test)return res.json({success:true,channel:c,messageId:c.toUpperCase()+'-TEST-'+rid,status:'ok'});
  if(need[c].some(f=>!b[f]))return res.status(400).json({success:false,error:'Missing: '+need[c].join(', ')});
  if(/\[fail\]/i.test(b.message))return res.status(500).json({success:false,error:'Simulated failure'});
  res.json({success:true,channel:c,messageId:c.toUpperCase()+'-DEMO-'+rid,status:'sent'})}));

app.post('/api/notifications/send',adminOrKey,rateLimit(30,60000),ah(async(q,s)=>{const l=await S.notifier.send(q.body||{},origin(q));
  s.status(l.status==='sent'?200:502).json({success:l.status==='sent',messageId:l.messageId,responseTime:l.responseTime,status:l.status,error:l.errorMessage,id:l.id})}));

app.use('/api',admin);
app.get('/api/dashboard',(q,s)=>{const d=S.stats.summary(q.query.range),g=S.gm.list();s.json({...d,gateways:d.gateways.map(x=>({...x,...g.find(y=>y.id===x.id)}))})});
app.get('/api/statistics',(q,s)=>s.json(S.stats.summary(q.query.range||'30d')));
app.get('/api/gateways',(q,s)=>{const st=S.stats.summary('30d').gateways;s.json(S.gm.list().map(g=>({...g,...st.find(x=>x.id===g.id)})))});
app.get('/api/gateways/:id',(q,s)=>{const g=S.gm.list().find(x=>x.id===q.params.id);g?s.json(g):s.status(404).json({error:'Gateway not found'})});
app.put('/api/gateways/:id',(q,s)=>s.json(S.gm.update(q.params.id,q.body||{})));
app.post('/api/gateways/:id/test',ah(async(q,s)=>s.json(await S.gm.test(q.params.id,origin(q)))));
app.get('/api/notifications',(q,s)=>s.json(S.history.list(q.query)));
app.get('/api/notifications/:id',(q,s)=>s.json(S.history.get(q.params.id)));
app.get('/api/settings',(q,s)=>s.json(S.repos.settings.get()));
app.put('/api/settings',(q,s)=>{const b=q.body||{};if(!['sms','zalo','push'].includes(b.defaultGateway))return s.status(400).json({error:'Invalid default gateway'});
  if(!(b.timeout>=500&&b.timeout<=15000)||!(b.retries>=0&&b.retries<=5))return s.status(400).json({error:'Timeout 500-15000, retry 0-5'});
  s.json(S.repos.settings.set({defaultGateway:b.defaultGateway,timeout:+b.timeout,retries:+b.retries,logging:!!b.logging,history:!!b.history}))});
app.post('/api/settings/reset',(q,s)=>s.json(S.repos.settings.reset()));
app.get('/api/api-keys',(q,s)=>s.json(S.keys.list()));
app.post('/api/api-keys',(q,s)=>s.status(201).json(S.keys.create((q.body||{}).name)));
app.delete('/api/api-keys/:id',(q,s)=>s.json(S.keys.revoke(q.params.id)));

app.use(express.static(path.join(__dirname,'..','public')));
app.use((err,req,res,next)=>{const st=err.status||500;if(st>=500)console.error('[error]',err.message);
  res.status(st).json({error:st>=500?'Internal server error':err.message})});
module.exports=app;
