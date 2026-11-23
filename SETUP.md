# Setting up Kids Calendar

About 15 minutes, on a computer. You need your Google (Gmail) account and this GitHub repo.
When you're done you'll have a link like `https://YOUR-GITHUB-NAME.github.io/kids-calendar/` that
anyone with a code can open on their phone and add to their Home Screen.

**Where things live**
- The app's pages are in this GitHub repo. That's code only: no names, dates or kids' details.
- The calendar itself (people, events, who has the kids) is stored in a Google Sheet in **your**
  Google Drive. Change emails go out from **your** Gmail. Don't share the Sheet with anyone.

---

## Part 1: Google (the calendar's storage and emails)

1. Go to **sheets.google.com** and start a **Blank spreadsheet**. Name it `Kids Calendar`.
2. In the Sheet's menu choose **Extensions → Apps Script**. A code editor opens in a new tab.
3. In the editor, select all the sample code in `Code.gs` and delete it.
4. In this GitHub repo open **`apps-script/Code.gs`**. Click the **copy** button (two squares, top
   right of the file) and paste everything into the empty editor.
5. Click the **save** icon (floppy disk). If it asks for a project name, type `Kids Calendar`.
6. In the toolbar, next to **Run** and **Debug**, there's a box listing the script's functions.
   Click it and pick **`install`** from the list, then click **Run**.
7. Google asks you to approve the script:
   - **Review permissions**, then pick your Google account.
   - You'll see **"Google hasn't verified this app"**. That's normal: it's your own script, not a
     published app. Click **Advanced**, then **Go to Kids Calendar (unsafe)**.
   - It asks for four things: to use **this one spreadsheet**, to **send email as you**, to
     **connect to an external service** (to send phone notifications), and to **run when you're
     not there** (to send the change emails). Click **Allow**.
8. The log at the bottom says `Installed. Setup key: XXXXXXXXXX`. Your Sheet now has a **Settings**
   tab with the same `setup_key`. You'll need it once, in Part 3.
9. Click **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
   - Description: `Kids Calendar`
   - Execute as: **Me**
   - Who has access: **Anyone** (this is needed so phones can reach it; only people with a code
     can see anything)
   - Click **Deploy**, then copy the **Web app URL**. It ends in `/exec`.

## Part 2: GitHub (the link everyone opens)

10. In this repo open **`docs/config.js`** and click the **pencil** (Edit).
11. Paste the Web app URL between the quotes, so the line reads:
    `window.KIDS_CAL_API = 'https://script.google.com/macros/s/…/exec';`
    Click **Commit changes**.
12. Go to the repo's **Settings → Pages**. Under "Build and deployment" choose
    **Deploy from a branch**, branch **main**, folder **/docs**, and **Save**.
13. Wait a minute or two. The page shows your link: `https://YOUR-GITHUB-NAME.github.io/kids-calendar/`.

## Part 3: Check it works

14. Open the link on your iPhone in **Safari**. You should see **"Set up your calendar"**.
    - If it says **"not connected"** or **"didn't answer properly"**: check the address in
      `docs/config.js` (it must end in `/exec`) and that step 9 says **Anyone**.
15. Fill in the form with the **setup key** from step 8, your name and email, the other parent's
    name and email, and the kids' first names. Tap **Create calendar**.
16. You get two codes. **Keep yours.** Tap **Send** next to the other parent's code to text it to them.
17. Tap **Share → Add to Home Screen → Add**. Open Kids Calendar from the Home Screen: it opens
    full-screen. Type your code once more (the Home Screen app keeps its own sign-in).
18. Tap **+ Event** and then the **Notes** box. Check the keyboard doesn't hide what you type.
19. Set the usual schedule (Settings → Usual schedule), and add an event. Within about 5 to 10
    minutes the other parent gets one email listing your changes. You never get emails about your
    own changes.

---

## Later

**Updating the Google script** (if a new `Code.gs` comes out):
1. Back up first: in the Sheet, **File → Make a copy**.
2. In Apps Script, select everything in `Code.gs`, delete it, paste the new one, and **save**.
3. Pick **`install`** in the function box and click **Run**. If Google asks for a new permission,
   approve it as in step 7. (Nothing is lost: install never clears the calendar.)
4. **Deploy → Manage deployments → pencil → Version: New version → Deploy**. That keeps the same
   address. Don't use "New deployment": that makes a new address and you'd have to redo step 11.

**Phone notifications:** in the app, **Settings → Notifications on this phone → Turn on**, then
**Allow**. On an iPhone this only works in the app opened from the Home Screen (iOS 16.4 or newer).
Use **Send a test notification** to check. Emails carry on separately (Settings → You).

**Backups:** in the Sheet, **File → Make a copy** now and then.

**Lost code:** anyone already signed in can see everyone's codes under Settings → People.

**Limits:** a normal Gmail account can send about 100 emails a day. Changes are batched, so a
family calendar stays far below that.

**Stopping it:** in Apps Script, **Deploy → Manage deployments → Archive**. Then turn off Pages in
the repo settings.
