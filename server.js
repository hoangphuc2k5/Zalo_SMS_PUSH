require('dotenv').config();
const app=require('./src/app');const p=process.env.PORT||5000;
app.listen(p,()=>console.log('http://localhost:'+p));
