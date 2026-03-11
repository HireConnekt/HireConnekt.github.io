/* ============================================================
   HireConnect Admin – admin.js
   Admin dashboard: seeker stats, connector management.
   Depends on: firebase-config.js (loaded before this file)
   ============================================================ */

// ── State ─────────────────────────────────────────────────────
let currentUser   = null;
let hcAdminEmails = [];
let isHcAdmin     = false;
let allRequests   = [];   // open + resolved combined (for stats)
let connectors    = [];   // from hireconnect_connectors collection

// ── Utilities ─────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#039;");
}

function showAccessDenied(msg, showSignIn) {
  document.getElementById("adminMain").style.display    = "none";
  document.getElementById("accessDenied").style.display = "";
  document.getElementById("accessDeniedMsg").textContent = msg;
  const btn = document.getElementById("signinBtn");
  if (btn) btn.style.display = showSignIn ? "" : "none";
}

function adminSignIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch((e) => alert("Sign-in failed: " + e.message));
}

// ── Auth Badge ────────────────────────────────────────────────

function renderAdminAuthBadge() {
  const area = document.getElementById("authArea");
  if (!area || !currentUser) return;
  const name = escapeHtml(currentUser.displayName || currentUser.email || "Admin");
  area.innerHTML = `
    <span class="hc-auth-name" title="${name}">${name}</span>
    <button class="hc-signout-btn" onclick="auth.signOut()">Sign Out</button>
  `;
}

// ── Data Subscriptions ────────────────────────────────────────

function subscribeAdminData() {
  // All requests (open + resolved) for seeker stats and connector company stats
  db.collection("hireconnect_requests").onSnapshot(
    (snap) => {
      allRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderSeekerTable();
      renderConnectorTable(); // connector company stats depend on allRequests
    },
    (err) => console.error("Admin requests listener error:", err)
  );

  // All connector profiles
  db.collection("hireconnect_connectors").onSnapshot(
    (snap) => {
      connectors = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderConnectorTable();
    },
    (err) => console.error("Admin connectors listener error:", err)
  );
}

// ── Seeker Table ──────────────────────────────────────────────

function renderSeekerTable() {
  const wrap = document.getElementById("seekerTable");
  if (!wrap) return;

  // Group requests by submittedByUid
  const map = {}; // key → { name, email?, open, resolved }

  allRequests.forEach((r) => {
    const key  = r.submittedByUid || "__anon__";
    const name = r.submittedBy
      ? r.submittedBy
      : (r.submittedByUid ? "User …" + r.submittedByUid.slice(-4) : "Anonymous");

    if (!map[key]) map[key] = { name, open: 0, resolved: 0 };
    // Prefer a non-empty display name
    if (r.submittedBy && map[key].name.startsWith("User ")) {
      map[key].name = r.submittedBy;
    }
    if (r.status === "open")     map[key].open++;
    if (r.status === "resolved") map[key].resolved++;
  });

  const rows = Object.values(map).sort((a, b) => (b.open + b.resolved) - (a.open + a.resolved));

  // Update count badge
  const countEl = document.getElementById("seekerCount");
  const uniqueSeekers = rows.filter(r => r !== map["__anon__"] || map["__anon__"]);
  if (countEl) {
    countEl.textContent  = rows.length;
    countEl.style.display = rows.length > 0 ? "" : "none";
  }

  if (rows.length === 0) {
    wrap.innerHTML = `<div class="hc-empty">No seekers yet.</div>`;
    return;
  }

  const thead = `
    <thead>
      <tr>
        <th>Name</th>
        <th style="text-align:center">Open</th>
        <th style="text-align:center">Resolved</th>
        <th style="text-align:center">Total</th>
      </tr>
    </thead>`;

  const tbody = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td style="text-align:center">${r.open}</td>
      <td style="text-align:center">${r.resolved}</td>
      <td style="text-align:center;font-weight:600">${r.open + r.resolved}</td>
    </tr>`).join("");

  wrap.innerHTML = `<table class="hc-admin-table">${thead}<tbody>${tbody}</tbody></table>`;
}

// ── Connector Table ───────────────────────────────────────────

function renderConnectorTable() {
  const wrap = document.getElementById("connectorTable");
  if (!wrap) return;

  // Update count badge
  const countEl = document.getElementById("connectorCount");
  if (countEl) {
    countEl.textContent   = connectors.length;
    countEl.style.display = connectors.length > 0 ? "" : "none";
  }

  // Pending banner
  const pending   = connectors.filter((c) => !c.approved);
  const bannerEl  = document.getElementById("pendingBanner");
  const pendingEl = document.getElementById("pendingCount");
  if (bannerEl)  bannerEl.style.display  = pending.length > 0 ? "" : "none";
  if (pendingEl) pendingEl.textContent   = pending.length;

  if (connectors.length === 0) {
    wrap.innerHTML = `<div class="hc-empty">No connectors registered yet.</div>`;
    return;
  }

  // Sort: pending first, then alphabetically by name
  const sorted = [...connectors].sort((a, b) => {
    if (a.approved === b.approved) return (a.displayName || "").localeCompare(b.displayName || "");
    return a.approved ? 1 : -1; // pending first
  });

  const thead = `
    <thead>
      <tr>
        <th>Name</th>
        <th>Company</th>
        <th style="text-align:center">Open (co.)</th>
        <th style="text-align:center">Resolved (co.)</th>
        <th style="text-align:center">Status</th>
        <th style="text-align:center">Action</th>
      </tr>
    </thead>`;

  const tbody = sorted.map((c) => {
    // Count requests for this connector's company (case-insensitive)
    const co = (c.company || "").toLowerCase();
    const companyOpen     = allRequests.filter((r) => r.status === "open"     && (r.company || "").toLowerCase() === co).length;
    const companyResolved = allRequests.filter((r) => r.status === "resolved" && (r.company || "").toLowerCase() === co).length;

    const statusPill = c.approved
      ? `<span class="hc-approved-pill">✓ Approved</span>`
      : `<span class="hc-unapproved-pill">⏳ Pending</span>`;

    const toggleLabel = c.approved ? "Disable" : "Enable";
    const toggleClass = c.approved ? "hc-toggle-btn hc-toggle-btn--disable" : "hc-toggle-btn hc-toggle-btn--enable";

    return `
      <tr>
        <td>
          <div style="font-weight:600">${escapeHtml(c.displayName || "Unknown")}</div>
          <div style="font-size:0.78rem;color:var(--muted)">${escapeHtml(c.email || "")}</div>
        </td>
        <td>${escapeHtml(c.company || "—")}</td>
        <td style="text-align:center">${companyOpen}</td>
        <td style="text-align:center">${companyResolved}</td>
        <td style="text-align:center">${statusPill}</td>
        <td style="text-align:center">
          <button
            class="${toggleClass}"
            onclick="toggleConnector('${escapeHtml(c.uid)}', ${c.approved})"
          >${toggleLabel}</button>
        </td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `<table class="hc-admin-table">${thead}<tbody>${tbody}</tbody></table>`;
}

// ── Admin Actions ─────────────────────────────────────────────

function toggleConnector(uid, currentApproved) {
  if (!isHcAdmin) return;
  db.collection("hireconnect_connectors").doc(uid).update({
    approved: !currentApproved,
  }).catch((err) => alert("Failed to update connector: " + err.message));
}

// ── Init ──────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  auth.onAuthStateChanged((user) => {
    currentUser = user;

    if (!user) {
      showAccessDenied("Please sign in to access the admin dashboard.", true);
      return;
    }

    // Check admin status
    db.collection("hireconnect_config").doc("admins").get()
      .then((snap) => {
        hcAdminEmails = snap.exists ? (snap.data().emails || []) : [];
        isHcAdmin     = hcAdminEmails
          .map((e) => e.toLowerCase())
          .includes((user.email || "").toLowerCase());

        if (!isHcAdmin) {
          showAccessDenied("Access denied. This page is for admins only.", false);
          return;
        }

        renderAdminAuthBadge();
        document.getElementById("adminMain").style.display   = "";
        document.getElementById("accessDenied").style.display = "none";
        subscribeAdminData();
      })
      .catch(() => showAccessDenied("Could not verify admin access. Try again.", true));
  });
});
