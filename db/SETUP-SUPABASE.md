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
