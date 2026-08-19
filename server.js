// Duel Masters virtual tabletop — relay/authority server.
// No phases, no turn locks — both players can act on their own cards at any
// time. Server only enforces ownership, not turn order.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ---- Card database (name -> {name, cost, type, civs[]}), loaded from any
// .xlsx file sitting in the carddata/ folder — no specific filename required.
// Re-upload an updated file (same folder, any name) to update it — checked on
// every request via file modified-time, so no server restart is needed.
// Cards missing from it, or missing a cost/type, are simply never gated (fail-open by design).
const CARD_DATA_DIR = path.join(__dirname, 'carddata');
let CARD_DB = new Map();
let CARD_DB_SOURCE_PATH = null;
let CARD_DB_MTIME = 0;

function findCardDataFile() {
  try {
    const files = fs.readdirSync(CARD_DATA_DIR).filter(f => f.toLowerCase().endsWith('.xlsx'));
    if (!files.length) return null;
    // if more than one .xlsx is sitting in there, use whichever was modified most recently
    let chosen = files[0], latest = -1;
    for (const f of files) {
      const m = fs.statSync(path.join(CARD_DATA_DIR, f)).mtimeMs;
      if (m > latest) { latest = m; chosen = f; }
    }
    return path.join(CARD_DATA_DIR, chosen);
  } catch (e) {
    return null;
  }
}

function loadCardDatabase(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const db = new Map();
    const yes = v => /^y(es)?$/i.test((v === undefined || v === null ? '' : v).toString().trim());
    const txt = v => (v === undefined || v === null) ? null : (v.toString().trim() || null);
    const num = v => {
      const n = parseInt((v === undefined || v === null ? '' : v).toString().replace(/[^0-9-]/g, ''), 10);
      return Number.isFinite(n) ? n : null;
    };
    for (const row of rows) {
      const name = (row['Name'] || '').toString().trim();
      if (!name) continue;
      const key = normalizeCardKey(name);
      const civRaw = (row['Civilization'] || '').toString().trim();
      const entry = {
        name,
        cost: num(row['Mana Cost']),
        type: txt(row['Type']),
        civs: civRaw ? civRaw.split('/').map(x => x.trim()).filter(Boolean) : [],
        power: num(row['Power']),
        race: txt(row['Race']),
        blocker: yes(row['Blocker (Yes/No)']),
        shieldTrigger: yes(row['Shield Trigger (Yes/No)']),
        speedAttacker: yes(row['Speed Attacker (yes/No)']),
        powerAttacker: num(row['Power attacker']),
        slayer: yes(row['Slayer']),
        tapAbility: yes(row['Tap Ability']),
        turboRush: yes(row['Turbo Rush']),
        doubleBreaker: yes(row['Double Breaker']),
        tripleBreaker: yes(row['Triple Breaker']),
        attackRestriction: (txt(row['Attack restriction']) || 'none').toLowerCase(),
        lightStealth: yes(row['Light Stealth'])
      };
      // Duplicate rows (reprints) are merged field by field, keeping whichever row
      // actually has data — a blank reprint row must never blank out a filled one.
      const existing = db.get(key);
      db.set(key, existing ? mergeCardEntries(existing, entry) : entry);
    }
    CARD_DB = db;
    console.log('Card database (re)loaded from', filePath, '-', CARD_DB.size, 'unique card names.');
  } catch (e) {
    console.warn('Card database not loaded (' + filePath + '):', e.message);
    CARD_DB = new Map();
  }
}

// Card names are matched on this form, so curly vs straight apostrophes and stray
// spacing can never stop a card's abilities from firing.
function normalizeCardKey(name) {
  return name.toLowerCase()
    .replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'")
    .replace(/_/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeCardEntries(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    const av = a[k], bv = b[k];
    if (bv === null || bv === undefined || bv === false) continue;      // b adds nothing
    if (av === null || av === undefined || av === false) { out[k] = bv; continue; }
    if (Array.isArray(av) && Array.isArray(bv)) { out[k] = av.length >= bv.length ? av : bv; continue; }
    if (k === 'attackRestriction' && av === 'none' && bv !== 'none') { out[k] = bv; continue; }
  }
  return out;
}

function ensureCardDatabaseFresh() {
  const filePath = findCardDataFile();
  if (!filePath) {
    if (CARD_DB.size > 0) console.warn('No .xlsx file found in carddata/ anymore — card database cleared.');
    CARD_DB = new Map(); CARD_DB_SOURCE_PATH = null; CARD_DB_MTIME = 0;
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (filePath !== CARD_DB_SOURCE_PATH || stat.mtimeMs !== CARD_DB_MTIME) {
      loadCardDatabase(filePath);
      CARD_DB_SOURCE_PATH = filePath;
      CARD_DB_MTIME = stat.mtimeMs;
    }
  } catch (e) {
    // ignore transient read errors — keep whatever was last loaded
  }
}
ensureCardDatabaseFresh();

app.get('/api/races', (req, res) => {
  ensureCardDatabaseFresh();
  const races = new Set();
  for (const c of CARD_DB.values()) if (c.race) races.add(c.race);
  res.set('Cache-Control', 'no-store');
  res.json([...races].sort());
});

app.get('/api/carddata', (req, res) => {
  ensureCardDatabaseFresh();
  res.set('Cache-Control', 'no-store');
  res.json({ count: CARD_DB.size, cards: [...CARD_DB.values()] });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const connMeta = new Map(); // ws -> { roomCode, idx }

function newRoomCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function newKey() { return crypto.randomBytes(6).toString('hex'); }

// Human-readable label for a log line, e.g. "DM-1/Bolshack Dragon.jpg" -> "Bolshack Dragon"
function cardLabel(id) {
  if (!id) return 'a card';
  const file = id.split('/').pop() || id;
  return file.replace(/\.[^.]+$/, '');
}

// Names of cards whose "search your deck" ability the app is allowed to facilitate.
// Add more here if other search-granting cards come up.
const SEARCH_DECK_ENABLERS = ['crystal memory'];
function hasNamedCard(player, nameLower) {
  return player.battlezone.some(c => cardLabel(c.id).toLowerCase() === nameLower);
}
function canSearchDeck(player) {
  return SEARCH_DECK_ENABLERS.some(n => hasNamedCard(player, n));
}
const SKYSWORD_NAME = 'skysword, the savage vizier';
const BRONZE_ARM_NAME = 'bronze-arm tribe';
const ICE_VAPOR_NAME = 'ice vapor, shadow of anguish';

// --- Card effect tables -------------------------------------------------
// Adding another card with one of these behaviours is a one-line change.

// A "choice" is: pick a card from some zone, then do something to it. One shared
// mechanism covers every card below; the client renders a picker from `zone`.
//   zone   - where the chooser picks from
//   action - what happens to the chosen card
//   filter - narrows the candidates
//   who    - 'me' (caster chooses) or 'opp' (opponent must choose)
const TARGET_EFFECTS = {
  'spiral gate':      { zone: 'oppBattle', action: 'returnToHand' },
  'aqua surfer':      { zone: 'oppBattle', action: 'returnToHand' },
  'terror pit':       { zone: 'oppBattle', action: 'destroy' },
  'death smoke':      { zone: 'oppBattle', action: 'destroy', filter: 'untapped' },
  'solar ray':        { zone: 'oppBattle', action: 'tap',     filter: 'untapped' },
  'natural snare':    { zone: 'oppBattle', action: 'toOwnerMana' },
  'poisonous mushroom': { zone: 'ownHand', action: 'toOwnMana' },
  'dark reversal':    { zone: 'ownGrave', action: 'toHand' },
  'corpse charger':   { zone: 'ownGrave', action: 'toHand', filter: 'creature' },
  'miraculous snare': { zone: 'anyBattle', action: 'toOwnerShield', filter: 'nonEvolution' },
  'rothus, the traveler': { zone: 'ownBattle', action: 'destroy', alsoOpp: true },
  'crimson hammer':   { zone: 'oppBattle', action: 'destroy', maxPower: 2000 },
  'tornado flame':    { zone: 'oppBattle', action: 'destroy', maxPower: 4000 },
  'critical blade':   { zone: 'oppBattle', action: 'destroy', requireBlocker: true },
  'volcanic arrows':  { zone: 'anyBattle', action: 'destroy', maxPower: 6000, thenShieldToGrave: true },
  'comet missile':    { zone: 'oppBattle', action: 'destroy', maxPower: 6000, requireBlocker: true, byOpponent: true },
  'volcano charger':  { zone: 'oppBattle', action: 'destroy', maxPower: 2000 },
  'miraculous rebirth': { zone: 'oppBattle', action: 'destroy', maxPower: 5000, thenSearchSameCost: true },
  'galek, the shadow warrior': { zone: 'oppBattle', action: 'destroy', requireBlocker: true },
  'thrash crawler':   { zone: 'ownMana', action: 'toHand' },
  'belix, the explorer': { zone: 'ownMana', action: 'toHand', filter: 'spell' }
};

// "Choose up to N cards from a zone and do X." One entry per card.
const MULTI_EFFECTS = {
  'aqua sniper':       { zone: 'anyBattle', action: 'returnToHand', max: 2, prompt: "Choose up to 2 creatures to return to their owners' hands." },
  'craze valkyrie, the drastic': { zone: 'oppBattle', action: 'tap', max: 2, prompt: "Choose up to 2 of your opponent's creatures to tap." },
  'morbid medicine':   { zone: 'ownGrave', action: 'toHand', max: 2, filter: 'creature', prompt: 'Choose up to 2 creatures in your graveyard to return to your hand.' },
  'apocalypse vise':   { zone: 'oppBattle', action: 'destroy', max: 99, maxPower: 8000, prompt: "Choose any number of your opponent's creatures with power 8000 or less to destroy." },
  'laser wing':        { zone: 'anyBattle', action: 'unblockable', max: 2, prompt: "Choose up to 2 creatures — they can't be blocked this turn." }
};

// Tap abilities used INSTEAD of attacking.
const TAP_ABILITIES = {
  'bliss totem, avatar of luck': { kind: 'multi', zone: 'ownGrave', action: 'toOwnMana', max: 3, prompt: 'Put up to 3 cards from your graveyard into your mana zone.' },
  "rikabu's screwdriver":        { kind: 'target', zone: 'oppBattle', action: 'destroy', requireBlocker: true },
  'phantasmal horror gigazald':  { kind: 'oppDiscardRandom' }
};

// "When this creature would be destroyed, return it to its owner's hand instead."
const RETURN_INSTEAD_OF_DESTROY = new Set(['aqua skydiver', 'aqua knight', 'aqua soldier']);

// Creatures that can never be blocked.
const ALWAYS_UNBLOCKABLE = new Set(['crystal lancer']);

// Destroys every opposing creature at or below a power threshold.
const MASS_POWER_DESTROY = { 'searing wave': 3000 };

// Cards that go somewhere other than the graveyard once their effect resolves.
const SPELL_RESOLVES_TO_MANA = new Set(['corpse charger', 'volcano charger']);

// Always enters the mana zone tapped.
const ENTERS_MANA_TAPPED = new Set(['gonta, the warrior savage', 'miraculous snare']);

// Top card of deck straight into the mana zone on summon, no shuffle.
const AUTO_MANA_FROM_DECK = new Set(['bronze-arm tribe']);

// Returned to its owner's hand at the end of that owner's turn.
const END_TURN_RETURN_TO_HAND = new Set(['pyrofighter magnus']);

// Asked at end of turn whether it attacked and broke a shield (the engine can't
// tell which creature broke which shield, since shields are resolved by hand).
const END_TURN_SHIELD_PROMPT = new Set(["hearty cap'n polligon"]);

// Taps every untapped creature the opponent controls.
const TAP_ALL_OPP = new Set(['holy awe']);

const ALCADEIAS_NAME = 'alcadeias, lord of spirits';
const PETROVA_NAME = 'petrova, channeler of suns';
const MONGREL_MAN_NAME = 'mongrel man';
const GIGAZALD_NAME = 'phantasmal horror gigazald';
const BULLRAIZER_NAME = 'snip striker bullraizer';

// Draws that happen the moment the card lands, with no prompt.
const AUTO_DRAW_ON_SUMMON = { 'aqua hulcus': 1, 'energy stream': 2, 'magris, vizier of magnetism': 1, 'king ripped-hide': 2 };

// Opens the deck search view automatically on cast.
const AUTO_SEARCH_ON_SUMMON = {
  'crystal memory':   { filter: null,          reveal: false },
  'logic cube':       { filter: 'spell',       reveal: true },   // must take a spell, and show it
  'rumbling terahorn':{ filter: 'creature',    reveal: true },
  'niofa, horned protector': { filter: 'nature creature', reveal: true },
  'hawkeye lunatron': { filter: null,          reveal: false }
};

// Wipes every creature that isn't a Darkness creature, on both sides.
const MASS_DESTROY_CARDS = new Set(['ballom, master of death', 'ballom emperor, lord of demons']);

// Goes back to the mana zone instead of the graveyard, but only from the battlezone.
const COILING_VINES_NAME = 'coiling vines';

function isSpellCard(id) {
  const m = cardMeta(id);
  return !!(m && m.type && /spell/i.test(m.type));
}
function civsOf(id) {
  const m = cardMeta(id);
  return (m && m.civs) ? m.civs : [];
}
function powerOf(id) {           // null = not filled in on the sheet yet
  const m = cardMeta(id);
  return (m && m.power != null) ? m.power : null;
}
function isBlocker(id) {
  const m = cardMeta(id);
  return !!(m && m.blocker);
}
function removeBattleCard(owner, key) {
  const i = owner.battlezone.findIndex(c => c.key === key);
  return i === -1 ? null : owner.battlezone.splice(i, 1)[0];
}
// Single funnel for battlezone -> graveyard so the Coiling Vines redirect can't be
// missed by one of the several paths that destroy a creature.
function battleCardToGrave(owner, card) {
  // destroyed: the whole stack goes to the graveyard together
  dissolveStack(owner, card, null, 'graveyard');
  const nm = normalizeCardKey(cardLabel(card.id));
  // some creatures go home rather than dying
  if (RETURN_INSTEAD_OF_DESTROY.has(nm)) {
    owner.hand.push({ id: card.id, key: card.key });
    return 'hand';
  }
  if (cardLabel(card.id).toLowerCase() === COILING_VINES_NAME) {
    const slot = manaSlot(owner);
    owner.mana.push({ id: card.id, key: card.key, tapped: false, x: slot.x, y: slot.y });
    return 'mana zone';
  }
  owner.graveyard.push({ id: card.id, key: card.key });
  return 'graveyard';
}

// ---------- power & combat helpers ----------
function metaOf(id) { return cardMeta(id) || {}; }
function raceOf(id) { return (metaOf(id).race || '').toLowerCase(); }
// Races can be compound, e.g. "Angel Command/Lost Crusader"
function racesOf(id) {
  return (metaOf(id).race || '').toLowerCase().split('/').map(r => r.trim()).filter(Boolean);
}
function isEvolutionCard(id) {
  const t = metaOf(id).type || '';
  return /evolution/i.test(t);
}
// An evolution creature stacks onto one of your creatures sharing a race with it.
function canEvolveOnto(evoId, baseId) {
  const evoRaces = racesOf(evoId), baseRaces = racesOf(baseId);
  if (!evoRaces.length || !baseRaces.length) return false;
  return evoRaces.some(r => baseRaces.includes(r));
}
// Cards stacked under an evolution creature travel with it. Being DESTROYED sends the
// whole stack to the graveyard; any other way of leaving the battlezone (bounced to
// hand, put on the deck, sent to mana) just moves them along with the top card.
function dissolveStack(owner, card, logs, dest) {
  if (!card.under || !card.under.length) return;
  const n = card.under.length;
  for (const u of card.under) {
    if (dest === 'graveyard') owner.graveyard.push({ id: u.id, key: u.key });
    else owner.hand.push({ id: u.id, key: u.key });
  }
  if (logs) logs.push('the ' + n + ' card' + (n === 1 ? '' : 's') + ' under ' + cardLabel(card.id) +
                      (dest === 'graveyard' ? ' went to the graveyard.' : ' went back to hand.'));
  card.under = [];
}
function hasNamed(player, normName) {
  return player.battlezone.some(c => normalizeCardKey(cardLabel(c.id)) === normName);
}
function namedCard(player, normName) {
  return player.battlezone.find(c => normalizeCardKey(cardLabel(c.id)) === normName) || null;
}

// Effective power, including every static buff currently applying to this creature.
// `attacking` adds bonuses that only count while it is the one attacking.
function effectivePower(state, ownerIdx, card, attacking) {
  const owner = state.players[ownerIdx];
  const m = metaOf(card.id);
  if (m.power == null) return null;              // unknown — caller must ask the players
  let p = m.power;
  const selfKey = normalizeCardKey(cardLabel(card.id));

  if (attacking && m.powerAttacker) p += m.powerAttacker;

  // Barkwhip, the Smasher: while TAPPED, your other Beast Folk get +2000
  const bark = namedCard(owner, 'barkwhip, the smasher');
  if (bark && bark.tapped && bark.key !== card.key && raceOf(card.id).includes('beast folk')) p += 2000;

  // Petrova: +4000 to your OTHER creatures of the named race, while Petrova is out
  // Every Petrova names its own race, and each one grants +4000 independently.
  for (const pet of owner.battlezone) {
    if (normalizeCardKey(cardLabel(pet.id)) !== PETROVA_NAME) continue;
    if (!pet.petrovaRace || pet.key === card.key) continue;
    if (racesOf(card.id).includes(pet.petrovaRace.toLowerCase())) p += 4000;
  }

  // Pala Olesis: during the OPPONENT's turn, your other creatures get +2000
  const pala = namedCard(owner, 'pala olesis, morning guardian');
  if (pala && pala.key !== card.key && state.activeTurn != null && state.activeTurn !== ownerIdx) p += 2000;

  // Quixotic Hero Swine Snout: +3000 for each creature that has entered play since
  // it arrived — permanent, and carries across turns
  if (selfKey === QUIXOTIC_NAME) p += 3000 * (card.qxCount || 0);

  // Super Necrodragon Abzo Dolba: +2000 per creature in your graveyard
  if (selfKey === 'super necrodragon abzo dolba') {
    p += 2000 * owner.graveyard.filter(g => !isSpellCard(g.id)).length;
  }

  // Bolshack Dragon: while ATTACKING, +1000 per fire card in your graveyard
  if (attacking && selfKey === 'bolshack dragon') {
    p += 1000 * owner.graveyard.filter(g => civsOf(g.id).includes('Fire')).length;
  }

  // Magmadragon Ogrist Vhal: +3000 per card in your hand
  if (selfKey === 'magmadragon ogrist vhal') p += 3000 * owner.hand.length;

  // Rikabu Flipper: +2000 per spell you cast this turn
  if (selfKey === 'rikabu flipper, explosive artisan') p += 2000 * (owner.spellsCastThisTurn || 0);

  return p;
}

// How many shields this creature may break, recalculated live because Ogrist Vhal's
// breaker count depends on its current power rather than a fixed flag.
function breakerCount(state, ownerIdx, card) {
  const m = metaOf(card.id);
  if (normalizeCardKey(cardLabel(card.id)) === 'magmadragon ogrist vhal') {
    const p = effectivePower(state, ownerIdx, card, true) || 0;
    if (p >= 15000) return 3;
    if (p >= 6000) return 2;
    return 1;
  }
  if (m.tripleBreaker) return 3;
  if (m.doubleBreaker) return 2;
  return 1;
}

function restrictionOf(id) { return (metaOf(id).attackRestriction || 'none').toLowerCase(); }
function canAttackAtAll(id) { return !restrictionOf(id).includes('cannot attack'); }
function canAttackShields(id) {
  const r = restrictionOf(id);
  return !r.includes('cannot attack') && !r.includes('not players') && !r.includes('blocker only');
}
function canAttackUntapped(id) { return restrictionOf(id).includes('untapped ok'); }
function mustAttackIfAble(id) { return restrictionOf(id).includes('if able'); }
function blockerOnly(id) { return restrictionOf(id).includes('blocker only'); }

// Summoning sickness, unless the creature has Speed Attacker or Turbo Rush is active.
function hasSummoningSickness(state, ownerIdx, card) {
  const owner = state.players[ownerIdx];
  if (card.under && card.under.length) return false;   // evolved: never sick
  if (isEvolutionCard(card.id)) return false;          // evolution creatures can attack at once
  if (metaOf(card.id).speedAttacker) return false;
  if (owner.turboRushActive) return false;
  return card.summonedTurn != null && card.summonedTurn === state.turnNumber;
}

// A block prompt is only worth showing if the defender can actually block this
// attacker — no untapped Blocker, or Light Stealth / unblockable, means no window.
function hasLegalBlocker(state, defender, atkCard) {
  if (atkCard.unblockableThisTurn) return false;
  if (ALWAYS_UNBLOCKABLE.has(normalizeCardKey(cardLabel(atkCard.id)))) return false;
  const m = metaOf(atkCard.id);
  if (m.lightStealth && defender.mana.some(x => civsOf(x.id).includes('Light'))) return false;
  return defender.battlezone.some(c => !c.tapped && metaOf(c.id).blocker);
}

// One shield breaking, shared by the "declare and break in one click" path and the
// extra clicks a double/triple breaker makes. Calls back with a shield-trigger offer
// if that shield can fire one.
function breakOneShield(state, atkIdx, defIdx, attacker, shieldKey, logs, onTrigger) {
  const me = state.players[atkIdx], opp = state.players[defIdx];
  const i = opp.shields.findIndex(sh => sh.key === shieldKey);
  if (i === -1) return false;
  const [sh] = opp.shields.splice(i, 1);
  me.brokeShieldThisTurn = true;
  if (attacker) attacker.brokeShieldThisTurn = true;

  const atkName = attacker ? normalizeCardKey(cardLabel(attacker.id)) : '';
  if (atkName === 'bolmeteus steel dragon') {
    opp.graveyard.push({ id: sh.id, key: sh.key });
    logs.push('broke a shield with Bolmeteus Steel Dragon — it went straight to the graveyard.');
  } else {
    opp.hand.push({ id: sh.id, key: sh.key });
    logs.push('broke a shield.');
    // Cryptic Totem switches the defender's shield triggers off while it is tapped
    const crypticOff = me.battlezone.some(c => normalizeCardKey(cardLabel(c.id)) === 'cryptic totem' && c.tapped);
    if (!crypticOff && hasShieldTrigger(sh.id) && onTrigger) {
      onTrigger({ idx: defIdx, key: sh.key, id: sh.id });
    }
  }
  const cb = state.combat;
  if (cb) {
    cb.shieldsToBreak -= 1;
    if (cb.shieldsToBreak <= 0 || !opp.shields.length) state.combat = null;
  }
  return true;
}

// Attack abilities. Most fire the moment the attack is declared; a few (Trixo) only
// pay off if the attack actually connects without being blocked.
function fireAttackTriggers(state, meIdx, oppIdx, card, logs, when) {
  const me = state.players[meIdx], opp = state.players[oppIdx];
  const trig = ATTACK_TRIGGERS[normalizeCardKey(cardLabel(card.id))];
  if (!trig) return;
  const onHit = trig.effect === 'oppDestroysOwnCreature';   // needs an unblocked connection
  if ((when === 'declare') === onHit) return;

  if (trig.effect === 'oppDiscardRandom') {
    if (opp.hand.length) {
      opp.pendingDiscards.push({ id: newKey(), kind: 'random', count: 1, source: cardLabel(card.id) });
      logs.push('attacked with ' + cardLabel(card.id) + ' — their opponent discards at random.');
    }
  } else if (trig.effect === 'destroyOwnCreature') {
    if (me.battlezone.some(c => c.key !== card.key)) {
      me.pendingTargets.push({ id: newKey(), zone: 'ownBattle', action: 'destroy', filter: null,
                               source: cardLabel(card.id), spellKey: null, sourceKey: card.key });
    }
  } else if (trig.effect === 'ownManaToHand') {
    if (me.mana.length) {
      me.pendingTargets.push({ id: newKey(), zone: 'ownMana', action: 'toHand', filter: null,
                               source: cardLabel(card.id), spellKey: null });
    }
  } else if (trig.effect === 'oppDestroysOwnCreature') {
    if (opp.battlezone.length) {
      opp.pendingTargets.push({ id: newKey(), zone: 'ownBattle', action: 'destroy', filter: null,
                               source: cardLabel(card.id), spellKey: null });
      logs.push(cardLabel(card.id) + " connected — their opponent must destroy one of their own creatures.");
    }
  }
}

// Resolves a battle between two creatures. Returns {needsManual} when a power value
// is missing from the sheet, in which case the players decide the winner themselves.
function resolveBattle(state, aIdx, aCard, dIdx, dCard, logs) {
  const A = state.players[aIdx], D = state.players[dIdx];
  const ap = effectivePower(state, aIdx, aCard, true);    // attacker keeps Power Attacker
  const dp = effectivePower(state, dIdx, dCard, false);   // defender never gets it
  const aName = cardLabel(aCard.id), dName = cardLabel(dCard.id);

  if (ap == null || dp == null) {
    logs.push('battle between ' + aName + ' and ' + dName + ' needs a manual result (power not in the card sheet).');
    return { needsManual: { aIdx, aKey: aCard.key, aName, dIdx, dKey: dCard.key, dName } };
  }

  const aSlayer = !!metaOf(aCard.id).slayer, dSlayer = !!metaOf(dCard.id).slayer;
  const losers = [];
  if (ap > dp) losers.push([D, dCard, dIdx]);
  else if (dp > ap) losers.push([A, aCard, aIdx]);
  else { losers.push([A, aCard, aIdx]); losers.push([D, dCard, dIdx]); }   // tie destroys both

  // Slayer drags the other creature down with it whatever the numbers said
  if (aSlayer && !losers.some(l => l[1].key === dCard.key)) losers.push([D, dCard, dIdx]);
  if (dSlayer && !losers.some(l => l[1].key === aCard.key)) losers.push([A, aCard, aIdx]);

  // "when this creature wins a battle, destroy it" (Bloody Squito, Bone Spider)
  const SELF_DESTRUCT_ON_WIN = new Set(['bloody squito', 'bone spider']);
  const winner = losers.some(l => l[1].key === aCard.key) ? null : aCard;
  const loserD = losers.some(l => l[1].key === dCard.key);
  if (winner && SELF_DESTRUCT_ON_WIN.has(normalizeCardKey(aName)) && loserD) losers.push([A, aCard, aIdx]);
  if (!losers.some(l => l[1].key === dCard.key) && SELF_DESTRUCT_ON_WIN.has(normalizeCardKey(dName))) losers.push([D, dCard, dIdx]);

  logs.push('battle: ' + aName + ' (' + ap + ') vs ' + dName + ' (' + dp + ').');
  for (const [owner, card, ownerIdx] of losers) {
    if (!owner.battlezone.some(c => c.key === card.key)) continue;
    removeBattleCard(owner, card.key);
    const dest = battleCardToGrave(owner, card);
    creatureDestroyed(owner, state.players[ownerIdx === 0 ? 1 : 0], card, logs, dest === 'graveyard');
    logs.push(cardLabel(card.id) + ' was destroyed (to ' + dest + ').');
  }
  if (!losers.length) logs.push('neither creature was destroyed.');
  return {};
}

const QUIXOTIC_NAME = 'quixotic hero swine snout';
// Called whenever a creature enters either battlezone. Every Quixotic already in play
// gains a permanent +3000; the creature arriving doesn't count itself, and creatures
// that were already out when Quixotic arrived never counted.
function onCreatureEnteredBattlezone(state, enteringKey, enteringId) {
  if (isSpellCard(enteringId)) return;
  for (const p of state.players) {
    for (const c of p.battlezone) {
      if (c.key === enteringKey) continue;
      if (normalizeCardKey(cardLabel(c.id)) !== QUIXOTIC_NAME) continue;
      c.qxCount = (c.qxCount || 0) + 1;
    }
  }
}

function opponentOf(room, player) {
  return room.state.players[0] === player ? room.state.players[1] : room.state.players[0];
}

// Mongrel Man: draw one card for each of YOUR OTHER creatures that hits the graveyard.
// Only true destruction counts — bouncing to hand or mana does not, and Mongrel Man
// dying doesn't trigger itself.
function creatureDestroyed(owner, _opp, card, logs, wentToGrave) {
  if (wentToGrave === false) return;
  const name = cardLabel(card.id).toLowerCase();
  if (name === MONGREL_MAN_NAME) return;
  if (isSpellCard(card.id)) return;
  if (!owner.battlezone.some(c => cardLabel(c.id).toLowerCase() === MONGREL_MAN_NAME)) return;
  const drawn = owner.deck.shift();
  if (drawn) {
    owner.hand.push({ id: drawn, key: newKey() });
    logs.push('drew a card from Mongrel Man (' + cardLabel(card.id) + ' was destroyed).');
  }
}

// Once a spell's prompt is done the card leaves the battlezone — usually to the
// graveyard, but a few go elsewhere.
function resolveSpellCard(me, eff, logs) {
  if (!eff.spellKey) return;
  // A spell can queue several prompts (Hydro Hurricane queues one per Light and per
  // Darkness creature). It only leaves the battlezone once the LAST of them is done,
  // otherwise the card would disappear part-way through resolving itself.
  if (me.pendingTargets.some(t => t.spellKey === eff.spellKey)) return;
  const spent = removeBattleCard(me, eff.spellKey);
  if (!spent) return;
  if (!isSpellCard(spent.id)) {           // a creature stays on the battlefield
    me.battlezone.push(spent);
    return;
  }
  if (SPELL_RESOLVES_TO_MANA.has(cardLabel(spent.id).toLowerCase())) {
    const slot = manaSlot(me);
    me.mana.push({ id: spent.id, key: spent.key, tapped: false, x: slot.x, y: slot.y });
    logs.push('put ' + cardLabel(spent.id) + ' into their mana zone.');
  } else {
    me.graveyard.push({ id: spent.id, key: spent.key });
    logs.push('sent ' + cardLabel(spent.id) + ' to the graveyard.');
  }
}

// "The opponent discards from hand."
const OPPONENT_DISCARD_EFFECTS = {
  'ghost touch':   { kind: 'random', count: 1 },
  'locomotiver':   { kind: 'random', count: 1 },
  'cranium clamp': { kind: 'choose', count: 2 },
  'gigabalza':     { kind: 'random', count: 1 },
  'lost soul':     { kind: 'all' }
};

// Tapping your own creature IS attacking, so these fire the moment it's tapped.
const ATTACK_TRIGGERS = {
  'horrid worm':            { effect: 'oppDiscardRandom' },
  'gigabalza':              { effect: 'oppDiscardRandom' },
  'daidalos, general of fury': { effect: 'destroyOwnCreature' },
  'sniper mosquito':        { effect: 'ownManaToHand' },
  'trixo, wicked doll':     { effect: 'oppDestroysOwnCreature' }
};

// Shared by summonCard and castFreeFromHand — both are "a card entered the battlezone" events.
// Returns { defer, sfx, extraLog }: defer means a prompt now owns this card, so a
// spell must NOT be swept to the graveyard until that prompt resolves.
function applyOnSummonTriggers(me, opp, cardId, cardKey) {
  const name = cardLabel(cardId).toLowerCase();
  let defer = false, sfx = null, revealHand = null, peekShields = null;
  const extraLog = [];
  const notices = [];

  if (name === 'corile') {
    me.pendingTargets.push({ id: newKey(), zone: 'oppBattle', action: 'toTopOfDeck', filter: null,
                             source: cardLabel(cardId), spellKey: null, sourceKey: cardKey });
  }
  // Skysword: top card of the deck into mana, then the next into shields face down.
  // Resolves on its own — no prompts, no shuffle.
  if (name === SKYSWORD_NAME) {
    const toMana = me.deck.shift();
    if (toMana) {
      const slot = manaSlot(me);
      me.mana.push({ id: toMana, key: newKey(), tapped: false, x: slot.x, y: slot.y });
    }
    const toShield = me.deck.shift();
    if (toShield) {
      me.shields.push({ id: toShield, key: newKey(), faceUp: false, slot: nextShieldSlot(me) });
    }
    const bits = [];
    if (toMana) bits.push(cardLabel(toMana) + ' to their mana zone');
    if (toShield) bits.push('a card to their shields face down');
    extraLog.push(bits.length ? ('used ' + cardLabel(cardId) + ' to put ' + bits.join(' and ') + '.')
                              : ('used ' + cardLabel(cardId) + ' but their deck was empty.'));
    notices.push({
      self: cardLabel(cardId) + ' \u2014 ' + (toMana ? cardLabel(toMana) + ' went to your mana zone' : 'no card for mana') +
            (toShield ? ', and a new shield was added.' : '.'),
      other: "%p's " + cardLabel(cardId) + ' added a card to their mana zone and a new shield.'
    });
  }

  const targetEff = TARGET_EFFECTS[name];
  if (targetEff) {
    const base = {
      id: newKey(), zone: targetEff.zone, action: targetEff.action,
      filter: targetEff.filter || null, maxPower: targetEff.maxPower || null,
      requireBlocker: !!targetEff.requireBlocker,
      thenSearchSameCost: !!targetEff.thenSearchSameCost, source: cardLabel(cardId),
      // only a SPELL leaves the battlezone once its effect resolves
      spellKey: isSpellCard(cardId) ? cardKey : null,
      sourceKey: cardKey            // never a legal target for its own effect
    };
    if (targetEff.byOpponent) {
      // Comet Missile makes the OPPONENT destroy one of their own creatures. The
      // spell itself is finished, so it isn't deferred waiting on their choice.
      opp.pendingTargets.push(Object.assign({}, base, { zone: 'ownBattle', spellKey: null }));
    } else {
      me.pendingTargets.push(base);
      defer = true;
    }
    // Volcanic Arrows also forces you to bin one of your own shields
    if (targetEff.thenShieldToGrave && me.shields.length) {
      me.pendingTargets.push({
        id: newKey(), zone: 'ownShield', action: 'toGrave', filter: null,
        source: cardLabel(cardId) + ' (shield)', spellKey: isSpellCard(cardId) ? cardKey : null
      });
      defer = true;
    }
    // Rothus makes BOTH players sacrifice a creature
    if (targetEff.alsoOpp && opp.battlezone.length) {
      opp.pendingTargets.push({
        id: newKey(), zone: 'ownBattle', action: 'destroy',
        filter: null, source: cardLabel(cardId), spellKey: null
      });
    }
  }

  // Searing Wave: wipe opposing creatures at or under a power threshold. Creatures
  // whose power isn't in the sheet yet can't be judged automatically, so the caster
  // is asked about those individually instead of guessing.
  const massMax = MASS_POWER_DESTROY[name];
  if (massMax != null) {
    const killed = [], unknown = [];
    for (const card of opp.battlezone.slice()) {
      const pw = powerOf(card.id);
      if (pw == null) { unknown.push(card.key); continue; }
      if (pw > massMax) continue;
      removeBattleCard(opp, card.key);
      const dest = battleCardToGrave(opp, card);
      creatureDestroyed(opp, me, card, extraLog, dest === 'graveyard');
      killed.push(cardLabel(card.id));
    }
    extraLog.push('cast ' + cardLabel(cardId) + ' \u2014 ' + (killed.length ? 'destroyed ' + killed.join(', ') + '.' : 'destroyed nothing automatically.'));
    if (unknown.length) {
      me.pendingMulti = {
        id: newKey(), source: cardLabel(cardId), keys: unknown, spellKey: cardKey,
        prompt: 'These creatures have no power recorded in your spreadsheet. Tick any with power ' + massMax + ' or less to destroy them.'
      };
      defer = true;
    }
  }

  // "Choose up to N" effects
  const multiEff = MULTI_EFFECTS[name];
  if (multiEff) {
    const pool = multiEff.zone === 'oppBattle' ? opp.battlezone
               : multiEff.zone === 'ownGrave'  ? me.graveyard
               : me.battlezone.concat(opp.battlezone);
    let keys = pool.map(c => c.key);
    if (multiEff.filter === 'creature') keys = pool.filter(c => !isSpellCard(c.id)).map(c => c.key);
    if (multiEff.maxPower != null) {
      keys = pool.filter(c => { const pw = powerOf(c.id); return pw == null || pw <= multiEff.maxPower; }).map(c => c.key);
    }
    if (keys.length) {
      me.pendingMulti = { id: newKey(), source: cardLabel(cardId), zone: multiEff.zone, action: multiEff.action,
                          max: multiEff.max, keys: keys.filter(k => k !== cardKey),
                          prompt: multiEff.prompt, spellKey: isSpellCard(cardId) ? cardKey : null };
      defer = true;
    }
  }

  // Crystal Paladin: every blocker on the table goes back to its owner's hand
  if (name === 'crystal paladin') {
    const bounced = [];
    for (const owner of [me, opp]) {
      for (const c of owner.battlezone.slice()) {
        if (c.key === cardKey) continue;
        if (!metaOf(c.id).blocker) continue;
        removeBattleCard(owner, c.key);
        dissolveStack(owner, c, extraLog, 'hand');
        owner.hand.push({ id: c.id, key: c.key });
        bounced.push(cardLabel(c.id));
      }
    }
    extraLog.push('returned every blocker to its owner\'s hand with ' + cardLabel(cardId) + (bounced.length ? ': ' + bounced.join(', ') + '.' : ' — there were none.'));
  }

  // Estol: top of deck becomes a face-down shield, then peek at an opposing shield
  if (name === 'estol, vizier of aqua') {
    const top = me.deck.shift();
    if (top) {
      me.shields.push({ id: top, key: newKey(), faceUp: false, slot: nextShieldSlot(me) });
      extraLog.push('added the top card of their deck to their shields face down.');
    }
    if (opp.shields.length) peekShields = opp.shields.map(sh => ({ key: sh.key, id: sh.id }));
  }

  // Bronze Chain Sickle: top of deck to mana, plus a card tucked under a shield
  if (name === 'bronze chain sickle') {
    const top = me.deck.shift();
    if (top) {
      const slot = manaSlot(me);
      me.mana.push({ id: top, key: newKey(), tapped: false, x: slot.x, y: slot.y });
      extraLog.push('put ' + cardLabel(top) + ' into their mana zone.');
    }
    const under = me.deck.shift();
    if (under && me.shields.length) {
      const sh = me.shields[Math.floor(Math.random() * me.shields.length)];
      sh.stack = (sh.stack || 1) + 1;
      sh.under = sh.under || [];
      sh.under.push(under);
      extraLog.push('tucked a card underneath one of their shields (shield plus).');
    }
  }

  // Dolmarks: both players lose a creature and a card from mana
  if (name === 'dolmarks, the shadow warrior') {
    if (me.battlezone.some(c => c.key !== cardKey)) {
      me.pendingTargets.push({ id: newKey(), zone: 'ownBattle', action: 'destroy', filter: null, source: cardLabel(cardId), spellKey: null });
    }
    if (me.mana.length) {
      me.pendingTargets.push({ id: newKey(), zone: 'ownMana', action: 'toGrave', filter: null, source: cardLabel(cardId) + ' (mana)', spellKey: null });
    }
    if (opp.battlezone.length) {
      opp.pendingTargets.push({ id: newKey(), zone: 'ownBattle', action: 'destroy', filter: null, source: cardLabel(cardId), spellKey: null });
    }
    if (opp.mana.length) {
      opp.pendingTargets.push({ id: newKey(), zone: 'ownMana', action: 'toGrave', filter: null, source: cardLabel(cardId) + ' (mana)', spellKey: null });
    }
  }

  // Galek also makes the opponent pitch a card at random
  if (name === 'galek, the shadow warrior' && opp.hand.length) {
    opp.pendingDiscards.push({ id: newKey(), kind: 'random', count: 1, source: cardLabel(cardId) });
  }

  // Petrova: name a race — your other creatures of that race get +4000 while it stays
  if (name === PETROVA_NAME) {
    me.pendingRaceChoices.push({ id: newKey(), source: cardLabel(cardId), cardKey,
                                 excludeRace: (cardMeta(cardId) || {}).race || null });
  }

  // Miraculous Truce: name a civilization that can't attack you until your next turn
  if (name === 'miraculous truce') {
    me.pendingTruce = { id: newKey(), source: cardLabel(cardId), spellKey: isSpellCard(cardId) ? cardKey : null };
    defer = true;
  }

  // Diamond Cutter: for the rest of this turn your creatures may attack shields
  // regardless of attack restrictions, and without summoning sickness.
  if (name === 'diamond cutter') {
    me.diamondCutterActive = true;   // cleared when this player's turn ends
    extraLog.push('cast Diamond Cutter — their creatures can attack shields freely this turn.');
    notices.push({ self: 'Diamond Cutter — your creatures can attack shields this turn, ignoring restrictions and summoning sickness.',
                   other: "%p's Diamond Cutter — their creatures can attack your shields freely this turn." });
  }

  // Rain of Arrows: the caster sees the opponent's hand, then every darkness spell
  // in it is discarded automatically.
  if (name === 'rain of arrows') {
    revealHand = opp.hand.map(c => c.id);   // snapshot before anything is removed
    const doomed = opp.hand.filter(c => isSpellCard(c.id) && civsOf(c.id).includes('Darkness'));
    for (const c of doomed) {
      const idx = opp.hand.findIndex(h => h.key === c.key);
      if (idx !== -1) {
        opp.hand.splice(idx, 1);
        opp.graveyard.push({ id: c.id, key: c.key });
      }
    }
    const names = doomed.map(c => cardLabel(c.id));
    extraLog.push('cast ' + cardLabel(cardId) + ' \u2014 ' + (names.length ? 'discarded ' + names.join(', ') + " from their opponent's hand." : 'their opponent had no darkness spells.'));
    notices.push({
      self: cardLabel(cardId) + ' \u2014 ' + (names.length ? 'discarded ' + names.join(', ') + '.' : 'no darkness spells to discard.'),
      other: "%p's " + cardLabel(cardId) + ' \u2014 ' + (names.length ? 'you discarded ' + names.join(', ') + '.' : 'you had no darkness spells.')
    });
  }

  // Hydro Hurricane: one optional choice per Light creature (opponent's mana -> their
  // hand) and one per Darkness creature (opponent's creature -> their hand).
  if (name === 'hydro hurricane') {
    const lights = me.battlezone.filter(c => c.key !== cardKey && civsOf(c.id).includes('Light')).length;
    const darks  = me.battlezone.filter(c => c.key !== cardKey && civsOf(c.id).includes('Darkness')).length;
    for (let n = 0; n < lights; n++) {
      me.pendingTargets.push({ id: newKey(), zone: 'oppMana', action: 'returnToHand', filter: null,
                               source: cardLabel(cardId) + ' (Light)', spellKey: isSpellCard(cardId) ? cardKey : null, sourceKey: cardKey });
    }
    for (let n = 0; n < darks; n++) {
      me.pendingTargets.push({ id: newKey(), zone: 'oppBattle', action: 'returnToHand', filter: null,
                               source: cardLabel(cardId) + ' (Darkness)', spellKey: isSpellCard(cardId) ? cardKey : null, sourceKey: cardKey });
    }
    if (lights || darks) defer = true;
    extraLog.push('cast ' + cardLabel(cardId) + ' with ' + lights + ' light and ' + darks + ' darkness creature' + ((lights + darks) === 1 ? '' : 's') + ' in the battle zone.');
  }

  // Bronze-Arm Tribe: top of deck straight into mana, no prompt, no shuffle
  if (AUTO_MANA_FROM_DECK.has(name)) {
    const top = me.deck.shift();
    if (top) {
      const slot = manaSlot(me);
      me.mana.push({ id: top, key: newKey(), tapped: false, x: slot.x, y: slot.y });
      extraLog.push('put ' + cardLabel(top) + ' from the top of their deck into their mana zone with ' + cardLabel(cardId) + '.');
      notices.push({ self: cardLabel(cardId) + ' \u2014 ' + cardLabel(top) + ' went to your mana zone.',
                     other: "%p's " + cardLabel(cardId) + ' put ' + cardLabel(top) + ' into their mana zone.' });
    }
  }

  // Holy Awe: tap everything the opponent has untapped
  if (TAP_ALL_OPP.has(name)) {
    let n = 0;
    for (const c of opp.battlezone) { if (!c.tapped) { c.tapped = true; n++; } }
    extraLog.push('tapped ' + n + " of their opponent's creature" + (n === 1 ? '' : 's') + ' with ' + cardLabel(cardId) + '.');
    notices.push({ self: cardLabel(cardId) + ' \u2014 tapped ' + n + " of your opponent's creatures.",
                   other: "%p's " + cardLabel(cardId) + ' tapped ' + n + ' of your creatures.' });
  }

  const discardEff = OPPONENT_DISCARD_EFFECTS[name];
  if (discardEff) opp.pendingDiscards.push({ id: newKey(), kind: discardEff.kind, count: discardEff.count || 0, source: cardLabel(cardId) });

  // automatic draws — no prompt, resolves immediately
  const drawCount = AUTO_DRAW_ON_SUMMON[name];
  if (drawCount) {
    let drawn = 0;
    for (let i = 0; i < drawCount; i++) {
      const c = me.deck.shift();
      if (!c) break;
      me.hand.push({ id: c, key: newKey() });
      drawn++;
    }
    extraLog.push('drew ' + drawn + ' card' + (drawn === 1 ? '' : 's') + ' with ' + cardLabel(cardId) + '.');
    notices.push({ self: cardLabel(cardId) + ' \u2014 you drew ' + drawn + ' card' + (drawn === 1 ? '' : 's') + '.',
                   other: cardLabel(cardId) + ' let %p draw ' + drawn + ' card' + (drawn === 1 ? '' : 's') + '.' });
    sfx = 'draw';
  }

  // automatic deck search (Crystal Memory)
  const searchOpts = AUTO_SEARCH_ON_SUMMON[name];
  if (searchOpts) {
    me.pendingSearch = { id: newKey(), source: cardLabel(cardId), spellKey: cardKey,
                         filter: searchOpts.filter, reveal: searchOpts.reveal };
    defer = true;
  }

  // Ballom: wipe every non-Darkness creature on both sides
  if (MASS_DESTROY_CARDS.has(name)) {
    const killed = [];
    for (const owner of [me, opp]) {
      for (const card of owner.battlezone.slice()) {
        if (card.key === cardKey) continue;                       // Ballom itself survives
        if (civsOf(card.id).includes('Darkness')) continue;        // Darkness creatures survive
        removeBattleCard(owner, card.key);
        const dest = battleCardToGrave(owner, card);
        creatureDestroyed(owner, owner === me ? opp : me, card, extraLog, dest === 'graveyard');
        killed.push(cardLabel(card.id) + (dest === 'mana zone' ? ' (to mana)' : ''));
      }
    }
    extraLog.push('played ' + cardLabel(cardId) + ', destroying ' + (killed.length ? killed.join(', ') : 'nothing') + '.');
    notices.push({ self: cardLabel(cardId) + ' \u2014 every non-Darkness creature destroyed.',
                   other: "%p's " + cardLabel(cardId) + ' destroyed every non-Darkness creature.' });
    sfx = 'ballom';
  }

  // Ice Vapor is a passive on the OPPONENT's board: casting a spell into it costs
  // the caster a card from hand and one from mana. Each half is only queued if the
  // caster actually has cards there — otherwise it would sit pending forever.
  if (isSpellCard(cardId) && opp.battlezone.some(c => cardLabel(c.id).toLowerCase() === ICE_VAPOR_NAME)) {
    if (me.hand.length) {
      me.pendingDiscards.push({ id: newKey(), kind: 'choose', count: 1, source: 'Ice Vapor, Shadow of Anguish' });
    }
    if (me.mana.length) {
      me.pendingManaDiscards = (me.pendingManaDiscards || 0) + 1;
    }
  }

  return { defer, sfx, extraLog, notices, revealHand, peekShields };
}

// Cards with Shield Trigger — when returned to hand FROM the shield zone specifically
// (not destroyed, not from mana), the player may cast them immediately for free.
const SHIELD_TRIGGER_CARDS = new Set([
  'holy awe', 'solar ray', 'apocalypse day', 'logic cube', 'logic sphere', 'super spark',
  'miele, vizier of lightning', 'kolon, the oracle', 'phal eega, dawn guardian',
  'syforce, aurora elemental', 'spiral gate', 'teleportation', 'brain serum', 'crystal memory',
  'liquid scope', 'aqua surfer', 'hunter fish', 'aqua jolter', 'terror pit', 'ghost touch',
  'dark reversal', 'critical blade', 'zombie carnival', 'bone assassin, the ambusher',
  'locomotiver', 'burst shot', 'tornado flame', "phantom dragon's flame",
  'natural snare', 'dimension gate', 'mana crisis', 'mystic inscription', 'torcon', 'dome shell',
  'mighty shouter'
]);
function hasShieldTrigger(id) {
  if (SHIELD_TRIGGER_CARDS.has(normalizeCardKey(cardLabel(id)))) return true;
  return !!metaOf(id).shieldTrigger;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emptyPlayerState() {
  return {
    hand: [], deck: [], mana: [], battlezone: [], shields: [], graveyard: [],
    showingHand: false, pendingCorileUses: 0, pendingSkyswordMana: 0, pendingSkyswordShield: 0, pendingBronzeArm: 0,
    pendingTargets: [], pendingDiscards: [], pendingManaDiscards: 0, pendingSearch: null, pendingMulti: null,
    spellsCastThisTurn: 0, turboRushActive: false, brokeShieldThisTurn: false, diamondCutterActive: false,
    pendingTruce: null, truceCiv: null, truceUntilTurn: null,
    pendingRaceChoices: []
  };
}

function send(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

function broadcastState(room) {
  for (let i = 0; i < 2; i++) {
    const ws = room.sockets[i];
    if (!ws) continue;
    send(ws, { type: 'state', you: i, state: viewFor(room, i) });
  }
}
function broadcastRaw(room, msg) {
  for (let i = 0; i < 2; i++) send(room.sockets[i], msg);
}
function nameFor(room, idx) {
  const ws = room.sockets[idx];
  if (!ws) return null;
  const m = connMeta.get(ws);
  return (m && m.name) || null;
}
function playerLabel(room, idx) {
  return nameFor(room, idx) || ('Player ' + (idx + 1));
}
// Log lines are written per-viewer so the acting player reads "You drew a card."
// while their opponent reads "jobster drew a card." — text passed in is a verb phrase.
// The log always names the acting player, which reads better as a shared record of
// the match — and matters in practice mode, where "you" flips meaning as you switch
// sides. Text arrives in third person, so it needs no rewriting.
function logMsg(room, idx, text) {
  const line = playerLabel(room, idx) + ' ' + text;
  for (let i = 0; i < 2; i++) {
    const ws = room.sockets[i];
    if (!ws) continue;
    send(ws, { type: 'log', fromIdx: idx, text: line });
  }
}

// An on-screen toast for things the engine did automatically, so an effect
// resolving isn't something you only find out by reading the log.
// '%p' in otherText is replaced with the acting player's name.
function noticeMsg(room, idx, selfText, otherText) {
  for (let i = 0; i < 2; i++) {
    const ws = room.sockets[i];
    if (!ws) continue;
    const text = (i === idx) ? selfText : otherText.replace(/%p/g, playerLabel(room, idx));
    send(ws, { type: 'notice', text });
  }
}

function viewFor(room, viewerIdx) {
  const s = room.state;
  const mask = (p, isSelf) => ({
    hand: p.hand.map(c => ({ key: c.key, id: (isSelf || p.showingHand) ? c.id : undefined })),
    showingHand: isSelf ? p.showingHand : undefined,
    deckCount: p.deck.length,
    mana: p.mana,
    battlezone: p.battlezone.map(c => {
      const ownerIdx = s.players.indexOf(p);
      // livePower deliberately excludes Power Attacker — that bonus is shown separately
      // and only while the creature is tapped from attacking.
      return Object.assign({}, c, {
        livePower: effectivePower(s, ownerIdx, c, false),
        basePower: (cardMeta(c.id) || {}).power != null ? cardMeta(c.id).power : null,
        powerAttacker: (cardMeta(c.id) || {}).powerAttacker || null
      });
    }),
    shields: p.shields.map(sh => ({ key: sh.key, faceUp: sh.faceUp, slot: sh.slot, id: sh.faceUp ? sh.id : undefined })),
    graveyard: p.graveyard,
    pendingCorileUses: isSelf ? (p.pendingCorileUses || 0) : undefined,
    pendingSkyswordMana: isSelf ? (p.pendingSkyswordMana || 0) : undefined,
    pendingSkyswordShield: isSelf ? (p.pendingSkyswordShield || 0) : undefined,
    pendingBronzeArm: isSelf ? (p.pendingBronzeArm || 0) : undefined,
    pendingTargets: isSelf ? p.pendingTargets : undefined,
    pendingDiscards: isSelf ? p.pendingDiscards : undefined,
    pendingManaDiscards: isSelf ? (p.pendingManaDiscards || 0) : undefined,
    pendingSearch: isSelf ? p.pendingSearch : undefined,
    pendingMulti: isSelf ? p.pendingMulti : undefined,
    turboRushActive: !!p.turboRushActive,
    diamondCutterActive: !!p.diamondCutterActive,
    pendingTruce: isSelf ? p.pendingTruce : undefined,
    pendingRaceChoice: isSelf ? (p.pendingRaceChoices[0] || null) : undefined,
    truceCiv: p.truceCiv || null,
    brokeShieldThisTurn: !!p.brokeShieldThisTurn
  });
  return {
    dealt: [!!room.decks[0], !!room.decks[1]],
    names: [nameFor(room, 0), nameFor(room, 1)],
    gameOver: s.gameOver,
    endGameRequestBy: s.endGameRequestBy,
    surrenderBy: s.surrenderBy,
    rematch: s.rematch,
    soundMap: s.soundMap,
    activeTurn: s.activeTurn,
    turnNumber: s.turnNumber,
    combat: s.combat,
    players: [mask(s.players[0], viewerIdx === 0), mask(s.players[1], viewerIdx === 1)],
    you: viewerIdx
  };
}

// y is "distance from the owner's own base": 0 = right at their shields.
// Clamped because a card is taller than the half-zone is deep — going higher
// pushes the card body out past the zone and into the shield row.
// Cards render at 1.35x in the battlezone, so columns are spaced wider to match.
// Picks the first UNOCCUPIED slot rather than counting cards: after something dies
// the count drops, and reusing that index would drop the next summon on top of a
// creature that's still there.
function battlefieldSlot(me) {
  const cols = 7;
  const slotXY = i => ({ x: 2 + (i % cols) * 13.8, y: Math.min(20, Math.floor(i / cols) * 20) });
  const taken = pos => me.battlezone.some(c =>
    c.x != null && Math.abs(c.x - pos.x) < 4 && Math.abs((c.y == null ? 0 : c.y) - pos.y) < 6);
  for (let i = 0; i < cols * 3; i++) {
    const pos = slotXY(i);
    if (!taken(pos)) return pos;
  }
  return slotXY(me.battlezone.length % (cols * 3));
}

// Single row — overlap is fine and preferred over wrapping to a second row.
function manaSlot(me) {
  const slot = me.mana.length;
  const cols = 14;
  const col = slot % cols;
  // y is a small inset, not 0: absolutely positioned cards measure from the zone's
  // border, so y=0 makes the card sit flush against the edge and look like it's
  // spilling out of the zone.
  return { x: 2 + col * 7, y: 5 };
}

// Shields keep a fixed slot so breaking one leaves a visible gap instead of the
// rest sliding over. A newly added shield fills the lowest free slot.
function nextShieldSlot(me) {
  const used = new Set(me.shields.map(s => s.slot));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

function cardMeta(id) { ensureCardDatabaseFresh(); return CARD_DB.get(normalizeCardKey(cardLabel(id))) || null; }

// Figures out which untapped mana cards would pay for a card, respecting both
// the total cost and needing at least one untapped mana of each required
// civilization. Returns a Set of mana keys to tap, or null if it can't be paid.
// Pure/read-only — callers tap the returned keys themselves.
//
// After covering the civilization requirements, the remaining generic cost is
// filled by preferring whichever civilization currently has the MOST spare
// untapped mana — e.g. with 2 Nature + 2 Fire untapped and a cost-2 mono-Nature
// card, this pays with 1 Nature + 1 Fire (not 2 Nature), so a second copy of
// that same card can still be paid for afterward instead of getting starved.
function planManaPayment(me, meta) {
  const untapped = me.mana.filter(m => !m.tapped);
  if (untapped.length < meta.cost) return null;
  const reserved = new Set();
  for (const civ of (meta.civs || [])) {
    const found = untapped.find(m => {
      if (reserved.has(m.key)) return false;
      const mMeta = cardMeta(m.id);
      return mMeta && mMeta.civs.includes(civ);
    });
    if (!found) return null;
    reserved.add(found.key);
  }
  while (reserved.size < meta.cost) {
    const remaining = untapped.filter(m => !reserved.has(m.key));
    if (!remaining.length) return null;
    const civCounts = new Map();
    for (const m of remaining) {
      const mMeta = cardMeta(m.id);
      const civs = (mMeta && mMeta.civs.length) ? mMeta.civs : ['__unknown__'];
      for (const cv of civs) civCounts.set(cv, (civCounts.get(cv) || 0) + 1);
    }
    let best = remaining[0], bestScore = -1;
    for (const m of remaining) {
      const mMeta = cardMeta(m.id);
      const civs = (mMeta && mMeta.civs.length) ? mMeta.civs : ['__unknown__'];
      const score = Math.max(...civs.map(cv => civCounts.get(cv) || 0));
      if (score > bestScore) { bestScore = score; best = m; }
    }
    reserved.add(best.key);
  }
  return reserved;
}

function dealPlayer(room, idx) {
  const s = room.state;
  const deck = shuffle(room.decks[idx]);
  const p = s.players[idx];
  p.shields = deck.splice(0, 6).map((id, i) => ({ id, key: newKey(), targeted: false, faceUp: false, slot: i }));
  p.hand = deck.splice(0, 5).map(id => ({ id, key: newKey() }));
  p.deck = deck;
  p.battlezone = []; p.mana = []; p.graveyard = []; p.showingHand = false;
}

function freshMatchState() {
  return {
    gameOver: null, endGameRequestBy: null, surrenderBy: null, rematch: [false, false],
    soundMap: Math.random() < 0.5 ? [0, 1] : [1, 0], // which chat-tone index (0 or 1) each player idx uses
    // Purely advisory — nothing is actually locked to turns, this just tracks
    // whose turn the players have agreed it is. null until someone ends a turn.
    activeTurn: null,
    turnNumber: 0,
    creaturesEnteredThisTurn: 0,
    combat: null,          // the in-progress attack, if any
    players: [emptyPlayerState(), emptyPlayerState()]
  };
}

function cleanupRoom(room) {
  if (!room.sockets[0] && !room.sockets[1] && !room.pendingJoin) rooms.delete(room.code);
}

wss.on('connection', (ws) => {
  connMeta.set(ws, { roomCode: null, idx: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = connMeta.get(ws);

    if (msg.type === 'create') {
      const roomCode = newRoomCode();
      const room = { code: roomCode, sockets: [ws, null], pendingJoin: null, decks: [null, null], state: freshMatchState() };
      rooms.set(roomCode, room);
      meta.roomCode = roomCode; meta.idx = 0;
      meta.name = (msg.name || '').trim().slice(0, 24) || null;
      send(ws, { type: 'joined', room: roomCode, you: 0 });
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get((msg.room || '').toUpperCase());
      if (!room) { send(ws, { type: 'error', message: 'Room not found.' }); return; }
      if (room.sockets[1]) { send(ws, { type: 'error', message: 'Room is full.' }); return; }
      if (!room.sockets[0]) { send(ws, { type: 'error', message: 'Host is not connected.' }); return; }
      if (room.pendingJoin) { send(ws, { type: 'error', message: 'Someone else is already asking to join — try again shortly.' }); return; }
      room.pendingJoin = ws;
      meta.roomCode = room.code; meta.idx = null;
      meta.name = (msg.name || '').trim().slice(0, 24) || null;
      send(ws, { type: 'joinPending' });
      send(room.sockets[0], { type: 'joinRequest', name: meta.name });
      return;
    }

    if (msg.type === 'respondJoin') {
      const room = rooms.get(meta.roomCode);
      if (!room || meta.idx !== 0 || !room.pendingJoin) return;
      const reqWs = room.pendingJoin;
      room.pendingJoin = null;
      if (msg.accept) {
        room.sockets[1] = reqWs;
        connMeta.get(reqWs).idx = 1;
        send(reqWs, { type: 'joined', room: room.code, you: 1 });
        broadcastState(room);
      } else {
        send(reqWs, { type: 'joinDeclined' });
      }
      return;
    }

    if (!meta.roomCode || meta.idx === null) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const idx = meta.idx;
    const oppIdx = idx === 0 ? 1 : 0;
    const s = room.state;

    if (msg.type === 'submitDeck') {
      if (!Array.isArray(msg.deck) || !msg.deck.length) return;
      room.decks[idx] = msg.deck.slice(0, 40);
      dealPlayer(room, idx);
      broadcastState(room);
      logMsg(room, idx, 'joined the table and drew their opening hand.');
      return;
    }

    if (msg.type === 'flash') {
      broadcastRaw(room, { type: 'flash', zone: msg.zone, ownerIdx: msg.ownerIdx, key: msg.key });
      return;
    }

    if (msg.type === 'chatMessage') {
      const text = (msg.text || '').toString().trim().slice(0, 500);
      if (!text) return;
      broadcastRaw(room, { type: 'chat', from: playerLabel(room, idx), fromIdx: idx, text });
      return;
    }

    if (msg.type === 'requestSearchDeck') {
      if (!room.decks[idx]) return;
      const me0 = s.players[idx];
      if (!canSearchDeck(me0)) return;
      send(ws, { type: 'searchDeckOffer', cards: me0.deck.map((id, index) => ({ index, id })), filter: null, source: 'Search Deck' });
      return;
    }

    if (!room.decks[idx]) return; // must have dealt your own hand first
    const me = s.players[idx];
    const opp = s.players[oppIdx];

    // An unpaid Ice Vapor mana cost blocks the caster's own plays until it's paid.
    // Only their own board actions are gated — they can still chat, resolve the
    // debt itself, tap/untap, or concede, so it can never soft-lock the game.
    const BLOCKED_WHILE_OWING = new Set([
      'chargeMana', 'summonCard', 'castFreeFromHand', 'drawCard', 'shuffleDeck',
      'requestSearchDeck', 'searchDeckPick', 'endTurn',
      'skyswordToMana', 'skyswordToShield', 'bronzeArmToMana'
    ]);
    if (me.pendingManaDiscards > 0 && BLOCKED_WHILE_OWING.has(msg.type)) {
      send(ws, { type: 'summonRejected', reason: 'Ice Vapor: you must send a card from your mana zone to the graveyard first.\n\nRight-click a card in your mana zone and choose "Send to Graveyard (Ice Vapor)".' });
      return;
    }

    let logText = null; // set by a case below to emit a log line after the switch
    const extraLogs = []; // additional log lines from automatic card effects
    const pendingNotices = []; // on-screen toasts for automatic effects: {self, other}
    const endTurnPrompts = []; // end-of-turn questions only the player can answer
    let revealPayload = null; // a hand shown to the caster (Rain of Arrows)
    let manualBattle = null;    // set when a battle can't be judged from the sheet
    let shieldTriggerFor = null; // a broken shield that may fire its trigger
    let winCheck = false, winnerIdx = null;  // an unblocked attack landed on a shieldless opponent
    const searchAlreadyOpen = !!me.pendingSearch; // so an auto-search only opens once
    let shieldTriggerOfferKey = null, shieldTriggerOfferId = null; // set when a shield-trigger card is returned to hand
    let sfxToPlay = null; // set by a case below to broadcast a sound-effect cue

    switch (msg.type) {
      case 'drawCard': {
        const c = me.deck.shift();
        if (c) {
          me.hand.push({ id: c, key: newKey() });
          // Off-turn draws are legitimate (shield triggers, forced draws, etc.) but
          // are flagged in the log so an accidental one is easy to spot after the fact.
          const offTurn = (s.activeTurn !== null && s.activeTurn !== undefined && s.activeTurn !== idx);
          logText = offTurn ? 'drew a card OUT OF TURN.' : 'drew a card.';
          sfxToPlay = 'draw';
        }
        break;
      }
      case 'shuffleDeck': { me.deck = shuffle(me.deck); logText = 'shuffled their deck.'; break; }
      case 'endTurn': {
        if (s.combat) { send(ws, { type: 'summonRejected', reason: 'Finish resolving the current attack first.' }); return; }
        // end of MY turn: bounce cards that go home, and ask about shield-break returns
        for (const c of me.battlezone.slice()) {
          const nm = normalizeCardKey(cardLabel(c.id));
          if (END_TURN_RETURN_TO_HAND.has(nm) || nm === 'bazagazeal dragon') {
            removeBattleCard(me, c.key);
            me.hand.push({ id: c.id, key: c.key });
            extraLogs.push('returned ' + cardLabel(c.id) + ' to their hand at end of turn.');
          } else if (nm === 'ruby grass' && c.tapped) {
            endTurnPrompts.push({ key: c.key, name: cardLabel(c.id), kind: 'untap' });
          } else if (END_TURN_SHIELD_PROMPT.has(nm) && c.tapped && c.brokeShieldThisTurn) {
            // Polligon only goes home if it actually broke a shield, which the engine now knows
            removeBattleCard(me, c.key);
            me.hand.push({ id: c.id, key: c.key });
            extraLogs.push('returned ' + cardLabel(c.id) + ' to their hand (it broke a shield this turn).');
          }
        }
        // per-turn counters reset as the turn passes
        me.spellsCastThisTurn = 0; me.turboRushActive = false; me.brokeShieldThisTurn = false; me.diamondCutterActive = false;
        for (const c of me.battlezone) { c.brokeShieldThisTurn = false; c.attackedThisTurn = false; }
        s.creaturesEnteredThisTurn = 0;

        s.activeTurn = oppIdx;
        s.turnNumber = (s.turnNumber || 0) + 1;
        // untap step: the player whose turn is starting untaps their mana and creatures
        let untapped = 0;
        for (const m of opp.mana) { if (m.tapped) { m.tapped = false; untapped++; } }
        for (const c of opp.battlezone) { if (c.tapped) { c.tapped = false; untapped++; } c.atkResolved = false; }
        // Miraculous Truce expires at the start of its caster's next turn
        if (opp.truceUntilTurn != null && s.turnNumber >= opp.truceUntilTurn) { opp.truceCiv = null; opp.truceUntilTurn = null; }
        logText = 'ended their turn.' + (untapped ? " (Opponent's cards untapped.)" : '');
        sfxToPlay = 'turn';
        break;
      }
      case 'claimTurn': {
        s.activeTurn = idx;
        logText = 'took the turn.';
        break;
      }

      case 'chargeMana': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        const mSlot = manaSlot(me);
        const arrivesTapped = ENTERS_MANA_TAPPED.has(cardLabel(c.id).toLowerCase());
        me.mana.push({ id: c.id, key: c.key, tapped: arrivesTapped, x: mSlot.x, y: mSlot.y });
        logText = 'charged ' + cardLabel(c.id) + ' to their mana zone' + (arrivesTapped ? ' (tapped).' : '.');
        break;
      }
      case 'summonCard': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const cardId = me.hand[i].id;
        // Alcadeias locks out non-light spells for BOTH players, including its controller
        if (isSpellCard(cardId) && !civsOf(cardId).includes('Light')) {
          const holder = [me, opp].find(p => p.battlezone.some(c => cardLabel(c.id).toLowerCase() === ALCADEIAS_NAME));
          if (holder) {
            send(ws, { type: 'summonRejected', reason: 'Alcadeias, Lord of Spirits is in the battle zone — only light spells can be cast.' });
            return;
          }
        }
        const metaRaw = cardMeta(cardId);
        // Volcano Smog, Deceptive Shade taxes Light cards by 2 while it's in play
        const smog = [me, opp].some(p => p.battlezone.some(c => normalizeCardKey(cardLabel(c.id)) === 'volcano smog, deceptive shade'));
        const meta = (metaRaw && smog && civsOf(cardId).includes('Light') && metaRaw.cost != null)
          ? Object.assign({}, metaRaw, { cost: metaRaw.cost + 2 })
          : metaRaw;
        if (meta && meta.cost != null) {
          const plan = planManaPayment(me, meta);
          if (!plan) {
            const civText = meta.civs.length ? (' (needs ' + meta.civs.join('/') + ' civilization mana)') : '';
            const untappedDesc = me.mana.filter(m => !m.tapped).map(m => {
              const mMeta = cardMeta(m.id);
              const civLabel = !mMeta ? 'not found in card database' : (mMeta.civs.length ? mMeta.civs.join('/') : 'no civilization data');
              return cardLabel(m.id) + ' [' + civLabel + ']';
            }).join(', ') || 'none';
            send(ws, {
              type: 'summonRejected',
              reason: 'Not enough mana to summon ' + cardLabel(cardId) + ' — costs ' + meta.cost + civText + '.\n\nYour untapped mana: ' + untappedDesc
            });
            return;
          }
          plan.forEach(k => { const m = me.mana.find(mm => mm.key === k); if (m) m.tapped = true; });
        }
        // Evolution creatures are never summoned onto empty ground — they stack onto
        // one of your creatures that shares a race with them.
        let evoBase = null;
        if (isEvolutionCard(cardId)) {
          const legal = me.battlezone.filter(b => canEvolveOnto(cardId, b.id));
          if (!legal.length) {
            const need = (cardMeta(cardId) || {}).race || 'a matching race';
            send(ws, { type: 'summonRejected', reason: cardLabel(cardId) + ' is an evolution creature — you need a ' + need + ' creature in your battle zone to evolve from.' });
            return;
          }
          if (!msg.baseKey) {
            send(ws, { type: 'summonRejected', reason: 'Choose which creature ' + cardLabel(cardId) + ' evolves from.' });
            return;
          }
          evoBase = legal.find(b => b.key === msg.baseKey);
          if (!evoBase) {
            send(ws, { type: 'summonRejected', reason: cardLabel(cardId) + " can't evolve from that creature — the races don't match." });
            return;
          }
        }

        const [c] = me.hand.splice(i, 1);
        let x, y, inheritTapped = false, stack = [];
        if (evoBase) {
          // take the base's position, and inherit anything already stacked under it
          x = evoBase.x; y = evoBase.y;
          inheritTapped = !!evoBase.tapped;
          stack = (evoBase.under || []).concat([{ id: evoBase.id, key: evoBase.key }]);
          removeBattleCard(me, evoBase.key);
        } else {
          const slot = battlefieldSlot(me);
          x = slot.x; y = slot.y;
        }
        // An evolution creature never has summoning sickness, so it simply doesn't
        // record an arrival turn — that way it can't be flagged as sick by either
        // side even if the card database hasn't loaded yet.
        me.battlezone.push({ id: c.id, key: c.key, tapped: inheritTapped, x, y,
                             summonedTurn: evoBase ? null : s.turnNumber,
                             brokeShieldThisTurn: false, under: stack });
        onCreatureEnteredBattlezone(s, c.key, c.id);
        if (evoBase) extraLogs.push('evolved ' + cardLabel(c.id) + ' from ' + cardLabel(evoBase.id) + '.');
        if (isSpellCard(c.id)) me.spellsCastThisTurn = (me.spellsCastThisTurn || 0) + 1;
        else s.creaturesEnteredThisTurn = (s.creaturesEnteredThisTurn || 0) + 1;
        // Turbo Rush: if one of your creatures already broke a shield this turn, your
        // creatures gain Speed Attacker for the rest of it
        if (metaOf(c.id).turboRush && me.brokeShieldThisTurn) {
          me.turboRushActive = true;
          extraLogs.push('activated Turbo Rush — their creatures have Speed Attacker this turn.');
        }
        logText = 'summoned ' + cardLabel(c.id) + '.';
        {
          const res = applyOnSummonTriggers(me, opp, c.id, c.key);
          if (res.sfx) sfxToPlay = res.sfx;
          res.extraLog.forEach(t => extraLogs.push(t));
          (res.notices || []).forEach(n => pendingNotices.push(n));
          if (res.revealHand) revealPayload = { title: "Your opponent's hand", cards: res.revealHand };
          if (res.peekShields) revealPayload = { title: "One of your opponent's shields", cards: [res.peekShields[Math.floor(Math.random() * res.peekShields.length)].id] };
          // a spell has done its job once nothing is waiting on it
          if (isSpellCard(c.id) && !res.defer) {
            const spent = removeBattleCard(me, c.key);
            if (spent) { me.graveyard.push({ id: spent.id, key: spent.key }); extraLogs.push('sent ' + cardLabel(spent.id) + ' to the graveyard.'); }
          }
        }
        break;
      }
      case 'castFreeFromHand': {
        // Glena Vuele watches for the opponent casting a shield trigger
        if (opp.battlezone.some(c => normalizeCardKey(cardLabel(c.id)) === 'glena vuele, the hypnotic')) {
          const top = opp.deck.shift();
          if (top) {
            opp.shields.push({ id: top, key: newKey(), faceUp: false, slot: nextShieldSlot(opp) });
            extraLogs.push('triggered Glena Vuele — their opponent added a card to their shields.');
          }
        }
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        if (!hasShieldTrigger(me.hand[i].id)) return; // only valid for actual Shield Trigger cards
        const [c] = me.hand.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y, summonedTurn: s.turnNumber, brokeShieldThisTurn: false, under: [] });
        onCreatureEnteredBattlezone(s, c.key, c.id);
        if (isSpellCard(c.id)) me.spellsCastThisTurn = (me.spellsCastThisTurn || 0) + 1;
        else s.creaturesEnteredThisTurn = (s.creaturesEnteredThisTurn || 0) + 1;
        logText = 'used Shield Trigger to cast ' + cardLabel(c.id) + ' for free.';
        sfxToPlay = 'shieldTrigger';
        {
          const res = applyOnSummonTriggers(me, opp, c.id, c.key);
          res.extraLog.forEach(t => extraLogs.push(t));
          (res.notices || []).forEach(n => pendingNotices.push(n));
          if (res.revealHand) revealPayload = { title: "Your opponent's hand", cards: res.revealHand };
          if (res.peekShields) revealPayload = { title: "One of your opponent's shields", cards: [res.peekShields[Math.floor(Math.random() * res.peekShields.length)].id] };
          if (isSpellCard(c.id) && !res.defer) {
            const spent = removeBattleCard(me, c.key);
            if (spent) { me.graveyard.push({ id: spent.id, key: spent.key }); extraLogs.push('sent ' + cardLabel(spent.id) + ' to the graveyard.'); }
          }
        }
        break;
      }
      case 'discardFromHand': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'discarded ' + cardLabel(c.id) + '.';
        break;
      }
      case 'handCardToDeckShuffle': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        me.deck.push(c.id);
        me.deck = shuffle(me.deck);
        logText = 'returned a card from hand to their deck and shuffled.';
        break;
      }
      case 'setShowingHand': {
        me.showingHand = !!msg.show;
        logText = me.showingHand ? 'started showing their hand to their opponent.' : 'stopped showing their hand.';
        break;
      }

      case 'manaTap': {
        const c = me.mana.find(c => c.key === msg.key);
        if (c) { c.tapped = !c.tapped; logText = (c.tapped ? 'tapped ' : 'untapped ') + cardLabel(c.id) + ' in their mana zone.'; }
        break;
      }
      case 'manaMove': {
        const c = me.mana.find(c => c.key === msg.key);
        if (c) { c.x = msg.x; c.y = msg.y; logText = 'repositioned ' + cardLabel(c.id) + ' in their mana zone.'; }
        break;
      }
      case 'manaReturnToHand': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.mana.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' from mana to hand.';
        break;
      }
      case 'manaDestroy': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.mana.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'sent ' + cardLabel(c.id) + ' from mana to the graveyard.';
        break;
      }
      case 'manaToDeckShuffle': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.mana.splice(i, 1);
        me.deck.push(c.id);
        me.deck = shuffle(me.deck);
        logText = 'put ' + cardLabel(c.id) + ' from mana back into their deck and shuffled.';
        break;
      }

      case 'shieldReturnToHand': {
        const i = me.shields.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.shields.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = c.faceUp ? ('returned shield ' + cardLabel(c.id) + ' to hand.') : 'returned a shield to hand.';
        if (hasShieldTrigger(c.id)) { shieldTriggerOfferKey = c.key; shieldTriggerOfferId = c.id; }
        break;
      }
      case 'shieldToGraveyard': {
        const i = me.shields.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.shields.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'put a shield (' + cardLabel(c.id) + ') into the graveyard.';
        break;
      }
      case 'shieldFlip': {
        const c = me.shields.find(c => c.key === msg.key);
        if (c) { c.faceUp = !c.faceUp; logText = c.faceUp ? ('flipped a shield face up: ' + cardLabel(c.id) + '.') : 'turned a shield back face down.'; }
        break;
      }

      case 'battleTap': {
        // own creatures only — cards that tap an opponent's creature (Solar Ray etc.)
        // go through the targeting effects instead
        const c = me.battlezone.find(c => c.key === msg.key);
        if (!c) return;
        const name = cardLabel(c.id).toLowerCase();

        if (!c.tapped) {
          // Snip Striker Bullraizer can't attack while outnumbered
          if (name === BULLRAIZER_NAME && opp.battlezone.length > me.battlezone.length) {
            send(ws, { type: 'summonRejected', reason: cardLabel(c.id) + " can't attack while your opponent has more creatures in the battle zone than you do." });
            return;
          }
          // Gigazald lets your other Darkness creatures tap for an ability instead of attacking
          const gigazald = me.battlezone.some(g => normalizeCardKey(cardLabel(g.id)) === GIGAZALD_NAME);
          const grantsChoice = TAP_ABILITIES[name] ||
            (gigazald && name !== GIGAZALD_NAME && civsOf(c.id).includes('Darkness'));
          if (grantsChoice && !msg.mode) {
            send(ws, { type: 'tapModeOffer', key: c.key, name: cardLabel(c.id) });
            return;
          }
        }

        c.tapped = !c.tapped;
        logText = (c.tapped ? 'tapped ' : 'untapped ') + cardLabel(c.id) + '.';

        if (c.tapped && msg.mode === 'ability') {
          const own = TAP_ABILITIES[name];
          const gigazaldGrant = me.battlezone.some(g => normalizeCardKey(cardLabel(g.id)) === GIGAZALD_NAME)
                                && name !== GIGAZALD_NAME && civsOf(c.id).includes('Darkness');
          const ability = own || (gigazaldGrant ? { kind: 'oppDiscardRandom' } : null);
          if (!ability) { logText = 'tapped ' + cardLabel(c.id) + '.'; break; }
          if (ability.kind === 'oppDiscardRandom') {
            if (opp.hand.length) opp.pendingDiscards.push({ id: newKey(), kind: 'random', count: 1, source: cardLabel(c.id) });
          } else if (ability.kind === 'multi') {
            const pool = ability.zone === 'ownGrave' ? me.graveyard : me.battlezone;
            if (pool.length) {
              me.pendingMulti = { id: newKey(), source: cardLabel(c.id), zone: ability.zone, action: ability.action,
                                  max: ability.max, keys: pool.map(x => x.key), prompt: ability.prompt, spellKey: null };
            }
          } else if (ability.kind === 'target') {
            me.pendingTargets.push({ id: newKey(), zone: ability.zone, action: ability.action,
                                     filter: null, requireBlocker: !!ability.requireBlocker,
                                     source: cardLabel(c.id), spellKey: null });
          }
          logText = 'used ' + cardLabel(c.id) + "'s tap ability instead of attacking.";
          break;
        }

        break;
      }
      case 'battleMove': {
        const c = me.battlezone.find(c => c.key === msg.key);
        if (c) { c.x = msg.x; c.y = msg.y; logText = 'repositioned ' + cardLabel(c.id) + ' on the battlefield.'; }
        break;
      }
      case 'battleDestroy': {
        const i = me.battlezone.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.battlezone.splice(i, 1);
        const dest = battleCardToGrave(me, c);
        creatureDestroyed(me, opp, c, extraLogs, dest === 'graveyard');
        logText = 'destroyed ' + cardLabel(c.id) + ' (to ' + dest + ').';
        break;
      }
      case 'battleReturn': {
        const i = me.battlezone.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.battlezone.splice(i, 1);
        dissolveStack(me, c, extraLogs, 'hand');
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' from the battlefield to hand.';
        break;
      }

      case 'gyReturnToHand': {
        const i = me.graveyard.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.graveyard.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' from the graveyard to hand.';
        break;
      }
      case 'gyReturnToDeckShuffle': {
        const i = me.graveyard.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.graveyard.splice(i, 1);
        me.deck.push(c.id);
        me.deck = shuffle(me.deck);
        logText = 'shuffled ' + cardLabel(c.id) + ' from the graveyard back into their deck.';
        break;
      }
      case 'gyReturnToBattlefield': {
        const i = me.graveyard.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.graveyard.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y, summonedTurn: s.turnNumber, under: [] });
        onCreatureEnteredBattlezone(s, c.key, c.id);
        logText = 'returned ' + cardLabel(c.id) + ' from the graveyard to the battlefield.';
        break;
      }

      case 'searchDeckPick': {
        if (!canSearchDeck(me) && !me.pendingSearch) return;
        const i = msg.index;
        if (typeof i !== 'number' || i < 0 || i >= me.deck.length) return;
        const search = me.pendingSearch;
        if (search && search.filter) {
          const pickId = me.deck[i];
          const f = search.filter;
          let ok = true;
          if (f === 'spell') ok = isSpellCard(pickId);
          else if (f === 'creature') ok = !isSpellCard(pickId);
          else if (f === 'nature creature') ok = !isSpellCard(pickId) && civsOf(pickId).includes('Nature');
          if (!ok) {
            send(ws, { type: 'summonRejected', reason: search.source + ' can only take a ' + f + ' from your deck.' });
            return;
          }
          if (search.costEquals != null && (cardMeta(pickId) || {}).cost !== search.costEquals) {
            send(ws, { type: 'summonRejected', reason: search.source + ' can only take a creature costing exactly ' + search.costEquals + '.' });
            return;
          }
        }
        const [cardId] = me.deck.splice(i, 1);
        if (search && search.toBattlezone) {
          // Miraculous Rebirth puts the fetched creature straight into play for free
          const slot = battlefieldSlot(me);
          const freeKey = newKey();
          me.battlezone.push({ id: cardId, key: freeKey, tapped: false, x: slot.x, y: slot.y,
                               summonedTurn: s.turnNumber, brokeShieldThisTurn: false, under: [] });
          onCreatureEnteredBattlezone(s, freeKey, cardId);
          s.creaturesEnteredThisTurn = (s.creaturesEnteredThisTurn || 0) + 1;
          extraLogs.push('put ' + cardLabel(cardId) + ' into the battle zone for free with ' + search.source + '.');
        } else {
          me.hand.push({ id: cardId, key: newKey() });
        }
        me.deck = shuffle(me.deck);
        logText = 'searched their deck and shuffled.'; // card taken is normally private
        if (search) {
          me.pendingSearch = null;
          // Logic Cube requires the taken spell to be shown to the opponent
          if (search.reveal) {
            pendingNotices.push({
              self: search.source + ' \u2014 you took ' + cardLabel(cardId) + ' (revealed to your opponent).',
              other: '%p took ' + cardLabel(cardId) + ' from their deck with ' + search.source + '.'
            });
            extraLogs.push('revealed ' + cardLabel(cardId) + ' and put it into their hand.');
          }
          if (search.spellKey) {
            const spent = removeBattleCard(me, search.spellKey);
            if (spent) { me.graveyard.push({ id: spent.id, key: spent.key }); extraLogs.push('sent ' + cardLabel(spent.id) + ' to the graveyard.'); }
          }
        }
        break;
      }
      case 'searchDeckCancel': {
        if (!canSearchDeck(me) && !me.pendingSearch) return;
        me.deck = shuffle(me.deck);
        logText = 'searched their deck and shuffled.';
        if (me.pendingSearch) {
          const spellKey = me.pendingSearch.spellKey;
          me.pendingSearch = null;
          if (spellKey) {
            const spent = removeBattleCard(me, spellKey);
            if (spent) { me.graveyard.push({ id: spent.id, key: spent.key }); extraLogs.push('sent ' + cardLabel(spent.id) + ' to the graveyard.'); }
          }
        }
        break;
      }
      case 'corilePutOnDeck': {
        if (!me.pendingCorileUses) return;
        const i = opp.battlezone.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = opp.battlezone.splice(i, 1);
        opp.deck.unshift(c.id);
        me.pendingCorileUses -= 1;
        logText = "used Corile to put " + cardLabel(c.id) + " on top of their opponent's deck.";
        break;
      }
      case 'corileSkip': {
        if (!me.pendingCorileUses) return;
        me.pendingCorileUses -= 1;
        logText = 'chose not to use a pending Corile ability.';
        break;
      }
      case 'skyswordToMana': {
        if (!me.pendingSkyswordMana) return;
        const cardId = me.deck.shift();
        me.pendingSkyswordMana -= 1;
        me.pendingSkyswordShield = (me.pendingSkyswordShield || 0) + 1;
        if (cardId) {
          const mSlot = manaSlot(me);
          me.mana.push({ id: cardId, key: newKey(), tapped: false, x: mSlot.x, y: mSlot.y });
          logText = 'used Skysword, the Savage Vizier to put ' + cardLabel(cardId) + ' from their deck into their mana zone.';
        } else {
          logText = "used Skysword, the Savage Vizier, but their deck was empty.";
        }
        break;
      }
      case 'skyswordToShield': {
        if (!me.pendingSkyswordShield) return;
        const cardId = me.deck.shift();
        me.pendingSkyswordShield -= 1;
        if (cardId) me.shields.push({ id: cardId, key: newKey(), faceUp: false, slot: nextShieldSlot(me) });
        logText = 'used Skysword, the Savage Vizier to put the next card of their deck face down into their shield zone.';
        break;
      }
      case 'bronzeArmToMana': {
        if (!me.pendingBronzeArm) return;
        const cardId = me.deck.shift();
        me.pendingBronzeArm -= 1;
        if (cardId) {
          const mSlot = manaSlot(me);
          me.mana.push({ id: cardId, key: newKey(), tapped: false, x: mSlot.x, y: mSlot.y });
          logText = 'used Bronze-Arm Tribe to put ' + cardLabel(cardId) + ' from their deck into their mana zone.';
        } else {
          logText = 'used Bronze-Arm Tribe, but their deck was empty.';
        }
        break;
      }

      case 'effectTarget': {
        const i = me.pendingTargets.findIndex(t => t.id === msg.effectId);
        if (i === -1) return;
        const eff = me.pendingTargets[i];
        let destroyedCost = null;
        const zones = {
          oppBattle: { owner: opp, list: opp.battlezone },
          ownBattle: { owner: me,  list: me.battlezone },
          ownHand:   { owner: me,  list: me.hand },
          ownMana:   { owner: me,  list: me.mana },
          oppMana:   { owner: opp, list: opp.mana },
          ownGrave:  { owner: me,  list: me.graveyard },
          ownShield: { owner: me,  list: me.shields },
          anyBattle: null
        };
        let owner, list;
        if (eff.zone === 'anyBattle') {
          owner = me.battlezone.some(c => c.key === msg.key) ? me : opp;
          list = owner.battlezone;
        } else {
          const z = zones[eff.zone];
          if (!z) return;
          owner = z.owner; list = z.list;
        }
        if (eff.sourceKey && msg.key === eff.sourceKey) {
          send(ws, { type: 'summonRejected', reason: eff.source + " can't choose itself." });
          return;
        }
        const ci = list.findIndex(c => c.key === msg.key);
        if (ci === -1) return;
        const card = list[ci];

        // Petrova can't be chosen by the opposing player's effects (its own
        // controller may still pick it).
        if (owner !== me && cardLabel(card.id).toLowerCase() === PETROVA_NAME) {
          send(ws, { type: 'summonRejected', reason: cardLabel(card.id) + " can't be chosen by your effects." });
          return;
        }
        if (eff.filter === 'untapped' && card.tapped) {
          send(ws, { type: 'summonRejected', reason: eff.source + ' can only affect an UNTAPPED creature.' });
          return;
        }
        if (eff.filter === 'creature' && isSpellCard(card.id)) {
          send(ws, { type: 'summonRejected', reason: eff.source + ' can only choose a creature.' });
          return;
        }
        if (eff.filter === 'spell' && !isSpellCard(card.id)) {
          send(ws, { type: 'summonRejected', reason: eff.source + ' can only choose a spell.' });
          return;
        }
        if (eff.requireBlocker && !isBlocker(card.id)) {
          send(ws, { type: 'summonRejected', reason: eff.source + ' can only choose a creature with Blocker.' });
          return;
        }
        if (eff.maxPower != null) {
          const pw = powerOf(card.id);
          // pw === null means the sheet has no power for this card yet, so the
          // player's on-screen confirmation is what we go on
          if (pw != null && pw > eff.maxPower) {
            send(ws, { type: 'summonRejected', reason: eff.source + ' can only affect a creature with power ' + eff.maxPower + ' or less. ' + cardLabel(card.id) + ' has ' + pw + '.' });
            return;
          }
        }
        if (eff.filter === 'nonEvolution') {
          const m = cardMeta(card.id);
          if (m && m.type && /evolution/i.test(m.type)) {
            send(ws, { type: 'summonRejected', reason: eff.source + " can't choose an evolution creature." });
            return;
          }
        }

        const label = cardLabel(card.id);
        switch (eff.action) {
          case 'tap':
            if (card.tapped) { send(ws, { type: 'summonRejected', reason: label + ' is already tapped.' }); return; }
            card.tapped = true;
            logText = 'used ' + eff.source + ' to tap ' + label + '.';
            break;
          case 'returnToHand':
            list.splice(ci, 1);
            dissolveStack(owner, card, extraLogs, 'hand');
            owner.hand.push({ id: card.id, key: card.key });
            logText = 'used ' + eff.source + ' to return ' + label + " to its owner's hand.";
            break;
          case 'toHand':
            list.splice(ci, 1);
            me.hand.push({ id: card.id, key: card.key });
            logText = 'used ' + eff.source + ' to take ' + label + ' back into their hand.';
            break;
          case 'destroy': {
            list.splice(ci, 1);
            const dest = battleCardToGrave(owner, card);
            creatureDestroyed(owner, opponentOf(room, owner), card, extraLogs);
            destroyedCost = (cardMeta(card.id) || {}).cost;
            logText = 'used ' + eff.source + ' to destroy ' + label + ' (to ' + dest + ').';
            break;
          }
          case 'toOwnerMana': {
            list.splice(ci, 1);
            dissolveStack(owner, card, extraLogs, 'hand');
            const slot = manaSlot(owner);
            owner.mana.push({ id: card.id, key: card.key, tapped: false, x: slot.x, y: slot.y });
            logText = 'used ' + eff.source + ' to put ' + label + " into its owner's mana zone.";
            break;
          }
          case 'toOwnMana': {
            list.splice(ci, 1);
            const slot = manaSlot(me);
            me.mana.push({ id: card.id, key: card.key, tapped: false, x: slot.x, y: slot.y });
            logText = 'used ' + eff.source + ' to put ' + label + ' into their mana zone.';
            break;
          }
          case 'toGrave':
            list.splice(ci, 1);
            owner.graveyard.push({ id: card.id, key: card.key });
            logText = 'used ' + eff.source + ' to put ' + label + ' into the graveyard.';
            break;
          case 'toTopOfDeck':
            list.splice(ci, 1);
            dissolveStack(owner, card, extraLogs, 'hand');
            owner.deck.unshift(card.id);
            logText = 'used ' + eff.source + ' to put ' + label + " on top of its owner's deck.";
            break;
          case 'toOwnerShield':
            list.splice(ci, 1);
            owner.shields.push({ id: card.id, key: card.key, faceUp: false, slot: nextShieldSlot(owner) });
            logText = 'used ' + eff.source + ' to put ' + label + " into its owner's shield zone.";
            break;
          default:
            return;
        }
        me.pendingTargets.splice(i, 1);
        // Miraculous Rebirth: the destroyed creature's cost decides what you may
        // fetch, so the spell waits for that search rather than resolving now.
        if (eff.thenSearchSameCost && destroyedCost != null) {
          me.pendingSearch = {
            id: newKey(), source: eff.source, spellKey: eff.spellKey,
            filter: 'creature', costEquals: destroyedCost, toBattlezone: true
          };
        } else {
          resolveSpellCard(me, eff, extraLogs);
        }
        break;
      }
      case 'effectMultiResolve': {
        const pm = me.pendingMulti;
        if (!pm || pm.id !== msg.effectId) return;
        let keys = Array.isArray(msg.keys) ? msg.keys.filter(k => pm.keys.includes(k)) : [];
        if (pm.max) keys = keys.slice(0, pm.max);
        const zoneOf = z => ({
          oppBattle: { owner: opp, list: opp.battlezone },
          ownBattle: { owner: me,  list: me.battlezone },
          anyBattle: null,
          ownGrave:  { owner: me,  list: me.graveyard },
          ownMana:   { owner: me,  list: me.mana },
          oppMana:   { owner: opp, list: opp.mana },
          ownHand:   { owner: me,  list: me.hand }
        })[z];
        const done = [];
        for (const k of keys) {
          let owner, list;
          if (pm.zone === 'anyBattle') {
            owner = me.battlezone.some(c => c.key === k) ? me : opp;
            list = owner.battlezone;
          } else {
            const z = zoneOf(pm.zone);
            if (!z) continue;
            owner = z.owner; list = z.list;
          }
          const i = list.findIndex(c => c.key === k);
          if (i === -1) continue;
          const card = list[i];
          const label = cardLabel(card.id);
          switch (pm.action) {
            case 'destroy': {
              list.splice(i, 1);
              const dest = battleCardToGrave(owner, card);
              creatureDestroyed(owner, owner === me ? opp : me, card, extraLogs, dest === 'graveyard');
              done.push(label);
              break;
            }
            case 'tap':
              if (!card.tapped) { card.tapped = true; done.push(label); }
              break;
            case 'returnToHand':
              list.splice(i, 1);
              dissolveStack(owner, card, extraLogs, 'hand');
              owner.hand.push({ id: card.id, key: card.key });
              done.push(label);
              break;
            case 'toHand':
              list.splice(i, 1);
              me.hand.push({ id: card.id, key: card.key });
              done.push(label);
              break;
            case 'toOwnMana': {
              list.splice(i, 1);
              const slot = manaSlot(me);
              me.mana.push({ id: card.id, key: card.key, tapped: false, x: slot.x, y: slot.y });
              done.push(label);
              break;
            }
            case 'unblockable':
              card.unblockableThisTurn = true;
              done.push(label);
              break;
            default: break;
          }
        }
        const verb = { destroy: 'destroyed', tap: 'tapped', returnToHand: 'returned to hand',
                       toHand: 'took back to hand', toOwnMana: 'put into their mana zone',
                       unblockable: 'made unblockable this turn' }[pm.action] || 'affected';
        logText = done.length ? (verb + ' ' + done.join(', ') + ' with ' + pm.source + '.')
                              : ('used ' + pm.source + ' without choosing anything.');
        const spellKey = pm.spellKey;
        me.pendingMulti = null;
        if (spellKey) resolveSpellCard(me, { spellKey }, extraLogs);
        break;
      }
      case 'choosePetrovaRace': {
        const pending = me.pendingRaceChoices[0];
        if (!pending) return;
        const race = (msg.race || '').toString().trim();
        if (!race) return;
        // Petrova can't name its own race
        if (pending.excludeRace && race.toLowerCase() === pending.excludeRace.toLowerCase()) {
          send(ws, { type: 'summonRejected', reason: "Petrova can't choose its own race (" + pending.excludeRace + ').' });
          return;
        }
        const petCard = me.battlezone.find(c => c.key === pending.cardKey);
        if (petCard) petCard.petrovaRace = race;
        me.pendingRaceChoices.shift();
        logText = 'named ' + race + ' with Petrova — their other ' + race + ' creatures get +4000.';
        break;
      }
      case 'chooseTruceCiv': {
        const pt = me.pendingTruce;
        if (!pt) return;
        const civ = ['Light','Water','Darkness','Fire','Nature'].find(c => c === msg.civ);
        if (!civ) return;
        me.truceCiv = civ;
        me.truceUntilTurn = (s.turnNumber || 0) + 2;   // lasts until the start of your next turn
        me.pendingTruce = null;
        logText = 'named ' + civ + " with Miraculous Truce — those creatures can't attack them until their next turn.";
        if (pt.spellKey) resolveSpellCard(me, { spellKey: pt.spellKey }, extraLogs);
        break;
      }
      case 'endTurnUntap': {
        const c = me.battlezone.find(c => c.key === msg.key);
        if (!c || !c.tapped) return;
        c.tapped = false;
        logText = 'untapped ' + cardLabel(c.id) + ' at end of turn.';
        break;
      }
      case 'effectTargetSkip': {
        const i = me.pendingTargets.findIndex(t => t.id === msg.effectId);
        if (i === -1) return;
        const eff = me.pendingTargets[i];
        logText = "didn't use " + eff.source + '.';
        me.pendingTargets.splice(i, 1);
        resolveSpellCard(me, eff, extraLogs);
        break;
      }
      case 'effectDiscardResolve': {
        const i = me.pendingDiscards.findIndex(d => d.id === msg.effectId);
        if (i === -1) return;
        const eff = me.pendingDiscards[i];
        const moved = [];
        if (eff.kind === 'random') {
          if (me.hand.length) {
            const r = Math.floor(Math.random() * me.hand.length);
            const [c] = me.hand.splice(r, 1);
            me.graveyard.push({ id: c.id, key: c.key });
            moved.push(cardLabel(c.id));
          }
        } else if (eff.kind === 'all') {
          while (me.hand.length) {
            const [c] = me.hand.splice(0, 1);
            me.graveyard.push({ id: c.id, key: c.key });
            moved.push(cardLabel(c.id));
          }
        } else { // 'choose'
          const keys = Array.isArray(msg.keys) ? msg.keys.slice(0, eff.count) : [];
          for (const k of keys) {
            const idx = me.hand.findIndex(c => c.key === k);
            if (idx !== -1) {
              const [c] = me.hand.splice(idx, 1);
              me.graveyard.push({ id: c.id, key: c.key });
              moved.push(cardLabel(c.id));
            }
          }
        }
        // naming them is fine — they're in the graveyard now, which both players can inspect
        logText = moved.length
          ? ('discarded ' + moved.join(', ') + ' to ' + eff.source + '.')
          : ('had no cards to discard to ' + eff.source + '.');
        me.pendingDiscards.splice(i, 1);
        break;
      }
      case 'effectDiscardMana': {
        if (!me.pendingManaDiscards) return;
        const idx = me.mana.findIndex(c => c.key === msg.key);
        if (idx === -1) return;
        const [c] = me.mana.splice(idx, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        me.pendingManaDiscards -= 1;
        logText = 'sent ' + cardLabel(c.id) + ' from mana to the graveyard (Ice Vapor).';
        break;
      }

      case 'endTurnReturnConfirm': {
        const c = me.battlezone.find(c => c.key === msg.key);
        if (!c) return;
        removeBattleCard(me, c.key);
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' to their hand (it broke a shield this turn).';
        break;
      }

      // ---------------- COMBAT ----------------
      case 'declareAttack': {
        if (s.combat) { send(ws, { type: 'summonRejected', reason: 'An attack is already being resolved.' }); return; }
        const atk = me.battlezone.find(c => c.key === msg.key);
        if (!atk || atk.tapped) return;
        if (s.activeTurn !== idx) { send(ws, { type: 'summonRejected', reason: "You can only attack on your own turn." }); return; }
        // Diamond Cutter this turn: summoning sickness is bypassed for ANY attack,
        // while the attack restrictions it lifts ("can't attack" / "not players")
        // only let a creature swing at SHIELDS — never at other creatures.
        const dc = !!me.diamondCutterActive;
        const dcShieldRun = dc && (msg.target || {}).type === 'shield';
        if (!dcShieldRun && !canAttackAtAll(atk.id)) { send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + " can't attack." }); return; }
        if (!dc && hasSummoningSickness(s, idx, atk)) {
          send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + ' has summoning sickness — it can\'t attack the turn it was summoned.' });
          return;
        }
        if (normalizeCardKey(cardLabel(atk.id)) === BULLRAIZER_NAME && opp.battlezone.length > me.battlezone.length) {
          send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + " can't attack while your opponent has more creatures than you." });
          return;
        }

        const target = msg.target || {};
        if (target.type === 'shield') {
          if (!dcShieldRun && !canAttackShields(atk.id)) { send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + " can't attack shields." }); return; }
          // no shields left: this is the direct attack that wins the game if unblocked
        } else if (target.type === 'creature') {
          const victim = opp.battlezone.find(c => c.key === target.key);
          if (!victim) return;
          if (!victim.tapped && !canAttackUntapped(atk.id)) {
            send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + ' can only attack TAPPED creatures.' });
            return;
          }
          if (blockerOnly(atk.id) && !metaOf(victim.id).blocker) {
            send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + ' can only attack creatures that have Blocker.' });
            return;
          }
          if (normalizeCardKey(cardLabel(victim.id)) === PETROVA_NAME) {
            // Petrova can't be *chosen* by effects, but attacking it is allowed
          }
        } else return;

        // Miraculous Truce: creatures of the named civilization can't attack that player
        if (opp.truceCiv && civsOf(atk.id).includes(opp.truceCiv)) {
          send(ws, { type: 'summonRejected', reason: 'Miraculous Truce prevents ' + opp.truceCiv + ' creatures from attacking this player.' });
          return;
        }

        atk.tapped = true;
        atk.attackedThisTurn = true;
        fireAttackTriggers(s, idx, oppIdx, atk, extraLogs, 'declare');

        const canBlock = hasLegalBlocker(s, opp, atk);
        s.combat = {
          attackerIdx: idx, attackerKey: atk.key,
          target, phase: canBlock ? 'blocking' : 'breaking',
          shieldsToBreak: target.type === 'shield' ? breakerCount(s, idx, atk) : 0
        };
        logText = 'attacked with ' + cardLabel(atk.id) +
          (target.type === 'shield' ? ' \u2014 aiming at shields.' : ' \u2014 targeting ' + cardLabel((opp.battlezone.find(c => c.key === target.key) || {}).id) + '.');
        if (!canBlock) {
          if (target.type === 'creature') {
            const victim = opp.battlezone.find(c => c.key === target.key);
            s.combat = null;
            if (victim) {
              const res = resolveBattle(s, idx, atk, oppIdx, victim, extraLogs);
              if (res.needsManual) manualBattle = res.needsManual;
            }
          } else {
            if (!opp.shields.length) {
              // nothing to break — the attack lands on the player and ends the game
              s.combat = null;
              winCheck = true;
            } else if (target.key) {
              // the attack connects: break the shield they clicked, in the same click
              breakOneShield(s, idx, oppIdx, atk, target.key, extraLogs, out => { shieldTriggerFor = out; });
            }
            fireAttackTriggers(s, idx, oppIdx, atk, extraLogs, 'hit');
          }
        }
        break;
      }

      case 'declareBlock': {
        const cb = s.combat;
        if (!cb || cb.phase !== 'blocking' || cb.attackerIdx === idx) return;
        const attacker = s.players[cb.attackerIdx];
        const atk = attacker.battlezone.find(c => c.key === cb.attackerKey);
        if (!atk) { s.combat = null; break; }

        if (msg.blockerKey) {
          const blk = me.battlezone.find(c => c.key === msg.blockerKey);
          if (!blk || blk.tapped || !metaOf(blk.id).blocker) return;
          // Light Stealth: can't be blocked if the blocking player has Light cards in mana
          if (metaOf(atk.id).lightStealth && me.mana.some(m => civsOf(m.id).includes('Light'))) {
            send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + " has Light Stealth — you can't block it while you have Light cards in your mana zone." });
            return;
          }
          if (atk.unblockableThisTurn) {
            send(ws, { type: 'summonRejected', reason: cardLabel(atk.id) + " can't be blocked this turn." });
            return;
          }
          blk.tapped = true;
          logText = 'blocked with ' + cardLabel(blk.id) + '.';
          const res = resolveBattle(s, cb.attackerIdx, atk, idx, blk, extraLogs);
          s.combat = null;
          if (res.needsManual) manualBattle = res.needsManual;
          break;
        }

        // no block: the attack lands
        logText = 'chose not to block.';
        if (cb.target.type === 'creature') {
          const victim = me.battlezone.find(c => c.key === cb.target.key);
          if (victim) {
            const res = resolveBattle(s, cb.attackerIdx, atk, idx, victim, extraLogs);
            if (res.needsManual) manualBattle = res.needsManual;
          }
          s.combat = null;
        } else {
          const attackerCard = attacker.battlezone.find(c => c.key === cb.attackerKey);
          if (!me.shields.length) {
            s.combat = null;
            winCheck = true;
            winnerIdx = cb.attackerIdx;
          } else {
            cb.phase = 'breaking';
            if (cb.target.key) breakOneShield(s, cb.attackerIdx, idx, attackerCard, cb.target.key, extraLogs, out => { shieldTriggerFor = out; });
          }
          fireAttackTriggers(s, cb.attackerIdx, idx, attackerCard, extraLogs, 'hit');
        }
        break;
      }

      case 'breakShield': {
        const cb = s.combat;
        if (!cb || cb.phase !== 'breaking' || cb.attackerIdx !== idx) return;
        const attacker = me.battlezone.find(c => c.key === cb.attackerKey);
        const ok = breakOneShield(s, idx, oppIdx, attacker, msg.key, extraLogs, out => { shieldTriggerFor = out; });
        if (!ok) return;
        if (!s.combat) {
          const atkNameNorm = attacker ? normalizeCardKey(cardLabel(attacker.id)) : '';
          if (atkNameNorm === 'aqua master' && opp.shields.length) {
            const t = opp.shields[Math.floor(Math.random() * opp.shields.length)];
            t.faceUp = true;
            extraLogs.push("turned one of their opponent's shields face up with Aqua Master.");
          }
          if (atkNameNorm === 'marrow ooze, the twister' && attacker) {
            removeBattleCard(me, attacker.key);
            const dest = battleCardToGrave(me, attacker);
            creatureDestroyed(me, opp, attacker, extraLogs, dest === 'graveyard');
            extraLogs.push('Marrow Ooze, the Twister destroyed itself after attacking.');
          }
          fireAttackTriggers(s, idx, oppIdx, attacker, extraLogs, 'hit');
        }
        break;
      }
      case 'cancelCombat': {
        if (!s.combat) return;
        s.combat = null;
        logText = 'ended the attack.';
        break;
      }

      case 'manualBattleResult': {
        // used when power data is missing for one of the creatures
        if (!msg.loserOwner || !msg.loserKey) return;
        const loserOwner = msg.loserOwner === 'me' ? me : opp;
        const card = loserOwner.battlezone.find(c => c.key === msg.loserKey);
        if (!card) return;
        removeBattleCard(loserOwner, card.key);
        const dest = battleCardToGrave(loserOwner, card);
        creatureDestroyed(loserOwner, loserOwner === me ? opp : me, card, extraLogs, dest === 'graveyard');
        logText = 'resolved the battle manually \u2014 ' + cardLabel(card.id) + ' was destroyed.';
        break;
      }

      case 'requestEndGame': {
        if (s.gameOver) return;
        // If no opponent is actually seated/dealt in, there's nobody to agree —
        // end it straight away instead of waiting on a confirmation that can never come.
        if (!room.sockets[oppIdx] || !room.decks[oppIdx]) {
          s.gameOver = { reason: 'agreed' };
          s.endGameRequestBy = null;
          logText = 'ended the game.';
          break;
        }
        s.endGameRequestBy = idx;
        logText = 'asked to end the game.';
        break;
      }
      case 'respondEndGame': {
        if (s.endGameRequestBy === null || s.endGameRequestBy === idx) return;
        if (msg.accept) { s.gameOver = { reason: 'agreed' }; logText = 'agreed to end the game.'; }
        else logText = 'declined to end the game.';
        s.endGameRequestBy = null;
        break;
      }
      case 'surrender': {
        if (s.gameOver || s.surrenderBy !== null) return;
        // no opponent seated to accept it — just end the game
        if (!room.sockets[oppIdx] || !room.decks[oppIdx]) {
          s.gameOver = { reason: 'agreed' };
          logText = 'ended the game.';
          break;
        }
        s.surrenderBy = idx;
        logText = 'surrendered.';
        break;
      }
      case 'acceptSurrender': {
        if (s.surrenderBy === null || s.surrenderBy === idx) return;
        s.gameOver = { reason: 'surrender', by: s.surrenderBy };
        s.surrenderBy = null;
        logText = "accepted their opponent's surrender.";
        break;
      }
      case 'rematchVote': {
        s.rematch[idx] = true;
        logText = 'voted for a rematch.';
        // solo in the room: no second vote is coming, so restart immediately
        const oppPresent = room.sockets[oppIdx] && room.decks[oppIdx];
        if ((s.rematch[0] && s.rematch[1]) || !oppPresent) {
          room.state = freshMatchState();
          if (room.decks[0]) dealPlayer(room, 0);
          if (room.decks[1]) dealPlayer(room, 1);
        }
        break;
      }

      default: return;
    }
    broadcastState(room);
    if (logText) logMsg(room, idx, logText);
    extraLogs.forEach(t => logMsg(room, idx, t));
    pendingNotices.forEach(n => noticeMsg(room, idx, n.self, n.other));
    endTurnPrompts.forEach(q => send(ws, { type: 'endTurnPrompt', key: q.key, name: q.name, kind: q.kind || 'return' }));
    if (revealPayload) send(ws, { type: 'revealCards', title: revealPayload.title, cards: revealPayload.cards });
    if (manualBattle) broadcastRaw(room, { type: 'manualBattle', battle: manualBattle });
    // Win condition: an attack connects while the defender has no shields left.
    if (winCheck && !s.gameOver) {
      const w = (winnerIdx == null) ? idx : winnerIdx;
      s.gameOver = { reason: 'shields', by: w };
      broadcastState(room);
      logMsg(room, w, 'won the game — the final attack connected with no shields left to defend.');
    }
    if (shieldTriggerFor) {
      const tws = room.sockets[shieldTriggerFor.idx];
      if (tws) send(tws, { type: 'shieldTriggerOffer', key: shieldTriggerFor.key, id: shieldTriggerFor.id });
    }
    if (shieldTriggerOfferKey) send(ws, { type: 'shieldTriggerOffer', key: shieldTriggerOfferKey, id: shieldTriggerOfferId });
    if (me.pendingSearch && !searchAlreadyOpen) send(ws, { type: 'searchDeckOffer', cards: me.deck.map((id, index) => ({ index, id })), filter: me.pendingSearch.filter, costEquals: me.pendingSearch.costEquals != null ? me.pendingSearch.costEquals : null, source: me.pendingSearch.source });
    if (sfxToPlay) broadcastRaw(room, { type: 'sfx', name: sfxToPlay });
  });

  ws.on('close', () => {
    const meta = connMeta.get(ws);
    connMeta.delete(ws);
    if (!meta || !meta.roomCode) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    if (room.pendingJoin === ws) room.pendingJoin = null;
    if (meta.idx !== null) room.sockets[meta.idx] = null;
    broadcastState(room);
    cleanupRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Duel Masters table running on port ' + PORT));
