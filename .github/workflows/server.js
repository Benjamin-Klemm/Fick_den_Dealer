const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function snapshot(room) {
  return {
    code: room.code,
    ownerId: room.ownerId,
    players: room.players,
    dealerIdx: room.dealerIdx,
    turnIdx: room.turnIdx,
    deckCount: room.deck.length,
    status: room.status,
    history: room.history,
    tally: room.tally,
    failCount: room.failCount,
    round: room.round
  };
}

function createDeck() {
  const deck = [];
  for (let rank = 2; rank <= 14; rank++) {
    for (let i = 0; i < 4; i++) deck.push({ rank });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function nextPlayerIdx(room, idx) {
  return (idx + 1) % room.players.length;
}

function startRound(room) {
  if (room.deck.length === 0) {
    room.status = 'ended';
    io.to(room.code).emit('room:update', snapshot(room));
    return;
  }
  const dealer = room.players[room.dealerIdx];
  const card = room.deck[0];
  room.round = {
    card,
    firstGuess: null,
    hint: null,
    phase: 'first',
    turnIdx: room.turnIdx
  };
  io.to(room.code).emit('room:update', snapshot(room));
}

io.on('connection', (socket) => {

  socket.on('room:create', ({ name }, cb) => {
    const code = Math.random().toString(36).substr(2, 5).toUpperCase();
    rooms[code] = {
      code,
      ownerId: socket.id,
      players: [{ id: socket.id, name, isOnline: true }],
      dealerIdx: 0,
      turnIdx: 1 % 1,
      deck: [],
      history: [],
      tally: {},
      status: 'lobby',
      failCount: 0,
      round: null
    };
    rooms[code].tally[socket.id] = 0;
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    cb?.({ ok: true, code });
    io.to(code).emit('room:update', snapshot(rooms[code]));
  });

  socket.on('room:join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (room.status === 'ended') return cb?.({ ok: false, error: 'Spiel beendet' });

    if (room.players.some(p => p.id === socket.id)) {
      return cb?.({ ok: false, error: 'Du bist schon im Raum' });
    }
    const trimmedName = (name || 'Spieler').trim();
    if (room.players.some(p => p.name === trimmedName)) {
      return cb?.({ ok: false, error: 'Name bereits vergeben' });
    }

    room.players.push({ id: socket.id, name: trimmedName, isOnline: true });
    room.tally[socket.id] = 0;
    socket.join(code);
    socket.data.code = code;
    socket.data.name = trimmedName;

    cb?.({ ok: true, code });
    io.to(code).emit('room:update', snapshot(room));
  });

  socket.on('game:start', (cb) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: 'Raum nicht gefunden' });
    if (socket.id !== room.ownerId) return cb?.({ ok: false, error: 'Nur der Ersteller darf starten' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Mindestens 2 Spieler' });

    room.deck = createDeck();
    room.history = [];
    room.status = 'playing';
    room.dealerIdx = Math.floor(Math.random() * room.players.length);
    room.turnIdx = nextPlayerIdx(room, room.dealerIdx);
    room.failCount = 0;
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on('dealer:peek', () => {
    const room = rooms[socket.data.code];
    if (!room) return;
    if (room.players[room.dealerIdx].id !== socket.id) return;
    socket.emit('dealer:peek', { rank: room.round.card.rank });
  });

  socket.on('guess:first', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    if (room.players[room.turnIdx].id !== socket.id) return;
    room.round.firstGuess = rank;
    if (rank === room.round.card.rank) {
      const dealerId = room.players[room.dealerIdx].id;
      room.tally[dealerId] += rank;
      io.to(room.code).emit('popup', { message: `${socket.data.name} hat ${room.players[room.dealerIdx].name} ${rank} Schlücke eingeschenkt` });
      room.history.push(room.round.card);
      room.deck.shift();
      room.failCount = 0;
      room.turnIdx = nextPlayerIdx(room, room.turnIdx);
      startRound(room);
    } else {
      room.round.hint = rank < room.round.card.rank ? 'higher' : 'lower';
      room.round.phase = 'second';
    }
    io.to(room.code).emit('room:update', snapshot(room));
  });

  socket.on('guess:second', ({ rank }, cb) => {
    const room = rooms[socket.data.code];
    if (!room) return;
    if (room.players[room.turnIdx].id !== socket.id) return;

    const diff = Math.abs(rank - room.round.card.rank);
    if (rank === room.round.card.rank) {
      const dealerId = room.players[room.dealerIdx].id;
      room.tally[dealerId] += diff;
      io.to(room.code).emit('popup', { message: `${socket.data.name} hat ${room.players[room.dealerIdx].name} ${diff} Schlücke eingeschenkt` });
      room.failCount = 0;
    } else {
      const playerId = socket.id;
      room.tally[playerId] += diff;
      io.to(room.code).emit('popup', { message: `${room.players[room.dealerIdx].name} hat ${socket.data.name} ${diff} Schlücke eingeschenkt` });
      room.failCount++;
    }

    room.history.push(room.round.card);
    room.deck.shift();

    if (room.failCount >= 3) {
      room.dealerIdx = nextPlayerIdx(room, room.dealerIdx);
      room.failCount = 0;
    }
    room.turnIdx = nextPlayerIdx(room, room.turnIdx);
    startRound(room);
    io.to(room.code).emit('room:update', snapshot(room));
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (room) {
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) p.isOnline = false;
      io.to(code).emit('room:update', snapshot(room));
    }
  });

});

server.listen(3000, () => console.log('Listening on *:3000'));
