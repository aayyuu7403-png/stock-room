# Stock Room

A simple inventory tracker. Add your products with photo, quantity, cost and selling price. See stock value and low-stock alerts, and import or export Excel.

- **No build step.** Plain HTML, CSS and JS, so it runs on GitHub Pages as is.
- **Works on phone.** Installable as an app (Add to Home Screen) and opens offline.
- **Two storage modes:**
  | Mode | Setup | Where data lives |
  |---|---|---|
  | **This device only** (default) | none | the browser's IndexedDB on that one device |
  | **Cloud sync** | free Supabase project, ~10 min | your Supabase database. Sign in from any device; changes appear live |

---

## 1. Run it on your computer

Open a terminal in this folder and run:

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173.

---

## 2. Put it online with GitHub Pages

1. Create a new repository on https://github.com/new (for example `stock-room`). Leave "Add README" unticked.
2. In this folder, run (replace `YOUR-USERNAME`):
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/stock-room.git
   git push -u origin main
   ```
3. On GitHub, open the repo → **Settings → Pages**. Under **Build and deployment** pick **Deploy from a branch**, then **main** / **/(root)** → **Save**.
4. After about a minute the site is live at `https://YOUR-USERNAME.github.io/stock-room/`.

To publish changes later:

```bash
git add -A && git commit -m "Update" && git push
```

> In **This device only** mode, everyone who opens the link gets their own empty inventory in their own browser. Nobody else can see your data. But it is also **not** shared between your phone and your laptop. If you want the same data everywhere, set up cloud sync below.

---

## 3. Cloud sync (same stock on phone + laptop)

1. Create a free project at https://supabase.com.
2. In the project, open **SQL Editor → New query**. Paste in the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. This creates the products table, a private photo bucket and the security rules, so each user can only ever see their own data.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.
4. Paste both into [`js/config.js`](js/config.js):
   ```js
   supabaseUrl: "https://xxxx.supabase.co",
   supabaseAnonKey: "eyJhbGciOi...",
   ```
5. In Supabase, open **Authentication → URL Configuration** and set **Site URL** to your GitHub Pages address.
6. Commit and push. Open the site and click **Create account** to sign up with your email.
7. **Lock it down:** once your account exists, go to **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**. Also set `allowSignup: false` in `js/config.js`.

The anon key is meant to be public. The row-level security rules in `schema.sql` are what protect your data. **Never** put the `service_role` key in this project.

**Moving existing data to the cloud:** in device-only mode, use **Export → Full backup**. After switching to cloud mode and signing in, use **Import** and choose that `.json` file.

---

## Using it

- **Add product:** name, SKU (auto-generated if left blank), category, quantity, cost, selling price and low-stock level, plus a photo from the camera or gallery. Photos are shrunk automatically.
- **Change quantity:** use the − / + buttons, or type a number straight into the table.
- **Import:** `.xlsx` / `.csv` with columns such as `Product, SKU, Category, Quantity, Cost Price, Selling Price, Low Stock At, Notes`. Rows whose SKU already exists update that product; the rest are added as new products.
- **Export:** an Excel sheet to view or share, or a **Full backup** (`.json`, includes photos) that you can restore through Import.

## Project layout

```
index.html            page markup
css/styles.css        styles (light + dark theme)
js/config.js          your settings (Supabase keys go here)
js/store.js           storage: IndexedDB (local) or Supabase (cloud)
js/app.js             app logic
sw.js                 offline cache
manifest.webmanifest  install-as-app info
supabase/schema.sql   database setup for cloud sync
legacy/               the original claude.ai artifact version
```
