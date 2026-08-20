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
  let votedRematch = false;

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

  // ---- mana: what can it actually afford right now? -------------------------
  // Knowing this is what lets the bot plan a turn instead of guessing and being
  // refused. Mirrors the server's payment rule: one card per point of cost, and at
  // least one card of each civilization the card requires.
  function untappedMana(state) { return myState(state).mana.filter(m => !m.tapped); }
  function manaCivs(id) { return meta(id).civs || []; }

  function canAfford(state, cardId) {
    const m = meta(cardId);
    if (m.cost == null) return true;                 // unknown — let the server judge
    const pool = untappedMana(state);
    if (pool.length < m.cost) return false;
    const need = m.civs || [];
    if (!need.length) return true;
    // assign one distinct mana card to each required civilization
    const used = new Set();
    for (const civ of need) {
      const hit = pool.find(x => !used.has(x.key) && manaCivs(x.id).includes(civ));
      if (!hit) return false;
      used.add(hit.key);
    }
    return true;
  }

  // ---- board reading --------------------------------------------------------
  function untappedBlockers(player) {
    return player.battlezone.filter(c => !c.tapped && meta(c.id).blocker);
  }
  function isThreat(card) {
    // rough danger score: power, plus a premium for blockers and breakers
    let t = livePowerOf(card);
    if (meta(card.id).blocker) t += 3000;
    if (meta(card.id).doubleBreaker) t += 2000;
    if (meta(card.id).tripleBreaker) t += 4000;
    if (meta(card.id).slayer) t += 2000;
    return t;
  }
  function bestRemovalTarget(list) {
    if (!list.length) return null;
    return list.slice().sort((a, b) => isThreat(b) - isThreat(a))[0];
  }

  // ---- mana charging --------------------------------------------------------
  // Keeps castable cards in hand, and makes sure the civilizations it actually
  // needs are represented in the mana zone.
  function pickManaCard(state) {
    const me = myState(state);
    if (!me.hand.length) return null;
    const haveCivs = new Set();
    me.mana.forEach(m => manaCivs(m.id).forEach(c => haveCivs.add(c)));

    const counts = {};
    me.hand.forEach(c => { counts[c.id] = (counts[c.id] || 0) + 1; });

    const scored = me.hand.map(c => {
      let score = 0;
      const civs = manaCivs(c.id);
      // a civilization it can't otherwise produce is valuable in the mana zone
      if (civs.length && !civs.some(v => haveCivs.has(v))) score -= 4;
      if (counts[c.id] > 1) score += 3;                       // spare copy
      if (isEvolution(c.id)) score += 2;                       // often stuck in hand
      score += Math.max(0, costOf(c.id) - (me.mana.length + 2)); // out of reach for a while
      if (isSpell(c.id)) score += 1;
      if (canAfford(state, c.id)) score -= 2;                  // castable now — keep it
      if (powerOf(c.id) >= 5000) score -= 2;                   // strong body, keep it
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].c;
  }

  // ---- what to play this turn ----------------------------------------------
  // Removal comes first (clearing blockers before attacking), then bodies, then
  // value spells with whatever mana is left.
  function pickPlay(state) {
    const me = myState(state), opp = oppState(state);
    const affordable = me.hand.filter(c => !unaffordable.has(c.key) && canAfford(state, c.id));
    if (!affordable.length) return null;

    const oppCreatures = opp.battlezone.filter(c => !isSpell(c.id));
    const oppBlockers = untappedBlockers(opp);

    const nameOfCard = c => (nameOf(c.id) || '').toLowerCase();

    // 1. removal — only when there's something worth removing
    const removal = affordable.filter(c => /terror pit|death smoke|crimson hammer|tornado flame|searing wave|apocalypse vise|volcano charger|miraculous rebirth|critical blade|natural snare|spiral gate|aqua surfer|corile/.test(nameOfCard(c)));
    if (removal.length && oppCreatures.length) {
      // worth it if it can answer a real threat, and especially a blocker in the way
      const target = bestRemovalTarget(oppCreatures);
      const worthIt = oppBlockers.length > 0 || isThreat(target) >= 4000 || oppCreatures.length >= 2;
      if (worthIt) {
        removal.sort((a, b) => costOf(a.id) - costOf(b.id));   // cheapest answer first
        return removal[0];
      }
    }

    // 2. evolution, when a base is available — usually the strongest play available
    const evo = affordable.filter(c => isEvolution(c.id) && evolutionBaseFor(state, c));
    if (evo.length) {
      evo.sort((a, b) => powerOf(b.id) - powerOf(a.id));
      return evo[0];
    }

    // 3. creatures — biggest body the mana allows, blockers valued when behind
    const creatures = affordable.filter(c => !isSpell(c.id) && !isEvolution(c.id));
    if (creatures.length) {
      const behind = me.battlezone.length < opp.battlezone.length;
      creatures.sort((a, b) => {
        const va = powerOf(a.id) + (behind && meta(a.id).blocker ? 3000 : 0);
        const vb = powerOf(b.id) + (behind && meta(b.id).blocker ? 3000 : 0);
        return vb - va || costOf(b.id) - costOf(a.id);
      });
      return creatures[0];
    }

    // 4. value spells (draw/search/disruption) with spare mana
    const value = affordable.filter(c => {
      if (!isSpell(c.id)) return false;
      const n = nameOfCard(c);
      if (/ghost touch|locomotiver|cranium clamp|lost soul|gigabalza|rain of arrows/.test(n)) return opp.handCount > 0;
      if (/holy awe/.test(n)) return opp.battlezone.some(x => !x.tapped);
      if (/logic cube|brain serum|energy stream|crystal memory|dimension gate/.test(n)) return true;
      return false;
    });
    if (value.length) {
      value.sort((a, b) => costOf(a.id) - costOf(b.id));
      return value[0];
    }
    return null;
  }

  function evolutionBaseFor(state, card) {
    const me = myState(state);
    const a = racesOf(card.id);
    // evolve from the weakest valid base, keeping the better body on the table
    const bases = me.battlezone.filter(b => {
      const bb = racesOf(b.id);
      return a.length && bb.length && a.some(r => bb.includes(r));
    });
    if (!bases.length) return null;
    bases.sort((x, y) => powerOf(x.id) - powerOf(y.id));
    return bases[0];
  }

  // ---- attacking ------------------------------------------------------------
  function planAttack(state) {
    const me = myState(state), opp = oppState(state);
    const ready = me.battlezone.filter(c =>
      !c.tapped && canAttackAtAll(c.id) && !isSummoningSick(state, c) && !isSpell(c.id) &&
      !unaffordable.has('atk:' + c.key));
    if (!ready.length) return null;

    const blockers = untappedBlockers(opp);
    const strongestBlocker = blockers.length
      ? blockers.slice().sort((a, b) => livePowerOf(b) - livePowerOf(a))[0] : null;

    // LETHAL: no shields and nothing can block — swing for the win immediately
    if (!opp.shields.length && !blockers.length) {
      const finisher = ready.find(c => canAttackShields(c.id));
      if (finisher) return { key: finisher.key, target: { type: 'shield' } };
    }

    ready.sort((a, b) => livePowerOf(b) - livePowerOf(a));

    for (const atk of ready) {
      const myPow = livePowerOf(atk) + (meta(atk.id).powerAttacker || 0);
      const survivesBlock = !strongestBlocker || myPow > livePowerOf(strongestBlocker);
      const expendable = livePowerOf(atk) <= 2000;   // small body, fine to trade

      // a clean kill on a creature it beats
      const targets = opp.battlezone.filter(v => {
        if (!v.tapped && !canAttackUntapped(atk.id)) return false;
        if (/blocker only/.test(meta(atk.id).attackRestriction || '') && !meta(v.id).blocker) return false;
        return true;
      });
      const killable = targets.filter(v => myPow > livePowerOf(v));
      if (killable.length) {
        // take out the most dangerous creature it can actually beat
        const victim = bestRemovalTarget(killable);
        return { key: atk.key, target: { type: 'creature', key: victim.key } };
      }

      // otherwise go at the shields, but don't feed a good creature to a bigger blocker
      if (canAttackShields(atk.id) && (survivesBlock || expendable || !opp.shields.length)) {
        const shieldKey = opp.shields.length ? opp.shields[0].key : null;
        return { key: atk.key, target: shieldKey ? { type: 'shield', key: shieldKey } : { type: 'shield' } };
      }
    }
    return null;
  }

  // ---- blocking -------------------------------------------------------------
  function pickBlocker(state) {
    const me = myState(state), opp = oppState(state);
    const cb = state.combat;
    if (!cb) return null;
    const atk = opp.battlezone.find(c => c.key === cb.attackerKey);
    if (!atk) return null;
    const atkPow = livePowerOf(atk) + (meta(atk.id).powerAttacker || 0);
    const blockers = untappedBlockers(me);
    if (!blockers.length) return null;

    const wouldLoseGame = cb.target.type === 'shield' && me.shields.length === 0;
    const lastShield = cb.target.type === 'shield' && me.shields.length === 1;

    // a blocker that survives and kills the attacker is always worth it
    const winners = blockers.filter(b => livePowerOf(b) > atkPow);
    if (winners.length) {
      winners.sort((a, b) => livePowerOf(a) - livePowerOf(b));   // smallest that still wins
      return winners[0].key;
    }
    // trading evenly is fine against a serious attacker
    const trades = blockers.filter(b => livePowerOf(b) === atkPow || meta(b.id).slayer);
    if (trades.length && (isThreat(atk) >= 4000 || wouldLoseGame || lastShield)) {
      trades.sort((a, b) => livePowerOf(a) - livePowerOf(b));
      return trades[0].key;
    }
    // chump-block only to stay alive
    if (wouldLoseGame) {
      blockers.sort((a, b) => livePowerOf(a) - livePowerOf(b));
      return blockers[0].key;
    }
    return null;   // let the shield break — cards and triggers are worth more
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
        // pitch what it can't cast soon, keeping castable cards and strong bodies
        const ranked = me.hand.slice().sort((a, b) => {
          const va = (costOf(a.id) * 100) - powerOf(a.id) / 10;
          const vb = (costOf(b.id) * 100) - powerOf(b.id) / 10;
          return vb - va;
        });
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
      const takingBack = (pm.action === 'toHand' || pm.action === 'toOwnMana');
      cands.sort((a, b) => takingBack ? (powerOf(b.id) - powerOf(a.id)) : (isThreat(b) - isThreat(a)));
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
      if (ownZone) {
        // giving something up: pick the least valuable thing it owns
        cands.sort((a, b) => (isThreat(a) || powerOf(a.id)) - (isThreat(b) || powerOf(b.id)));
      } else if (eff.action === 'toHand' || eff.zone === 'ownGrave') {
        // recovering a card: take the strongest thing available
        cands.sort((a, b) => powerOf(b.id) - powerOf(a.id));
      } else {
        // hitting the opponent: blockers and big bodies first
        cands.sort((a, b) => isThreat(b) - isThreat(a));
      }
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

    // Play the best affordable card. Affordability is checked here rather than
    // discovered through rejections, so it can pick the strongest legal play and
    // keep casting while mana remains.
    const play = pickPlay(state);
    if (play) {
      const msg = { type: 'summonCard', key: play.key };
      if (isEvolution(play.id)) {
        const base = evolutionBaseFor(state, play);
        if (base) msg.baseKey = base.key;
      }
      lastAttemptKey = play.key;
      act(() => send(msg), DELAY.normal);
      return true;
    }

    const attack = planAttack(state);
    if (attack && !unaffordable.has('atk:' + attack.key)) {
      lastAttemptKey = 'atk:' + attack.key;
      act(() => send({ type: 'declareAttack', key: attack.key, target: attack.target }), DELAY.slow);
      return true;
    }

    act(() => send({ type: 'endTurn' }), DELAY.normal);
    return true;
  }

  // ---- main loop ------------------------------------------------------------
  function onState(state) {
    if (!active || !state) return;
    lastState = state;
    if (state.gameOver) {
      // both players must vote, so the bot accepts a rematch rather than leaving
      // the human staring at a button that never does anything
      if (!votedRematch) {
        votedRematch = true;
        act(() => send({ type: 'rematchVote' }), 1200);
      }
      return;
    }
    if (votedRematch) {
      // a fresh match has started — clear everything from the last one
      votedRematch = false;
      turnState = { turn: -1, drew: false, charged: false };
      unaffordable = new Set();
      lastActionSig = '';
      repeatCount = 0;
      lastProgressAt = Date.now();
    }
    if (thinkingTimer) return;                    // an action is already queued

    // Outstanding prompts are ALWAYS answered first, before any stall protection.
    // A pending effect can appear during the human's turn (a shield trigger the bot
    // just cast, say), and it must never be skipped — leaving one unanswered strands
    // a spell on the table and freezes the game.
    if (handlePrompts(state)) return;

    // If the human still has something to resolve — a Shield Trigger it just caused,
    // say — the bot waits rather than acting into an effect that hasn't happened yet.
    if ((oppState(state).pendingPromptCount || 0) > 0) {
      lastProgressAt = Date.now();
      return;
    }

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
    let worthCasting = true;
    try {
      const st = lastState;
      if (st) {
        const card = myState(st).hand.find(c => c.key === key);
        if (card) {
          const n = (nameOf(card.id) || '').toLowerCase();
          const opp = oppState(st), mine = myState(st);
          // removal with nothing to remove is wasted — keep it in hand instead
          if (/terror pit|death smoke|spiral gate|aqua surfer|natural snare|solar ray|crimson hammer|tornado flame|critical blade|corile/.test(n)) {
            worthCasting = opp.battlezone.length > 0;
          } else if (/holy awe/.test(n)) {
            worthCasting = opp.battlezone.some(x => !x.tapped);
          } else if (/ghost touch|locomotiver|cranium clamp|lost soul|gigabalza/.test(n)) {
            worthCasting = (opp.handCount || 0) > 0;
          }
          // when the game is on the line, take any effect that might help
          if (!worthCasting && mine.shields.length <= 1) worthCasting = opp.battlezone.length > 0;
        }
      }
    } catch (e) { /* fall back to casting */ }
    act(() => send(worthCasting
      ? { type: 'castFreeFromHand', key }
      : { type: 'shieldTriggerDecline', key }), DELAY.normal);
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

        // Never time out while the human is the one being waited on — they may be
        // deciding whether to block, or resolving a shield trigger. Cancelling the
        // attack here was pulling the block prompt out from under them.
        const cb0 = st.combat;
        const humanDeciding =
          (cb0 && cb0.phase === 'blocking' && cb0.attackerIdx === st.you) ||
          ((oppState(st).pendingPromptCount || 0) > 0);
        if (humanDeciding) { lastProgressAt = Date.now(); return; }

        if (Date.now() - lastProgressAt < 15000) return;
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
