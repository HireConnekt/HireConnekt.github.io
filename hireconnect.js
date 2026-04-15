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
let resolvedSearchQuery       = "";
let unsubscribeOpen     = null;
let unsubscribeResolved = null;
let hcAdminEmails       = [];    // loaded from hireconnect_config/admins in Firestore
let isHcAdmin           = false; // derived: currentUser.email in hcAdminEmails
let currentRole         = null;  // "seeker" | "connector" | null
let connectorProfile    = null;  // Firestore doc for current connector user
let isConnectorApproved = false; // derived from connectorProfile.approved
let unsubscribeConnectorProfile = null;
let connectorCompanies = [];     // unique approved connector company names

// ── Group State ───────────────────────────────────────────────
let currentGroupId      = null;   // Firestore doc ID of the active group
let currentGroupProfile = null;   // { id, name, inviteCode, isActive, ... }
let userGroups          = [];     // [{ groupId, name, role, membershipId }]
let isGroupAdmin        = false;  // current user has role="admin" in currentGroup
let unsubscribeGroupProfile  = null;
let unsubscribeMemberships   = null;

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

function fmtDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
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

// ── Group Utilities ───────────────────────────────────────────

function randomCode(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ── Group: memberships real-time listener ─────────────────────

function subscribeMemberships() {
  if (unsubscribeMemberships) { unsubscribeMemberships(); unsubscribeMemberships = null; }
  if (!currentUser) return;

  unsubscribeMemberships = db.collection("hireconnect_memberships")
    .where("uid", "==", currentUser.uid)
    .onSnapshot(async (snap) => {
      userGroups = snap.docs.map((d) => ({ membershipId: d.id, ...d.data() }));

      // Update group admin status for currently-selected group
      isGroupAdmin = currentGroupId
        ? userGroups.some((g) => g.groupId === currentGroupId && g.role === "admin")
        : false;

      if (userGroups.length === 0) {
        // No groups — show onboarding unless user just created one (currentGroupId set)
        if (!currentGroupId) showOnboarding();
      } else if (!currentGroupId) {
        // First load: auto-select saved group or the only group
        const savedId = localStorage.getItem(groupKey());
        const valid   = userGroups.find((g) => g.groupId === savedId);
        if (valid) {
          await selectGroup(savedId);
        } else if (userGroups.length === 1) {
          await selectGroup(userGroups[0].groupId);
        } else {
          showGroupSwitcher();
        }
      }
      renderGroupArea();
      renderAuthBadge();
    }, () => {});
}

// ── Group: subscribe to group profile ────────────────────────

function subscribeGroupProfile(groupId) {
  if (unsubscribeGroupProfile) { unsubscribeGroupProfile(); unsubscribeGroupProfile = null; }
  if (!groupId) return;

  unsubscribeGroupProfile = db.collection("hireconnect_groups").doc(groupId)
    .onSnapshot((snap) => {
      if (snap.exists) {
        currentGroupProfile = { id: snap.id, ...snap.data() };
      } else {
        currentGroupProfile = null;
      }
      renderGroupArea();
    }, () => {});
}

// ── Group: select active group ────────────────────────────────

async function selectGroup(groupId) {
  currentGroupId = groupId;
  if (groupKey()) localStorage.setItem(groupKey(), groupId);
  isGroupAdmin = userGroups.some((g) => g.groupId === groupId && g.role === "admin");

  subscribeGroupProfile(groupId);
  subscribeOpen();
  subscribeResolved();

  loadRole();
  if (!currentRole) {
    showRolePicker();
  } else if (currentRole === "connector") {
    subscribeConnectorProfile();
    loadConnectorCompanies();
  } else if (currentRole === "seeker") {
    loadConnectorCompanies();
  }

  updatePageVisibility();
  renderGroupArea();
  renderAuthBadge();
  renderSubmitArea();
  renderOpenRequests();
  renderResolvedRequests();
  renderCompanySidebar();
  updateHeroCards();
}

// ── Group: create a new group ─────────────────────────────────

async function createGroup(name, description) {
  if (!currentUser) return null;
  name = (name || "").trim();
  if (!name) return null;

  const inviteCode = randomCode(10);
  const groupRef = await db.collection("hireconnect_groups").add({
    name,
    description:  (description || "").trim(),
    createdBy:    currentUser.uid,
    createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
    inviteCode,
    isActive:     true,
    memberCount:  1,
    requestCount: 0,
    resolvedCount: 0,
  });

  // Creator becomes the first admin member
  await db.collection("hireconnect_memberships")
    .doc(`${currentUser.uid}_${groupRef.id}`)
    .set({
      uid:        currentUser.uid,
      groupId:    groupRef.id,
      groupName:  name,
      role:       "admin",
      joinedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      joinMethod: "created",
    });

  return groupRef.id;
}

// ── Group: join via invite code ───────────────────────────────

async function processInviteCode(code) {
  if (!code || !currentUser) return;
  try {
    const snap = await db.collection("hireconnect_groups")
      .where("inviteCode", "==", code)
      .where("isActive", "==", true)
      .limit(1)
      .get();

    if (snap.empty) {
      showInviteError("This invite link is not valid or has been deactivated.");
      return;
    }

    const groupDoc   = snap.docs[0];
    const groupId    = groupDoc.id;
    const groupData  = groupDoc.data();
    const memberDocId = `${currentUser.uid}_${groupId}`;

    // Check if already a member
    const existing = await db.collection("hireconnect_memberships").doc(memberDocId).get();
    if (!existing.exists) {
      await db.collection("hireconnect_memberships").doc(memberDocId).set({
        uid:        currentUser.uid,
        groupId,
        groupName:  groupData.name,
        role:       "member",
        joinedAt:   firebase.firestore.FieldValue.serverTimestamp(),
        joinMethod: "invite",
      });
      // Increment member count
      db.collection("hireconnect_groups").doc(groupId).update({
        memberCount: firebase.firestore.FieldValue.increment(1),
      });
    }
    // Clear the invite code from the URL without reloading
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
  } catch (e) {
    console.error("Failed to process invite:", e);
  }
}

function showInviteError(msg) {
  const el = document.getElementById("inviteErrorBanner");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "";
  setTimeout(() => { el.style.display = "none"; }, 6000);
}

// ── Group: regenerate invite code ─────────────────────────────

async function regenerateInviteCode() {
  if (!currentGroupId || !isGroupAdmin) return;
  const newCode = randomCode(10);
  try {
    await db.collection("hireconnect_groups").doc(currentGroupId).update({ inviteCode: newCode });
    // currentGroupProfile updates via onSnapshot; re-render settings
    renderGroupSettingsGeneral();
  } catch (e) {
    alert("Failed to regenerate invite code: " + e.message);
  }
}

// ── Group: admin management ───────────────────────────────────

async function setMemberRole(uid, groupId, newRole) {
  if (!isGroupAdmin && !isHcAdmin) return;
  const memberDocId = `${uid}_${groupId}`;
  try {
    await db.collection("hireconnect_memberships").doc(memberDocId).update({ role: newRole });
    renderGroupMembersTab();
  } catch (e) {
    alert("Failed to update role: " + e.message);
  }
}

// ── Group: connector approval (group admin) ───────────────────

async function approveConnectorForGroup(docId, currentApproved) {
  if (!isGroupAdmin && !isHcAdmin) return;
  try {
    await db.collection("hireconnect_connectors").doc(docId).update({ approved: !currentApproved });
  } catch (e) {
    alert("Failed to update connector: " + e.message);
  }
}

// ── Group: render group area (title-group community label) ────

function renderGroupArea() {
  const labelEl = document.getElementById("groupNameLabel");
  const adminBtnEl = document.getElementById("groupAdminBtn");
  if (!labelEl) return;

  if (!currentUser) {
    labelEl.textContent = "";
    if (adminBtnEl) adminBtnEl.style.display = "none";
    return;
  }

  if (currentGroupProfile) {
    labelEl.textContent = currentGroupProfile.name;
    labelEl.style.cursor = userGroups.length > 1 ? "pointer" : "default";
    labelEl.onclick = userGroups.length > 1 ? showGroupSwitcher : null;
  } else if (userGroups.length === 0) {
    labelEl.textContent = "No group selected";
  } else {
    labelEl.textContent = "Loading…";
  }

  if (adminBtnEl) {
    if (isGroupAdmin && currentGroupId) {
      adminBtnEl.style.display = "";
      // Show pending connector count
      if (currentGroupId) {
        db.collection("hireconnect_connectors")
          .where("groupId", "==", currentGroupId)
          .where("approved", "==", false)
          .get()
          .then((snap) => {
            const count = snap.size;
            adminBtnEl.textContent = count > 0
              ? `⚙ Manage Group (${count} pending)`
              : "⚙ Manage Group";
          })
          .catch(() => { adminBtnEl.textContent = "⚙ Manage Group"; });
      }
    } else {
      adminBtnEl.style.display = "none";
    }
  }
}

// ── Auth ─────────────────────────────────────────────────────

function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch((e) => showError("Login failed: " + e.message));
}

function signOut() {
  // Clean up group state before signing out
  if (unsubscribeMemberships)        { unsubscribeMemberships();        unsubscribeMemberships        = null; }
  if (unsubscribeGroupProfile)       { unsubscribeGroupProfile();       unsubscribeGroupProfile       = null; }
  if (unsubscribeConnectorProfile)   { unsubscribeConnectorProfile();   unsubscribeConnectorProfile   = null; }
  if (unsubscribeOpen)               { unsubscribeOpen();               unsubscribeOpen               = null; }
  if (unsubscribeResolved)           { unsubscribeResolved();           unsubscribeResolved           = null; }
  currentGroupId      = null;
  currentGroupProfile = null;
  userGroups          = [];
  isGroupAdmin        = false;
  auth.signOut().catch((e) => showError("Sign-out failed: " + e.message));
}

// ── Role ─────────────────────────────────────────────────────

function roleKey()  {
  if (!currentUser) return null;
  return currentGroupId
    ? `hc_role_${currentUser.uid}_${currentGroupId}`
    : `hc_role_${currentUser.uid}`;
}
function groupKey() { return currentUser ? `hc_group_${currentUser.uid}` : null; }
function loadRole() {
  const key = roleKey();
  currentRole = key ? (localStorage.getItem(key) || null) : null;
}

function saveRole(role) {
  currentRole = role;
  localStorage.setItem(roleKey(), role);
  document.getElementById("rolePickerModal").style.display = "none";
  if (role === "connector") subscribeConnectorProfile();
  if (role === "seeker") loadConnectorCompanies();
  renderAuthBadge();
  renderSubmitArea();
  renderOpenRequests();
  renderResolvedRequests();
  renderCompanySidebar();
  updateHeroCards();
}

function switchRole() {
  currentRole = null;
  localStorage.removeItem(roleKey());
  document.getElementById("rolePickerModal").style.display = "flex";
}

function switchToRole(role) {
  if (!currentUser) { signIn(); return; }
  if (currentRole === role) return;
  if (role === "seeker") {
    saveRole("seeker");
  } else if (role === "connector") {
    currentRole = null;
    localStorage.removeItem(roleKey());
    document.getElementById("rolePickerModal").style.display = "flex";
    // Reset to step 1 so showConnectorCompanyStep is triggered via the modal's connector button
    document.getElementById("roleStep1").style.display = "";
    document.getElementById("roleStep2").style.display = "none";
    // Auto-advance into connector flow
    showConnectorCompanyStep();
  }
  updateHeroCards();
}

function updatePageVisibility() {
  const loggedIn = !!currentUser;
  document.getElementById("heroLoggedOut").style.display   = loggedIn ? "none" : "";
  document.getElementById("heroLoggedIn").style.display    = loggedIn ? ""     : "none";
  document.getElementById("hcSubmitBar").style.display     = loggedIn ? ""     : "none";
  document.getElementById("hcMainContent").style.display   = loggedIn ? ""     : "none";
  document.getElementById("hcResolvedSection").style.display = loggedIn ? ""   : "none";
}

function updateHeroCards() {
  const seekerCard     = document.getElementById("heroCardSeeker");
  const connectorCard  = document.getElementById("heroCardConnector");
  const seekerBadge    = document.getElementById("heroCardSeekerBadge");
  const connectorBadge = document.getElementById("heroCardConnectorBadge");
  if (!seekerCard) return;

  seekerCard.classList.toggle("hc-hero-card--active-role",    currentRole === "seeker");
  connectorCard.classList.toggle("hc-hero-card--active-role", currentRole === "connector");

  if (currentRole === "seeker") {
    seekerBadge.textContent    = "✓ Your current role";
    connectorBadge.textContent = "Switch to Connector →";
  } else if (currentRole === "connector") {
    seekerBadge.textContent    = "Switch to Seeker →";
    connectorBadge.textContent = "✓ Your current role";
  } else {
    seekerBadge.textContent    = "Get started as a Seeker →";
    connectorBadge.textContent = "Get started as a Connector →";
  }
}

function showRolePicker() {
  document.getElementById("rolePickerModal").style.display = "flex";
}

function showConnectorCompanyStep() {
  // If connector already has a company on file, skip the form and go straight in
  if (connectorProfile && connectorProfile.company) {
    saveRole("connector");
    return;
  }

  // Check Firestore in case connectorProfile hasn't loaded yet
  if (currentUser && currentGroupId) {
    const docId = `${currentUser.uid}_${currentGroupId}`;
    db.collection("hireconnect_connectors").doc(docId).get().then((snap) => {
      if (snap.exists && snap.data().company) {
        connectorProfile    = snap.data();
        isConnectorApproved = connectorProfile.approved === true;
        saveRole("connector");
      } else {
        document.getElementById("roleStep1").style.display = "none";
        document.getElementById("roleStep2").style.display = "";
        const inp = document.getElementById("connectorCompanyInput");
        if (inp) inp.focus();
      }
    }).catch(() => {
      document.getElementById("roleStep1").style.display = "none";
      document.getElementById("roleStep2").style.display = "";
    });
    return;
  }

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
  const inp       = document.getElementById("connectorCompanyInput");
  const liInp     = document.getElementById("connectorLinkedinInput");
  const errEl     = document.getElementById("connectorRegError");
  const company   = inp   ? inp.value.trim()   : "";
  const linkedinUrl = liInp ? liInp.value.trim() : "";

  if (!company) {
    errEl.textContent = "Please enter your company name.";
    errEl.style.display = "";
    return;
  }
  errEl.style.display = "none";

  const btn = document.querySelector("#roleStep2 .hc-submit-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  if (!currentGroupId) {
    errEl.textContent = "No group selected. Please join or create a group first.";
    errEl.style.display = "";
    if (btn) { btn.disabled = false; btn.textContent = "Continue"; }
    return;
  }

  try {
    const docId = `${currentUser.uid}_${currentGroupId}`;
    await db.collection("hireconnect_connectors").doc(docId).set({
      uid:         currentUser.uid,
      groupId:     currentGroupId,
      email:       currentUser.email || "",
      displayName: currentUser.displayName || "",
      company,
      linkedinUrl,
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

function showConnectorCompanyEdit() {
  const area = document.getElementById("submitFormArea");
  if (!area) return;
  const current = connectorProfile ? (connectorProfile.company || "") : "";
  area.innerHTML = `
    <div class="hc-submit-signin-prompt">
      <span class="hc-submit-signin-icon">🏢</span>
      <div style="flex:1">
        <strong>Update your company</strong>
        <div class="hc-connector-company-form" style="margin-top:8px">
          <input
            id="updateCompanyInput"
            type="text"
            class="hc-input"
            value="${escapeHtml(current)}"
            placeholder="e.g. Google, Microsoft, Infosys…"
            autocomplete="organization"
          />
          <div class="hc-connector-company-actions">
            <button class="hc-cancel-btn" onclick="renderSubmitArea()">Cancel</button>
            <button class="hc-submit-btn" onclick="updateConnectorCompany()">Save</button>
          </div>
          <div id="updateCompanyError" class="hc-feedback" style="display:none"></div>
        </div>
      </div>
    </div>`;
  const inp = document.getElementById("updateCompanyInput");
  if (inp) inp.focus();
}

async function updateConnectorCompany() {
  const inp   = document.getElementById("updateCompanyInput");
  const errEl = document.getElementById("updateCompanyError");
  const company = inp ? inp.value.trim() : "";

  if (!company) {
    errEl.textContent = "Please enter your company name.";
    errEl.style.display = "";
    return;
  }
  errEl.style.display = "none";

  const btn = document.querySelector("#submitFormArea .hc-submit-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  try {
    const docId = `${currentUser.uid}_${currentGroupId}`;
    await db.collection("hireconnect_connectors").doc(docId).update({ company });
    // onSnapshot will update connectorProfile; just restore the view
    renderSubmitArea();
  } catch (err) {
    errEl.textContent = "Failed to save: " + err.message;
    errEl.style.display = "";
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

// ── Connector Profile ─────────────────────────────────────────

function subscribeConnectorProfile() {
  if (unsubscribeConnectorProfile) { unsubscribeConnectorProfile(); unsubscribeConnectorProfile = null; }
  if (!currentUser || currentRole !== "connector" || !currentGroupId) return;

  const docId = `${currentUser.uid}_${currentGroupId}`;
  unsubscribeConnectorProfile = db
    .collection("hireconnect_connectors")
    .doc(docId)
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
         </span>`
      : "";
    const siteAdminLink = isHcAdmin
      ? `<a href="admin.html" class="hc-admin-link">⚙ Site Admin</a>`
      : "";
    const switchGroupBtn = userGroups.length > 1
      ? `<button class="hc-switch-group-btn" onclick="showGroupSwitcher()" title="Switch group">⇄ Groups</button>`
      : "";
    const joinGroupBtn = currentUser
      ? `<button class="hc-switch-group-btn" onclick="showGroupSwitcher()" title="Manage groups">＋ Join/Create</button>`
      : "";
    const groupBtns = userGroups.length > 1 ? switchGroupBtn : (userGroups.length > 0 ? joinGroupBtn : "");
    area.innerHTML = `
      ${roleBadge}
      ${siteAdminLink}
      ${groupBtns}
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
  if (unsubscribeOpen) { unsubscribeOpen(); unsubscribeOpen = null; }
  if (!currentGroupId) return;

  unsubscribeOpen = db
    .collection("hireconnect_requests")
    .where("groupId", "==", currentGroupId)
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
        document.getElementById("openRequestsList").innerHTML =
          `<div class="hc-empty">Error loading requests. Check console.</div>`;
      }
    );
}

function subscribeResolved() {
  if (unsubscribeResolved) { unsubscribeResolved(); unsubscribeResolved = null; }
  if (!currentGroupId) return;

  unsubscribeResolved = db
    .collection("hireconnect_requests")
    .where("groupId", "==", currentGroupId)
    .where("status", "==", "resolved")
    .orderBy("resolvedAt", "desc")
    .limit(50)
    .onSnapshot(
      (snap) => {
        resolvedRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderResolvedRequests();
        renderSubmitArea(); // keep Thank You points count in sync
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

// ── Connector companies loader ────────────────────────────────

function loadConnectorCompanies() {
  if (!currentGroupId) return;
  db.collection("hireconnect_connectors")
    .where("groupId", "==", currentGroupId)
    .where("approved", "==", true)
    .get()
    .then((snap) => {
      connectorCompanies = [...new Set(
        snap.docs.map((d) => d.data().company).filter(Boolean)
      )].sort((a, b) => a.localeCompare(b));
      if (currentRole === "seeker") renderSubmitArea();
    })
    .catch(() => {});
}

function onCompanySelect(val) {
  const manual = document.getElementById("companyManualInput");
  if (!manual) return;
  if (val === "__other__") {
    manual.style.display = "";
    manual.focus();
  } else {
    manual.style.display = "none";
    manual.value = "";
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
    const tyPoints = resolvedRequests.filter((r) => r.resolvedByUid === currentUser.uid).length;
    const companyHtml = connectorProfile
      ? ` — <span class="hc-connector-company-name">${escapeHtml(connectorProfile.company)}</span><button class="hc-update-company-link" onclick="showConnectorCompanyEdit()">Update</button>`
      : "";
    area.innerHTML = `
      <div class="hc-submit-signin-prompt">
        <span class="hc-submit-signin-icon">🤝</span>
        <div>
          <strong>You're signed in as a Connector${companyHtml}</strong>
          <p>${approvedMsg}</p>
        </div>
        <div class="hc-ty-points" title="Requests you've resolved">
          <span class="hc-ty-points-count">${tyPoints}</span>
          <span class="hc-ty-points-label">Thank You Point${tyPoints !== 1 ? "s" : ""}</span>
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
      <div class="hc-company-select-wrap">
        <select id="companyInput" class="hc-input hc-company-input" onchange="onCompanySelect(this.value)">
          <option value="" disabled selected>Select a company…</option>
          ${connectorCompanies.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          <option value="__other__">Other (type manually)</option>
        </select>
        <input
          id="companyManualInput"
          type="text"
          class="hc-input hc-company-input"
          placeholder="Enter company name"
          autocomplete="off"
          style="display:none;margin-top:6px"
        />
      </div>
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
  if (!currentGroupId) return showError("Please join or create a group first.");

  const jobUrlEl   = document.getElementById("jobUrlInput");
  const companyEl  = document.getElementById("companyInput");
  const manualEl   = document.getElementById("companyManualInput");
  const detailsEl  = document.getElementById("detailsInput");
  const anonEl     = document.getElementById("submitAnonCheck");
  const btn        = document.getElementById("submitBtn");

  const jobUrl = jobUrlEl.value.trim();
  const selectedVal = companyEl ? companyEl.value : "";
  const company = (selectedVal === "__other__" || selectedVal === "")
    ? (manualEl ? manualEl.value.trim() : "")
    : selectedVal.trim();
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
      groupId:         currentGroupId,
      status:          "open",
      submittedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      submittedBy:     stayAnonymous ? "" : (currentUser.displayName || currentUser.email || ""),
      submittedByUid:  currentUser.uid,   // always stored so Seekers can see their own tickets
    });
    jobUrlEl.value  = "";
    if (companyEl) companyEl.value = "";
    if (manualEl)  { manualEl.value = ""; manualEl.style.display = "none"; }
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
      status:              "resolved",
      resolvedAt:          firebase.firestore.FieldValue.serverTimestamp(),
      resolvedBy:          stayAnonymous ? "" : (currentUser.displayName || currentUser.email || "Community Member"),
      resolvedByUid:       currentUser.uid,
      resolverLinkedinUrl: (connectorProfile && connectorProfile.linkedinUrl) || "",
      hiringManager,
      referralIntent,
      resolverNotes,
    });
    expandedRequestId = null;
  } catch (err) {
    showError("Failed to resolve: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Mark as Resolved"; }
  }
}

// ── Seeker: edit / delete own request ────────────────────────

function showEditRequestForm(id) {
  const req = openRequests.find((r) => r.id === id);
  if (!req) return;

  // Replace the expanded panel in-place
  const article = document.querySelector(`.hc-request-row[data-id="${id}"]`);
  if (!article) return;
  const panel = article.querySelector(".hc-expanded-panel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="hc-expanded-header">Edit Connection Request</div>
    <div class="hc-form-group">
      <label for="edit_url_${id}">Job URL</label>
      <input id="edit_url_${id}" type="url" class="hc-input" style="width:100%"
        value="${escapeHtml(req.jobUrl)}" autocomplete="off" />
    </div>
    <div class="hc-form-group">
      <label for="edit_company_${id}">Company</label>
      <input id="edit_company_${id}" type="text" class="hc-input" style="width:100%"
        value="${escapeHtml(req.company || "")}" autocomplete="off" />
    </div>
    <div class="hc-form-group">
      <label for="edit_details_${id}">Details <span class="hc-optional">(optional)</span></label>
      <input id="edit_details_${id}" type="text" class="hc-input" style="width:100%"
        value="${escapeHtml(req.details || "")}" autocomplete="off" />
    </div>
    <div id="edit_error_${id}" class="hc-feedback" style="display:none"></div>
    <div class="hc-form-actions" style="margin-top:12px">
      <button class="hc-cancel-btn" onclick="toggleExpand('${id}')">Cancel</button>
      <button class="hc-submit-btn" onclick="saveRequestEdit('${id}')">Save</button>
    </div>`;
}

async function saveRequestEdit(id) {
  const jobUrl  = document.getElementById(`edit_url_${id}`).value.trim();
  const company = document.getElementById(`edit_company_${id}`).value.trim();
  const details = document.getElementById(`edit_details_${id}`).value.trim();
  const err     = document.getElementById(`edit_error_${id}`);

  if (!jobUrl) { err.textContent = "Please enter a job URL."; err.style.display = ""; return; }
  if (!jobUrl.startsWith("http://") && !jobUrl.startsWith("https://")) {
    err.textContent = "Please enter a valid URL starting with http:// or https://";
    err.style.display = ""; return;
  }
  if (!company) { err.textContent = "Please enter a company name."; err.style.display = ""; return; }
  err.style.display = "none";

  const btn = document.querySelector(`.hc-request-row[data-id="${id}"] .hc-submit-btn`);
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  try {
    await db.collection("hireconnect_requests").doc(id).update({ jobUrl, company, details });
    expandedRequestId = id; // keep expanded after re-render
  } catch (e) {
    err.textContent = "Failed to save: " + e.message;
    err.style.display = "";
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

async function deleteOwnRequest(id) {
  if (!confirm("Delete this request? This cannot be undone.")) return;
  try {
    await db.collection("hireconnect_requests").doc(id).delete();
    expandedRequestId = null;
  } catch (e) {
    showError("Failed to delete: " + e.message);
  }
}

// ── Render: expanded panel ────────────────────────────────────

function buildExpandedPanel(req) {
  if (currentRole === "seeker") {
    const safe    = safeUrl(req.jobUrl);
    const company = escapeHtml(req.company || "");
    const details = escapeHtml(req.details || "");
    const id      = req.id;
    return `
      <div class="hc-expanded-panel">
        <div class="hc-expanded-header">Connection Request Details</div>
        <div class="hc-detail-row">
          <span class="hc-detail-label">Job URL</span>
          <span class="hc-detail-value"><a href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(req.jobUrl)}</a></span>
        </div>
        ${company ? `
        <div class="hc-detail-row">
          <span class="hc-detail-label">Company</span>
          <span class="hc-detail-value">${company}</span>
        </div>` : ""}
        ${details ? `
        <div class="hc-detail-row">
          <span class="hc-detail-label">Details</span>
          <span class="hc-detail-value">${details}</span>
        </div>` : ""}
        <div class="hc-form-actions" style="margin-top:12px">
          <button class="hc-cancel-btn" onclick="toggleExpand(null)">Close</button>
          <button class="hc-role-switch-btn" onclick="showEditRequestForm('${id}')">Edit</button>
          <button class="hc-delete-own-btn" onclick="deleteOwnRequest('${id}')">Delete</button>
        </div>
      </div>`;
  }

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
          placeholder="Share only Name and LinkedIn URL. No email or phone numbers, please."
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
        ${isHcAdmin ? `<button class="hc-delete-own-btn" onclick="deleteRequest('${id}')">Delete</button>` : ""}
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
  const seekerName = currentRole === "connector"
    ? (req.submittedBy ? escapeHtml(req.submittedBy) : "Anonymous Seeker")
    : "";

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
        ${req.submittedAt ? `<span class="hc-date-tag">📅 ${fmtDate(req.submittedAt)}</span>` : ""}
        ${company ? `<span class="hc-company-badge">${company}</span>` : ""}
        ${details ? `<span class="hc-details-preview">${details}</span>` : ""}
        ${seekerName ? `<span class="hc-seeker-name">👤 ${seekerName}</span>` : ""}
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
    const badge = titleEl.querySelector("#openPanelCount");
    titleEl.textContent = currentRole === "seeker" ? "My Open Requests " : "Open Postings ";
    if (badge) titleEl.appendChild(badge);
  }

  // Not signed in — hide everything
  if (!currentUser) {
    const countEl = document.getElementById("openPanelCount");
    if (countEl) { countEl.textContent = ""; countEl.style.display = "none"; }
    list.innerHTML = `<div class="hc-empty">🔒 Sign in to view postings.</div>`;
    return;
  }

  // Unapproved connector — hide until admin approves
  if (currentRole === "connector" && !isConnectorApproved) {
    const countEl = document.getElementById("openPanelCount");
    if (countEl) { countEl.textContent = ""; countEl.style.display = "none"; }
    list.innerHTML = `<div class="hc-empty">⏳ Your Connector account is pending admin approval. Open postings will appear here once you're approved.</div>`;
    return;
  }

  // Seekers see only their own posts; connectors see all
  let source = openRequests;
  if (currentRole === "seeker") {
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

  // Not signed in — hide sidebar
  if (!currentUser) {
    const countEl = document.getElementById("sidebarCount");
    if (countEl) { countEl.textContent = ""; countEl.style.display = "none"; }
    sidebar.innerHTML = "";
    return;
  }

  // Seekers see only companies from their own posts
  const base = currentRole === "seeker"
    ? openRequests.filter((r) => r.submittedByUid === currentUser.uid)
    : openRequests;
  const companies = [...new Set(base.map((r) => r.company).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );

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

  // Not signed in — hide everything
  if (!currentUser) {
    const countEl = document.getElementById("resolvedCount");
    if (countEl) { countEl.textContent = ""; countEl.style.display = "none"; }
    list.innerHTML = `<div class="hc-empty">🔒 Sign in to view resolved requests.</div>`;
    return;
  }

  // Unapproved connector — hide until admin approves
  if (currentRole === "connector" && !isConnectorApproved) {
    const countEl = document.getElementById("resolvedCount");
    if (countEl) { countEl.textContent = ""; countEl.style.display = "none"; }
    list.innerHTML = `<div class="hc-empty">⏳ Resolved requests will be visible once your account is approved.</div>`;
    return;
  }

  // Seekers see only their own resolved posts; connectors see all
  let source = currentRole === "seeker"
    ? resolvedRequests.filter((r) => r.submittedByUid === currentUser.uid)
    : resolvedRequests;

  const rq = resolvedSearchQuery.toLowerCase();
  if (rq) {
    source = source.filter(
      (r) =>
        (r.company || "").toLowerCase().includes(rq) ||
        (r.jobUrl  || "").toLowerCase().includes(rq) ||
        (r.details || "").toLowerCase().includes(rq)
    );
  }

  const countEl = document.getElementById("resolvedCount");
  if (countEl) {
    countEl.textContent = source.length;
    countEl.style.display = source.length > 0 ? "" : "none";
  }

  const emptyMsg = currentRole === "seeker"
    ? "✨ None of your requests are resolved yet."
    : (rq ? `🔍 No results for "${escapeHtml(rq)}".` : "✨ No resolved requests yet.");

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
    const resolverName    = req.resolvedBy ? escapeHtml(req.resolvedBy) : "Anonymous";
    const resolverLi      = req.resolverLinkedinUrl ? safeUrl(req.resolverLinkedinUrl) : null;
    const resolverDisplay = resolverLi && resolverLi !== "#" && req.resolvedBy
      ? `<a href="${resolverLi}" target="_blank" rel="noopener noreferrer" class="hc-thanks-link">${resolverName}</a>`
      : resolverName;
    const thanks = `Thanks ${resolverDisplay}!`;
    const seekerName = currentRole === "connector"
      ? (req.submittedBy ? escapeHtml(req.submittedBy) : "Anonymous Seeker")
      : "";
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
          ${req.resolvedAt ? `<span class="hc-date-tag">✅ ${fmtDate(req.resolvedAt)}</span>` : ""}
          ${company ? `<span class="hc-company-badge">${company}</span>` : ""}
          ${details ? `<span class="hc-details-preview">${details}</span>` : ""}
          ${seekerName ? `<span class="hc-seeker-name">👤 ${seekerName}</span>` : ""}
        </div>
        <span class="hc-thanks-badge">${thanks}</span>
        ${isHcAdmin ? `<button class="hc-delete-btn" title="Delete posting" onclick="event.stopPropagation(); deleteRequest('${id}')">🗑</button>` : ""}
      </div>
      ${isExpanded ? buildResolvedDetail(req) : ""}
    `;

    list.appendChild(article);
  });
}

// ── Group: onboarding modal (no groups yet) ───────────────────

function showOnboarding() {
  // Hide role picker if it's showing
  document.getElementById("rolePickerModal").style.display = "none";
  document.getElementById("groupOnboardingModal").style.display = "flex";
  document.getElementById("onboardingStep1").style.display = "";
  document.getElementById("onboardingStepCreate").style.display = "none";
  document.getElementById("onboardingStepJoin").style.display = "none";
  const errEl = document.getElementById("onboardingError");
  if (errEl) errEl.style.display = "none";
}

function hideOnboarding() {
  document.getElementById("groupOnboardingModal").style.display = "none";
}

function showOnboardingCreate() {
  document.getElementById("onboardingStep1").style.display = "none";
  document.getElementById("onboardingStepCreate").style.display = "";
  const inp = document.getElementById("newGroupNameInput");
  if (inp) inp.focus();
}

function showOnboardingJoin() {
  document.getElementById("onboardingStep1").style.display = "none";
  document.getElementById("onboardingStepJoin").style.display = "";
  const inp = document.getElementById("joinCodeInput");
  if (inp) inp.focus();
}

function showOnboardingStep1() {
  document.getElementById("onboardingStep1").style.display = "";
  document.getElementById("onboardingStepCreate").style.display = "none";
  document.getElementById("onboardingStepJoin").style.display = "none";
}

async function submitCreateGroup() {
  const name    = (document.getElementById("newGroupNameInput").value || "").trim();
  const desc    = (document.getElementById("newGroupDescInput").value || "").trim();
  const errEl   = document.getElementById("onboardingError");
  const btn     = document.getElementById("createGroupBtn");

  if (!name) {
    errEl.textContent = "Please enter a group name.";
    errEl.style.display = "";
    return;
  }
  errEl.style.display = "none";
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const groupId = await createGroup(name, desc);
    hideOnboarding();
    // subscribeMemberships will pick up the new group and call selectGroup
  } catch (e) {
    errEl.textContent = "Failed to create group: " + e.message;
    errEl.style.display = "";
    btn.disabled = false;
    btn.textContent = "Create Group";
  }
}

async function submitJoinByCode() {
  const code  = (document.getElementById("joinCodeInput").value || "").trim();
  const errEl = document.getElementById("onboardingError");
  const btn   = document.getElementById("joinGroupBtn");

  if (!code) {
    errEl.textContent = "Please enter an invite code or paste the full invite link.";
    errEl.style.display = "";
    return;
  }

  // Accept full URL or just the code
  let finalCode = code;
  try {
    const url = new URL(code);
    finalCode = url.searchParams.get("invite") || code;
  } catch (_) { /* not a URL, use raw code */ }

  errEl.style.display = "none";
  btn.disabled = true;
  btn.textContent = "Joining…";

  try {
    await processInviteCode(finalCode);
    // subscribeMemberships listener will fire and call selectGroup
    hideOnboarding();
  } catch (e) {
    errEl.textContent = "Failed to join group: " + e.message;
    errEl.style.display = "";
    btn.disabled = false;
    btn.textContent = "Join Group";
  }
}

// ── Group: group switcher modal ───────────────────────────────

function showGroupSwitcher() {
  const modal = document.getElementById("groupSwitcherModal");
  if (!modal) return;
  renderGroupSwitcherList();
  modal.style.display = "flex";
}

function hideGroupSwitcher() {
  const modal = document.getElementById("groupSwitcherModal");
  if (modal) modal.style.display = "none";
}

function renderGroupSwitcherList() {
  const list = document.getElementById("groupSwitcherList");
  if (!list) return;

  if (userGroups.length === 0) {
    list.innerHTML = `<div class="hc-empty">You haven't joined any groups yet.</div>`;
    return;
  }

  list.innerHTML = userGroups.map((g) => {
    const isActive = g.groupId === currentGroupId;
    const roleBadge = g.role === "admin"
      ? `<span class="hc-group-role-badge hc-group-role-badge--admin">Admin</span>`
      : `<span class="hc-group-role-badge">Member</span>`;
    return `
      <div class="hc-group-switcher-item${isActive ? " active" : ""}" onclick="switchToGroup('${g.groupId}')">
        <div class="hc-group-switcher-name">${escapeHtml(g.groupName || g.groupId)}</div>
        ${roleBadge}
        ${isActive ? `<span class="hc-group-active-tick">✓ Active</span>` : ""}
      </div>`;
  }).join("");
}

async function switchToGroup(groupId) {
  hideGroupSwitcher();
  // Reset role context for new group
  currentRole         = null;
  connectorProfile    = null;
  isConnectorApproved = false;
  if (unsubscribeConnectorProfile) { unsubscribeConnectorProfile(); unsubscribeConnectorProfile = null; }
  openRequests    = [];
  resolvedRequests = [];
  searchQuery     = "";
  resolvedSearchQuery = "";
  await selectGroup(groupId);
}

// ── Group: settings modal (General / Members / Connectors tabs) ──

function showGroupSettings() {
  const modal = document.getElementById("groupSettingsModal");
  if (!modal || !currentGroupId || !isGroupAdmin) return;
  modal.style.display = "flex";
  showGroupSettingsTab("general");
}

function hideGroupSettings() {
  const modal = document.getElementById("groupSettingsModal");
  if (modal) modal.style.display = "none";
}

function showGroupSettingsTab(tab) {
  ["general", "members", "connectors"].forEach((t) => {
    const pane = document.getElementById(`groupSettingsTab_${t}`);
    const btn  = document.getElementById(`groupSettingsTabBtn_${t}`);
    if (pane) pane.style.display = t === tab ? "" : "none";
    if (btn)  btn.classList.toggle("active", t === tab);
  });
  if (tab === "general")    renderGroupSettingsGeneral();
  if (tab === "members")    renderGroupMembersTab();
  if (tab === "connectors") renderGroupConnectorsTab();
}

function renderGroupSettingsGeneral() {
  const wrap = document.getElementById("groupSettingsTab_general");
  if (!wrap || !currentGroupProfile) return;

  const inviteLink = `${window.location.origin}${window.location.pathname}?invite=${currentGroupProfile.inviteCode}`;

  wrap.innerHTML = `
    <div class="hc-form-group">
      <label for="gsGroupName">Group Name</label>
      <input id="gsGroupName" type="text" class="hc-input" style="width:100%"
        value="${escapeHtml(currentGroupProfile.name)}" />
    </div>
    <div class="hc-form-group">
      <label for="gsGroupDesc">Description <span class="hc-optional">(optional)</span></label>
      <input id="gsGroupDesc" type="text" class="hc-input" style="width:100%"
        value="${escapeHtml(currentGroupProfile.description || "")}" />
    </div>
    <div id="gsGeneralError" class="hc-feedback" style="display:none"></div>
    <div class="hc-form-actions" style="margin-top:8px">
      <button class="hc-submit-btn" onclick="saveGroupSettings()">Save</button>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
      <div class="hc-form-group">
        <label>Invite Link</label>
        <div class="hc-invite-link-row">
          <input id="gsInviteLink" type="text" class="hc-input" style="flex:1;font-size:12px"
            value="${escapeHtml(inviteLink)}" readonly />
          <button class="hc-cancel-btn" onclick="copyInviteLink()">Copy</button>
          <button class="hc-cancel-btn" onclick="regenerateInviteCode()" title="Generate a new code — old link stops working">Regenerate</button>
        </div>
        <p style="font-size:11px;color:var(--muted);margin-top:6px">Share this link to invite members to your group. Regenerating will invalidate the current link.</p>
      </div>
    </div>`;
}

async function saveGroupSettings() {
  const name  = (document.getElementById("gsGroupName").value || "").trim();
  const desc  = (document.getElementById("gsGroupDesc").value || "").trim();
  const errEl = document.getElementById("gsGeneralError");

  if (!name) {
    errEl.textContent = "Group name cannot be empty.";
    errEl.style.display = "";
    return;
  }
  errEl.style.display = "none";

  try {
    await db.collection("hireconnect_groups").doc(currentGroupId).update({ name, description: desc });
    // Update groupName in membership docs for this group (best-effort)
    const snap = await db.collection("hireconnect_memberships")
      .where("groupId", "==", currentGroupId).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.update(d.ref, { groupName: name }));
    await batch.commit();
  } catch (e) {
    errEl.textContent = "Save failed: " + e.message;
    errEl.style.display = "";
  }
}

function copyInviteLink() {
  const el = document.getElementById("gsInviteLink");
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => {
    const btn = el.nextElementSibling;
    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 2000); }
  }).catch(() => { el.select(); document.execCommand("copy"); });
}

function renderGroupMembersTab() {
  const wrap = document.getElementById("groupSettingsTab_members");
  if (!wrap || !currentGroupId) return;
  wrap.innerHTML = `<div class="hc-empty">Loading members…</div>`;

  db.collection("hireconnect_memberships")
    .where("groupId", "==", currentGroupId)
    .get()
    .then((snap) => {
      if (snap.empty) {
        wrap.innerHTML = `<div class="hc-empty">No members yet.</div>`;
        return;
      }
      const members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const adminCount = members.filter((m) => m.role === "admin").length;

      const rows = members.sort((a, b) => {
        if (a.role === b.role) return (a.uid || "").localeCompare(b.uid || "");
        return a.role === "admin" ? -1 : 1;
      }).map((m) => {
        const isMe = m.uid === currentUser.uid;
        const canDemote = m.role === "admin" && adminCount > 1 && !isMe;
        const canPromote = m.role === "member";
        const actionBtn = canPromote
          ? `<button class="hc-toggle-btn hc-toggle-btn--enable" onclick="setMemberRole('${m.uid}','${currentGroupId}','admin')">Make Admin</button>`
          : canDemote
            ? `<button class="hc-toggle-btn hc-toggle-btn--disable" onclick="setMemberRole('${m.uid}','${currentGroupId}','member')">Remove Admin</button>`
            : `<span style="color:var(--muted);font-size:0.78rem">${isMe ? "(you)" : ""}</span>`;

        const rolePill = m.role === "admin"
          ? `<span class="hc-approved-pill">Admin</span>`
          : `<span class="hc-unapproved-pill">Member</span>`;

        return `<tr>
          <td style="font-weight:600">${escapeHtml(m.uid.slice(-6))}</td>
          <td style="text-align:center">${rolePill}</td>
          <td style="text-align:center">${actionBtn}</td>
        </tr>`;
      }).join("");

      wrap.innerHTML = `
        <table class="hc-admin-table">
          <thead><tr>
            <th>User ID (last 6)</th>
            <th style="text-align:center">Role</th>
            <th style="text-align:center">Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:11px;color:var(--muted);margin-top:10px">
          There must always be at least one admin. You cannot remove your own admin rights.
        </p>`;
    })
    .catch((e) => {
      wrap.innerHTML = `<div class="hc-empty">Failed to load members: ${escapeHtml(e.message)}</div>`;
    });
}

function renderGroupConnectorsTab() {
  const wrap = document.getElementById("groupSettingsTab_connectors");
  if (!wrap || !currentGroupId) return;
  wrap.innerHTML = `<div class="hc-empty">Loading connectors…</div>`;

  db.collection("hireconnect_connectors")
    .where("groupId", "==", currentGroupId)
    .get()
    .then((snap) => {
      if (snap.empty) {
        wrap.innerHTML = `<div class="hc-empty">No connectors registered in this group yet.</div>`;
        return;
      }
      const connectors = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const pending = connectors.filter((c) => !c.approved).length;

      const sorted = [...connectors].sort((a, b) => {
        if (a.approved === b.approved) return (a.displayName || "").localeCompare(b.displayName || "");
        return a.approved ? 1 : -1;
      });

      const rows = sorted.map((c) => {
        const statusPill = c.approved
          ? `<span class="hc-approved-pill">✓ Approved</span>`
          : `<span class="hc-unapproved-pill">⏳ Pending</span>`;
        const toggleLabel = c.approved ? "Disable" : "Approve";
        const toggleClass = c.approved
          ? "hc-toggle-btn hc-toggle-btn--disable"
          : "hc-toggle-btn hc-toggle-btn--enable";
        return `<tr>
          <td>
            <div style="font-weight:600">${escapeHtml(c.displayName || "Unknown")}</div>
            <div style="font-size:0.78rem;color:var(--muted)">${escapeHtml(c.email || "")}</div>
          </td>
          <td>${escapeHtml(c.company || "—")}</td>
          <td style="text-align:center">${statusPill}</td>
          <td style="text-align:center">
            <button class="${toggleClass}" onclick="approveConnectorForGroup('${c.id}',${c.approved}); renderGroupConnectorsTab();">${toggleLabel}</button>
          </td>
        </tr>`;
      }).join("");

      const pendingBanner = pending > 0
        ? `<div class="hc-pending-banner" style="margin-bottom:12px">⚠️ <strong>${pending} connector(s)</strong> awaiting approval</div>`
        : "";

      wrap.innerHTML = `
        ${pendingBanner}
        <table class="hc-admin-table">
          <thead><tr>
            <th>Name</th><th>Company</th>
            <th style="text-align:center">Status</th>
            <th style="text-align:center">Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .catch((e) => {
      wrap.innerHTML = `<div class="hc-empty">Failed to load connectors: ${escapeHtml(e.message)}</div>`;
    });
}

// ── Feedback modal ───────────────────────────────────────────

function openFeedbackModal() {
  const modal = document.getElementById("feedbackModal");
  if (!modal) return;
  document.getElementById("feedbackText").value  = "";
  document.getElementById("feedbackEmail").value = "";
  document.getElementById("feedbackError").style.display = "none";
  modal.style.display = "flex";
  setTimeout(() => document.getElementById("feedbackText").focus(), 50);
}

function closeFeedbackModal() {
  const modal = document.getElementById("feedbackModal");
  if (modal) modal.style.display = "none";
}

function submitFeedback() {
  const text  = document.getElementById("feedbackText").value.trim();
  const email = document.getElementById("feedbackEmail").value.trim();
  const errEl = document.getElementById("feedbackError");

  if (!text) {
    errEl.textContent = "Please enter your feedback before sending.";
    errEl.style.display = "";
    return;
  }

  const subject = encodeURIComponent("InsideHire.fyi Feedback");
  const body    = encodeURIComponent(
    (email ? `From: ${email}\n\n` : "") + text
  );
  window.location.href = `mailto:siliconvalleysprouts@gmail.com?subject=${subject}&body=${body}`;
  closeFeedbackModal();
}

// ── Search ────────────────────────────────────────────────────

function onSearch(value) {
  searchQuery = value.trim();
  renderOpenRequests();
}


// ── Init ──────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Resolved search box
  const resolvedBox = document.getElementById("resolvedSearchBox");
  if (resolvedBox) {
    resolvedBox.addEventListener("input",  () => { resolvedSearchQuery = resolvedBox.value.trim(); renderResolvedRequests(); });
    resolvedBox.addEventListener("search", () => { resolvedSearchQuery = resolvedBox.value.trim(); renderResolvedRequests(); });
  }

  // Site admin config (no auth required — reads public emails list)
  subscribeAdminConfig();

  // Auth observer
  auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    updateAdminStatus();

    if (user) {
      // Process invite code from URL before loading memberships
      const params     = new URLSearchParams(window.location.search);
      const inviteCode = params.get("invite");
      if (inviteCode) {
        await processInviteCode(inviteCode);
      }

      // Subscribe to user's group memberships (real-time)
      // This listener will call selectGroup() once memberships are loaded
      subscribeMemberships();
    } else {
      // Clean up all state on sign-out
      currentRole         = null;
      connectorProfile    = null;
      isConnectorApproved = false;
      currentGroupId      = null;
      currentGroupProfile = null;
      userGroups          = [];
      isGroupAdmin        = false;
      openRequests        = [];
      resolvedRequests    = [];

      if (unsubscribeConnectorProfile) { unsubscribeConnectorProfile(); unsubscribeConnectorProfile = null; }
      if (unsubscribeGroupProfile)     { unsubscribeGroupProfile();     unsubscribeGroupProfile     = null; }
      if (unsubscribeMemberships)      { unsubscribeMemberships();      unsubscribeMemberships      = null; }
      if (unsubscribeOpen)             { unsubscribeOpen();             unsubscribeOpen             = null; }
      if (unsubscribeResolved)         { unsubscribeResolved();         unsubscribeResolved         = null; }

      updatePageVisibility();
      renderGroupArea();
      renderAuthBadge();
      renderSubmitArea();
      renderOpenRequests();
      renderResolvedRequests();
      renderCompanySidebar();
      updateHeroCards();
    }
  });
});
