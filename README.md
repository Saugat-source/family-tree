# Shrestha Family Tree

A private family tree website. Relatives sign up, an admin approves them, and approved members add themselves (with details and a photo) under the right ancestor.

- **Website**: hosted free on **GitHub Pages** (the files in this folder).
- **Logins, data and photos**: stored free on **Supabase**.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The website |
| `config.js` | Your Supabase keys and the site title |
| `supabase-schema.sql` | Creates the database, access rules, photo storage and the starting family line |

---

## Setup (about 20 minutes)

### 1. Create the Supabase project
1. Go to <https://supabase.com>, sign up (free), and click **New project**.
2. Give it a name (e.g. `family-tree`), set a database password (save it somewhere), choose the region closest to your family (e.g. *Mumbai* or *Singapore*), and create it.

### 2. Create the database
1. In your Supabase project open **SQL Editor → New query**.
2. Open `supabase-schema.sql`, copy everything, paste it in, and click **Run**.
   This creates the tables and photo storage, and adds Gangaram Shrestha → Kuber → Ratna Bahadur → Dal Bahadur → Santa Bahadur → Saugat.

### 3. Put your keys in `config.js`
1. In Supabase open **Project Settings → API** (or **Connect**).
2. Copy the **Project URL** and the **anon / public** key into `config.js`.
   The anon key is designed to be public; the database rules stop anyone who isn't approved from seeing data. **Never** put the `service_role` key in this website.

### 4. Publish on GitHub Pages
1. On <https://github.com> create a new repository, e.g. `family-tree`. It can be public; your family data is in Supabase, not in GitHub.
2. Click **Add file → Upload files** and upload everything in this folder (including the `.nojekyll` file), then **Commit changes**.
3. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, choose **main** and **/ (root)**, and click **Save**.
4. After a minute your site is live at `https://YOUR-USERNAME.github.io/family-tree/`.

### 5. Tell Supabase your website address
In Supabase open **Authentication → URL Configuration**:
- **Site URL**: `https://YOUR-USERNAME.github.io/family-tree/`
- **Redirect URLs**: add the same address.

This makes the confirmation and password-reset emails link back to your site.

### 6. Make yourself the admin
1. Open your site, click **Become a member**, and sign up with your own email. Confirm the email if asked.
2. In Supabase **SQL Editor**, run (with your email):
   ```sql
   update public.profiles
   set status = 'approved', is_admin = true
   where email = 'your-email@example.com';
   ```
3. Log in on the site. You'll see the **Members** tab.
4. Open **Saugat Shrestha** in the tree → **Edit** → tick **This is me** → **Save**. That links the entry to your account.

You only do step 6 once. After that you approve everyone from the **Members** tab, and you can make other trusted relatives admins there too.

---

## How the family uses it

1. A relative opens the site and clicks **Become a member**.
2. You see them under **Members → Waiting for approval** and click **Approve** (or **Reject**).
3. They log in, find their father or mother in the tree (or use search), open them and click **Add child**.
4. They fill in their details and photo, tick **This is me**, and save.
5. If their parent isn't in the tree yet (for example, someone from one of Gangaram's other three sons), they add the missing ancestors first, starting under the nearest person who is already there.

**Who can do what**
- Only approved members can see the tree and photos.
- Any approved member can add people.
- A person can be edited by whoever added them, by the member linked to them ("This is me"), or by an admin.
- Only admins can delete people (and only people with no children), approve members, or add a new top ancestor.

---

## Good to know

- **Confirmation emails**: Supabase's built-in email sender only allows a few emails per hour. If many relatives join on the same day, either
  - turn off **Authentication → Sign In / Providers → Email → Confirm email** (you approve everyone by hand anyway), or
  - connect your own email service under **Authentication → SMTP Settings**.
- **Free plan pause**: Supabase pauses free projects after about a week with no activity. If that happens, open the Supabase dashboard and click **Restore**. Regular visits keep it awake.
- **Backups**: export your data now and then from **Table Editor → persons → Export to CSV**.
- **Changing the title**: edit `siteTitle` in `config.js`.
- **Updating the site**: change files in the GitHub repository; Pages republishes automatically within a minute or two.
