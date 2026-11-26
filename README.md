# Letterboxd Movie Club Awards: Trivia Night

A team trivia game for the end-of-year gala, built from the club's own Letterboxd data: who rated what, who wrote which review, whose Top 4 is whose. Everyone plays on their phone with a room code, and the faster a team locks in a right answer, the more it's worth.

The site republishes itself on GitHub Pages whenever you change a file on the `main` branch, usually within a minute.

## How a game works

1. Open the site on your laptop. Press **Turn on play-along** to get a 5-letter room code and a QR code, and set the team names (one per line, up to 8).
2. Press **📺 Open board** and drag that window onto the TV. It only ever shows what the room should see. Press **F** on it for full screen, and click it once so sound comes out of the TV.
3. Everyone scans the QR code (or goes to the site address with `/play` on the end), types the room code and their name, and picks a team. The lobby on the TV fills up as they join.
4. Pick the game. **Space** moves everything along: round card → question (clock running) → reveal → next question → round standings → next round → final results.

### Scoring

- A right answer is worth **1,000 points** if it's locked in right away, dropping to **100** as the clock runs out (30 seconds by default). Wrong answers and no answer are worth 0.
- Ordering questions give partial credit: each item in the right slot earns a quarter (or a third, or a fifth) of the points.
- A **team's** score on a question is the **average** of its players' points, so a team of three can beat a team of six.
- A round marked **double** counts twice. Everyone also has an individual score for the MVP race.
- Answers close when the clock runs out, when you press **X**, or when you reveal.

### Host shortcuts

- **Space / Enter:** next step
- **Backspace:** back a step
- **X:** close answers early
- **0:** leaderboard (on the board too)
- **M:** mute · **B:** open the board · **⚙︎:** back to setup (the game is saved, and **Resume** picks it up)

The game saves itself in the browser, so a refresh or a closed tab won't lose a game in progress. Phones reconnect by themselves. **New room code** opens a fresh room (everyone joins again) and **Reset scores** starts the scoreboard over.

Messages go through free public relays that anyone could listen in on, so the answer is never sent to the phones before it's revealed. Fine for a party, not for anything private.

## The questions

`games/awards.json` holds the 8 rounds. Edit it on github.com with the pencil icon and commit; the site updates on its own. There are three kinds of question. Multiple choice:

```json
{
  "prompt": "Which pick earned the HIGHEST average club rating?",
  "choices": ["The Truman Show", "Project Hail Mary", "Eternal Sunshine of the Spotless Mind", "The Matrix"],
  "answer": "Project Hail Mary",
  "note": "4.54★ from 14 members."
}
```

Type-in, checked automatically (capitals and punctuation don't matter, longer answers forgive a typo, a surname alone counts for a person, and `accept` lists other right answers). After the reveal the host sees every answer given and can tap one to flip it between right and wrong:

```json
{ "type": "text", "prompt": "Who directed Get Out?", "answer": "Jordan Peele" }
```

Ordering, where players tap the items in order. Each item in the right slot earns a share of the points:

```json
{
  "type": "order",
  "prompt": "Put these Best Picture winners in order of when they won.",
  "items": ["Titanic", "Gladiator", "The Departed", "Parasite"],
  "ends": ["Earliest", "Most recent"],
  "meta": { "Titanic": "1997", "Gladiator": "2000", "The Departed": "2006", "Parasite": "2019" }
}
```

| Field | What it does |
| --- | --- |
| `prompt` | The question |
| `choices`, `answer` | Multiple choice: 2 to 4 options and the right one (spelled exactly as in `choices`) |
| `answer`, `accept`, `needs`, `exact` | Type-in: the answer, other accepted answers, words that must all appear, and `exact: true` to turn off the surname shortcut |
| `items`, `ends`, `meta` | Ordering: the items in the right order, labels for the two ends, and a small note shown next to each item after the reveal |
| `note` | Small print shown with the answer |
| `hint` | A line under the question |
| `quote` | A review shown in a quote box |
| `top4` | Four film titles shown as posters |

A round has a `title`, a `blurb`, its `questions`, and optionally `time` (seconds per question) and `double: true`.

To add another game, copy `awards.json`, add it to `games/index.json`, and it shows up on the start screen.

## Sound cues

Drop MP3s into `sounds/` named `theme.mp3`, `round.mp3`, `think.mp3`, `timesup.mp3`, `reveal.mp3`, `standings.mp3` or `winner.mp3`. Until then the short cues play simple built-in tones.

## Running it on your own computer

There's no build step. From the repo folder:

```
python3 -m http.server
```

Then open http://localhost:8000.

## Where the data came from

Ratings, reviews and Top 4s were read from the members' public Letterboxd profiles on November 25, 2026, for the 40 films on the club's 2026 list. Members are the accounts tracie220 follows (minus four non-members), plus tracie220. Averages use every member's rating of a film, whenever it was logged. Member awards only consider people with at least 10 club ratings.
