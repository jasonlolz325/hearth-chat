# Hearth

Discord-style chat with a real server. Email-only accounts — no Google or X.

## Features

- Register / sign in with **email + password**
- Servers, channels, invite codes
- Live messages (Server-Sent Events)
- Member list with online status
- Direct messages
- Edit / delete messages and emoji reactions

## Run

Requires **Node.js 18+**. No `npm install` — uses only built-in modules.

```bash
node server.js
```

Open **http://localhost:3000**

Data is stored in `data.json` (created on first run; not committed).

## Project layout

| Path | Description |
|------|-------------|
| `server.js` | HTTP API, static files, live events |
| `public/index.html` | Chat UI |
| `public/styles.css` | Styles |
| `public/app.js` | Client logic |
