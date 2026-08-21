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
  'onoppmanatograve', 'onoppsummon', 'onoppplay', 'ondiscard'
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
  target: { side: 'any', zone: 'target' }
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
  let accessor = null;
  const acc = raw.match(/^(.*)\.(topCard|count)$/);
  if (acc) { raw = acc[1]; accessor = acc[2]; }
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
  const text = words.join(' ');
  let m;
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

function parseClause(raw, cardName) {
  const clause = raw.trim();
  if (!clause) return null;

  // card-level property, no trigger
  let m = clause.match(/^resolvesTo\s+(mana|grave|hand)(\s+tapped)?$/i);
  if (m) return { kind: 'property', property: 'resolvesTo', to: m[1].toLowerCase(), tapped: !!m[2] };

  m = clause.match(/^([a-zA-Z]+)\s*:\s*(.+)$/);
  if (!m) return { kind: 'error', reason: 'no trigger prefix', text: clause };
  const trigger = m[1].toLowerCase();
  if (!TRIGGERS.has(trigger)) return { kind: 'error', reason: 'unknown trigger "' + m[1] + '"', text: clause };

  let body = m[2].trim();

  // trailing modifiers: ", optional", ", oppChoice", ", reveal"
  const mods = {};
  body = body.replace(/,\s*(optional|oppChoice|reveal|untilNextTurn|shuffled|noShieldTrigger)\b/gi, (_, w) => {
    mods[w.toLowerCase()] = true; return '';
  }).trim();
  // ", min 2" puts a floor under a cost reduction
  body = body.replace(/,\s*min\s+(\d+)\b/i, (_, n) => { mods.min = parseInt(n, 10); return ''; }).trim();

  // "... if <condition>"
  let condition = null;
  const ifIdx = body.toLowerCase().lastIndexOf(' if ');
  if (ifIdx > -1) {
    condition = body.slice(ifIdx + 4).trim();
    body = body.slice(0, ifIdx).trim();
  }
  if (/^if\s+/i.test(body)) { condition = body.replace(/^if\s+/i, '').trim(); body = ''; }

  // "... orElse <action>"
  let orElse = null;
  const oe = body.split(/\s+orElse\s+/i);
  if (oe.length === 2) { body = oe[0].trim(); orElse = oe[1].trim(); }

  const action = parseAction(body, mods);
  if (!action) return { kind: 'error', reason: 'unrecognised action', text: clause };

  return Object.assign({ kind: 'effect', trigger, condition, orElse, card: cardName }, action, { mods });
}

function parseAction(body, mods) {
  if (!body) return { action: 'condition' };
  const words = body.split(/\s+/);
  const verb = words[0].toLowerCase();

  // "-> hand" / "-> mana" (replacement effects)
  if (verb === '->') return { action: 'moveSelf', to: words[1] ? words[1].toLowerCase() : 'hand' };

  // "+2000 self per ownGrave[civ=Fire]"
  // the selector may contain spaces inside its brackets, e.g. [race=Beast Folk]
  const SEL = '[a-zA-Z]+(?:\\[[^\\]]*\\])?';
  const plus = body.match(new RegExp('^\\+(\\d+)\\s+(' + SEL + ')(?:\\s+per\\s+(' + SEL + '))?', 'i'));
  if (plus) {
    return { action: 'buff', amount: parseInt(plus[1], 10),
             target: parseSelector(plus[2]) || { name: plus[2] },
             per: plus[3] ? (parseSelector(plus[3]) || { name: plus[3] }) : null };
  }

  const rest = words.slice(1);

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
      return { action: verb === 'todecktop' ? 'toDeckTop'
                     : verb === 'tomana' ? 'toMana' : verb === 'tograve' ? 'toGrave'
                     : verb === 'tohand' ? 'toHand' : verb === 'toshield' ? 'toShield' : verb,
               count: c.count, optional: !!c.optional, selector: sel };
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
      const sel = rest.length > 1 ? parseSelector(rest.slice(1).join(' ')) : null;
      return { action: 'prevent', what, selector: sel };
    }
    case 'oppkeeps': {
      // "oppKeeps 1 of 2 oppCreature, rest -> destroy"
      const restStr = rest.join(' ');
      const km = restStr.match(/^(\S+)(?:\s+of\s+(\d+))?\s+(\S+?)(?:,\s*rest\s*->\s*(\w+))?$/i);
      if (!km) return null;
      return { action: 'oppKeeps',
               keep: /^\d+$/.test(km[1]) ? parseInt(km[1], 10) : { dynamic: km[1] },
               pool: km[2] ? parseInt(km[2], 10) : null,
               selector: parseSelector(km[3]) || { name: km[3] },
               rest: km[4] ? km[4].toLowerCase() : 'hand' };
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
    case 'namerace': return { action: 'nameRace' };
    case 'nameciv': return { action: 'nameCiv' };
    default:
      return null;
  }
}

function parseEffect(text, cardName) {
  const clauses = splitTop(String(text || ''), ';');
  const out = { effects: [], properties: {}, errors: [] };
  for (const c of clauses) {
    const parsed = parseClause(c, cardName);
    if (!parsed) continue;
    if (parsed.kind === 'error') out.errors.push(parsed);
    else if (parsed.kind === 'property') out.properties[parsed.property] = parsed;
    else out.effects.push(parsed);
  }
  return out;
}

module.exports = { parseEffect, parseClause, parseSelector, TRIGGERS };
