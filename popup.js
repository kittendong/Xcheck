const STORAGE_KEY = "xUnfollowHelper";
const MAX_HISTORY = 8;
const RELATIONSHIP_DETECTION_VERSION = 5;

const els = {
  pageStatus: document.querySelector("#pageStatus"),
  openX: document.querySelector("#openX"),
  profileInput: document.querySelector("#profileInput"),
  usePageProfile: document.querySelector("#usePageProfile"),
  listTypeBadge: document.querySelector("#listTypeBadge"),
  collectVisible: document.querySelector("#collectVisible"),
  scanList: document.querySelector("#scanList"),
  calibratedScan: document.querySelector("#calibratedScan"),
  scanProgress: document.querySelector("#scanProgress"),
  followersCount: document.querySelector("#followersCount"),
  followingCount: document.querySelector("#followingCount"),
  alertCount: document.querySelector("#alertCount"),
  nonMutualCount: document.querySelector("#nonMutualCount"),
  listTitle: document.querySelector("#listTitle"),
  showLostAlerts: document.querySelector("#showLostAlerts"),
  showNonMutual: document.querySelector("#showNonMutual"),
  refreshData: document.querySelector("#refreshData"),
  alertsList: document.querySelector("#alertsList"),
  openSelected: document.querySelector("#openSelected"),
  markSelectedDone: document.querySelector("#markSelectedDone"),
  exportData: document.querySelector("#exportData"),
  clearAccount: document.querySelector("#clearAccount")
};

let activeTab = null;
let pageState = { profile: "", listType: "", url: "" };
let selectedHandles = new Set();
let currentView = "nonMutual";

function normalizeHandle(value) {
  return String(value || "").replace(/^@+/, "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function usersToObject(users = []) {
  return Object.fromEntries(
    users
      .filter((user) => user?.handle)
      .map((user) => [normalizeHandle(user.handle), { ...user, handle: normalizeHandle(user.handle) }])
  );
}

async function storageGet() {
  const value = await chrome.storage.local.get(STORAGE_KEY);
  return value[STORAGE_KEY] || { accounts: {} };
}

async function storageSet(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function inferPageStateFromUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    const parts = url.pathname.split("/").filter(Boolean);
    const profile = normalizeHandle(parts[0]);
    const last = parts[parts.length - 1] || "";
    const listType = last === "followers" || last === "verified_followers"
      ? "followers"
      : last === "following"
        ? "following"
        : "";
    return { profile, listType, url: url.href };
  } catch {
    return { profile: "", listType: "", url: "" };
  }
}

function ensureAccount(data, profile) {
  const key = normalizeHandle(profile);
  if (!data.accounts[key]) {
    data.accounts[key] = {
      profile: key,
      createdAt: nowIso(),
      last: {},
      history: [],
      alerts: {}
    };
  }
  return data.accounts[key];
}

function getSelectedProfile() {
  return normalizeHandle(els.profileInput.value || pageState.profile);
}

function differenceUsers(previous = {}, current = {}) {
  return Object.values(previous).filter((user) => !current[user.handle]);
}

function buildCountCheck(listType, snapshotCount, expectedFollowingCount, isFullScan) {
  if (listType !== "following" || !isFullScan) {
    return { status: "not_applicable" };
  }

  if (!expectedFollowingCount || !Number.isFinite(expectedFollowingCount.value)) {
    return {
      status: "unknown",
      message: "未读取到页面上的关注总数。"
    };
  }

  const expected = Number(expectedFollowingCount.value);
  const diff = snapshotCount - expected;

  if (!expectedFollowingCount.exact) {
    return {
      status: "approximate",
      expected,
      expectedRaw: expectedFollowingCount.raw,
      actual: snapshotCount,
      diff,
      message: "页面显示的是缩写约数，无法做严格相等核对。"
    };
  }

  if (snapshotCount === expected) {
    return {
      status: "matched",
      expected,
      expectedRaw: expectedFollowingCount.raw,
      actual: snapshotCount,
      diff,
      message: "快照数量和页面关注总数一致。"
    };
  }

  const tolerance = Math.max(1, Math.min(10, Math.ceil(expected * 0.003)));
  if (Math.abs(diff) <= tolerance) {
    return {
      status: "near_match",
      expected,
      expectedRaw: expectedFollowingCount.raw,
      actual: snapshotCount,
      diff,
      tolerance,
      message: "快照数量和页面关注总数存在小误差，已保存但会提示复核。"
    };
  }

  return {
    status: "mismatch",
    expected,
    expectedRaw: expectedFollowingCount.raw,
    actual: snapshotCount,
    diff,
    message: "快照数量和页面关注总数不一致。"
  };
}

function formatExpectedCount(countCheck) {
  if (!countCheck || !Number.isFinite(countCheck.expected)) {
    return "未知";
  }

  return countCheck.expectedRaw && String(countCheck.expectedRaw) !== String(countCheck.expected)
    ? `${countCheck.expectedRaw}（约 ${countCheck.expected}）`
    : String(countCheck.expected);
}

function recomputeOpenAlertStatus(account) {
  const following = account.last.following?.users || {};
  for (const alert of Object.values(account.alerts || {})) {
    if (alert.status !== "open") continue;
    alert.stillFollowing = Boolean(following[alert.handle]);
    alert.updatedAt = nowIso();
  }
}

async function setBadge(count) {
  try {
    await chrome.runtime.sendMessage({ type: "SET_BADGE", count });
  } catch {
    // Badge support is convenient, not essential.
  }
}

async function saveSnapshot(scanData) {
  const profile = normalizeHandle(scanData.profile || getSelectedProfile());
  const listType = scanData.listType;
  const users = usersToObject(scanData.users);
  const countCheck = buildCountCheck(
    listType,
    Object.keys(users).length,
    scanData.expectedFollowingCount,
    scanData.isFullScan
  );

  if (!profile || !["followers", "following"].includes(listType)) {
    throw new Error("请先打开目标账号的 followers 或 following 页面。");
  }

  const data = await storageGet();
  const account = ensureAccount(data, profile);
  const previous = account.last[listType];
  const snapshot = {
    type: listType,
    users,
    count: Object.keys(users).length,
    capturedAt: scanData.scannedAt || nowIso(),
    url: scanData.url || pageState.url,
    scanMode: scanData.scanMode || "unknown",
    isFullScan: Boolean(scanData.isFullScan),
    stopReason: scanData.stopReason || "",
    relationshipDetectionVersion: scanData.relationshipDetectionVersion || 1,
    expectedFollowingCount: scanData.expectedFollowingCount || null,
    candidateCount: scanData.candidateCount ?? null,
    countCheck
  };

  account.history.unshift({
    type: listType,
    count: snapshot.count,
    capturedAt: snapshot.capturedAt,
    url: snapshot.url,
    expectedFollowingCount: countCheck.expected ?? null,
    countCheckStatus: countCheck.status
  });
  account.history = account.history.slice(0, MAX_HISTORY);
  const shouldSaveAsLast = !(listType === "following" && countCheck.status === "mismatch" && snapshot.count === 0);

  if (shouldSaveAsLast) {
    account.last[listType] = snapshot;
  }

  if (shouldSaveAsLast && listType === "followers" && previous?.users) {
    const lostFollowers = differenceUsers(previous.users, users);
    const following = account.last.following?.users || {};
    for (const user of lostFollowers) {
      if (account.alerts[user.handle]?.status === "done") {
        continue;
      }

      account.alerts[user.handle] = {
        handle: user.handle,
        displayName: user.displayName || `@${user.handle}`,
        profileUrl: `https://x.com/${user.handle}`,
        detectedAt: nowIso(),
        lastFollowerSnapshotAt: previous.capturedAt,
        status: "open",
        stillFollowing: Boolean(following[user.handle])
      };
    }
  }

  recomputeOpenAlertStatus(account);
  await storageSet(data);

  const openAlerts = Object.values(account.alerts || {}).filter((item) => item.status === "open");
  await setBadge(openAlerts.length);
  const nonMutualCount = listType === "following"
    ? countNonMutualUsers(shouldSaveAsLast ? account.last.following?.users : users)
    : getNonMutualUsers(account).length;

  return {
    account,
    savedCount: snapshot.count,
    openAlerts: openAlerts.length,
    nonMutualCount,
    listType,
    countCheck,
    savedAsLast: shouldSaveAsLast
  };
}

function showSnapshotPrompt(result) {
  if (result.listType !== "following" || result.countCheck?.status === "not_applicable") {
    return;
  }

  const check = result.countCheck;
  if (check.status === "mismatch" && check.actual === 0 && Number(check.expected) > 0) {
    alert(`没有识别到用户行：页面关注人数 ${formatExpectedCount(check)}，本次快照 0。\n这通常是 X 页面结构变化或旧 contentScript 未刷新。请确认扩展版本已更新、刷新 X 页面后再试。`);
    return;
  }

  if (check.status === "matched") {
    alert(`已完成扫描~喵~\n当前未互关 ${result.nonMutualCount} 人`);
    return;
  }

  if (check.status === "near_match") {
    alert(`已完成扫描~喵~\n当前未互关 ${result.nonMutualCount} 人。\n页面关注人数 ${formatExpectedCount(check)}，本次快照 ${check.actual}，差异 ${check.diff > 0 ? "+" : ""}${check.diff}，属于小误差，已保存名单。`);
    return;
  }

  if (check.status === "mismatch") {
    alert(`已保存扫描结果，但数量未完全校准。\n页面关注人数 ${formatExpectedCount(check)}，本次快照 ${check.actual}。\n当前未互关 ${result.nonMutualCount} 人。`);
    return;
  }

  if (check.status === "approximate") {
    alert(`已完成扫描~喵~\n当前未互关 ${result.nonMutualCount} 人。\n页面关注人数显示为约数 ${formatExpectedCount(check)}，本次快照 ${check.actual}。建议确认数量是否接近。`);
    return;
  }

  alert(`已完成扫描~喵~\n当前未互关 ${result.nonMutualCount} 人。\n没有读到页面上的关注总数，建议确认数量是否完整。`);
}

function updatePageStatus() {
  const hostOk = activeTab?.url?.startsWith("https://x.com/") || activeTab?.url?.startsWith("https://twitter.com/");
  if (!hostOk) {
    els.pageStatus.textContent = "当前标签页不是 X/Twitter";
    els.listTypeBadge.textContent = "未在 X 页面";
    return;
  }

  const label = pageState.listType === "followers"
    ? "粉丝列表页"
    : pageState.listType === "following"
      ? "关注列表页"
      : "账号页面";
  els.pageStatus.textContent = pageState.profile ? `当前：@${pageState.profile}` : "已打开 X/Twitter";
  els.listTypeBadge.textContent = label;
}

function renderStats(account) {
  els.followersCount.textContent = account?.last?.followers?.count ?? "-";
  els.followingCount.textContent = account?.last?.following?.count ?? "-";
  const openAlerts = getOpenAlerts(account);
  const nonMutualUsers = getNonMutualUsers(account);
  els.alertCount.textContent = openAlerts.length;
  const staleRelationshipSnapshot = hasStaleRelationshipSnapshot(account);
  els.nonMutualCount.textContent = staleRelationshipSnapshot ? "重扫" : nonMutualUsers.length;
  els.showLostAlerts.textContent = `取关提醒 (${openAlerts.length})`;
  els.showNonMutual.textContent = staleRelationshipSnapshot ? "当前未互关 (重扫)" : `当前未互关 (${nonMutualUsers.length})`;
}

function getOpenAlerts(account) {
  return Object.values(account?.alerts || {})
    .filter((item) => item.status === "open")
    .sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)));
}

function getNonMutualUsers(account) {
  if (!hasCurrentRelationshipSnapshot(account)) {
    return [];
  }

  return Object.values(account?.last?.following?.users || {})
    .filter((user) => user.followsYou === false)
    .sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
}

function hasCurrentRelationshipSnapshot(account) {
  return account?.last?.following?.relationshipDetectionVersion === RELATIONSHIP_DETECTION_VERSION;
}

function hasStaleRelationshipSnapshot(account) {
  return Boolean(account?.last?.following) && !hasCurrentRelationshipSnapshot(account);
}

function countNonMutualUsers(users = {}) {
  return Object.values(users).filter((user) => user.followsYou === false).length;
}

function updateBulkButtons() {
  const hasSelection = selectedHandles.size > 0;
  els.openSelected.disabled = !hasSelection;
  els.markSelectedDone.disabled = true;
}

function setCurrentView(view) {
  currentView = view;
  selectedHandles.clear();
  els.showLostAlerts.classList.toggle("active", view === "lostAlerts");
  els.showNonMutual.classList.toggle("active", view === "nonMutual");
  refreshData();
}

function renderAlerts(account) {
  const items = getNonMutualUsers(account);
  const validHandles = new Set(items.map((item) => item.handle));
  selectedHandles = new Set([...selectedHandles].filter((handle) => validHandles.has(handle)));

  els.alertsList.textContent = "";
  els.listTitle.textContent = `当前未互关（${items.length}人）`;

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = hasStaleRelationshipSnapshot(account)
        ? "识别规则已更新。请在 following 页面重新自动滚动采集一次，旧版本的未互关误判结果已暂时隐藏。"
      : "暂时没有当前未互关名单。请先在 following 页面重新采集，插件会读取用户名区域是否显示“关注了你”。";
    els.alertsList.append(empty);
    updateBulkButtons();
    return;
  }

  for (const alert of items) {
    const item = document.createElement("article");
    item.className = "alert-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedHandles.has(alert.handle);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedHandles.add(alert.handle);
      else selectedHandles.delete(alert.handle);
      updateBulkButtons();
    });

    const body = document.createElement("div");
    body.className = "person";

    const name = document.createElement("strong");
    name.textContent = alert.displayName || `@${alert.handle}`;
    const handle = document.createElement("span");
    handle.textContent = `@${alert.handle}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    const detected = document.createElement("span");
    detected.className = "tag";
    detected.textContent = `采集：${formatTime(alert.capturedAt)}`;
    const following = document.createElement("span");
    following.className = "tag warn";
    following.textContent = "未显示“关注了你”";
    meta.append(detected, following);

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const openButton = document.createElement("button");
    openButton.textContent = "打开主页";
    openButton.addEventListener("click", () => chrome.tabs.create({ url: alert.profileUrl || `https://x.com/${alert.handle}` }));
    const doneButton = document.createElement("button");
    doneButton.className = "removed";
    actions.append(openButton, doneButton);

    body.append(name, handle, meta, actions);
    item.append(checkbox, body);
    els.alertsList.append(item);
  }

  updateBulkButtons();
}

async function refreshData() {
  const profile = getSelectedProfile();
  const data = await storageGet();
  const account = profile ? data.accounts[profile] : null;
  renderStats(account);
  renderAlerts(account);
  const openCount = getOpenAlerts(account).length;
  await setBadge(openCount);
}

async function collectVisible() {
  if (!activeTab?.id) return;
  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: "COLLECT_VISIBLE_USERS" });
    if (!response?.ok) throw new Error("无法读取当前页面。");
    const result = await saveSnapshot(response.data);
    els.scanProgress.hidden = false;
    els.scanProgress.textContent = `当前可见采集：识别 ${result.savedCount} 个账号，待处理 ${result.openAlerts} 个。`;
    await refreshData();
    showSnapshotPrompt(result);
  } catch (error) {
    els.scanProgress.hidden = false;
    els.scanProgress.textContent = String(error?.message || error);
  }
}

async function scanList() {
  if (!activeTab?.id) return;
  els.scanList.disabled = true;
  els.collectVisible.disabled = true;
  els.calibratedScan.disabled = true;
  els.scanProgress.hidden = false;
  els.scanProgress.textContent = "正在自动滚动采集...";

  const port = chrome.tabs.connect(activeTab.id, { name: "x-list-scan" });
  port.onMessage.addListener(async (message) => {
    if (message.type === "PROGRESS") {
      const progress = message.progress;
      const expected = progress.expectedFollowingCount?.value
        ? `，关注总数 ${progress.expectedFollowingCount.raw || progress.expectedFollowingCount.value}`
        : "";
      els.scanProgress.textContent = progress.phase === "count"
        ? `正在读取关注总数${expected}...`
        : `已采集 ${progress.count} 个${expected}，${progress.elapsedSeconds}s，滚动 ${progress.scrollPercent || 0}%，到底确认 ${progress.bottomStableRounds || 0}/${progress.maxBottomStableRounds || 0}`;
      return;
    }

    if (message.type === "DONE") {
      els.scanList.disabled = false;
      els.collectVisible.disabled = false;
      els.calibratedScan.disabled = false;
      port.disconnect();
      if (!message.ok) {
        els.scanProgress.textContent = message.error || "采集失败。";
        return;
      }

      try {
        const result = await saveSnapshot(message.data);
        const suffix = result.countCheck?.status === "mismatch"
          ? `数量未通过核对，未覆盖可靠快照。本次识别未互关 ${result.nonMutualCount} 人。`
          : result.listType === "following"
            ? `当前未互关 ${result.nonMutualCount} 人。`
            : `待处理 ${result.openAlerts} 个。`;
        els.scanProgress.textContent = `采集完成：本次 ${result.savedCount} 个，${suffix}`;
        await refreshData();
        showSnapshotPrompt(result);
      } catch (error) {
        els.scanProgress.textContent = String(error?.message || error);
      }
    }
  });
  port.postMessage({ type: "START_SCAN", options: { maxSeconds: 900, maxQuietRounds: 45 } });
}

async function startCalibratedScan() {
  if (!activeTab?.id) return;
  const profile = getSelectedProfile();
  if (!profile) {
    els.scanProgress.hidden = false;
    els.scanProgress.textContent = "请先输入账号，或打开目标账号页面后点击“使用当前页”。";
    return;
  }

  try {
    els.scanProgress.hidden = false;
    els.scanProgress.textContent = "正在启动：先打开账号主页读取正在关注人数，再进入 following 页面扫描...";
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "START_CALIBRATED_FOLLOWING_SCAN",
      profile
    });
  } catch {
    els.scanProgress.hidden = false;
    els.scanProgress.textContent = "启动失败。请刷新 X 页面，确认当前标签页是 x.com 后再试。";
  }
}

async function markAlerts(handles, status) {
  const profile = getSelectedProfile();
  const data = await storageGet();
  const account = data.accounts[profile];
  if (!account) return;

  for (const handle of handles) {
    if (!account.alerts[handle]) continue;
    account.alerts[handle].status = status;
    account.alerts[handle].updatedAt = nowIso();
    selectedHandles.delete(handle);
  }

  await storageSet(data);
  await refreshData();
}

async function openSelectedProfiles() {
  const handles = [...selectedHandles].slice(0, 12);
  for (const handle of handles) {
    await chrome.tabs.create({ url: `https://x.com/${handle}`, active: false });
  }
}

async function exportData() {
  const data = await storageGet();
  const payload = JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  await chrome.tabs.create({ url });
}

async function clearAccount() {
  const profile = getSelectedProfile();
  if (!profile) return;
  const confirmed = confirm(`清空 @${profile} 的本地快照和提醒？`);
  if (!confirmed) return;
  const data = await storageGet();
  delete data.accounts[profile];
  await storageSet(data);
  selectedHandles.clear();
  await refreshData();
}

async function init() {
  activeTab = await getCurrentTab();
  pageState = inferPageStateFromUrl(activeTab?.url || "");
  if (pageState.profile && !els.profileInput.value) {
    els.profileInput.value = pageState.profile;
  }

  updatePageStatus();
  await refreshData();

  els.openX.addEventListener("click", () => chrome.tabs.create({ url: "https://x.com/home" }));
  els.usePageProfile.addEventListener("click", async () => {
    if (pageState.profile) {
      els.profileInput.value = pageState.profile;
      await refreshData();
    }
  });
  els.profileInput.addEventListener("change", refreshData);
  els.collectVisible.addEventListener("click", collectVisible);
  els.scanList.addEventListener("click", scanList);
  els.calibratedScan.addEventListener("click", startCalibratedScan);
  els.showLostAlerts.addEventListener("click", () => setCurrentView("lostAlerts"));
  els.showNonMutual.addEventListener("click", () => setCurrentView("nonMutual"));
  els.refreshData.addEventListener("click", refreshData);
  els.openSelected.addEventListener("click", openSelectedProfiles);
  els.markSelectedDone.addEventListener("click", () => markAlerts([...selectedHandles], "done"));
  els.exportData.addEventListener("click", exportData);
  els.clearAccount.addEventListener("click", clearAccount);
}

init();
