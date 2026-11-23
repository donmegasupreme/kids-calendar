# Kids Calendar

A shared calendar for parents. It shows:

- **who has the kids each day**, colour-coded, from a repeating schedule (week about, 2-2-3, every
  second weekend, or your own pattern) plus one-off swaps for holidays or work trips;
- **the kids' events**: sport, school plays, appointments, with which child, who's taking them,
  where, and notes;
- **a list of every change**, and an **email to the other parent** when someone adds or changes
  something. Several quick edits go out as one email.

Open the link in Safari and use **Share → Add to Home Screen** to install it like an app on an
iPhone. It also works on Android and computers. No passwords: each person has a short code.

**To set it up, follow [SETUP.md](SETUP.md).**

## How it works

- **`docs/`**: the app (plain HTML, CSS and JavaScript, no build step), served by GitHub Pages.
  `docs/config.js` holds the address of the Google script.
- **`apps-script/Code.gs`**: the back end, pasted into a Google Sheet's Apps Script. It keeps the
  calendar in the Sheet's tabs and sends change emails from the owner's Gmail every 5 minutes.
  It's built from:
  - `core/calendar.js`: the calendar rules (plain JavaScript, no Google calls);
  - `apps-script/gas.js`: the Google part (Sheet storage, email, web requests).
- Dates are stored as `YYYY-MM-DD` text, so days never shift with time zones.

## Working on it

Needs Node.js 20 or newer. Nothing to install.

```sh
npm test       # rebuilds Code.gs, then runs it against pretend Google services
npm run dev    # local preview at http://localhost:8080 (prints a setup key; no real emails)
```

After changing `core/` or `apps-script/gas.js`, run `npm run build` and commit the new
`apps-script/Code.gs`.
