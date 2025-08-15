(function attachClient() {
  function init() {
    const socket = io();
    let state = { me: { id: null, name: '' }, room: null, inviteCode: null };

    const $ = s => document.querySelector(s);
    const show = id => {
      ['#lobby', '#game'].forEach(sel => { const el = $(sel); if (el) el.classList.add('hidden'); });
      const target = $(id); if (target) target.classList.remove('hidden');
    };

    const RANK_TEXT  = r => r<=10?String(r):({11:'J',12:'Q',13:'K',14:'A'}[r]);
    const RANK_LABEL = r => r<=10?String(r):({11:'Bube (11)',12:'Dame (12)',13:'König (13)',14:'Ass (14)'}[r]);

    function setShareLink(code){
      const el = $('#shareLink');
      if (el) el.value = `${location.origin}/?room=${code}`;
    }

    function renderPlayers(room){
      const box = $('#players'); if (!box) return;
      box.innerHTML='';
      room.players.forEach((p,idx)=>{
        const el = document.createElement('div');
        el.className = 'badge';
        const tags = [];
        if (idx===room.dealerIdx) tags.push('Dealer');
        if (idx===room.turnIdx)   tags.push('am Zug');
        el.textContent = `${p.name}${tags.length?' ['+tags.join(', ')+']':''}`;
        box.appendChild(el);
      });
    }

    function renderPad(phase){
      const pad = $('#rankPad'); if (!pad) return;
      pad.innerHTML='';
      for (let r=2;r<=14;r++){
        const b = document.createElement('button');
        b.textContent = RANK_TEXT(r);
        b.onclick = () => {
          const ev = phase==='first' ? 'guess:first' : 'guess:second';
          socket.emit(ev, {rank:r}, resp => resp?.error && alert(resp.error));
        };
        pad.appendChild(b);
      }
    }

    function renderHistory(room){
      const area = $('#history'); if (!area) return;
      area.innerHTML='';

      const counts = new Map();
      (room.history||[]).forEach(h => counts.set(h.rank, (counts.get(h.rank)||0)+1));

      for (let r=2; r<=14; r++){
        const c = counts.get(r) || 0;
        const wrap = document.createElement('div');
        wrap.className = 'cardwrap';
        const card = document.createElement('div');
        card.className = 'cardface small' + (c === 0 ? ' dim' : '');
        card.textContent = RANK_TEXT(r);
        card.title = `${RANK_LABEL(r)} × ${c}`;
        const badge = document.createElement('span');
        badge.className = 'count' + (c === 0 ? ' zero' : '');
        badge.textContent = `× ${c}`;
        wrap.appendChild(card);
        wrap.appendChild(badge);
        area.appendChild(wrap);
      }
    }

    function renderTally(room){
      const t = $('#tally'); if (!t) return;
      t.innerHTML='';
      room.players.forEach(p=>{
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span>${p.name}:</span><span class="muted">${room.tally?.[p.id]??0}</span>`;
        t.appendChild(row);
      });
    }

    function toggleCreateJoinUI() {
      const hasInvite = !!state.inviteCode;
      const creatorControls = $('#creatorControls');
      const linkJoinControls = $('#linkJoinControls');
      if (creatorControls) creatorControls.classList.toggle('hidden', hasInvite);
      if (linkJoinControls) linkJoinControls.classList.toggle('hidden', !hasInvite);
      const codeInput = $('#roomCode');
      if (hasInvite && codeInput) codeInput.value = state.inviteCode;
    }

    function renderRoom(room){
      state.room = room;
      setShareLink(room.code);
      renderPlayers(room);

      const amOwner = room.ownerId === state.me.id;
      const startBtn = $('#startGame');
      if (startBtn) startBtn.style.display = amOwner && room.status==='lobby' ? 'inline-block' : 'none';

      const dealerBadge = $('#dealerBadge');
      const turnBadge   = $('#turnBadge');
      const deckCount   = $('#deckCount');

      if (dealerBadge) dealerBadge.textContent = `Dealer: ${room.players[room.dealerIdx]?.name || '-'}`;
      if (turnBadge)   turnBadge.textContent   = `Am Zug: ${room.players[room.turnIdx]?.name || '-'}`;
      if (deckCount)   deckCount.textContent   = `Karten im Stapel: ${room.deckCount}`;

      if (typeof room.failCount === 'number' && dealerBadge) {
        const remaining = Math.max(0, 3 - room.failCount);
        dealerBadge.textContent += `  —  Noch ${remaining} Fehlversuch${remaining===1?'':'e'} bis Dealerwechsel`;
      }

      if (room.status === 'playing' || room.status === 'ended'){
        show('#game');
        const meIsDealer = room.players[room.dealerIdx]?.id === state.me.id;
        const meIsTurn   = room.players[room.turnIdx]?.id === state.me.id;
        $('#dealerView')?.classList.toggle('hidden', !meIsDealer);
        $('#turnView')?.classList.toggle('hidden', !meIsTurn);
        $('#spectatorView')?.classList.toggle('hidden', meIsDealer || meIsTurn);

        if (room.round){
          renderPad(room.round.phase);
          $('#firstGuessInfo').textContent = `Erster Tipp: ${room.round.firstGuess ? RANK_LABEL(room.round.firstGuess) : '–'}`;
          $('#hintBox').textContent = room.round.phase==='second' && room.round.hint
            ? `Hinweis: ${room.round.hint==='higher'?'DRÜBER':'DRUNTER'}`
            : '';
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

    function logLine(text){
      const log = $('#log');
      if (log) log.textContent = text;
    }

    function showPopup(message, ms=2500){
      const pop = $('#popup');
      const txt = $('#popup-text');
      txt.textContent = message;
      pop.classList.remove('hidden');
      clearTimeout(showPopup._t);
      showPopup._t = setTimeout(()=>pop.classList.add('hidden'), ms);
    }

    socket.on('connect', ()=>{ state.me.id = socket.id; });
    socket.on('room:update', (room) => { if (room) renderRoom(room); });
    socket.on('dealer:peek', ({rank}) => {
      $('#dealerCard').textContent = RANK_TEXT(rank);
      $('#dealerCard').classList.remove('dim');
    });
    socket.on('popup', ({message}) => showPopup(message));

    const btnCreate = $('#createRoom');
    const btnJoin   = $('#joinRoom');
    const btnJoinViaLink = $('#joinViaLink');
    const btnStart  = $('#startGame');
    const btnPeek   = $('#peekBtn');
    const btnCopy   = $('#copyLink');

    btnCreate.onclick = () => {
      const name = ($('#name')?.value || '').trim();
      socket.emit('room:create', {name}, r => !r?.ok && alert(r?.error||'Fehler'));
    };
    btnJoin.onclick = () => {
      const name = ($('#name')?.value || '').trim();
      const code = ($('#roomCode')?.value || '').trim();
      socket.emit('room:join', {code, name}, r => !r?.ok && alert(r?.error||'Fehler'));
    };
    btnJoinViaLink.onclick = () => {
      const name = ($('#name')?.value || '').trim();
      const code = state.inviteCode;
      socket.emit('room:join', {code, name}, r => !r?.ok && alert(r?.error||'Fehler'));
    };
    btnStart.onclick = () =>
      socket.emit('game:start', r=>!r?.ok && alert(r?.error||'Nur der Ersteller darf starten oder nicht genug Spieler'));
    btnPeek.onclick = () => socket.emit('dealer:peek');
    btnCopy.onclick = async () => {
      try {
        const link = $('#shareLink')?.value || '';
        await navigator.clipboard.writeText(link);
        const o = btnCopy.textContent; btnCopy.textContent='Kopiert!'; setTimeout(()=>btnCopy.textContent=o,1200);
      } catch { alert('Kopieren fehlgeschlagen'); }
    };

    (function(){
      const p = new URLSearchParams(location.search);
      let code = p.get('room') || location.hash.replace('#','');
      if (code) {
        code = code.toUpperCase();
        state.inviteCode = code;
        const rc = $('#roomCode'); if (rc) rc.value = code;
      }
      toggleCreateJoinUI();
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
