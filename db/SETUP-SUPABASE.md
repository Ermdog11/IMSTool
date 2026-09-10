# Supabase setup — remaining steps

You've created the Supabase account and project. Three things left. None take more than a
couple of minutes.

## 1. Create the database tables

1. In Supabase, open **SQL Editor** (left sidebar) → **New query**.
2. Open `db/schema.sql` from this project, copy the whole file, paste it into the editor.
3. Click **Run**. You should see "Success. No rows returned."
   (Safe to run again later if we add to it.)

## 2. Give me the two safe values

In Supabase → **Project Settings** (gear) → **API Keys** (and **Data API** for the URL),
copy and paste into chat:

- **Project URL** (e.g. `https://abcdefgh.supabase.co`)
- **Publishable key** (`sb_publishable_...`) — Supabase itself says this "can be safely
  shared publicly."

## 3. Add all three values to Vercel (I'll tell you exactly when)

In **Vercel → the `ims-tool` project → Settings → Environment Variables**, add three, each
for **Production, Preview, and Development**:

| Name | Value |
|---|---|
| `SUPABASE_URL` | the Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_...` key |
| `SUPABASE_SECRET_KEY` | the **`sb_secret_...`** key. **Only paste this in Vercel, never in chat.** |

Then redeploy (Vercel does this automatically on the next push, or hit **Redeploy** on the
latest deployment).

## 4. Auth settings (I'll confirm the values with you)

In Supabase → **Authentication** → **URL Configuration**:

- **Site URL:** `https://ims-tool.vercel.app`
- **Redirect URLs:** add `https://ims-tool.vercel.app/**`

In **Authentication → Providers**: **Email** is on by default (magic links). Google
sign-in is optional and can be added later.

## 5. First sign-in

Once the env vars are in Vercel and it's redeployed:

1. Go to `https://ims-tool.vercel.app/login`
2. Enter your email → click the link in the email.
3. **The first person to sign in is automatically made the publisher** of InsideMDSports.
4. From then on: **Settings → Team & alerts** (only you see it) — invite your writers by
   email, set roles, and tick who gets which alerts. They get access the first time they
   sign in with the invited email.

Until step 5 is done, the tool stays exactly as it is now — open, no sign-in — so nothing
breaks while the keys aren't set.

### Email note
Supabase's built-in email sender is rate-limited (a few per hour) — fine for setting up a
small team. If we hit the limit, we point Supabase at the same Gmail SMTP the digests
already use (Authentication → Emails → SMTP Settings).
