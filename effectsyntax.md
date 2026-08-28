# Effect column — syntax reference

Add one column to the spreadsheet called **Effect**. Fill it in only for cards you
actually play. Leave it blank for vanilla creatures with no ability.

Everything is written as:

```
trigger: action
```

Multiple abilities on one card are separated by a semicolon:

```
onSummon: draw 1; onSummon: fromDeck 1 -> mana
```

Case doesn't matter. Extra spaces don't matter.

---

## 0. Standing rules (not written per-card)

**Evolution.** Every Evolution Creature's "Put on one of your X" requirement is just
its own **Race** — no separate data needed. For `Type = Evolution Creature`, the valid
base to evolve onto is any own creature whose Race matches this card's own Race column.
Confirmed against every Evolution Creature seen so far (Kuukai onto Mecha Thunder,
Barkwhip onto Beast Folk, Ballom / Ballom Emperor onto Demon Command, Alcadeias onto
Angel Command, Gigazald / Gigazabal onto Chimera). If a future card's wording ever
breaks this pattern, that'll get flagged specifically when it comes up — until then,
don't add an Effect entry for evolution, the engine can derive it from Type + Race.

---

## 1. Triggers — *when* it happens

| Trigger | Fires when |
|---|---|
| `onSummon:` | the card is put into the battle zone (creatures and spells alike) |
| `onAttack:` | the creature is tapped to attack |
| `onDestroy:` | the creature would be destroyed |
| `onBreak:` | this creature breaks a shield |
| `endTurn:` | at the end of its owner's turn |
| `tapAbility:` | tapped to use its ability *instead of* attacking |
| `static:` | continuously, while it is in the battle zone |
| `cast:` | a condition that must be true to cast it at all |
| `onUnblockedAttack:` | this creature's attack on a player resolves *unblocked* |
| `onPlayerAttack:` | this creature declares an attack against a **player** specifically (not a creature) — fires regardless of block |
| `onBattleWin:` | this creature wins a battle (destroys the creature it fought), as attacker or blocker |
| `onAnyCreatureEnter:` | any *other* creature — yours or your opponent's — enters the battle zone |
| `onAnyCreatureDestroyed:` | any *other* creature — yours or your opponent's — is destroyed |
| `onBlock:` | this creature is used to block an attack |
| `onOppCast:` | your **opponent** casts a spell |
| `onBlocked:` | this creature, while attacking, just got blocked |

---

## 2. Selectors — *what* it affects

| Selector | Means |
|---|---|
| `self` | this card |
| `ownCreature` | one of your creatures |
| `otherOwnCreature` | one of your creatures, not this one |
| `oppCreature` | one of your opponent's creatures |
| `anyCreature` | either player's creature — the caster chooses |
| `ownMana` / `oppMana` | a card in that mana zone |
| `ownShield` / `oppShield` | a shield |
| `ownGrave` | a card in your graveyard |
| `ownHand` / `oppHand` | a card in that hand |

**Filters** go in square brackets and can be combined with commas:

```
oppCreature[power<=2000]
oppCreature[blocker]
anyCreature[!evolution]
ownGrave[creature]
otherOwnCreature[race=Beast Folk]
oppHand[spell,civ=Darkness]
```

Available filters: `power<=N`, `power>=N`, `blocker`, `!blocker`, `evolution`,
`!evolution`, `creature`, `spell`, `tapped`, `untapped`, `race=X`, `civ=X`, `cost=N`,
`cost<=N`.

**Counts** go before the selector:

```
destroy oppCreature              → exactly one
destroy up to 2 oppCreature      → the player may pick 0, 1 or 2
destroy all oppCreature          → no choice, hits everything matching
destroy any number of oppCreature → the player may pick zero or more, no upper cap
```

**Group filters** (as opposed to per-card filters) constrain the whole chosen set at
once rather than each card individually:

```
oppCreature[totalPower<=8000]   → the *combined* power of everything picked must be ≤8000
```

**Who chooses** the target is normally the ability's controller. Append `, oppChoice`
after the action to flip that — the target's own controller chooses instead:

```
onUnblockedAttack: destroy oppCreature, oppChoice   → your opponent picks which of their own creatures dies
```

**Optional actions** that aren't naturally counted (untap, tap, etc. — `draw`/`destroy`/
`bounce` already have `up to N` for this) take a trailing `, optional`:

```
endTurn: untap self, optional   → "you may untap this creature"
```

**Dynamic counts.** `up to N` doesn't require N to be a literal number — it can be
`<sel>.count`, so "up to as many as you have of X":

```
onSummon: bounce up to ownCreature[civ=Light].count oppMana
```

---

## 3. Actions — *what* happens

| Action | Example |
|---|---|
| `draw N` | `onSummon: draw 1` |
| `draw up to N` | `onSummon: draw up to 2` |
| `destroy <sel>` | `onSummon: destroy oppCreature[power<=2000]` |
| `bounce <sel>` | `onSummon: bounce anyCreature` (to owner's hand) |
| `toDeckTop <sel>` | `onSummon: toDeckTop oppCreature` |
| `toMana <sel>` | `onSummon: toMana oppCreature` |
| `toShield <sel>` | `onSummon: toShield anyCreature[!evolution]` |
| `toGrave <sel>` | `onSummon: toGrave ownShield` |
| `toHand <sel>` | `onSummon: toHand ownGrave[creature]` |
| `tap <sel>` / `untap <sel>` | `onSummon: tap all oppCreature[untapped]` |
| `oppDiscard random N` | `onAttack: oppDiscard random 1` |
| `oppDiscard choose N` | `onSummon: oppDiscard choose 2` |
| `oppDiscard all` | `onSummon: oppDiscard all` (whole hand) |
| `oppDiscard all <sel>[filter]` | `onSummon: oppDiscard all oppHand[spell,civ=Darkness]` (only a filtered subset) |
| `fromDeck N -> mana` | `onSummon: fromDeck 1 -> mana` |
| `fromDeck N -> shield` | `onSummon: fromDeck 1 -> shield` |
| `search <filter> -> hand` | `onSummon: search creature -> hand` |
| `search <filter> -> battle` | `onSummon: search creature[cost=X] -> battle` |
| `reveal` | added to a search: `search spell -> hand, reveal` |
| `-> hand` (bare) | `onDestroy: -> hand` — replaces destruction |
| `+N power <sel>` | `static: +2000 otherOwnCreature[race=Beast Folk]` |
| `grant <keyword> <sel>` | `static: grant unblockable self` |
| `prevent <what>` | `static: prevent oppCast spell[!civ=Light]` |
| `prevent oppBlock <sel>` | `static: prevent oppBlock oppCreature[power>=4000]` — can't be blocked by matching creatures |
| `prevent selfAttack` | `static: prevent selfAttack if oppCreature.count > ownCreature.count` |
| `prevent civAttackYou[civ=X]` | `onSummon: prevent civAttackYou[civ=named] untilNextTurn` — creatures of that civilization can't attack you |
| `nameCiv` | `onSummon: nameCiv` — choose a civilization, referenced later as `civ=named` (mirrors `nameRace`) |
| `resolvesTo mana` / `resolvesTo mana tapped` | `onSummon: draw 1; resolvesTo mana` — Charger keyword: goes to mana zone instead of the graveyard after resolving (add `tapped` if it enters tapped) |
| `oppKeeps <K> [of <N>] <sel>, rest -> <fate>` | `onSummon: oppKeeps 1 of 2 oppCreature, rest -> destroy` — the target's controller picks K to keep (sent to hand); `<fate>` for the rest defaults to `hand`, or can be `destroy` / `grave` |
| `target` (as in `target.cost`) | `onSummon: destroy oppCreature[power<=5000]; onSummon: search creature[cost=target.cost] -> battle` — refers to whatever the previous action in the same trigger resolved on |
| `grant powerAttacker[+N] <sel>` | `onSummon: grant powerAttacker[+4000] ownCreature` — a *parameterized* keyword grant (the bracket carries the number); not the same as flat `+N power`, since power attacker only applies while attacking |
| `grant attackUntapped <sel>` | `static: grant attackUntapped self` — this creature may attack an opposing creature even if it's untapped (normally only players or tapped opposing creatures are legal attack targets) |
| `grant attackableUntapped <sel>` | `onSummon: grant attackableUntapped oppCreature` — mirror image of the above, granted to the target instead: your creatures may attack it this turn even though it's untapped |
| `grant <keyword> <sel> onBlocked` | `onSummon: grant slayer ownCreature onBlocked` — a delayed grant: the next time each matching creature gets blocked this turn, it gains the keyword for that fight |
| bare `-> mana` | `onDestroy: -> mana` — replacement action (like the existing bare `-> hand`), sends the card to the mana zone instead of wherever it was headed |

**Conditions** are appended with `if`:

```
static: +2000 otherOwnCreature if self.tapped
static: +3000 self per cardInHand
onAttack: destroy ownCreature if ownCreature.count >= 2
cast: if oppShield.count > ownShield.count
endTurn: -> hand if self.brokeShieldThisTurn
```

Two conditions can be combined with `and`:

```
static: +2000 self if attacking and ownCreature[race=Human].count>=1
```

**Either/or.** `orElse` between two actions means the caster picks exactly one:

```
onSummon: destroy 2 ownCreature orElse destroy self
```

---

## 4. Your cards, written out

These are real examples from your set — copy the style.

| Card | Effect column |
|---|---|
| Aqua Hulcus | `onSummon: draw up to 1` |
| Energy Stream | `onSummon: draw 2` |
| Bronze-Arm Tribe | `onSummon: fromDeck 1 -> mana` |
| Ghost Touch | `onSummon: oppDiscard random 1` |
| Cranium Clamp | `onSummon: oppDiscard choose 2` |
| Lost Soul | `onSummon: oppDiscard all` |
| Terror Pit | `onSummon: destroy oppCreature` |
| Death Smoke | `onSummon: destroy oppCreature[untapped]` |
| Crimson Hammer | `onSummon: destroy oppCreature[power<=2000]` |
| Searing Wave | `onSummon: destroy all oppCreature[power<=3000]` |
| Apocalypse Vise | `onSummon: destroy any number of oppCreature[totalPower<=8000]` |
| Spiral Gate | `onSummon: bounce anyCreature` |
| Aqua Surfer | `onSummon: bounce up to 1 anyCreature` |
| Aqua Sniper | `onSummon: bounce up to 2 anyCreature` |
| Corile | `onSummon: toDeckTop oppCreature` |
| Natural Snare | `onSummon: toMana oppCreature` |
| Holy Awe | `onSummon: tap all oppCreature` |
| Solar Ray | `onSummon: tap oppCreature` |
| Crystal Memory | `onSummon: search any -> hand` |
| Logic Cube | `onSummon: search spell -> hand, reveal` |
| Niofa, Horned Protector | `onSummon: search creature[civ=Nature] -> hand, reveal` |
| Dark Reversal | `onSummon: toHand ownGrave[creature]` |
| Morbid Medicine | `onSummon: toHand up to 2 ownGrave[creature]` |
| Corpse Charger | `onSummon: toHand ownGrave[creature]; resolvesTo mana` |
| Aqua Soldier | `onDestroy: -> hand` |
| Pyrofighter Magnus | `endTurn: -> hand` |
| Horrid Worm | `onAttack: oppDiscard random 1` |
| Sniper Mosquito | `onAttack: toHand ownMana` |
| Daidalos, General of Fury | `onAttack: destroy ownCreature` |
| Rikabu's Screwdriver | `tapAbility: destroy oppCreature[blocker]` |
| Bliss Totem | `tapAbility: toMana up to 3 ownGrave` |
| Barkwhip, the Smasher | `static: +2000 otherOwnCreature[race=Beast Folk] if self.tapped` |
| Pala Olesis | `static: +2000 otherOwnCreature if oppTurn` |
| Petrova, Channeler of Suns | `onSummon: nameRace; static: +4000 ownCreature[race=named]; static: grant unchoosable self` |
| Quixotic Hero Swine Snout | `onAnyCreatureEnter: +3000 self` |
| Super Necrodragon Abzo Dolba | `static: +2000 self per ownGrave[creature]` |
| Magmadragon Ogrist Vhal | `static: +3000 self per cardInHand` |
| Bolshack Dragon | `static: +1000 self per ownGrave[civ=Fire] if attacking` |
| Crystal Lancer | `static: grant unblockable self` |
| Alcadeias, Lord of Spirits | `static: prevent anyCast spell[!civ=Light]` |
| Volcano Smog | `static: costPlus 2 anyCard[civ=Light]` |
| Ballom, Master of Death | `onSummon: destroy all anyCreature[!civ=Darkness]` |
| Miraculous Meltdown | `cast: if oppShield.count > ownShield.count; onSummon: oppKeeps ownShield.count oppShield, rest -> hand` |
| Diamond Cutter | `onSummon: grant ignoreAttackRestrictions all ownCreature` |
| Locomotiver | `onSummon: oppDiscard random 1` |
| Magris, Vizier of Magnetism | `onSummon: draw up to 1` |
| Trixo, Wicked Doll | `onUnblockedAttack: destroy oppCreature, oppChoice` |
| Propeller Mutant | `onDestroy: oppDiscard random 1` |
| Marrow Ooze, the Twister | `onPlayerAttack: destroy self` |
| Bone Spider | `onBattleWin: destroy self` |
| Bloody Squito | `onBattleWin: destroy self` |
| Hearty Cap'n Polligon | `endTurn: -> hand if self.brokeShieldThisTurn` |
| Comet Missile | `onSummon: destroy oppCreature[blocker,power<=6000]` |
| Spastic Missile | `onSummon: destroy oppCreature[power<=3000]` |
| Volcanic Arrows | `onSummon: destroy anyCreature[power<=6000]; onSummon: toGrave ownShield` |
| Kuukai, Finder of Karma | `onBlock: untap self` |
| Frei, Vizier of Air | `endTurn: untap self, optional` |
| Eureka Charger | `onSummon: draw 1; resolvesTo mana` |
| Calgo, Vizier of Rainclouds | `static: prevent oppBlock oppCreature[power>=4000]` |
| Snip Striker Bullraizer | `static: prevent selfAttack if oppCreature.count > ownCreature.count` |
| Rothus, the Traveler | `onSummon: destroy ownCreature; onSummon: destroy oppCreature, oppChoice` |
| Miraculous Meltdown | `cast: if oppShield.count > ownShield.count; onSummon: oppKeeps ownShield.count oppShield, rest -> hand; resolvesTo mana tapped` |
| Miraculous Plague | `onSummon: oppKeeps 1 of 2 oppCreature, rest -> destroy; onSummon: oppKeeps 1 of 2 oppMana, rest -> grave; resolvesTo mana tapped` |
| Miraculous Rebirth | `onSummon: destroy oppCreature[power<=5000]; onSummon: search creature[cost=target.cost] -> battle; resolvesTo mana tapped` |
| Miraculous Snare | `onSummon: toShield anyCreature[!evolution]; resolvesTo mana tapped` |
| Miraculous Truce | `onSummon: nameCiv; onSummon: prevent civAttackYou[civ=named] untilNextTurn; resolvesTo mana tapped` |
| Belix, the Explorer | `onSummon: toHand ownMana[spell]` |
| Ice Vapor, Shadow of Anguish | `onOppCast: oppDiscard choose 1; onOppCast: toGrave oppMana, oppChoice` |
| Phantasmal Horror Gigazald | `tapAbility: oppDiscard random 1; static: grant sharedTap[civ=Darkness] self` |
| Mist Rias, Sonic Guardian | `onAnyCreatureEnter: draw up to 1` |
| Hydro Hurricane | `onSummon: bounce up to ownCreature[civ=Light].count oppMana; onSummon: bounce up to ownCreature[civ=Darkness].count oppCreature` |
| Nomad Hero Gigio / Gatling Skyterror | `static: grant attackUntapped self` |
| Chaos Strike | `onSummon: grant attackableUntapped oppCreature` |
| Fatal Attacker Horvath | `static: +2000 self if attacking and ownCreature[race=Armorloid].count>=1` |
| Magma Gazer | `onSummon: grant powerAttacker[+4000] ownCreature; onSummon: grant doubleBreaker target` |
| Burning Power | `onSummon: grant powerAttacker[+2000] ownCreature` |
| Aura Blast | `onSummon: grant powerAttacker[+2000] all ownCreature` |
| Gigaberos | `onSummon: destroy 2 ownCreature orElse destroy self` |
| Creeping Plague | `onSummon: grant slayer ownCreature onBlocked` |
| Coiling Vines / Red-Eye Scorpion | `onDestroy: -> mana` |

(This table only tracks cards that introduced new syntax or are otherwise good reference
examples — by round 6 the full, authoritative list of every card's Effect text lives in
the spreadsheet itself, not here.)
| Poisonous Mushroom | `onSummon: toMana up to 1 ownHand` |
| Deadly Fighter Braid Claw | `static: grant mustAttack self` |
| Tornado Flame | `onSummon: destroy oppCreature[power<=4000]` |
| Rain of Arrows | `onSummon: oppDiscard all oppHand[spell,civ=Darkness]` |
| Emerald Mist | `tapAbility: bounce all anyCreature` |
| Ballom Emperor, Lord of Demons | `onSummon: destroy all anyCreature[!civ=Darkness]` |
| Gigabalza | `onSummon: oppDiscard random 1` |
| Mongrel Man | `onAnyCreatureDestroyed: draw up to 1` |
| Critical Blade | `onSummon: destroy oppCreature[blocker]` |

---

## 5. How to start

1. Add the **Effect** column at the end of the sheet.
2. Fill in **only the cards in your current decks** — the same subset you did power for.
3. Start with the easy ones (`draw`, `oppDiscard`, `destroy`) to get a feel for it.
4. Send me the sheet once you've done fifteen or twenty.

I'll build the parser against what you've actually written, and tell you plainly
where the syntax doesn't stretch far enough — then we adjust it together before you
fill in the rest. **Don't do all of them first**: the syntax will almost certainly
need a tweak or two once it meets real cards, and I'd rather you didn't have to redo
work.

Anything the parser can't read will be reported by name rather than silently
ignored, so nothing goes wrong quietly.

---

## 6. Extensions (added after round 1: Diamond Cutter, Petrova)

Two real cards didn't fit the original vocabulary. Both are covered by extending the
existing `grant <keyword> <sel>` action with two new keywords, plus one general rule
about how long a granted keyword sticks around.

**Duration rule.** A keyword granted by a `static:` trigger lasts as long as the card
stays in the battle zone (unchanged from before). A keyword granted by any *other*
trigger (`onSummon`, `onAttack`, `tapAbility`, `endTurn`) is **transient** — it lasts
only until end of the current turn, then falls off automatically. This needed no new
syntax, just an engine rule keyed off which trigger the `grant` is attached to.

**New keyword: `ignoreAttackRestrictions`.** Grants permission to attack **the
opponent** (i.e. declare an attack aimed at the opponent's shields) this turn, even if
summoning sickness or an Attack restriction value like `not players` would otherwise
forbid it. It only unlocks attacking the opponent — it never grants permission to
attack an opposing creature directly. A creature that couldn't attack a creature before
(whether from summoning sickness or any other restriction) still can't attack a
creature while this keyword is active.

```
Diamond Cutter: onSummon: grant ignoreAttackRestrictions all ownCreature
```

Because the trigger is `onSummon` (not `static`), the duration rule above makes this
transient — it wears off at end of turn, matching "This turn, ignore..." on the card.

**New keyword: `unchoosable`.** A creature with this keyword can't be picked as the
target of a selector (`oppCreature`, `anyCreature`, etc.) inside an *opponent's* spell
or ability effect — e.g. it's immune to being targeted by Spiral Gate, Terror Pit,
Corile, or Aqua Surfer. It does **not** protect against normal combat: opponent's
creatures can still attack and block it as usual. Only effect-selection is blocked.

```
Petrova, Channeler of Suns: onSummon: nameRace; static: +4000 ownCreature[race=named]; static: grant unchoosable self
```

Here the `grant unchoosable self` is attached to `static:`, so per the duration rule
it's permanent for as long as Petrova is in the battle zone — matching the card's
always-on wording ("Whenever your opponent would choose...").

---

## 7. Extensions (added after round 3: 20 more cards)

This batch needed more new vocabulary than round 1 — four new triggers, a chooser
modifier, a group filter, and one keyword. All of it follows the same rule as before:
extend the grammar, don't bolt on one-off text.

**Four new triggers** (see section 1): `onUnblockedAttack:`, `onPlayerAttack:`,
`onBattleWin:`, `onAnyCreatureEnter:`. `onPlayerAttack` vs `onAttack`: `onAttack`
fires the moment the creature is tapped to attack, before you even know the target
type; `onPlayerAttack` only fires when that target is a player specifically (mirrors
the player-vs-creature attack distinction from Diamond Cutter). `onUnblockedAttack`
adds the further condition that the attack wasn't blocked.

**New chooser modifier: `, oppChoice`** (see section 2). Flips who picks the target of
a selector from the ability's controller to the target's own controller — generalizes
the same idea already used by `oppDiscard choose N`.

```
Trixo, Wicked Doll: onUnblockedAttack: destroy oppCreature, oppChoice
```

**New count + group filter: `any number of <sel>` / `totalPower<=N`** (see section 2).
`any number of` replaces the old "up to 99" hack for an uncapped selection. `totalPower
<=N` constrains the *combined* power of everything picked, not each card on its own —
this is a meaningfully different (weaker) effect than a per-card power filter, which is
why Apocalypse Vise's round-1 entry was wrong and got corrected.

```
Apocalypse Vise: onSummon: destroy any number of oppCreature[totalPower<=8000]
```

**Duration rule, generalized.** Previously this only covered `grant <keyword>`. It now
covers *any* effect attached to a non-`static` trigger — a `+N power`, a `grant`,
anything with an ongoing effect rather than an instantaneous one (destroy/draw/discard
don't have a duration to begin with, so this doesn't change them). Attached to a
`static:` trigger, it's permanent while the card's in the zone, as always. This is why
Quixotic Hero Swine Snout needs no bespoke duration syntax:

```
Quixotic Hero Swine Snout: onAnyCreatureEnter: +3000 self
```

`onAnyCreatureEnter` isn't `static`, so the +3000 is automatically transient — it wears
off at end of turn and re-applies (transiently again) the next time a creature enters,
matching "gets +3000 power until the end of the turn" on the real card. (Round 1's
sample table had this as a permanent stacking bonus, which was wrong.)

**New condition property: `self.brokeShieldThisTurn`** (see the conditions block in
section 3).

```
Hearty Cap'n Polligon: endTurn: -> hand if self.brokeShieldThisTurn
```

**New keyword: `mustAttack`.** Granted via `grant`, as with `unblockable` and
`unchoosable` — the creature must attack (a player or a creature) every turn if a legal
attack exists.

```
Deadly Fighter Braid Claw: static: grant mustAttack self
```

---

## 8. Extensions (added after round 4: 19 more cards)

Lighter round — most cards fit the grammar exactly (including several already in the
section 4 table that checked out against the real card text unchanged). Two additions:

**New trigger: `onAnyCreatureDestroyed:`.** Fires whenever any *other* creature — yours
or your opponent's — is destroyed. (Not this card's own destruction — that's still
`onDestroy`.)

```
Mongrel Man: onAnyCreatureDestroyed: draw up to 1
```

**`oppDiscard all` now takes an optional selector+filter.** Previously `oppDiscard
random N` / `choose N` / `all` always meant "from the whole hand". Rain of Arrows only
discards a filtered subset ("discards all darkness spells" from the opponent's hand),
so `oppDiscard all` can now take an explicit `oppHand[filter]` selector — same filter
syntax as everywhere else. `oppDiscard all` with no selector still means the whole
hand, unchanged.

```
Rain of Arrows: onSummon: oppDiscard all oppHand[spell,civ=Darkness]
```

**One correction.** Dark Reversal's round-1 sample entry (`onSummon: toHand ownGrave`)
was checked against the real card image for the first time this round — it returns a
*creature* from the graveyard, not any card:

```
Dark Reversal: onSummon: toHand ownGrave[creature]
```

---

## 9. Extensions (added after round 5: 24 more cards, incl. the "Miraculous" cycle)

The biggest round of new vocabulary so far — almost entirely from 5 unusually complex
multicolor spells (Miraculous Meltdown / Plague / Rebirth / Snare / Truce). Everything
else in the round used the existing grammar or small, predictable additions.

**New triggers:** `onBlock:` (this creature is used to block) and `onOppCast:` (your
*opponent* casts a spell — the first trigger keyed off the opponent's action rather
than your own card).

**New trailing modifier `, optional`** generalizes "may" to actions that aren't
naturally counted — `draw`/`destroy`/`bounce` already had `up to N` for this; `untap`
didn't. `endTurn: untap self, optional`.

**Dynamic `up to` counts.** `up to N` can now be `<sel>.count` instead of a literal
number — "up to as many as you have of X": `bounce up to ownCreature[civ=Light].count
oppMana`.

**`resolvesTo mana` formalized.** This is the *Charger* keyword — it's been in the
sample table since round 1 (Corpse Charger) but never actually written up. Fixed now.
The Miraculous cycle needed a tapped variant, `resolvesTo mana tapped`, since those
cards explicitly enter tapped (Corpse Charger / Eureka Charger enter untapped).

**`prevent` gets two new "what" clauses:** `oppBlock <sel>` (can't be blocked by
matching creatures) and `selfAttack` (this creature can't attack — usually paired with
an `if` condition for a restriction that changes as the board changes, unlike the
static Attack restriction column).

**Generalized `oppKeeps`.** The round-1 form was always "keep N out of everything
matching, rest → hand." Now it's `oppKeeps <K> of <N> <sel>, rest -> <fate>` — the
caster can first narrow to a specific-sized group (`of <N>`), and the leftover fate
can be `destroy` or `grave`, not just `hand`.

**New reference: `target`.** Inside one trigger's chain of actions, `target` refers to
whatever the *previous* action just resolved on — e.g. `search creature[cost=target.
cost] -> battle` after a `destroy`, to find a replacement of the same cost.

**`nameCiv`, `civAttackYou`, and `untilNextTurn`.** `nameCiv` mirrors `nameRace`
(Petrova) for choosing a civilization instead of a race. `civAttackYou[civ=X]` is a new
`prevent` clause meaning creatures of that civilization can't attack *you* — a
player-level protection that also covers creatures not yet on the board.
`untilNextTurn` is a new explicit duration that *overrides* the round-3 default
("granted/triggered effects expire at end of turn") for the rare case where something
needs to survive into the opponent's turn.

**New keyword: `sharedTap[<filter>]`.** Granted via `grant`, like `unblockable` /
`unchoosable` / `mustAttack` — lets other creatures matching the filter tap
*themselves* to activate this card's `tapAbility`, instead of tapping this card.

---

## 10. Extensions (added after round 6: 122 cards)

Much bigger batch, proportionally more new vocabulary — see section 4's table for the
specific cards. Summary:

- **`and`** joins two conditions in one `if` clause.
- **`orElse`** between two actions means the caster picks exactly one (an either/or).
- **`grant powerAttacker[+N] <sel>`** — the first *parameterized* keyword grant. Not
  interchangeable with flat `+N power <sel>`: power attacker only applies while
  attacking, a flat power bonus applies always.
- **`grant attackUntapped <sel>`** / **`grant attackableUntapped <sel>`** — lift the
  normal restriction that a creature can only attack a player or a *tapped* opposing
  creature. `attackUntapped` is granted to your own attacker; `attackableUntapped` is
  granted to a specific opposing creature instead (the mirror image).
- **`onBlocked:`** trigger, and **`grant <keyword> <sel> onBlocked`** — a delayed grant
  that applies the next time each matching creature gets blocked this turn.
- **Bare `-> mana`** generalizes the existing bare `-> hand` replacement action to
  another destination zone.

Also: a full-sheet duplicate scan turned up 29 groups of fully identical rows (not just
in this round's cards) — 30 redundant rows removed, keeping the first occurrence of
each.

---

## 11. Extensions (added after round 12: DM-08 set, 188 cards)

This batch filled in a manually-appended 181-row DM-08 set (Power/Race/Attack
restriction/Effect were already present for most rows; every keyword column was
blank). New vocabulary:

- **`grant silentSkill self`** — the round's dominant new keyword. Card text: "Silent
  skill (at the start of each of your turns, if this creature is tapped, you may keep
  it tapped and use its [tap] ability)." Always paired with a `tapAbility:` action on
  the same card — `silentSkill` changes *when* the tap-ability can be used (also at
  your turn start while already tapped, not just by choosing to tap it), it doesn't
  replace the `tapAbility:` trigger itself.
- **`grant entersManaTapped self`** — canonical name for "(This creature is put into
  your mana zone tapped.)" as a replacement-on-summon effect on a *battle-zone*
  creature (distinct from a spell's `resolvesTo mana tapped`). A few cards in this
  round were entered by a peer process as `grant manaTapped self` instead — **treat
  `manaTapped` as a deprecated alias for `entersManaTapped`**; the sheet still has a
  handful of rows using the old name (e.g. Aqua Skydiver, Galek the Shadow Warrior)
  left as-is since they were already non-blank and not overwritten, but any *new*
  card going forward should use `entersManaTapped`.
- **Double breaker / triple breaker power-threshold pattern**, used by the Vhal/dragon
  cycle (Magmadragon Ogrist Vhal, Terradragon Dakma Balgarow, Elixia, King Oquanos,
  etc.): `static: grant doubleBreaker self if self.power>=6000; static: grant
  tripleBreaker self if self.power>=15000`. **Standardize on excluding the triple
  range from the double grant** — `if self.power>=6000 and self.power<15000` — since
  the real card text is "while 6000 or more, double breaker" / "while 15000 or more,
  triple breaker *instead of* double breaker," i.e. the two are meant to be mutually
  exclusive, not both active at 15000+.
- **`onBreak:`** (already documented as "this creature breaks a shield") now has a
  worked example of chaining onto a revealed card's own properties, for Bluum Erkis,
  Flare Guardian's novel shield-break replacement: opponent reveals the shield instead
  of receiving it, then it's cast for free and grave'd if it has shield trigger, or
  goes to hand otherwise:
  `onBreak: reveal target; onBreak: cast target free, then toGrave oppGrave target if
  target.shieldTrigger; onBreak: toHand target if !target.shieldTrigger`
  This is a genuinely new pattern — conditionally branching on a *revealed* card's own
  printed properties to pick between two different zone-change outcomes — and hasn't
  been needed before. Flagging for review rather than treating as fully settled.
- **`onOwnCreatureDestroyed[<filter>]:`** — bracket-filtered variant of the existing
  `onOwnCreatureDestroyed:` trigger (parallel to `onAnyCreatureEnter[<filter>]:` from
  section 8), for "whenever one of your creatures of race X is destroyed" (Simian
  Warrior Grash).

A second independent extraction pass over this same batch (this round's chunk agents
re-deriving Effect text for cards whose Effect cell the earlier pass had already
filled) surfaced ~150 cases of two differently-phrased but functionally identical
Effect strings for the same card — e.g. `.count` appended to a "per <sel>" selector
or not, `choose 1` vs bare `up to 1`, `all` made explicit vs implied. None of these are
real disagreements about what the card does; per the blanks-only policy the
already-filled (first-pass) wording was always kept and the second pass's phrasing was
discarded. No syntax changes needed for these — noted here only so a future round
doesn't mistake the two conventions for a real inconsistency.

---

## 12. Extensions (added after round 13: 126 cards, sets DM-13/DM-32)

This batch introduced **Cross Gear** — a card type this project hasn't seen before.
Cross Gear cards aren't creatures or spells you play for their own body; you "cross"
one onto a creature you control, and it modifies that creature. New vocabulary:

- **`crossedCreature`** — new selector, meaning "the creature this Cross Gear is
  crossed onto." Used wherever a normal card would say `self`: `static: +1000
  crossedCreature`, `static: grant unblockable crossedCreature`, `static: grant
  powerAttacker[+5000] crossedCreature`. A Cross Gear's whole card text is usually just
  one or two `static:` grants/bonuses onto `crossedCreature` — there's no creature
  Power/Race/keyword-column data to fill for these cards, only Effect.
- **`crossedCreature.onDestroy: -> hand`** (Spiral Aura) — a trigger *scoped to* the
  crossed creature rather than to the Cross Gear itself (the Cross Gear returns to
  hand when the creature it's on is destroyed). Dot-scoping a trigger onto a selector
  is new; flagging as a pattern to watch rather than fully settled, since we only have
  one example so far.
- **`grant race[<name>] crossedCreature`** (Final Dragarmor) — a parameterized grant
  that changes what race the crossed creature counts as, additively (reminder text:
  "also a[n] X" style). New parameterized keyword, same shape as `powerAttacker[+N]`.
- **`grant additionalBreaker[+N] <sel>`** — stacks with existing breaker count rather
  than setting it outright (distinct from `grant doubleBreaker`/`tripleBreaker`, which
  set a specific fixed breaker count).
- **`static: x2 power crossedCreature`** (Powered Stallion) — first doubling effect
  seen; write power-doubling as `x2 power <sel>` rather than trying to express it as a
  `+N` (the bonus scales with the base, a flat `+N` can't represent that).
- **`static: grant freeCrossGear self`** (Bolberg Cross Dragon) — lets you attach Cross
  Gear onto this creature for no cost. New keyword, only one example so far.

Also new this round, unrelated to Cross Gear:

- **`grant saver[race=<X>] self`** — the "Saver" keyword (reminder text: "if a creature
  with this ability is in the battle zone, whenever one of your race-X creatures would
  be attacked or destroyed, this creature can be attacked/destroyed instead" — i.e. it
  redirects). Four cards this round (Balor, Bix, Branca, Malulu) each guard a different
  race. Written as a parameterized grant on `self`, matching the `sharedTap[<filter>]`
  / `saver[race=X]` shape already used for other filter-parameterized keywords.
- **`self.metamorphosed`** (Brutal Revenger) — new state check, true after this
  creature has undergone the "Metamorphosis" mechanic (a DM keyword this project
  hasn't encountered before this round — only one card, so treated as a boolean state
  flag rather than modeling the full mechanic).
- **`costPlus N <sel>`** / **`costMinus N <sel>`** — static cost modifiers on cards
  matching a filter (Broken Horn's tax on opponent's spells; Faerie Gift's discount on
  your own next creature). Mirror image of each other, same parameter shape.
- **`grant evolutionAnyRace self`** (Innocent, the Invoked) — lets this creature be
  used as an evolution base for any race's evolution creature, not just its own race.
- **`grant winsAllBattles self`** (Marshias, Sun Elemental) — this creature always wins
  battles it's in regardless of power. New absolute-outcome keyword, distinct from a
  power bonus.
- **`ownCreature.distinctRaces[<filter>]`** (Shaman Totem: "draw 1 per ownCreature
  .distinctRaces[!race=Mystery Totem]") — counts *distinct races represented*, not
  card count. New counting mode alongside the existing `.count`.
- **`oppCreature[totalPower<=N]`** (Hell's Scrapper: "destroy any number of
  oppCreature[totalPower<=N]") — the chosen group's *combined* power must be under the
  cap, not each individual creature's power. Distinct from the ordinary `power<=N`
  per-card filter.
- **`target.wasBounced`** (Wave Crawler) — new post-action state check on a prior
  action's target, for "if the bounce actually happened" (the opponent's creature
  bounce is optional/conditional, so this checks whether it resolved).
- **`nameInGrave`** filter modifier (Wrangle, the Hidden Heretic: "prevent oppCast
  spell[civ=Light/Nature,nameInGrave]") — restricts to cards sharing a name with
  something already in a graveyard. New filter predicate.

No last-card-drop-bug incidents this round — all 13 chunk agents returned every card
in their list, including the last one, so no manual re-reads were needed.

---

## 13. Extensions (added after round 14: 60 cards)

More Cross Gear vocabulary this round, filling out the mechanic introduced in section
12:

- **`self.crossed`** — new state check on a *creature*: true if it currently has a
  Cross Gear attached. (Distinct from `crossedCreature`, which is the selector a Cross
  Gear card uses to refer to *its own* host creature — `self.crossed` is the reverse
  direction, a creature checking its own status.) Two of this round's chunk agents
  independently invented `self.crossedWithGear` for the same check — normalized to
  `self.crossed` everywhere in the sheet; use `self.crossed` going forward.
- **`crossedGear`** — new selector, the mirror image of `crossedCreature`: from a
  *creature's* card text, refers to the Cross Gear(s) attached to it. One card's first
  draft used `crossGearOnSelf` for the same thing — normalized to `crossedGear`.
- **`cross <sel> -> <destCreature>, free`** — new action, attaching a Cross Gear onto a
  creature (Full Throttle Sergeant's tap ability re-crosses one of your own Cross Gear
  cards; Quick Defense crosses *itself* onto a new creature when its old host is
  destroyed, via `cross self -> ownCreature, free`).
- **`recross <sel> -> <destCreature>, free`** — like `cross`, but for *moving* a Cross
  Gear that's already attached somewhere else onto a new creature (Ice Medusa: "when
  destroyed, you may move all Cross Gear on it onto another of your creatures").
- **`self.firstAttackThisTurn`** — new state check, true only during a creature's first
  attack in the current turn (distinguishes a card's first attack from a second attack
  granted by some other effect, e.g. an extra-attack grant).
- **`onGenerateCrossGear:`** — new trigger, for "whenever you generate a cross gear"
  (the act of putting a new Cross Gear into play, whether normally cast or produced via
  Shield Trigger Cross below). Only one example so far (Sirius, the Patroller).
- **`grant shieldTriggerCross self`** — a real, distinct printed keyword ("Shield
  Trigger Cross"), not a mistaken rewrite of the ordinary Shield Trigger column: a
  Cross Gear with this keyword, when it's your broken shield, lets you both generate
  it *and* cross it onto a creature for free in one step, instead of just putting it
  into your hand or casting it normally. Verified against the card image — this is
  correctly kept out of the SHIELD_TRIGGER column (that column is for the ordinary
  keyword only) and expressed only in Effect.

Also normalized: **`self.nameInGrave`** is now the one form for "a card with this same
name is already in your graveyard" (extends the `nameInGrave` filter predicate from
section 12 to a bare self-check). Two cards' first draft instead wrote
`ownGrave[name=self].count>=1` for the identical check — normalized to `self.nameInGrave`.

No last-card-drop-bug incidents this round either.
