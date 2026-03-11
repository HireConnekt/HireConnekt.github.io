/* ============================================================
   HireConnect – hireconnect.js
   All logic for the HireConnect job-networking feature.
   Depends on: firebase-config.js (loaded before this file)
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let currentUser       = null;
let openRequests      = [];      // [{id, jobUrl, company, details, ...}]
let resolvedRequests  = [];      // [{id, ...}]
let expandedRequestId         = null;  // doc ID of expanded open row, or null
let expandedResolvedId        = null;  // doc ID of expanded resolved row, or null
let searchQuery               = "";
let unsubscribeOpen     = null;
let unsubscribeResolved = null;
let hcAdminEmails       = [];    // loaded from hireconnect_config/admins in Firestore
let isHcAdmin           = false; // derived: currentUser.email in hcAdminEmails
let currentRole         = null;  // "seeker" | "connector" | null
let connectorProfile    = null;  // Firestore doc for current connector user
let isConnectorApproved = false; // derived from connectorProfile.approved
let unsubscribeConnectorProfile = null;

// ── Utilities ────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#039;");
}

function safeUrl(url) {
  if (!url) return "#";
  const trimmed = url.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? trimmed
    : "#";
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40
      ? u.pathname.slice(0, 40) + "…"
      : u.pathname;
    return u.hostname + path;
  } catch {
    return url.length > 60 ? url.slice(0, 60) + "…" : url;
  }
}

function showFeedback(msg, type) {
  const el = document.getElementById("submitFeedback");
  if (!el) return;
  el.textContent = msg;
  el.className   = "hc-feedback " + type;
  setTimeout(() => { el.textContent = ""; el.className = "hc-feedback"; }, 5000);
}
const showError   = (msg) => showFeedback(msg, "error");
const showSuccess = (msg) => showFeedback(msg, "success");

// ── Auth ─────────────────────────────────────────────────────

function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch((e) => showError("Login failed: " + e.message));
}

function signOut() {
  auth.signOut().catch((e) => showError("Sign-out failed: " + e.message));
}

// ── Role ─────────────────────────────────────────────────────

function roleKey()  { return `hc_role_${currentUser.uid}`; }
function loadRole() { currentRole = localStorage.getItem(roleKey()) || null; }

function saveRole(role) {
  currentRole = role;
  localStorage.setItem(roleKey(), role);
  document.getElementById("rolePickerModal").style.display = "none";
  if (role === "connector") subscribeConnectorProfile();
  renderAuthBadge();
  renderSubmitArea();
  renderOpenRequests();
  renderResolvedRequests();
  renderCompanySidebar();
}

function switchRole() {
  currentRole = null;
  localStorage.removeItem(roleKey());
  document.getElementById("rolePickerModal").style.display = "flex";
}

function showRolePicker() {
  document.getElementById("rolePickerModal").style.display = "flex";
}

function showConnectorCompanyStep() {
  document.getElementById("roleStep1").style.display = "none";
  document.getElementById("roleStep2").style.display = "";
  const inp = document.getElementById("connectorCompanyInput");
  if (inp) inp.focus();
}

function showRoleStep1() {
  document.getElementById("roleStep2").style.display = "none";
  document.getElementById("roleStep1").style.display = "";
}

async function registerConnector() {
  const inp    = document.getElementById("connectorCompanyInput");
  const errEl  = document.getElementById("connectorRegError");
  const company = inp ? inp.value.trim() : "";

  if (!company) {
    errEl.textContent = "Please enter your company name.";
    errEl.style.display = "";
    return;
  }
  errEl.style.display = "none";

  const btn = document.querySelector("#roleStep2 .hc-submit-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  try {
    await db.collection("hireconnect_connectors").doc(currentUser.uid).set({
      uid:         currentUser.uid,
      email:       currentUser.email || "",
      displayName: currentUser.displayName || "",
      company,
      approved:    false,
      requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });  // merge so re-registering doesn't reset an already-approved status
    saveRole("connector");
  } catch (err) {
    errEl.textContent = "Failed to save: " + err.message;
    errEl.style.display = "";
    if (btn) { btn.disabled = false; btn.textContent = "Continue"; }
  }
}

// ── Connector Profile ─────────────────────────────────────────

function subscribeConnectorProfile() {
  if (unsubscribeConnectorProfile) { unsubscribeConnectorProfile(); unsubscribeConnectorProfile = null; }
  if (!currentUser || currentRole !== "connector") return;

  unsubscribeConnectorProfile = db
    .collection("hireconnect_connectors")
    .doc(currentUser.uid)
    .onSnapshot((snap) => {
      if (snap.exists) {
        connectorProfile    = snap.data();
        isConnectorApproved = connectorProfile.approved === true;

        // Pre-filter by connector's company on first approved load
        if (isConnectorApproved && connectorProfile.company) {
          const box = document.getElementById("searchBox");
          if (box && !box.value && !searchQuery) {
            box.value   = connectorProfile.company;
            searchQuery = connectorProfile.company;
          }
        }
      } else {
        connectorProfile    = null;
        isConnectorApproved = false;
      }
      renderAuthBadge();
      renderSubmitArea();
      renderOpenRequests();
      renderResolvedRequests();
    }, () => {});
}

function renderAuthBadge() {
  const area = document.getElementById("authArea");
  if (!area) return;

  if (currentUser) {
    const name = escapeHtml(currentUser.displayName || currentUser.email || "User");
    const roleBadge = currentRole
      ? `<span class="hc-role-badge hc-role-badge--${currentRole}">
           ${currentRole === "seeker" ? "🎯 Seeker" : "🤝 Connector"}
         </span>
         <button class="hc-role-switch-btn" onclick="switchRole()">Switch</button>`
      : "";
    const adminLink = isHcAdmin
      ? `<a href="admin.html" class="hc-admin-link">⚙ Admin</a>`
      : "";
    area.innerHTML = `
      ${roleBadge}
      ${adminLink}
      <span class="hc-auth-name" title="${name}">${name}</span>
      <button class="hc-signout-btn" onclick="signOut()">Sign Out</button>
    `;
  } else {
    area.innerHTML = `
      <button class="hc-signin-btn" onclick="signIn()">Sign in</button>
    `;
  }
}

// ── Firestore Subscriptions ───────────────────────────────────

function subscribeOpen() {
  if (unsubscribeOpen) unsubscribeOpen();

  unsubscribeOpen = db
    .collection("hireconnect_requests")
    .where("status", "==", "open")
    .orderBy("submittedAt", "desc")
    .onSnapshot(
      (snap) => {
        openRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderOpenRequests();
        renderCompanySidebar();
      },
      (err) => {
        console.error("HireConnect open listener error:", err);
        // If index missing, Firestore logs a URL to create it in the console.
        document.getElementById("openRequestsList").innerHTML =
          `<div class="hc-empty">Error loading requests. Check console.</div>`;
      }
    );
}

function subscribeResolved() {
  if (unsubscribeResolved) unsubscribeResolved();

  unsubscribeResolved = db
    .collection("hireconnect_requests")
    .where("status", "==", "resolved")
    .orderBy("resolvedAt", "desc")
    .limit(50)
    .onSnapshot(
      (snap) => {
        resolvedRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderResolvedRequests();
      },
      (err) => {
        console.error("HireConnect resolved listener error:", err);
      }
    );
}

// ── Admin Config ─────────────────────────────────────────────

function subscribeAdminConfig() {
  db.collection("hireconnect_config").doc("admins").onSnapshot(
    (snap) => {
      hcAdminEmails = snap.exists ? (snap.data().emails || []) : [];
      const email   = currentUser ? (currentUser.email || "").toLowerCase() : "";
      isHcAdmin     = email && hcAdminEmails.map(e => e.toLowerCase()).includes(email);
      // Re-render lists so delete buttons appear/disappear live
      renderOpenRequests();
      renderResolvedRequests();
    },
    () => { /* silent — no admin doc is valid state */ }
  );
}

function updateAdminStatus() {
  const email = currentUser ? (currentUser.email || "").toLowerCase() : "";
  isHcAdmin   = email && hcAdminEmails.map(e => e.toLowerCase()).includes(email);
}

async function deleteRequest(id) {
  if (!isHcAdmin) return;
  if (!confirm("Delete this posting? This cannot be undone.")) return;
  try {
    await db.collection("hireconnect_requests").doc(id).delete();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

// ── Submit Area Render ────────────────────────────────────────

function renderSubmitArea() {
  const area = document.getElementById("submitFormArea");
  if (!area) return;

  if (!currentUser) {
    area.innerHTML = `
      <div class="hc-submit-signin-prompt">
        <span class="hc-submit-signin-icon">🔒</span>
        <div>
          <strong>Sign in to post a connection request</strong>
          <p>You can choose to submit anonymously — your identity stays private.</p>
        </div>
        <button class="hc-signin-btn" onclick="signIn()">Sign in with Google</button>
      </div>`;
    return;
  }

  if (currentRole === "connector") {
    const approvedMsg = isConnectorApproved
      ? "Browse open requests below and click <strong>Help →</strong> to provide hiring manager info."
      : "Your account is <strong>pending admin approval</strong>. You'll be able to help once approved.";
    area.innerHTML = `
      <div class="hc-submit-signin-prompt">
        <span class="hc-submit-signin-icon">🤝</span>
        <div>
          <strong>You're signed in as a Connector${connectorProfile ? " — " + escapeHtml(connectorProfile.company) : ""}</strong>
          <p>${approvedMsg}</p>
        </div>
      </div>`;
    return;
  }

  area.innerHTML = `
    <p class="hc-submit-label">📌 Post a Connection Request</p>
    <div class="hc-submit-row">
      <input
        id="jobUrlInput"
        type="url"
        class="hc-input hc-url-input"
        placeholder="Paste LinkedIn or job posting URL"
        autocomplete="off"
      />
      <input
        id="companyInput"
        type="text"
        class="hc-input hc-company-input"
        placeholder="Company name"
        autocomplete="off"
      />
      <input
        id="detailsInput"
        type="text"
        class="hc-input hc-details-input"
        placeholder="Additional details (optional)"
        autocomplete="off"
      />
      <div class="hc-submit-actions">
        <label class="hc-anon-label">
          <input type="checkbox" id="submitAnonCheck" class="hc-anon-checkbox" />
          Submit anonymously
        </label>
        <button id="submitBtn" class="hc-submit-btn" onclick="submitRequest()">
          Request Help
        </button>
      </div>
    </div>
    <div id="submitFeedback" class="hc-feedback" aria-live="polite"></div>`;
}

// ── Submit ────────────────────────────────────────────────────

async function submitRequest() {
  if (!currentUser) return showError("Please sign in to submit a request.");

  const jobUrlEl   = document.getElementById("jobUrlInput");
  const companyEl  = document.getElementById("companyInput");
  const detailsEl  = document.getElementById("detailsInput");
  const anonEl     = document.getElementById("submitAnonCheck");
  const btn        = document.getElementById("submitBtn");

  const jobUrl       = jobUrlEl.value.trim();
  const company      = companyEl.value.trim();
  const details      = detailsEl.value.trim();
  const stayAnonymous = anonEl ? anonEl.checked : false;

  if (!jobUrl)   return showError("Please enter a job posting URL.");
  if (!jobUrl.startsWith("http://") && !jobUrl.startsWith("https://")) {
    return showError("Please enter a valid URL starting with http:// or https://");
  }
  if (!company) return showError("Please enter a company name.");

  btn.disabled    = true;
  btn.textContent = "Submitting…";

  try {
    await db.collection("hireconnect_requests").add({
      jobUrl,
      company,
      details,
      status:          "open",
      submittedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      submittedBy:     stayAnonymous ? "" : (currentUser.displayName || currentUser.email || ""),
      submittedByUid:  currentUser.uid,   // always stored so Seekers can see their own tickets
    });
    jobUrlEl.value  = "";
    companyEl.value = "";
    detailsEl.value = "";
    if (anonEl) anonEl.checked = false;
    showSuccess("Request submitted! The community will help you shortly.");
  } catch (err) {
    showError("Failed to submit: " + err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Request Help";
  }
}

// ── Expand / Collapse ─────────────────────────────────────────

function toggleExpand(id) {
  expandedRequestId = (expandedRequestId === id) ? null : id;
  renderOpenRequests();
}

function toggleExpandResolved(id) {
  expandedResolvedId = (expandedResolvedId === id) ? null : id;
  renderResolvedRequests();
}

// ── Resolve ──────────────────────────────────────────────────

async function resolveRequest(reqId) {
  if (!currentUser) return showError("Please sign in to resolve a request.");

  const hmInput      = document.getElementById("hm_" + reqId);
  const notesInput   = document.getElementById("notes_" + reqId);
  const referralEl   = document.querySelector(`input[name="ref_${reqId}"]:checked`);
  const anonEl       = document.getElementById("anon_" + reqId);

  const hiringManager   = hmInput    ? hmInput.value.trim()    : "";
  const resolverNotes   = notesInput ? notesInput.value.trim() : "";
  const referralIntent  = referralEl ? referralEl.value        : "no";
  const stayAnonymous   = anonEl     ? anonEl.checked          : false;

  if (!hiringManager) {
    return showError("Please provide hiring manager info before resolving.");
  }

  const btn = document.getElementById("resolveBtn_" + reqId);
  if (btn) { btn.disabled = true; btn.textContent = "Resolving…"; }

  try {
    await db.collection("hireconnect_requests").doc(reqId).update({
      status:         "resolved",
      resolvedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      resolvedBy:     stayAnonymous ? "" : (currentUser.displayName || currentUser.email || "Community Member"),
      resolvedByUid:  currentUser.uid,
      hiringManager,
      referralIntent,
      resolverNotes,
    });
    expandedRequestId = null;
    // Firestore listeners automatically move the item to the resolved section
  } catch (err) {
    showError("Failed to resolve: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Mark as Resolved"; }
  }
}

// ── Render: expanded panel ────────────────────────────────────

function buildExpandedPanel(req) {
  if (currentRole === "connector" && !isConnectorApproved) {
    return `
      <div class="hc-expanded-panel">
        <div class="hc-auth-prompt">
          ⏳ Your Connector account is pending admin approval. You'll be able to help once approved.
        </div>
      </div>`;
  }

  if (!currentUser) {
    return `
      <div class="hc-expanded-panel">
        <div class="hc-auth-prompt">
          Sign in with Google to provide hiring manager info and help this person.
          <button class="hc-signin-btn" onclick="signIn()">Sign In with Google</button>
        </div>
      </div>`;
  }

  const id = req.id;
  return `
    <div class="hc-expanded-panel">
      <div class="hc-expanded-header">Help with this request</div>

      <div class="hc-form-group">
        <label for="hm_${id}">Hiring Manager Info</label>
        <input
          type="text"
          id="hm_${id}"
          class="hc-input"
          style="width:100%"
          placeholder="Name, LinkedIn profile URL, email, etc."
          autocomplete="off"
        />
      </div>

      <div class="hc-form-group">
        <label>Referral Intent</label>
        <div class="hc-radio-group">
          <label><input type="radio" name="ref_${id}" value="yes" /> Yes, I can refer</label>
          <label><input type="radio" name="ref_${id}" value="maybe" checked /> Maybe</label>
          <label><input type="radio" name="ref_${id}" value="no" /> Info only</label>
        </div>
      </div>

      <div class="hc-form-group">
        <label for="notes_${id}">
          Additional Notes <span class="hc-optional">(optional)</span>
        </label>
        <textarea
          id="notes_${id}"
          class="hc-textarea"
          rows="2"
          placeholder="Any extra context that might help…"
        ></textarea>
      </div>

      <div class="hc-form-actions">
        <label class="hc-anon-label">
          <input type="checkbox" id="anon_${id}" class="hc-anon-checkbox" />
          Stay anonymous
        </label>
        <button class="hc-cancel-btn" onclick="toggleExpand(null)">Cancel</button>
        <button
          id="resolveBtn_${id}"
          class="hc-resolve-btn"
          onclick="resolveRequest('${id}')"
        >Mark as Resolved</button>
      </div>
    </div>`;
}

// ── Render: one open request row ──────────────────────────────

function buildRequestRow(req) {
  const isExpanded = expandedRequestId === req.id;
  const safe       = safeUrl(req.jobUrl);
  const label      = escapeHtml(truncateUrl(req.jobUrl));
  const company    = escapeHtml(req.company || "");
  const details    = escapeHtml(req.details || "");
  const id         = req.id;

  const article = document.createElement("article");
  article.className = "hc-request-row" + (isExpanded ? " expanded" : "");
  article.dataset.id = id;

  article.innerHTML = `
    <div class="hc-request-summary" onclick="toggleExpand('${id}')">
      <button class="hc-chevron-btn" aria-expanded="${isExpanded}" aria-label="Expand request">
        <span class="hc-chevron-icon">&#9658;</span>
      </button>
      <div class="hc-request-info">
        <a
          class="hc-job-url"
          href="${safe}"
          target="_blank"
          rel="noopener noreferrer"
          onclick="event.stopPropagation()"
          title="${escapeHtml(req.jobUrl)}"
        >${label}</a>
        ${company ? `<span class="hc-company-badge">${company}</span>` : ""}
        ${details ? `<span class="hc-details-preview">${details}</span>` : ""}
      </div>
      ${currentRole === "connector" && !isConnectorApproved
        ? `<span class="hc-pending-badge">⏳ Pending Approval</span>`
        : currentRole !== "seeker"
          ? `<button class="hc-open-btn" onclick="event.stopPropagation(); toggleExpand('${id}')">${isExpanded ? "Close" : "Help →"}</button>`
          : ""}
      ${isHcAdmin ? `<button class="hc-delete-btn" title="Delete posting" onclick="event.stopPropagation(); deleteRequest('${id}')">🗑</button>` : ""}
    </div>
    ${isExpanded ? buildExpandedPanel(req) : ""}
  `;

  return article;
}

// ── Render: open requests list ────────────────────────────────

function renderOpenRequests() {
  const list = document.getElementById("openRequestsList");
  if (!list) return;

  // Update panel title based on role
  const titleEl = document.getElementById("openPanelTitle");
  if (titleEl) {
    // Replace text node content, preserving the count badge span child
    const badge = titleEl.querySelector("#openPanelCount");
    titleEl.textContent = currentRole === "seeker" ? "My Open Requests " : "Open Postings ";
    if (badge) titleEl.appendChild(badge);
  }

  // Apply role filter first, then search filter
  let source = openRequests;
  if (currentRole === "seeker" && currentUser) {
    source = source.filter((r) => r.submittedByUid === currentUser.uid);
  }

  const q        = searchQuery.toLowerCase();
  const filtered = q
    ? source.filter(
        (r) =>
          (r.company || "").toLowerCase().includes(q) ||
          (r.jobUrl  || "").toLowerCase().includes(q) ||
          (r.details || "").toLowerCase().includes(q)
      )
    : source;

  // Update count badge
  const countEl = document.getElementById("openPanelCount");
  if (countEl) {
    countEl.textContent = filtered.length;
    countEl.style.display = filtered.length > 0 ? "" : "none";
  }

  const emptyMsg = currentRole === "seeker"
    ? "📭 You haven't submitted any requests yet."
    : (q ? `🔍 No results for "${escapeHtml(q)}".` : "🔍 No open requests yet. Be the first to ask for help!");

  if (filtered.length === 0) {
    list.innerHTML = `<div class="hc-empty">${q && currentRole !== "seeker" ? `🔍 No results for "${escapeHtml(q)}".` : emptyMsg}</div>`;
    return;
  }

  list.innerHTML = "";
  filtered.forEach((req) => list.appendChild(buildRequestRow(req)));
}

// ── Render: company sidebar ───────────────────────────────────

function renderCompanySidebar() {
  const sidebar = document.getElementById("companySidebar");
  if (!sidebar) return;

  const base = (currentRole === "seeker" && currentUser)
    ? openRequests.filter((r) => r.submittedByUid === currentUser.uid)
    : openRequests;
  const companies = [...new Set(base.map((r) => r.company).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );

  // Update sidebar count badge
  const countEl = document.getElementById("sidebarCount");
  if (countEl) {
    countEl.textContent = companies.length;
    countEl.style.display = companies.length > 0 ? "" : "none";
  }

  if (companies.length === 0) {
    sidebar.innerHTML = `<div class="hc-empty" style="padding:8px 0;font-size:12px">No open requests yet</div>`;
    return;
  }

  sidebar.innerHTML = companies
    .map(
      (c) =>
        `<div class="hc-company-item" onclick="filterByCompany('${escapeHtml(c).replace(/'/g, "\\'")}')">
          ${escapeHtml(c)}
        </div>`
    )
    .join("");
}

function filterByCompany(company) {
  const box = document.getElementById("searchBox");
  if (box) box.value = company;
  searchQuery = company;
  renderOpenRequests();
}

// ── Render: resolved detail panel ────────────────────────────

function buildResolvedDetail(req) {
  const hm       = escapeHtml(req.hiringManager  || "");
  const notes    = escapeHtml(req.resolverNotes  || "");
  const referral = req.referralIntent || "no";
  const by       = escapeHtml(req.resolvedBy     || "Anonymous");

  const referralLabel = { yes: "Yes, willing to refer", maybe: "Maybe", no: "Info only" }[referral] || referral;
  const referralColor = { yes: "var(--p0)", maybe: "var(--p1)", no: "var(--muted)" }[referral] || "var(--muted)";

  return `
    <div class="hc-resolved-detail">
      <div class="hc-detail-row">
        <span class="hc-detail-label">Hiring Manager Info</span>
        <span class="hc-detail-value">${hm || "<em>Not provided</em>"}</span>
      </div>
      <div class="hc-detail-row">
        <span class="hc-detail-label">Referral Intent</span>
        <span class="hc-detail-value" style="color:${referralColor};font-weight:600">${referralLabel}</span>
      </div>
      ${notes ? `
      <div class="hc-detail-row">
        <span class="hc-detail-label">Notes</span>
        <span class="hc-detail-value">${notes}</span>
      </div>` : ""}
    </div>`;
}

// ── Render: resolved section ──────────────────────────────────

function renderResolvedRequests() {
  const list = document.getElementById("resolvedList");
  if (!list) return;

  // Apply role filter
  const source = (currentRole === "seeker" && currentUser)
    ? resolvedRequests.filter((r) => r.submittedByUid === currentUser.uid)
    : resolvedRequests;

  // Update resolved count badge
  const countEl = document.getElementById("resolvedCount");
  if (countEl) {
    countEl.textContent = source.length;
    countEl.style.display = source.length > 0 ? "" : "none";
  }

  const emptyMsg = currentRole === "seeker"
    ? "✨ None of your requests are resolved yet."
    : "✨ No resolved requests yet.";

  if (source.length === 0) {
    list.innerHTML = `<div class="hc-empty">${emptyMsg}</div>`;
    return;
  }

  list.innerHTML = "";
  source.forEach((req) => {
    const isExpanded = expandedResolvedId === req.id;
    const safe       = safeUrl(req.jobUrl);
    const label      = escapeHtml(truncateUrl(req.jobUrl));
    const company    = escapeHtml(req.company || "");
    const details    = escapeHtml(req.details  || "");
    const thanks     = req.resolvedBy
      ? "Thanks " + escapeHtml(req.resolvedBy) + "!"
      : "Thanks Anonymous!";
    const id = req.id;

    const article = document.createElement("article");
    article.className = "hc-request-row hc-resolved-item" + (isExpanded ? " expanded" : "");
    article.dataset.id = id;

    article.innerHTML = `
      <div class="hc-request-summary" onclick="toggleExpandResolved('${id}')">
        <button class="hc-chevron-btn" aria-expanded="${isExpanded}" aria-label="Expand resolved request">
          <span class="hc-chevron-icon">&#9658;</span>
        </button>
        <div class="hc-request-info">
          <a
            class="hc-job-url"
            href="${safe}"
            target="_blank"
            rel="noopener noreferrer"
            onclick="event.stopPropagation()"
            title="${escapeHtml(req.jobUrl)}"
          >${label}</a>
          ${company ? `<span class="hc-company-badge">${company}</span>` : ""}
          ${details ? `<span class="hc-details-preview">${details}</span>` : ""}
        </div>
        <span class="hc-thanks-badge">${thanks}</span>
        ${isHcAdmin ? `<button class="hc-delete-btn" title="Delete posting" onclick="event.stopPropagation(); deleteRequest('${id}')">🗑</button>` : ""}
      </div>
      ${isExpanded ? buildResolvedDetail(req) : ""}
    `;

    list.appendChild(article);
  });
}

// ── Search ────────────────────────────────────────────────────

function onSearch(value) {
  searchQuery = value.trim();
  renderOpenRequests();
}

// ── Init ──────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Start real-time listeners (reads are public, no auth required)
  subscribeOpen();
  subscribeResolved();
  subscribeAdminConfig();

  // Auth observer
  auth.onAuthStateChanged((user) => {
    currentUser = user;
    updateAdminStatus();
    if (user) {
      loadRole();
      if (!currentRole) {
        showRolePicker();
      } else if (currentRole === "connector") {
        subscribeConnectorProfile();
      }
    } else {
      currentRole         = null;
      connectorProfile    = null;
      isConnectorApproved = false;
      if (unsubscribeConnectorProfile) {
        unsubscribeConnectorProfile();
        unsubscribeConnectorProfile = null;
      }
    }
    renderAuthBadge();
    renderSubmitArea();
    // Re-render lists to show/hide delete buttons, role filters, and auth-gated panels
    renderOpenRequests();
    renderResolvedRequests();
    renderCompanySidebar();
  });
});
