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

// Beta state
let betaWaitlist     = [];   // from beta_waitlist collection
let creatorInvites   = [];   // from beta_creator_invites collection
let betaSettings     = null; // from hireconnect_config/beta_settings
let waitlistFilter   = 'all'; // current filter: all, pending, approved, rejected

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
  ["groups", "waitlist", "invites", "seekers", "connectors", "stats"].forEach((t) => {
    const section = document.getElementById(`adminTab_${t}`);
    const btn     = document.getElementById(`adminTabBtn_${t}`);
    if (section) section.style.display = t === tab ? "" : "none";
    if (btn)     btn.classList.toggle("active", t === tab);
  });
  if (tab === "stats") renderPlatformStats();
  if (tab === "waitlist") renderWaitlistTable();
  if (tab === "invites") renderInviteTable();
}

// ── Data Subscriptions ────────────────────────────────────────

function subscribeAdminData() {
  // Beta settings
  db.collection("hireconnect_config").doc("beta_settings").onSnapshot(
    (snap) => {
      betaSettings = snap.exists ? snap.data() : { defaultCreatorQuota: 3, betaEnabled: false };
    },
    (err) => console.error("Beta settings listener error:", err)
  );

  // Beta waitlist
  db.collection("beta_waitlist").orderBy("requestedAt", "desc").onSnapshot(
    (snap) => {
      betaWaitlist = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderWaitlistTable();
    },
    (err) => console.error("Waitlist listener error:", err)
  );

  // Creator invites
  db.collection("beta_creator_invites").onSnapshot(
    (snap) => {
      creatorInvites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderInviteTable();
    },
    (err) => console.error("Creator invites listener error:", err)
  );

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

// ══════════════════════════════════════════════════════════════
// BETA WAITLIST & CREATOR INVITES
// ══════════════════════════════════════════════════════════════

// ── Beta Waitlist Filter ──────────────────────────────────────

function filterWaitlist(status) {
  waitlistFilter = status;
  ["all", "pending", "approved", "rejected"].forEach((s) => {
    const btn = document.getElementById(`waitlistFilter_${s}`);
    if (btn) btn.classList.toggle("active", s === status);
  });
  renderWaitlistTable();
}

// ── Beta Waitlist Table ───────────────────────────────────────

function renderWaitlistTable() {
  const wrap = document.getElementById("waitlistTable");
  if (!wrap) return;

  // Count by status
  const pendingCount  = betaWaitlist.filter((w) => w.status === "pending").length;
  const approvedCount = betaWaitlist.filter((w) => w.status === "approved").length;
  const rejectedCount = betaWaitlist.filter((w) => w.status === "rejected").length;

  // Update counts in filter buttons
  const pendingBadge  = document.getElementById("waitlistPendingCount");
  const approvedBadge = document.getElementById("waitlistApprovedCount");
  const rejectedBadge = document.getElementById("waitlistRejectedCount");
  if (pendingBadge)  pendingBadge.textContent  = pendingCount > 0 ? `(${pendingCount})` : "";
  if (approvedBadge) approvedBadge.textContent = approvedCount > 0 ? `(${approvedCount})` : "";
  if (rejectedBadge) rejectedBadge.textContent = rejectedCount > 0 ? `(${rejectedCount})` : "";

  // Update total count badge
  const countBadge = document.getElementById("waitlistCount");
  if (countBadge) {
    countBadge.textContent = betaWaitlist.length;
    countBadge.style.display = betaWaitlist.length > 0 ? "" : "none";
  }

  // Filter data
  const filtered = waitlistFilter === "all"
    ? betaWaitlist
    : betaWaitlist.filter((w) => w.status === waitlistFilter);

  if (filtered.length === 0) {
    wrap.innerHTML = '<div class="hc-empty">No waitlist requests.</div>';
    return;
  }

  let html = `
    <table class="hc-admin-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Requested</th>
          <th>Status</th>
          <th>Reviewed By</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
  `;

  filtered.forEach((req) => {
    const requestedDate = req.requestedAt?.toDate
      ? req.requestedAt.toDate().toLocaleDateString()
      : "—";
    const reviewedDate = req.reviewedAt?.toDate
      ? req.reviewedAt.toDate().toLocaleDateString()
      : "—";

    const statusBadge = req.status === "pending"
      ? `<span style="color:#f59e0b;font-weight:600">Pending</span>`
      : req.status === "approved"
      ? `<span style="color:#22c55e;font-weight:600">Approved</span>`
      : `<span style="color:#ef4444;font-weight:600">Rejected</span>`;

    let actions = "";
    if (req.status === "pending") {
      actions = `
        <button class="hc-submit-btn" onclick="approveWaitlistRequest('${req.id}', '${escapeHtml(req.email)}')" style="font-size:0.85rem;padding:4px 10px">
          ✓ Approve
        </button>
        <button class="hc-cancel-btn" onclick="rejectWaitlistRequest('${req.id}')" style="font-size:0.85rem;padding:4px 10px;margin-left:4px">
          ✕ Reject
        </button>
      `;
    } else if (req.status === "approved") {
      actions = `
        <button class="hc-submit-btn" onclick="copyEmailToClipboard('${escapeHtml(req.email)}')" style="font-size:0.85rem;padding:4px 10px">
          📧 Copy Email
        </button>
      `;
    }

    html += `
      <tr>
        <td>${escapeHtml(req.email)}</td>
        <td>${requestedDate}</td>
        <td>${statusBadge}</td>
        <td>${escapeHtml(req.reviewedBy || "—")}<br><small style="opacity:0.7">${reviewedDate}</small></td>
        <td>${actions}</td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// ── Waitlist Actions ──────────────────────────────────────────

async function approveWaitlistRequest(docId, email) {
  if (!confirm(`Approve Beta access request from ${email}?\n\nRemember to grant a creator invite on the Creator Invites tab!`)) return;

  try {
    await db.collection("beta_waitlist").doc(docId).update({
      status: "approved",
      reviewedBy: currentUser.email,
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert(`✓ Approved ${email}!\n\nNext step: Go to "Creator Invites" tab and send them an invite.`);
  } catch (err) {
    alert("Failed to approve: " + err.message);
  }
}

async function rejectWaitlistRequest(docId) {
  const note = prompt("Optional: Add a note explaining why this request was rejected:");

  try {
    await db.collection("beta_waitlist").doc(docId).update({
      status: "rejected",
      reviewedBy: currentUser.email,
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
      notes: note || ""
    });
  } catch (err) {
    alert("Failed to reject: " + err.message);
  }
}

function copyEmailToClipboard(email) {
  navigator.clipboard.writeText(email).then(() => {
    alert(`✓ Copied: ${email}\n\nNow email them about their Beta access!`);
  }).catch(() => {
    alert("Failed to copy. Email: " + email);
  });
}

// ── Creator Invites Table ─────────────────────────────────────

function renderInviteTable() {
  const wrap = document.getElementById("inviteTable");
  if (!wrap) return;

  // Update count badge
  const countBadge = document.getElementById("inviteCount");
  if (countBadge) {
    countBadge.textContent = creatorInvites.length;
    countBadge.style.display = creatorInvites.length > 0 ? "" : "none";
  }

  if (creatorInvites.length === 0) {
    wrap.innerHTML = '<div class="hc-empty">No creator invites yet.</div>';
    return;
  }

  // Sort by most recent first
  const sorted = [...creatorInvites].sort((a, b) => {
    const aTime = a.invitedAt?.toMillis?.() || 0;
    const bTime = b.invitedAt?.toMillis?.() || 0;
    return bTime - aTime;
  });

  let html = `
    <table class="hc-admin-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Groups Used</th>
          <th>Invited By</th>
          <th>Date</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
  `;

  sorted.forEach((invite) => {
    const invitedDate = invite.invitedAt?.toDate
      ? invite.invitedAt.toDate().toLocaleDateString()
      : "—";

    const quotaText = `${invite.groupsCreated || 0}/${invite.groupsAllowed || 0}`;
    const quotaExhausted = (invite.groupsCreated || 0) >= (invite.groupsAllowed || 0);

    const statusBadge = invite.isActive
      ? `<span style="color:#22c55e;font-weight:600">Active</span>`
      : `<span style="color:#94a3b8;font-weight:600">Inactive</span>`;

    const toggleLabel = invite.isActive ? "Deactivate" : "Activate";
    const increaseBtn = quotaExhausted
      ? `<button class="hc-submit-btn" onclick="increaseCreatorQuota('${escapeHtml(invite.email)}')" style="font-size:0.85rem;padding:4px 10px;margin-left:4px">+ Quota</button>`
      : "";

    html += `
      <tr>
        <td>${escapeHtml(invite.email)}</td>
        <td>
          ${quotaText}
          ${quotaExhausted ? '<span style="color:#22c55e;margin-left:4px">✓</span>' : ""}
        </td>
        <td>${escapeHtml(invite.invitedBy || "—")}</td>
        <td>${invitedDate}</td>
        <td>${statusBadge}</td>
        <td>
          <button class="hc-cancel-btn" onclick="toggleCreatorInvite('${escapeHtml(invite.email)}', ${invite.isActive})" style="font-size:0.85rem;padding:4px 10px">
            ${toggleLabel}
          </button>
          ${increaseBtn}
        </td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// ── Send Creator Invite ───────────────────────────────────────

async function sendCreatorInvite() {
  const emailInput = document.getElementById("inviteEmailInput");
  const quotaInput = document.getElementById("inviteQuotaInput");
  const btn = document.getElementById("sendInviteBtn");
  const errEl = document.getElementById("inviteFormError");
  const successEl = document.getElementById("inviteFormSuccess");

  const email = emailInput.value.trim();
  const quota = parseInt(quotaInput.value) || (betaSettings?.defaultCreatorQuota || 3);

  if (errEl) errEl.style.display = "none";
  if (successEl) successEl.style.display = "none";

  if (!email || !email.includes("@")) {
    if (errEl) {
      errEl.textContent = "Please enter a valid email address.";
      errEl.style.display = "";
    }
    return;
  }

  if (quota < 1 || quota > 100) {
    if (errEl) {
      errEl.textContent = "Quota must be between 1 and 100.";
      errEl.style.display = "";
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }

  try {
    // Check if already exists
    const existing = await db.collection("beta_creator_invites").doc(email).get();
    if (existing.exists) {
      if (errEl) {
        errEl.textContent = `${email} already has a creator invite. Use the Actions menu to modify it.`;
        errEl.style.display = "";
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Send Invite";
      }
      return;
    }

    // Create invite
    await db.collection("beta_creator_invites").doc(email).set({
      email: email,
      invitedBy: currentUser.email,
      invitedAt: firebase.firestore.FieldValue.serverTimestamp(),
      groupsAllowed: quota,
      groupsCreated: 0,
      isActive: true,
      createdGroups: []
    });

    if (successEl) {
      successEl.textContent = `✓ Creator invite sent to ${email} with ${quota} group quota!`;
      successEl.style.display = "";
    }

    emailInput.value = "";
    quotaInput.value = betaSettings?.defaultCreatorQuota || 3;

  } catch (err) {
    console.error("Failed to send creator invite:", err);
    if (errEl) {
      errEl.textContent = "Failed to send invite: " + err.message;
      errEl.style.display = "";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send Invite";
    }
  }
}

// ── Toggle Creator Invite ─────────────────────────────────────

async function toggleCreatorInvite(email, currentlyActive) {
  const action = currentlyActive ? "deactivate" : "activate";
  if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} creator invite for ${email}?`)) return;

  try {
    await db.collection("beta_creator_invites").doc(email).update({
      isActive: !currentlyActive
    });
  } catch (err) {
    alert("Failed to toggle invite: " + err.message);
  }
}

// ── Increase Creator Quota ────────────────────────────────────

async function increaseCreatorQuota(email) {
  const current = creatorInvites.find((inv) => inv.email === email);
  if (!current) return;

  const newQuota = prompt(
    `Current quota for ${email}: ${current.groupsAllowed} groups\n` +
    `Groups created: ${current.groupsCreated}\n\n` +
    `Enter new quota (must be >= ${current.groupsCreated}):`,
    current.groupsAllowed + 3
  );

  if (!newQuota) return;

  const quota = parseInt(newQuota);
  if (isNaN(quota) || quota < current.groupsCreated) {
    alert(`Invalid quota. Must be >= ${current.groupsCreated}`);
    return;
  }

  try {
    await db.collection("beta_creator_invites").doc(email).update({
      groupsAllowed: quota
    });
    alert(`✓ Quota for ${email} updated to ${quota} groups.`);
  } catch (err) {
    alert("Failed to update quota: " + err.message);
  }
}
