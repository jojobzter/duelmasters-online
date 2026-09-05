// ====================== Card image loading ======================

// The "my decks" subfolder, kept from the scan so saving a deck can write a .txt
// back into it. Null when the browser has no File System Access API, or when the
// cards folder was picked with the older <input webkitdirectory> fallback.
let myDecksDirHandle = null;

// Cross Gear crossing state — declared up here because the selection resolver reads
// it far earlier in the file, and a `let` below its first use throws at load.
let crossingGearKey = null;
// The manual draw and mana charge are once per turn. The label says so rather than
// letting the click be refused, and a second click still sends it so a card effect
// the engine doesn't implement can be played by hand.
function manualUsed(what) {
  const st = seats[activeSeat] && seats[activeSeat].state;
  if (!st || st.activeTurn === null || st.activeTurn === undefined) return false;
  const me = st.players[st.you];
  return (what === 'draw' ? (me.manualDrawsThisTurn || 0) : (me.manualChargesThisTurn || 0)) >= 1;
}
// set when the server warns that a creature must attack; a second press overrides
let endTurnWarned = false;
// card names come from filenames, so escape before putting them in markup
function escapeHtml(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// Menu music state. Declared first: code further down runs at load time and reads
// these, and a `let` below its first use throws, taking every later handler with it.
const MENU_MUSIC_FILE = 'sounds/dark-angel.mp3';
const MENU_MUSIC_VOLUME = 0.32;
let menuMusic = null;
let menuMusicFade = null;
let menuMusicMuted = localStorage.getItem('dm_music_muted') === '1';
const SOUND_VOLUME = 0.55;
const SOUND_POOL_SIZE = 3;   // primed copies per sound, so overlapping plays still work
let cardDB = new Map();      // id ("DM-1/Name.png") -> {url, name, set}
let cardBackUrl = null;      // from a "card back" folder, if present
const IMG_EXT = /\.(png|jpg|jpeg|webp|gif)$/i;
// Old decks may hold ids captured before a file was renamed; map them onto whatever
// file is actually loaded now so saved decks keep working.
function healDeckIds(ids) {
  return (ids || []).map(id => resolveCardId(id) || id);
}
function stripExt(id) { return typeof id === 'string' ? id.replace(IMG_EXT, '') : id; }
function cardBaseName(id) { return id ? (id.split('/').pop() || id) : ''; }
// Filenames often can't hold an apostrophe, so it arrives as '_'. Normalising it here
// keeps both the display name and the ability lookup working.
function normKeyClient(name) {
  return (name || '').toLowerCase()
    .replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'")
    .replace(/_/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
// The card sheet holds the correct spelling; the filename is only a fallback.
function displayName(id) {
  const meta = cardMetaDB.get(normKeyClient(cardBaseName(id)));
  if (meta && meta.name) return meta.name;
  const c = lookupCard(id);
  return c ? c.name : cardBaseName(id);
}
const CARD_BACK_FOLDER = /^card ?back$/i;
const DECK_TXT = /\.txt$/i;
let deckFilesFound = [];   // {name, text} decklists discovered during the folder scan

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
  cardDB.clear(); cardBackUrl = null; invalidateCardGridCache();
  const statusEl = document.getElementById('load-status');
  progressStart(true);
  statusEl.textContent = 'Scanning folders...';
  const jobs = [];
  deckFilesFound = [];
  myDecksDirHandle = null;
  for await (const [setName, setHandle] of dirHandle.entries()) {
    if (setHandle.kind !== 'directory') continue;
    // remember this one so saved decks can be written back into it
    if (/^my\s*decks$/i.test(setName)) myDecksDirHandle = setHandle;
    for await (const [fileName, fileHandle] of setHandle.entries()) {
      if (fileHandle.kind !== 'file') continue;
      // a "my decks" folder of .txt decklists is picked up in the same pass
      if (DECK_TXT.test(fileName)) {
        try {
          const f = await fileHandle.getFile();
          deckFilesFound.push({ name: fileName.replace(DECK_TXT, ''), text: await f.text() });
        } catch (e) { /* ignore unreadable file */ }
        continue;
      }
      if (!IMG_EXT.test(fileName)) continue;
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
  cardDB.clear(); cardBackUrl = null; invalidateCardGridCache();
  const statusEl = document.getElementById('load-status');
  deckFilesFound = [];
  for (const f of files) {
    if (!DECK_TXT.test(f.name)) continue;
    try { deckFilesFound.push({ name: f.name.replace(DECK_TXT, ''), text: await f.text() }); }
    catch (e) { /* ignore */ }
  }
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
      rebuildCardIndex();
      const n = importFoundDecklists();
      statusEl.textContent = cardDB.size + ' cards loaded from "' + handle.name + '".' +
        (cardBackUrl ? ' Card back found.' : '') +
        (n ? '  ' + n + ' deck' + (n === 1 ? '' : 's') + ' loaded from your decks folder.' : '');
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
  rebuildCardIndex();
  const nDecks = importFoundDecklists();
  document.getElementById('load-status').textContent = cardDB.size + ' cards loaded.' +
    (cardBackUrl ? ' Card back found.' : '') +
    (nDecks ? '  ' + nDecks + ' deck' + (nDecks === 1 ? '' : 's') + ' loaded from your decks folder.' : '');
  refreshCardGrid();
});
document.getElementById('btn-load-folder').addEventListener('click', loadFolder);

// Browsers won't silently re-read local files after a page reload, but they WILL
// re-grant with a single confirmation click on a remembered folder — much less
// friction than re-navigating the whole folder picker every time.
let rememberedFolderHandle = null;

// Writes a deck out as a plain decklist, the same format the loader reads back.
// Best-effort: a failure never blocks the save, it just reports why.
async function writeDeckFile(name, cards) {
  if (!myDecksDirHandle) return { ok: false, why: 'no "my decks" folder in your cards folder' };
  try {
    if (myDecksDirHandle.queryPermission) {
      let perm = await myDecksDirHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await myDecksDirHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return { ok: false, why: 'write permission was declined' };
    }
    const counts = new Map();
    for (const id of cards) {
      const label = cardBaseName(id);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const body = [...counts.entries()].map(([n, c]) => c + 'x' + n).join('\n') + '\n';
    const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60) || 'deck';
    const fh = await myDecksDirHandle.getFileHandle(safe + '.txt', { create: true });
    const w = await fh.createWritable();
    await w.write(body);
    await w.close();
    return { ok: true, file: safe + '.txt' };
  } catch (e) {
    return { ok: false, why: (e && e.message) || 'the browser refused the write' };
  }
}

// Removes a deck's file when the deck itself is deleted, so the folder doesn't
// accumulate decks the player has thrown away.
async function deleteDeckFile(name) {
  if (!myDecksDirHandle) return;
  const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60) || 'deck';
  try { await myDecksDirHandle.removeEntry(safe + '.txt'); } catch (e) { /* never existed */ }
}
async function reloadRememberedFolder() {
  if (!rememberedFolderHandle) return;
  const statusEl = document.getElementById('load-status');
  try {
    const perm = await rememberedFolderHandle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') { statusEl.textContent = 'Permission denied — use "Choose cards folder" instead.'; return; }
    await scanDirHandle(rememberedFolderHandle);
    rebuildCardIndex();
    const nr = importFoundDecklists();
    statusEl.textContent = cardDB.size + ' cards loaded from "' + rememberedFolderHandle.name + '".' +
      (cardBackUrl ? ' Card back found.' : '') + (nr ? '  ' + nr + ' deck(s) loaded.' : '');
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
    rebuildCardIndex();
    const nd = importFoundDecklists();
    document.getElementById('load-status').textContent = cardDB.size + ' cards loaded from "' + handle.name + '" (remembered).' +
      (nd ? '  ' + nd + ' deck' + (nd === 1 ? '' : 's') + ' loaded.' : '');
    refreshCardGrid();
  } else {
    const btn = document.getElementById('btn-reload-folder');
    btn.textContent = 'Reload "' + handle.name + '"';
    btn.style.display = 'inline-block';
    document.getElementById('load-status').textContent = 'One click to reload your images.';
  }
})();

function faceDownHtml() { return cardBackUrl ? `<img src="${cardBackUrl}" alt="card back">` : ''; }
// Filenames can't hold an apostrophe, so the same card may be saved in a deck as
// "Cap_n" but sit on disk as "Cap'n" (or the reverse after a rename). Every image
// lookup goes through here so those still resolve to the right file.
const cardDBNorm = new Map();
function rebuildCardIndex() {
  cardDBNorm.clear();
  for (const key of cardDB.keys()) {
    const n = normKeyClient(key);
    if (!cardDBNorm.has(n)) cardDBNorm.set(n, key);
  }
}
function resolveCardId(id) {
  if (!id) return null;
  if (cardDB.has(id)) return id;
  return cardDBNorm.get(normKeyClient(id)) || null;
}
function lookupCard(id) {
  const real = resolveCardId(id);
  return real ? cardDB.get(real) : null;
}

function cardImgHtml(id) {
  const c = lookupCard(id);
  if (c) return `<img src="${c.url}" alt="${c.name}">`;
  return `<div class="placeholder-label">${id || '?'}</div>`;
}

// ====================== Deck builder ======================
let currentDeck = [];

// ---- Card metadata (civilization/type/cost), loaded from the server's parsed spreadsheet ----
let cardMetaDB = new Map(); // lowercase card name -> {name, cost, type, civs}
// the engine's published ability index, so the client can mirror rules like
// "this card can't be chosen by an opponent's effect" without hardcoding names
let EFFECT_INDEX = {};
// Fetched lazily: neither index is needed until a game starts, and on a cold Render
// instance these requests can take seconds — time better spent letting the menu paint.
function loadEffectIndex() {
  if (EFFECT_INDEX.__loading || Object.keys(EFFECT_INDEX).length) return;
  EFFECT_INDEX.__loading = true;
  fetch('/api/effects').then(r => r.json()).then(x => { EFFECT_INDEX = x || {}; }).catch(() => {});
}
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
      cardMetaDB.set(normKeyClient(c.name), c);
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
// warm the secondary indexes when the browser is idle, so they never block first paint
if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { loadEffectIndex(); loadRaceList(); });
else setTimeout(() => { loadEffectIndex(); loadRaceList(); }, 1500);

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

// The card browser can hold a few thousand cards, so this is the hottest thing on the
// setup screen. Five things keep it responsive:
//   1. images load lazily, so only what is on screen is decoded
//   2. deck counts come from one tally instead of a scan per card
//   3. the sorted id list and normalised names are cached, not recomputed
//   4. rows are built into a fragment and attached once
//   5. one delegated click handler instead of two listeners per card
let cardIdsSorted = null;          // invalidated when the library reloads
const normNameCache = new Map();

function invalidateCardGridCache() { cardIdsSorted = null; normNameCache.clear(); }

function normNameCached(name) {
  let v = normNameCache.get(name);
  if (v === undefined) { v = normKeyClient(name); normNameCache.set(name, v); }
  return v;
}

function refreshCardGrid() {
  const grid = document.getElementById('card-grid');
  const query = (document.getElementById('card-search').value || '').toLowerCase();
  if (!cardIdsSorted) cardIdsSorted = [...cardDB.keys()].sort();

  // one pass over the deck instead of a filter per card
  const deckCounts = new Map();
  for (const id of currentDeck) deckCounts.set(id, (deckCounts.get(id) || 0) + 1);

  const frag = document.createDocumentFragment();
  for (const id of cardIdsSorted) {
    const c = cardDB.get(id);
    if (query && !c.name.toLowerCase().includes(query) && !c.set.toLowerCase().includes(query)) continue;
    if (!cardPassesFilters(id)) continue;
    const meta = cardMetaDB.get(normNameCached(c.name));
    const div = document.createElement('div');
    div.className = 'card-thumb';
    div.dataset.cardId = id;
    const count = deckCounts.get(id) || 0;
    div.innerHTML = `<img src="${c.url}" title="${c.name}" loading="lazy" decoding="async">` +
      (count ? `<div class="count-badge">${count}</div>` : '') +
      (meta && meta.cost != null ? `<div class="cost-badge">${meta.cost}</div>` : '') +
      `<div class="zoom-btn" title="Preview">\u{1F50D}</div>` +
      `<div class="name">${c.name}</div>`;
    frag.appendChild(div);
  }
  grid.innerHTML = '';
  grid.appendChild(frag);
}

// One delegated handler for the whole grid, attached once, rather than two listeners
// per card on every rebuild.
document.getElementById('card-grid').addEventListener('click', (e) => {
  const thumb = e.target.closest('.card-thumb');
  if (!thumb) return;
  const id = thumb.dataset.cardId;
  if (!id) return;
  if (e.target.closest('.zoom-btn')) { e.stopPropagation(); openMagnify(id); return; }
  if (currentDeck.length >= 40) return;
  const name = (cardDB.get(id) || {}).name || id;
  if (currentDeck.filter(x => x === id).length >= 4) {
    alert('You can only have 4 copies of "' + name + '" in a deck.');
    return;
  }
  currentDeck.push(id);
  refreshCardGrid(); refreshDeckList();
});

// typing fires this on every keystroke, so coalesce to one rebuild per frame
let gridRedrawPending = false;
function refreshCardGridSoon() {
  if (gridRedrawPending) return;
  gridRedrawPending = true;
  requestAnimationFrame(() => { gridRedrawPending = false; refreshCardGrid(); });
}

document.getElementById('card-search').addEventListener('input', refreshCardGridSoon);

function refreshDeckList() {
  const list = document.getElementById('deck-list');
  list.innerHTML = '';
  const counts = new Map();
  for (const id of currentDeck) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, n] of [...counts.entries()].sort()) {
    const row = document.createElement('div');
    row.className = 'deck-list-item';
    row.innerHTML = `<span>${n}x ${displayName(id)}</span>`;
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
    div.innerHTML = cardImgHtml(id) + (n > 1 ? `<div class="count-badge">${n}</div>` : '') +
      `<div class="name">${displayName(id)}</div>`;
    makeMagnifiable(div, id);
    grid.appendChild(div);
  });
  document.getElementById('deck-view-modal').style.display = 'flex';
}
document.getElementById('deck-view-close').addEventListener('click', () => { document.getElementById('deck-view-modal').style.display = 'none'; });

function refreshSavedDecks() {
  setTimeout(refreshBotDeckSelect, 0);
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
    delBtn.addEventListener('click', async () => {
      delete decks[name]; setSavedDecks(decks);
      if (selectedDeckName === name) { selectedDeckName = null; localStorage.removeItem('dm_selected_deck'); }
      // remove its file too, or it would reappear the next time the folder is scanned
      await deleteDeckFile(name);
      refreshSavedDecks(); updateSelectedDeckDisplay();
    });
    row.appendChild(selectBtn); row.appendChild(loadBtn); row.appendChild(shareBtn); row.appendChild(delBtn);
    wrap.appendChild(row);
  }
  updateSelectedDeckDisplay();
}

document.getElementById('btn-save-deck').addEventListener('click', async () => {
  const name = (document.getElementById('deck-name').value || '').trim();
  if (!name) { alert('Name your deck first.'); return; }
  if (currentDeck.length !== 40) { if (!confirm('Deck has ' + currentDeck.length + ' cards, not 40. Save anyway?')) return; }
  const decks = getSavedDecks();
  decks[name] = currentDeck.slice();
  setSavedDecks(decks);
  // also write it into the "my decks" folder, so it survives clearing browser data
  // and can be shared as a plain file
  const written = await writeDeckFile(name, decks[name]);
  const status = document.getElementById('saved-decks-status');
  if (status) {
    status.textContent = written.ok
      ? 'Saved. Also written to my decks/' + written.file
      : 'Saved in this browser. Not written to a file — ' + written.why + '.';
    status.className = written.ok ? 'hint saved-ok' : 'hint';
  }
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
    const capped = enforceDeckRules(cards);
    currentDeck = capped.deck;
    document.getElementById('deck-name').value = name;
    refreshDeckList(); refreshCardGrid();
    document.getElementById('import-code').value = '';
    alert('Loaded "' + name + '" (' + currentDeck.length + ' cards) into the editor below. Click "Save Deck" to keep it — cards you don\'t have images for will just show as placeholders until you do.');
  } catch (e) {
    alert("That doesn't look like a valid share code.");
  }
});

// Deck rules in one place: at most 4 copies of a card NAME (not id — the same card
// can appear in several sets), and no more than 40 cards.
function enforceDeckRules(ids) {
  const counts = new Map();
  const out = [];
  const trimmed = [];
  for (const id of ids) {
    if (out.length >= 40) break;
    const nameKey = normKeyClient(displayName(id));
    const n = counts.get(nameKey) || 0;
    if (n >= 4) { if (!trimmed.includes(displayName(id))) trimmed.push(displayName(id)); continue; }
    counts.set(nameKey, n + 1);
    out.push(id);
  }
  return { deck: out, trimmed };
}

// A "my decks" file may hold either a share code or a plain decklist — work out which.
function deckFromFileText(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const looksLikeCode = !/\s/.test(t) && t.length > 24 && /^[A-Za-z0-9+/=]+$/.test(t);
  if (looksLikeCode) {
    try {
      const { name, cards } = decodeDeckCode(t);
      return { deck: enforceDeckRules(cards).deck, name };
    } catch (e) { /* fall through to plain-text parsing */ }
  }
  const { deck } = parseDecklist(t);
  return { deck, name: null };
}

// ---- decklists in plain text: "4xAqua Surfer", one per line ----
// Used by both the paste box and any .txt files found in a "my decks" folder.
function parseDecklist(raw) {
  const byName = new Map();
  for (const [id, c] of cardDB) {
    const k = normKeyClient(c.name);
    if (!byName.has(k)) byName.set(k, id);
  }
  const loose = t => normKeyClient(t).replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim();
  const looseMap = new Map();
  for (const [k, id] of byName) looseMap.set(loose(k), id);

  const deck = [], notFound = [], overLimit = [];
  for (let line of (raw || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.match(/^(\d+)\s*[xX*]?\s*(.+)$/);
    let count = 1, name = line;
    if (m) { count = parseInt(m[1], 10); name = m[2]; }
    name = name.trim();
    const id = byName.get(normKeyClient(name)) || looseMap.get(loose(name));
    if (!id) { notFound.push(name); continue; }
    if (count > 4) { overLimit.push(name); count = 4; }
    for (let i = 0; i < count && deck.length < 40; i++) deck.push(id);
  }
  const capped = enforceDeckRules(deck);
  capped.trimmed.forEach(n => { if (!overLimit.includes(n)) overLimit.push(n); });
  return { deck: capped.deck, notFound, overLimit };
}

// Decklists found alongside the card images are saved automatically, so there's
// nothing to paste or import by hand.
function importFoundDecklists() {
  if (!deckFilesFound.length || !cardDB.size) return 0;
  const decks = getSavedDecks();
  let added = 0;
  for (const f of deckFilesFound) {
    const parsed = deckFromFileText(f.text);
    if (!parsed || !parsed.deck.length) continue;
    // filename wins as the deck name; a share code's own name is the fallback
    decks[f.name || parsed.name || 'Imported deck'] = parsed.deck;
    added++;
  }
  if (added) { setSavedDecks(decks); refreshSavedDecks(); }
  return added;
}

document.getElementById('btn-build-from-text').addEventListener('click', () => {
  const raw = document.getElementById('decklist-text').value || '';
  const status = document.getElementById('decklist-status');
  if (!raw.trim()) { status.textContent = 'Paste a list first.'; return; }
  if (!cardDB.size) { status.textContent = 'Load your cards folder first.'; return; }
  // accept a share code pasted here too, so either format works
  const asCode = deckFromFileText(raw);
  if (asCode && asCode.name !== null && asCode.deck.length) {
    currentDeck = asCode.deck;
    if (asCode.name) document.getElementById('deck-name').value = asCode.name;
    refreshDeckList(); refreshCardGrid();
    status.textContent = asCode.deck.length + ' cards loaded from a share code.';
    return;
  }
  const { deck, notFound, overLimit } = parseDecklist(raw);
  currentDeck = deck;
  refreshDeckList(); refreshCardGrid();
  const bits = [deck.length + ' cards loaded into the editor'];
  if (overLimit.length) bits.push('capped at 4: ' + overLimit.join(', '));
  if (notFound.length) bits.push('not found: ' + notFound.join(', '));
  status.textContent = bits.join(' \u2014 ');
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
// ---- play against the computer ----
// Reuses the practice-mode plumbing: seat 0 is you, seat 1 is the bot. The bot gets
// its own connection and only ever sees its own hand, exactly like a remote opponent.
let isBotGame = false;
let botDeck = null;
function refreshBotDeckSelect() {
  const sel = document.getElementById('bot-deck-select');
  if (!sel) return;
  const decks = getSavedDecks();
  const names = Object.keys(decks);
  const prev = sel.value;
  sel.innerHTML = '';
  if (!names.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '(no saved decks)';
    sel.appendChild(o);
    return;
  }
  names.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n + ' (' + decks[n].length + ')';
    sel.appendChild(o);
  });
  if (prev && names.includes(prev)) sel.value = prev;
  else if (selectedDeckName && names.includes(selectedDeckName)) sel.value = selectedDeckName;
}
document.getElementById('btn-vs-computer').addEventListener('click', () => {
  const decks = getSavedDecks();
  if (!selectedDeckName || !decks[selectedDeckName]) { alert('Select your own deck above first.'); return; }
  const botName = document.getElementById('bot-deck-select').value;
  if (!botName || !decks[botName]) { alert("Choose a deck for the computer to play."); return; }
  practiceDeck = healDeckIds(decks[selectedDeckName]);
  botDeck = healDeckIds(decks[botName]);
  isSolo = true; isBotGame = true;
  document.getElementById('room-info').textContent = 'Starting game against the computer...';
  openSeat(0, { type: 'create', name: myName() });
});

// music toggle, remembered between sessions
function wireMusicToggle() {
  const btn = document.getElementById('btn-music');
  if (!btn) return;
  btn.textContent = menuMusicMuted ? 'Music: off' : 'Music: on';
  btn.classList.toggle('muted', menuMusicMuted);
  btn.addEventListener('click', (e) => { e.stopPropagation(); setMusicMuted(!menuMusicMuted); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMusicToggle);
else wireMusicToggle();

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

// One-shot prompts are addressed to a specific seat. In practice mode both seats live
// in this one browser, so a prompt for the seat you aren't currently viewing used to be
// dropped on the floor — that's why a shield trigger on "the opponent" never appeared.
// They're queued instead, and practice mode hops to that seat so you can answer.
const seatPromptQueue = [[], []];
function deliverPrompt(seatIndex, fn) {
  if (seatIndex === activeSeat) { fn(); return; }
  seatPromptQueue[seatIndex].push(fn);
  if (isSolo) {
    switchSeat(seatIndex);
    flushSeatPrompts(seatIndex);
  }
}
function flushSeatPrompts(seatIndex) {
  const q = seatPromptQueue[seatIndex];
  if (!q || !q.length) return;
  const pending = q.splice(0, q.length);
  // let the board repaint before a modal lands on top of it
  setTimeout(() => pending.forEach(fn => { try { fn(); } catch (e) {} }), 120);
}

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
      // heal ids first, so a deck saved before a file rename still finds its images
      const deckToUse = healDeckIds(isSolo ? practiceDeck : decks[selectedDeckName]);
      if (deckToUse && deckToUse.length) sendOnSeat(0, { type: 'submitDeck', deck: deckToUse });
      if (isSolo) { openSeat(1, { type: 'join', room: msg.room, name: isBotGame ? 'Computer' : undefined }); }
    } else if (isSolo) {
      const seatDeck = isBotGame ? botDeck : practiceDeck;
      sendOnSeat(1, { type: 'submitDeck', deck: healDeckIds(seatDeck) });
      if (isBotGame) {
        Bot.start({ seatIdx: 1, deck: botDeck, send: (m) => sendOnSeat(1, m) });
      } else {
        showSeatSwitcher();
      }
    }
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
  if (msg.type === 'notice') {
    if (seatIndex === activeSeat) showNotice(msg.text);
    return;
  }
  if (msg.type === 'sfx') {
    if (seatIndex === activeSeat) playSfx(msg.name);
    return;
  }
  if (msg.type === 'summonRejected') {
    if (isBotGame && seatIndex === 1) { Bot.onRejected(); return; }
    // If a free cast was refused, the trigger can't be used — decline it rather than
    // leaving the prompt pending, which would block the opponent too.
    if (/must attack if it is able/.test(msg.reason || '')) endTurnWarned = true;
    if (shieldTriggerPendingKey) {
      sendMsg({ type: 'shieldTriggerDecline', key: shieldTriggerPendingKey });
      const m = document.getElementById('shield-trigger-modal');
      if (m) m.style.display = 'none';
      shieldTriggerPendingKey = null;
      deliverPrompt(seatIndex, () => alert(msg.reason));
      processNextShieldTrigger();
      return;
    }
    deliverPrompt(seatIndex, () => alert(msg.reason));
    return;
  }
  if (msg.type === 'searchDeckOffer') {
    if (isBotGame && seatIndex === 1) {
      // take the first legal option the server offered
      const pick = (msg.cards || [])[0];
      if (pick) setTimeout(() => sendOnSeat(1, { type: 'searchDeckPick', index: pick.index }), 600);
      else setTimeout(() => sendOnSeat(1, { type: 'searchDeckCancel' }), 400);
      return;
    }
    deliverPrompt(seatIndex, () => openSearchModal(msg.cards, msg.filter, msg.source, msg.costEquals));
    return;
  }
  if (msg.type === 'revealCards') {
    if (isBotGame && seatIndex === 1) { return; }
    deliverPrompt(seatIndex, () => openRevealModal(msg.title, msg.cards));
    return;
  }
  if (msg.type === 'manualBattle') {
    if (isBotGame && seatIndex === 1) { return; }   // the human decides these
    deliverPrompt(seatIndex, () => openManualBattle(msg.battle));
    return;
  }
  if (msg.type === 'tapModeOffer') {
    if (isBotGame && seatIndex === 1) { Bot.onTapMode(msg.key); return; }
    deliverPrompt(seatIndex, () => openTapModeModal(msg.key, msg.name));
    return;
  }
  if (msg.type === 'endTurnPrompt') {
    if (isBotGame && seatIndex === 1) { return; }
    deliverPrompt(seatIndex, () => openEndTurnPrompt(msg.key, msg.name, msg.kind));
    return;
  }
  if (msg.type === 'shieldTriggerOffer') {
    if (isBotGame && seatIndex === 1) { Bot.onShieldTrigger(msg.key); return; }
    deliverPrompt(seatIndex, () => openShieldTriggerModal(msg.key, msg.id));
    return;
  }
  if (msg.type === 'state') {
    seat.state = msg.state;
    if (isBotGame && seatIndex === 1) { Bot.onState(msg.state); return; }
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
  flushSeatPrompts(seatIndex);
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
  turn: 'sounds/turn-change.mp3',
  ballom: 'sounds/ballom.mp3'
};
// Mobile browsers refuse to play audio that wasn't started by a user gesture, and a
// sound triggered by an incoming network message doesn't count as one. So every clip
// is primed (loaded and unlocked) on the player's first tap, then replayed from cache.
const audioCache = {};
let audioUnlocked = false;

function allSoundPaths() { return CHAT_TONE_FILES.concat(Object.values(SFX_FILES)); }


// ---------------------------------------------------------------------------
// Menu music.
//
// Loops quietly on the setup screen and fades out when the table opens, so it never
// plays over a game. Browsers block autoplay until the person interacts with the
// page, so it starts on the first tap/click/keypress rather than on load.
// ---------------------------------------------------------------------------


function startMenuMusic() {
  if (menuMusicMuted) return;
  if (menuMusic && !menuMusic.paused) return;
  try {
    if (!menuMusic) {
      menuMusic = new Audio(MENU_MUSIC_FILE);
      menuMusic.loop = true;
      menuMusic.preload = 'auto';
      // If the track isn't there, say so on the button rather than failing silently —
      // "no music" and "music file missing" look identical otherwise.
      menuMusic.addEventListener('error', () => {
        menuMusic = null;
        const btn = document.getElementById('btn-music');
        if (btn) { btn.textContent = 'Music: file missing'; btn.classList.add('muted'); btn.title = MENU_MUSIC_FILE + ' was not found'; }
        console.warn('Menu music not found at ' + MENU_MUSIC_FILE + ' — drop the file into public/sounds/.');
      }, { once: true });
    }
    if (menuMusicFade) { clearInterval(menuMusicFade); menuMusicFade = null; }
    menuMusic.volume = MENU_MUSIC_VOLUME;
    const p = menuMusic.play();
    if (p && p.catch) p.catch(() => { /* still blocked; the next interaction retries */ });
  } catch (e) { /* no music is not an error worth surfacing */ }
}

function fadeOutMenuMusic(ms) {
  if (!menuMusic || menuMusic.paused) return;
  if (menuMusicFade) clearInterval(menuMusicFade);
  const steps = 24;
  const step = menuMusic.volume / steps;
  const tick = Math.max(16, (ms || 1200) / steps);
  menuMusicFade = setInterval(() => {
    if (!menuMusic) { clearInterval(menuMusicFade); menuMusicFade = null; return; }
    const v = menuMusic.volume - step;
    if (v <= 0.01) {
      menuMusic.pause();
      menuMusic.currentTime = 0;
      menuMusic.volume = MENU_MUSIC_VOLUME;
      clearInterval(menuMusicFade);
      menuMusicFade = null;
    } else {
      menuMusic.volume = v;
    }
  }, tick);
}

function setMusicMuted(muted) {
  menuMusicMuted = muted;
  localStorage.setItem('dm_music_muted', muted ? '1' : '0');
  const btn = document.getElementById('btn-music');
  if (btn) {
    btn.textContent = muted ? 'Music: off' : 'Music: on';
    btn.classList.toggle('muted', muted);
  }
  if (muted) { if (menuMusic) { menuMusic.pause(); menuMusic.currentTime = 0; } }
  else if (document.getElementById('screen-setup').style.display !== 'none') startMenuMusic();
}

function unlockAudio() {
  // the music needs a gesture too, and this fires on every interaction rather than once
  if (document.getElementById('screen-setup') &&
      document.getElementById('screen-setup').style.display !== 'none') startMenuMusic();
  if (audioUnlocked) return;
  audioUnlocked = true;
  // Mobile browsers only allow an audio element to play if THAT element was started
  // during a user gesture. A clone counts as a different element and stays blocked,
  // so prime a small pool per sound here and replay those instead of cloning later.
  for (const path of allSoundPaths()) {
    const pool = [];
    for (let i = 0; i < SOUND_POOL_SIZE; i++) {
      try {
        const a = new Audio(path);
        a.preload = 'auto';
        a.volume = 0;
        const p = a.play();
        const settle = () => { try { a.pause(); a.currentTime = 0; } catch (e) {} a.volume = SOUND_VOLUME; };
        if (p && p.then) p.then(settle).catch(settle); else settle();
        pool.push(a);
      } catch (e) { /* ignore */ }
    }
    if (pool.length) audioCache[path] = pool;
  }
}
['touchstart', 'pointerdown', 'click', 'keydown'].forEach(ev =>
  document.addEventListener(ev, unlockAudio, { passive: true })
);
// coming back to the tab on a phone can leave the primed elements suspended
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) audioUnlocked = false;
});

function playSound(path) {
  try {
    const pool = audioCache[path];
    if (pool && pool.length) {
      // reuse a primed element that isn't currently playing; fall back to the oldest
      let a = pool.find(x => x.paused || x.ended);
      if (!a) { a = pool[0]; pool.push(pool.shift()); }
      try { a.currentTime = 0; } catch (e) {}
      a.volume = SOUND_VOLUME;
      const p = a.play();
      // If the browser still refuses, the pool is stale (this happens on mobile after
      // the tab is backgrounded). Allow the next tap to prime it again.
      if (p && p.catch) p.catch(() => { audioUnlocked = false; });
      return;
    }
    // not primed yet (no gesture has happened) — try anyway, it works on desktop
    const audio = new Audio(path);
    audio.volume = SOUND_VOLUME;
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
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

// ---- table zoom: scales the card-size variables, so the whole board reflows to fit
// rather than needing constant scrolling ----
let tableZoom = parseFloat(localStorage.getItem('dm_table_zoom') || '1') || 1;
function applyTableZoom() {
  tableZoom = Math.max(0.4, Math.min(1.6, tableZoom));
  document.documentElement.style.setProperty('--card-scale', tableZoom.toFixed(2));
  const el = document.getElementById('zoom-val');
  if (el) el.textContent = Math.round(tableZoom * 100) + '%';
  localStorage.setItem('dm_table_zoom', String(tableZoom));
}
document.getElementById('btn-zoom-out').addEventListener('click', () => { tableZoom -= 0.1; applyTableZoom(); });
document.getElementById('btn-zoom-in').addEventListener('click', () => { tableZoom += 0.1; applyTableZoom(); });
document.getElementById('btn-zoom-reset').addEventListener('click', () => { tableZoom = 1; applyTableZoom(); });
// keyboard shortcuts, ignored while typing in chat
document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === '-' || e.key === '_') { tableZoom -= 0.1; applyTableZoom(); }
  else if (e.key === '=' || e.key === '+') { tableZoom += 0.1; applyTableZoom(); }
  else if (e.key === '0') { tableZoom = 1; applyTableZoom(); }
});
applyTableZoom();

// ====================== On-screen notices ======================
function showNotice(text) {
  const stack = document.getElementById('notice-stack');
  const el = document.createElement('div');
  el.className = 'notice-toast';
  el.textContent = text;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => el.remove(), 450);
  }, 4200);
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
    loadEffectIndex(); loadRaceList();
    document.getElementById('screen-setup').style.display = 'none';
    document.getElementById('screen-table').style.display = 'flex';
    fadeOutMenuMusic(1400);
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
['opp-mana', 'my-mana', 'opp-shields', 'my-shields', 'opp-battle', 'my-battle', 'my-hand'].forEach(id => {
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
    const [label, fn, disabledReason] = item;
    const div = document.createElement('div');
    div.className = 'context-menu-item' + (disabledReason ? ' disabled' : '');
    div.textContent = label;
    if (disabledReason) {
      div.title = disabledReason;
      div.addEventListener('click', (e) => e.stopPropagation());   // greyed out: does nothing
    } else {
      div.addEventListener('click', () => { fn(); hideContextMenu(); });
    }
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

function openSearchModal(entries, filter, source, costEquals) {
  const grid = document.getElementById('search-modal-grid');
  const title = document.getElementById('search-modal-title');
  if (title) {
    title.textContent = (source || 'Search Your Deck') +
      (filter ? ' \u2014 take one ' + filter.toUpperCase() : ' \u2014 take one card') +
      (costEquals != null ? ' costing exactly ' + costEquals : '');
  }
  grid.innerHTML = '';
  entries.forEach(entry => {
    const id = entry.id;
    // indices come from the server so a filtered view can't pick the wrong card
    const index = entry.index;
    let allowed = true;
    if (filter === 'spell') allowed = isSpellById(id);
    else if (filter === 'creature') allowed = !isSpellById(id);
    else if (filter === 'nature creature') allowed = !isSpellById(id) && (cardMetaFor(id).civs || []).includes('Nature');
    if (allowed && costEquals != null) allowed = (cardMetaFor(id).cost === costEquals);
    const div = document.createElement('div');
    div.className = 'card-thumb' + (allowed ? '' : ' dimmed');
    div.innerHTML = cardImgHtml(id) +
      '<div class="zoom-btn" title="Preview">\u{1F50D}</div>' +
      '<div class="name">' + displayName(id) + '</div>' +
      (allowed ? '<button class="take-btn">Take</button>' : '<div class="hint" style="font-size:.7em">not eligible</div>');
    div.querySelector('.zoom-btn').addEventListener('click', (e) => { e.stopPropagation(); openMagnify(id); });
    const takeBtn = div.querySelector('.take-btn');
    if (takeBtn) {
      takeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendMsg({ type: 'searchDeckPick', index });
        document.getElementById('search-modal').style.display = 'none';
      });
    }
    grid.appendChild(div);
  });
  document.getElementById('search-modal').style.display = 'flex';
}

function powerById(id) {
  const meta = cardMetaDB.get(normKeyClient(cardBaseName(id)));
  return (meta && meta.power != null) ? meta.power : null;
}
function isBlockerById(id) {
  const meta = cardMetaDB.get(normKeyClient(cardBaseName(id)));
  return !!(meta && meta.blocker);
}
// a card the opponent's effects can't choose (Petrova, and anything the sheet grants
// "unchoosable" to) — read from the published effect index rather than by name
// Cross Gear, identified the same way the engine does: from the published ability
// index, so the two can never disagree about what counts as gear.
// "This creature can't be blocked by light creatures" — mirrors the engine so the
// client never highlights a blocker the server would then refuse.
function blockForbidden(attacker, blocker) {
  if (!attacker || !blocker) return false;
  const name = normKeyClient(cardBaseName(attacker.id));
  const fx = (typeof EFFECT_INDEX !== 'undefined' && EFFECT_INDEX) ? EFFECT_INDEX[name] : null;
  const clauses = (fx && fx.described) || [];
  for (const d of clauses) {
    if (d.action !== 'prevent' || String(d.what || '').toLowerCase() !== 'oppblock') continue;
    for (const f of (d.filters || [])) {
      if (f.key === 'civ') {
        const wants = String(f.value).split('/').map(x => x.trim().toLowerCase());
        const got = civsById(blocker.id).map(x => String(x).toLowerCase());
        if (wants.some(w => got.includes(w))) return true;
      }
    }
  }
  return false;
}

function isCrossGearById(id) {
  const name = normKeyClient(cardBaseName(id));
  const meta = cardMetaDB.get(name);
  if (meta && /cross gear/i.test(meta.type || '')) return true;
  const fx = (typeof EFFECT_INDEX !== 'undefined' && EFFECT_INDEX) ? EFFECT_INDEX[name] : null;
  return !!(fx && fx.crossGear);
}
function isUnchoosableById(id) {
  const name = normKeyClient(cardBaseName(id));
  if (name === 'petrova, channeler of suns') return true;
  const fx = (typeof EFFECT_INDEX !== 'undefined' && EFFECT_INDEX) ? EFFECT_INDEX[name] : null;
  return !!(fx && fx.unchoosable);
}
function civsById(id) {
  const meta = cardMetaDB.get(normKeyClient(cardBaseName(id)));
  return (meta && meta.civs) || [];
}
function racesById(id) {
  const meta = cardMetaDB.get(normKeyClient(cardBaseName(id)));
  const r = (meta && meta.race) || '';
  return String(r).toLowerCase().split('/').map(x => x.trim()).filter(Boolean);
}

// card type comes from the shared card database loaded at startup
function isSpellById(id) {
  const meta = cardMetaDB.get(normKeyClient(cardBaseName(id)));
  return !!(meta && meta.type && /spell/i.test(meta.type));
}

// ---- read-only reveal (Rain of Arrows shows the opponent's hand) ----
function openRevealModal(title, ids) {
  document.getElementById('gy-modal-title').textContent = title;
  const grid = document.getElementById('gy-modal-grid');
  grid.innerHTML = '';
  if (!ids.length) {
    grid.innerHTML = '<div class="hint" style="padding:20px">No cards.</div>';
  }
  ids.forEach(id => {
    const div = document.createElement('div');
    div.className = 'card-thumb';
    div.innerHTML = cardImgHtml(id);
    makeMagnifiable(div, id);
    grid.appendChild(div);
  });
  document.getElementById('gy-modal').style.display = 'flex';
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
  if (typeof Bot !== 'undefined') Bot.stop();
  isBotGame = false;
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
  startMenuMusic();
  document.getElementById('room-info').textContent = '';
  document.getElementById('join-request-banner').style.display = 'none';
});
document.getElementById('btn-stop-showing').addEventListener('click', () => sendMsg({ type: 'setShowingHand', show: false }));
document.getElementById('btn-skip-corile').addEventListener('click', () => sendMsg({ type: 'corileSkip' }));
document.getElementById('btn-end-turn').addEventListener('click', () => {
  sendMsg({ type: 'endTurn', force: endTurnWarned });
  endTurnWarned = false;
  // practice mode: hop to the other player so you're always looking at whoever is up.
  // Against the computer you stay put — seat 1 is the bot.
  if (isSolo && !isBotGame) setTimeout(() => switchSeat(activeSeat === 0 ? 1 : 0), 260);
});

// ====================== Shield Trigger prompt ======================
let shieldTriggerQueue = [];
let shieldTriggerPendingKey = null;
function openShieldTriggerModal(key, id) {
  shieldTriggerQueue.push({ key, id });
  if (!shieldTriggerPendingKey) processNextShieldTrigger();
}
// ====================== Forced discard prompts (Ghost Touch, Cranium Clamp, Lost Soul, Ice Vapor) ======================
let discardEffectId = null, discardChosen = new Set(), discardNeeded = 0;

function openDiscardModal(eff, hand) {
  discardEffectId = eff.id;
  discardChosen = new Set();
  discardNeeded = eff.kind === 'choose' ? eff.count : 0;
  const titleEl = document.getElementById('discard-modal-title');
  const subEl = document.getElementById('discard-modal-sub');
  const grid = document.getElementById('discard-modal-grid');
  titleEl.textContent = eff.source;
  grid.innerHTML = '';

  if (eff.kind === 'random') {
    subEl.textContent = 'Discard a random card from your hand?';
  } else if (eff.kind === 'all') {
    subEl.textContent = 'Discard your entire hand (' + hand.length + ' card' + (hand.length === 1 ? '' : 's') + ')?';
  } else {
    subEl.textContent = 'Choose ' + eff.count + ' card' + (eff.count === 1 ? '' : 's') + ' to discard.';
  }

  hand.forEach(c => {
    const d = document.createElement('div');
    d.className = 'pick';
    d.innerHTML = cardImgHtml(c.id) + '<div class="zoom-btn" title="Preview">\u{1F50D}</div>';
    // preview works in every mode, including the ones where clicking does nothing
    d.querySelector('.zoom-btn').addEventListener('click', (e) => { e.stopPropagation(); openMagnify(c.id); });
    if (eff.kind === 'choose') {
      d.addEventListener('click', () => {
        if (discardChosen.has(c.key)) discardChosen.delete(c.key);
        else {
          if (discardChosen.size >= discardNeeded) return;   // don't exceed the required count
          discardChosen.add(c.key);
        }
        d.classList.toggle('chosen', discardChosen.has(c.key));
        updateDiscardButton(hand.length);
      });
    }
    grid.appendChild(d);
  });
  updateDiscardButton(hand.length);
  document.getElementById('discard-modal').style.display = 'flex';
}

function updateDiscardButton(handLen) {
  const btn = document.getElementById('btn-discard-confirm');
  if (discardNeeded > 0) {
    const short = Math.min(discardNeeded, handLen === undefined ? discardNeeded : handLen);
    btn.textContent = 'Discard (' + discardChosen.size + '/' + short + ')';
    btn.disabled = discardChosen.size < short;
  } else {
    btn.textContent = 'OK';
    btn.disabled = false;
  }
}

document.getElementById('btn-discard-confirm').addEventListener('click', () => {
  if (!discardEffectId) return;
  sendMsg({ type: 'effectDiscardResolve', effectId: discardEffectId, keys: [...discardChosen] });
  discardEffectId = null; discardChosen = new Set();
  document.getElementById('discard-modal').style.display = 'none';
});

document.getElementById('btn-skip-effect').addEventListener('click', () => {
  const st = seats[activeSeat] && seats[activeSeat].state;
  if (!st) return;
  if (st.combat && st.combat.phase === 'breaking' && st.combat.attackerIdx === st.you) {
    sendMsg({ type: 'cancelCombat' });   // stop breaking further shields
    return;
  }
  const mine = st.players[st.you];
  if (mine.pendingTargets && mine.pendingTargets.length) {
    sendMsg({ type: 'effectTargetSkip', effectId: mine.pendingTargets[0].id });
  }
});

// ---- generic choice picker: works for any zone the effect names ----
let targetPickEffectId = null;
function candidatesFor(eff, me, opp) {
  const zones = {
    oppBattle: opp.battlezone,
    ownBattle: me.battlezone,
    ownHand:   me.hand,
    ownMana:   me.mana,
    oppMana:   opp.mana,
    ownGrave:  me.graveyard,
    ownShield: me.shields,
    anyBattle: me.battlezone.concat(opp.battlezone),
    oppShield: opp.shields,
    oppGrave:  opp.graveyard,
    oppHand:   opp.hand,
    anyMana:   me.mana.concat(opp.mana),
    anyShield: me.shields.concat(opp.shields),
    anyGrave:  me.graveyard.concat(opp.graveyard)
  };
  // an effect may allow a choice between zones, e.g. "(oppCreature or oppShield)"
  let list = [];
  for (const zn of (eff.altZones && eff.altZones.length ? eff.altZones : [eff.zone])) {
    list = list.concat(zones[zn] || []);
  }
  // an effect never targets the card that produced it
  if (eff.sourceKey) list = list.filter(c => c.key !== eff.sourceKey);
  if (eff.filter === 'untapped') list = list.filter(c => !c.tapped);
  if (eff.requireBlocker) list = list.filter(c => isBlockerById(c.id));
  if (eff.filter === 'spell') list = list.filter(c => isSpellById(c.id));
  if (eff.filter === 'creature') list = list.filter(c => !isSpellById(c.id));
  if (eff.filter === 'nonEvolution') list = list.filter(c => !/evolution/i.test((cardMetaFor(c.id) || {}).type || ''));
  // "civ=Darkness/Fire" lists alternatives — match any of them, as the server does
  const anyOf = (have, spec) => {
    if (spec == null) return true;
    const wants = String(spec).split('/').map(x => x.trim().toLowerCase()).filter(Boolean);
    const got = (have || []).map(x => String(x).toLowerCase());
    return wants.some(w => got.includes(w));
  };
  if (eff.civ) list = list.filter(c => anyOf(civsById(c.id), eff.civ));
  if (eff.negCiv) list = list.filter(c => !anyOf(civsById(c.id), eff.negCiv));
  if (eff.race) list = list.filter(c => anyOf(racesById(c.id), eff.race));
  if (eff.maxPower != null) {
    // keep creatures with no recorded power — the player confirms those by hand
    list = list.filter(c => { const p = powerById(c.id); return p == null || p <= eff.maxPower; });
  }
  // Petrova can't be chosen by the opponent's effects
  if (eff.zone === 'oppBattle' || eff.zone === 'anyBattle' || (eff.altZones || []).includes('oppBattle')) {
    list = list.filter(c => !(opp.battlezone.includes(c) && isUnchoosableById(c.id)));
  }
  return list;
}
function zonePrompt(eff) {
  switch (eff.action) {
    case 'tap': return "Choose one of your opponent's untapped creatures to tap.";
    case 'returnToHand':
      return eff.zone === 'oppMana'
        ? "Choose a card in your opponent's mana zone to return to their hand."
        : "Choose a creature to return to its owner's hand.";
    case 'toHand': return 'Choose a card to take back into your hand.';
    case 'destroy': return eff.zone === 'ownBattle' ? 'Choose one of YOUR OWN creatures to destroy.' : 'Choose a creature to destroy.';
    case 'toOwnerMana': return "Choose a creature to send to its owner's mana zone.";
    case 'toOwnMana': return 'Choose a card from your hand to put into your mana zone.';
    case 'toTopOfDeck': return "Choose a creature to put on top of its owner's deck.";
    case 'toOwnerShield': return "Choose a non-evolution creature to put into its owner's shield zone.";
    case 'toGrave': return eff.zone === 'ownShield'
      ? 'Choose one of your shields to put into your graveyard.'
      : 'Choose a card to put into your graveyard.';
    default: return 'Choose a card.';
  }
}
function openTargetPickModal(eff, me, opp) {
  const valid = candidatesFor(eff, me, opp);
  if (!valid.length) {
    sendMsg({ type: 'effectTargetSkip', effectId: eff.id });   // nothing legal to pick
    return;
  }
  targetPickEffectId = eff.id;
  document.getElementById('target-pick-title').textContent = eff.source;
  document.getElementById('target-pick-sub').textContent = zonePrompt(eff);
  const grid = document.getElementById('target-pick-grid');
  grid.innerHTML = '';
  valid.forEach(c => {
    const d = document.createElement('div');
    d.className = 'pick';
    const pw = powerById(c.id);
    d.innerHTML = cardImgHtml(c.id) + '<div class="zoom-btn" title="Preview">\u{1F50D}</div>' +
      (eff.maxPower != null ? '<div class="pw-badge">' + (pw == null ? '?' : pw) + '</div>' : '');
    d.querySelector('.zoom-btn').addEventListener('click', (e) => { e.stopPropagation(); openMagnify(c.id); });
    d.addEventListener('click', () => {
      if (eff.maxPower != null && powerById(c.id) == null) {
        // power isn't in the spreadsheet yet, so the player has to vouch for it
        if (!confirm('Is ' + displayName(c.id) + ' a creature with power ' + eff.maxPower + ' or less?')) return;
      }
      sendMsg({ type: 'effectTarget', effectId: eff.id, key: c.key });
      targetPickEffectId = null;
      document.getElementById('target-pick-modal').style.display = 'none';
    });
    grid.appendChild(d);
  });
  document.getElementById('target-pick-modal').style.display = 'flex';
}
document.getElementById('btn-target-pick-skip').addEventListener('click', () => {
  if (targetPickEffectId) sendMsg({ type: 'effectTargetSkip', effectId: targetPickEffectId });
  targetPickEffectId = null;
  document.getElementById('target-pick-modal').style.display = 'none';
});

// ====================== COMBAT ======================
let attackChoiceKey = null;      // creature we're declaring an attack with
let manualBattleData = null;

function cardMetaFor(id) { return cardMetaDB.get(normKeyClient(cardBaseName(id))) || {}; }
function isSummoningSick(state, card) {
  if (!state) return false;
  // an evolved creature always carries a stack, so this works even before the card
  // database has loaded — the metadata check below is the belt-and-braces version
  if (card.under && card.under.length) return false;
  if (isEvolutionById(card.id)) return false;    // evolutions can attack the turn they arrive
  if (cardMetaFor(card.id).speedAttacker) return false;
  const mine = state.players[state.you];
  if (mine && mine.turboRushActive) return false;
  return card.summonedTurn != null && card.summonedTurn === state.turnNumber;
}
function restrictionFor(id) { return (cardMetaFor(id).attackRestriction || 'none').toLowerCase(); }
// Only the bare "cannot attack" fully blocks shields — "cannot attack creatures" (Vile
// Mulder, Avalanche Giant, Nocturnal Giant) still allows shield attacks; a loose
// substring match previously caught that phrase too and hid the shield-attack button.
function canAttackShieldsC(id) {
  const r = restrictionFor(id);
  return r !== 'cannot attack' && !r.includes('not players') && !r.includes('blocker only');
}
// "untapped ok" may be scoped to one civilization, e.g. "not players/untapped ok:darkness"
// (Aeris, Flight Elemental can only attack untapped Darkness creatures, not any untapped
// creature). A bare "untapped ok" with no civ suffix still means "any civilization".
function untappedAttackCivC(id) {
  const m = restrictionFor(id).match(/untapped ok(?::(\w+))?/);
  if (!m) return null;
  return m[1] || true;
}
function canAttackUntappedTargetC(id, targetId) {
  const c = untappedAttackCivC(id);
  if (!c) return false;
  if (c === true) return true;
  return (cardMetaFor(targetId).civs || []).some(v => v.toLowerCase() === c);
}
function blockerOnlyC(id) { return restrictionFor(id).includes('blocker only'); }
// Board-state-dependent restrictions (Cliffcrush Giant, Headlong Giant). Returns a
// reason string if this specific creature currently can't attack at all, else null.
function conditionalAttackBlockC(card, me) {
  const r = restrictionFor(card.id);
  if (r === 'cannot attack while other own creature untapped') {
    if (me.battlezone.some(c => c.key !== card.key && !c.tapped)) {
      return displayName(card.id) + " can't attack while you have another untapped creature.";
    }
  } else if (r === 'cannot attack if hand empty') {
    if (!me.hand.length) return displayName(card.id) + " can't attack — your hand is empty.";
  }
  return null;
}

// Step 1 — pick what this creature is attacking.
function openAttackTargetModal(card, state) {
  attackChoiceKey = card.key;
  const me = state.players[state.you], opp = state.players[state.you === 0 ? 1 : 0];
  const name = displayName(card.id);
  document.getElementById('attack-target-title').textContent = 'Attack with ' + name;
  const legal = opp.battlezone.filter(c => {
    if (!c.tapped && !canAttackUntappedTargetC(card.id, c.id)) return false;
    if (blockerOnlyC(card.id) && !cardMetaFor(c.id).blocker) return false;
    return true;
  });
  document.getElementById('attack-target-sub').textContent =
    legal.length ? 'Choose a creature to attack, or attack their shields.'
                 : 'No creatures you can attack — you can still attack their shields.';
  const grid = document.getElementById('attack-target-grid');
  grid.innerHTML = '';
  legal.forEach(c => {
    const d = document.createElement('div');
    d.className = 'pick';
    d.innerHTML = cardImgHtml(c.id) + '<div class="zoom-btn">\u{1F50D}</div>';
    d.querySelector('.zoom-btn').addEventListener('click', e => { e.stopPropagation(); openMagnify(c.id); });
    d.addEventListener('click', () => {
      sendMsg({ type: 'declareAttack', key: card.key, target: { type: 'creature', key: c.key } });
      closeAttackTargetModal();
    });
    grid.appendChild(d);
  });
  const dcActive = !!(me && me.diamondCutterActive);
  const shieldBtn = document.getElementById('btn-attack-shields');
  shieldBtn.style.display = ((canAttackShieldsC(card.id) || dcActive) && opp.shields.length) ? 'inline-block' : 'none';
  if (dcActive && !canAttackShieldsC(card.id)) shieldBtn.textContent = 'Attack Shields (Diamond Cutter)';
  else shieldBtn.textContent = 'Attack Shields';
  document.getElementById('attack-target-modal').style.display = 'flex';
}
function closeAttackTargetModal() {
  attackChoiceKey = null;
  document.getElementById('attack-target-modal').style.display = 'none';
}
document.getElementById('btn-attack-shields').addEventListener('click', () => {
  if (attackChoiceKey) sendMsg({ type: 'declareAttack', key: attackChoiceKey, target: { type: 'shield' } });
  closeAttackTargetModal();
});
document.getElementById('btn-attack-cancel').addEventListener('click', closeAttackTargetModal);

// Step 2 — the defender may block with an untapped Blocker.
let blockShownFor = null;
function openBlockModal(state) {
  const cb = state.combat;
  const me = state.players[state.you], opp = state.players[state.you === 0 ? 1 : 0];
  const atk = opp.battlezone.find(c => c.key === cb.attackerKey);
  const atkName = atk ? displayName(atk.id) : 'A creature';
  const lightStealth = atk && cardMetaFor(atk.id).lightStealth && me.mana.some(m => (cardMetaFor(m.id).civs || []).includes('Light'));
  const targetTxt = cb.target.type === 'shield' ? 'your shields' : 'one of your creatures';
  document.getElementById('block-sub').textContent =
    atkName + ' is attacking ' + targetTxt + '.' +
    (lightStealth ? " It has Light Stealth — you can't block it while you have Light cards in your mana zone." : ' Block with a Blocker, or let it through.');
  const grid = document.getElementById('block-grid');
  grid.innerHTML = '';
  const blockers = lightStealth ? [] : me.battlezone.filter(c => !c.tapped && cardMetaFor(c.id).blocker);
  blockers.forEach(c => {
    const d = document.createElement('div');
    d.className = 'pick';
    d.innerHTML = cardImgHtml(c.id) + '<div class="zoom-btn">\u{1F50D}</div>';
    d.querySelector('.zoom-btn').addEventListener('click', e => { e.stopPropagation(); openMagnify(c.id); });
    d.addEventListener('click', () => {
      sendMsg({ type: 'declareBlock', blockerKey: c.key });
      document.getElementById('block-modal').style.display = 'none';
    });
    grid.appendChild(d);
  });
  document.getElementById('block-modal').style.display = 'flex';
}
document.getElementById('btn-no-block').addEventListener('click', () => {
  sendMsg({ type: 'declareBlock' });
  document.getElementById('block-modal').style.display = 'none';
});

// Step 4 — manual result when the sheet has no power for one of the creatures.
function openManualBattle(b) {
  manualBattleData = b;
  document.getElementById('manual-battle-sub').textContent =
    b.aName + ' battled ' + b.dName + ", but the card sheet has no power for one of them. Decide the result between you.";
  document.getElementById('manual-battle-modal').style.display = 'flex';
}
function sendManual(which) {
  const b = manualBattleData;
  if (!b) return;
  const mine = seats[activeSeat].state.you;
  if (which === 'a' || which === 'both') {
    sendMsg({ type: 'manualBattleResult', loserOwner: b.aIdx === mine ? 'me' : 'opp', loserKey: b.aKey });
  }
  if (which === 'd' || which === 'both') {
    sendMsg({ type: 'manualBattleResult', loserOwner: b.dIdx === mine ? 'me' : 'opp', loserKey: b.dKey });
  }
  manualBattleData = null;
  document.getElementById('manual-battle-modal').style.display = 'none';
}
document.getElementById('btn-manual-a').addEventListener('click', () => sendManual('a'));
document.getElementById('btn-manual-d').addEventListener('click', () => sendManual('d'));
document.getElementById('btn-manual-both').addEventListener('click', () => sendManual('both'));
document.getElementById('btn-manual-none').addEventListener('click', () => sendManual('none'));

// ---- multi-select for mass effects whose power data is incomplete (Searing Wave) ----
let multiPickId = null, multiPickChosen = new Set();
let truceAsked = false;
let raceAsked = null;
let ALL_RACES = [];
function loadRaceList() {
  if (ALL_RACES && ALL_RACES.length) return;
  fetch('/api/races').then(r => r.json()).then(list => { ALL_RACES = list || []; }).catch(() => {});
}

function openRacePicker(source, excludeRace) {
  const grid = document.getElementById('race-pick-grid');
  document.getElementById('race-pick-title').textContent = source;
  grid.innerHTML = '';
  const search = document.getElementById('race-pick-search');
  const ex = (excludeRace || '').toLowerCase();
  const draw = (filter) => {
    grid.innerHTML = '';
    const f = (filter || '').toLowerCase();
    ALL_RACES
      .filter(r => !ex || r.toLowerCase() !== ex)   // Petrova can't name its own race
      .filter(r => !f || r.toLowerCase().includes(f)).slice(0, 400).forEach(r => {
      const b = document.createElement('button');
      b.className = 'race-chip';
      b.textContent = r;
      b.addEventListener('click', () => {
        sendMsg({ type: 'choosePetrovaRace', race: r });
        document.getElementById('race-pick-modal').style.display = 'none';
      });
      grid.appendChild(b);
    });
  };
  search.value = '';
  search.oninput = () => draw(search.value);
  draw('');
  document.getElementById('race-pick-modal').style.display = 'flex';
}
function openMultiPickModal(pm, me, opp) {
  multiPickId = pm.id;
  multiPickChosen = new Set();
  const zones = {
    oppBattle: opp.battlezone, ownBattle: me.battlezone,
    anyBattle: me.battlezone.concat(opp.battlezone),
    ownGrave: me.graveyard, ownMana: me.mana, oppMana: opp.mana, ownHand: me.hand
  };
  const pool = zones[pm.zone] || opp.battlezone;
  document.getElementById('multi-pick-title').textContent = pm.source;
  document.getElementById('multi-pick-sub').textContent = pm.prompt || 'Choose cards.';
  const grid = document.getElementById('multi-pick-grid');
  grid.innerHTML = '';
  pm.keys.forEach(k => {
    const c = pool.find(x => x.key === k);
    if (!c) return;
    const d = document.createElement('div');
    d.className = 'pick';
    d.innerHTML = cardImgHtml(c.id) + '<div class="zoom-btn" title="Preview">\u{1F50D}</div>';
    d.querySelector('.zoom-btn').addEventListener('click', (e) => { e.stopPropagation(); openMagnify(c.id); });
    d.addEventListener('click', () => {
      if (multiPickChosen.has(k)) multiPickChosen.delete(k);
      else {
        if (pm.max && multiPickChosen.size >= pm.max) return;   // respect "up to N"
        multiPickChosen.add(k);
      }
      d.classList.toggle('chosen', multiPickChosen.has(k));
      const btn = document.getElementById('btn-multi-pick-ok');
      btn.textContent = pm.max && pm.max < 90
        ? 'Confirm (' + multiPickChosen.size + '/' + pm.max + ')'
        : 'Confirm (' + multiPickChosen.size + ')';
    });
    grid.appendChild(d);
  });
  document.getElementById('btn-multi-pick-ok').textContent = 'Confirm (0)';
  document.getElementById('multi-pick-modal').style.display = 'flex';
}
document.getElementById('btn-multi-pick-ok').addEventListener('click', () => {
  if (multiPickId) sendMsg({ type: 'effectMultiResolve', effectId: multiPickId, keys: [...multiPickChosen] });
  multiPickId = null; multiPickChosen = new Set();
  document.getElementById('multi-pick-modal').style.display = 'none';
});

// ---- Gigazald: tapping a Darkness creature can mean attack OR use its tap ability ----
let tapModeKey = null;
function openTapModeModal(key, name) {
  tapModeKey = key;
  document.getElementById('attack-trigger-text').textContent =
    name + ' — attack with it, or use its tap ability (Gigazald: opponent discards at random)?';
  document.getElementById('attack-trigger-modal').style.display = 'flex';
}
document.getElementById('btn-attack-yes').addEventListener('click', () => {
  if (tapModeKey) sendMsg({ type: 'battleTap', key: tapModeKey, mode: 'attack' });
  tapModeKey = null;
  document.getElementById('attack-trigger-modal').style.display = 'none';
});
document.getElementById('btn-attack-no').addEventListener('click', () => {
  if (tapModeKey) sendMsg({ type: 'battleTap', key: tapModeKey, mode: 'ability' });
  tapModeKey = null;
  document.getElementById('attack-trigger-modal').style.display = 'none';
});

// ---- end-of-turn question (Hearty Cap'n Polligon) ----
function openEndTurnPrompt(key, name, kind) {
  if (kind === 'untap') {
    if (confirm(name + ' — untap it at the end of your turn?')) sendMsg({ type: 'endTurnUntap', key });
    return;
  }
  if (confirm(name + ' — did it attack and break a shield this turn?\n\nOK returns it to your hand.')) {
    sendMsg({ type: 'endTurnReturnConfirm', key });
  }
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
  if (shieldTriggerPendingKey) sendMsg({ type: 'shieldTriggerDecline', key: shieldTriggerPendingKey });
  document.getElementById('shield-trigger-modal').style.display = 'none';
  processNextShieldTrigger();
});
// A decision prompt only closes through its own buttons. Clicking the backdrop or
// pressing Escape does nothing — an accidental tap shouldn't silently decline a
// Shield Trigger. The modal is height-capped and scrollable, so the buttons are
// always reachable.


// ---- on-table selection: valid cards glow and are clicked directly, so choosing a
// target never covers the board with a dialog ----
let attackMode = null;         // {key} while choosing what a creature attacks
let evolveMode = null;         // {handKey, cardId} while choosing what to evolve from
function isEvolutionById(id) { return /evolution/i.test(cardMetaFor(id).type || ''); }
function racesOfId(id) {
  return (cardMetaFor(id).race || '').toLowerCase().split('/').map(r => r.trim()).filter(Boolean);
}
function canEvolveOntoClient(evoId, baseId) {
  const a = racesOfId(evoId), b = racesOfId(baseId);
  return a.length && b.length && a.some(r => b.includes(r));
}
let multiTableChosen = new Set();

function selectableKeysFor(state, me, opp) {
  // returns { keys:Set, onClick(key), banner:string, showConfirm:bool, showSkip:bool }

  // Crossing a piece of gear: pick one of your own creatures to attach it to.
  if (crossingGearKey) {
    const gear = (me.crossGear || []).find(g => g.key === crossingGearKey);
    const legal = me.battlezone.filter(c => !isSpellById(c.id) && c.key !== (gear && gear.crossedTo));
    if (!gear || !legal.length) {
      crossingGearKey = null;
    } else {
      const costTxt = gear.cost != null ? (' — costs ' + gear.cost + ' mana again') : '';
      return {
        keys: new Set(legal.map(c => c.key)),
        onClick: key => {
          sendMsg({ type: 'crossGear', key: crossingGearKey, targetKey: key });
          crossingGearKey = null;
        },
        banner: 'Cross ' + (gear.name || 'gear') + ' onto which creature?' + costTxt,
        showSkip: true,
        skipLabel: 'Cancel',
        onSkip: () => { crossingGearKey = null; }
      };
    }
  }

  if (evolveMode) {
    const legal = me.battlezone.filter(b => canEvolveOntoClient(evolveMode.cardId, b.id));
    if (!legal.length) { evolveMode = null; return null; }
    return {
      keys: new Set(legal.map(c => c.key)),
      onClick: key => {
        sendMsg({ type: 'summonCard', key: evolveMode.handKey, baseKey: key });
        evolveMode = null;
      },
      banner: 'Evolving ' + displayName(evolveMode.cardId) + ' — click one of your ' +
              ((cardMetaFor(evolveMode.cardId).race) || 'matching') + ' creatures to evolve from.',
      showSkip: true, skipLabel: 'Cancel', onSkip: () => { evolveMode = null; renderState(state); }
    };
  }
  if (attackMode) {
    const card = me.battlezone.find(c => c.key === attackMode.key);
    if (!card) { attackMode = null; return null; }
    const keys = new Set();
    opp.battlezone.forEach(c => {
      if (!c.tapped && !canAttackUntappedTargetC(card.id, c.id)) return;
      if (blockerOnlyC(card.id) && !isBlockerById(c.id)) return;
      keys.add(c.key);
    });
    // Diamond Cutter grants "ignoreAttackRestrictions", which lets a creature that
    // normally can't attack players go at SHIELDS this turn. Read it from the state so
    // the client never offers an attack the server would refuse, or hide a legal one.
    const kwList = (me.liveKeywords && me.liveKeywords[card.key]) || [];
    const ignoresRestrictions = kwList.some(k => /^ignoreattackrestrictions/i.test(k));
    const dcActive = !!me.diamondCutterActive || ignoresRestrictions;
    const mayHitPlayer = canAttackShieldsC(card.id) || dcActive;
    const canShields = mayHitPlayer && opp.shields.length;
    if (canShields) opp.shields.forEach(sh => keys.add(sh.key));
    // With no shields left there's no card to click, so the finishing blow needs its
    // own button — otherwise the winning attack is impossible to declare.
    const finisher = mayHitPlayer && !opp.shields.length;
    return {
      keys,
      onClick: key => {
        const isShield = opp.shields.some(sh => sh.key === key);
        sendMsg({ type: 'declareAttack', key: attackMode.key,
                  target: isShield ? { type: 'shield' } : { type: 'creature', key } });
        attackMode = null;
      },
      banner: finisher
        ? 'Attacking with ' + displayName(card.id) + ' — your opponent has NO SHIELDS LEFT. Attack them directly to win!'
        : 'Attacking with ' + displayName(card.id) + ' — click an enemy creature' + (canShields ? ' or shield' : '') + ' to attack.',
      showConfirm: finisher,
      confirmLabel: '\u{1F3C6} Attack player to win',
      onConfirm: () => {
        sendMsg({ type: 'declareAttack', key: attackMode.key, target: { type: 'shield' } });
        attackMode = null;
      },
      showSkip: true, skipLabel: 'Cancel attack', onSkip: () => { attackMode = null; renderState(state); }
    };
  }

  const cb = state.combat;
  if (cb && cb.phase === 'blocking' && cb.attackerIdx !== state.you) {
    const atk = opp.battlezone.find(c => c.key === cb.attackerKey);
    // an attacker may forbid certain creatures from blocking it — don't offer those
    const keys = new Set(me.battlezone
      .filter(c => !c.tapped && isBlockerById(c.id) && !blockForbidden(atk, c))
      .map(c => c.key));
    return {
      keys,
      onClick: key => sendMsg({ type: 'declareBlock', blockerKey: key }),
      banner: (atk ? displayName(atk.id) : 'A creature') + ' is attacking — click one of your blockers, or let it through.',
      showSkip: true, skipLabel: "Don't block", onSkip: () => sendMsg({ type: 'declareBlock' })
    };
  }

  if (cb && cb.phase === 'breaking' && cb.attackerIdx === state.you) {
    return {
      keys: new Set(opp.shields.map(sh => sh.key)),
      onClick: key => sendMsg({ type: 'breakShield', key }),
      banner: 'Break ' + cb.shieldsToBreak + ' shield' + (cb.shieldsToBreak === 1 ? '' : 's') + " — click your opponent's shields.",
      showSkip: true, skipLabel: 'Stop breaking', onSkip: () => sendMsg({ type: 'cancelCombat' })
    };
  }

  const eff = (me.pendingTargets || [])[0];
  if (eff && eff.zone !== 'ownGrave') {
    // One filter implementation, shared with the picker modal. A second copy here is
    // exactly how Mizoy ended up highlighting creatures of every civilization while
    // the modal filtered them correctly.
    const list = candidatesFor(eff, me, opp);
    return {
      keys: new Set(list.map(c => c.key)),
      onClick: key => {
        if (eff.maxPower != null && powerById((list.find(c => c.key === key) || {}).id) == null) {
          if (!confirm('Is this a creature with power ' + eff.maxPower + ' or less?')) return;
        }
        sendMsg({ type: 'effectTarget', effectId: eff.id, key });
      },
      banner: eff.source + ' — ' + zonePrompt(eff),
      showSkip: true, skipLabel: 'Skip', onSkip: () => sendMsg({ type: 'effectTargetSkip', effectId: eff.id })
    };
  }

  const pm = me.pendingMulti;
  if (pm && pm.zone !== 'ownGrave') {
    return {
      keys: new Set(pm.keys),
      multi: true,
      onClick: key => {
        if (multiTableChosen.has(key)) multiTableChosen.delete(key);
        else { if (pm.max && multiTableChosen.size >= pm.max) return; multiTableChosen.add(key); }
        renderState(state);
      },
      banner: pm.source + ' — ' + (pm.prompt || 'Choose cards') +
              '  (' + multiTableChosen.size + (pm.max && pm.max < 90 ? '/' + pm.max : '') + ' chosen)',
      showConfirm: true,
      onConfirm: () => {
        sendMsg({ type: 'effectMultiResolve', effectId: pm.id, keys: [...multiTableChosen] });
        multiTableChosen = new Set();
      }
    };
  }
  return null;
}

let activeSelection = null;
function applySelectableHighlights(state, me, opp) {
  activeSelection = selectableKeysFor(state, me, opp);
  document.querySelectorAll('.card.selectable-target, .card.chosen-target')
    .forEach(el => el.classList.remove('selectable-target', 'chosen-target'));
  // the DOM is about to be re-keyed below, so any previous hover no longer applies —
  // the player just needs to nudge the mouse to bring the arrow back
  hoverTargetKey = null;
  const bar = document.getElementById('select-bar');
  if (!activeSelection || !activeSelection.keys.size) {
    if (!activeSelection) { bar.style.display = 'none'; updateIntentArrow(state, me, opp); return; }
    // a prompt with no clickable cards can still be actionable (e.g. the winning attack)
    document.getElementById('select-bar-text').textContent =
      activeSelection.banner + (activeSelection.showConfirm ? '' : ' (nothing valid)');
    bar.style.display = 'flex';
    wireSelectBarButtons();
    updateIntentArrow(state, me, opp);
    return;
  }
  activeSelection.keys.forEach(key => {
    document.querySelectorAll('.card[data-key="' + key + '"]').forEach(el => {
      el.classList.add(multiTableChosen.has(key) ? 'chosen-target' : 'selectable-target');
      el.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) return;    // ctrl+click still means "point at this"
        e.stopPropagation();
        activeSelection.onClick(key);
      };
      // faint preview arrow: whoever's picking a target sees, live, where a creature
      // is lined up to strike before they commit to the click
      el.addEventListener('mouseenter', () => { hoverTargetKey = key; updateIntentArrow(state, me, opp); });
      el.addEventListener('mouseleave', () => {
        if (hoverTargetKey === key) { hoverTargetKey = null; updateIntentArrow(state, me, opp); }
      });
    });
  });
  document.getElementById('select-bar-text').textContent = activeSelection.banner;
  bar.style.display = 'flex';
  wireSelectBarButtons();
  updateIntentArrow(state, me, opp);
}

// ---- faint intent arrow: attacker -> target, live while choosing / fixed once declared ----
let hoverTargetKey = null;
function cardCenterInTable(key) {
  const tableEl = document.getElementById('table');
  const el = document.querySelector('.card[data-key="' + key + '"]');
  if (!tableEl || !el) return null;
  const t = tableEl.getBoundingClientRect(), c = el.getBoundingClientRect();
  if (!c.width || !c.height) return null;
  return { x: c.left + c.width / 2 - t.left, y: c.top + c.height / 2 - t.top };
}
function zoneCenterInTable(elId) {
  const tableEl = document.getElementById('table');
  const el = document.getElementById(elId);
  if (!tableEl || !el) return null;
  const t = tableEl.getBoundingClientRect(), c = el.getBoundingClientRect();
  return { x: c.left + c.width / 2 - t.left, y: c.top + c.height / 2 - t.top };
}
function computeIntentArrow(state, me, opp) {
  const cb = state.combat;
  if (cb) {
    // an attack has been declared: show attacker -> target for both players, since
    // the defender needs to see it too while deciding whether to block
    const iAmAttacker = cb.attackerIdx === state.you;
    const source = cardCenterInTable(cb.attackerKey);
    if (!source) return null;
    let target = null;
    if (cb.phase === 'breaking' && iAmAttacker) {
      // double/triple breakers pick shields one at a time — point at whichever
      // shield the attacker is currently hovering, or the shield row in general
      if (hoverTargetKey && opp.shields.some(sh => sh.key === hoverTargetKey)) {
        target = cardCenterInTable(hoverTargetKey);
      }
      if (!target) target = zoneCenterInTable('opp-shields');
    } else if (cb.target && cb.target.type === 'creature') {
      target = cardCenterInTable(cb.target.key);
    } else if (cb.target && cb.target.type === 'shield') {
      target = zoneCenterInTable(iAmAttacker ? 'opp-shields' : 'my-shields');
    }
    if (!target) return null;
    return { source, target, committed: true };
  }
  // nothing declared yet: preview where an attack would land while the attacking
  // player is still choosing (hovering a legal creature or shield to attack)
  if (attackMode && hoverTargetKey && activeSelection && activeSelection.keys.has(hoverTargetKey)) {
    const source = cardCenterInTable(attackMode.key);
    const target = cardCenterInTable(hoverTargetKey);
    if (source && target) return { source, target, committed: false };
  }
  return null;
}
window.addEventListener('resize', () => {
  if (window.__lastState) updateIntentArrow(window.__lastState, window.__lastMe, window.__lastOpp);
});
function updateIntentArrow(state, me, opp) {
  const layer = document.getElementById('intent-arrow-layer');
  if (!layer) return;
  const arrow = computeIntentArrow(state, me, opp);
  if (!arrow) { layer.classList.remove('showing', 'committed'); return; }
  const line = document.getElementById('intent-arrow-line');
  // pull the head back off the target card a little so it doesn't vanish under it
  const dx = arrow.target.x - arrow.source.x, dy = arrow.target.y - arrow.source.y;
  const dist = Math.hypot(dx, dy) || 1;
  const pullBack = Math.min(38, dist * 0.28);
  line.setAttribute('x1', arrow.source.x);
  line.setAttribute('y1', arrow.source.y);
  line.setAttribute('x2', arrow.target.x - (dx / dist) * pullBack);
  line.setAttribute('y2', arrow.target.y - (dy / dist) * pullBack);
  layer.classList.add('showing');
  layer.classList.toggle('committed', arrow.committed);
}
function wireSelectBarButtons() {
  const sk = document.getElementById('btn-select-skip');
  const cf = document.getElementById('btn-select-confirm');
  sk.style.display = (activeSelection && activeSelection.showSkip) ? 'inline-block' : 'none';
  cf.style.display = (activeSelection && activeSelection.showConfirm) ? 'inline-block' : 'none';
  if (activeSelection) {
    sk.textContent = activeSelection.skipLabel || 'Skip';
    cf.textContent = activeSelection.confirmLabel || 'Confirm';
    sk.onclick = () => { if (activeSelection.onSkip) activeSelection.onSkip(); };
    cf.onclick = () => { if (activeSelection.onConfirm) activeSelection.onConfirm(); };
  }
}

// ---- highlight cards the engine just moved ----
// Zone membership is diffed between state updates, so any card the engine relocated
// (drawn, discarded, sent to mana, broken from a shield) flashes without the server
// needing to announce each move.
let prevZoneByKey = null;
function zoneMapOf(state) {
  const map = {};
  const add = (list, zone) => (list || []).forEach(c => { if (c && c.key) map[c.key] = zone; });
  state.players.forEach((p, i) => {
    add(p.hand, 'hand' + i); add(p.mana, 'mana' + i); add(p.battlezone, 'bz' + i);
    add(p.shields, 'sh' + i); add(p.graveyard, 'gy' + i);
  });
  return map;
}
function flashMovedCards(state) {
  const now = zoneMapOf(state);
  if (prevZoneByKey) {
    const moved = [];
    for (const key of Object.keys(now)) {
      if (prevZoneByKey[key] !== now[key]) moved.push(key);   // new card, or changed zone
    }
    for (const key of moved) {
      document.querySelectorAll('[data-key="' + key + '"]').forEach(el => {
        el.classList.remove('just-moved');
        void el.offsetWidth;                                   // restart the animation
        el.classList.add('just-moved');
        setTimeout(() => el.classList.remove('just-moved'), 1600);
      });
    }
  }
  prevZoneByKey = now;
}

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
    const oppName = (state.names && state.names[oppIdx]) ? state.names[oppIdx] : 'Your opponent';
    let title;
    if (g.reason === 'shields') {
      title = g.by === meIdx
        ? '\u{1F3C6} You win! Your final attack got through with no shields left to stop it.'
        : oppName + ' wins — your shields were gone and the attack connected.';
    } else if (g.reason === 'surrender') {
      title = g.by === meIdx ? 'You surrendered.' : oppName + ' surrendered — you win!';
    } else if (g.reason === 'decked') {
      title = g.by === meIdx
        ? '\u{1F3C6} You win! ' + oppName + ' ran out of cards in their deck.'
        : 'You ran out of cards in your deck — ' + oppName + ' wins.';
    } else {
      title = 'Game ended by agreement.';
    }
    document.getElementById('game-over-title').textContent = title;
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
    // base hand cards are already large, so the hover lift is a modest nudge —
    // it's there to pull a card clear of its neighbours, not to enlarge it much
    const enlargeHand = () => { el.classList.add('hand-hover'); el.style.transform = 'rotate(0deg) translateY(-22px) scale(1.12)'; };
    const restoreHand = () => { el.classList.remove('hand-hover'); el.style.transform = restTransform; };
    el.addEventListener('mouseenter', enlargeHand);
    el.addEventListener('mouseleave', () => { if (menuAnchorEl === el) return; restoreHand(); });
    makeMagnifiable(el, c.id);
    attachFlashClick(el, 'hand', meIdx, c.key);
    // Shift+click toggles a single card in/out of the selection. The fan overlaps
    // heavily, so a drag-box alone can't reliably pick out individual cards.
    el.addEventListener('click', (e) => {
      if (!e.shiftKey) return;
      e.preventDefault(); e.stopPropagation();
      if (selectedContainerId !== 'my-hand') { clearSelection(); selectedContainerId = 'my-hand'; }
      if (selectedKeys.has(c.key)) selectedKeys.delete(c.key); else selectedKeys.add(c.key);
      if (!selectedKeys.size) selectedContainerId = null;
      applySelectionClasses();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      enlargeHand();
      if (selectedKeys.size > 1 && selectedContainerId === 'my-hand' && selectedKeys.has(c.key)) {
        const keys = [...selectedKeys];
        showContextMenu(e.clientX, e.clientY, [
          ['Discard Selected (' + keys.length + ')', () => {
            keys.forEach(k => sendMsg({ type: 'discardFromHand', key: k }));
            clearSelection();
          }],
          ['Charge Selected to Mana (' + keys.length + ')', () => {
            // Charging a selection is still one charge per turn. Rather than quietly
            // sending several and having all but one refused, say what will happen.
            if (manualUsed('charge')) {
              if (!confirm('You have already charged mana this turn.\n\nCharge all ' + keys.length + ' anyway?')) return;
              keys.forEach(k => sendMsg({ type: 'chargeMana', key: k, force: true }));
            } else if (keys.length > 1) {
              if (!confirm('Only one card may be charged per turn.\n\nCharge all ' + keys.length + ' anyway?')) {
                sendMsg({ type: 'chargeMana', key: keys[0] });   // just the first
                clearSelection();
                return;
              }
              keys.forEach((k, i) => sendMsg({ type: 'chargeMana', key: k, force: i > 0 }));
            } else {
              sendMsg({ type: 'chargeMana', key: keys[0] });
            }
            clearSelection();
          }],
          ['Return Selected to Deck & Shuffle (' + keys.length + ')', () => {
            keys.forEach(k => sendMsg({ type: 'handCardToDeckShuffle', key: k }));
            clearSelection();
          }]
        ], el, restoreHand);
        return;
      }
      clearSelection();
      const items = [
        [manualUsed('charge') ? 'Charge Mana (already charged)' : 'Charge Mana', () => {
          if (manualUsed('charge')) {
            if (!confirm('You have already charged mana this turn.\n\nCharge anyway?')) return;
            sendMsg({ type: 'chargeMana', key: c.key, force: true });
            return;
          }
          sendMsg({ type: 'chargeMana', key: c.key });
        }],
        [(isCrossGearById(c.id) ? 'Generate' : isSpellById(c.id) ? 'Cast' : 'Summon'), () => {
          if (isEvolutionById(c.id)) {
            const st = seats[activeSeat] && seats[activeSeat].state;
            const mine = st && st.players[st.you];
            const legal = mine ? mine.battlezone.filter(b => canEvolveOntoClient(c.id, b.id)) : [];
            if (!legal.length) {
              alert(displayName(c.id) + ' is an evolution creature — you need a ' +
                    ((cardMetaFor(c.id).race) || 'matching') + ' creature in your battle zone first.');
              return;
            }
            evolveMode = { handKey: c.key, cardId: c.id };
            renderState(st);
            return;
          }
          sendMsg({ type: 'summonCard', key: c.key });
        }],
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

  renderManaZone('my-mana', me.mana, true, meIdx, me.pendingManaDiscards || 0);
  renderManaZone('opp-mana', opp.mana, false, oppIdx);
  renderShieldZone('my-shields', me.shields, true, meIdx);
  renderShieldZone('opp-shields', opp.shields, false, oppIdx);
  const pendingCorileUses = 0;  // Corile now goes through the standard target highlighting
  renderBattleHalf('my-battle', me.battlezone, true, meIdx, pendingCorileUses, me.pendingTargets || []);
  renderBattleHalf('opp-battle', opp.battlezone, false, oppIdx, pendingCorileUses, me.pendingTargets || []);
  const canSearch = me.battlezone.some(c => cardBaseName(c.id).toLowerCase() === 'crystal memory');
  renderDeckZone('my-deck', me.deckCount, true, canSearch);
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

  // ---- targeting effects (Spiral Gate, Aqua Surfer, Terror Pit, Death Smoke) ----
  const effBanner = document.getElementById('effect-banner');
  const myTargets = me.pendingTargets || [];
  const manaDiscards = me.pendingManaDiscards || 0;
  if (myTargets.length && myTargets[0].zone === 'ownGrave') {
    const t = myTargets[0];
    const verb = t.action === 'returnToHand' ? "return it to its owner's hand"
               : t.action === 'tap' ? 'tap it'
               : t.action === 'toOwnerMana' ? "send it to its owner's mana zone"
               : t.action === 'toHand' ? 'take it back to your hand'
               : t.action === 'toOwnMana' ? 'put it into your mana zone'
               : t.action === 'toOwnerShield' ? "put it into its owner's shield zone"
               : 'destroy it';
    document.getElementById('effect-banner-text').textContent =
      t.source + ' — right-click a creature in your opponent\'s battlezone to ' + verb + '.' +
      (myTargets.length > 1 ? ' (' + myTargets.length + ' pending)' : '');
    document.getElementById('btn-skip-effect').style.display = 'inline-block';
    effBanner.className = 'showing-hand-banner effect-banner';
    effBanner.style.display = 'flex';
  } else if (manaDiscards > 0) {
    document.getElementById('effect-banner-text').textContent =
      'Ice Vapor — you must send a card from your mana zone to the graveyard before you can play on.' +
      (manaDiscards > 1 ? ' (' + manaDiscards + ' owed)' : '');
    document.getElementById('btn-skip-effect').style.display = 'none';
    effBanner.className = 'showing-hand-banner effect-banner owing';
    effBanner.style.display = 'flex';
  } else {
    effBanner.style.display = 'none';
  }

  // ---- Solar Ray style effects open a picker automatically ----
  // Cards sitting on the table are chosen by clicking them; only the graveyard pile
  // (which isn't laid out on the table) still needs a picker window.
  const pickEff = myTargets[0];
  const needsModal = pickEff && pickEff.zone === 'ownGrave';
  if (needsModal && targetPickEffectId !== pickEff.id) {
    openTargetPickModal(pickEff, me, opp);
  } else if (!needsModal && targetPickEffectId) {
    targetPickEffectId = null;
    document.getElementById('target-pick-modal').style.display = 'none';
  }

  // ---- combat: defender's block window, attacker's shield breaking ----
  const cb = state.combat;
  const blockModal = document.getElementById('block-modal');
  blockModal.style.display = 'none';   // blocking is chosen on the table now
  // shield breaking is handled by the select bar

  // ---- Petrova: name a race ----
  // tracked by id, not a boolean — a second Petrova queues its own prompt and must
  // still open once the first is answered
  if (me.pendingRaceChoice && raceAsked !== me.pendingRaceChoice.id) {
    raceAsked = me.pendingRaceChoice.id;
    openRacePicker(me.pendingRaceChoice.source, me.pendingRaceChoice.excludeRace);
  } else if (!me.pendingRaceChoice) {
    raceAsked = null;
    document.getElementById('race-pick-modal').style.display = 'none';
  }

  // ---- Miraculous Truce: name a civilization ----
  if (me.pendingTruce && !truceAsked) {
    truceAsked = true;
    setTimeout(() => {
      const civ = prompt('Miraculous Truce — name a civilization that can\'t attack you until your next turn:\n\nLight, Water, Darkness, Fire or Nature');
      const match = ['Light','Water','Darkness','Fire','Nature'].find(c => c.toLowerCase() === (civ || '').trim().toLowerCase());
      if (match) sendMsg({ type: 'chooseTruceCiv', civ: match });
      truceAsked = false;
    }, 50);
  }

  // ---- mass effects needing manual confirmation (Searing Wave) ----
  const pmNeedsModal = me.pendingMulti && me.pendingMulti.zone === 'ownGrave';
  if (pmNeedsModal && multiPickId !== me.pendingMulti.id) {
    openMultiPickModal(me.pendingMulti, me, opp);
  } else if (!pmNeedsModal && multiPickId) {
    multiPickId = null;
    document.getElementById('multi-pick-modal').style.display = 'none';
  }

  // ---- forced discards: open automatically, one at a time ----
  const myDiscards = me.pendingDiscards || [];
  if (myDiscards.length && !discardEffectId) {
    openDiscardModal(myDiscards[0], me.hand);
  } else if (!myDiscards.length && discardEffectId) {
    // resolved (or cleared by a rematch) — make sure the modal doesn't linger
    discardEffectId = null;
    document.getElementById('discard-modal').style.display = 'none';
  }

  // make it obvious when the opponent is held up waiting on you
  const waitingOnMe = (me.pendingPromptCount || 0) > 0;
  const waitingOnThem = (opp.pendingPromptCount || 0) > 0;

  const ti = document.getElementById('turn-indicator');
  const oppLabel = (state.names && state.names[oppIdx]) ? state.names[oppIdx] : 'your opponent';
  ti.textContent = !state.dealt[oppIdx] ? 'Waiting for opponent to join & deal in...'
    : waitingOnThem ? (oppLabel + ' is resolving something — please wait.')
    : waitingOnMe ? 'Resolve your prompt to continue.'
    : ('Free play with ' + oppLabel + ' — act anytime');
  ti.classList.toggle('waiting', waitingOnThem || waitingOnMe);
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

  // Mana cards overlap, so an explicit count removes any doubt about what's available
  const manaLabel = (el, zone) => {
    const node = document.getElementById(el);
    if (!node) return;
    const free = zone.filter(c => !c.tapped).length;
    node.textContent = '— ' + free + ' of ' + zone.length + ' available';
    node.classList.toggle('none-left', free === 0 && zone.length > 0);
  };
  manaLabel('my-mana-count', me.mana);
  manaLabel('opp-mana-count', opp.mana);


  const ws = document.getElementById('whose-side');
  if (ws) {
    const myName = (state.names && state.names[meIdx]) ? state.names[meIdx] : ('Player ' + (meIdx + 1));
    ws.textContent = (isSolo && !isBotGame) ? ('VIEWING: ' + myName.toUpperCase()) : myName.toUpperCase();
  }

  applySelectionClasses();
  applySelectableHighlights(state, me, opp);
  flashMovedCards(state);
  window.__lastMe = me; window.__lastOpp = opp; window.__lastState = state;
}

function renderManaZone(elId, mana, isMine, ownerIdx, pendingManaDiscards) {
  const container = document.getElementById(elId);
  container.innerHTML = '';
  mana.forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.dataset.key = c.key;
    div.innerHTML = cardImgHtml(c.id);
    makeMagnifiable(div, c.id);

    const xPct0 = (c.x != null) ? c.x : 3;
    // clamped: the zone is only a little taller than a card, so a large y would
    // push the card body out through the bottom edge
    const yPct0 = Math.max(0, Math.min(11, (c.y != null) ? c.y : 5));
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
        ].concat(pendingManaDiscards > 0
          ? [['Send to Graveyard (Ice Vapor)', () => sendMsg({ type: 'effectDiscardMana', key: c.key })]]
          : []), div);
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
            finalYPct = Math.max(0, Math.min(11, origYPct + (dy / cr.height) * 100));
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
    // during a shield attack the attacker clicks the opponent's shields to break them
    if (!isMine) {
      const st = seats[activeSeat] && seats[activeSeat].state;
      if (st && st.combat && st.combat.phase === 'breaking' && st.combat.attackerIdx === st.you) {
        div.classList.add('breakable');
        div.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey) return;   // ctrl+click still means "indicate"
          sendMsg({ type: 'breakShield', key: s.key });
        });
      }
    }
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


// ---------------------------------------------------------------------------
// Cross Gear
//
// Gear lives in the battle zone alongside creatures rather than in a separate strip.
// Click a piece of gear to start crossing it, then click the creature to attach it to.
// ---------------------------------------------------------------------------

// while crossing, clicking one of your creatures completes it
function tryCompleteCross(creatureKey) {
  if (!crossingGearKey) return false;
  sendMsg({ type: 'crossGear', key: crossingGearKey, targetKey: creatureKey });
  crossingGearKey = null;
  return true;
}

// how many pieces of gear are crossed onto this creature
function gearCountOn(creatureKey, isMine) {
  const st = seats[activeSeat] && seats[activeSeat].state;
  if (!st) return 0;
  const p = st.players[isMine ? st.you : (st.you === 0 ? 1 : 0)];
  return ((p && p.crossGear) || []).filter(g => g.crossedTo === creatureKey).length;
}

function renderBattleHalf(elId, cards, isMine, ownerIdx, pendingCorileUses, pendingTargets) {
  const container = document.getElementById(elId);
  container.innerHTML = '';

  // Cross Gear shares the battle zone with creatures. It is drawn slightly smaller and
  // labelled with whatever it is crossed to, so it reads as equipment rather than a
  // creature without needing a zone of its own.
  const st0 = seats[activeSeat] && seats[activeSeat].state;
  const owner = st0 ? st0.players[ownerIdx] : null;
  const gearList = (owner && owner.crossGear) || [];
  gearList.forEach(g => {
    const div = document.createElement('div');
    const bearer = (owner.battlezone || []).find(c => c.key === g.crossedTo);
    div.className = 'card gear-card' + (bearer ? ' crossed' : ' unattached') +
                    (crossingGearKey === g.key ? ' selected' : '');
    div.dataset.key = g.key;
    div.dataset.gear = '1';
    div.innerHTML = cardImgHtml(g.id) +
      '<div class="gear-tag">' + (bearer ? '\u2699 ' + escapeHtml(cardBaseName(bearer.id)) : '\u2699 not crossed') + '</div>';
    makeMagnifiable(div, g.id);
    const gx = (g.x != null) ? g.x : 4;
    const gy = Math.max(0, Math.min(22, (g.y != null) ? g.y : 4));
    div.style.left = gx + '%';
    if (isMine) div.style.bottom = gy + '%'; else div.style.top = gy + '%';
    if (isMine) {
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        crossingGearKey = (crossingGearKey === g.key) ? null : g.key;
        renderState(st0);
      });
    }
    container.appendChild(div);
  });

  cards.forEach(c => {
    const div = document.createElement('div');
    div.className = 'card' + (c.tapped ? ' tapped' : '');
    div.dataset.key = c.key;
    // Green overlay = lasting buffs only (Petrova, Barkwhip...). livePower is computed
    // without the Power Attacker bonus, so that temporary boost can never leak into the
    // green figure — it only ever appears in the gold badge. Both can show at once when
    // a Power Attacker also has a permanent buff.
    const boosted = (c.livePower != null && c.basePower != null && c.livePower !== c.basePower);
    // gold badge: Power Attacker, shown only while the creature is tapped from
    // attacking, and gone again once the turn ends
    const showPA = !!(c.powerAttacker && c.attackedThisTurn && c.tapped);
    const stacked = (c.under && c.under.length) ? c.under.length : 0;
    div.innerHTML = cardImgHtml(c.id) +
      (boosted ? '<div class="power-overlay" title="Printed power ' + c.basePower +
                 ', currently ' + c.livePower + '">' + c.livePower + '</div>' : '') +
      (showPA ? '<div class="pa-badge"><span>POWER ATTACKER</span>+' + c.powerAttacker + '</div>' : '') +
      (stacked ? '<div class="evo-badge" title="Evolution stack: ' + (stacked + 1) + ' cards">\u21D1' + (stacked + 1) + '</div>' : '') +
      (gearCountOn(c.key, isMine) ? '<div class="gear-badge" title="Cross Gear attached">\u2699' + gearCountOn(c.key, isMine) + '</div>' : '');
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
      if (isMine && selectedKeys.size > 1 && selectedContainerId === elId && selectedKeys.has(c.key)) {
        const targetTapped = !c.tapped;
        const tapLabel = targetTapped ? 'Tap Selected' : 'Untap Selected';
        const batch = [[tapLabel, () => {
          selectedKeys.forEach(k => {
            const card = cards.find(cc => cc.key === k);
            if (card && card.tapped !== targetTapped) sendMsg({ type: 'battleTap', key: k });
          });
          clearSelection();
        }]];
        {
          batch.push(['Destroy Selected', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleDestroy', key: k })); clearSelection(); }]);
          batch.push(['Return Selected to Hand', () => { selectedKeys.forEach(k => sendMsg({ type: 'battleReturn', key: k })); clearSelection(); }]);
        }
        showContextMenu(e.clientX, e.clientY, batch, div);
        return;
      }
      clearSelection();
      // tap/untap is your own creatures only — effects like Solar Ray handle tapping
      // an opponent's creature through the targeting system instead
      const items = [];
      if (isMine) {
        const st = seats[activeSeat] && seats[activeSeat].state;
        const myTurn = st && st.activeTurn === st.you;
        const meta = cardMetaFor(c.id);
        const restr = restrictionFor(c.id);
        // Diamond Cutter lets anything swing at shields this turn, so the option stays live
        const dcActive = !!(st && st.players[st.you] && st.players[st.you].diamondCutterActive);
        let attackBlockedBy = null;
        if (restr === 'cannot attack' && !dcActive) attackBlockedBy = "This creature can't attack.";
        else if (!myTurn) attackBlockedBy = 'You can only attack on your own turn.';
        else if (st && st.combat) attackBlockedBy = 'An attack is already being resolved.';
        else if (isSummoningSick(st, c) && !dcActive) attackBlockedBy = 'Summoning sickness — it can\'t attack the turn it arrived.';
        else if (!dcActive && st) attackBlockedBy = conditionalAttackBlockC(c, st.players[st.you]);
        if (!c.tapped) {
          items.push(['\u2694 Attack', () => { attackMode = { key: c.key }; renderState(st); }, attackBlockedBy]);
          if (meta.tapAbility) items.push(['Use tap ability', () => sendMsg({ type: 'battleTap', key: c.key, mode: 'ability' })]);
        }
        items.push([c.tapped ? 'Untap' : 'Tap (no attack)', () => sendMsg({ type: 'battleTap', key: c.key })]);
        items.push(['Destroy', () => sendMsg({ type: 'battleDestroy', key: c.key })]);
        items.push(['Return to Hand', () => sendMsg({ type: 'battleReturn', key: c.key })]);
      } else {
        for (const t of (pendingTargets || []).filter(t => t.zone === 'oppBattle' || t.zone === 'anyBattle')) {
          const label = t.action === 'returnToHand' ? 'Return to Hand (' + t.source + ')'
                      : t.action === 'tap' ? 'Tap it (' + t.source + ')'
                      : t.action === 'toOwnerMana' ? 'Send to Mana (' + t.source + ')'
                      : t.action === 'toTopOfDeck' ? 'Put on Top of Deck (' + t.source + ')'
                      : 'Destroy (' + t.source + ')';
          items.push([label, () => sendMsg({ type: 'effectTarget', effectId: t.id, key: c.key })]);
        }
      }
      if (!items.length) return;   // nothing you're allowed to do to that creature
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

function renderDeckZone(elId, count, isMine, canSearch) {
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
      [manualUsed('draw') ? 'Draw a Card (already drawn)' : 'Draw a Card', () => {
        // Off-turn draws are legitimate (shield triggers, forced draws) — just confirm
        // so an accidental misclick during the opponent's turn doesn't slip through.
        if (isOffTurnForMe()) {
          if (!confirm("It's not your turn. Draw anyway?\n\n(Legitimate for shield triggers and forced draws — this will be flagged in the move log.)")) return;
        }
        if (manualUsed('draw')) {
          if (!confirm('You have already drawn this turn.\n\nOnly a card effect grants an extra draw. Draw anyway?')) return;
          sendMsg({ type: 'drawCard', force: true });
          return;
        }
        sendMsg({ type: 'drawCard' });
      }],
      ['Shuffle Deck', () => sendMsg({ type: 'shuffleDeck' })]
    ];
    if (canSearch) items.push(['Search Deck', () => sendMsg({ type: 'requestSearchDeck' })]);
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
