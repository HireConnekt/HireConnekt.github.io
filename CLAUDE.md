# InsideHire.fyi — Project Context

## Overview
Community-powered job search platform where job seekers post a company + job URL to find out who the hiring manager is, and verified "connectors" (company insiders) respond with the hiring manager's name/LinkedIn or offer a referral.

- **Live URL:** https://insidehire.fyi
- **Repo:** HireConnekt/HireConnekt.github.io (GitHub Pages, CNAME: insidehire.fyi)
- **Contact:** siliconvalleysprouts@gmail.com
- **Status:** Beta

---

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS — no build system, no bundler, no framework
- **Backend:** Firebase Firestore (real-time listeners) + Firebase Auth (Google OAuth)
- **Firebase SDK:** compat v9.23.0 loaded via CDN
- **Font:** Inter from Google Fonts
- **Deployment:** GitHub Pages (static hosting, push to main branch to deploy)

---

## File Inventory

| File | Purpose |
|---|---|
| `index.html` | Main landing page (seeker view) |
| `hireconnect.js` | Core app logic (~1071 lines) |
| `hireconnect.css` | All styles (CSS custom properties, `hc-` prefix) |
| `firebase-config.js` | Firebase project config; exports `db` (Firestore) and `auth` |
| `admin.html` | Admin dashboard (seeker stats + connector approval) |
| `admin.js` | Admin dashboard logic |
| `blog.html` | Blog listing page |
| `blog-applying-online.html` | Full blog post: "Why Applying Online Alone Is Not Enough" |
| `CNAME` | GitHub Pages custom domain: `insidehire.fyi` |

---

## Firestore Collections

### `hireconnect_requests`
One document per job connection request.

| Field | Type | Notes |
|---|---|---|
| `jobUrl` | string | URL of job posting |
| `company` | string | Company name |
| `details` | string | Optional extra context from seeker |
| `status` | string | `"open"` or `"resolved"` |
| `submittedAt` | timestamp | When seeker submitted |
| `submittedBy` | string | Display name of seeker |
| `submittedByUid` | string | Firebase UID of seeker |
| `resolvedBy` | string | Display name of connector who resolved |
| `resolvedByUid` | string | Firebase UID of resolver |
| `resolverLinkedinUrl` | string | Connector's LinkedIn URL (copied from their profile at resolve time) |
| `hiringManager` | string | Name/LinkedIn of the hiring manager |
| `referralIntent` | boolean | Whether connector offered a referral |
| `resolverNotes` | string | Notes from connector |
| `resolvedAt` | timestamp | When resolved |

### `hireconnect_connectors`
One document per connector, keyed by Firebase UID.

| Field | Type | Notes |
|---|---|---|
| `uid` | string | Firebase Auth UID (also the doc ID) |
| `email` | string | Google account email |
| `displayName` | string | Google account display name |
| `company` | string | Company they work at |
| `linkedinUrl` | string | Connector's LinkedIn profile URL |
| `approved` | boolean | Set to `true` by admin to enable connector access |
| `requestedAt` | timestamp | When they registered |

### `hireconnect_config/admins`
Single document. Field: `emails` (array of strings). Admin access is granted by matching the signed-in user's email against this list.

---

## Roles & Auth Flow

Two user roles: `"seeker"` and `"connector"`. Role stored in localStorage keyed by `hc_role_{uid}`.

1. User lands on `index.html` → Firebase `onAuthStateChanged` fires
2. If no role in localStorage → `showRolePicker()` shows the role picker modal
3. Seeker: direct to seeker view
4. Connector: `registerConnector()` writes to `hireconnect_connectors` with `approved: false`, then `subscribeConnectorProfile()` sets up a real-time listener
5. `isConnectorApproved` is set by the real-time Firestore listener — updates live without page refresh
6. Unapproved connectors in connector role see a pending message instead of open/resolved requests

### Key JS State Variables (hireconnect.js)
```js
let currentUser = null;          // Firebase Auth user object
let currentRole = null;          // "seeker" | "connector"
let isConnectorApproved = false; // real-time from Firestore
let connectorProfile = null;     // { company, linkedinUrl, ... }
let allCompanies = [];           // list of companies with approved connectors
```

### Key Functions (hireconnect.js)
- `saveRole(role)` — saves to localStorage, triggers subscriptions and re-renders
- `switchRole()` — toggles between seeker/connector (shows modal to re-pick)
- `registerConnector()` — writes connector doc with `approved: false`
- `subscribeConnectorProfile()` — real-time listener; sets `isConnectorApproved`
- `renderAuthBadge()` — renders role badge + Switch button + name + sign out
- `resolveRequest(reqId)` — marks resolved, copies `resolverLinkedinUrl` from profile onto request doc
- `renderOpenRequests()` — gates unapproved connectors with pending message
- `renderResolvedRequests()` — gates unapproved connectors; Thanks badge links to connector's LinkedIn

---

## CSS Conventions

- All class names prefixed with `hc-`
- CSS custom properties defined on `:root`:
  - `--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent`, `--accent-dark`
- Dark mode via `@media (prefers-color-scheme: dark)` on `:root`
- `.hc-topbar` — flex header, `align-items: flex-start`
- `.hc-title` — gradient text via `background-clip: text; -webkit-text-fill-color: transparent`
- `.hc-beta-tag` — `display: block; font-size: 0.5em` (half of title size); overrides text-fill to white
- `.hc-auth-area` — `margin-left: auto` pushes auth elements to the right
- Blog styles: `.hc-blog-*` for listing, `.hc-post-*` for individual post pages

---

## Admin Dashboard

- Gated by email match against `hireconnect_config/admins.emails`
- Shows seeker stats table (grouped by UID, open/resolved counts)
- Shows connector table with pending banner; approve/disable toggle calls `toggleConnector(uid, currentApproved)`
- Files: `admin.html` + `admin.js`

---

## Deployment

Push to `main` branch → GitHub Pages auto-deploys to https://insidehire.fyi.
No build step required — all files are served as-is.

