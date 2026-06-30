# InsideMDSports News Monitor — Deployment Guide
## Complete step-by-step instructions for getting this live on Vercel

---

## What you'll need (all free or cheap)
- A GitHub account (free) — github.com
- A Vercel account (free) — vercel.com
- An Anthropic API account — console.anthropic.com (~$20-50/month usage)
- A SendGrid account (free tier) — sendgrid.com (for emails)

---

## STEP 1: Create a GitHub account (if you don't have one)

1. Go to **github.com**
2. Click "Sign up"
3. Enter your email, create a password, choose a username
4. Verify your email
5. Done — you have GitHub

---

## STEP 2: Create a new GitHub repository

Think of a repository (or "repo") as a folder on the internet that stores your code.

1. Log into GitHub
2. Click the **+** button in the top-right corner
3. Click **"New repository"**
4. Name it: `insidemdsports-monitor`
5. Make sure **"Private"** is selected (so your code isn't public)
6. Click **"Create repository"**
7. You'll see a page with a URL like `https://github.com/YOURNAME/insidemdsports-monitor`

---

## STEP 3: Upload your files to GitHub

You have a folder called `insidemdsports` with these files inside:
```
insidemdsports/
├── vercel.json
├── package.json
├── api/
│   ├── scan.js
│   ├── digest.js
│   └── morning-brief.js
└── public/
    └── index.html
```

**To upload them:**

1. On your new GitHub repo page, click **"uploading an existing file"** link
   (It's in the middle of the page, in small text)
2. Drag the entire `insidemdsports` folder contents onto the page
   — OR — click "choose your files" and select all the files
3. Important: Upload the FILES inside the folder, not the folder itself.
   GitHub needs to see: vercel.json, package.json, and the api/ and public/ folders
4. Scroll down, type a commit message like "Initial upload"
5. Click **"Commit changes"**

Your files are now on GitHub.

---

## STEP 4: Get your Anthropic API key

This is what lets the scanner actually call Claude to search for news.

1. Go to **console.anthropic.com**
2. Sign up or log in
3. Click **"API Keys"** in the left sidebar
4. Click **"Create Key"**
5. Name it `insidemdsports-monitor`
6. **Copy the key immediately** — it starts with `sk-ant-...`
   (You can only see it once. If you miss it, create a new one.)
7. Paste it somewhere safe temporarily (like a note on your phone)

---

## STEP 5: Set up SendGrid for email delivery

SendGrid sends the actual alert emails to your inbox.

1. Go to **sendgrid.com** and sign up (free tier is plenty)
2. Verify your email address
3. Go to **Settings → API Keys**
4. Click **"Create API Key"**
5. Name it `insidemdsports`
6. Select **"Full Access"**
7. Click **"Create & View"**
8. **Copy the key** (starts with `SG.`)

**Then verify your sender email:**
1. In SendGrid, go to **Settings → Sender Authentication**
2. Click **"Verify a Single Sender"**
3. Enter the email you want alerts to come FROM
   (This can be any email you own — like yourname@gmail.com)
4. Click the verification link SendGrid sends you

---

## STEP 6: Create a Vercel account and deploy

Vercel is where your dashboard actually lives and runs.

1. Go to **vercel.com**
2. Click **"Sign up"**
3. Click **"Continue with GitHub"** — this connects your accounts
4. Authorize Vercel to access your GitHub

**Now import your project:**
1. On the Vercel dashboard, click **"Add New → Project"**
2. Find `insidemdsports-monitor` in the list and click **"Import"**
3. Vercel will automatically detect the settings
4. **Don't click Deploy yet** — you need to add your secret keys first

---

## STEP 7: Add your secret keys to Vercel

These are called "Environment Variables" — they're like passwords that your code can use without them being visible in the code itself.

On the Vercel import page, scroll down to **"Environment Variables"** and add these four:

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | Your key from Step 4 (starts with `sk-ant-`) |
| `SENDGRID_API_KEY` | Your key from Step 5 (starts with `SG.`) |
| `ALERT_EMAIL` | The email where you want to RECEIVE alerts (e.g. jeff@insidemdsports.com) |
| `FROM_EMAIL` | The email you verified in SendGrid (the sender) |

To add each one:
1. Type the Name in the first box
2. Paste the Value in the second box
3. Click "Add"
4. Repeat for all four

---

## STEP 8: Deploy

1. Click **"Deploy"**
2. Vercel will build your project (takes about 60 seconds)
3. When it says "Congratulations!" you're live
4. Click the URL it gives you — something like `insidemdsports-monitor.vercel.app`
5. Your dashboard is live at that URL

---

## STEP 9: Set up a custom domain (optional)

If you want the dashboard at a URL like `monitor.insidemdsports.com`:

1. In Vercel, go to your project → **Settings → Domains**
2. Type `monitor.insidemdsports.com`
3. Vercel will give you DNS settings to add
4. Log into wherever you manage your domain (GoDaddy, Namecheap, etc.)
5. Add the DNS record Vercel shows you
6. Wait 5-10 minutes for it to propagate

---

## STEP 10: Test it

1. Open your dashboard URL
2. Click **"Scan now"**
3. Wait about 30 seconds — it's searching the web
4. You should see Terps news alerts appear, rated 1-5

**To test email alerts:**
- You can manually trigger the digest by visiting:
  `your-url.vercel.app/api/digest`
- This will send you a digest email immediately

---

## How automatic scanning works

Once deployed, Vercel runs your scanner automatically:
- **Every 30 minutes**: Scans for new stories. If any are rated 5, sends you an immediate email.
- **8:00 AM daily**: Morning brief email with overnight news
- **8:00 PM daily**: Full nightly digest email

You don't need to do anything — it just runs.

---

## Making changes later

If you want to update the dashboard, change a scan parameter, add a new name to the watch list, etc.:

1. Make the change in this chat (tell me what you want changed)
2. I'll give you the updated file
3. Go to your GitHub repo
4. Find the file, click the pencil (edit) icon
5. Paste in the new version
6. Click "Commit changes"
7. Vercel automatically redeploys within 60 seconds

---

## Estimated costs

| Service | Cost |
|---------|------|
| Vercel | Free (hobby plan) |
| GitHub | Free |
| SendGrid | Free (up to 100 emails/day) |
| Anthropic API | ~$20-50/month depending on scan frequency |

The Anthropic cost comes from 48 scans/day × $0.003 per scan ≈ ~$4.32/day at the high end. In practice it will be less since scans with few results cost less.

---

## Need help?

If anything goes wrong, take a screenshot of the error and share it here.
The most common issues are:
- Wrong API key (copy-paste error)
- FROM_EMAIL not verified in SendGrid
- Files uploaded in wrong structure to GitHub
