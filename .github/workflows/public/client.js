(function () {
  const socket = io();
  let state = { me: { id: null }, room: null, inviteCode: null };

  const $ = sel => document.querySelector(sel);
  const show = id => {
    ['#lobby', '#game'].forEach(s => $(s).classList.add('hidden'));
    $(id).classList.remove('hidden');
  };
  const RANK_TEXT = r => r <= 10 ? String(r) : ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r]);

  // ----- Helpers -----
  function setShareLink(code) {
    const el = $('#shareLink');
    if (el) el.value = `${location.origin}/?room=${code}`;
  }
  function toggleJoinUI() {
    const hasInvite = !!state.inviteCode;
    $('#creatorControls')?.classList.toggle('hidden', hasInvite);
    $('#linkJoinControls')?.classList.toggle('hidden', !hasInvite);
    if (hasInvite) { const rc = $('#roomCode'); if (rc) rc.value = state.inviteCode; }
  }
  const setLog = (txt) => { const el = $('#log'); if (el) el.textContent = txt; };

  function renderPlayers(room) {
    const box = $('#players'); box.innerHTML = '';
    room.players.forEach((p, idx) => {
      const el = document.createElement('div');
      el.className = 'badge';
      const tags = [];
      if (idx === room.dealerIdx) tags.push('Dealer');
      if (idx === room.turnIdx) tags.push('am Zug');
      el.textContent = `${p.name}${tags.length ? ' [' + tags.join(', ') + ']' : ''}`;
      box.appendChild(el);
    });
  }

  function renderPad(phase) {
    const pad = $('#rankPad'); pad.innerHTML = '';
    for (let r = 2; r <= 14; r++) {
      const b = document.createElement('button');
      b.textContent = RANK_TEXT(r);
      b.onclick = () => socket.emit(phase === 'first' ? 'guess:first' : 'guess:second', { rank: r });
      pad.appendChild(b);
    }
  }

  function renderHistory(room) {
    const counts = new Map();
    (room.history || []).forEach(rank => counts.set(rank, (counts.get(rank) || 0) + 1));
    const hist = $('#history'); hist.innerHTML = '';
    for (let r = 2; r <= 14; r++) {
      const n = counts.get(r) || 0;
      const wrap = document.createElement('div');
      wrap.className = 'cardwrap';
      const card = document.createElement('div');
      card.className = 'cardface small' + (n === 0 ? ' dim' : '');
      card.textContent = RANK_TEXT(r);
      const badge = document.createElement('span');
      badge.className = 'count' + (n === 0 ? ' zero' : '');
      badge.textContent = `× ${n}`;
      wrap.appendChild(card); wrap.appendChild(badge);
      hist.appendChild(wrap);
    }
  }

  function renderTally(room) {
    const t = $('#tally'); t.innerHTML = '';
    room.players.forEach(p => {
      const row = document.createElement('div');
      row.textContent = `${p.name}: ${room.tally?.[p.id] || 0}`;
      t.appendChild(row);
    });
  }

  function renderRoom(room) {
    state.room = room;
    setShareLink(room.code);
    renderPlayers(room);

    $('#dealerBadge').textContent = `Dealer: ${room.players[room.dealerIdx]?.name || '-'}`;
    $('#turnBadge').textContent   = `Am Zug: ${room.players[room.turnIdx]?.name || '-'}`;
    $('#deckCount').textContent   = `Karten im Stapel: ${room.deckCount}`;

    if (room.status === 'playing') {
      show('#game');
      const meIsDealer = room.players[room.dealerIdx]?.id === state.me.id;
      const meIsTurn   = room.players[room.turnIdx]?.id === state.me.id;

      $('#dealerView').classList.toggle('hidden', !meIsDealer);
      $('#turnView').classList.toggle('hidden', !meIsTurn);

      if (room.round && meIsTurn) {
        renderPad(room.round.phase);
        $('#firstGuessInfo').textContent = `Erster Tipp: ${room.round.firstGuess ?? '–'}`;
        $('#hintBox').textContent = room.round.hint || '';
      } else {
        $('#rankPad').innerHTML = '';
        $('#firstGuessInfo').textContent = 'Erster Tipp: –';
        $('#hintBox').textContent = '';
      }

      renderHistory(room);
      renderTally(room);
    } else {
      show('#lobby');
    }
  }

  function showPopup(message, ms = 2200) {
    const pop = $('#popup'), txt = $('#popup-text');
    if (!pop || !txt) return;
    txt.textContent = message;
    pop.classList.remove('hidden');
    clearTimeout(showPopup._t);
    showPopup._t = setTimeout(() => pop.classList.add('hidden'), ms);
  }

  // ----- Socket events -----
  socket.on('connect', () => { state.me.id = socket.id; });
  socket.on('room:update', room => renderRoom(room));

  // ► NEU: persistente Ergebnis-Meldung
  socket.on('round:result', (ev) => {
    // ev: { message, drinks, actual, turnPlayerId, targetId, type }
    if (ev?.message) setLog(ev.message);
    // Optional auch als kleines Popup:
    // showPopup(ev.message);
  });

  socket.on('dealer:peek', ({ rank }) => { $('#dealerCard').textContent = (rank <= 10 ? String(rank) : ({11:'J',12:'Q',13:'K',14:'A'}[rank])); });

  // ----- Buttons -----
  $('#createRoom').onclick = () => {
    const name = ($('#name').value || '').trim();
    socket.emit('room:create', { name }, r => !r?.ok && alert(r?.error || 'Fehler'));
  };
  $('#joinRoom').onclick = () => {
    const name = ($('#name').value || '').trim();
    const code = ($('#roomCode').value || '').trim();
    socket.emit('room:join', { code, name }, r => !r?.ok && alert(r?.error || 'Fehler'));
  };
  $('#joinViaLink').onclick = () => {
    const name = ($('#name').value || '').trim();
    const code = state.inviteCode;
    socket.emit('room:join', { code, name }, r => !r?.ok && alert(r?.error || 'Fehler'));
  };
  $('#startGame').onclick = () => socket.emit('game:start', r => !r?.ok && alert(r?.error || 'Fehler'));
  $('#peekBtn').onclick = () => socket.emit('dealer:peek');
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText($('#shareLink').value || ''); alert('Link kopiert'); }
    catch { alert('Kopieren fehlgeschlagen'); }
  };

  // Invite-Link (?room=CODE)
  (function detectInvite() {
    const p = new URLSearchParams(location.search);
    let code = p.get('room') || location.hash.replace('#', '');
    if (code) {
      state.inviteCode = code.toUpperCase();
      const rc = $('#roomCode'); if (rc) rc.value = state.inviteCode;
    }
    toggleJoinUI();
  })();
})();
