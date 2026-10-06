# CoPublisher in the App Store and Google Play

CoPublisher is one app (the website) that works on phones and computers. The store
versions are thin "wrappers" around the same site, so every update reaches the
store apps instantly with no new review. This folder has everything needed to
list it, and what only the publisher can do.

## What's already done in the app

- Installable phone app: `public/manifest.json`, icons in `public/icons/`, service
  worker `public/sw.js` (PR #90).
- Phone layout with a bottom tab bar (PR #90).
- Public pages the stores require: **/privacy**, **/terms**, **/support** (drafts:
  fill in the `[bracketed]` details first).
- **Delete my account** in Preferences › Your account (Apple requires in-app
  account deletion), via `/api/account-delete`.
- Inside the iPhone store app, sign-in is email-only (the wrapper adds
  `CoPublisherApp-iOS` to its user agent), because Apple requires Sign in with
  Apple if an app offers Google or Facebook sign-in.
- Store screenshots (iPhone 6.7", 1290×2796, also fine for Google Play) in
  `screenshots/`, made with sample data. Real ones from the live app are better
  once you have a week of real stories.

## What the publisher does

1. **Fill in the legal pages** (`public/privacy.html`, `public/terms.html`,
   `public/support.html`): legal business name, support email, mailing address,
   billing terms. Have them checked. (Send the details and Claude will fill them in.)
2. **Google Play developer account**: play.google.com/console, $25 one-time.
   Organization accounts need a D-U-N-S number; individual accounts don't.
3. **Apple Developer Program**: developer.apple.com/programs, $99/year.
   Organizations need a D-U-N-S number (free, can take a week or two to issue).
4. Decide the **store name** (see below) and send a real logo if you want one.

## Android (Google Play): about an afternoon

Uses a Trusted Web Activity: the Play app opens the site full screen, with
notifications working like a native app.

1. Go to **pwabuilder.com**, enter `https://ims-tool.vercel.app` (or your custom
   domain), and choose **Package for stores › Android**. Keep the package ID it
   suggests (e.g. `app.vercel.ims_tool.twa`) or set one like `com.copublisher.app`.
2. Download the package. It contains the `.aab` to upload, a signing key
   (**keep it safe and backed up**: you need it for every future update) and an
   `assetlinks.json` file.
3. Send Claude the `assetlinks.json` (or the SHA-256 fingerprint in it). It goes at
   `public/.well-known/assetlinks.json` so Android trusts the site and hides the
   browser bar.
4. In the Play Console: create the app, upload the `.aab` to **Internal testing**
   first, fill in the listing (copy below), the Data safety form (answers below),
   content rating (questionnaire: no objectionable content) and target audience
   (adults). Then promote to Production. Review usually takes a few days.

## iPhone (App Store): needs a little more

Apple reviews more strictly (guideline 4.2 rejects apps that are "just a website").
CoPublisher's case: bottom tab navigation, push notifications, transcription with
the microphone, offline-friendly drafts (Phase 3). Plan:

1. **Native push.** Web push doesn't work inside an App Store wrapper on iPhone, so
   the iPhone app needs Apple push (APNs): a push key from the Apple Developer
   account, and the server sending to it alongside web push. Claude can build this
   once the developer account exists.
2. **Build the wrapper** with Capacitor, set to add `CoPublisherApp-iOS` to the
   user agent. Building and uploading needs a Mac with Xcode, or a cloud build
   service (Codemagic or Ionic Appflow, free tiers) with your Apple account
   connected. Claude can set up the project and the cloud build.
3. In App Store Connect: create the app, add the listing, App Privacy answers
   (below), screenshots, support and privacy URLs, and a **demo login for the
   reviewer** (a test account in a test newsroom). Submit for review (usually
   1-3 days; first submissions often get questions).
4. **Payments:** keep sign-up and billing on the website, not in the app. Apple
   allows business tools where accounts are bought elsewhere, but the app must not
   link to or mention buying a plan.

## Store listing copy

- **Name:** CoPublisher AI (30 characters max on iPhone)
- **Subtitle (iPhone, 30):** Run your newsroom on the go
- **Short description (Google Play, 80):** AI newsroom assistant: rated news, breaking alerts, drafts and transcripts.
- **Category:** Business (secondary: News on iPhone; Productivity on Google Play)
- **Keywords (iPhone, 100):** newsroom,sports news,publisher,journalist,editor,breaking news,transcription,AI writing,beat
- **Description:**

> Your newsroom, in your pocket. CoPublisher AI watches every source on your beat,
> rates each story 1 to 5, and alerts you the moment something breaks, so you can
> publish first from wherever you are.
>
> • Breaking alerts: rated news from dozens of sources, with phone notifications
>   for the big ones and a one-tap Write it that drafts the story in your house
>   style, grounded in your own archive and the current roster.
> • Write and edit on the go: a full copy desk in your phone. Paste a draft or give
>   directions and get publish-ready copy with headlines, SEO and fact-check flags.
> • Transcribe anything: record a press conference with your phone's microphone,
>   upload audio, or paste a YouTube link. Every transcript is saved and searchable,
>   and one tap turns it into a story.
> • Know when to publish: hot spots show the best times to post, from your own
>   audience numbers, with reminders.
> • Team chat, calendar, competitor watch and analytics, all in one place.
>
> Built for sports and local news publishers. Requires a CoPublisher newsroom account.

- **Support URL:** https://ims-tool.vercel.app/support
- **Privacy policy URL:** https://ims-tool.vercel.app/privacy

## Privacy answers (Apple App Privacy / Google Data safety)

- **Collected, linked to the user, not used for tracking:** contact info (email,
  name); user content (drafts, transcripts, chat messages, photos, audio for
  transcription); identifiers (user ID); diagnostics (server logs).
- **Not collected:** location, contacts, browsing history, financial info, health.
- **Not sold, not shared for advertising.** Data is processed by service providers
  (AI, transcription, hosting, email) only to run the app.
- **Encrypted in transit:** yes. **Users can request deletion:** yes, in the app.
