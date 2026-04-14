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
let allGroups     = [];   // from hireconnect_groups collection

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

// ── Tab switching ─────────────────────────────────────────────

function showAdminTab(tab) {
  ["groups", "seekers", "connectors", "stats"].forEach((t) => {
    const section = document.getElementById(`adminTab_${t}`);
    const btn     = document.getElementById(`adminTabBtn_${t}`);
    if (section) section.style.display = t === tab ? "" : "none";
    if (btn)     btn.classList.toggle("active", t === tab);
  });
  if (tab === "stats") renderPlatformStats();
}

// ── Data Subscriptions ────────────────────────────────────────

function subscribeAdminData() {
  // All groups
  db.collection("hireconnect_groups").onSnapshot(
    (snap) => {
      allGroups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderGroupTable();
      renderPlatformStats();
    },
    (err) => console.error("Admin groups listener error:", err)
  );

  // All requests (open + resolved) for seeker stats and connector company stats
  db.collection("hireconnect_requests").onSnapshot(
    (snap) => {
      allRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderSeekerTable();
      renderConnectorTable();
      renderGroupTable();        // refresh request counts per group
      renderPlatformStats();
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

// ── Group Table ───────────────────────────────────────────────

function renderGroupTable() {
  const wrap = document.getElementById("groupTable");
  if (!wrap) return;

  const countEl = document.getElementById("groupCount");
  if (countEl) {
    countEl.textContent  = allGroups.length;
    countEl.style.display = allGroups.length > 0 ? "" : "none";
  }

  if (allGroups.length === 0) {
    wrap.innerHTML = `<div class="hc-empty">No groups yet.</div>`;
    return;
  }

  const sorted = [...allGroups].sort((a, b) => {
    // Active groups first, then by creation date desc
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const aTime = a.createdAt ? a.createdAt.toMillis() : 0;
    const bTime = b.createdAt ? b.createdAt.toMillis() : 0;
    return bTime - aTime;
  });

  const thead = `
    <thead><tr>
      <th>Group Name</th>
      <th style="text-align:center">Members</th>
      <th style="text-align:center">Open Requests</th>
      <th style="text-align:center">Resolved</th>
      <th style="text-align:center">Connectors</th>
      <th style="text-align:center">Status</th>
      <th style="text-align:center">Action</th>
    </tr></thead>`;

  const tbody = sorted.map((g) => {
    const openCount     = allRequests.filter((r) => r.groupId === g.id && r.status === "open").length;
    const resolvedCount = allRequests.filter((r) => r.groupId === g.id && r.status === "resolved").length;
    const connCount     = connectors.filter((c) => c.groupId === g.id && c.approved).length;

    const statusPill = g.isActive
      ? `<span class="hc-approved-pill">✓ Active</span>`
      : `<span class="hc-unapproved-pill">⊘ Deactivated</span>`;

    const toggleLabel = g.isActive ? "Deactivate" : "Reactivate";
    const toggleClass = g.isActive
      ? "hc-toggle-btn hc-toggle-btn--disable"
      : "hc-toggle-btn hc-toggle-btn--enable";

    const createdDate = g.createdAt
      ? new Date(g.createdAt.toMillis()).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "—";

    return `<tr>
      <td>
        <div style="font-weight:600">${escapeHtml(g.name || "Unnamed")}</div>
        ${g.description ? `<div style="font-size:0.78rem;color:var(--muted)">${escapeHtml(g.description)}</div>` : ""}
        <div style="font-size:0.75rem;color:var(--muted)">Created ${createdDate}</div>
      </td>
      <td style="text-align:center">${g.memberCount || 0}</td>
      <td style="text-align:center">${openCount}</td>
      <td style="text-align:center">${resolvedCount}</td>
      <td style="text-align:center">${connCount}</td>
      <td style="text-align:center">${statusPill}</td>
      <td style="text-align:center">
        <button class="${toggleClass}"
          onclick="toggleGroup('${escapeHtml(g.id)}', ${g.isActive})"
        >${toggleLabel}</button>
      </td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table class="hc-admin-table">${thead}<tbody>${tbody}</tbody></table>`;
}

function toggleGroup(groupId, currentlyActive) {
  if (!isHcAdmin) return;
  if (currentlyActive && !confirm("Deactivate this group? Members will lose access and the invite link will stop working.")) return;
  db.collection("hireconnect_groups").doc(groupId).update({
    isActive: !currentlyActive,
  }).catch((err) => alert("Failed to update group: " + err.message));
}

// ── Platform Stats ────────────────────────────────────────────

function renderPlatformStats() {
  const grid = document.getElementById("platformStatsGrid");
  if (!grid) return;

  const activeGroups      = allGroups.filter((g) => g.isActive).length;
  const deactivatedGroups = allGroups.length - activeGroups;
  const totalOpen         = allRequests.filter((r) => r.status === "open").length;
  const totalResolved     = allRequests.filter((r) => r.status === "resolved").length;
  const totalConnectors   = connectors.filter((c) => c.approved).length;
  const pendingConnectors = connectors.filter((c) => !c.approved).length;

  const stats = [
    { label: "Active Groups",      value: activeGroups,      color: "var(--p0)" },
    { label: "Deactivated Groups", value: deactivatedGroups, color: "var(--muted)" },
    { label: "Open Requests",      value: totalOpen,         color: "var(--active)" },
    { label: "Resolved Requests",  value: totalResolved,     color: "var(--p0)" },
    { label: "Approved Connectors",value: totalConnectors,   color: "var(--p0)" },
    { label: "Pending Connectors", value: pendingConnectors, color: "var(--p1)" },
  ];

  grid.innerHTML = stats.map((s) => `
    <div class="hc-stat-card">
      <div class="hc-stat-value" style="color:${s.color}">${s.value}</div>
      <div class="hc-stat-label">${s.label}</div>
    </div>`).join("");

  // Top groups table
  const topWrap = document.getElementById("topGroupsTable");
  if (!topWrap) return;

  const groupActivity = allGroups.map((g) => ({
    name:     g.name || "Unnamed",
    open:     allRequests.filter((r) => r.groupId === g.id && r.status === "open").length,
    resolved: allRequests.filter((r) => r.groupId === g.id && r.status === "resolved").length,
    members:  g.memberCount || 0,
    isActive: g.isActive,
  })).sort((a, b) => (b.open + b.resolved) - (a.open + a.resolved)).slice(0, 10);

  if (groupActivity.length === 0) {
    topWrap.innerHTML = `<div class="hc-empty">No group activity yet.</div>`;
    return;
  }

  const thead = `<thead><tr>
    <th>Group</th>
    <th style="text-align:center">Members</th>
    <th style="text-align:center">Open</th>
    <th style="text-align:center">Resolved</th>
    <th style="text-align:center">Total Activity</th>
  </tr></thead>`;

  const tbody = groupActivity.map((g) => `<tr>
    <td>
      <span style="font-weight:600">${escapeHtml(g.name)}</span>
      ${!g.isActive ? `<span class="hc-unapproved-pill" style="margin-left:6px">Deactivated</span>` : ""}
    </td>
    <td style="text-align:center">${g.members}</td>
    <td style="text-align:center">${g.open}</td>
    <td style="text-align:center">${g.resolved}</td>
    <td style="text-align:center;font-weight:600">${g.open + g.resolved}</td>
  </tr>`).join("");

  topWrap.innerHTML = `<table class="hc-admin-table">${thead}<tbody>${tbody}</tbody></table>`;
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

  // Build a map of groupId → groupName for display
  const groupNameMap = {};
  allGroups.forEach((g) => { groupNameMap[g.id] = g.name; });

  const thead = `
    <thead>
      <tr>
        <th>Name</th>
        <th>Company</th>
        <th>Group</th>
        <th style="text-align:center">Open (co.)</th>
        <th style="text-align:center">Resolved (co.)</th>
        <th style="text-align:center">Status</th>
        <th style="text-align:center">Action</th>
      </tr>
    </thead>`;

  const tbody = sorted.map((c) => {
    // Count requests for this connector's company within the same group
    const co      = (c.company || "").toLowerCase();
    const gid     = c.groupId || "";
    const companyOpen     = allRequests.filter((r) => r.groupId === gid && r.status === "open"     && (r.company || "").toLowerCase() === co).length;
    const companyResolved = allRequests.filter((r) => r.groupId === gid && r.status === "resolved" && (r.company || "").toLowerCase() === co).length;

    const statusPill = c.approved
      ? `<span class="hc-approved-pill">✓ Approved</span>`
      : `<span class="hc-unapproved-pill">⏳ Pending</span>`;

    const toggleLabel = c.approved ? "Disable" : "Enable";
    const toggleClass = c.approved ? "hc-toggle-btn hc-toggle-btn--disable" : "hc-toggle-btn hc-toggle-btn--enable";
    const groupName   = gid ? escapeHtml(groupNameMap[gid] || gid.slice(-6)) : "—";

    return `
      <tr>
        <td>
          <div style="font-weight:600">${escapeHtml(c.displayName || "Unknown")}</div>
          <div style="font-size:0.78rem;color:var(--muted)">${escapeHtml(c.email || "")}</div>
        </td>
        <td>${escapeHtml(c.company || "—")}</td>
        <td style="font-size:0.82rem;color:var(--muted)">${groupName}</td>
        <td style="text-align:center">${companyOpen}</td>
        <td style="text-align:center">${companyResolved}</td>
        <td style="text-align:center">${statusPill}</td>
        <td style="text-align:center">
          <button
            class="${toggleClass}"
            onclick="toggleConnector('${escapeHtml(c.id)}', ${c.approved})"
          >${toggleLabel}</button>
        </td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `<table class="hc-admin-table">${thead}<tbody>${tbody}</tbody></table>`;
}

// ── Admin Actions ─────────────────────────────────────────────

function toggleConnector(docId, currentApproved) {
  if (!isHcAdmin) return;
  // docId is now "{uid}_{groupId}" — use it directly
  db.collection("hireconnect_connectors").doc(docId).update({
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
