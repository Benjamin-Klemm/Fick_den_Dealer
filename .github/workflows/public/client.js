const socket = io();

let state = { me: { id: null, name: '' }, room: null };
const $ = s => document.querySelector(s);
const show = id => { ['#lobby','#game'].forEach(sel => $(sel).classList.add('hidden')); $(id).classList.remove('hidden'); };

function rankLabel(r){ return r<=10?String(r):({11:'Bube (11)',12:'Dame (12)',13:'König (13)',14:'Ass (14)'}[r]); }

function setShareLink(code){
  const url = `${location.origin}/?room=${code}`;
  $('#shareLink').value = url;
}

function renderPad(phase){
  const pad = $('#rankPad'); pad.innerHTML = '';
  const ranks = Array.from({length:13}, (_,i)=>i+2);
  ranks.forEach(r=>{
    const b = document.createElement('button');
    b.textContent = r<=10?String(r):['J','Q','K','A'][r-11];
    b.onclick = () => {
      if (phase === 'first') socket.emit('guess:first', {rank:r}, resp => resp?.error && alert(resp.error));
      else socket.emit('guess:second', {rank:r}, resp => resp?.error && alert(resp.error));
    };
    pad.appendChild(b);
  });
}

function renderRoom(room){
  state.room = room;
  setShareLink(room.code);

  // players
  const players = $('#players'); players.innerHTML = '';
  room.players.forEach((p,idx)=>{
    const el = document.createElement('div');
    el.className = 'badge';
    const tags = [];
    if (idx === room.dealerIdx) tags.push('Dealer');
    if (idx === room.turnIdx)   tags.push('am Zug');
    el.textContent = `${p.name}${tags.length?' ['+tags.join(', ')+']':''}`;
    players.appendChild(el);
  });

  if (room.status === 'playing' || room.status === 'ended'){
    show('#game');
    $('#status').textContent = room.status === 'ended' ? 'Spiel beendet' : 'Läuft';
    $('#deckCount').textContent = `Karten im Stapel: ${room.deckCount}`;
    $('#dealerInfo').textContent = `Dealer: ${room.players[room.dealerIdx]?.name || '-'}`;
    $('#turnInfo').textContent   = `Am Zug: ${room.players[room.turnIdx]?.name || '-'}`;

    const meIsTurn = room.players[room.turnIdx]?.id === state.me.id;
    const meIsDealer = room.players[room.dealerIdx]?.id === state.me.id;
    $('#rankPad').style.pointerEvents = meIsTurn ? 'auto' : 'none';
    $('#rankPad').style.opacity = meIsTurn ? 1 : 0.6;
    $('#peekBtn').disabled = !meIsDealer;

    $('#hintBox').textContent = room.round?.phase === 'second' && room.round?.hint
      ? `Hinweis: ${room.round.hint === 'higher' ? 'DRÜBER' : 'DRUNTER'}`
      : '';

    if (room.round) renderPad(room.round.phase);

    // history bar
    const hist = $('#history'); hist.innerHTML='';
    if (room.history?.length){
      const counts = new Map();
      room.history.forEach(h => counts.set(h.rank, (counts.get(h.rank)||0)+1));
      const row = document.createElement('div'); row.className='row';
      for (let r=2;r<=14;r++){
        const pill = document.createElement('div'); pill.className='badge';
        pill.textContent = `${r<=10?r:['J','Q','K','A'][r-11]} × ${(counts.get(r)||0)}`;
        row.appendChild(pill);
      }
      hist.appendChild(row);
    } else hist.textContent = '—';

    // tally
    const tally = $('#tally'); tally.innerHTML='';
    room.players.forEach(p=>{
      const li = document.createElement('div'); li.className='log-item';
      li.textContent = `${p.name}: ${room.tally?.[p.id] ?? 0}`;
      tally.appendChild(li);
    });

  } else {
    show('#lobby');
  }
}

function logLine(text){
  const log = $('#log'); const item = document.createElement('div');
  item.className = 'log-item'; item.textContent = text; log.textContent=''; log.appendChild(item);
}

// sockets
socket.on('connect', ()=>{ state.me.id = socket.id; });

socket.on('room:update', (room) => { renderRoom(room); });

socket.on('dealer:peek', ({rank}) => { $('#dealerCard').textContent = `Verdeckte Karte: ${rankLabel(rank)}`; });

socket.on('round:result', (ev) => {
  const player = state.room?.players.find(p => p.id === ev.turnPlayerId)?.name || 'Spieler';
  const target = state.room?.players.find(p => p.id === ev.targetId)?.name || '—';
  const actual = rankLabel(ev.actual);
  const msg = ev.type === 'first-correct'
    ? `${player} trifft sofort! ${target} trinkt ${ev.drinks}. (Karte: ${actual})`
    : ev.type === 'second-correct'
      ? `${player} trifft im 2. Versuch. ${target} trinkt ${ev.drinks}. (Karte: ${actual})`
      : `${player} verfehlt. ${target} trinkt ${ev.drinks}. (Karte: ${actual})`;
  logLine(msg);
  $('#dealerCard').textContent = 'Verdeckt';
});

// ui
$('#createRoom').onclick = () => {
  const name = $('#name').value.trim();
  socket.emit('room:create', {name}, (resp) => {
    if (!resp?.ok) return alert(resp?.error||'Fehler');
  });
};

$('#joinRoom').onclick = () => {
  const name = $('#name').value.trim();
  const code = ($('#roomCode').value || '').trim();
  socket.emit('room:join', {code, name}, (resp) => !resp?.ok && alert(resp?.error||'Fehler'));
};

$('#startGame').onclick = () => {
  socket.emit('game:start', (resp) => !resp?.ok && alert(resp?.error||'Fehler beim Start'));
};

$('#peekBtn').onclick = () => socket.emit('dealer:peek');

$('#copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText($('#shareLink').value); $('#copyLink').textContent = 'Kopiert!'; setTimeout(()=>$('#copyLink').textContent='Link kopieren',1400); }
  catch { alert('Kopieren fehlgeschlagen'); }
};

// auto-join via Link  (?room=CODE oder #CODE)
(function autoJoinFromURL(){
  const params = new URLSearchParams(location.search);
  let code = params.get('room') || location.hash.replace('#','');
  if (!code) return;
  code = code.toUpperCase();
  $('#roomCode').value = code;
})();
