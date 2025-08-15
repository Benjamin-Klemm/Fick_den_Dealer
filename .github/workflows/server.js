const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static files
app.use(express.static(path.join(__dirname, 'public')));
// einfache Health-Route (praktisch für Render)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// -------------------- Spielzustand --------------------
// rooms[code] = {
//   code, status: 'lobby'|'playing'|'ended',
//   ownerId,
//   players: [{id,name,isOnline}],
//   dealerIdx, turnIdx,
//   deck: number[],              // nur Ränge 2..14
//   history: number[],           // aufgedeckte Ränge
//   tally: { [playerId]: number },
//   failCount: number,           // Fehlversuche in Folge (nur „zweiter Versuch falsch“ zählt)
//   round: { phase:'first'|'second', firstGuess:number|null, hint:'higher'|'lower'|null }
// }
const rooms = Object.create(null);

const rankValue = r => r; // 2..10 = Zahl, J=11, Q=12, K=13, A=14
const nextIdx = (i, n) => (i + 1) % n;

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

  // Nächster Tipp-Spieler: immer „links vom Dealer“, wenn Dealer wechselte,
  // sonst normal zum nächsten Spieler, aber Dealer überspringen.
  if (dealerRotated) {
    room.turnIdx = nextIdx(room.dealerIdx, room.players.length);
  } else {
    let next = nextIdx(room.turnIdx, room.players.length);
    if (next === room.dealerIdx) next = nextIdx(next, room.players.length);
    room.turnIdx = next;
  }

  startRound(room);
}

// -------------------- Socket-Logik --------------------
io.on('connection', (socket) => {
  // Raum erstellen (Ersteller wird Owner)
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

  // Raum beitreten (mit einfachem Duplikatschutz)
  socket.on('room:join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (room.status === 'ended') return cb?.({ ok: false, error: 'Spiel beendet' });

    if (room.players.some(p => p.id === socket.id)) {
      return cb?.({ ok: false, error: 'Du bist schon im Raum' });
    }

    const playerName = (name || 'Spieler').trim();
    // Optional: gleiche Namen verhindern
    if (room.players.some(p => p.name === playerName)) {
      return cb?.({ ok: false, error: 'Name bereits vergeben' });
    }

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
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (socket.id !== room.ownerId) return cb?.({ ok: false, error: 'Nur der Ersteller darf starten' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Mindestens 2 Spieler' });

    room.deck = createDeck();
    room.history = [];
    room.tally = {};
    for (const p of room.players) room.tally[p.id] = 0;
    room.status = 'playing';
    room.failCount = 0;

    // zufälliger Dealer; Startspieler ist links vom Dealer (Dealer selbst rät nicht)
    room.dealerIdx = Math.floor(Math.random() * room.players.length);
    room.turnIdx = nextIdx(room.dealerIdx, room.players.length);

    startRound(room);
    cb?.({ ok: true });
  });

  // Dealer darf die verdeckte Karte ansehen
  socket.on('dealer:peek', () => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    if (room.players[room.dealerIdx].id !== socket.id) return;
    // Karte ist das oberste Element im Deck
    const currentRank = room.deck[0];
    socket.emit('dealer:peek', { rank: currentRank });
  });

  // Erster Tipp
  socket.on('guess:first', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room || room.status !== 'playing' || !room.round) return;
    // nur Spieler am Zug
    if (room.players[room.turnIdx].id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });

    rank = Number(rank);
    if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

    room.round.firstGuess = rank;

    const actual = room.deck[0];
    if (rank === actual) {
      // Dealer trinkt Kartenwert
      const dealerId = room.players[room.dealerIdx].id;
      room.tally[dealerId] += rankValue(actual);

      // Karte aufgedeckt
      room.history.push(actual);
      room.deck.shift();

      // Failserie bricht
      room.failCount = 0;

      // nächster Spieler (Dealer überspringen)
      let next = nextIdx(room.turnIdx, room.players.length);
      if (next === room.dealerIdx) next = nextIdx(next, room.players.length);
      room.turnIdx = next;

      advanceAfterReveal(room);
    } else {
      // Hinweis + zweite Phase
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
    if (room.players[room.turnIdx].id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });

    rank = Number(rank);
    if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

    const actual = room.deck[0];
    const first = room.round.firstGuess ?? actual;

    if (rank === actual) {
      // Dealer trinkt Differenz zum ersten Tipp
      const dealerId = room.players[room.dealerIdx].id;
      const diff = Math.abs(first - actual);
      room.tally[dealerId] += diff;

      // Failserie bricht
      room.failCount = 0;
    } else {
      // Spieler trinkt Differenz zum tatsächlichen Wert
      const diff = Math.abs(rank - actual);
      room.tally[socket.id] += diff;

      // Fehlversuch zählt
      room.failCount += 1;
    }

    // Karte aufgedeckt
    room.history.push(actual);
    room.deck.shift();

    // nach Aufdecken weiter
    advanceAfterReveal(room);

    io.to(room.code).emit('room:update', snapshot(room));
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.isOnline = false;
    io.to(code).emit('room:update', snapshot(room));
  });
});

// Start
server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
