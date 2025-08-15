(function(){
  const socket = io();
  let state = { me: {}, room: null };

  const $ = sel => document.querySelector(sel);
  const show = id => {
    ['#lobby','#game'].forEach(sel => $(sel).classList.add('hidden'));
    $(id).classList.remove('hidden');
  };

  const RANK_TEXT = r => r<=10?String(r):({11:'J',12:'Q',13:'K',14:'A'}[r]);

  function setShareLink(code){
    $('#shareLink').value = `${location.origin}/?room=${code}`;
  }

  function renderPlayers(room){
    $('#players').innerHTML = '';
    room.players.forEach((p,idx)=>{
      const el = document.createElement('div');
      el.className = 'badge';
      const tags = [];
      if (idx===room.dealerIdx) tags.push('Dealer');
      if (idx===room.turnIdx) tags.push('am Zug');
      el.textContent = `${p.name}${tags.length?' ['+tags.join(', ')+']':''}`;
      $('#players').appendChild(el);
    });
  }

  function renderPad(phase){
    $('#rankPad').innerHTML = '';
    for(let r=2;r<=14;r++){
      const b = document.createElement('button');
      b.textContent = RANK_TEXT(r);
      b.onclick = ()=> socket.emit(phase==='first'?'guess:first':'guess:second', {rank:r});
      $('#rankPad').appendChild(b);
    }
  }

  function renderHistory(room){
    const counts = {};
    (room.history||[]).forEach(h => counts[h] = (counts[h]||0)+1);
    $('#history').innerHTML = '';
    for(let r=2;r<=14;r++){
      const card = document.createElement('div');
      card.className = 'cardface';
      card.textContent = RANK_TEXT(r);
      $('#history').appendChild(card);
    }
  }

  function renderTally(room){
    $('#tally').innerHTML = '';
    room.players.forEach(p=>{
      const row = document.createElement('div');
      row.innerHTML = `${p.name}: ${room.tally?.[p.id]||0}`;
      $('#tally').appendChild(row);
    });
  }

  function renderRoom(room){
    state.room = room;
    setShareLink(room.code);
    renderPlayers(room);
    $('#dealerBadge').textContent = `Dealer: ${room.players[room.dealerIdx]?.name||'-'}`;
    $('#turnBadge').textContent = `Am Zug: ${room.players[room.turnIdx]?.name||'-'}`;
    $('#deckCount').textContent = `Karten im Stapel: ${room.deckCount}`;

    if(room.status==='playing'){
      show('#game');
      const meIsDealer = room.players[room.dealerIdx]?.id === state.me.id;
      const meIsTurn = room.players[room.turnIdx]?.id === state.me.id;

      $('#dealerView').classList.toggle('hidden', !meIsDealer);
      $('#turnView').classList.toggle('hidden', !meIsTurn);

      if(room.round && meIsTurn){
        renderPad(room.round.phase);
        $('#firstGuessInfo').textContent = `Erster Tipp: ${room.round.firstGuess || '-'}`;
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

  socket.on('connect', ()=> state.me.id = socket.id);
  socket.on('room:update', room => renderRoom(room));
  socket.on('dealer:peek', ({rank}) => $('#dealerCard').textContent = RANK_TEXT(rank));

  $('#createRoom').onclick = ()=> {
    const name = $('#name').value.trim();
    socket.emit('room:create',{name});
  };
  $('#joinRoom').onclick = ()=> {
    const name = $('#name').value.trim();
    const code = $('#roomCode').value.trim();
    socket.emit('room:join',{name,code});
  };
  $('#startGame').onclick = ()=> socket.emit('game:start');
  $('#peekBtn').onclick = ()=> socket.emit('dealer:peek');
  $('#copyLink').onclick = ()=> {
    navigator.clipboard.writeText($('#shareLink').value);
    alert('Link kopiert');
  };
})();
