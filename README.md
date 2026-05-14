# SpaceDonate

SpaceDonate is a local prototype for a streaming donation platform with Pix-style donation flow, OBS alerts, and OAuth connection points for YouTube and Twitch.

## Features

- Landing page with login/signup UI
- YouTube and Twitch OAuth routes
- Donation page with Pix placeholder QR code
- OBS overlay page with animated alerts
- Server-Sent Events for real-time overlay notifications
- Local Node.js server
- PowerShell fallback server for simple local testing

## Stack

- HTML5
- CSS3
- JavaScript
- Node.js
- Server-Sent Events
- OAuth 2.0
- PowerShell

## Running Locally

```bash
node server.js
```

Then open:

```txt
http://localhost:3000/
```

## Environment

Copy `.env.example` to `.env` and fill in the credentials:

```env
PUBLIC_BASE_URL=http://localhost:3000

YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:3000/auth/youtube/callback

TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://localhost:3000/auth/twitch/callback
```

## Important

The Pix flow is currently a placeholder and does not create real payments.
