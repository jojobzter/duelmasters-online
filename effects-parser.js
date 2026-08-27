// ============================================================================
// Effect column parser.
//
// Turns the spreadsheet's Effect text into structured descriptors the engine can
// execute, so a new card is a spreadsheet row rather than a code change.
//
// Grammar (one card may have several clauses, separated by ';'):
//
//     trigger: action [modifiers] [if condition]
//
// Anything it can't parse is reported by name rather than ignored, so a typo is
// visible instead of silently doing nothing.
// ============================================================================

const TRIGGERS = new Set([
  'onsummon', 'oncast', 'static', 'ondestroy', 'endturn', 'onattack',
  'onbattlewin', 'tapability', 'onanycreatureenter', 'onanycreaturedestroyed',
  'onoppcast', 'onplayerattack', 'onunblockedattack', 'onblock', 'cast', 'onbreak',
  // reactive triggers
  'onblocked', 'onbattle', 'onanycreaturebreak', 'onoppshieldtrigger',
  'onoppmanatograve', 'onoppsummon', 'onoppplay', 'ondiscard',
  'startturn', 'onownshieldbreak', 'onattacked', 'onowncreaturedestroyed',
  'onownsummon', 'oncreatureattack', 'oppstartturn', 'onoppcreaturedestroyed',
  'silentskill',
  // added with the Cross Gear set
  'onoppcreatureattack', 'ondraw', 'ondrawstep', 'onoppdiscard', 'onoppmanacharge',
  // added with DM-08
  'onowncreatureenter', 'onowncreatureattacked', 'onshieldwouldbreak', 'onturnstart',
  'onoppturnstart', 'onowncreatureattack', 'onanycast', 'onownshieldtriggercast'
]);

// Zones the selectors may refer to
const ZONES = {
  owncreature: { side: 'own', zone: 'battle' },
  otherowncreature: { side: 'own', zone: 'battle', excludeSelf: true },
  oppcreature: { side: 'opp', zone: 'battle' },
  anycreature: { side: 'any', zone: 'battle' },
  ownmana: { side: 'own', zone: 'mana' },
  oppmana: { side: 'opp', zone: 'mana' },
  ownshield: { side: 'own', zone: 'shield' },
  oppshield: { side: 'opp', zone: 'shield' },
  owngrave: { side: 'own', zone: 'grave' },
  oppgrave: { side: 'opp', zone: 'grave' },
  ownhand: { side: 'own', zone: 'hand' },
  opphand: { side: 'opp', zone: 'hand' },
  self: { side: 'own', zone: 'battle', selfOnly: true },
  // pseudo-zones: cards as they are played, used by cost modifiers
  anycard: { side: 'any', zone: 'played' },
  owncard: { side: 'own', zone: 'played' },
  oppcard: { side: 'opp', zone: 'played' },
  target: { side: 'any', zone: 'target' },
  otheranycreature: { side: 'any', zone: 'battle', excludeSelf: true },
  // "other..." forms simply exclude the card doing the choosing
  // either player's zone, used by effects that may reach across the table
  // Cross Gear: gear sits in its own zone and may be crossed to a creature
  owncrossgear: { side: 'own', zone: 'crossgear' },
  oppcrossgear: { side: 'opp', zone: 'crossgear' },
  anycrossgear: { side: 'any', zone: 'crossgear' },
  // the creature this gear is currently crossed to
  crossedcreature: { side: 'own', zone: 'battle', crossed: true },
  anymana:   { side: 'any', zone: 'mana' },
  anyshield: { side: 'any', zone: 'shield' },
  anygrave:  { side: 'any', zone: 'grave' },
  anyhand:   { side: 'any', zone: 'hand' },
  anycreature2: { side: 'any', zone: 'battle' },
  otherowngrave: { side: 'own', zone: 'grave', excludeSelf: true },
  otherownmana:  { side: 'own', zone: 'mana',  excludeSelf: true },
  otherownhand:  { side: 'own', zone: 'hand',  excludeSelf: true },
  otherownshield:{ side: 'own', zone: 'shield',excludeSelf: true }
};

function splitTop(text, sep) {
  // split on sep, but not inside [ ]
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

// "oppCreature[power<=2000,blocker]" -> { zone, filters }
function parseSelector(raw) {
  if (!raw) return null;
  raw = raw.trim();
  // "(oppCreature or oppShield)" — the player may pick from either zone
  const alt = raw.match(/^\((.+)\)$/);
  if (alt) {
    const raws = alt[1].split(/\s+or\s+/i).map(x => x.trim());
    const parts = raws.map(x => parseSelector(x));
    // if any branch is unknown the whole thing is unknown — degrading to one option
    // would quietly change what the card does
    if (parts.some(x => !x)) return null;
    if (parts.length > 1) return { name: raw, alternatives: parts, side: parts[0].side, zone: parts[0].zone, filters: [], accessor: null };
    return parts[0];
  }
  let accessor = null;
  const acc = raw.match(/^(.*)\.(topCard|count|evoBase|name|crossedCreature|crossed)$/);
  if (acc) { raw = acc[1]; accessor = acc[2]; }
  // "self.crossedCreature" / "target.crossedCreature" resolve to a crossed creature
  if (accessor === 'crossedCreature') {
    const base = raw.trim().toLowerCase();
    return { name: raw + '.crossedCreature', side: base === 'target' ? 'target' : 'own',
             zone: 'battle', crossed: true, of: base, filters: [], accessor: null };
  }
  const m = raw.match(/^([a-zA-Z]+)(?:\[(.*)\])?$/);
  if (!m) return null;
  const base = ZONES[m[1].toLowerCase()];
  if (!base) return null;
  const sel = Object.assign({ name: m[1] }, base, { filters: [], accessor });
  if (m[2]) {
    for (const f of splitTop(m[2], ',')) {
      const neg = f.startsWith('!');
      const body = neg ? f.slice(1) : f;
      const cmp = body.match(/^([a-zA-Z]+)\s*(<=|>=|~|=|<|>)\s*(.+)$/);
      if (cmp) sel.filters.push({ key: cmp[1].toLowerCase(), op: cmp[2], value: cmp[3].trim(), negate: neg });
      else sel.filters.push({ key: body.toLowerCase(), op: 'flag', value: true, negate: neg });
    }
  }
  return sel;
}

// "up to 2", "all", "any number of", "2", or a dynamic count expression
function parseCount(words) {
  let text = words.join(' ');
  let m;
  // "choose 1 oppCreature" / "choose up to 2 ownShield" — the player picks
  if ((m = text.match(/^choose\s+/i))) text = text.slice(m[0].length);
  if ((m = text.match(/^all\b/i))) return { count: 'all', rest: text.slice(m[0].length).trim() };
  if ((m = text.match(/^any number of\b/i))) return { count: 'all', optional: true, rest: text.slice(m[0].length).trim() };
  if ((m = text.match(/^up to ([a-zA-Z][\w\[\]=,.!~ ]*?\.count)\s/i))) {
    return { count: { dynamic: m[1].trim() }, optional: true, rest: text.slice(m[0].length).trim() };
  }
  // a bare dynamic count, e.g. "tap ownMana[civ=Light,untapped].count oppCreature"
  if ((m = text.match(/^([a-zA-Z][\w\[\]=,.!~ ]*?\.count)\s/i))) {
    return { count: { dynamic: m[1].trim() }, rest: text.slice(m[0].length).trim() };
  }
  if ((m = text.match(/^any number of\b/i))) return { count: 'all', optional: true, rest: text.slice(m[0].length).trim() };
  if ((m = text.match(/^any number\b/i))) return { count: 'all', optional: true, rest: text.slice(m[0].length).trim() };
  if ((m = text.match(/^up to (\d+)\b/i))) return { count: parseInt(m[1], 10), optional: true, rest: text.slice(m[0].length).trim() };
  if ((m = text.match(/^(\d+)\b/))) return { count: parseInt(m[1], 10), rest: text.slice(m[0].length).trim() };
  return { count: 1, rest: text };
}

// Strips the trailing modifiers, the "if" condition and any "orElse" chain off a
// clause body. Shared by triggered clauses and ones that inherit their trigger.
function processBody(bodyIn) {
  const mods = {};
  let body = bodyIn;
  body = body.replace(/,\s*(optional|oppChoice|reveal|untilNextTurn|shuffled|noShieldTrigger|loseShieldTrigger|reorder|permanent|tapped|free|noTrigger)\b/gi,
    (_, w) => { mods[w.toLowerCase()] = true; return ''; }).trim();
  body = body.replace(/,\s*min\s+(\d+)\b/i, (_, n) => { mods.min = parseInt(n, 10); return ''; }).trim();
  body = body.replace(/\s+(tapped|free|endOfTurn|endOfExtraTurn)\s*$/i, (_, w) => { mods[w.toLowerCase()] = true; return ''; }).trim();
  body = body.replace(/,\s*(choice|prevents break)\s*(?=$|\s+if\s)/i, (_, w) => { mods[w.toLowerCase().replace(/\s+/g,'')] = true; return ''; }).trim();

  let condition = null;
  const ifIdx = body.toLowerCase().lastIndexOf(' if ');
  if (ifIdx > -1) { condition = body.slice(ifIdx + 4).trim(); body = body.slice(0, ifIdx).trim(); }
  if (/^if\s+/i.test(body)) { condition = body.replace(/^if\s+/i, '').trim(); body = ''; }

  let orElse = null;
  const oe = body.split(/\s+orElse\s+/i);
  if (oe.length > 1) { body = oe[0].trim(); orElse = oe.slice(1).map(x => x.trim()); }
  return { body, mods, condition, orElse };
}

function parseClause(raw, cardName, inheritedTrigger) {
  let clause = raw.trim();
  if (!clause) return null;

  // card-level property, no trigger
  let m = clause.match(/^resolvesTo\s+(mana|grave|hand)(\s+tapped)?$/i);
  if (m) return { kind: 'property', property: 'resolvesTo', to: m[1].toLowerCase(), tapped: !!m[2] };

  // "noAutoUntap" — this card is skipped by the automatic untap step and stays
  // tapped until something (a player's manual untap, or a card effect) untaps it.
  if (/^noAutoUntap$/i.test(clause)) return { kind: 'property', property: 'noAutoUntap', value: true };

  // "crossedCreature.onDestroy: -> hand" — the trigger belongs to the creature this
  // card is crossed to, not to the card itself.
  let watches = null;
  const pref = clause.match(/^([a-zA-Z]+)\.([a-zA-Z]+)(\[[^\]]*\])?\s*:\s*(.+)$/);
  if (pref && TRIGGERS.has(pref[2].toLowerCase())) {
    watches = pref[1];
    clause = pref[2] + (pref[3] || '') + ': ' + pref[4];
  }

  m = clause.match(/^([a-zA-Z]+)(?:\[([^\]]*)\])?\s*:\s*(.+)$/);
  if (!m) {
    // A clause with no trigger of its own continues the previous one, e.g.
    // "onSummon: draw 1; extraTurn" — the second clause is part of the same trigger.
    if (inheritedTrigger) {
      // run it through the same body processing a triggered clause gets, so trailing
      // modifiers like "tapped" are handled identically
      const r0 = processBody(clause.trim());
      const action0 = parseAction(r0.body, r0.mods);
      if (action0) return Object.assign({ kind: 'effect', trigger: inheritedTrigger, triggerFilter: null,
        condition: r0.condition, orElse: r0.orElse, card: cardName }, action0, { mods: r0.mods });
    }
    return { kind: 'error', reason: 'no trigger prefix', text: clause };
  }
  const trigger = m[1].toLowerCase();
  if (!TRIGGERS.has(trigger)) return { kind: 'error', reason: 'unknown trigger "' + m[1] + '"', text: clause };
  // the bracketed part restricts WHICH event fires this clause
  const triggerFilter = m[2] ? parseTriggerFilter(m[2]) : null;

  // One shared body processor for both paths — a duplicated copy here is exactly how
  // ", tapped" ended up working in one place and not the other.
  const r = processBody(m[3].trim());
  const body = r.body, mods = r.mods, condition = r.condition, orElse = r.orElse;

  const action = parseAction(body, mods);
  if (!action) return { kind: 'error', reason: 'unrecognised action', text: clause };

  return Object.assign({ kind: 'effect', trigger, triggerFilter, watches, condition, orElse, card: cardName }, action, { mods });
}

function parseAction(body, mods) {
  if (!body) return { action: 'condition' };

  // Some clauses lead with the quantity rather than a verb, e.g.
  // "up to 2 ownHand -> mana" or "any number ownGrave[...] -> hand".
  // The destination arrow carries the action.
  const countFirst = body.match(/^(all|any number(?: of)?|up to\s+\S+|\d+)\s+(.+?)\s*->\s*(\w+)\s*$/i);
  if (countFirst) {
    const c = parseCount((countFirst[1] + ' x').split(/\s+/));
    const dest = countFirst[3].toLowerCase();
    const verbFor = { mana: 'toMana', hand: 'toHand', shield: 'toShield', grave: 'toGrave',
                      battle: 'toBattle', deck: 'toDeck', decktop: 'toDeckTop' }[dest];
    if (verbFor) {
      return { action: verbFor, count: c.count, optional: !!c.optional,
               selector: parseSelector(countFirst[2].trim()) || { name: countFirst[2].trim() } };
    }
  }

  const words = body.split(/\s+/);
  const verb = words[0].toLowerCase();

  // "-> hand" / "-> mana" (replacement effects)
  if (verb === '->') return { action: 'moveSelf', to: words[1] ? words[1].toLowerCase() : 'hand' };

  // "+2000 self per ownGrave[civ=Fire]"
  // the selector may contain spaces inside its brackets, e.g. [race=Beast Folk]
  // A selector may carry brackets (with spaces inside) and a dotted accessor.
  const SEL = '[a-zA-Z]+(?:\\.[a-zA-Z]+)?(?:\\[[^\\]]*\\])?';
  // "+2000 X", "-1000 power X", each optionally "per <selector>"
  // The target may carry a count word ("all X"), and the "per" selector may end in
  // ".count" or be followed by a duration word — none of which change the amount.
  // "+4000 choose 1 ownCreature", "-1000 self per (ownShield.count+oppShield.count)"
  const COUNTWORD = '(?:choose\\s+)?(?:all|any number(?: of)?|up to \\d+|\\d+)';
  const PER = '(?:\\([^)]*\\)|' + SEL + '(?:\\.count)?)';
  const plus = body.match(new RegExp(
    '^([+-])(\\d+)\\s+(?:power\\s+)?(?:(' + COUNTWORD + ')\\s+)?(' + SEL + ')' +
    '(?:\\s+per\\s+(' + PER + '))?' +
    '(?:\\s+(untilEndOfTurn|thisTurn|permanently))?\\s*$', 'i'));
  if (plus) {
    const sign = plus[1] === '-' ? -1 : 1;
    const dur = (plus[6] || '').toLowerCase();
    const countWord = plus[3] ? plus[3].replace(/^choose\s+/i, '') : null;
    // a "per" may be a sum of several counts, written in brackets
    let per = null, perSum = null;
    if (plus[5]) {
      const braced = plus[5].trim().match(/^\((.*)\)$/);
      if (braced) {
        perSum = braced[1].split('+').map(x => parseSelector(x.trim())).filter(Boolean);
        if (!perSum.length) perSum = null;
      } else {
        per = parseSelector(plus[5]) || { name: plus[5] };
      }
    }
    return { action: 'buff', amount: sign * parseInt(plus[2], 10),
             count: countWord ? parseCount([countWord, 'x']).count : undefined,
             chooses: !!(plus[3] && /^choose/i.test(plus[3])),
             target: parseSelector(plus[4]) || { name: plus[4] },
             per, perSum, duration: dur || null };
  }
  // "x2 power crossedCreature" — a multiplier rather than a flat change
  const times = body.match(new RegExp('^x(\\d+(?:\\.\\d+)?)\\s+(?:power\\s+)?(' + SEL + ')\\s*$', 'i'));
  if (times) {
    return { action: 'buffMultiply', factor: parseFloat(times[1]),
             target: parseSelector(times[2]) || { name: times[2] } };
  }

  let rest = words.slice(1);
  // "choose up to 1 ownHand[...] -> battle" puts the chosen card somewhere specific
  let destination = null;
  const arrowAt = rest.indexOf('->');
  if (arrowAt > -1 && !['fromdeck','search','ownkeeps','oppkeeps'].includes(verb)) {
    destination = (rest[arrowAt + 1] || '').toLowerCase();
    rest = rest.slice(0, arrowAt);
  }

  switch (verb) {
    case 'draw': {
      const c = parseCount(rest);
      return { action: 'draw', count: c.count, optional: !!c.optional };
    }
    case 'oppdiscard': {
      const kindWord = (rest[0] || '').toLowerCase();
      if (kindWord === 'random' || kindWord === 'choose' || kindWord === 'all') {
        const c = parseCount(rest.slice(1));
        const sel = c.rest ? parseSelector(c.rest) : null;
        return { action: 'oppDiscard', mode: kindWord, count: kindWord === 'all' ? 'all' : c.count, selector: sel };
      }
      return { action: 'oppDiscard', mode: 'random', count: 1 };
    }
    case 'destroy': case 'bounce': case 'tomana': case 'tograve': case 'tohand':
    case 'toshield': case 'todecktop': case 'tap': case 'untap': {
      const c = parseCount(rest);
      const sel = parseSelector(c.rest);
      if (!sel) return null;
      if (destination === 'battle') {
        const c2 = parseCount(rest);
        return { action: 'toBattle', count: c2.count, optional: !!c2.optional, selector: parseSelector(c2.rest) || { name: c2.rest } };
      }
      return { action: verb === 'todecktop' ? 'toDeckTop'
                     : verb === 'tomana' ? 'toMana' : verb === 'tograve' ? 'toGrave'
                     : verb === 'tohand' ? 'toHand' : verb === 'toshield' ? 'toShield' : verb,
               count: c.count, optional: !!c.optional, selector: sel };
    }
    case 'fromhand': {
      const n = parseInt(rest[0], 10) || 1;
      const arrow = rest.indexOf('->');
      const dest = arrow > -1 ? (rest[arrow + 1] || 'shield').toLowerCase() : 'shield';
      const verbFor = { shield: 'toShield', mana: 'toMana', grave: 'toGrave',
                        battle: 'toBattle', deck: 'toDeck' }[dest] || 'toShield';
      return { action: verbFor, count: n, optional: !!(mods && mods.optional),
               selector: { name: 'ownHand', side: 'own', zone: 'hand', filters: [], accessor: null } };
    }
    case 'fromdeck': {
      const n = parseInt(rest[0], 10) || 1;
      const arrow = rest.indexOf('->');
      return { action: 'fromDeck', count: n, to: arrow > -1 ? (rest[arrow + 1] || 'mana').toLowerCase() : 'mana' };
    }
    case 'search': {
      const arrow = rest.indexOf('->');
      const filterText = (arrow > -1 ? rest.slice(0, arrow) : rest).join(' ');
      return { action: 'search',
               filter: filterText.toLowerCase() === 'any' ? null : (parseSelector(filterText) || { raw: filterText }),
               to: arrow > -1 ? (rest[arrow + 1] || 'hand').toLowerCase() : 'hand',
               reveal: !!mods.reveal };
    }
    case 'grant': {
      const kw = rest[0] || '';
      const kwm = kw.match(/^([a-zA-Z]+)(?:\[(.*)\])?$/);
      const c = parseCount(rest.slice(1));
      return { action: 'grant',
               keyword: kwm ? kwm[1] : kw,
               arg: kwm && kwm[2] ? kwm[2] : null,
               count: c.count, optional: !!c.optional,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'prevent': {
      const what = rest[0];
      // "spell[!civ=Light]" is a description of a card, not a zone, so it needs the
      // card-filter parser rather than parseSelector (which only knows zones).
      const sel = rest.length > 1 ? parseCardFilter(rest.slice(1).join(' ')) : null;
      return { action: 'prevent', what, cardFilter: sel };
    }
    case 'costplus': case 'costminus': {
      const amt = parseInt(rest[0], 10) || 1;
      const sel = parseSelector(rest.slice(1).join(' '));
      return { action: verb === 'costplus' ? 'costPlus' : 'costMinus',
               amount: amt, selector: sel || { name: rest.slice(1).join(' ') },
               min: mods.min != null ? mods.min : null };
    }
    case 'look': {
      const c = parseCount(rest);
      return { action: 'look', count: c.count, optional: !!c.optional,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'discard': {
      const c = parseCount(rest);
      return { action: 'ownDiscard', count: c.count, optional: !!c.optional,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'reshufflehand': {
      return { action: 'reshuffleHand', selector: parseSelector(rest.join(' ')) || { name: rest.join(' ') } };
    }
    case 'tobattle': {
      const c = parseCount(rest);
      return { action: 'toBattle', count: c.count, optional: !!c.optional,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'todeckbottom': {
      const c = parseCount(rest);
      return { action: 'toDeckBottom', count: c.count,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'todeck': {
      const c = parseCount(rest);
      return { action: 'toDeck', count: c.count, shuffled: !!mods.shuffled,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'break': case 'breakshield': {
      const c = parseCount(rest);
      return { action: 'breakShield', count: c.count,
               selector: parseSelector(c.rest) || { name: c.rest } };
    }
    case 'looktop': {
      const n = parseInt(rest[0], 10) || 1;
      const arrow = rest.indexOf('->');
      return { action: 'lookTop', count: n, then: arrow > -1 ? (rest[arrow + 1] || 'reorder').toLowerCase() : 'reorder' };
    }
    case 'oppdraw': {
      const c = parseCount(rest);
      return { action: 'oppDraw', count: c.count, optional: !!c.optional };
    }
    case 'namecost': return { action: 'nameCost' };
    case 'choose': {
      // a bare "choose N X -> dest": the movement is carried by the destination
      const c = parseCount(rest);
      return { action: destination === 'battle' ? 'toBattle' : destination === 'hand' ? 'toHand' : 'choose',
               count: c.count, optional: !!c.optional,
               selector: parseSelector(c.rest) || { name: c.rest }, to: destination };
    }
    case 'faceup': return { action: 'faceUp', selector: parseSelector(rest.join(' ')) || { name: rest.join(' ') } };
    case 'peek':   return { action: 'peek',   selector: parseSelector(rest.join(' ')) || { name: rest.join(' ') } };
    case 'reveal': return { action: 'reveal', selector: parseSelector(rest.join(' ')) || { name: rest.join(' ') } };
    case 'arrangedecktop': return { action: 'arrangeDeckTop', count: parseInt(rest[0], 10) || 1 };
    case 'extraturn': return { action: 'extraTurn' };
    case 'losegame': return { action: 'loseGame', when: (rest[0] || '').toLowerCase() || null };
    case 'cast': {
      return { action: 'castTarget', free: !!(mods && mods.free),
               selector: parseSelector(rest[0]) || { name: rest[0] } };
    }
    case 'eachdiscard': {
      const kindWord = (rest[0] || 'random').toLowerCase();
      const c = parseCount(rest.slice(1));
      return { action: 'eachDiscard', mode: kindWord, count: c.count };
    }
    case 'namecard': return { action: 'nameCard', selector: parseSelector(rest.join(' ')) || { name: rest.join(' ') } };
    case 'ownkeeps': case 'oppkeeps': {
      const restStr = rest.join(' ');
      const km = restStr.match(/^(\S+)(?:\s+of\s+(\d+))?\s+([^,]+?)(?:\s*,\s*rest\s*->\s*(\w+))?$/i);
      if (!km) return null;
      return { action: verb === 'ownkeeps' ? 'ownKeeps' : 'oppKeeps',
               keep: /^\d+$/.test(km[1]) ? parseInt(km[1], 10) : { dynamic: km[1] },
               pool: km[2] ? parseInt(km[2], 10) : null,
               selector: parseSelector(km[3].trim()) || { name: km[3].trim() },
               rest: km[4] ? km[4].toLowerCase() : 'hand' };
    }
    case 'namerace': return { action: 'nameRace' };
    case 'nameciv': return { action: 'nameCiv' };
    default:
      return null;
  }
}

// "spell[!civ=Light]", "creature[race~Dragon]", "anyCard[civ=Light]" — a description
// of a card rather than a place to look for one.
function parseCardFilter(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/^([a-zA-Z]+)(?:\[(.*)\])?$/);
  if (!m) return null;
  const out = { kind: m[1].toLowerCase(), filters: [] };
  if (m[2]) {
    for (const f of splitTop(m[2], ',')) {
      const neg = f.startsWith('!');
      const body = neg ? f.slice(1) : f;
      const cmp = body.match(/^([a-zA-Z]+)\s*(<=|>=|~|=|<|>)\s*(.+)$/);
      if (cmp) out.filters.push({ key: cmp[1].toLowerCase(), op: cmp[2], value: cmp[3].trim(), negate: neg });
      else out.filters.push({ key: body.toLowerCase(), op: 'flag', value: true, negate: neg });
    }
  }
  return out;
}

// The bracket on a trigger, e.g. onAnyCreatureEnter[own,race=Ghost]
function parseTriggerFilter(raw) {
  const out = { side: null, filters: [] };
  for (const part of splitTop(raw, ',')) {
    const t = part.trim();
    const low = t.toLowerCase();
    if (low === 'own' || low === 'owncreature') { out.side = 'own'; continue; }
    if (low === 'opp' || low === 'oppcreature') { out.side = 'opp'; continue; }
    const cmp = t.match(/^([a-zA-Z]+)\s*(?:contains|~|=)\s*(.+)$/i);
    if (cmp) { out.filters.push({ key: cmp[1].toLowerCase(), op: /contains|~/i.test(t) ? '~' : '=', value: cmp[2].trim() }); continue; }
    out.filters.push({ key: low, op: 'flag', value: true });
  }
  return out;
}

function parseEffect(text, cardName) {
  const clauses = splitTop(String(text || ''), ';');
  const out = { effects: [], properties: {}, errors: [] };
  let lastTrigger = null;
  for (const c of clauses) {
    const parsed = parseClause(c, cardName, lastTrigger);
    if (parsed && parsed.kind === 'effect' && parsed.trigger) lastTrigger = parsed.trigger;
    if (!parsed) continue;
    if (parsed.kind === 'error') out.errors.push(parsed);
    else if (parsed.kind === 'property') out.properties[parsed.property] = parsed;
    else out.effects.push(parsed);
  }
  return out;
}

module.exports = { parseEffect, parseClause, parseSelector, parseCardFilter, TRIGGERS };
