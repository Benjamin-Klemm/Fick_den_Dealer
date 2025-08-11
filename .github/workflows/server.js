
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
const rooms = Object.create(null);
function makeDeck(){ const d=[]; for(let r=2;r<=14;r++){ for(let s=0;s<4;s++) d.push(r);} for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];} return d;}
const valueOf=r=>r; const nextIdx=(i,n)=>(i+1)%n;
function broadcastRoom(code){ const room=rooms[code]; if(!room)return;
  const snap={ code:room.code,status:room.status,players:room.players.map(p=>({id:p.id,name:p.name,isOnline:p.isOnline})),dealerIdx:room.dealerIdx,turnIdx:room.turnIdx,consecutiveFails:room.consecutiveFails,deckCount:Math.max(0,room.deck.length-room.topIndex),round:room.round?{phase:room.round.phase,firstGuess:room.round.firstGuess??null,hint:room.round.hint??null}:null,history:room.history,tally:room.tally};
  io.to(code).emit('room:update',snap);
}
function startGame(code){ const room=rooms[code]; if(!room||room.players.length<2)return;
  room.status='playing'; room.deck=makeDeck(); room.topIndex=0; room.history=[]; room.tally={}; for(const p of room.players) room.tally[p.id]=0;
  room.dealerIdx=0; room.turnIdx=(room.dealerIdx+1)%room.players.length; room.consecutiveFails=0; startRound(room);
}
function startRound(room){ if(room.topIndex>=room.deck.length){ room.status='ended'; room.round=null; return; }
  room.round={phase:'first',currentRank:room.deck[room.topIndex],firstGuess:null,hint:null};
}
function advanceAfterReveal(room){ room.topIndex+=1; room.turnIdx=nextIdx(room.turnIdx, room.players.length); if(room.turnIdx===room.dealerIdx) room.turnIdx=nextIdx(room.turnIdx, room.players.length);
  if(room.consecutiveFails>=3){ room.dealerIdx=nextIdx(room.dealerIdx, room.players.length); room.turnIdx=nextIdx(room.dealerIdx, room.players.length); room.consecutiveFails=0; }
  if(room.topIndex>=room.deck.length){ room.status='ended'; room.round=null; } else startRound(room);
}
io.on('connection',(socket)=>{
  socket.on('room:create',({name},cb)=>{ const code=Math.random().toString(36).slice(2,8).toUpperCase();
    rooms[code]={code,createdAt:Date.now(),status:'lobby',players:[{id:socket.id,name:(name||'Spieler').trim(),isOnline:true}],dealerIdx:0,turnIdx:0,consecutiveFails:0,deck:[],topIndex:0,round:null,history:[],tally:{[socket.id]:0}};
    socket.join(code); socket.data.code=code; socket.data.name=(name||'Spieler').trim(); cb?.({ok:true,code}); broadcastRoom(code);
  });
  socket.on('room:join',({code,name},cb)=>{ code=(code||'').toUpperCase(); const room=rooms[code];
    if(!room) return cb?.({ok:false,error:'Raum nicht gefunden'}); if(room.status==='ended') return cb?.({ok:false,error:'Spiel bereits beendet'});
    room.players.push({id:socket.id,name:(name||'Spieler').trim(),isOnline:true}); room.tally[socket.id]=0; socket.join(code); socket.data.code=code; socket.data.name=(name||'Spieler').trim(); cb?.({ok:true,code}); broadcastRoom(code);
  });
  socket.on('game:start',(cb)=>{ const code=socket.data.code; const room=rooms[code]; if(!room)return;
    if(room.players[room.dealerIdx]?.id!==socket.id) return cb?.({ok:false,error:'Nur der Dealer darf starten'}); if(room.players.length<2) return cb?.({ok:false,error:'Mindestens 2 Spieler'});
    startGame(code); cb?.({ok:true}); const dId=room.players[room.dealerIdx].id; io.to(dId).emit('dealer:peek',{rank:room.round?.currentRank}); broadcastRoom(code);
  });
  socket.on('dealer:peek',()=>{ const code=socket.data.code; const room=rooms[code]; if(!room||!room.round)return; if(room.players[room.dealerIdx]?.id!==socket.id) return; io.to(socket.id).emit('dealer:peek',{rank:room.round.currentRank}); });
  socket.on('guess:first',({rank},cb)=>{ const code=socket.data.code; const room=rooms[code]; if(!room||room.status!=='playing'||!room.round)return;
    if(room.players[room.turnIdx]?.id!==socket.id) return cb?.({ok:false,error:'Du bist nicht am Zug'}); if(room.round.phase!=='first') return cb?.({ok:false,error:'Nicht der erste Versuch'});
    rank=Number(rank); if(!(rank>=2&&rank<=14)) return cb?.({ok:false,error:'Ungültiger Rang'});
    const actual=room.round.currentRank; if(rank===actual){ room.tally[room.players[room.dealerIdx].id]+=actual; io.to(room.code).emit('round:result',{type:'first-correct',turnPlayerId:socket.id,actual,drinks:actual,targetId:room.players[room.dealerIdx].id});
      room.history.push({rank:actual,byPlayerId:socket.id}); advanceAfterReveal(room); if(room.status==='playing'&&room.round){ const dId=room.players[room.dealerIdx].id; io.to(dId).emit('dealer:peek',{rank:room.round.currentRank}); } broadcastRoom(code); return cb?.({ok:true});
    } else { room.round.firstGuess=rank; room.round.hint= rank<actual?'higher':'lower'; room.round.phase='second'; broadcastRoom(code); return cb?.({ok:true}); }
  });
  socket.on('guess:second',({rank},cb)=>{ const code=socket.data.code; const room=rooms[code]; if(!room||room.status!=='playing'||!room.round)return;
    if(room.players[room.turnIdx]?.id!==socket.id) return cb?.({ok:false,error:'Du bist nicht am Zug'}); if(room.round.phase!=='second') return cb?.({ok:false,error:'Nicht der zweite Versuch'});
    rank=Number(rank); if(!(rank>=2&&rank<=14)) return cb?.({ok:false,error:'Ungültiger Rang'});
    const actual=room.round.currentRank; const first=room.round.firstGuess??actual;
    if(rank===actual){ const diff=Math.abs(first-actual); room.tally[room.players[room.dealerIdx].id]+=diff; io.to(room.code).emit('round:result',{type:'second-correct',turnPlayerId:socket.id,actual,drinks:diff,targetId:room.players[room.dealerIdx].id}); }
    else { const diff=Math.abs(rank-actual); room.tally[socket.id]+=diff; room.consecutiveFails+=1; io.to(room.code).emit('round:result',{type:'second-wrong',turnPlayerId:socket.id,actual,drinks:diff,targetId:socket.id}); }
    room.history.push({rank:actual,byPlayerId:socket.id}); advanceAfterReveal(room); if(room.status==='playing'&&room.round){ const dId=room.players[room.dealerIdx].id; io.to(dId).emit('dealer:peek',{rank:room.round.currentRank}); } broadcastRoom(code); cb?.({ok:true});
  });
  socket.on('player:rename',({name})=>{ const code=socket.data.code; const room=rooms[code]; if(!room) return; const p=room.players.find(p=>p.id===socket.id); if(p) p.name=(name||'').trim().slice(0,20)||p.name; broadcastRoom(code); });
  socket.on('disconnect',()=>{ const code=socket.data.code; if(!code||!rooms[code])return; const room=rooms[code]; const p=room.players.find(p=>p.id===socket.id); if(p) p.isOnline=false;
    if(room.players.every(p=>!p.isOnline)){ setTimeout(()=>{ if(rooms[code]&&rooms[code].players.every(p=>!p.isOnline)) delete rooms[code]; },60000);} broadcastRoom(code);
  });
});
server.listen(PORT,()=>console.log('Server listening on',PORT));
