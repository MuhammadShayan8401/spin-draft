# Deploy Spin Draft XI (Vercel only)

```
Vercel project:  public/ (game)  +  api/ (functions)  +  Upstash Redis (online rooms only)
```
The single-device game needs nothing but Vercel. **Online rooms** need a small Redis database, because
serverless functions forget everything between requests (step 2). There is no player data to build or host:
players type the names they pick.

## 1. Deploy to Vercel
1. Push this repo to GitHub.
2. Vercel -> Add New Project -> import it. Leave **Root Directory** as the repo root, Framework Preset **Other**,
   no build command. (`vercel.json` already points the output at `public/`.)
3. Deploy and open the site: the game works straight away.

## Changing the default teams
Edit the two lists in `lib/teams.js` **and** `CLUB_NAMES` / `NAT_NAMES` at the top of the script in `public/index.html`
(the page uses its own copy so it works offline). Players can also add any team in the page's Wheel presets screen.

## 2. Online rooms: add Redis (free)
1. In the Vercel project: **Storage** (or Marketplace) -> **Upstash for Redis** -> create a free database
   and connect it to this project (all environments).
2. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`) automatically.
   Either pair works.
3. **Redeploy** so the functions see the new variables.
4. Open the site -> "Play online with friends" -> create a room, join from a second device.

Without Redis the rest of the game works and creating a room shows "Online rooms are not set up yet".

Redis usage: a room is one small key that expires by itself (lobby 30 min, playing 3 h, finished 1 h).
A polling player costs about 1 Redis command per second plus a few per 8 s, so an hour with 4 players is
roughly 25 000 commands. Check the free plan's monthly command limit on Upstash if you play a lot.

## Install as an app and use it offline
The game is a PWA (`public/manifest.webmanifest` + `public/sw.js`). After one visit with internet:
- **Android / Chrome / Edge:** an "Install app" button appears at the top of the page, or use the browser menu -> Install app.
- **iPhone / iPad (Safari):** Share -> **Add to Home Screen**.
- It then opens with no connection and the single-device game works. The page is cached. Online rooms are disabled offline (the buttons grey out and the page says so).
- After you deploy a new version, open the app once online; the update shows on the next launch.
- If you change `sw.js` caching or the precache list, bump `VERSION` in `public/sw.js` so old caches are removed.

## Local run
```
npm test                                  # no install needed
npx vercel dev                            # runs the game + functions at http://localhost:3000
```
Locally (no `VERCEL` variable) rooms use an in-memory store, so no Redis is needed to try them.

## Notes
- **Rooms close when every player has left.** Leaving (button), closing the tab/app, or navigating away calls `/leave`.
  In the lobby the player is removed (host passes on); mid-draft they keep their seat but are out, and the host can skip their turns. A player silent for 60 s (`CLOSE_AFTER` in `lib/rooms.js`) counts as left. When the last player is gone the room is deleted.
  Reopening the game always starts at the dashboard; the invite link only fills the code box.
- Players poll the room once a second (every 3 s in a background tab). A player silent for ~20 s shows as away,
  and the host gets a "Skip turn" button for them.
- Vercel's free (Hobby) plan allows enough function calls for a few friends; many simultaneous rooms
  would need a paid plan.

## Accounts and friends
Accounts, friend requests and room invites use the same Redis database as the rooms (`/api/account/...`, see `lib/accounts.js`).
Nothing extra to set up on Vercel: once Redis is connected (step 2) the "Account and friends" box on the home screen works.
Passwords are stored as scrypt hashes; sessions last 30 days.
