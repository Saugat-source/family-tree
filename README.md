# Shrestha Family Tree

A private family tree website. Relatives sign up, an admin approves them, and approved members add themselves (with details and a photo) under the right ancestor.

- **Website**: hosted free on **GitHub Pages** (the files in this folder).
- **Logins, data and photos**: stored free on **Supabase**.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The website |
| `config.js` | Your Supabase keys and the site title |
| `i18n.js` | The Nepali wording for every English line on the site |
| `supabase-schema.sql` | Creates the database, roles, access rules, photo storage and the starting family line |
| `supabase-update-roles.sql` | Only for databases created before roles were added; new projects don't need it |

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
   set status = 'approved', role = 'admin'
   where email = 'your-email@example.com';
   ```
3. Log in on the site. You'll see the **Members & roles** tab.
4. Open **Saugat Shrestha** in the tree → **Edit** → tick **This is me** → **Save**. That links the entry to your account.

You only do step 6 once. After that you approve everyone from the **Members & roles** tab and choose each person's role there.

---

## How the family uses it

1. A relative opens the site and clicks **Become a member**.
2. You see them under **Members & roles → Waiting for approval**, choose their role and click **Approve** (or **Reject**).
3. They log in and press **Connect me**. It asks about them, then their father or mother, searching the tree as they type.
4. If a parent isn't in the tree yet (for example, someone from one of Gangaram's other three sons), they add them and are asked about the next generation up, until the guide finds a match.
5. They check the line on the review screen and confirm. If they were already added by someone else, the guide offers **This is me** instead.

**Roles** (set by admins on the **Members & roles** page)

| Role | Can do |
|---|---|
| **Admin** | Everything: approve members, change roles, add new top ancestors, edit and delete anyone |
| **Editor** | Add people (including new top ancestors), edit and delete anyone in the tree |
| **Member** | Add people, edit themselves and the people they added *(default for new members)* |
| **Viewer** | See the tree only |

- Only approved members can see the tree and photos, whatever their role.
- People can only be deleted if they have no children in the tree.
- There must always be at least one admin; the database refuses to remove the last one.

---

## Good to know

- **Confirmation emails**: Supabase's built-in email sender only allows a few emails per hour. If many relatives join on the same day, either
  - turn off **Authentication → Sign In / Providers → Email → Confirm email** (you approve everyone by hand anyway), or
  - connect your own email service under **Authentication → SMTP Settings**.
- **Free plan pause**: Supabase pauses free projects after about a week with no activity. If that happens, open the Supabase dashboard and click **Restore**. Regular visits keep it awake.
- **Backups**: export your data now and then from **Table Editor → persons → Export to CSV**.
- **Changing the title**: edit `siteTitle` in `config.js`, and its Nepali version in `i18n.js`.
- **Languages**: everyone can switch between English and नेपाली with the buttons at the top; the site remembers the choice on that phone or computer. To fix a Nepali wording, change the right-hand side of its line in `i18n.js`.
- **Updating the site**: change files in the GitHub repository; Pages republishes automatically within a minute or two.
