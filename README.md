# Calf Doctor

Doctoring log for Christian Peterson's crew. Cowboys sign in with Gmail, log pulls at the chute by voice or by tapping, and the app checks the treatment protocol and builds per-cowboy reports.

- Works on iPhone and Android in the browser, and installs to the home screen.
- Works offline: entries save on the phone and sync when signal comes back.
- Data lives in Google Firebase (Firestore). Sign-in is Google (Gmail) only.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | App source (plain JavaScript, no framework) |
| `src/config.js` | Firebase config and owner email |
| `src/constants.js` | Diagnoses, treatments, causes, voice nicknames |
| `src/protocol.js` | Protocol suggestions (DRAFT until Christian's written protocol) |
| `src/reports.js` | Report math and CSV export |
| `firestore.rules` | Security rules: paste into Firebase console → Firestore → Rules |
| `docs/` | Built app, served by GitHub Pages |
| `dist/demo.html` | Single-file demo that keeps data on the device |

## Build

```
npm install
npm run build
```

## One-time setup

1. Firebase project with Google sign-in enabled and `<username>.github.io` added under Authentication → Settings → Authorized domains.
2. Firestore database in production mode; paste `firestore.rules` into the Rules tab and Publish.
3. Put the web app's `firebaseConfig` in `src/config.js`, build, push.
4. GitHub repo → Settings → Pages → Deploy from branch `main`, folder `/docs`.
5. Open the app, sign in as the owner, and add the crew under More → Crew.

## Data model

- `crew/{gmail}`: `{ name, role: 'admin' | 'cowboy', active }`
- `settings/main`: `{ season, locations[], tagColors[{color, year}], extraAliases{nickname: treatment} }`
- `entries/{id}`: one pull or death: tag (year + color + number), diagnosis, temperature, treatment or cause, pulled by, entered by, location, GPS, time, protocol warnings shown.

## Costs

The free Firebase plan is enough for testing. Once the whole crew uses it all season, switch the project to the pay-as-you-go plan and set a budget alert. At this size it should cost no more than a few dollars a month, because every phone downloads the season's entries.
