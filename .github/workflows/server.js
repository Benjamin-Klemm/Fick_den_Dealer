const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static & Health
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---------- Game State ----------
const rooms = Object.create(null);
const rankValue = r => r;                 // 2..10 = Zahl, J=11, Q=12, K=13, A=14
const nextIdx = (i, n) => (i + 1) % n;
const nextNonDealerIdx = (room, fromIdxExclusive) => {
  // finde den nächsten Index ≠ dealerIdx (ein Schritt weiter als fromIdxExclusive)
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

function startRound(room) {
  if (room.deck.length === 0) {
    room.status = 'ended';
    room.round = null;
    io.to(room.code).emit('room:update', snapshot(room));
    return;
  }
  room.round = { phase: 'first', firstGuess: null, hint: null };
  io.to(room.code).emit('room:update', snapshot(room));
}

function advanceAfterReveal(room) {
  // Dealerwechsel nach 3 Fehlversuchen in Folge
  let dealerRotated = false;
  if (room.failCount >= 3) {
    room.dealerIdx = nextIdx(room.dealerIdx, room.players.length);
    room.failCount = 0;
    dealerRotated = true;
  }

  // Nächster Tipp-Spieler: immer ein Nicht-Dealer
  if (dealerRotated) {
    room.turnIdx = nextNonDealerIdx(room, room.dealerIdx); // links vom neuen Dealer
  } else {
    room.turnIdx = nextNonDealerIdx(room, room.turnIdx);   // normal weiter, Dealer überspringen
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

  // Raum beitreten (Duplikate verhindern)
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
  socket.on('game:start', (cb) => {
    const room = rooms[socket.data.code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (socket.id !== room.ownerId) return cb?.({ ok: false, error: 'Nur der Ersteller darf starten' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Mindestens 2 Spieler' });

    room.deck = createDeck();
    room.history = [];
    room.tally = {};
    for (const p of room.players) room.tally[p.id] = 0;
    room.status = 'playing';
    room.failCount = 0;

    room.dealerIdx = Math.floor(Math.random() * room.players.length);
    room.turnIdx = nextNonDealerIdx(room, room.dealerIdx); // Startspieler ≠ Dealer

    startRound(room);
    cb?.({ ok: true });
  });

  // Dealer darf Karte ansehen
  socket.on('dealer:peek', () => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    const dealerId = room.players[room.dealerIdx].id;
    if (dealerId !== socket.id) return; // nur Dealer
    const currentRank = room.deck[0];
    socket.emit('dealer:peek', { rank: currentRank });
  });

  // ---------- Guess 1 ----------
  socket.on('guess:first', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    const dealerId = room.players[room.dealerIdx].id;

    // ❗ Dealer darf nie raten
    if (socket.id === dealerId) return cb?.({ ok: false, error: 'Der Dealer rät nicht.' });

    // nur Spieler am Zug
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

      // Nächster Spieler wird in advanceAfterReveal gesetzt (immer ≠ Dealer)
      advanceAfterReveal(room);
    } else {
      room.round.hint = rank < actual ? 'higher' : 'lower';
      room.round.phase = 'second';
      io.to(room.code).emit('room:update', snapshot(room));
    }

    cb?.({ ok: true });
  });

  // ---------- Guess 2 ----------
  socket.on('guess:second', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    const dealerId = room.players[room.dealerIdx].id;

    // ❗ Dealer darf nie raten
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

    // Nächster Spieler/Dealerwechsel
    advanceAfterReveal(room);
    io.to(room.code).emit('room:update', snapshot(room));
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
