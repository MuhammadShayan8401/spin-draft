# Spin Draft XI

Spin a club or country, then everyone drafts a player from it, one after another, for their starting eleven.
**There is no player data: players type the names they pick**, so any player, any era, is allowed.

Everything deploys as one Vercel project.

- `public/`: the game (static page), plus the offline app files (`manifest.webmanifest`, `sw.js`, `icons/`)
- `api/`: Vercel serverless functions (Node): `/api/rooms/...` (online rooms)
- `lib/`: the room rules (`rooms.js`), routes (`api.js`), storage (`store.js`), the default teams (`teams.js`)
- `tests/`: `npm test` (Node 20+, no dependencies to install)

No scraping, no AI agents, no Firebase. See **DEPLOY.md**.

**Accounts and friends.** Players can make an account (username + password), add friends by username, accept or decline friend requests, and
invite a friend to the room they are in. The friend sees the invite on their home screen and joins with one tap. Routes: `/api/account/...`
(`lib/accounts.js`). Accounts live in the same Redis database as the rooms. Playing without an account still works exactly as before.

**Teams.** `lib/teams.js` (and the matching list at the top of the page script) holds the 14 clubs and 12 countries that are on the
wheel by default. They are names only.

**Wheel presets.** The "Wheel presets" page (open it from the setup screen or the room lobby) lets you choose which clubs and countries
can come up on the wheel, add any club or country by typing its name, and save your own named presets. Presets are stored in the browser
(localStorage). In an online room the host's chosen preset is sent to the server (`options.wheel`), so everyone plays the same wheel.

**Every team once.** A club or country that has been spun is taken off the wheel for the rest of the draft (always on). If every team has
come up, they all go back on. Every re-spin counts as a spin.

**Re-spins.** The host (or the setup screen) chooses how many re-spins each player gets, 0 to 5 (default 1), and whether a re-spin
can be used on any of your picks or only on the first pick of a round. Online, the host sets both in the lobby (`options.respins`, `options.rrAny`).

**Options.** Position wheel, snake order, first-pick toss, and
"no repeat in a row" (the team that was just spun, or just re-spun away, is left off the next wheel even right after a refill, which only happens with a small preset; it needs at least 3 teams on the wheel).

**Fix a typo.** Every pick on your pitch has a small pencil button. It lets you correct the name (same position, same turn order,
duplicates still refused). Online you can only edit your own picks; on one device anyone can edit any pick.

**Vote and scoreboard (online rooms).** When the draft ends, a popup asks everyone to vote for the best XI (yourself included; you can change
your vote until everyone has voted, and the host can close voting early). Most votes wins; a tie shares the win. Each win is one point on the
room's scoreboard, which is kept when you press **New game** (a "Scoreboard" line shows on the game screen). A player who leaves takes their
points with them. The vote popup can be reopened with the "Vote and scoreboard" button. The server routes are `rename`, `vote` and `endvote`.

**New game.** When an online draft ends, any player can press **New game** to start again with the same players and settings.

**Away players.** If a player drops off mid-draft, the host gets a "Skip <name>'s turn" button. It fills one of that player's open
positions with a blank so the draft can go on (nobody picks a player for them).
