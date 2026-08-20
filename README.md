# Duel Masters Table

A private, browser-based virtual tabletop for playing Duel Masters with your
own scanned/prepared cards. It knows nothing about card effects — it just
handles zones, hands, mana, tapping, and free-form play so you and your
opponent(s) can play manually, exactly like at a real table, communicating
over voice/Discord/phone as you go. There is no turn or phase lock — both
players can act on their own cards at any time.

Works in any modern browser on Windows, Mac, or phone (landscape recommended
on phones). No installer needed.

---

## How to play

1. Everyone opens the game URL, loads their `cards` folder, builds/saves a
   40-card deck.
2. Host clicks **Create Private Game** and shares the room code — or click
   **Practice Mode (Solo)** to test everything yourself, no opponent needed
   (a "Player 1 / Player 2" switcher lets you flip sides).
3. Whoever else joins types the code and clicks **Join Game** — the host
   gets an **Accept/Decline** prompt before they're let in.
4. Pick a saved deck and click **Ready**. Your hand is dealt immediately —
   you don't wait on the other player. 6 shields + 5-card hand are dealt
   from your own shuffled 40, leaving 29 in your deck. Once both players
   have readied up, a die roll (just for fun) shows who "goes first," but
   nothing is actually locked to turns.

### The table
- **Deck** (bottom right, face down) — right-click: **Draw a Card**,
  **Shuffle Deck**.
- **Graveyard** (next to your deck, face up) — click it to inspect the full
  pile, yours or your opponent's, any time.
- **Shield Zone** — 6 face-down cards, centered. Right-click your own:
  **Return to Hand**, **Put in Graveyard**, **Flip Card** (reveals it in
  place, to both of you — right-click again to **Unflip**).
- **Battlezone** — cards you own can be **freely dragged** anywhere in the
  zone (so you can stack an evolution creature on top of what it's
  evolving from). Right-click: **Tap/Untap** (either player, any creature —
  for blocking, etc.), plus **Destroy** / **Return to Hand** for your own.
- **Mana Zone** — right-click your own mana: **Tap/Untap**, **Return to
  Hand**, **Destroy**, **Put Back in Deck & Shuffle**.
- **Hand** (yours only, fanned) — right-click: **Charge Mana**, **Summon**,
  **Discard**, **Show Hand to Opponent** (a "Stop Showing" button appears
  while active), **Return Card to Deck & Shuffle**.

### Extra tools
- **Hover** any card to see it enlarged; **double-click** to fill the
  screen with it; click outside or press Esc to close.
- **Drag a selection box** over multiple cards in a mana/shield/battle zone,
  then right-click any of them to apply an action (tap, destroy, etc.) to
  the whole selection at once.
- **Ctrl/Cmd+click** any card — yours, your opponent's, even a face-down one
  you can't see — to make it blink red for both players, to point out which
  card you mean (e.g. "break this shield," or picking blind from an
  opponent's hand for a spell effect).
- **Surrender** or **End Game** (asks your opponent to agree) are in the
  sidebar. When the game ends, both players get a Rematch/Quit prompt.

---

## Known limitations

- No automatic evolution/effect logic — that's on purpose, it's all manual.
- Free-drag card positions are stored per-player and sync live, but very
  fast simultaneous drags by both players on the same card could conflict
  (last write wins) — rare in practice.
- Safari can't remember your folder permission between sessions — Chrome or
  Edge is recommended, including on Mac.

