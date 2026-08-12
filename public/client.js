// ====================== Card image loading ======================
// cardDB: Map(id -> { url, name, set })  id = "DM-1/Card Name.png"
let cardDB = new Map();

const IMG_EXT = /\.(png|jpg|jpeg|webp|gif)$/i;

// --- tiny IndexedDB helper to remember the folder handle (Chrome/Edge) ---
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

// ---- progress bar helpers ----
const progWrap = document.getElementById('load-progress-wrap');
const progBar = document.getElementById('load-progress-bar');
function progressStart(indeterminate) {
  progWrap.style.display = 'block';
  progBar.classList.toggle('indeterminate', !!indeterminate);
  progBar.style.width = '0%';
}
function progressUpdate(done, total) {
  if (total > 0) progBar.style.width = Math.round((done / total) * 100) + '%';
}
function progressDone() {
  progBar.classList.remove('indeterminate');
  progBar.style.width = '100%';
  setTimeout(() => { progWrap.style.display = 'none'; }, 400);
}

// yield to the browser every so often so the progress bar / UI can repaint
let __yieldCounter = 0;
async function maybeYield() {
  __yieldCounter++;
  if (__yieldCounter % 15 === 0) await new Promise(r => setTimeout(r, 0));
}

async function scanDirHandle(dirHandle) {
  cardDB.clear();
  const statusEl = document.getElementById('load-status');

  // Pass 1: enumerate everything first so we know the total (cheap — no file reads yet)
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

  // Pass 2: actually load each image, with a real percentage
  progressStart(false);
  const total = jobs.length;
  for (let i = 0; i < total; i++) {
    const { setName, fileName, fileHandle } = jobs[i];
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    const id = setName + '/' + fileName;
    cardDB.set(id, { url, name: fileName.replace(IMG_EXT, ''), set: setName });
    if (i % 10 === 0 || i === total - 1) {
      progressUpdate(i + 1, total);
      statusEl.textContent = `Loading cards... ${i + 1} / ${total}`;
      await maybeYield();
    }
  }
  progressDone();
}

async function scanFileList(files) {
  cardDB.clear();
  const statusEl = document.getElementById('load-status');
  const imgFiles = [...files].filter(f => IMG_EXT.test(f.name));
  const total = imgFiles.length;
  progressStart(false);
  for (let i = 0; i < total; i++) {
    const file = imgFiles[i];
    const rel = file.webkitRelativePath || file.name; // "cards/DM-1/Name.png"
    const parts = rel.split('/');
    if (parts.length < 2) continue;
    const setName = parts[parts.length - 2];
    const fileName = parts[parts.length - 1];
    const id = setName + '/' + fileName;
    const url = URL.createObjectURL(file);
    cardDB.set(id, { url, name: fileName.replace(IMG_EXT, ''), set: setName });
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
      statusEl.textContent = cardDB.size + ' cards loaded from "' + handle.name + '".';
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
  document.getElementById('load-status').textContent = cardDB.size + ' cards loaded.';
  refreshCardGrid();
});

document.getElementById('btn-load-folder').addEventListener('click', loadFolder);

// try to silently reconnect to a previously granted folder
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

// ====================== Deck builder ======================
let currentDeck = []; // array of card ids, may repeat

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
      `<div class="name">${c.name}</div>`;
    div.addEventListener('click', () => {
      if (currentDeck.length >= 40) return;
      currentDeck.push(id);
      refreshCardGrid();
      refreshDeckList();
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
      refreshDeckList();
      refreshCardGrid();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  document.getElementById('deck-count').textContent = currentDeck.length + ' / 40 cards';
}

function getSavedDecks() {
  try { return JSON.parse(localStorage.getItem('dm_decks') || '{}'); } catch { return {}; }
}
function setSavedDecks(d) { localStorage.setItem('dm_decks', JSON.stringify(d)); }

function refreshSavedDecks() {
  const wrap = document.getElementById('saved-decks');
  const sel = document.getElementById('active-deck-select');
  wrap.innerHTML = '';
  sel.innerHTML = '';
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
    delBtn.addEventListener('click', () => {
      delete decks[name]; setSavedDecks(decks); refreshSavedDecks();
    });
    row.appendChild(loadBtn); row.appendChild(delBtn);
    wrap.appendChild(row);

    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name + ' (' + decks[name].length + ')';
    sel.appendChild(opt);
  }
}

document.getElementById('btn-save-deck').addEventListener('click', () => {
  const name = (document.getElementById('deck-name').value || '').trim();
  if (!name) { alert('Name your deck first.'); return; }
  if (currentDeck.length !== 40) {
    if (!confirm('Deck has ' + currentDeck.length + ' cards, not 40. Save anyway?')) return;
  }
  const decks = getSavedDecks();
  decks[name] = currentDeck.slice();
  setSavedDecks(decks);
  refreshSavedDecks();
});

refreshSavedDecks();
refreshDeckList();

// ====================== Networking / lobby ======================
let ws = null;
let myIndex = null;
let roomCode = null;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host;
}

function connectAndSend(msg) {
  const cWrap = document.getElementById('connect-progress-wrap');
  cWrap.style.display = 'block';
  document.getElementById('room-info').textContent = 'Connecting to server (may take a minute if it was asleep)...';
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => ws.send(JSON.stringify(msg)));
  ws.addEventListener('message', (ev) => { cWrap.style.display = 'none'; onServerMessage(ev); });
  ws.addEventListener('close', () => { cWrap.style.display = 'none'; appendLog('Disconnected from server.'); });
  ws.addEventListener('error', () => { cWrap.style.display = 'none'; document.getElementById('room-info').textContent = 'Could not connect. Try again.'; });
}

document.getElementById('btn-create-room').addEventListener('click', () => {
  connectAndSend({ type: 'create' });
});
document.getElementById('btn-join-room').addEventListener('click', () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) return;
  connectAndSend({ type: 'join', room: code });
});
document.getElementById('btn-submit-deck').addEventListener('click', () => {
  const decks = getSavedDecks();
  const name = document.getElementById('active-deck-select').value;
  const deck = decks[name];
  if (!deck || !deck.length) { alert('Pick a saved deck first.'); return; }
  ws.send(JSON.stringify({ type: 'submitDeck', deck }));
  document.getElementById('ready-status').textContent = 'Deck submitted. Waiting for opponent...';
});

let lastPhase = null;
let dieScreenShown = false;

function onServerMessage(ev) {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'error') { alert(msg.message); return; }
  if (msg.type === 'joined') {
    myIndex = msg.you;
    roomCode = msg.room;
    document.getElementById('room-info').textContent =
      'Room code: ' + roomCode + '  (share this with your opponent) — you are Player ' + (myIndex + 1);
    document.getElementById('ready-panel').style.display = 'block';
    refreshSavedDecks();
    return;
  }
  if (msg.type === 'state') {
    renderState(msg.state);
    return;
  }
}

// ====================== Table rendering ======================
function cardImgHtml(id) {
  const c = cardDB.get(id);
  if (c) return `<img src="${c.url}" alt="${c.name}">`;
  return `<div class="placeholder-label">${id || '?'}</div>`;
}

function appendLog(text) {
  const log = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function renderState(state) {
  const meIdx = state.you;
  const oppIdx = meIdx === 0 ? 1 : 0;
  const me = state.players[meIdx];
  const opp = state.players[oppIdx];

  if (state.phase === 'waiting') {
    document.getElementById('ready-status').textContent = state.ready
      ? 'Both decks in — starting...' : 'Waiting for both players to submit a deck...';
    return;
  }

  // first time we see a non-waiting phase, show the die roll screen briefly
  if (!dieScreenShown && state.die[0] !== null) {
    dieScreenShown = true;
    document.getElementById('screen-setup').style.display = 'none';
    document.getElementById('screen-die').style.display = 'block';
    document.getElementById('die-result').textContent =
      'You rolled ' + state.die[meIdx] + '  —  Opponent rolled ' + state.die[oppIdx] +
      '.  ' + (state.turn === meIdx ? 'You go first!' : 'Opponent goes first.');
    setTimeout(() => {
      document.getElementById('screen-die').style.display = 'none';
      document.getElementById('screen-table').style.display = 'flex';
    }, 2200);
  }

  // ---- hand (mine, face up, interactive, fanned) ----
  const myHand = document.getElementById('my-hand');
  myHand.innerHTML = '';
  const handCards = me.hand || [];
  const n = handCards.length;
  handCards.forEach((id, i) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = cardImgHtml(id);
    el.style.zIndex = String(i);

    // fan geometry: spread rotation + slight arc, centered on the hand
    const mid = (n - 1) / 2;
    const angleStep = n > 1 ? Math.min(8, 60 / (n - 1)) : 0;
    const angle = (i - mid) * angleStep;
    const arcLift = -(Math.pow(mid - Math.abs(i - mid), 1) * 2.5); // center cards sit slightly higher
    const restTransform = `rotate(${angle}deg) translateY(${arcLift}px)`;
    el.style.transform = restTransform;

    el.addEventListener('mouseenter', () => {
      el.classList.add('hand-hover');
      el.style.transform = 'rotate(0deg) translateY(-40px) scale(1.6)';
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('hand-hover');
      el.style.transform = restTransform;
    });

    makeMagnifiable(el, id);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [];
      if (state.turn === meIdx && state.phase === 'charge') {
        items.push(['Charge Mana', () => sendMsg({ type: 'chargeMana', cardId: id })]);
      }
      if (state.turn === meIdx && state.phase === 'main') {
        items.push(['Place on Battlefield', () => sendMsg({ type: 'placeCard', cardId: id })]);
      }
      items.push(['Discard to Graveyard', () => sendMsg({ type: 'discardFromHand', cardId: id })]);
      showContextMenu(e.pageX, e.pageY, items);
    });
    myHand.appendChild(el);
  });

  // ---- opponent hand (face down, count only) ----
  const oppHand = document.getElementById('opp-hand');
  oppHand.innerHTML = '';
  for (let i = 0; i < (opp.handCount || 0); i++) {
    const el = document.createElement('div');
    el.className = 'card face-down';
    oppHand.appendChild(el);
  }

  // ---- mana zones (public) ----
  renderManaZone('my-mana', me.mana, true);
  renderManaZone('opp-mana', opp.mana, false);

  // ---- shields (identity hidden even from owner) ----
  renderShieldZone('my-shields', me.shields, true);
  renderShieldZone('opp-shields', opp.shields, false);

  // ---- battlezone ----
  renderBattleZone('my-battle', me.battlezone, true);
  renderBattleZone('opp-battle', opp.battlezone, false);

  // ---- sidebar ----
  const ti = document.getElementById('turn-indicator');
  ti.textContent = state.turn === meIdx ? 'Your turn' : "Opponent's turn";
  ti.className = 'turn-indicator' + (state.turn === meIdx ? ' my-turn' : '');
  document.getElementById('phase-label').textContent = 'Phase: ' + state.phase;
  document.getElementById('my-gy-count').textContent = me.graveyard.length;
  document.getElementById('opp-gy-count').textContent = opp.graveyard.length;
  document.getElementById('my-deck-count').textContent = me.deckCount;
  document.getElementById('opp-deck-count').textContent = opp.deckCount;

  const isMyTurn = state.turn === meIdx;
  document.getElementById('btn-end-phase').style.display = (isMyTurn && state.phase !== 'end') ? 'inline-block' : 'none';
  document.getElementById('btn-end-turn').style.display = isMyTurn ? 'inline-block' : 'none';

  window.__lastMe = me; window.__lastOpp = opp;
}

function renderManaZone(elId, mana, isMine) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  (mana || []).forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);
    if (isMine) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.pageX, e.pageY, [
          [c.tapped ? 'Untap' : 'Tap', () => sendMsg({ type: 'tapMana', key: c.key })],
          ['Send to Graveyard', () => sendMsg({ type: 'sendManaToGraveyard', key: c.key })]
        ]);
      });
    }
    el.appendChild(div);
  });
}

function renderShieldZone(elId, shields, isMine) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  (shields || []).forEach(s => {
    const div = document.createElement('div');
    div.className = 'card face-down' + (s.targeted ? ' targeted' : '');
    el.appendChild(div);
    if (!isMine) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.pageX, e.pageY, [
          [s.targeted ? 'Remove Target' : 'Target this Shield', () => sendMsg({ type: 'targetCard', zone: 'shield', key: s.key })]
        ]);
      });
    } else if (s.targeted) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.pageX, e.pageY, [
          ['Send to Hand', () => sendMsg({ type: 'resolveTarget', key: s.key, dest: 'hand' })],
          ['Send to Graveyard', () => sendMsg({ type: 'resolveTarget', key: s.key, dest: 'graveyard' })]
        ]);
      });
    }
  });
}

function renderBattleZone(elId, cards, isMine) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  (cards || []).forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '') + (c.targeted ? ' targeted' : '');
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [];
      items.push([c.tapped ? 'Untap' : 'Tap', () => sendMsg({ type: 'tapCard', key: c.key })]);
      if (!isMine) {
        items.push([c.targeted ? 'Remove Target' : 'Target this Creature', () => sendMsg({ type: 'targetCard', zone: 'battlezone', key: c.key })]);
      } else {
        if (c.targeted) {
          items.push(['Send to Hand', () => sendMsg({ type: 'resolveTarget', key: c.key, dest: 'hand' })]);
          items.push(['Send to Graveyard', () => sendMsg({ type: 'resolveTarget', key: c.key, dest: 'graveyard' })]);
        }
        items.push(['Return to Hand', () => sendMsg({ type: 'battleToHand', key: c.key })]);
        items.push(['Send to Graveyard', () => sendMsg({ type: 'sendBattleToGraveyard', key: c.key })]);
      }
      showContextMenu(e.pageX, e.pageY, items);
    });
    el.appendChild(div);
  });
}

function sendMsg(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

document.getElementById('btn-end-phase').addEventListener('click', () => sendMsg({ type: 'endPhase' }));
document.getElementById('btn-end-turn').addEventListener('click', () => sendMsg({ type: 'endTurn' }));
document.getElementById('btn-draw').addEventListener('click', () => sendMsg({ type: 'drawCard' }));

// ====================== Context menu ======================
function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach(([label, fn]) => {
    const div = document.createElement('div');
    div.className = 'context-menu-item';
    div.textContent = label;
    div.addEventListener('click', () => { fn(); hideContextMenu(); });
    menu.appendChild(div);
  });
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
}
function hideContextMenu() { document.getElementById('context-menu').style.display = 'none'; }
document.addEventListener('click', hideContextMenu);

// ====================== Magnify (double-click a card) ======================
const magnifyOverlay = document.getElementById('magnify-overlay');
const magnifyCard = document.getElementById('magnify-card');
function openMagnify(id) {
  magnifyCard.innerHTML = cardImgHtml(id);
  magnifyOverlay.style.display = 'flex';
}
function closeMagnify() { magnifyOverlay.style.display = 'none'; }
magnifyOverlay.addEventListener('click', (e) => {
  if (e.target === magnifyOverlay) closeMagnify(); // click outside the card = close
});
magnifyCard.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMagnify(); });

function makeMagnifiable(el, id) {
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMagnify(id);
  });
}

// ====================== Graveyard viewer ======================
function openGyModal(title, ids) {
  document.getElementById('gy-modal-title').textContent = title;
  const grid = document.getElementById('gy-modal-grid');
  grid.innerHTML = '';
  ids.forEach(id => {
    const div = document.createElement('div');
    div.className = 'card-thumb';
    div.innerHTML = cardImgHtml(id);
    makeMagnifiable(div, id);
    grid.appendChild(div);
  });
  document.getElementById('gy-modal').style.display = 'flex';
}
document.getElementById('btn-view-my-gy').addEventListener('click', () => {
  openGyModal('Your Graveyard', (window.__lastMe && window.__lastMe.graveyard) || []);
});
document.getElementById('btn-view-opp-gy').addEventListener('click', () => {
  openGyModal('Opponent Graveyard', (window.__lastOpp && window.__lastOpp.graveyard) || []);
});
document.getElementById('gy-modal-close').addEventListener('click', () => {
  document.getElementById('gy-modal').style.display = 'none';
});
