# Calf Doctor

Doctoring log for Christian Peterson's crew. Cowboys sign in with Google or with any email address and a password, log pulls at the chute by voice or by tapping, and the app checks the treatment protocol and builds per-cowboy reports.

- Works on iPhone and Android in the browser, and installs to the home screen.
- Works offline: entries save on the phone and sync when signal comes back. Photos and videos wait on the phone and upload when there's signal.
- Voice: on an iPhone home-screen icon, Apple doesn't allow the browser's voice recognition, so the app shows the keyboard-mic route instead (tap the box, tap the keyboard's 🎤). In Safari and on Android the big mic button works.
- Data lives in Google Firebase (Firestore). Sign-in is Google, or email + password for any other address (the address must be confirmed by email before the account sees any data).

## Layout

| Path | What it is |
| --- | --- |
| `src/` | App source (plain JavaScript, no framework) |
| `src/config.js` | Firebase config and owner email |
| `src/constants.js` | Diagnoses, treatments, causes, voice nicknames |
| `src/protocol.js` | Protocol suggestions (DRAFT until Christian's written protocol) |
| `src/reports.js` | Report math and CSV export |
| `firestore.rules` | Security rules: paste into Firebase console → Firestore → Rules |
| `storage.rules` | Photo/video rules: paste into Firebase console → Storage → Rules |
| `src/media.js` | Photo/video queue: waits on the phone with no signal, uploads later |
| `docs/` | Built app, served by GitHub Pages |
| `dist/demo.html` | Single-file demo that keeps data on the device |

## Build

```
npm install
npm run build
```

## One-time setup

1. Firebase project with the Google and Email/Password sign-in providers enabled and `<username>.github.io` added under Authentication → Settings → Authorized domains.
2. Firestore database in production mode; paste `firestore.rules` into the Rules tab and Publish.
3. Put the web app's `firebaseConfig` in `src/config.js`, build, push.
4. GitHub repo → Settings → Pages → Deploy from branch `main`, folder `/docs`.
5. Open the app, sign in as the owner, and add the crew under More → Crew.
6. For death-report photos and videos: switch the project to the pay-as-you-go Blaze plan (Firebase requires it for Storage) and set a budget alert, then Storage → Get started, pick a US region (us-west1 or us-central1 keep the free allowance), paste `storage.rules` into the Rules tab and Publish. Until this is done, photos stay queued on the phone and the rest of the entry saves normally.
7. Under More → Settings, an admin fills in pastures, herds and the dose for each drug.

## Data model

- `crew/{email}`: `{ name, role: 'admin' | 'cowboy', active }`
- `settings/main`: `{ season, locations[] (pastures), herds[], dosages{treatment: text}, tagColors[{color, year}], extraAliases{nickname: treatment} }`
- `entries/{id}`: one pull or death: tag (year + color + number, or `noTag`), diagnosis, temperature, treatment and the dose shown at the time, or cause + herd for deaths, pulled by, entered by, pasture pulled from (`location`), GPS, time, notes/description, `media[{path, type, size}]`, protocol warnings shown.
- Storage `entries/{id}/…`: photos (shrunk to 1600 px on the phone) and videos for death reports.

## Costs

The free Firebase plan is enough for testing. Once the whole crew uses it all season, switch the project to the pay-as-you-go plan and set a budget alert. At this size it should cost no more than a few dollars a month, because every phone downloads the season's entries.
