const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
// sichert, dass "/" index.html liefert
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== Spielzustand =====
/*
rooms[code] = {
  code, status, players:[{id,name,isOnline}], dealerIdx, turnIdx,
  deck, topIndex, round:{phase:'first'|'second', currentRank, firstGuess, hint},
  history:[{rank, byPlayerId}], tally:{[playerId]: number}
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

function publicSnapshot(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({ id: p.id, name: p.name, isOnline: p.isOnline })),
    dealerIdx: room.dealerIdx,
    turnIdx: room.turnIdx,
    deckCount: Math.max(0, room.deck.length - room.topIndex),
    round: room.round ? { phase: room.round.phase, firstGuess: room.round.firstGuess ?? null, hint: room.round.hint ?? null } : null,
    history: room.history,
    tally: room.tally
  };
}

function startGame(room) {
  room.status = 'playing';
  room.deck = makeDeck();
  room.topIndex = 0;
  room.history = [];
  room.tally = {};
  for (const p of room.players) room.tally[p.id] = 0;

  // Dealer zufällig bestimmen
  room.dealerIdx = Math.floor(Math.random() * room.players.length);
  room.turnIdx   = nextIdx(room.dealerIdx, room.players.length);
  startRound(room);
}

function startRound(room) {
  if (room.topIndex >= room.deck.length) { room.status = 'ended'; room.round = null; return; }
  room.round = { phase: 'first', currentRank: room.deck[room.topIndex], firstGuess: null, hint: null };
  // aktuelle Karte an Dealer schicken
  const dealerId = room.players[room.dealerIdx].id;
  io.to(dealerId).emit('dealer:peek', { rank: room.round.currentRank });
}

function advanceAfterReveal(room) {
  room.topIndex += 1;

  // Dealer rotiert IMMER reihum
  room.dealerIdx = nextIdx(room.dealerIdx, room.players.length);
  room.turnIdx   = nextIdx(room.dealerIdx, room.players.length);

  if (room.topIndex >= room.deck.length) { room.status = 'ended'; room.round = null; }
  else startRound(room);
}

io.on('connection', (socket) => {
  // Raum erstellen
  socket.on('room:create', ({ name }, cb) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms[code] = {
      code,
      status: 'lobby',
      players: [{ id: socket.id, name: (name || 'Spieler').trim(), isOnline: true }],
      dealerIdx: 0,
      turnIdx: 0,
      deck: [],
      topIndex: 0,
      round: null,
      history: [],
      tally: { [socket.id]: 0 },
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = (name || 'Spieler').trim();
    cb?.({ ok: true, code });
    io.to(code).emit('room:update', publicSnapshot(rooms[code]));
  });

  // Raum beitreten
  socket.on('room:join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (room.status === 'ended') return cb?.({ ok: false, error: 'Spiel beendet' });

    room.players.push({ id: socket.id, name: (name || 'Spieler').trim(), isOnline: true });
    room.tally[socket.id] = 0;
    socket.join(code);
    socket.data.code = code;
    socket.data.name = (name || 'Spieler').trim();
    cb?.({ ok: true, code });
    io.to(code).emit('room:update', publicSnapshot(room));
  });

  // Spiel starten (jeder darf starten – Dealer wird ja random)
  socket.on('game:start', (cb) => {
    const room = rooms[socket.data.code];
    if (!room) return cb?.({ ok: false, error: 'Kein Raum' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Mind. 2 Spieler' });

    startGame(room);
    cb?.({ ok: true });
    io.to(room.code).emit('room:update', publicSnapshot(room));
  });

  // Dealer – Karte nachträglich einsehen (bei Refresh)
  socket.on('dealer:peek', () => {
    const room = rooms[socket.data.code];
    if (!room || !room.round) return;
    if (room.players[room.dealerIdx]?.id !== socket.id) return;
    io.to(socket.id).emit('dealer:peek', { rank: room.round.currentRank });
  });

  // Erster Guess
  socket.on('guess:first', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    if (room.players[room.turnIdx]?.id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });
    if (room.round.phase !== 'first') return cb?.({ ok: false, error: 'Falsche Phase' });
    rank = Number(rank); if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

    const actual = room.round.currentRank;
    if (rank === actual) {
      // Dealer trinkt Kartenwert
      const dealerId = room.players[room.dealerIdx].id;
      room.tally[dealerId] += valueOf(actual);
      io.to(room.code).emit('round:result', { type: 'first-correct', turnPlayerId: socket.id, actual, drinks: valueOf(actual), targetId: dealerId });
      room.history.push({ rank: actual, byPlayerId: socket.id });
      advanceAfterReveal(room);
      io.to(room.code).emit('room:update', publicSnapshot(room));
      return cb?.({ ok: true });
    } else {
      room.round.firstGuess = rank;
      room.round.hint = rank < actual ? 'higher' : 'lower';
      room.round.phase = 'second';
      io.to(room.code).emit('room:update', publicSnapshot(room));
      return cb?.({ ok: true });
    }
  });

  // Zweiter Guess
  socket.on('guess:second', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    if (room.players[room.turnIdx]?.id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });
    if (room.round.phase !== 'second') return cb?.({ ok: false, error: 'Falsche Phase' });
    rank = Number(rank); if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

    const actual = room.round.currentRank;
    const first = room.round.firstGuess ?? actual;

    if (rank === actual) {
      const dealerId = room.players[room.dealerIdx].id;
      const diff = Math.abs(first - actual);
      room.tally[dealerId] += diff;
      io.to(room.code).emit('round:result', { type: 'second-correct', turnPlayerId: socket.id, actual, drinks: diff, targetId: dealerId });
    } else {
      const diff = Math.abs(rank - actual);
      room.tally[socket.id] += diff;
      io.to(room.code).emit('round:result', { type: 'second-wrong', turnPlayerId: socket.id, actual, drinks: diff, targetId: socket.id });
    }

    room.history.push({ rank: actual, byPlayerId: socket.id });
    advanceAfterReveal(room);
    io.to(room.code).emit('room:update', publicSnapshot(room));
    cb?.({ ok: true });
  });

  // Rename
  socket.on('player:rename', ({ name }) => {
    const room = rooms[socket.data.code]; if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.name = (name || '').trim().slice(0, 20) || p.name;
    io.to(room.code).emit('room:update', publicSnapshot(room));
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = rooms[socket.data.code]; if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.isOnline = false;
    if (room.players.every(p => !p.isOnline)) {
      setTimeout(() => { if (rooms[room.code] && rooms[room.code].players.every(p => !p.isOnline)) delete rooms[room.code]; }, 60000);
    }
    io.to(room.code).emit('room:update', publicSnapshot(room));
  });
});

server.listen(PORT, () => console.log('Server listening on', PORT));
