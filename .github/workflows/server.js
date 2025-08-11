// ...oben bleibt alles gleich...

// Erster Guess
socket.on('guess:first', ({ rank }, cb) => {
  const room = rooms[socket.data.code];
  if (!room || room.status !== 'playing' || !room.round) return;
  if (room.players[room.turnIdx]?.id !== socket.id) return cb?.({ ok: false, error: 'Nicht dein Zug' });
  if (room.round.phase !== 'first') return cb?.({ ok: false, error: 'Falsche Phase' });
  rank = Number(rank); if (!(rank >= 2 && rank <= 14)) return cb?.({ ok: false, error: 'Ungültiger Rang' });

  // NEU: allen den aktuellen Tipp anzeigen
  io.to(room.code).emit('round:guess', {
    which: 'first',
    byPlayerId: socket.id,
    rank
  });

  const actual = room.round.currentRank;
  if (rank === actual) {
    const dealerId = room.players[room.dealerIdx].id;
    room.tally[dealerId] += actual;
    io.to(room.code).emit('round:result', { type: 'first-correct', turnPlayerId: socket.id, actual, drinks: actual, targetId: dealerId });
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

  // NEU: allen den aktuellen 2. Tipp anzeigen
  io.to(room.code).emit('round:guess', {
    which: 'second',
    byPlayerId: socket.id,
    rank
  });

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
