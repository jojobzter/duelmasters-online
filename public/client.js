// ====================== Card image loading ======================
let cardDB = new Map();      // id ("DM-1/Name.png") -> {url, name, set}
let cardBackUrl = null;      // from a "card back" folder, if present
const IMG_EXT = /\.(png|jpg|jpeg|webp|gif)$/i;
function stripExt(id) { return typeof id === 'string' ? id.replace(IMG_EXT, '') : id; }
function cardBaseName(id) { return id ? (id.split('/').pop() || id) : ''; }
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
      const baseName = fileName.replace(IMG_EXT, '');
      const id = setName + '/' + baseName; // extension-agnostic: renaming .png->.jpg etc. never breaks matching
      cardDB.set(id, { url, name: baseName, set: setName });
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
      const baseName = fileName.replace(IMG_EXT, '');
      const id = setName + '/' + baseName;
      cardDB.set(id, { url, name: baseName, set: setName });
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

// Browsers won't silently re-read local files after a page reload, but they WILL
// re-grant with a single confirmation click on a remembered folder — much less
// friction than re-navigating the whole folder picker every time.
let rememberedFolderHandle = null;
async function reloadRememberedFolder() {
  if (!rememberedFolderHandle) return;
  const statusEl = document.getElementById('load-status');
  try {
    const perm = await rememberedFolderHandle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') { statusEl.textContent = 'Permission denied — use "Choose cards folder" instead.'; return; }
    await scanDirHandle(rememberedFolderHandle);
    statusEl.textContent = cardDB.size + ' cards loaded from "' + rememberedFolderHandle.name + '".' + (cardBackUrl ? ' Card back found.' : '');
    document.getElementById('btn-reload-folder').style.display = 'none';
    refreshCardGrid();
  } catch (e) {
    statusEl.textContent = 'Could not reload folder: ' + e.message;
  }
}
document.getElementById('btn-reload-folder').addEventListener('click', reloadRememberedFolder);

(async () => {
  if (!window.showDirectoryPicker) return;
  const handle = await idbGet('cardsFolder');
  if (!handle) return;
  rememberedFolderHandle = handle;
  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') {
    await scanDirHandle(handle);
    document.getElementById('load-status').textContent = cardDB.size + ' cards loaded from "' + handle.name + '" (remembered).';
    refreshCardGrid();
  } else {
    const btn = document.getElementById('btn-reload-folder');
    btn.textContent = 'Reload "' + handle.name + '"';
    btn.style.display = 'inline-block';
    document.getElementById('load-status').textContent = 'One click to reload your images.';
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

// ---- Card metadata (civilization/type/cost), loaded from the server's parsed spreadsheet ----
let cardMetaDB = new Map(); // lowercase card name -> {name, cost, type, civs}
let activeCivFilters = new Set();
let activeTypeFilters = new Set();
const CIV_COLORS = { Fire: '#c0392b', Water: '#2980b9', Nature: '#27ae60', Light: '#c99a1e', Darkness: '#6a3f9e' };

async function loadCardMetaDB() {
  try {
    const res = await fetch('/api/carddata', { cache: 'no-store' });
    const data = await res.json();
    const arr = data.cards || [];
    cardMetaDB = new Map();
    const civSet = new Set(), typeSet = new Set();
    arr.forEach(c => {
      cardMetaDB.set(c.name.toLowerCase(), c);
      (c.civs || []).forEach(v => civSet.add(v));
      if (c.type) typeSet.add(c.type);
    });
    buildFilterUI([...civSet].sort(), [...typeSet].sort());
    console.log('Card database loaded in browser:', arr.length, 'cards.');
  } catch (e) {
    console.warn('Could not load card database:', e);
  }
}
loadCardMetaDB();

function buildFilterUI(civs, types) {
  const civWrap = document.getElementById('civ-filters');
  const typeWrap = document.getElementById('type-filters');
  if (!civWrap || !typeWrap) return;
  civWrap.innerHTML = '';
  civs.forEach(civ => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip';
    btn.textContent = civ;
    btn.style.setProperty('--chip-color', CIV_COLORS[civ] || '#555a66');
    btn.addEventListener('click', () => {
      if (activeCivFilters.has(civ)) activeCivFilters.delete(civ); else activeCivFilters.add(civ);
      btn.classList.toggle('active');
      refreshCardGrid();
    });
    civWrap.appendChild(btn);
  });
  typeWrap.innerHTML = '';
  types.forEach(type => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip';
    btn.textContent = type;
    btn.addEventListener('click', () => {
      if (activeTypeFilters.has(type)) activeTypeFilters.delete(type); else activeTypeFilters.add(type);
      btn.classList.toggle('active');
      refreshCardGrid();
    });
    typeWrap.appendChild(btn);
  });
}

// Cards missing from the spreadsheet, or missing a civ/type, always pass through
// unfiltered — incomplete data should never hide a card, only unlock filtering for it.
function cardPassesFilters(id) {
  const meta = cardMetaDB.get(cardBaseName(id).toLowerCase());
  if (activeCivFilters.size) {
    if (!meta || !meta.civs || !meta.civs.some(c => activeCivFilters.has(c))) return false;
  }
  if (activeTypeFilters.size) {
    if (!meta || !meta.type || !activeTypeFilters.has(meta.type)) return false;
  }
  return true;
}

function refreshCardGrid() {
  const grid = document.getElementById('card-grid');
  const query = (document.getElementById('card-search').value || '').toLowerCase();
  grid.innerHTML = '';
  const ids = [...cardDB.keys()].sort();
  for (const id of ids) {
    const c = cardDB.get(id);
    if (query && !c.name.toLowerCase().includes(query) && !c.set.toLowerCase().includes(query)) continue;
    if (!cardPassesFilters(id)) continue;
    const meta = cardMetaDB.get(c.name.toLowerCase());
    const div = document.createElement('div');
    div.className = 'card-thumb';
    const count = currentDeck.filter(x => x === id).length;
    div.innerHTML = `<img src="${c.url}" title="${c.name}">` +
      (count ? `<div class="count-badge">${count}</div>` : '') +
      (meta && meta.cost != null ? `<div class="cost-badge">${meta.cost}</div>` : '') +
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

function getSavedDecks() {
  try {
    const decks = JSON.parse(localStorage.getItem('dm_decks') || '{}');
    // migrate any legacy card ids that still include a file extension (e.g. from before a format change)
    for (const name of Object.keys(decks)) decks[name] = decks[name].map(stripExt);
    return decks;
  } catch { return {}; }
}
function setSavedDecks(d) { localStorage.setItem('dm_decks', JSON.stringify(d)); }

let selectedDeckName = localStorage.getItem('dm_selected_deck') || null;

function updateSelectedDeckDisplay() {
  const el = document.getElementById('selected-deck-display');
  const decks = getSavedDecks();
  if (selectedDeckName && decks[selectedDeckName]) {
    el.textContent = 'Selected deck: ' + selectedDeckName + ' (' + decks[selectedDeckName].length + ' cards)';
    el.classList.add('has-deck');
  } else {
    selectedDeckName = null;
    localStorage.removeItem('dm_selected_deck');
    el.textContent = 'No deck selected yet — pick one above and click "Select".';
    el.classList.remove('has-deck');
  }
}

function selectDeck(name) {
  selectedDeckName = name;
  localStorage.setItem('dm_selected_deck', name);
  updateSelectedDeckDisplay();
}

function openDeckViewModal(name, cards) {
  document.getElementById('deck-view-title').textContent = name + ' (' + cards.length + ' cards)';
  const grid = document.getElementById('deck-view-grid');
  grid.innerHTML = '';
  const counts = new Map();
  cards.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
  [...counts.entries()].sort().forEach(([id, n]) => {
    const div = document.createElement('div');
    div.className = 'card-thumb';
    const c = cardDB.get(id);
    div.innerHTML = cardImgHtml(id) + (n > 1 ? `<div class="count-badge">${n}</div>` : '') +
      `<div class="name">${c ? c.name : id}</div>`;
    makeMagnifiable(div, id);
    grid.appendChild(div);
  });
  document.getElementById('deck-view-modal').style.display = 'flex';
}
document.getElementById('deck-view-close').addEventListener('click', () => { document.getElementById('deck-view-modal').style.display = 'none'; });

function refreshSavedDecks() {
  const wrap = document.getElementById('saved-decks');
  wrap.innerHTML = '';
  const decks = getSavedDecks();
  for (const name of Object.keys(decks).sort()) {
    const row = document.createElement('div');
    row.className = 'saved-deck-row';
    const nameLink = document.createElement('b');
    nameLink.className = 'deck-name-link';
    nameLink.textContent = name;
    nameLink.title = 'Click to preview the cards in this deck';
    nameLink.addEventListener('click', () => openDeckViewModal(name, decks[name]));
    row.appendChild(nameLink);
    const countSpan = document.createElement('span');
    countSpan.className = 'hint';
    countSpan.textContent = ' (' + decks[name].length + ' cards) ';
    row.appendChild(countSpan);

    const selectBtn = document.createElement('button');
    selectBtn.textContent = (selectedDeckName === name) ? 'Selected \u2713' : 'Select';
    selectBtn.addEventListener('click', () => { selectDeck(name); refreshSavedDecks(); });
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Edit';
    loadBtn.addEventListener('click', () => {
      currentDeck = decks[name].slice();
      document.getElementById('deck-name').value = name;
      refreshDeckList(); refreshCardGrid();
    });
    const shareBtn = document.createElement('button');
    shareBtn.textContent = 'Share';
    shareBtn.addEventListener('click', () => {
      const code = encodeDeckCode(name, decks[name]);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => alert('Share code for "' + name + '" copied to clipboard!'))
          .catch(() => prompt('Copy this share code:', code));
      } else {
        prompt('Copy this share code:', code);
      }
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      delete decks[name]; setSavedDecks(decks);
      if (selectedDeckName === name) { selectedDeckName = null; localStorage.removeItem('dm_selected_deck'); }
      refreshSavedDecks(); updateSelectedDeckDisplay();
    });
    row.appendChild(selectBtn); row.appendChild(loadBtn); row.appendChild(shareBtn); row.appendChild(delBtn);
    wrap.appendChild(row);
  }
  updateSelectedDeckDisplay();
}

document.getElementById('btn-save-deck').addEventListener('click', () => {
  const name = (document.getElementById('deck-name').value || '').trim();
  if (!name) { alert('Name your deck first.'); return; }
  if (currentDeck.length !== 40) { if (!confirm('Deck has ' + currentDeck.length + ' cards, not 40. Save anyway?')) return; }
  const decks = getSavedDecks();
  decks[name] = currentDeck.slice();
  setSavedDecks(decks);
  // clear the working list so the editor is ready for the next deck
  currentDeck = [];
  document.getElementById('deck-name').value = '';
  document.getElementById('share-code-box').style.display = 'none';
  document.getElementById('share-code-status').textContent = '';
  refreshDeckList();
  refreshCardGrid();
  refreshSavedDecks();
});

// ---- share codes: a portable text blob a friend can paste to get your exact decklist ----
function encodeDeckCode(name, cards) {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ n: name, c: cards }))));
}
function decodeDeckCode(code) {
  const obj = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
  if (!obj || !Array.isArray(obj.c) || !obj.c.length) throw new Error('bad code');
  return { name: (obj.n || 'Imported Deck').toString().slice(0, 60), cards: obj.c.map(stripExt) };
}
document.getElementById('btn-share-deck').addEventListener('click', () => {
  if (!currentDeck.length) { alert('Build a deck first.'); return; }
  const name = (document.getElementById('deck-name').value || '').trim() || 'My Deck';
  const code = encodeDeckCode(name, currentDeck);
  const box = document.getElementById('share-code-box');
  box.value = code;
  box.style.display = 'block';
  box.select();
  const status = document.getElementById('share-code-status');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code)
      .then(() => { status.textContent = 'Copied to clipboard — paste it to a friend.'; })
      .catch(() => { status.textContent = 'Select the code below and copy it manually.'; });
  } else {
    status.textContent = 'Select the code below and copy it manually.';
  }
});
document.getElementById('btn-import-deck').addEventListener('click', () => {
  const raw = document.getElementById('import-code').value;
  if (!raw.trim()) return;
  try {
    const { name, cards } = decodeDeckCode(raw);
    currentDeck = cards.slice(0, 40);
    document.getElementById('deck-name').value = name;
    refreshDeckList(); refreshCardGrid();
    document.getElementById('import-code').value = '';
    alert('Loaded "' + name + '" (' + currentDeck.length + ' cards) into the editor below. Click "Save Deck" to keep it — cards you don\'t have images for will just show as placeholders until you do.');
  } catch (e) {
    alert("That doesn't look like a valid share code.");
  }
});

refreshSavedDecks();
refreshDeckList();

// ====================== Networking / seats ======================
let seats = [
  { ws: null, idx: null, roomCode: null, state: null },
  { ws: null, idx: null, roomCode: null, state: null }
];
let activeSeat = 0;
let lastActiveTurn = null; // tracks turn changes so the banner can pulse when it becomes yours

// True only when a turn has actually been claimed AND it isn't the viewing player's.
// Before anyone presses "End My Turn" there's no turn order at all, so nothing is "off turn".
function isOffTurnForMe() {
  const st = seats[activeSeat] && seats[activeSeat].state;
  if (!st) return false;
  if (st.activeTurn === null || st.activeTurn === undefined) return false;
  return st.activeTurn !== st.you;
}
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

const nameInput = document.getElementById('player-name');
nameInput.value = localStorage.getItem('dm_playername') || '';
nameInput.addEventListener('change', () => localStorage.setItem('dm_playername', nameInput.value.trim().slice(0, 24)));
function myName() { return nameInput.value.trim().slice(0, 24); }

document.getElementById('btn-create-room').addEventListener('click', () => {
  const decks = getSavedDecks();
  if (!selectedDeckName || !decks[selectedDeckName]) { alert('Select a deck above first.'); return; }
  isSolo = false;
  document.getElementById('room-info').textContent = 'Connecting to server (may take a minute if it was asleep)...';
  openSeat(0, { type: 'create', name: myName() });
});
document.getElementById('btn-join-room').addEventListener('click', () => {
  const decks = getSavedDecks();
  if (!selectedDeckName || !decks[selectedDeckName]) { alert('Select a deck above first.'); return; }
  isSolo = false;
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) return;
  document.getElementById('room-info').textContent = 'Connecting to server (may take a minute if it was asleep)...';
  openSeat(0, { type: 'join', room: code, name: myName() });
});
document.getElementById('btn-practice').addEventListener('click', () => {
  const decks = getSavedDecks();
  if (!selectedDeckName || !decks[selectedDeckName]) { alert('Select a deck above first.'); return; }
  practiceDeck = decks[selectedDeckName]; isSolo = true;
  document.getElementById('room-info').textContent = 'Starting practice game...';
  openSeat(0, { type: 'create', name: myName() });
});
function respondToJoin(accept) {
  document.getElementById('join-request-banner').style.display = 'none';
  document.getElementById('table-join-banner').style.display = 'none';
  sendOnSeat(0, { type: 'respondJoin', accept });
}
document.getElementById('btn-accept-join').addEventListener('click', () => respondToJoin(true));
document.getElementById('btn-decline-join').addEventListener('click', () => respondToJoin(false));
document.getElementById('btn-table-accept-join').addEventListener('click', () => respondToJoin(true));
document.getElementById('btn-table-decline-join').addEventListener('click', () => respondToJoin(false));

function handleSeatMessage(seatIndex, msg) {
  const seat = seats[seatIndex];
  if (msg.type === 'error') { alert(msg.message); return; }

  if (msg.type === 'joined') {
    seat.idx = msg.you; seat.roomCode = msg.room;
    if (seatIndex === 0) {
      const youLabel = myName() ? (myName() + ' (Player ' + (msg.you + 1) + ')') : ('Player ' + (msg.you + 1));
      document.getElementById('room-info').textContent =
        'Room code: ' + msg.room + '  (share this with your opponent) — you are ' + youLabel +
        ' — using deck "' + (isSolo ? (selectedDeckName || 'Practice') : selectedDeckName) + '"';
      // also show it on the table itself — the setup screen disappears as soon as you're dealt in
      if (!isSolo) {
        const rc = document.getElementById('table-room-code');
        rc.innerHTML = 'Room code — share with your opponent:<span class="code">' + msg.room + '</span>';
        rc.style.display = 'block';
      }
      const decks = getSavedDecks();
      const deckToUse = isSolo ? practiceDeck : decks[selectedDeckName];
      if (deckToUse) sendOnSeat(0, { type: 'submitDeck', deck: deckToUse });
      if (isSolo) { openSeat(1, { type: 'join', room: msg.room }); }
    } else if (isSolo) { sendOnSeat(1, { type: 'submitDeck', deck: practiceDeck }); showSeatSwitcher(); }
    return;
  }
  if (msg.type === 'joinRequest') {
    if (isSolo) sendOnSeat(0, { type: 'respondJoin', accept: true });
    else {
      const text = (msg.name || 'Someone') + ' wants to join your game.';
      // show on BOTH the setup screen and the table — the host is usually already at the table by now
      document.getElementById('join-request-text').textContent = text;
      document.getElementById('join-request-banner').style.display = 'flex';
      document.getElementById('table-join-text').textContent = text;
      document.getElementById('table-join-banner').style.display = 'flex';
      appendLog(text);
    }
    return;
  }
  if (msg.type === 'joinPending') { document.getElementById('room-info').textContent = 'Waiting for the host to accept your join request...'; return; }
  if (msg.type === 'joinDeclined') { document.getElementById('room-info').textContent = 'The host declined your join request.'; return; }
  if (msg.type === 'flash') {
    const el = document.querySelector(`[data-key="${msg.key}"]`);
    if (el) { el.classList.remove('flash-red'); void el.offsetWidth; el.classList.add('flash-red'); }
    return;
  }
  if (msg.type === 'log') {
    if (seatIndex === activeSeat) appendLog(msg.text, msg.fromIdx);
    return;
  }
  if (msg.type === 'chat') {
    if (seatIndex === activeSeat) {
      appendChatMessage(msg.from, msg.text, msg.fromIdx);
      const soundMap = seat.state && seat.state.soundMap;
      playChatTone(msg.fromIdx, soundMap);
    }
    return;
  }
  if (msg.type === 'sfx') {
    if (seatIndex === activeSeat) playSfx(msg.name);
    return;
  }
  if (msg.type === 'summonRejected') {
    if (seatIndex === activeSeat) alert(msg.reason);
    return;
  }
  if (msg.type === 'searchDeckOffer') {
    if (seatIndex === activeSeat) openSearchModal(msg.cards);
    return;
  }
  if (msg.type === 'shieldTriggerOffer') {
    if (seatIndex === activeSeat) openShieldTriggerModal(msg.key, msg.id);
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
function switchSeat(seatIndex) {
  activeSeat = seatIndex;
  clearSelection();
  lastActiveTurn = null; // avoid a spurious "it's your turn" pulse just from switching view
  if (seats[seatIndex].state) renderState(seats[seatIndex].state);
}

function appendLog(text, fromIdx) {
  const log = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = text;
  if (fromIdx === 0 || fromIdx === 1) line.className = 'log-line player-' + fromIdx;
  // make out-of-turn actions stand out when scanning back through the log
  if (text.indexOf('OUT OF TURN') !== -1) line.className += ' log-flagged';
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ====================== Sound effects ======================
// Drop your two chosen message tones at public/sounds/chat-tone-1.mp3 and
// chat-tone-2.mp3, and a Shield Trigger sound at public/sounds/shield-trigger.mp3.
// Missing files just fail silently — nothing breaks if they're not there yet.
const CHAT_TONE_FILES = ['sounds/chat-tone-1.mp3', 'sounds/chat-tone-2.mp3'];
const SFX_FILES = {
  shieldTrigger: 'sounds/shield-trigger.mp3',
  draw: 'sounds/draw-card.mp3',
  turn: 'sounds/turn-change.mp3'
};
function playSound(path) {
  try {
    const audio = new Audio(path);
    audio.volume = 0.55;
    audio.play().catch(() => {});
  } catch (e) { /* ignore */ }
}
function playChatTone(fromIdx, soundMap) {
  const toneIndex = (soundMap && soundMap[fromIdx] != null) ? soundMap[fromIdx] : fromIdx;
  playSound(CHAT_TONE_FILES[toneIndex] || CHAT_TONE_FILES[0]);
}
function playSfx(name) {
  const path = SFX_FILES[name];
  if (path) playSound(path);
}

// ====================== Chat ======================
function appendChatMessage(from, text, fromIdx) {
  const box = document.getElementById('chat-messages');
  const line = document.createElement('div');
  const colorClass = (fromIdx === 0 || fromIdx === 1) ? ('player-' + fromIdx) : '';
  line.className = 'chat-line' + (colorClass ? ' ' + colorClass : '');
  const fromSpan = document.createElement('span');
  fromSpan.className = 'chat-from' + (colorClass ? ' ' + colorClass : '');
  fromSpan.textContent = from + ': ';
  line.appendChild(fromSpan);
  line.appendChild(document.createTextNode(text));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  sendMsg({ type: 'chatMessage', text });
  input.value = '';
}
document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

const EMOJI_LIST = ['😀','😂','😅','😉','😊','😍','😎','🤔','😮','😢','😡','👍','👎','👏','🙏','💪','🔥','⭐','🎉','🎲','⚔️','🛡️','💀','🐉','⚡','💧','🌿','☀️','🌑','🃏'];
const emojiPicker = document.getElementById('emoji-picker');
EMOJI_LIST.forEach(em => {
  const span = document.createElement('span');
  span.textContent = em;
  span.addEventListener('click', () => {
    const input = document.getElementById('chat-input');
    input.value += em;
    input.focus();
    emojiPicker.style.display = 'none';
  });
  emojiPicker.appendChild(span);
});
document.getElementById('btn-emoji-picker').addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.style.display = emojiPicker.style.display === 'grid' ? 'none' : 'grid';
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.emoji-wrap')) emojiPicker.style.display = 'none';
});

function ensureTableVisible() {
  if (document.getElementById('screen-table').style.display !== 'flex') {
    document.getElementById('screen-setup').style.display = 'none';
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
let menuAnchorEl = null;
let menuAnchorRevertFn = null;

function showContextMenu(x, y, items, anchorEl, revertFn) {
  hideContextMenu(); // clean up any previously-focused card first
  menuAnchorEl = anchorEl || null;
  menuAnchorRevertFn = revertFn || null;
  if (menuAnchorEl) menuAnchorEl.classList.add('menu-open');

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
function hideContextMenu() {
  document.getElementById('context-menu').style.display = 'none';
  if (menuAnchorEl) {
    menuAnchorEl.classList.remove('menu-open');
    if (menuAnchorRevertFn) menuAnchorRevertFn();
  }
  menuAnchorEl = null;
  menuAnchorRevertFn = null;
}
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
function graveyardMenuItems(key) {
  return [
    ['Return to Hand', () => sendMsg({ type: 'gyReturnToHand', key })],
    ['Return to Deck & Shuffle', () => sendMsg({ type: 'gyReturnToDeckShuffle', key })],
    ['Return to Battlefield', () => sendMsg({ type: 'gyReturnToBattlefield', key })]
  ];
}

function openGyModal(title, cards, ownerIdx, isMine) {
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
    if (isMine) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, graveyardMenuItems(item.key), div);
      });
    }
    grid.appendChild(div);
  });
  document.getElementById('gy-modal').style.display = 'flex';
}
document.getElementById('gy-modal-close').addEventListener('click', () => { document.getElementById('gy-modal').style.display = 'none'; });

function openSearchModal(cards) {
  const grid = document.getElementById('search-modal-grid');
  grid.innerHTML = '';
  cards.forEach((id, index) => {
    const div = document.createElement('div');
    div.className = 'card-thumb';
    div.innerHTML = cardImgHtml(id);
    makeMagnifiable(div, id);
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        ['Return to Hand', () => {
          sendMsg({ type: 'searchDeckPick', index });
          document.getElementById('search-modal').style.display = 'none';
        }]
      ], div);
    });
    grid.appendChild(div);
  });
  document.getElementById('search-modal').style.display = 'flex';
}
document.getElementById('search-modal-close').addEventListener('click', () => {
  document.getElementById('search-modal').style.display = 'none';
  sendMsg({ type: 'searchDeckCancel' });
});

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
document.getElementById('btn-accept-surrender').addEventListener('click', () => sendMsg({ type: 'acceptSurrender' }));
document.getElementById('btn-rematch').addEventListener('click', () => {
  sendMsg({ type: 'rematchVote' });
  document.getElementById('rematch-status').textContent = 'Waiting for opponent to accept rematch...';
});
document.getElementById('btn-quit').addEventListener('click', () => {
  // return to the lobby without a page reload, so the loaded card images survive
  seats.forEach(s => { try { if (s.ws) s.ws.close(); } catch (e) {} s.ws = null; s.idx = null; s.state = null; });
  activeSeat = 0; isSolo = false; lastActiveTurn = null;
  document.getElementById('game-over-modal').style.display = 'none';
  document.getElementById('end-game-request-modal').style.display = 'none';
  document.getElementById('surrender-accept-modal').style.display = 'none';
  document.getElementById('table-room-code').style.display = 'none';
  document.getElementById('table-join-banner').style.display = 'none';
  const sw = document.getElementById('seat-switcher');
  if (sw) sw.remove();
  document.getElementById('log').innerHTML = '';
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('screen-table').style.display = 'none';
  document.getElementById('screen-setup').style.display = 'block';
  document.getElementById('room-info').textContent = '';
  document.getElementById('join-request-banner').style.display = 'none';
});
document.getElementById('btn-stop-showing').addEventListener('click', () => sendMsg({ type: 'setShowingHand', show: false }));
document.getElementById('btn-skip-corile').addEventListener('click', () => sendMsg({ type: 'corileSkip' }));
document.getElementById('btn-end-turn').addEventListener('click', () => sendMsg({ type: 'endTurn' }));

// ====================== Shield Trigger prompt ======================
let shieldTriggerQueue = [];
let shieldTriggerPendingKey = null;
function openShieldTriggerModal(key, id) {
  shieldTriggerQueue.push({ key, id });
  if (!shieldTriggerPendingKey) processNextShieldTrigger();
}
function processNextShieldTrigger() {
  if (!shieldTriggerQueue.length) { shieldTriggerPendingKey = null; return; }
  const next = shieldTriggerQueue.shift();
  shieldTriggerPendingKey = next.key;
  document.getElementById('shield-trigger-preview').innerHTML = cardImgHtml(next.id);
  document.getElementById('shield-trigger-modal').style.display = 'flex';
}
document.getElementById('btn-shield-trigger-yes').addEventListener('click', () => {
  if (shieldTriggerPendingKey) sendMsg({ type: 'castFreeFromHand', key: shieldTriggerPendingKey });
  document.getElementById('shield-trigger-modal').style.display = 'none';
  processNextShieldTrigger();
});
document.getElementById('btn-shield-trigger-no').addEventListener('click', () => {
  document.getElementById('shield-trigger-modal').style.display = 'none';
  processNextShieldTrigger();
});

// ====================== Table rendering ======================
function renderState(state) {
  const meIdx = state.you;
  const oppIdx = meIdx === 0 ? 1 : 0;
  const me = state.players[meIdx];
  const opp = state.players[oppIdx];

  if (!state.dealt[meIdx]) {
    document.getElementById('room-info').textContent = 'Submitting your deck and dealing your hand...';
    return;
  }
  ensureTableVisible();

  // ---- end game / surrender / game over modals ----
  document.getElementById('end-game-request-modal').style.display =
    (state.endGameRequestBy !== null && state.endGameRequestBy !== meIdx) ? 'flex' : 'none';
  document.getElementById('surrender-accept-modal').style.display =
    (state.surrenderBy !== null && state.surrenderBy !== meIdx) ? 'flex' : 'none';
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
    const enlargeHand = () => { el.classList.add('hand-hover'); el.style.transform = 'rotate(0deg) translateY(-46px) scale(1.7)'; };
    const restoreHand = () => { el.classList.remove('hand-hover'); el.style.transform = restTransform; };
    el.addEventListener('mouseenter', enlargeHand);
    el.addEventListener('mouseleave', () => { if (menuAnchorEl === el) return; restoreHand(); });
    makeMagnifiable(el, c.id);
    attachFlashClick(el, 'hand', meIdx, c.key);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      enlargeHand();
      const items = [
        ['Charge Mana', () => sendMsg({ type: 'chargeMana', key: c.key })],
        ['Summon', () => sendMsg({ type: 'summonCard', key: c.key })],
        ['Discard', () => sendMsg({ type: 'discardFromHand', key: c.key })],
        [me.showingHand ? 'Stop Showing Hand to Opponent' : 'Show Hand to Opponent', () => sendMsg({ type: 'setShowingHand', show: !me.showingHand })],
        ['Return Card to Deck & Shuffle', () => sendMsg({ type: 'handCardToDeckShuffle', key: c.key })]
      ];
      showContextMenu(e.clientX, e.clientY, items, el, restoreHand);
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
  const pendingCorileUses = me.pendingCorileUses || 0;
  renderBattleHalf('my-battle', me.battlezone, true, meIdx, pendingCorileUses);
  renderBattleHalf('opp-battle', opp.battlezone, false, oppIdx, pendingCorileUses);
  const canSearch = me.battlezone.some(c => cardBaseName(c.id).toLowerCase() === 'crystal memory');
  renderDeckZone('my-deck', me.deckCount, true, canSearch, me.pendingSkyswordMana || 0, me.pendingSkyswordShield || 0, me.pendingBronzeArm || 0);
  renderDeckZone('opp-deck', opp.deckCount, false, false, 0, 0, 0);
  renderGyZone('my-gy', me.graveyard, true, meIdx);
  renderGyZone('opp-gy', opp.graveyard, false, oppIdx);

  // ---- Corile banner ----
  const corileBanner = document.getElementById('corile-banner');
  if (pendingCorileUses > 0) {
    document.getElementById('corile-banner-text').textContent =
      'Corile triggered (' + pendingCorileUses + ') — right-click an opponent\'s creature to put it on top of their deck.';
    corileBanner.style.display = 'flex';
  } else {
    corileBanner.style.display = 'none';
  }

  const ti = document.getElementById('turn-indicator');
  const oppLabel = (state.names && state.names[oppIdx]) ? state.names[oppIdx] : 'your opponent';
  ti.textContent = state.dealt[oppIdx] ? ('Free play with ' + oppLabel + ' — act anytime') : 'Waiting for opponent to join & deal in...';
  // once the opponent is actually in, the room code is no longer useful
  if (state.dealt[oppIdx]) document.getElementById('table-room-code').style.display = 'none';

  // ---- advisory turn banner ----
  const banner = document.getElementById('turn-banner');
  const endTurnBtn = document.getElementById('btn-end-turn');
  // highlight whichever side of the table is the active player
  const mySide = ['my-hand', 'my-mana', 'my-battle', 'my-shields'];
  const oppSide = ['opp-hand', 'opp-mana', 'opp-battle', 'opp-shields'];
  const setSide = (ids, on) => ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active-side', on);
  });
  if (state.activeTurn === null || state.activeTurn === undefined) {
    banner.style.display = 'none';
    endTurnBtn.style.display = state.dealt[oppIdx] ? 'block' : 'none';
    setSide(mySide, false); setSide(oppSide, false);
  } else {
    const isMine = state.activeTurn === meIdx;
    banner.textContent = isMine ? 'Your turn' : (oppLabel + "'s turn");
    banner.className = 'turn-banner ' + (isMine ? 'mine' : 'theirs');
    banner.style.display = 'block';
    setSide(mySide, isMine); setSide(oppSide, !isMine);
    // only offer "end my turn" when it's actually your turn
    endTurnBtn.style.display = isMine ? 'block' : 'none';
    if (isMine && lastActiveTurn !== null && lastActiveTurn !== meIdx) {
      banner.classList.add('just-changed');
      setTimeout(() => banner.classList.remove('just-changed'), 3000);
    }
  }
  lastActiveTurn = (state.activeTurn === undefined) ? null : state.activeTurn;
  ti.className = 'turn-indicator' + (state.dealt[oppIdx] ? ' my-turn' : '');

  applySelectionClasses();
  window.__lastMe = me; window.__lastOpp = opp;
}

function renderManaZone(elId, mana, isMine, ownerIdx) {
  const container = document.getElementById(elId);
  container.innerHTML = '';
  mana.forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.dataset.key = c.key;
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);

    const xPct0 = (c.x != null) ? c.x : 3;
    const yPct0 = (c.y != null) ? c.y : 4;
    div.style.left = xPct0 + '%';
    div.style.top = yPct0 + '%';

    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!isMine) return;
      if (selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(c.key)) {
        const targetTapped = !c.tapped; // the action matches whatever this specific card needs
        const tapLabel = targetTapped ? 'Tap Selected' : 'Untap Selected';
        showContextMenu(e.clientX, e.clientY, [
          [tapLabel, () => {
            selectedKeys.forEach(k => {
              const card = mana.find(m => m.key === k);
              if (card && card.tapped !== targetTapped) sendMsg({ type: 'manaTap', key: k });
            });
            clearSelection();
          }],
          ['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaReturnToHand', key: k })); clearSelection(); }],
          ['Destroy Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaDestroy', key: k })); clearSelection(); }],
          ['Put Selected Back in Deck & Shuffle', () => { selectedKeys.forEach(k => sendMsg({ type: 'manaToDeckShuffle', key: k })); clearSelection(); }]
        ], div);
      } else {
        clearSelection();
        showContextMenu(e.clientX, e.clientY, [
          [c.tapped ? 'Untap' : 'Tap', () => sendMsg({ type: 'manaTap', key: c.key })],
          ['Return to Hand', () => sendMsg({ type: 'manaReturnToHand', key: c.key })],
          ['Destroy', () => sendMsg({ type: 'manaDestroy', key: c.key })],
          ['Put Back in Deck & Shuffle', () => sendMsg({ type: 'manaToDeckShuffle', key: c.key })]
        ], div);
      }
    });

    if (isMine) {
      div.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendMsg({ type: 'flash', zone: 'mana', ownerIdx, key: c.key }); return; }
        e.preventDefault();
        e.stopPropagation();
        const cr = container.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const origXPct = xPct0, origYPct = yPct0;
        let moved = false;
        let finalXPct = origXPct, finalYPct = origYPct;
        function onMove(ev) {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
          if (moved) {
            div.classList.add('dragging');
            finalXPct = Math.max(0, Math.min(92, origXPct + (dx / cr.width) * 100));
            finalYPct = Math.max(0, Math.min(15, origYPct + (dy / cr.height) * 100));
            div.style.left = finalXPct + '%';
            div.style.top = finalYPct + '%';
          }
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          div.classList.remove('dragging');
          if (moved) sendMsg({ type: 'manaMove', key: c.key, x: finalXPct, y: finalYPct });
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    } else {
      attachFlashClick(div, 'mana', ownerIdx, c.key);
    }
    container.appendChild(div);
  });
}

function renderShieldZone(elId, shields, isMine, ownerIdx) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  // Shields sit at fixed slots so a broken shield leaves its gap behind.
  // Width is sized to the highest slot in use, and the row stays centred.
  const maxSlot = shields.reduce((m, s) => Math.max(m, (s.slot != null ? s.slot : 0)), 0);
  const slotCount = Math.max(6, maxSlot + 1);
  const track = document.createElement('div');
  track.className = 'shield-track';
  track.style.width = 'calc((var(--card-w) + 8px) * ' + slotCount + ')';
  el.appendChild(track);

  shields.forEach((s, i) => {
    const slot = (s.slot != null) ? s.slot : i;
    const div = document.createElement('div');
    const faceUp = !!s.faceUp;
    div.className = 'card' + (faceUp ? '' : ' face-down');
    div.dataset.key = s.key;
    div.style.left = 'calc((var(--card-w) + 8px) * ' + slot + ')';
    div.innerHTML = faceUp ? cardImgHtml(s.id) : faceDownHtml();
    if (faceUp) makeMagnifiable(div, s.id);
    attachFlashClick(div, 'shield', ownerIdx, s.key);
    if (isMine) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(s.key)) {
          showContextMenu(e.clientX, e.clientY, [
            ['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'shieldReturnToHand', key: k })); clearSelection(); }],
            ['Put Selected in Graveyard', () => { selectedKeys.forEach(k => sendMsg({ type: 'shieldToGraveyard', key: k })); clearSelection(); }],
            ['Flip Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'shieldFlip', key: k })); clearSelection(); }]
          ], div);
        } else {
          clearSelection();
          const items = [['Return to Hand', () => sendMsg({ type: 'shieldReturnToHand', key: s.key })],
                          ['Put in Graveyard', () => sendMsg({ type: 'shieldToGraveyard', key: s.key })],
                          [faceUp ? 'Unflip' : 'Flip Card', () => sendMsg({ type: 'shieldFlip', key: s.key })]];
          showContextMenu(e.clientX, e.clientY, items, div);
        }
      });
    }
    track.appendChild(div);
  });
}

function renderBattleHalf(elId, cards, isMine, ownerIdx, pendingCorileUses) {
  const container = document.getElementById(elId);
  container.innerHTML = '';

  cards.forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.dataset.key = c.key;
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);

    const xPct0 = (c.x != null) ? c.x : 4;
    const yPct0 = Math.max(0, Math.min(22, (c.y != null) ? c.y : 4));
    // y = "distance from the owner's own base", same meaning for both players.
    // Anchor from the edge that IS that player's base so the card body always
    // grows inward (toward the divider) instead of spilling out of the zone:
    // my half's base is its bottom edge, the opponent's is their top edge.
    div.style.left = xPct0 + '%';
    if (isMine) { div.style.bottom = yPct0 + '%'; div.style.top = 'auto'; }
    else { div.style.top = yPct0 + '%'; div.style.bottom = 'auto'; }

    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(c.key)) {
        const targetTapped = !c.tapped;
        const tapLabel = targetTapped ? 'Tap Selected' : 'Untap Selected';
        const batch = [[tapLabel, () => {
          selectedKeys.forEach(k => {
            const card = cards.find(cc => cc.key === k);
            if (card && card.tapped !== targetTapped) sendMsg({ type: 'battleTap', key: k });
          });
          clearSelection();
        }]];
        if (isMine) {
          batch.push(['Destroy Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleDestroy', key: k })); clearSelection(); }]);
          batch.push(['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleReturn', key: k })); clearSelection(); }]);
        }
        showContextMenu(e.clientX, e.clientY, batch, div);
        return;
      }
      clearSelection();
      // tap/untap is allowed on any creature — some cards let you tap an opponent's creature
      const items = [[c.tapped ? 'Untap' : 'Tap', () => sendMsg({ type: 'battleTap', key: c.key })]];
      if (isMine) {
        items.push(['Destroy', () => sendMsg({ type: 'battleDestroy', key: c.key })]);
        items.push(['Return to Hand', () => sendMsg({ type: 'battleReturn', key: c.key })]);
      } else if (pendingCorileUses > 0) {
        items.push(["Put on Top of Opponent's Deck (Corile)", () => sendMsg({ type: 'corilePutOnDeck', key: c.key })]);
      }
      showContextMenu(e.clientX, e.clientY, items, div);
    });

    if (isMine) {
      div.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendMsg({ type: 'flash', zone: 'battlezone', ownerIdx, key: c.key }); return; }
        e.preventDefault();
        e.stopPropagation();
        const cr = container.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const origXPct = xPct0, origYPct = yPct0;
        let moved = false;
        let finalXPct = origXPct, finalYPct = origYPct;
        function onMove(ev) {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
          if (moved) {
            div.classList.add('dragging');
            finalXPct = Math.max(0, Math.min(92, origXPct + (dx / cr.width) * 100));
            // anchored from my base (bottom edge), so dragging down = smaller y
            finalYPct = Math.max(0, Math.min(22, origYPct - (dy / cr.height) * 100));
            div.style.left = finalXPct + '%';
            div.style.bottom = finalYPct + '%';
          }
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          div.classList.remove('dragging');
          if (moved) sendMsg({ type: 'battleMove', key: c.key, x: finalXPct, y: finalYPct });
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

function renderDeckZone(elId, count, isMine, canSearch, pendingSkyswordMana, pendingSkyswordShield, pendingBronzeArm) {
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
    const items = [
      ['Draw a Card', () => {
        // Off-turn draws are legitimate (shield triggers, forced draws) — just confirm
        // so an accidental misclick during the opponent's turn doesn't slip through.
        if (isOffTurnForMe()) {
          if (!confirm("It's not your turn. Draw anyway?\n\n(Legitimate for shield triggers and forced draws — this will be flagged in the move log.)")) return;
        }
        sendMsg({ type: 'drawCard' });
      }],
      ['Shuffle Deck', () => sendMsg({ type: 'shuffleDeck' })]
    ];
    if (canSearch) items.push(['Search Deck', () => sendMsg({ type: 'requestSearchDeck' })]);
    if (pendingSkyswordMana > 0) items.push(['Put in Mana Zone (Skysword)', () => sendMsg({ type: 'skyswordToMana' })]);
    else if (pendingSkyswordShield > 0) items.push(['Put in Shield Zone (Skysword)', () => sendMsg({ type: 'skyswordToShield' })]);
    if (pendingBronzeArm > 0) items.push(['Add to Mana Zone (Bronze-Arm Tribe)', () => sendMsg({ type: 'bronzeArmToMana' })]);
    showContextMenu(e.clientX, e.clientY, items, card);
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
    if (isMine) {
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, graveyardMenuItems(top.key), card);
      });
    }
    el.appendChild(card);
    const badge = document.createElement('div');
    badge.className = 'stack-count';
    badge.textContent = cards.length;
    el.appendChild(badge);
  }
  el.onclick = () => openGyModal(isMine ? 'Your Graveyard' : 'Opponent Graveyard', cards, ownerIdx, isMine);
}
