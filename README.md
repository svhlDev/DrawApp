# Pixel Forge — Setup & Deploy Guide

## Quick Start (Local Testing)

```bash
cd pixel-forge
npm install
node server.js
```

Open the host URL printed in the terminal (includes your secret).

---

## Deploy to Railway

### 1. Push to GitHub

```bash
cd pixel-forge
git init
git add .
git commit -m "initial commit"
gh repo create pixel-forge --private --push
```

Or create a repo manually on github.com and push.

### 2. Deploy

1. Go to **railway.app** → sign in with GitHub
2. **New Project** → **Deploy from GitHub Repo** → select `pixel-forge`
3. Railway detects Node.js, runs `npm install` + `npm start` automatically
4. Go to **Settings** → **Networking** → **Generate Domain** (gives you `something.up.railway.app`)

### 3. Set Environment Variables

In Railway dashboard → **Variables** tab, add:

| Variable | Value | Purpose |
|----------|-------|---------|
| `HOST_SECRET` | any random string (e.g. `myS3cret99`) | Protects /host admin page |

`PORT` and `RAILWAY_PUBLIC_DOMAIN` are set automatically by Railway.

### 4. Open Your Admin Window

On your laptop, open:

```
https://your-app.up.railway.app/host?secret=myS3cret99
```

Bookmark this. This is what you project on the big screen. Without the
correct `?secret=` parameter, the page returns 403 Forbidden.

### 5. Players Join

They scan the QR code shown on your host screen, or go to:

```
https://your-app.up.railway.app/play?room=XXXXXX
```

Works on any network — school WiFi, mobile data, anything.

---

## File Structure

```
pixel-forge/
├── server.js           # Express + Socket.IO server
├── package.json
└── public/
    ├── host.html       # Admin view (projected screen)
    ├── host.js         # Room creation, canvas, player management
    ├── play.html       # Player view (phones)
    ├── play.js         # Drawing, brush tools, plot system
    └── style.css       # Shared dark theme
```

---

## Host Admin Controls

The host sidebar gives you:

- **QR code** — auto-generated, encodes the player join URL
- **Player list** — see who's connected and which plot they have
- **Kick button** — remove disruptive players (✕ next to their name)
- **Clear Canvas** — wipe everything (with confirmation)
- **Export PNG** — download the canvas as an image file

---

## Security Model

| Layer | What it does |
|-------|-------------|
| `HOST_SECRET` in URL | Only you can access /host and admin socket events |
| `helmet` | Secure HTTP headers (CSP, XSS protection, no MIME sniffing) |
| CSP policy | Blocks inline scripts, restricts resource origins |
| `express-rate-limit` | 300 HTTP requests per 15 min per IP |
| Socket rate limit | 60 draw events/sec per connection |
| Server-side bounds check | Every stroke point validated against player's plot |
| Input sanitization | Names stripped of HTML chars, colors validated as hex, brush sizes clamped |
| Payload cap | 100KB max WebSocket message |
| Room code entropy | `crypto.randomBytes` — not guessable |
| Auto cleanup | Rooms deleted after 2 hours of inactivity |

---

## How It Works

1. Host opens `/host?secret=...` → clicks Create Room → gets room code + QR
2. Server creates room state in memory: empty canvas, 10 available plots
3. Player scans QR → `/play?room=XXXXXX` → enters name → joins
4. Server assigns random plot from available pool, removes it from pool
5. Player draws within their plot → server validates bounds → broadcasts to room
6. Host canvas renders all strokes in real-time via Socket.IO
7. Player disconnects → their plot returns to the pool for the next joiner
8. "Change Plot" → old plot returns to pool, new random one assigned
