const socket = io();
let state = { me: { id: null, name: '' }, room: null, inviteCode: null };

const $ = s => document.querySelector(s);
const show = id => { ['#lobby','#game'].forEach(sel=>$(sel).classList.add('hidden')); $(id).classList.remove('hidden'); };

const RANK_TEXT  = r => r<=10?String(r):({11:'J',12:'Q',13:'K',14:'A'}[r]);
const RANK_LABEL = r => r<=10?String(r):({11:'Bube (11)',12:'Dame (12)',13:'König (13)',14:'Ass (14)'}[r]);

function setShareLink(code){ $('#shareLink').value = `${location.origin}/?room=${code}`; }

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

// sortierte Kartenübersicht (2 → A) mit Count-Badge
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
  // Wenn via Link gekommen: nur Name + "Beitreten"
  $('#creatorControls').classList.toggle('hidden', hasInvite);
  $('#linkJoinControls').classList.toggle('hidden', !hasInvite);
  if (hasInvite) {
    $('#roomCode').value = state.inviteCode;
  }
}

function renderRoom(room){
  state.room = room;
  setShareLink(room.code);
  renderPlayers(room);

  // Start-Button nur für Owner sichtbar (zusätzlich enforced am Server)
  const amOwner = room.ownerId === state.me.id;
  const startBtn = $('#startGame');
  startBtn.style.display = amOwner && room.status==='lobby' ? 'inline-block' : 'none';

  $('#dealerBadge').textContent = `Dealer: ${room.players[room.dealerIdx]?.name || '-'}`;
  $('#turnBadge').textContent   = `Am Zug: ${room.players[room.turnIdx]?.name || '-'}`;
  $('#deckCount').textContent   = `Karten im Stapel: ${room.deckCount}`;

  // FailCounter anzeigen
  if (typeof room.failCount === 'number') {
    const remaining = Math.max(0, 3 - room.failCount);
    $('#dealerBadge').textContent += `  —  Noch ${remaining} Fehlversuch${remaining===1?'':'e'} bis Dealerwechsel`;
  }

  if (room.status === 'playing' || room.status === 'ended'){
    show('#game');
    const meIsDealer = room.players[room.dealerIdx]?.id === state.me.id;
    const meIsTurn   = room.players[room.turnIdx]?.id === state.me.id;

    const wasHiddenBefore = $('#turnView').classList.contains('hidden');

    $('#dealerView').classList.toggle('hidden', !meIsDealer);
    $('#turnView').classList.toggle('hidden', !meIsTurn);
    $('#spectatorView').classList.toggle('hidden', meIsDealer || meIsTurn);

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

    // Handy: wenn ich jetzt dran bin, scrolle den Tipp-Block ins Bild
    if (meIsTurn && wasHiddenBefore && window.innerWidth <= 700) {
      document.querySelector('#turnView')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else {
    show('#lobby');
  }
}

function logLine(text){ const log = $('#log'); if (log) log.textContent = text; }

// --- Socket Events ---
socket.on('connect', ()=>{ state.me.id = socket.id; });
socket.on('room:update', (room) => { renderRoom(room); });

socket.on('dealer:peek', ({rank}) => {
  const d = $('#dealerCard'); if (d){ d.textContent = RANK_TEXT(rank); d.classList.remove('dim'); }
});

socket.on('round:guess', (ev) => {
  const player = state.room?.players.find(p=>p.id===ev.byPlayerId)?.name || 'Spieler';
  const which  = ev.which === 'first' ? 'Erster Tipp' : 'Zweiter Tipp';
  logLine(`${player} → ${which}: ${RANK_LABEL(ev.rank)}`);
});

socket.on('round:result', (ev) => {
  const p = state.room?.players.find(x=>x.id===ev.turnPlayerId)?.name || 'Spieler';
  const t = state.room?.players.find(x=>x.id===ev.targetId)?.name || '—';
  const msg = ev.type==='first-correct'
    ? `${p} trifft sofort! ${t} trinkt ${ev.drinks}. (Karte: ${RANK_LABEL(ev.actual)})`
    : ev.type==='second-correct'
      ? `${p} trifft im 2. Versuch. ${t} trinkt ${ev.drinks}. (Karte: ${RANK_LABEL(ev.actual)})`
      : `${p} verfehlt. ${t} trinkt ${ev.drinks}. (Karte: ${RANK_LABEL(ev.actual)})`;
  logLine(msg);
  const d = $('#dealerCard'); if (d){ d.textContent='？'; d.classList.add('dim'); }
});

// --- Buttons ---
$('#createRoom').onclick = () => {
  const name = $('#name').value.trim();
  socket.emit('room:create', {name}, r => !r?.ok && alert(r?.error||'Fehler'));
};
$('#joinRoom').onclick = () => {
  const name = $('#name').value.trim();
  const code = ($('#roomCode').value||'').trim();
  socket.emit('room:join', {code, name}, r => !r?.ok && alert(r?.error||'Fehler'));
};
// Join via Link (nur Namensfeld)
$('#joinViaLink').onclick = () => {
  const name = $('#name').value.trim();
  const code = state.inviteCode;
  socket.emit('room:join', {code, name}, r => !r?.ok && alert(r?.error||'Fehler'));
};

$('#startGame').onclick = () => socket.emit('game:start', r=>!r?.ok && alert(r?.error||'Nur der Ersteller darf starten oder nicht genug Spieler'));
$('#peekBtn').onclick = () => socket.emit('dealer:peek');
$('#copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText($('#shareLink').value);
    const b = $('#copyLink'); const o = b.textContent; b.textContent='Kopiert!'; setTimeout(()=>b.textContent=o,1200);
  } catch { alert('Kopieren fehlgeschlagen'); }
};

// --- Auto-Join via Link (?room=CODE) ---
(function(){
  const p = new URLSearchParams(location.search);
  let code = p.get('room') || location.hash.replace('#','');
  if (code) {
    code = code.toUpperCase();
    state.inviteCode = code;
    $('#roomCode').value = code;
  }
  toggleCreateJoinUI();
})();

