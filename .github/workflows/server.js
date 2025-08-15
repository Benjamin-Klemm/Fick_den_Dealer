const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---------- Game State ----------
const rooms = Object.create(null);
const rankValue = r => r; // 2..10 = Zahl, 11=J, 12=Q, 13=K, 14=A
const nextIdx = (i, n) => (i + 1) % n;
const nextNonDealerIdx = (room, fromIdxExclusive) => {
  let idx = nextIdx(fromIdxExclusive, room.players.length);
  if (idx === room.dealerIdx) idx = nextIdx(idx, room.players.length);
  return idx;
};

function createDeck() {
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
    ownerId: room.ownerId,
    players: room.players.map(p => ({ id: p.id, name: p.name, isOnline: p.isOnline })),
    dealerIdx: room.dealerIdx,
    turnIdx: room.turnIdx,
    deckCount: room.deck.length,
    status: room.status,
    history: room.history.slice(),
    tally: { ...room.tally },
    failCount: room.failCount,
    round: room.round ? {
      phase: room.round.phase,
      firstGuess: room.round.firstGuess,
      hint: room.round.hint
    } : null
  };
}

// ---- feste Game-Over-Meldung (kein Verlierer ermittelt) ----
function finishGame(room) {
  room.status = 'ended';
  room.round = null;
  // feste Nachricht – unabhängig davon, wer „verloren“ hätte
  const msg = 'Marc hat Verloren und muss sein Getränk Exen';
  io.to(room.code).emit('game:over', { message: msg });
  io.to(room.code).emit('room:update', snapshot(room));
}

function startRound(room) {
  if (room.deck.length === 0) { finishGame(room); return; }
  room.round = { phase: 'first', firstGuess: null, hint: null };
  io.to(room.code).emit('room:update', snapshot(room));

  // Dealer sieht Karte automatisch
  const dealerId = room.players[room.dealerIdx].id;
  const currentRank = room.deck[0];
  io.to(dealerId).emit('dealer:peek', { rank: currentRank });
}

function advanceAfterReveal(room) {
  // Dealerwechsel nach 3 misslungenen zweiten Tipps in Folge
  let dealerRotated = false;
  if (room.failCount >= 3) {
    room.dealerIdx = nextIdx(room.dealerIdx, room.players.length);
    room.failCount = 0;
    dealerRotated = true;
  }
  // Nächster Tipp-Spieler ≠ Dealer
  if (dealerRotated) {
    room.turnIdx = nextNonDealerIdx(room, room.dealerIdx);
  } else {
    room.turnIdx = nextNonDealerIdx(room, room.turnIdx);
  }
  startRound(room);
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  // Raum erstellen
  socket.on('room:create', ({ name }, cb) => {
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    const playerName = (name || 'Spieler').trim();

    rooms[code] = {
      code,
      ownerId: socket.id,
      players: [{ id: socket.id, name: playerName, isOnline: true }],
      dealerIdx: 0,
      turnIdx: 0,
      deck: [],
      history: [],
      tally: { [socket.id]: 0 },
      status: 'lobby',
      failCount: 0,
      round: null
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.name = playerName;

    cb?.({ ok: true, code });
    io.to(code).emit('room:update', snapshot(rooms[code]));
  });

  // Raum beitreten (Duplikate & gleiche Namen verhindern)
  socket.on('room:join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (room.status === 'ended') return cb?.({ ok: false, error: 'Spiel beendet' });
    if (room.players.some(p => p.id === socket.id)) return cb?.({ ok: false, error: 'Du bist schon im Raum' });

    const playerName = (name || 'Spieler').trim();
    if (room.players.some(p => p.name === playerName)) return cb?.({ ok: false, error: 'Name bereits vergeben' });

    room.players.push({ id: socket.id, name: playerName, isOnline: true });
    room.tally[socket.id] = 0;

    socket.join(code);
    socket.data.code = code;
    socket.data.name = playerName;

    cb?.({ ok: true, code });
    io.to(code).emit('room:update', snapshot(room));
  });

  // Spiel starten (nur Owner)
  function startNewGame(room) {
    room.deck = createDeck();
    room.history = [];
    room.tally = {};
    for (const p of room.players) room.tally[p.id] = 0;
    room.status = 'playing';
    room.failCount = 0;
    room.dealerIdx = Math.floor(Math.random() * room.players.length);
    room.turnIdx = nextNonDealerIdx(room, room.dealerIdx);
    startRound(room);
  }

  socket.on('game:start', (cb) => {
    const room = rooms[socket.data.code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (socket.id !== room.ownerId) return cb?.({ ok: false, error: 'Nur der Ersteller darf starten' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Mindestens 2 Spieler' });
    startNewGame(room);
    cb?.({ ok: true });
  });

  // Neustart am Ende (nur Owner)
  socket.on('game:restart', (cb) => {
    const room = rooms[socket.data.code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (socket.id !== room.ownerId) return cb?.({ ok: false, error: 'Nur der Ersteller darf neu starten' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Mindestens 2 Spieler' });
    startNewGame(room);
    cb?.({ ok: true });
  });

  // Dealer: Karte ansehen (optional manuell)
  socket.on('dealer:peek', () => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    const dealerId = room.players[room.dealerIdx].id;
    if (dealerId !== socket.id) return;
    io.to(socket.id).emit('dealer:peek', { rank: room.deck[0] });
  });

  // Erster Tipp
  socket.on('guess:first', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    const dealerId = room.players[room.dealerIdx].id;

    if (socket.id === dealerId) return cb?.({ ok: false, error: 'Der Dealer rät nicht.' });
    if (room.players[room.turnIdx].id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });

    rank = Number(rank);
    if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

    room.round.firstGuess = rank;

    const actual = room.deck[0];
    if (rank === actual) {
      const dealer = room.players[room.dealerIdx];
      const drinks = rankValue(actual);
      room.tally[dealer.id] += drinks;

      const msg = `${socket.data.name} hat ${dealer.name} ${drinks} Schlücke eingeschenkt`;
      io.to(room.code).emit('round:result', { type: 'first-correct', turnPlayerId: socket.id, targetId: dealer.id, drinks, actual, message: msg });

      room.history.push(actual);
      room.deck.shift();
      room.failCount = 0;

      if (room.deck.length === 0) finishGame(room);
      else advanceAfterReveal(room);
    } else {
      room.round.hint = rank < actual ? 'higher' : 'lower';
      room.round.phase = 'second';
      io.to(room.code).emit('room:update', snapshot(room));
    }

    cb?.({ ok: true });
  });

  // Zweiter Tipp
  socket.on('guess:second', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    const dealerId = room.players[room.dealerIdx].id;

    if (socket.id === dealerId) return cb?.({ ok: false, error: 'Der Dealer rät nicht.' });
    if (room.players[room.turnIdx].id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });

    rank = Number(rank);
    if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

    const actual = room.deck[0];
    const first = room.round.firstGuess ?? actual;

    if (rank === actual) {
      const dealer = room.players[room.dealerIdx];
      const drinks = Math.abs(first - actual);
      room.tally[dealer.id] += drinks;

      const msg = `${socket.data.name} hat ${dealer.name} ${drinks} Schlücke eingeschenkt`;
      io.to(room.code).emit('round:result', { type: 'second-correct', turnPlayerId: socket.id, targetId: dealer.id, drinks, actual, message: msg });

      room.failCount = 0;
    } else {
      const drinks = Math.abs(rank - actual);
      room.tally[socket.id] += drinks;

      const playerName = socket.data.name;
      const dealerName = room.players[room.dealerIdx].name;
      const msg = `Dealer ${dealerName} hat ${playerName} ${drinks} Schlücke eingeschenkt`;
      io.to(room.code).emit('round:result', { type: 'second-wrong', turnPlayerId: socket.id, targetId: socket.id, drinks, actual, message: msg });

      room.failCount += 1;
    }

    room.history.push(actual);
    room.deck.shift();

    if (room.deck.length === 0) finishGame(room);
    else advanceAfterReveal(room);

    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.code];
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.isOnline = false;
    io.to(room.code).emit('room:update', snapshot(room));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
