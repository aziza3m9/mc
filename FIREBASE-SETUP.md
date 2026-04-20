# Firebase Migration — Setup Steps

Project: `medicalcoding-39666`

After merging this PR, do these steps in the Firebase console **once** so
sign-in and sync actually work.

## 1. Enable Email/Password sign-in

- Open: https://console.firebase.google.com/project/medicalcoding-39666/authentication/providers
- If the page prompts to "Get started", click it
- Click **Email/Password** → toggle **Enable** → **Save**

## 2. Create the two user accounts

- Open: https://console.firebase.google.com/project/medicalcoding-39666/authentication/users
- Click **Add user** → email: `support@jcatmedia.com`, set a password → **Add user**
- Click **Add user** → email: `clarence@jcatmedia.com`, set a temporary password → **Add user**
- Share Clarence's temp password with him; he can reset via the **Forgot password** flow on first login.

## 3. Create the Firestore database (if not already)

- Open: https://console.firebase.google.com/project/medicalcoding-39666/firestore
- Click **Create database**
- Pick **Production mode** (locked down by default; rules below open exactly what's needed)
- Region: pick whatever's closest (e.g. `us-central`). This is permanent.

## 4. Deploy the security rules

The rules live in `firestore.rules` in this repo. Two options:

### Option A — Paste in the console (easiest)

- Open: https://console.firebase.google.com/project/medicalcoding-39666/firestore/rules
- Copy the entire contents of `firestore.rules`
- Paste into the editor, replacing whatever is there
- Click **Publish**

### Option B — Deploy via Firebase CLI

```sh
npm install -g firebase-tools
firebase login
firebase use medicalcoding-39666
firebase deploy --only firestore:rules
```

## 5. Add your GitHub Pages origin to Firebase Auth's allowed domains

Firebase rejects auth requests from origins it doesn't know.

- Open: https://console.firebase.google.com/project/medicalcoding-39666/authentication/settings
- Scroll to **Authorized domains** → **Add domain**
- Add: `aziza3m9.github.io`
- (You can keep `localhost` and `*.firebaseapp.com` — those are fine.)

## 6. Force email verification (recommended)

The security rules require `email_verified == true`. After creating users in
step 2, go to each user in the Authentication → Users list and click the
three-dot menu → **Send verification email**. Users must click the link from
the email before they can sign in the first time.

*(Optional:* If you'd rather skip this for now, open `firestore.rules` and
remove the `&& request.auth.token.email_verified == true` line before
publishing. Safer to keep it on.)*

## 7. (Optional) Turn off the GitHub Pages client-side lock

Since Firebase Auth is the real gate now, the old client-side lock is
replaced. Nothing further needed — the new `lock-screen` in the app is the
Firebase sign-in form.

## 8. Sanity check

- Visit https://aziza3m9.github.io/mc/
- You should see the new **Sign in** card (not "Set a password")
- Enter `support@jcatmedia.com` + password → should land on the dashboard
- Open the same URL on a second browser/device, sign in as Clarence → changes
  you make should appear on both within ~1 second

## Troubleshooting

- **"This app is not authorized"** → step 5, add your domain.
- **"auth/operation-not-allowed"** → step 1, enable Email/Password.
- **"Missing or insufficient permissions"** → step 4, publish the rules. Also
  make sure your account's email is verified (step 6) and ends in `@jcatmedia.com`.
- **Cases don't sync across devices** → make sure both users signed in with
  `@jcatmedia.com` accounts. Non-Jcat accounts can authenticate but the
  rules will reject all reads/writes.
