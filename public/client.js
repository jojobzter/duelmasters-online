// ====================== Card image loading ======================
let cardDB = new Map();      // id ("DM-1/Name.png") -> {url, name, set}
let cardBackUrl = null;      // from a "card back" folder, if present
const IMG_EXT = /\.(png|jpg|jpeg|webp|gif)$/i;
const CARD_BACK_FOLDER = /^card ?back$/i;

function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('dm-table', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => {
      const tx = req.result.transaction('handles', 'readonly');
      const g = tx.objectStore('handles').get(key);
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}
function idbSet(key, val) {
  const req = indexedDB.open('dm-table', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('handles');
  req.onsuccess = () => {
    const tx = req.result.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(val, key);
  };
}

const progWrap = document.getElementById('load-progress-wrap');
const progBar = document.getElementById('load-progress-bar');
function progressStart(indeterminate) {
  progWrap.style.display = 'block';
  progBar.classList.toggle('indeterminate', !!indeterminate);
  progBar.style.width = '0%';
}
function progressUpdate(done, total) { if (total > 0) progBar.style.width = Math.round((done / total) * 100) + '%'; }
function progressDone() {
  progBar.classList.remove('indeterminate');
  progBar.style.width = '100%';
  setTimeout(() => { progWrap.style.display = 'none'; }, 400);
}
let __yieldCounter = 0;
async function maybeYield() { __yieldCounter++; if (__yieldCounter % 15 === 0) await new Promise(r => setTimeout(r, 0)); }

async function scanDirHandle(dirHandle) {
  cardDB.clear(); cardBackUrl = null;
  const statusEl = document.getElementById('load-status');
  progressStart(true);
  statusEl.textContent = 'Scanning folders...';
  const jobs = [];
  for await (const [setName, setHandle] of dirHandle.entries()) {
    if (setHandle.kind !== 'directory') continue;
    for await (const [fileName, fileHandle] of setHandle.entries()) {
      if (fileHandle.kind !== 'file' || !IMG_EXT.test(fileName)) continue;
      jobs.push({ setName, fileName, fileHandle });
      await maybeYield();
    }
  }
  progressStart(false);
  const total = jobs.length;
  for (let i = 0; i < total; i++) {
    const { setName, fileName, fileHandle } = jobs[i];
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    if (CARD_BACK_FOLDER.test(setName)) { cardBackUrl = url; }
    else {
      const id = setName + '/' + fileName;
      cardDB.set(id, { url, name: fileName.replace(IMG_EXT, ''), set: setName });
    }
    if (i % 10 === 0 || i === total - 1) {
      progressUpdate(i + 1, total);
      statusEl.textContent = `Loading cards... ${i + 1} / ${total}`;
      await maybeYield();
    }
  }
  progressDone();
}

async function scanFileList(files) {
  cardDB.clear(); cardBackUrl = null;
  const statusEl = document.getElementById('load-status');
  const imgFiles = [...files].filter(f => IMG_EXT.test(f.name));
  const total = imgFiles.length;
  progressStart(false);
  for (let i = 0; i < total; i++) {
    const file = imgFiles[i];
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    if (parts.length < 2) continue;
    const setName = parts[parts.length - 2];
    const fileName = parts[parts.length - 1];
    const url = URL.createObjectURL(file);
    if (CARD_BACK_FOLDER.test(setName)) { cardBackUrl = url; }
    else {
      const id = setName + '/' + fileName;
      cardDB.set(id, { url, name: fileName.replace(IMG_EXT, ''), set: setName });
    }
    if (i % 10 === 0 || i === total - 1) {
      progressUpdate(i + 1, total);
      statusEl.textContent = `Loading cards... ${i + 1} / ${total}`;
      await maybeYield();
    }
  }
  progressDone();
}

async function loadFolder() {
  const statusEl = document.getElementById('load-status');
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker();
      await scanDirHandle(handle);
      idbSet('cardsFolder', handle);
      statusEl.textContent = cardDB.size + ' cards loaded from "' + handle.name + '".' + (cardBackUrl ? ' Card back found.' : '');
      refreshCardGrid();
    } catch (e) {
      if (e.name !== 'AbortError') statusEl.textContent = 'Could not read folder: ' + e.message;
    }
  } else {
    document.getElementById('fallback-input').click();
  }
}
document.getElementById('fallback-input').addEventListener('change', async (e) => {
  await scanFileList(e.target.files);
  document.getElementById('load-status').textContent = cardDB.size + ' cards loaded.' + (cardBackUrl ? ' Card back found.' : '');
  refreshCardGrid();
});
document.getElementById('btn-load-folder').addEventListener('click', loadFolder);

(async () => {
  if (!window.showDirectoryPicker) return;
  const handle = await idbGet('cardsFolder');
  if (!handle) return;
  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') {
    await scanDirHandle(handle);
    document.getElementById('load-status').textContent = cardDB.size + ' cards loaded from "' + handle.name + '" (remembered).';
    refreshCardGrid();
  } else {
    document.getElementById('load-status').textContent = 'Click "Choose cards folder" to reload your images (' + handle.name + ').';
  }
})();

function faceDownHtml() { return cardBackUrl ? `<img src="${cardBackUrl}" alt="card back">` : ''; }
function cardImgHtml(id) {
  const c = cardDB.get(id);
  if (c) return `<img src="${c.url}" alt="${c.name}">`;
  return `<div class="placeholder-label">${id || '?'}</div>`;
}

// ====================== Deck builder ======================
let currentDeck = [];

function refreshCardGrid() {
  const grid = document.getElementById('card-grid');
  const query = (document.getElementById('card-search').value || '').toLowerCase();
  grid.innerHTML = '';
  const ids = [...cardDB.keys()].sort();
  for (const id of ids) {
    const c = cardDB.get(id);
    if (query && !c.name.toLowerCase().includes(query) && !c.set.toLowerCase().includes(query)) continue;
    const div = document.createElement('div');
    div.className = 'card-thumb';
    const count = currentDeck.filter(x => x === id).length;
    div.innerHTML = `<img src="${c.url}" title="${c.name}">` +
      (count ? `<div class="count-badge">${count}</div>` : '') +
      `<div class="zoom-btn" title="Preview">\u{1F50D}</div>` +
      `<div class="name">${c.name}</div>`;
    div.querySelector('.zoom-btn').addEventListener('click', (e) => { e.stopPropagation(); openMagnify(id); });
    div.addEventListener('click', () => {
      if (currentDeck.length >= 40) return;
      currentDeck.push(id);
      refreshCardGrid(); refreshDeckList();
    });
    grid.appendChild(div);
  }
}
document.getElementById('card-search').addEventListener('input', refreshCardGrid);

function refreshDeckList() {
  const list = document.getElementById('deck-list');
  list.innerHTML = '';
  const counts = new Map();
  for (const id of currentDeck) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, n] of [...counts.entries()].sort()) {
    const c = cardDB.get(id) || { name: id };
    const row = document.createElement('div');
    row.className = 'deck-list-item';
    row.innerHTML = `<span>${n}x ${c.name}</span>`;
    const btn = document.createElement('button');
    btn.textContent = '-';
    btn.addEventListener('click', () => {
      const i = currentDeck.indexOf(id);
      if (i !== -1) currentDeck.splice(i, 1);
      refreshDeckList(); refreshCardGrid();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  document.getElementById('deck-count').textContent = currentDeck.length + ' / 40 cards';
}

function getSavedDecks() { try { return JSON.parse(localStorage.getItem('dm_decks') || '{}'); } catch { return {}; } }
function setSavedDecks(d) { localStorage.setItem('dm_decks', JSON.stringify(d)); }

function refreshSavedDecks() {
  const wrap = document.getElementById('saved-decks');
  const sel = document.getElementById('active-deck-select');
  const prevVal = sel.value;
  wrap.innerHTML = ''; sel.innerHTML = '';
  const decks = getSavedDecks();
  for (const name of Object.keys(decks).sort()) {
    const row = document.createElement('div');
    row.className = 'saved-deck-row';
    row.innerHTML = `<b>${name}</b> <span class="hint">(${decks[name].length} cards)</span>`;
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Edit';
    loadBtn.addEventListener('click', () => {
      currentDeck = decks[name].slice();
      document.getElementById('deck-name').value = name;
      refreshDeckList(); refreshCardGrid();
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => { delete decks[name]; setSavedDecks(decks); refreshSavedDecks(); });
    row.appendChild(loadBtn); row.appendChild(delBtn);
    wrap.appendChild(row);
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name + ' (' + decks[name].length + ')';
    sel.appendChild(opt);
  }
  if ([...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
}

document.getElementById('btn-save-deck').addEventListener('click', () => {
  const name = (document.getElementById('deck-name').value || '').trim();
  if (!name) { alert('Name your deck first.'); return; }
  if (currentDeck.length !== 40) { if (!confirm('Deck has ' + currentDeck.length + ' cards, not 40. Save anyway?')) return; }
  const decks = getSavedDecks();
  decks[name] = currentDeck.slice();
  setSavedDecks(decks);
  refreshSavedDecks();
});

refreshSavedDecks();
refreshDeckList();

// ====================== Networking / seats ======================
let seats = [
  { ws: null, idx: null, roomCode: null, state: null },
  { ws: null, idx: null, roomCode: null, state: null }
];
let activeSeat = 0;
let isSolo = false;
let practiceDeck = null;

function wsUrl() { const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'; return proto + location.host; }

function openSeat(seatIndex, onOpenMsg) {
  const cWrap = document.getElementById('connect-progress-wrap');
  cWrap.style.display = 'block';
  const seat = seats[seatIndex];
  seat.ws = new WebSocket(wsUrl());
  seat.ws.addEventListener('open', () => seat.ws.send(JSON.stringify(onOpenMsg)));
  seat.ws.addEventListener('message', (ev) => { cWrap.style.display = 'none'; handleSeatMessage(seatIndex, JSON.parse(ev.data)); });
  seat.ws.addEventListener('close', () => { cWrap.style.display = 'none'; appendLog('Seat ' + (seatIndex + 1) + ' disconnected.'); });
  seat.ws.addEventListener('error', () => { cWrap.style.display = 'none'; document.getElementById('room-info').textContent = 'Could not connect. Try again.'; });
  return seat;
}
function sendMsg(msg) {
  const seat = seats[activeSeat];
  if (seat && seat.ws && seat.ws.readyState === WebSocket.OPEN) seat.ws.send(JSON.stringify(msg));
}
function sendOnSeat(seatIndex, msg) {
  const seat = seats[seatIndex];
  if (seat && seat.ws && seat.ws.readyState === WebSocket.OPEN) seat.ws.send(JSON.stringify(msg));
}

document.getElementById('btn-create-room').addEventListener('click', () => {
  isSolo = false;
  document.getElementById('room-info').textContent = 'Connecting to server (may take a minute if it was asleep)...';
  openSeat(0, { type: 'create' });
});
document.getElementById('btn-join-room').addEventListener('click', () => {
  isSolo = false;
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) return;
  document.getElementById('room-info').textContent = 'Connecting to server (may take a minute if it was asleep)...';
  openSeat(0, { type: 'join', room: code });
});
document.getElementById('btn-submit-deck').addEventListener('click', () => {
  const decks = getSavedDecks();
  const name = document.getElementById('active-deck-select').value;
  const deck = decks[name];
  if (!deck || !deck.length) { alert('Pick a saved deck first.'); return; }
  sendOnSeat(0, { type: 'submitDeck', deck });
  document.getElementById('ready-status').textContent = 'Deck submitted — your hand is dealt now, no need to wait for your opponent.';
});
document.getElementById('btn-practice').addEventListener('click', () => {
  const decks = getSavedDecks();
  const name = document.getElementById('active-deck-select').value || Object.keys(decks)[0];
  const deck = decks[name];
  if (!deck || !deck.length) { alert('Save a deck first, then pick it in the "Use deck" dropdown.'); return; }
  practiceDeck = deck; isSolo = true;
  document.getElementById('room-info').textContent = 'Starting practice game...';
  document.getElementById('ready-panel').style.display = 'block';
  openSeat(0, { type: 'create' });
});
document.getElementById('btn-accept-join').addEventListener('click', () => {
  document.getElementById('join-request-banner').style.display = 'none';
  sendOnSeat(0, { type: 'respondJoin', accept: true });
});
document.getElementById('btn-decline-join').addEventListener('click', () => {
  document.getElementById('join-request-banner').style.display = 'none';
  sendOnSeat(0, { type: 'respondJoin', accept: false });
});

let dieScreenShown = false;
let prevGameOver = null;

function handleSeatMessage(seatIndex, msg) {
  const seat = seats[seatIndex];
  if (msg.type === 'error') { alert(msg.message); return; }

  if (msg.type === 'joined') {
    seat.idx = msg.you; seat.roomCode = msg.room;
    if (seatIndex === 0) {
      document.getElementById('room-info').textContent =
        'Room code: ' + msg.room + '  (share this with your opponent) — you are Player ' + (msg.you + 1);
      document.getElementById('ready-panel').style.display = 'block';
      refreshSavedDecks();
      if (isSolo) { sendOnSeat(0, { type: 'submitDeck', deck: practiceDeck }); openSeat(1, { type: 'join', room: msg.room }); }
    } else if (isSolo) { sendOnSeat(1, { type: 'submitDeck', deck: practiceDeck }); showSeatSwitcher(); }
    return;
  }
  if (msg.type === 'joinRequest') {
    if (isSolo) sendOnSeat(0, { type: 'respondJoin', accept: true });
    else document.getElementById('join-request-banner').style.display = 'flex';
    return;
  }
  if (msg.type === 'joinPending') { document.getElementById('room-info').textContent = 'Waiting for the host to accept your join request...'; return; }
  if (msg.type === 'joinDeclined') { document.getElementById('room-info').textContent = 'The host declined your join request.'; return; }
  if (msg.type === 'flash') {
    const el = document.querySelector(`[data-key="${msg.key}"]`);
    if (el) { el.classList.remove('flash-red'); void el.offsetWidth; el.classList.add('flash-red'); }
    return;
  }
  if (msg.type === 'state') {
    seat.state = msg.state;
    if (seatIndex === activeSeat) renderState(msg.state);
    return;
  }
}

function showSeatSwitcher() {
  if (document.getElementById('seat-switcher')) return;
  const div = document.createElement('div');
  div.id = 'seat-switcher'; div.className = 'seat-switcher';
  div.innerHTML = 'Practice mode — viewing: <button id="btn-view-seat0">Player 1</button><button id="btn-view-seat1">Player 2</button>';
  document.getElementById('sidebar').prepend(div);
  document.getElementById('btn-view-seat0').addEventListener('click', () => switchSeat(0));
  document.getElementById('btn-view-seat1').addEventListener('click', () => switchSeat(1));
}
function switchSeat(seatIndex) { activeSeat = seatIndex; clearSelection(); if (seats[seatIndex].state) renderState(seats[seatIndex].state); }

function appendLog(text) {
  const log = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}
function ensureTableVisible() {
  if (document.getElementById('screen-table').style.display !== 'flex') {
    document.getElementById('screen-setup').style.display = 'none';
    document.getElementById('screen-die').style.display = 'none';
    document.getElementById('screen-table').style.display = 'flex';
  }
}

// ====================== Multi-select (drag box) ======================
let selectedKeys = new Set();
let selectedContainerId = null;

function clearSelection() {
  selectedKeys.clear(); selectedContainerId = null;
  document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
}
function applySelectionClasses() {
  document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
  selectedKeys.forEach(k => { const el = document.querySelector(`.card[data-key="${k}"]`); if (el) el.classList.add('selected'); });
}
function initSelectableZone(containerEl) {
  containerEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.card')) return;
    if (e.button !== 0) return;
    if (selectedContainerId !== containerEl.id) clearSelection();
    const startX = e.clientX, startY = e.clientY;
    let curX = startX, curY = startY;
    const box = document.getElementById('selection-box');
    box.style.display = 'block';
    box.style.left = startX + 'px'; box.style.top = startY + 'px'; box.style.width = '0px'; box.style.height = '0px';
    function onMove(ev) {
      curX = ev.clientX; curY = ev.clientY;
      const x = Math.min(startX, curX), y = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.style.display = 'none';
      const rect = { left: Math.min(startX, curX), right: Math.max(startX, curX), top: Math.min(startY, curY), bottom: Math.max(startY, curY) };
      const keys = [];
      containerEl.querySelectorAll('.card[data-key]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (!(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom)) keys.push(el.dataset.key);
      });
      if (keys.length > 1) { selectedKeys = new Set(keys); selectedContainerId = containerEl.id; applySelectionClasses(); }
      else clearSelection();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
['opp-mana', 'my-mana', 'opp-shields', 'my-shields', 'opp-battle', 'my-battle'].forEach(id => {
  const el = document.getElementById(id);
  if (el) initSelectableZone(el);
});

// ====================== Context menu ======================
function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach(item => {
    if (item === '--') { const d = document.createElement('div'); d.className = 'context-menu-divider'; menu.appendChild(d); return; }
    const [label, fn] = item;
    const div = document.createElement('div');
    div.className = 'context-menu-item';
    div.textContent = label;
    div.addEventListener('click', () => { fn(); hideContextMenu(); });
    menu.appendChild(div);
  });
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - items.length * 36 - 20) + 'px';
  menu.style.display = 'block';
}
function hideContextMenu() { document.getElementById('context-menu').style.display = 'none'; }
document.addEventListener('click', (e) => { if (!e.target.closest('.context-menu')) hideContextMenu(); });

// ====================== Magnify ======================
const magnifyOverlay = document.getElementById('magnify-overlay');
const magnifyCard = document.getElementById('magnify-card');
function openMagnify(id) { magnifyCard.innerHTML = cardImgHtml(id); magnifyOverlay.style.display = 'flex'; }
function closeMagnify() { magnifyOverlay.style.display = 'none'; }
magnifyOverlay.addEventListener('click', (e) => { if (e.target === magnifyOverlay) closeMagnify(); });
magnifyCard.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMagnify(); });
function makeMagnifiable(el, id) { el.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); openMagnify(id); }); }

// ====================== Flash (ctrl/cmd+click indicate) ======================
function attachFlashClick(el, zone, ownerIdx, key) {
  el.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); sendMsg({ type: 'flash', zone, ownerIdx, key }); }
  });
}

// ====================== Graveyard modal ======================
function openGyModal(title, cards, ownerIdx) {
  document.getElementById('gy-modal-title').textContent = title;
  const grid = document.getElementById('gy-modal-grid');
  grid.innerHTML = '';
  cards.slice().reverse().forEach(item => {
    const div = document.createElement('div');
    div.className = 'card-thumb';
    div.dataset.key = item.key;
    div.innerHTML = cardImgHtml(item.id);
    makeMagnifiable(div, item.id);
    attachFlashClick(div, 'graveyard', ownerIdx, item.key);
    grid.appendChild(div);
  });
  document.getElementById('gy-modal').style.display = 'flex';
}
document.getElementById('gy-modal-close').addEventListener('click', () => { document.getElementById('gy-modal').style.display = 'none'; });

// ====================== End game / surrender ======================
document.getElementById('btn-surrender').addEventListener('click', () => {
  if (confirm('Surrender this game?')) sendMsg({ type: 'surrender' });
});
document.getElementById('btn-end-game').addEventListener('click', () => {
  sendMsg({ type: 'requestEndGame' });
  appendLog('Asked your opponent to end the game.');
});
document.getElementById('btn-accept-end').addEventListener('click', () => sendMsg({ type: 'respondEndGame', accept: true }));
document.getElementById('btn-decline-end').addEventListener('click', () => sendMsg({ type: 'respondEndGame', accept: false }));
document.getElementById('btn-rematch').addEventListener('click', () => {
  sendMsg({ type: 'rematchVote' });
  document.getElementById('rematch-status').textContent = 'Waiting for opponent to accept rematch...';
});
document.getElementById('btn-quit').addEventListener('click', () => location.reload());
document.getElementById('btn-stop-showing').addEventListener('click', () => sendMsg({ type: 'setShowingHand', show: false }));

// ====================== Table rendering ======================
function renderState(state) {
  const meIdx = state.you;
  const oppIdx = meIdx === 0 ? 1 : 0;
  const me = state.players[meIdx];
  const opp = state.players[oppIdx];

  if (!state.dealt[meIdx]) {
    document.getElementById('ready-status').textContent = 'Submit a deck to deal your hand — no need to wait for your opponent.';
    return;
  }

  // rematch reset detection (must run before the die-roll screen check below)
  if (prevGameOver && !state.gameOver) { dieScreenShown = false; }
  prevGameOver = state.gameOver;

  const dieRolled = state.die[0] !== null;
  if (dieRolled && !dieScreenShown) {
    dieScreenShown = true;
    document.getElementById('screen-setup').style.display = 'none';
    document.getElementById('screen-die').style.display = 'block';
    document.getElementById('die-result').textContent =
      'You rolled ' + state.die[meIdx] + '  —  Opponent rolled ' + state.die[oppIdx] + '.';
    setTimeout(ensureTableVisible, 1800);
  } else {
    ensureTableVisible();
  }

  // ---- end game / game over modals ----
  document.getElementById('end-game-request-modal').style.display =
    (state.endGameRequestBy !== null && state.endGameRequestBy !== meIdx) ? 'flex' : 'none';
  if (state.gameOver) {
    const g = state.gameOver;
    document.getElementById('game-over-title').textContent =
      g.reason === 'surrender' ? (g.by === meIdx ? 'You surrendered.' : 'Opponent surrendered — you win!') : 'Game ended by agreement.';
    document.getElementById('rematch-status').textContent = state.rematch[oppIdx] ? 'Opponent wants a rematch — click Rematch to accept!' : '';
    document.getElementById('game-over-modal').style.display = 'flex';
  } else {
    document.getElementById('game-over-modal').style.display = 'none';
  }

  // ---- showing-hand banner ----
  document.getElementById('showing-hand-banner').style.display = me.showingHand ? 'flex' : 'none';

  // ---- hand (mine, fanned) ----
  const myHand = document.getElementById('my-hand');
  myHand.innerHTML = '';
  const n = me.hand.length;
  me.hand.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.key = c.key;
    el.innerHTML = cardImgHtml(c.id);
    el.style.zIndex = String(i);
    const mid = (n - 1) / 2;
    const angleStep = n > 1 ? Math.min(8, 60 / (n - 1)) : 0;
    const angle = (i - mid) * angleStep;
    const arcLift = -(Math.abs(mid - Math.abs(i - mid)) * 2.5);
    const restTransform = `rotate(${angle}deg) translateY(${arcLift}px)`;
    el.style.transform = restTransform;
    el.addEventListener('mouseenter', () => { el.classList.add('hand-hover'); el.style.transform = 'rotate(0deg) translateY(-46px) scale(1.7)'; });
    el.addEventListener('mouseleave', () => { el.classList.remove('hand-hover'); el.style.transform = restTransform; });
    makeMagnifiable(el, c.id);
    attachFlashClick(el, 'hand', meIdx, c.key);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [
        ['Charge Mana', () => sendMsg({ type: 'chargeMana', key: c.key })],
        ['Summon', () => sendMsg({ type: 'summonCard', key: c.key })],
        ['Discard', () => sendMsg({ type: 'discardFromHand', key: c.key })],
        [me.showingHand ? 'Stop Showing Hand to Opponent' : 'Show Hand to Opponent', () => sendMsg({ type: 'setShowingHand', show: !me.showingHand })],
        ['Return Card to Deck & Shuffle', () => sendMsg({ type: 'handCardToDeckShuffle', key: c.key })]
      ];
      showContextMenu(e.pageX, e.pageY, items);
    });
    myHand.appendChild(el);
  });

  // ---- opponent hand ----
  const oppHand = document.getElementById('opp-hand');
  oppHand.innerHTML = '';
  opp.hand.forEach(c => {
    const el = document.createElement('div');
    el.className = 'card' + (c.id ? '' : ' face-down');
    el.dataset.key = c.key;
    el.innerHTML = c.id ? cardImgHtml(c.id) : faceDownHtml();
    if (c.id) makeMagnifiable(el, c.id);
    attachFlashClick(el, 'hand', oppIdx, c.key);
    oppHand.appendChild(el);
  });

  renderManaZone('my-mana', me.mana, true, meIdx);
  renderManaZone('opp-mana', opp.mana, false, oppIdx);
  renderShieldZone('my-shields', me.shields, true, meIdx);
  renderShieldZone('opp-shields', opp.shields, false, oppIdx);
  renderBattleHalf('my-battle', me.battlezone, true, meIdx);
  renderBattleHalf('opp-battle', opp.battlezone, false, oppIdx);
  renderDeckZone('my-deck', me.deckCount, true);
  renderDeckZone('opp-deck', opp.deckCount, false);
  renderGyZone('my-gy', me.graveyard, true, meIdx);
  renderGyZone('opp-gy', opp.graveyard, false, oppIdx);

  const ti = document.getElementById('turn-indicator');
  ti.textContent = dieRolled ? 'Free play — act anytime, either player' : 'Waiting for opponent to join & deal in...';
  ti.className = 'turn-indicator' + (dieRolled ? ' my-turn' : '');

  applySelectionClasses();
  window.__lastMe = me; window.__lastOpp = opp;
}

function renderManaZone(elId, mana, isMine, ownerIdx) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  mana.forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.dataset.key = c.key;
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);
    attachFlashClick(div, 'mana', ownerIdx, c.key);
    if (isMine) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(c.key)) {
          showContextMenu(e.pageX, e.pageY, [
            ['Tap / Untap Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaTap', key: k })); clearSelection(); }],
            ['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaReturnToHand', key: k })); clearSelection(); }],
            ['Destroy Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaDestroy', key: k })); clearSelection(); }],
            ['Put Selected Back in Deck & Shuffle', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaToDeckShuffle', key: k })); clearSelection(); }]
          ]);
        } else {
          clearSelection();
          showContextMenu(e.pageX, e.pageY, [
            [c.tapped ? 'Untap' : 'Tap', () => sendMsg({ type: 'manaTap', key: c.key })],
            ['Return to Hand', () => sendMsg({ type: 'manaReturnToHand', key: c.key })],
            ['Destroy', () => sendMsg({ type: 'manaDestroy', key: c.key })],
            ['Put Back in Deck & Shuffle', () => sendMsg({ type: 'manaToDeckShuffle', key: c.key })]
          ]);
        }
      });
    }
    el.appendChild(div);
  });
}

function renderShieldZone(elId, shields, isMine, ownerIdx) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  shields.forEach(s => {
    const div = document.createElement('div');
    const faceUp = !!s.faceUp;
    div.className = 'card' + (faceUp ? '' : ' face-down');
    div.dataset.key = s.key;
    div.innerHTML = faceUp ? cardImgHtml(s.id) : faceDownHtml();
    if (faceUp) makeMagnifiable(div, s.id);
    attachFlashClick(div, 'shield', ownerIdx, s.key);
    if (isMine) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(s.key)) {
          showContextMenu(e.pageX, e.pageY, [
            ['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'shieldReturnToHand', key: k })); clearSelection(); }],
            ['Put Selected in Graveyard', () => { selectedKeys.forEach(k => sendMsg({ type: 'shieldToGraveyard', key: k })); clearSelection(); }],
            ['Flip Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'shieldFlip', key: k })); clearSelection(); }]
          ]);
        } else {
          clearSelection();
          const items = [['Return to Hand', () => sendMsg({ type: 'shieldReturnToHand', key: s.key })],
                          ['Put in Graveyard', () => sendMsg({ type: 'shieldToGraveyard', key: s.key })],
                          [faceUp ? 'Unflip' : 'Flip Card', () => sendMsg({ type: 'shieldFlip', key: s.key })]];
          showContextMenu(e.pageX, e.pageY, items);
        }
      });
    }
    el.appendChild(div);
  });
}

function renderBattleHalf(elId, cards, isMine, ownerIdx) {
  const container = document.getElementById(elId);
  container.innerHTML = '';
  const rect = container.getBoundingClientRect();
  const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 100;
  const ch = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h')) || 140;
  const gap = 10;
  const cols = Math.max(1, Math.floor((rect.width || 600) / (cw + gap)));
  let autoIndex = 0;

  cards.forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.dataset.key = c.key;
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);

    let leftPx, topPx;
    if (c.x !== null && c.x !== undefined) {
      leftPx = (c.x / 100) * (rect.width || 600);
      topPx = (c.y / 100) * (rect.height || 200);
    } else {
      const col = autoIndex % cols, row = Math.floor(autoIndex / cols);
      leftPx = col * (cw + gap) + gap; topPx = row * (ch + gap) + gap;
      autoIndex++;
    }
    div.style.left = leftPx + 'px'; div.style.top = topPx + 'px';

    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(c.key)) {
        const batch = [['Tap / Untap Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleTap', key: k })); clearSelection(); }]];
        if (isMine) {
          batch.push(['Destroy Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleDestroy', key: k })); clearSelection(); }]);
          batch.push(['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleReturn', key: k })); clearSelection(); }]);
        }
        showContextMenu(e.pageX, e.pageY, batch);
      } else {
        clearSelection();
        const items = [[c.tapped ? 'Untap' : 'Tap', () => sendMsg({ type: 'battleTap', key: c.key })]];
        if (isMine) {
          items.push(['Destroy', () => sendMsg({ type: 'battleDestroy', key: c.key })]);
          items.push(['Return to Hand', () => sendMsg({ type: 'battleReturn', key: c.key })]);
        }
        showContextMenu(e.pageX, e.pageY, items);
      }
    });

    if (isMine) {
      div.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendMsg({ type: 'flash', zone: 'battlezone', ownerIdx, key: c.key }); return; }
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const origLeft = parseFloat(div.style.left), origTop = parseFloat(div.style.top);
        let moved = false;
        function onMove(ev) {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
          if (moved) { div.classList.add('dragging'); div.style.left = (origLeft + dx) + 'px'; div.style.top = (origTop + dy) + 'px'; }
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          div.classList.remove('dragging');
          if (moved) {
            const cr = container.getBoundingClientRect();
            const xPct = Math.max(0, Math.min(100, (parseFloat(div.style.left) / cr.width) * 100));
            const yPct = Math.max(0, Math.min(100, (parseFloat(div.style.top) / cr.height) * 100));
            sendMsg({ type: 'battleMove', key: c.key, x: xPct, y: yPct });
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    } else {
      attachFlashClick(div, 'battlezone', ownerIdx, c.key);
    }
    container.appendChild(div);
  });
}

function renderDeckZone(elId, count, isMine) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card face-down';
  card.innerHTML = faceDownHtml();
  el.appendChild(card);
  const badge = document.createElement('div');
  badge.className = 'stack-count';
  badge.textContent = count;
  el.appendChild(badge);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    if (!isMine) return;
    showContextMenu(e.pageX, e.pageY, [
      ['Draw a Card', () => sendMsg({ type: 'drawCard' })],
      ['Shuffle Deck', () => sendMsg({ type: 'shuffleDeck' })]
    ]);
  };
}

function renderGyZone(elId, cards, isMine, ownerIdx) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  if (cards.length) {
    const top = cards[cards.length - 1];
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = top.key;
    card.innerHTML = cardImgHtml(top.id);
    el.appendChild(card);
    const badge = document.createElement('div');
    badge.className = 'stack-count';
    badge.textContent = cards.length;
    el.appendChild(badge);
  }
  el.onclick = () => openGyModal(isMine ? 'Your Graveyard' : 'Opponent Graveyard', cards, ownerIdx);
}
