# Duel Masters Table

A browser-based Duel Masters virtual tabletop. Node + WebSocket server, vanilla JS
client, card behaviour driven by a spreadsheet rather than by code.

## Running it

```
npm install
npm start            # then open http://localhost:10000
```

## Layout

```
server.js            game engine — rules, combat, effect interpreter
effects-parser.js    turns the sheet's Effect column into structured abilities
public/              the client: client.js, bot.js, index.html, style.css, sounds/
carddata/            the card spreadsheet (drop a new .xlsx in to replace it)
effectsyntax.md      reference for the Effect column syntax
check.js             runs every project check
tools/checks.js      the checks themselves, one per name
```

## Adding cards

Card behaviour lives in the **Effect** column of the spreadsheet, not in the code.
Write a clause like `onSummon: destroy oppCreature[power<=3000]` and the engine picks
it up on the next reload — no code change needed. `effectsyntax.md` documents the
vocabulary.

After changing the sheet:

```
npm run check
```

That reports any clause the engine can't execute yet, plus data faults like duplicate
rows or a card whose printings contradict each other.

## Checks

`npm run check` runs all of them; `node check.js <name>` runs one.

| Name | What it catches |
|---|---|
| `guards` | a hardcoded effect that no longer stands down for a sheet-described card |
| `client` | client.js throwing at load — which silently kills every later handler |
| `server` | a handler that throws mid-game; drives a real game end to end |
| `bot` | the bot choosing badly, e.g. bouncing its own creature |
| `effects` | the trickiest cards no longer parsing to executable shapes |
| `audit` | a sheet clause the engine never executes |
| `sheet` | duplicate rows, contradictory printings, malformed cells |
