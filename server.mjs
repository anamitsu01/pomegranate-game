import http from 'node:http';
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {newRoom,addPlayer,act,view,insist} from './lib/game.mjs';

const root=dirname(fileURLToPath(import.meta.url)),dataDir=resolve(process.env.DATA_DIR||resolve(root,'data'));
mkdirSync(dataDir,{recursive:true});
const savePath=resolve(dataDir,'rooms.json');
let rooms=new Map(existsSync(savePath)?JSON.parse(readFileSync(savePath,'utf8')):[]);
const streams=new Map(),limits=new Map();
function save(){writeFileSync(savePath+'.tmp',JSON.stringify([...rooms]));renameSync(savePath+'.tmp',savePath);}
function publish(r){for(const s of streams.get(r.code)||[]){if(r.players.some(p=>p.id===s.id)){s.res.write(`data: ${JSON.stringify(view(r,s.id))}\n\n`);}else{s.res.end();}}}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));}
function auth(req){const code=String(req.headers['x-room-code']||'').toUpperCase(),token=req.headers.authorization?.replace(/^Bearer /,'');const r=rooms.get(code),p=r?.players.find(p=>p.token===token);insist(r&&p,'部屋または参加情報が見つかりません。');return {r,p};}
function body(req){return new Promise((yes,no)=>{let buf='';req.on('data',c=>{buf+=c;if(buf.length>12000){no(new Error('送信内容が大きすぎます。'));req.destroy();}});req.on('end',()=>{try{yes(JSON.parse(buf||'{}'));}catch{no(new Error('送信内容が正しくありません。'));}});req.on('error',no);});}
const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
const mime={html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml'};
export const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true});
    if(req.method==='GET'&&assets[url.pathname]){const name=assets[url.pathname];res.writeHead(200,{'Content-Type':`${mime[name.split('.').pop()]}; charset=utf-8`});return res.end(readFileSync(resolve(root,'public',name)));}
    if(!url.pathname.startsWith('/api/'))return json(res,404,{error:'見つかりません。'});
    // Browser fetch streams permit an Authorization header, avoiding credentials in URLs.
    if(req.method==='GET'&&url.pathname==='/api/events'){
      const {r,p}=auth(req);const set=streams.get(r.code)||new Set();insist([...set].filter(s=>s.id===p.id).length<4,'接続中のタブが多すぎます。');
      res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`data: ${JSON.stringify(view(r,p.id))}\n\n`);
      const s={id:p.id,res};set.add(s);streams.set(r.code,set);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);
      res.on('close',()=>{clearInterval(timer);set.delete(s);if(!set.size)streams.delete(r.code);});return;
    }
    insist(req.method==='POST','この操作は使用できません。');
    if(req.headers.origin)insist(new URL(req.headers.origin).host===req.headers.host,'別のサイトからの操作はできません。');
    const ip=req.socket.remoteAddress,now=Date.now(),limit=limits.get(ip)||{time:now,count:0};if(now-limit.time>60000){limit.time=now;limit.count=0;}insist(++limit.count<400,'操作が多すぎます。少し待ってください。');limits.set(ip,limit);
    const data=await body(req);
    if(url.pathname==='/api/create'||url.pathname==='/api/join'){
      const name=String(data.name||'').trim();insist(name.length>=1&&name.length<=20,'名前は1〜20文字で入力してください。');
      const token=randomBytes(32).toString('hex');let r,p;
      if(url.pathname==='/api/create'){insist(rooms.size<200,'部屋数の上限です。時間をおいてください。');let code;do{code=randomBytes(4).toString('hex').slice(0,6).toUpperCase();}while(rooms.has(code));r=newRoom(code,name,token);p=r.players[0];rooms.set(code,r);}
      else{r=rooms.get(String(data.code||'').trim().toUpperCase());insist(r,'部屋が見つかりません。');p=addPlayer(r,name,token);}
      r.version++;r.updatedAt=now;save();publish(r);return json(res,200,{code:r.code,token,state:view(r,p.id)});
    }
    const {r,p}=auth(req);
    if(url.pathname==='/api/state')return json(res,200,{state:view(r,p.id)});
    insist(url.pathname==='/api/action','不明な操作です。');insist(data.version===r.version,'状態が更新されました。最新の画面で操作してください。');
    // Execute against a copy; failed actions cannot partly mutate a game.
    const copy=structuredClone(r),player=copy.players.find(q=>q.id===p.id);
    if(data.action==='leave'){
      insist(copy.phase==='lobby','対戦中の席は再接続のため残ります。');copy.players=copy.players.filter(q=>q.id!==p.id);if(copy.hostId===p.id)copy.hostId=copy.players[0]?.id;
      if(!copy.players.length)rooms.delete(copy.code);else{copy.version++;rooms.set(copy.code,copy);}save();publish(copy);return json(res,200,{left:true});
    }
    act(copy,player,data.action,data.data||{});copy.version++;copy.updatedAt=now;rooms.set(copy.code,copy);save();publish(copy);json(res,200,{state:view(copy,p.id)});
  }catch(e){if(!res.headersSent)json(res,400,{error:e.message||'処理に失敗しました。'});else res.end();}
});
const cleanup=setInterval(()=>{const now=Date.now();for(const [code,r] of rooms)if(now-r.updatedAt>7*24*3600000&&!streams.has(code))rooms.delete(code);for(const [k,v] of limits)if(now-v.time>120000)limits.delete(k);save();},3600000);cleanup.unref();
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`ザクロの継承 http://localhost:${server.address().port}`));
