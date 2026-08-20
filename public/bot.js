// ============================================================================
// Computer opponent.
//
// It drives the second seat exactly as a human would: its own WebSocket, its own
// view of the game, and no access to anything a real opponent couldn't see. It
// reads only its own hand and whatever is public on the table.
//
// Design note: the bot performs at most ONE action per state update. Every action
// produces a new state, which wakes it again — so a turn plays out as a readable
// sequence of steps rather than a burst, and there's no risk of a runaway loop.
// ============================================================================

const Bot = (() => {
  let active = false;
  let seatIdx = 1;
  let deck = null;
  let send = null;              // send(msg) on the bot's seat
  let thinkingTimer = null;
  let turnState = { turn: -1, drew: false, charged: false };
  let unaffordable = new Set(); // cards rejected this turn, so it stops retrying
  let lastActionSig = '';
  let repeatCount = 0;
  let lastState = null;
  let lastAttemptKey = null;
  let heartbeat = null;
  let lastProgressAt = Date.now();

  const DELAY = { fast: 420, normal: 700, slow: 950 };

  function meta(id) {
    return (typeof cardMetaFor === 'function' ? cardMetaFor(id) : {}) || {};
  }
  function nameOf(id) {
    return (typeof displayName === 'function' ? displayName(id) : id);
  }
  function isSpell(id) { return /spell/i.test(meta(id).type || ''); }
  function isEvolution(id) { return /evolution/i.test(meta(id).type || ''); }
  function powerOf(id) { const p = meta(id).power; return (p == null ? 0 : p); }
  function costOf(id) { const c = meta(id).cost; return (c == null ? 99 : c); }
  function racesOf(id) {
    return (meta(id).race || '').toLowerCase().split('/').map(r => r.trim()).filter(Boolean);
  }

  // ---- helpers over the bot's own view of the board -------------------------
  function myState(state) { return state.players[state.you]; }
  function oppState(state) { return state.players[state.you === 0 ? 1 : 0]; }

  function livePowerOf(card) {
    return (card.livePower != null) ? card.livePower : powerOf(card.id);
  }

  function canAttackAtAll(id) { return !/cannot attack/.test(meta(id).attackRestriction || ''); }
  function canAttackShields(id) {
    const r = meta(id).attackRestriction || '';
    return !/cannot attack/.test(r) && !/not players/.test(r) && !/blocker only/.test(r);
  }
  function canAttackUntapped(id) { return /untapped ok/.test(meta(id).attackRestriction || ''); }
  function isSummoningSick(state, card) {
    if (card.under && card.under.length) return false;
    if (isEvolution(card.id)) return false;
    if (meta(card.id).speedAttacker) return false;
    if (myState(state).turboRushActive) return false;
    return card.summonedTurn != null && card.summonedTurn === state.turnNumber;
  }

  // ---- decisions ------------------------------------------------------------

  // Which card to put into mana. Keeps the good stuff in hand: prefers a duplicate,
  // then the most expensive card it can't realistically cast soon.
  function pickManaCard(state) {
    const hand = myState(state).hand;
    if (!hand.length) return null;
    const counts = {};
    hand.forEach(c => { counts[c.id] = (counts[c.id] || 0) + 1; });
    const scored = hand.map(c => {
      let score = 0;
      if (counts[c.id] > 1) score += 3;            // spare copy — safe to bury
      if (isEvolution(c.id)) score += 2;           // often uncastable early
      score += Math.max(0, costOf(c.id) - 5);      // very expensive cards are dead weight
      if (isSpell(c.id)) score += 1;
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].c;
  }

  // Best creature it can try to summon. Evolution creatures only when a valid base
  // is on the table, since the server would refuse otherwise.
  function pickSummon(state) {
    const me = myState(state);
    const options = me.hand.filter(c => {
      if (unaffordable.has(c.key)) return false;
      if (isSpell(c.id)) return false;             // spells handled separately
      if (isEvolution(c.id)) {
        return me.battlezone.some(b => {
          const a = racesOf(c.id), bb = racesOf(b.id);
          return a.length && bb.length && a.some(r => bb.includes(r));
        });
      }
      return true;
    });
    if (!options.length) return null;
    // strongest creature first; cost is a tiebreak so it develops the board fast
    options.sort((a, b) => (powerOf(b.id) - powerOf(a.id)) || (costOf(a.id) - costOf(b.id)));
    return options[0];
  }

  function evolutionBaseFor(state, card) {
    const me = myState(state);
    const a = racesOf(card.id);
    return me.battlezone.find(b => {
      const bb = racesOf(b.id);
      return a.length && bb.length && a.some(r => bb.includes(r));
    }) || null;
  }

  // A spell is only cast when the bot can see something useful for it to do.
  function pickSpell(state) {
    const me = myState(state), opp = oppState(state);
    return me.hand.find(c => {
      if (!isSpell(c.id) || unaffordable.has(c.key)) return false;
      const n = (nameOf(c.id) || '').toLowerCase();
      if (/terror pit|death smoke|crimson hammer|tornado flame|searing wave|apocalypse vise|volcano charger|miraculous rebirth|critical blade/.test(n)) {
        return opp.battlezone.length > 0;          // removal needs a target
      }
      if (/spiral gate|aqua surfer|natural snare|solar ray/.test(n)) return opp.battlezone.length > 0;
      if (/ghost touch|locomotiver|cranium clamp|lost soul|gigabalza/.test(n)) return opp.handCount > 0;
      if (/holy awe/.test(n)) return opp.battlezone.some(x => !x.tapped);
      return true;                                  // draw/search spells are always fine
    }) || null;
  }

  // Attackers, strongest first. Prefers a creature kill it wins outright, else shields.
  function planAttack(state) {
    const me = myState(state), opp = oppState(state);
    const ready = me.battlezone.filter(c =>
      !c.tapped && canAttackAtAll(c.id) && !isSummoningSick(state, c) && !isSpell(c.id) &&
      !unaffordable.has('atk:' + c.key));
    if (!ready.length) return null;
    ready.sort((a, b) => livePowerOf(b) - livePowerOf(a));

    for (const atk of ready) {
      const myPow = livePowerOf(atk) + (meta(atk.id).powerAttacker || 0);
      // a favourable trade against a creature it can legally hit
      const targets = opp.battlezone.filter(v => {
        if (!v.tapped && !canAttackUntapped(atk.id)) return false;
        if (/blocker only/.test(meta(atk.id).attackRestriction || '') && !meta(v.id).blocker) return false;
        return true;
      });
      const killable = targets.filter(v => myPow > livePowerOf(v));
      if (killable.length) {
        killable.sort((a, b) => livePowerOf(b) - livePowerOf(a));   // take the biggest one it beats
        return { key: atk.key, target: { type: 'creature', key: killable[0].key } };
      }
      if (canAttackShields(atk.id)) {
        // no shields left means this is the winning blow
        const shieldKey = opp.shields.length ? opp.shields[0].key : null;
        return { key: atk.key, target: shieldKey ? { type: 'shield', key: shieldKey } : { type: 'shield' } };
      }
    }
    return null;
  }

  // Block only when the blocker survives, or when the attack would otherwise end the game.
  function pickBlocker(state) {
    const me = myState(state), opp = oppState(state);
    const cb = state.combat;
    if (!cb) return null;
    const atk = opp.battlezone.find(c => c.key === cb.attackerKey);
    if (!atk) return null;
    const atkPow = livePowerOf(atk) + (meta(atk.id).powerAttacker || 0);
    const blockers = me.battlezone.filter(c => !c.tapped && meta(c.id).blocker);
    if (!blockers.length) return null;

    const survivors = blockers.filter(b => livePowerOf(b) > atkPow);
    if (survivors.length) {
      survivors.sort((a, b) => livePowerOf(a) - livePowerOf(b));    // cheapest that still wins
      return survivors[0].key;
    }
    // losing the blocker is worth it to avoid losing the game, or to stop a shield break
    const desperate = cb.target.type === 'shield' && me.shields.length <= 1;
    if (desperate) {
      blockers.sort((a, b) => livePowerOf(a) - livePowerOf(b));
      return blockers[0].key;
    }
    return null;
  }

  // ---- prompt handling ------------------------------------------------------
  // Returns true if it handled something (one action per wake-up).
  function handlePrompts(state) {
    const me = myState(state), opp = oppState(state);

    // forced discards — pitch the least useful cards
    if (me.pendingDiscards && me.pendingDiscards.length) {
      const eff = me.pendingDiscards[0];
      let keys = [];
      if (eff.kind === 'choose') {
        const ranked = me.hand.slice().sort((a, b) => costOf(b.id) - costOf(a.id));
        keys = ranked.slice(0, eff.count).map(c => c.key);
      }
      act(() => send({ type: 'effectDiscardResolve', effectId: eff.id, keys }), DELAY.normal);
      return true;
    }

    // Ice Vapor: give up the least useful mana card
    if (me.pendingManaDiscards > 0 && me.mana.length) {
      const pick = me.mana.slice().sort((a, b) => costOf(b.id) - costOf(a.id))[0];
      act(() => send({ type: 'effectDiscardMana', key: pick.key }), DELAY.normal);
      return true;
    }

    if (me.pendingRaceChoice) {
      // name whichever race the bot itself fields most
      const counts = {};
      me.battlezone.forEach(c => racesOf(c.id).forEach(r => { counts[r] = (counts[r] || 0) + 1; }));
      const ex = (me.pendingRaceChoice.excludeRace || '').toLowerCase();
      const best = Object.keys(counts).filter(r => r !== ex).sort((a, b) => counts[b] - counts[a])[0];
      const race = best ? best.replace(/\b\w/g, ch => ch.toUpperCase()) : 'Guardian';
      act(() => send({ type: 'choosePetrovaRace', race }), DELAY.normal);
      return true;
    }

    if (me.pendingTruce) {
      const civCount = {};
      opp.battlezone.forEach(c => (meta(c.id).civs || []).forEach(v => { civCount[v] = (civCount[v] || 0) + 1; }));
      const civ = Object.keys(civCount).sort((a, b) => civCount[b] - civCount[a])[0] || 'Fire';
      act(() => send({ type: 'chooseTruceCiv', civ }), DELAY.normal);
      return true;
    }

    if (me.pendingMulti) {
      const pm = me.pendingMulti;
      const pool = {
        oppBattle: opp.battlezone, ownBattle: me.battlezone,
        anyBattle: me.battlezone.concat(opp.battlezone),
        ownGrave: me.graveyard, ownMana: me.mana, oppMana: opp.mana, ownHand: me.hand
      }[pm.zone] || [];
      let cands = pm.keys.map(k => pool.find(c => c.key === k)).filter(Boolean);
      // for anything destructive, hit the biggest threats first
      cands.sort((a, b) => powerOf(b.id) - powerOf(a.id));
      const max = pm.max && pm.max < 90 ? pm.max : cands.length;
      const keys = cands.slice(0, max).map(c => c.key);
      act(() => send({ type: 'effectMultiResolve', effectId: pm.id, keys }), DELAY.normal);
      return true;
    }

    if (me.pendingTargets && me.pendingTargets.length) {
      const eff = me.pendingTargets[0];
      const pool = {
        oppBattle: opp.battlezone, ownBattle: me.battlezone, ownHand: me.hand,
        ownMana: me.mana, oppMana: opp.mana, ownShield: me.shields, ownGrave: me.graveyard,
        anyBattle: me.battlezone.concat(opp.battlezone)
      }[eff.zone] || [];
      let cands = pool.filter(c => c.key !== eff.sourceKey);
      if (eff.filter === 'untapped') cands = cands.filter(c => !c.tapped);
      if (eff.filter === 'creature') cands = cands.filter(c => !isSpell(c.id));
      if (eff.filter === 'spell') cands = cands.filter(c => isSpell(c.id));
      if (eff.filter === 'nonEvolution') cands = cands.filter(c => !isEvolution(c.id));
      if (eff.requireBlocker) cands = cands.filter(c => meta(c.id).blocker);
      if (eff.maxPower != null) cands = cands.filter(c => powerOf(c.id) <= eff.maxPower);

      if (!cands.length) { act(() => send({ type: 'effectTargetSkip', effectId: eff.id }), DELAY.fast); return true; }
      // hitting the opponent: take their best. Choosing its own: give up the weakest.
      const ownZone = (eff.zone === 'ownBattle' || eff.zone === 'ownHand' || eff.zone === 'ownMana' || eff.zone === 'ownShield');
      cands.sort((a, b) => ownZone ? (powerOf(a.id) - powerOf(b.id)) : (powerOf(b.id) - powerOf(a.id)));
      act(() => send({ type: 'effectTarget', effectId: eff.id, key: cands[0].key }), DELAY.normal);
      return true;
    }

    return false;
  }

  // ---- the turn -------------------------------------------------------------
  function takeTurn(state) {
    const me = myState(state), opp = oppState(state);

    if (turnState.turn !== state.turnNumber) {
      turnState = { turn: state.turnNumber, drew: false, charged: false };
      unaffordable = new Set();
    }

    if (!turnState.drew && me.deckCount > 0) {
      turnState.drew = true;
      act(() => send({ type: 'drawCard' }), DELAY.fast);
      return true;
    }

    if (!turnState.charged && me.hand.length) {
      turnState.charged = true;
      const card = pickManaCard(state);
      if (card) { act(() => send({ type: 'chargeMana', key: card.key }), DELAY.normal); return true; }
    }

    const creature = pickSummon(state);
    if (creature) {
      const base = isEvolution(creature.id) ? evolutionBaseFor(state, creature) : null;
      const msg = { type: 'summonCard', key: creature.key };
      if (base) msg.baseKey = base.key;
      lastAttemptKey = creature.key;
      act(() => send(msg), DELAY.normal);
      return true;
    }

    const spell = pickSpell(state);
    if (spell) {
      lastAttemptKey = spell.key;
      act(() => send({ type: 'summonCard', key: spell.key }), DELAY.normal);
      return true;
    }

    const attack = planAttack(state);
    if (attack && !unaffordable.has('atk:' + attack.key)) {
      lastAttemptKey = 'atk:' + attack.key;   // so a refused attack isn't retried forever
      act(() => send({ type: 'declareAttack', key: attack.key, target: attack.target }), DELAY.slow);
      return true;
    }

    act(() => send({ type: 'endTurn' }), DELAY.normal);
    return true;
  }

  // ---- main loop ------------------------------------------------------------
  function onState(state) {
    if (!active || !state || state.gameOver) return;
    lastState = state;
    if (thinkingTimer) return;                    // an action is already queued

    // Outstanding prompts are ALWAYS answered first, before any stall protection.
    // A pending effect can appear during the human's turn (a shield trigger the bot
    // just cast, say), and it must never be skipped — leaving one unanswered strands
    // a spell on the table and freezes the game.
    if (handlePrompts(state)) return;

    // Stall protection only guards the bot's own idle looping, never its prompts.
    const me = myState(state);
    const sig = JSON.stringify([state.turnNumber, state.activeTurn,
      me.hand.length, me.battlezone.length, me.mana.length,
      (me.pendingTargets || []).length, (me.pendingDiscards || []).length,
      me.pendingMulti ? 1 : 0, me.pendingSearch ? 1 : 0,
      (state.combat && state.combat.phase) || '']);
    if (sig === lastActionSig) {
      if (++repeatCount > 6) {
        // out of useful moves — end the turn rather than sitting there
        if (state.activeTurn === state.you && !state.combat) {
          repeatCount = 0;
          act(() => send({ type: 'endTurn' }), DELAY.fast);
        }
        return;
      }
    } else { lastActionSig = sig; repeatCount = 0; lastProgressAt = Date.now(); }

    const cb = state.combat;
    if (cb && cb.phase === 'blocking' && cb.attackerIdx !== state.you) {
      const blocker = pickBlocker(state);
      act(() => send(blocker ? { type: 'declareBlock', blockerKey: blocker } : { type: 'declareBlock' }), DELAY.slow);
      return;
    }
    if (cb && cb.phase === 'breaking' && cb.attackerIdx === state.you) {
      const opp = oppState(state);
      if (opp.shields.length && cb.shieldsToBreak > 0) {
        act(() => send({ type: 'breakShield', key: opp.shields[0].key }), DELAY.normal);
      } else {
        act(() => send({ type: 'cancelCombat' }), DELAY.fast);
      }
      return;
    }
    // Any other combat state belongs to the human — except one the bot itself started
    // and can no longer act on, which it must close rather than wait on forever.
    if (cb) {
      if (cb.attackerIdx === state.you && cb.phase !== 'blocking') {
        act(() => send({ type: 'cancelCombat' }), DELAY.normal);
      }
      return;
    }

    if (state.activeTurn === state.you) takeTurn(state);
  }

  function act(fn, delay) {
    thinkingTimer = setTimeout(() => {
      thinkingTimer = null;
      try { fn(); } catch (e) { console.warn('bot action failed', e); }
    }, delay);
  }

  // A shield trigger offer arrives as its own message rather than in the state.
  function onShieldTrigger(key) {
    if (!active) return;
    act(() => send({ type: 'castFreeFromHand', key }), DELAY.normal);
  }
  // Tap-ability choice (Gigazald): the bot just attacks.
  function onTapMode(key) {
    if (!active) return;
    act(() => send({ type: 'battleTap', key, mode: 'attack' }), DELAY.fast);
  }
  // A rejected action (usually not enough mana). Mark the card the bot ACTUALLY tried
  // — not a guess — and wake it straight away, because a rejection produces no state
  // update, so without this the bot would simply stop mid-turn.
  function onRejected() {
    if (!active) return;
    if (lastAttemptKey) unaffordable.add(lastAttemptKey);
    lastAttemptKey = null;
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    repeatCount = 0;
    lastActionSig = '';
    if (lastState) act(() => onState(lastState), DELAY.fast);
  }
  function noteUnaffordable(key) { if (key) unaffordable.add(key); }

  return {
    start(opts) {
      active = true;
      seatIdx = opts.seatIdx;
      deck = opts.deck;
      send = opts.send;
      turnState = { turn: -1, drew: false, charged: false };
      unaffordable = new Set();
      // Heartbeat: the bot normally reacts to state pushes, but some things (a
      // rejected action, a prompt that arrived without a state change) produce none.
      // Re-checking periodically means it can never sit waiting for a wake-up that
      // isn't coming.
      if (heartbeat) clearInterval(heartbeat);
      lastProgressAt = Date.now();
      heartbeat = setInterval(() => {
        if (!active || !lastState) return;
        if (!thinkingTimer) onState(lastState);

        // Hard watchdog. If it's the bot's turn and nothing has changed for a while,
        // force the turn to end — first backing out of any attack it left open. A
        // stuck bot would otherwise freeze the human's game indefinitely, and it also
        // stops the turn counter, which makes summoning sickness look broken.
        const st = lastState;
        if (st.gameOver || st.activeTurn !== st.you) return;
        if (Date.now() - lastProgressAt < 8000) return;
        lastProgressAt = Date.now();
        if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
        const cb = st.combat;
        if (cb && cb.attackerIdx === st.you) send({ type: 'cancelCombat' });
        else send({ type: 'endTurn' });
      }, 1500);
    },
    stop() {
      active = false;
      if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    },
    isActive() { return active; },
    deck() { return deck; },
    onState, onShieldTrigger, onTapMode, onRejected, noteUnaffordable
  };
})();
