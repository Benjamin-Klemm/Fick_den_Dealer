const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---- Health & Static ----
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ====== Game State ======
/*
rooms[code] = {
  code, status: 'lobby'|'playing'|'ended',
  ownerId,
  players: [{id,name,isOnline}],
  dealerIdx, turnIdx,
  deck: number[], topIndex,
  history: [{rank, byPlayerId}],
  tally: { [playerId]: number },
  failCount: number,
  round: { phase:'first'|'second', currentRank, firstGuess, hint:'higher'|'lower'|null }
}
*/
const rooms = Object.create(null);
const nextIdx = (i, n) => (i + 1) % n;
const valueOf = r => r;

function makeDeck() {
  const d = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) d.push(r);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function snapshot(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({ id: p.id, name: p.name, isOnline: p.isOnline })),
    dealerIdx: room.dealerIdx,
    turnIdx: room.turnIdx,
    deckCount: Math.max(0, room.deck.length - room.topIndex),
    round: room.round ? {
      phase: room.round.phase,
      firstGuess: room.round.firstGuess ?? null,
      hint: room.round.hint ?? null
    } : null,
    history: room.history,
    tally: room.tally,
    failCount: room.failCount,
    ownerId: room.ownerId
  };
}

function startGame(room) {
  room.status = 'playing';
  room.deck = makeDeck();
  room.topIndex = 0;
  room.history = [];
  room.tally = {};
  for (const p of room.players) room.tally[p.id] = 0;
  room.failCount = 0;

  room.dealerIdx = Math.floor(Math.random() * room.players.length);
  room.turnIdx   = nextIdx(room.dealerIdx, room.players.length);
  startRound(room);
}

function startRound(room) {
  if (room.topIndex >= room.deck.length) {
    room.status = 'ended';
    room.round = null;
    return;
  }
  room.round = { phase: 'first', currentRank: room.deck[room.topIndex], firstGuess: null, hint: null };
  const dealerId = room.players[room.dealerIdx].id;
  io.to(dealerId).emit('dealer:peek', { rank: room.round.currentRank }); // nur Dealer sieht die Karte
}

function advanceAfterReveal(room) {
  room.topIndex += 1;

  if (room.topIndex >= room.deck.length) {
    room.status = 'ended';
    room.round = null;
    return;
  }

  let dealerRotated = false;
  if (room.failCount >= 3) {
    room.dealerIdx = nextIdx(room.dealerIdx, room.players.length);
    room.failCount = 0;
    dealerRotated = true;
  }

  if (dealerRotated) {
    // nach Dealerwechsel: Startspieler ist links vom neuen Dealer
    room.turnIdx = nextIdx(room.dealerIdx, room.players.length);
  } else {
    // sonst: zum nächsten Spieler, Dealer überspringen
    let next = nextIdx(room.turnIdx, room.players.length);
    if (next === room.dealerIdx) next = nextIdx(next, room.players.length);
    room.turnIdx = next;
  }

  startRound(room);
}

// ====== Sockets ======
io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id);

  // Raum erstellen -> Owner ist der Ersteller
  socket.on('room:create', ({ name }, cb) => {
    try {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      rooms[code] = {
        code, status: 'lobby',
        ownerId: socket.id,
        players: [{ id: socket.id, name: (name || 'Spieler').trim(), isOnline: true }],
        dealerIdx: 0, turnIdx: 0,
        deck: [], topIndex: 0, history: [], tally: { [socket.id]: 0 },
        round: null, failCount: 0
      };
      socket.join(code);
      socket.data.code = code;
      socket.data.name = (name || 'Spieler').trim();
      cb?.({ ok: true, code });
      io.to(code).emit('room:update', snapshot(rooms[code]));
    } catch (e) {
      console.error('room:create error', e);
      cb?.({ ok:false, error:'Create failed' });
    }
  });

  // Raum beitreten
  socket.on('room:join', ({ code, name }, cb) => {
    try {
      code = (code || '').toUpperCase();
      const room = rooms[code];
      if (!room) return cb?.({ ok:false, error:'Raum nicht gefunden' });
      if (room.status === 'ended') return cb?.({ ok:false, error:'Spiel beendet' });
      room.players.push({ id: socket.id, name: (name || 'Spieler').trim(), isOnline: true });
      room.tally[socket.id] = 0;
      socket.join(code);
      socket.data.code = code;
      socket.data.name = (name || 'Spieler').trim();
      cb?.({ ok:true, code });
      io.to(code).emit('room:update', snapshot(room));
    } catch (e) {
      console.error('room:join error', e);
      cb?.({ ok:false, error:'Join failed' });
    }
  });

  // Nur Owner darf starten
  socket.on('game:start', (cb) => {
    try {
      const room = rooms[socket.data.code];
      if (!room) return cb?.({ ok:false, error:'Kein Raum' });
      if (socket.id !== room.ownerId) return cb?.({ ok:false, error:'Nur der Ersteller darf starten' });
      if (room.players.length < 2) return cb?.({ ok:false, error:'Mind. 2 Spieler' });
      startGame(room);
      cb?.({ ok:true });
      io.to(room.code).emit('room:update', snapshot(room));
    } catch (e) {
      console.error('game:start error', e);
      cb?.({ ok:false, error:'Start failed' });
    }
  });

  // Dealer sieht Karte (auf Wunsch)
  socket.on('dealer:peek', () => {
    const room = rooms[socket.data.code];
    if (!room || !room.round) return;
    if (room.players[room.dealerIdx]?.id !== socket.id) return;
    io.to(socket.id).emit('dealer:peek', { rank: room.round.currentRank });
  });

  // Erster Tipp
  socket.on('guess:first', ({ rank }, cb) => {
    try {
      const room = rooms[socket.data.code];
      if (!room || room.status !== 'playing' || !room.round) return;
      if (room.players[room.turnIdx]?.id !== socket.id) return cb?.({ ok:false, error:'Nicht dein Zug' });
      if (room.round.phase !== 'first') return cb?.({ ok:false, error:'Falsche Phase' });
      rank = Number(rank); if (!(rank >= 2 && rank <= 14)) return cb?.({ ok:false, error:'Ungültiger Rang' });

      io.to(room.code).emit('round:guess', { which:'first', byPlayerId: socket.id, rank });

      const actual = room.round.currentRank;
      if (rank === actual) {
        room.failCount = 0;
        const dealerId = room.players[room.dealerIdx].id;
        room.tally[dealerId] += valueOf(actual);
        io.to(room.code).emit('round:result', { type:'first-correct', turnPlayerId: socket.id, actual, drinks:valueOf(actual), targetId: dealerId });
        room.history.push({ rank: actual, byPlayerId: socket.id });
        advanceAfterReveal(room);
        io.to(room.code).emit('room:update', snapshot(room));
        return cb?.({ ok:true });
      } else {
        room.round.firstGuess = rank;
        room.round.hint = rank < actual ? 'higher' : 'lower';
        room.round.phase = 'second';
        io.to(room.code).emit('room:update', snapshot(room));
        return cb?.({ ok:true });
      }
    } catch (e) {
      console.error('guess:first error', e);
      cb?.({ ok:false, error:'Guess failed' });
    }
  });

  // Zweiter Tipp
  socket.on('guess:second', ({ rank }, cb) => {
    try {
      const room = rooms[socket.data.code];
      if (!room || room.status !== 'playing' || !room.round) return;
      if (room.players[room.turnIdx]?.id !== socket.id) return cb?.({ ok:false, error:'Nicht dein Zug' });
      if (room.round.phase !== 'second') return cb?.({ ok:false, error:'Falsche Phase' });
      rank = Number(rank); if (!(rank >= 2 && rank <= 14)) return cb?.({ ok:false, error:'Ungültiger Rang' });

      io.to(room.code).emit('round:guess', { which:'second', byPlayerId: socket.id, rank });

      const actual = room.round.currentRank;
      const first = room.round.firstGuess ?? actual;

      if (rank === actual) {
        room.failCount = 0;
        const dealerId = room.players[room.dealerIdx].id;
        const diff = Math.abs(first - actual);
        room.tally[dealerId] += diff;
        io.to(room.code).emit('round:result', { type:'second-correct', turnPlayerId: socket.id, actual, drinks: diff, targetId: dealerId });
      } else {
        const diff = Math.abs(rank - actual);
        room.tally[socket.id] += diff;
        room.failCount += 1;
        io.to(room.code).emit('round:result', { type:'second-wrong', turnPlayerId: socket.id, actual, drinks: diff, targetId: socket.id });
      }

      room.history.push({ rank: actual, byPlayerId: socket.id });
      advanceAfterReveal(room);
      io.to(room.code).emit('room:update', snapshot(room));
      cb?.({ ok:true });
    } catch (e) {
      console.error('guess:second error', e);
      cb?.({ ok:false, error:'Guess failed' });
    }
  });

  // Rename
  socket.on('player:rename', ({ name }) => {
    try {
      const room = rooms[socket.data.code]; if (!room) return;
      const p = room.players.find(p => p.id === socket.id);
      if (p) p.name = (name || '').trim().slice(0, 20) || p.name;
      io.to(room.code).emit('room:update', snapshot(room));
    } catch (e) {
      console.error('player:rename error', e);
    }
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.code]; if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.isOnline = false;
    if (room.players.every(p => !p.isOnline)) {
      setTimeout(() => {
        if (rooms[room.code] && rooms[room.code].players.every(p => !p.isOnline)) delete rooms[room.code];
      }, 60000);
    }
    io.to(room.code).emit('room:update', snapshot(room));
    console.log('[socket] disconnected', socket.id);
  });
});

// ---- Global Error Logging ----
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

// ---- Start Server ----
server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
